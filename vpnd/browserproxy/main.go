// Command vpn-browser-proxy carries one browser's traffic through WireGuard
// without touching the machine's networking.
//
// It exists so "browser only" mode can hold two properties at once that the
// ordinary tunnel cannot:
//
//   - Nothing about the system changes. No TUN device, no routes, no firewall
//     rules — so `ip route` and `wg show` look exactly as they did, and every
//     other program keeps its normal connection.
//   - No privileges are needed. The tunnel terminates in this process, so this
//     runs as the ordinary user.
//
// The second one is why this is a separate program rather than a mode inside
// vpnd. vpnd runs as root or LocalSystem and its module deliberately carries
// almost no third-party code, because everything it links runs at that
// privilege. A userspace network stack is a large dependency; putting it here
// keeps it out of the privileged process, where a flaw in it would be worth
// far more to an attacker.
//
// The configuration arrives on stdin, never in an argument, so it does not
// appear in the process list of a shared machine. stdin then stays open for
// the life of the process: the parent holding it is what keeps this one
// meaningful, and an orphan carrying a live tunnel is the outcome most worth
// ruling out.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
)

// ready is the single line printed to stdout once the proxy is listening. The
// parent reads it to learn the port, so it stays machine-readable and is the
// only thing ever written there.
type ready struct {
	SocksPort int `json:"socksPort"`
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	if err := run(log); err != nil {
		log.Error("browser proxy stopped", "error", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	stdin := bufio.NewReader(os.Stdin)

	raw, err := readConfig(stdin)
	if err != nil {
		return err
	}

	cfg, err := parseConfig(raw)
	if err != nil {
		return err
	}

	dev, tunnel, err := startTunnel(cfg, log)
	if err != nil {
		return err
	}
	defer dev.Close()

	// Port 0: the operating system picks a free one and the parent is told
	// which. A fixed port would collide with whatever else is on the machine
	// and would let any page guess where the proxy lives.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listening for the browser: %w", err)
	}

	port := listener.Addr().(*net.TCPAddr).Port
	dialer := newTunnelDialer(tunnel.Stack(), cfg.Addresses, cfg.DNS)
	server := newSocksServer(dialer, listener, func(msg string, args ...any) {
		log.Warn(msg, args...)
	})

	if err := announce(port); err != nil {
		return err
	}
	log.Info("browser proxy listening", "port", port)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		_ = server.Close()
	}()

	// The other way out. If the parent is killed rather than asked to stop,
	// nothing sends a signal here — but the pipe it held closes, and that is
	// the difference between a tunnel that ends with the daemon and one left
	// running with nobody able to take it down.
	go func() {
		_, _ = io.Copy(io.Discard, stdin)
		log.Info("the parent went away; stopping")
		_ = server.Close()
	}()

	return server.Serve()
}

// configEnd terminates the configuration on stdin.
//
// A sentinel rather than end-of-stream, because the stream has a second job:
// it stays open afterwards so this process learns when its parent dies. A lone
// dot cannot occur in a wg-quick config, whose every line is a section header
// or a key = value.
const configEnd = "."

// readConfig reads up to the sentinel.
func readConfig(in *bufio.Reader) (string, error) {
	var b strings.Builder
	for {
		line, err := in.ReadString('\n')
		if trimmed := strings.TrimRight(line, "\r\n"); trimmed == configEnd {
			return b.String(), nil
		}
		b.WriteString(line)
		if err != nil {
			if errors.Is(err, io.EOF) {
				// Tolerated: a configuration handed over and the pipe closed
				// straight away still describes a tunnel, and refusing it
				// would make this program impossible to try by hand.
				return b.String(), nil
			}
			return "", fmt.Errorf("reading the configuration: %w", err)
		}
	}
}

// startTunnel brings up wireguard-go against the in-process stack.
func startTunnel(cfg tunnelConfig, log *slog.Logger) (*device.Device, *netTun, error) {
	tunnel, err := newNetTun(cfg.Addresses, cfg.MTU)
	if err != nil {
		return nil, nil, fmt.Errorf("building the network stack: %w", err)
	}

	// wireguard-go's own logger is wired to nothing above Error. Its verbose
	// level prints handshakes and endpoints, which on this project is a
	// connection log by another name.
	logger := &device.Logger{
		Verbosef: func(string, ...any) {},
		Errorf:   func(format string, args ...any) { log.Error(fmt.Sprintf(format, args...)) },
	}

	dev := device.NewDevice(tunnel, conn.NewDefaultBind(), logger)

	uapi, err := cfg.uapi()
	if err != nil {
		dev.Close()
		return nil, nil, err
	}
	if err := dev.IpcSet(uapi); err != nil {
		dev.Close()
		return nil, nil, fmt.Errorf("configuring the tunnel: %w", err)
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, nil, fmt.Errorf("starting the tunnel: %w", err)
	}
	return dev, tunnel, nil
}

func announce(port int) error {
	out := bufio.NewWriter(os.Stdout)
	if err := json.NewEncoder(out).Encode(ready{SocksPort: port}); err != nil {
		return err
	}
	return out.Flush()
}
