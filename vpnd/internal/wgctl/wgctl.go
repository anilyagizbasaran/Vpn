// Package wgctl drives a WireGuard interface on a VPN node.
//
// Distinct from internal/tunnel, which manages the *client* end: this one
// never creates or destroys an interface, it only reconciles the peer table of
// one that already exists. The node's interface is brought up by wg-quick at
// boot and outlives the agent.
package wgctl

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Runner executes a command. Injectable so the argv can be asserted without a
// WireGuard installation.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

func realRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// Controller reconciles one interface.
type Controller struct {
	Interface string
	Binary    string
	// Prefix commands with `sudo -n`. Unnecessary when the agent runs as root
	// or with CAP_NET_ADMIN, which is the recommended install.
	UseSudo bool
	Run     Runner
}

func New(iface string) *Controller {
	return &Controller{Interface: iface, Binary: "wg", Run: realRunner}
}

func (c *Controller) run(ctx context.Context, args ...string) ([]byte, error) {
	binary := c.Binary
	if binary == "" {
		binary = "wg"
	}
	if c.UseSudo {
		return c.Run(ctx, "sudo", append([]string{"-n", binary}, args...)...)
	}
	return c.Run(ctx, binary, args...)
}

// PeerStat is one peer's counters, as reported by the interface.
type PeerStat struct {
	PublicKey     string
	Endpoint      string
	AllowedIPs    []string
	LastHandshake time.Time
	RxBytes       int64
	TxBytes       int64
}

// Dump reads the interface state.
//
// `wg show <if> dump` is tab-separated: the first line describes the
// interface, every line after it a peer. Parsing the dump rather than the
// human-readable output is deliberate — the latter is formatted for people and
// has changed shape between releases.
func (c *Controller) Dump(ctx context.Context) (interfaceKey string, peers []PeerStat, err error) {
	output, err := c.run(ctx, "show", c.Interface, "dump")
	if err != nil {
		return "", nil, fmt.Errorf("wg show %s dump: %w: %s",
			c.Interface, err, strings.TrimSpace(string(output)))
	}

	lines := strings.Split(strings.TrimRight(string(output), "\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) == "" {
		return "", nil, fmt.Errorf("wg show %s dump returned nothing", c.Interface)
	}

	// interface: private-key, public-key, listen-port, fwmark
	head := strings.Split(lines[0], "\t")
	if len(head) < 2 {
		return "", nil, fmt.Errorf("unexpected interface line: %q", lines[0])
	}
	interfaceKey = head[1]

	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		// peer: public-key, preshared-key, endpoint, allowed-ips,
		//       latest-handshake, rx, tx, persistent-keepalive
		fields := strings.Split(line, "\t")
		if len(fields) < 7 {
			continue
		}

		stat := PeerStat{PublicKey: fields[0]}
		if fields[2] != "(none)" {
			stat.Endpoint = fields[2]
		}
		if fields[3] != "(none)" {
			stat.AllowedIPs = strings.Split(fields[3], ",")
		}
		// Zero means "never", not the Unix epoch.
		if seconds, convErr := strconv.ParseInt(fields[4], 10, 64); convErr == nil && seconds > 0 {
			stat.LastHandshake = time.Unix(seconds, 0).UTC()
		}
		stat.RxBytes, _ = strconv.ParseInt(fields[5], 10, 64)
		stat.TxBytes, _ = strconv.ParseInt(fields[6], 10, 64)

		peers = append(peers, stat)
	}

	return interfaceKey, peers, nil
}

// DesiredPeer is what the control plane says should be on the interface.
type DesiredPeer struct {
	PublicKey    string   `json:"publicKey"`
	AllowedIPs   []string `json:"allowedIps"`
	PresharedKey string   `json:"presharedKey,omitempty"`
}

// SyncResult reports what changed.
type SyncResult struct {
	Added   int
	Removed int
	Total   int
}

// Sync makes the interface match desired, in a single `wg set` call.
//
// One call rather than one per peer: a node with a few thousand devices would
// otherwise spend its poll interval forking. `wg set` accepts any number of
// peer blocks, and a block may be an upsert or a removal, so the whole
// reconciliation fits in one invocation.
//
// Deliberately not `wg setconf`: that replaces the interface section too, and
// would need the node's private key on the agent's command line.
func (c *Controller) Sync(ctx context.Context, desired []DesiredPeer) (SyncResult, error) {
	_, live, err := c.Dump(ctx)
	if err != nil {
		return SyncResult{}, err
	}

	present := make(map[string]bool, len(live))
	for _, peer := range live {
		present[peer.PublicKey] = true
	}
	wanted := make(map[string]bool, len(desired))

	args := []string{"set", c.Interface}
	result := SyncResult{Total: len(desired)}

	// Preshared keys can only be passed as files, so they go into one
	// temporary directory that is removed before this returns.
	var pskDir string
	defer func() {
		if pskDir != "" {
			_ = os.RemoveAll(pskDir)
		}
	}()

	for i, peer := range desired {
		if err := ValidateKey(peer.PublicKey); err != nil {
			return SyncResult{}, fmt.Errorf("peer %d: %w", i, err)
		}
		wanted[peer.PublicKey] = true

		// Re-applying a peer that is already there is free and repairs drifted
		// allowed-ips, so the whole desired set goes in unconditionally.
		args = append(args, "peer", peer.PublicKey, "allowed-ips", strings.Join(peer.AllowedIPs, ","))

		if peer.PresharedKey != "" {
			if err := ValidateKey(peer.PresharedKey); err != nil {
				return SyncResult{}, fmt.Errorf("peer %d preshared key: %w", i, err)
			}
			if pskDir == "" {
				pskDir, err = os.MkdirTemp("", "wgnode-")
				if err != nil {
					return SyncResult{}, fmt.Errorf("creating a temporary directory: %w", err)
				}
			}
			path := filepath.Join(pskDir, fmt.Sprintf("peer-%d.psk", i))
			if err := os.WriteFile(path, []byte(peer.PresharedKey+"\n"), 0o600); err != nil {
				return SyncResult{}, fmt.Errorf("writing a preshared key: %w", err)
			}
			args = append(args, "preshared-key", path)
		}

		if !present[peer.PublicKey] {
			result.Added++
		}
	}

	for _, peer := range live {
		if wanted[peer.PublicKey] {
			continue
		}
		args = append(args, "peer", peer.PublicKey, "remove")
		result.Removed++
	}

	// Nothing to reconcile — skip the subprocess entirely.
	if len(args) == 2 {
		return result, nil
	}

	if output, err := c.run(ctx, args...); err != nil {
		return SyncResult{}, fmt.Errorf("wg set %s: %w: %s",
			c.Interface, err, strings.TrimSpace(string(output)))
	}
	return result, nil
}

// ValidateKey guards every value that reaches the wg argv.
//
// The keys come from the control plane over TLS, but a compromised or
// misbehaving control plane must not be able to inject arguments into a
// command running as root on every node.
func ValidateKey(key string) error {
	if len(key) != 44 || !strings.HasSuffix(key, "=") {
		return fmt.Errorf("not a base64-encoded 32-byte WireGuard key")
	}
	for _, r := range key[:43] {
		isBase64 := (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') ||
			(r >= '0' && r <= '9') || r == '+' || r == '/'
		if !isBase64 {
			return fmt.Errorf("not a base64-encoded 32-byte WireGuard key")
		}
	}
	return nil
}
