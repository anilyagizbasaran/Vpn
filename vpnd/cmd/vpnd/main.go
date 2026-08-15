// Command vpnd is the privileged half of the desktop client.
//
// It exists because the tunnel needs privileges the GUI must not have: on
// Windows a WireGuard tunnel service, on Linux CAP_NET_ADMIN. Running the
// whole GUI elevated to avoid a daemon would put an Electron-sized attack
// surface at root, which is why Mullvad, Tailscale and every other desktop
// VPN split the same way.
//
// It deliberately knows nothing about the account: no tokens, no API calls.
// The GUI authenticates, fetches a config and hands the finished config over.
// Stealing the daemon does not give you the account; stealing the GUI does not
// give you root.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"vpnd/internal/enroll"
	"vpnd/internal/ipc"
	"vpnd/internal/tunnel"
)

func main() {
	var (
		socketPath = flag.String("socket", ipc.DefaultSocketPath(), "path of the control socket")
		iface      = flag.String("interface", "vpn0", "name of the WireGuard interface to manage")
		configDir  = flag.String("config-dir", tunnel.DefaultConfigDir(), "directory for the tunnel configuration")
		mock       = flag.Bool("mock", false, "simulate the tunnel instead of touching a real interface")
		killSwitch = flag.Bool("kill-switch", false,
			"block traffic that is not going through the tunnel (Linux; Windows does this itself)")
		verbose = flag.Bool("verbose", false, "log at debug level")
		showVer = flag.Bool("version", false, "print the version and exit")
	)
	flag.Parse()

	if *showVer {
		fmt.Println(ipc.Version)
		return
	}

	level := slog.LevelInfo
	if *verbose {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	// Under the service control manager the lifecycle is its to drive: it
	// decides when to stop, and it expects to be told when the service is
	// running. From a console the signal handling below is the whole story.
	if isWindowsService() {
		serve := func(ctx context.Context) error {
			return run(ctx, log, *socketPath, *iface, *configDir, *mock, *killSwitch)
		}
		if err := runService(log, serviceName, serve); err != nil {
			log.Error("vpnd stopped", "error", err)
			os.Exit(1)
		}
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, log, *socketPath, *iface, *configDir, *mock, *killSwitch); err != nil {
		log.Error("vpnd stopped", "error", err)
		os.Exit(1)
	}
}

// Matches the name install-windows.ps1 registers. The SCM passes it back on
// start, and a mismatch is rejected before Execute ever runs.
const serviceName = "vpnd"

func run(
	ctx context.Context,
	log *slog.Logger,
	socketPath, iface, configDir string,
	mock, killSwitch bool,
) error {
	var driver tunnel.Driver
	if mock {
		log.Warn("mock driver active — no real tunnel will be configured")
		driver = &tunnel.MockDriver{}
	} else {
		exec := tunnel.NewExecDriver()
		exec.ConfigDir = configDir
		driver = exec
	}

	manager := tunnel.NewManager(driver, iface, log)
	manager.SetKillSwitch(chooseKillSwitch(killSwitch, mock))

	// Before anything can connect. A previous run that crashed with the rules
	// installed leaves a machine with no network and nothing on screen to
	// explain it, so a fresh process clears that first — whether or not the
	// kill switch is enabled this time.
	if err := manager.ReleaseKillSwitch(ctx); err != nil {
		log.Error("could not clear a previous traffic block", "error", err)
	}

	// Where the device identity lives. Beside the tunnel config on purpose:
	// one directory to lock down, and the mock driver writes to neither.
	identity := enroll.NewStore(configDir)

	listener, err := ipc.Listen(socketPath)
	if err != nil {
		return err
	}
	defer listener.Close()

	log.Info("vpnd listening",
		"socket", socketPath,
		"interface", iface,
		"driver", driver.Name(),
		"killSwitch", manager.KillSwitchName(),
		"version", ipc.Version)

	serveErr := make(chan error, 1)
	go func() { serveErr <- ipc.NewServer(manager, identity, log).Serve(ctx, listener) }()

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
	}

	// A tunnel must never outlive the daemon that manages it: nothing else
	// would be able to take it down, and the user would be left believing a
	// dead process is protecting them.
	log.Info("shutting down, tearing the tunnel down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	manager.Shutdown(shutdownCtx)

	return nil
}

// chooseKillSwitch picks the leak protection for this platform.
//
// Windows gets none from us on purpose: wireguard.exe already installs WFP
// filters that drop untunneled traffic for the configs this daemon accepts.
// A second mechanism would be another way to strand a machine offline without
// blocking anything the first one does not.
func chooseKillSwitch(enabled, mock bool) tunnel.KillSwitch {
	switch {
	case mock:
		// The mock driver never touches a real interface; touching a real
		// firewall from it would be a surprising way to lose a network.
		return tunnel.NoKillSwitch{Reason: "mock driver"}
	case !enabled:
		return tunnel.NoKillSwitch{Reason: "not enabled"}
	case runtime.GOOS == "windows":
		return tunnel.NoKillSwitch{Reason: "wireguard.exe blocks untunneled traffic itself"}
	case runtime.GOOS == "linux":
		return tunnel.NewNftKillSwitch()
	default:
		return tunnel.NoKillSwitch{Reason: "not implemented on " + runtime.GOOS}
	}
}
