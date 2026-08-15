// Command vpn-node-agent keeps one VPN node's peer table in step with the
// control plane.
//
// It pulls; the control plane never dials out. A push model would need a
// credential on the control plane that grants root on every node, and would
// need every node reachable from it. Pulling means a node exposes nothing but
// the WireGuard port, and a compromised control plane can hand out a bad peer
// list but cannot run commands anywhere.
//
// The agent keeps no state. Whatever the control plane answers is the truth,
// so a node that was offline for an hour converges on its first successful
// sync — the same reconcile-from-source-of-truth idea the control plane used
// to apply locally.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"vpnd/internal/wgctl"
)

// Version is stamped at build time with -ldflags.
var Version = "dev"

// What the agent tells the control plane about itself, and nothing about
// anybody else.
//
// It used to send a usage report per peer: bytes in, bytes out, and the last
// handshake time, keyed by public key. The control plane wrote that down, so
// the database held a per-device record of when someone was online and how
// much they moved. The interface still knows all of it — that is unavoidable,
// it is how WireGuard works — but it now stays in kernel memory on the node
// and is never written anywhere.
type syncRequest struct {
	InterfacePublicKey string `json:"interfacePublicKey"`
	AgentVersion       string `json:"agentVersion"`
}

type syncResponse struct {
	Server struct {
		ID            int    `json:"id"`
		Region        string `json:"region"`
		InterfaceName string `json:"interfaceName"`
	} `json:"server"`
	Peers            []wgctl.DesiredPeer `json:"peers"`
	PollAfterSeconds int                 `json:"pollAfterSeconds"`
}

func main() {
	var (
		controlPlane = flag.String("control-plane", os.Getenv("VPN_CONTROL_PLANE"), "base URL of the control plane")
		token        = flag.String("token", os.Getenv("VPN_NODE_TOKEN"), "this node's agent token")
		iface        = flag.String("interface", envOr("VPN_INTERFACE", "wg0"), "WireGuard interface to manage")
		useSudo      = flag.Bool("sudo", os.Getenv("VPN_USE_SUDO") == "true", "prefix wg with sudo -n")
		once         = flag.Bool("once", false, "sync a single time and exit")
		verbose      = flag.Bool("verbose", false, "log at debug level")
		showVersion  = flag.Bool("version", false, "print the version and exit")
	)
	flag.Parse()

	if *showVersion {
		fmt.Println(Version)
		return
	}

	level := slog.LevelInfo
	if *verbose {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	if *controlPlane == "" || *token == "" {
		log.Error("VPN_CONTROL_PLANE and VPN_NODE_TOKEN are required (see `npm run node:add`)")
		os.Exit(2)
	}

	controller := wgctl.New(*iface)
	controller.UseSudo = *useSudo

	agent := &agent{
		baseURL: strings.TrimRight(*controlPlane, "/"),
		token:   *token,
		wg:      controller,
		log:     log,
		http:    &http.Client{Timeout: 30 * time.Second},
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *once {
		if err := agent.syncOnce(ctx); err != nil {
			log.Error("sync failed", "error", err)
			os.Exit(1)
		}
		return
	}

	agent.run(ctx)
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

type agent struct {
	baseURL string
	token   string
	wg      *wgctl.Controller
	log     *slog.Logger
	http    *http.Client

	// The poll cadence the control plane last asked for. It owns the schedule
	// so a fleet can be slowed down centrally during an incident.
	lastInterval time.Duration
}

func (a *agent) run(ctx context.Context) {
	// Start at the default cadence; the control plane sets the real one.
	interval := 10 * time.Second
	failures := 0

	for {
		if err := a.syncOnce(ctx); err != nil {
			failures++
			// Back off so a control plane outage does not turn a fleet into a
			// thundering herd, but never so far that recovery is slow.
			backoff := min(time.Duration(failures)*5*time.Second, 2*time.Minute)
			a.log.Error("sync failed", "error", err, "retryIn", backoff.String(), "consecutiveFailures", failures)

			// The peer table is left exactly as it is. Tearing tunnels down
			// because the control plane is unreachable would turn a control
			// plane outage into a total outage.
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			continue
		}

		failures = 0
		select {
		case <-ctx.Done():
			a.log.Info("stopping; the peer table is left in place")
			return
		case <-time.After(interval):
		}

		if next := a.lastInterval; next > 0 {
			interval = next
		}
	}
}

func (a *agent) syncOnce(ctx context.Context) error {
	// The dump is still read, for the interface key the control plane compares
	// against its own record — a node rebuilt with a new key would otherwise
	// hand every client a config that can never handshake. The per-peer half of
	// the dump is deliberately discarded.
	interfaceKey, _, err := a.wg.Dump(ctx)
	if err != nil {
		return fmt.Errorf("reading the interface: %w", err)
	}

	response, err := a.post(ctx, syncRequest{
		InterfacePublicKey: interfaceKey,
		AgentVersion:       "vpn-node-agent/" + Version,
	})
	if err != nil {
		return err
	}

	if response.Server.InterfaceName != "" && response.Server.InterfaceName != a.wg.Interface {
		// Applying another node's peer list to this interface would be worse
		// than doing nothing at all.
		return fmt.Errorf("the control plane expects interface %q but this agent manages %q",
			response.Server.InterfaceName, a.wg.Interface)
	}

	result, err := a.wg.Sync(ctx, response.Peers)
	if err != nil {
		return fmt.Errorf("applying peers: %w", err)
	}

	if result.Added > 0 || result.Removed > 0 {
		a.log.Info("peers reconciled",
			"region", response.Server.Region,
			"added", result.Added,
			"removed", result.Removed,
			"total", result.Total)
	} else {
		a.log.Debug("no change", "total", result.Total)
	}

	if response.PollAfterSeconds > 0 {
		a.lastInterval = time.Duration(response.PollAfterSeconds) * time.Second
	}
	return nil
}

func (a *agent) post(ctx context.Context, body syncRequest) (*syncResponse, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, a.baseURL+"/node/sync", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("authorization", "Bearer "+a.token)

	response, err := a.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("reaching the control plane: %w", err)
	}
	defer response.Body.Close()

	// Bound the read: a control plane that has gone wrong must not be able to
	// exhaust a node's memory.
	raw, err := io.ReadAll(io.LimitReader(response.Body, 32<<20))
	if err != nil {
		return nil, err
	}

	if response.StatusCode == http.StatusUnauthorized {
		return nil, errors.New("the node token was rejected; re-provision it with `npm run node:add --rotate-token`")
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("control plane returned %d: %s",
			response.StatusCode, strings.TrimSpace(string(raw)))
	}

	var decoded syncResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, fmt.Errorf("decoding the response: %w", err)
	}
	return &decoded, nil
}
