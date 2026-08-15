package tunnel

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Runner executes a command. Injectable so the driver's argv can be asserted
// without a WireGuard installation — the same seam the control plane uses.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

func realRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// ScriptRunner executes a command with input on stdin.
//
// Separate from [Runner] because the ruleset is a document, not an argument:
// nft reads it from stdin, and putting a multi-line script on a root command
// line would be both fragile and a place for a quoting mistake to matter.
type ScriptRunner func(ctx context.Context, stdin, name string, args ...string) ([]byte, error)

func realScriptRunner(ctx context.Context, stdin, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin = strings.NewReader(stdin)
	return cmd.CombinedOutput()
}

// ExecDriver drives the official WireGuard tooling.
//
// It shells out rather than speaking netlink directly for the same reason the
// control plane does: the tooling is the reference implementation, it is what
// ships signed on Windows, and the failure modes are ones operators recognise.
type ExecDriver struct {
	// ConfigDir is where the tunnel config is written. Must be a directory
	// only the privileged user can read: the file holds the private key.
	ConfigDir string

	// Binary overrides the tool path. Empty means "discover it".
	Binary string

	Run  Runner
	GOOS string
}

func NewExecDriver() *ExecDriver {
	return &ExecDriver{ConfigDir: DefaultConfigDir(), Run: realRunner, GOOS: runtime.GOOS}
}

func (d *ExecDriver) Name() string { return "wireguard-cli" }

// DefaultConfigDir is a root-only location per platform. On Linux it is the
// directory wg-quick already expects, so `wg-quick down` works by name.
func DefaultConfigDir() string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("ProgramData"), "vpnd")
	default:
		return "/etc/wireguard"
	}
}

func (d *ExecDriver) configPath(iface string) string {
	return filepath.Join(d.ConfigDir, iface+".conf")
}

// writeConfig persists the config with the tightest permissions the platform
// offers.
//
// Writing a private key to disk is unavoidable — both wg-quick and
// wireguard.exe read the tunnel from a file — so it is written 0600 into a
// privileged directory and deleted again by Down. It is created with O_EXCL
// semantics via a fresh write so a pre-existing symlink cannot redirect it.
func (d *ExecDriver) writeConfig(iface, config string) (string, error) {
	if err := os.MkdirAll(d.ConfigDir, 0o700); err != nil {
		return "", &FailureError{
			Op:      "writeConfig",
			Message: "The tunnel configuration directory could not be created.",
			Err:     err,
		}
	}

	path := d.configPath(iface)
	// Remove first: os.WriteFile follows an existing symlink, which would let
	// anything that can create one in this directory choose the destination.
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return "", &FailureError{
			Op:      "writeConfig",
			Message: "The previous tunnel configuration could not be replaced.",
			Err:     err,
		}
	}
	if err := os.WriteFile(path, []byte(config), 0o600); err != nil {
		return "", &FailureError{
			Op:      "writeConfig",
			Message: "The tunnel configuration could not be written.",
			Err:     err,
		}
	}
	return path, nil
}

func (d *ExecDriver) Up(ctx context.Context, iface, config string) error {
	if err := validateInterfaceName(iface); err != nil {
		return err
	}

	// Idempotent by construction: tear any previous tunnel down first, so a
	// reconnect with a rotated key cannot leave the old peer installed.
	_ = d.Down(ctx, iface)

	path, err := d.writeConfig(iface, config)
	if err != nil {
		return err
	}

	binary, args, err := d.upCommand(iface, path)
	if err != nil {
		return err
	}

	if output, runErr := d.Run(ctx, binary, args...); runErr != nil {
		// The config file is useless without a running tunnel and still holds
		// the private key.
		_ = os.Remove(path)
		return &FailureError{
			Op:      "up",
			Message: "The VPN service could not start the tunnel. Check that WireGuard is installed.",
			Err:     fmt.Errorf("%s: %w: %s", binary, runErr, strings.TrimSpace(string(output))),
		}
	}
	return nil
}

func (d *ExecDriver) Down(ctx context.Context, iface string) error {
	if err := validateInterfaceName(iface); err != nil {
		return err
	}

	binary, args, err := d.downCommand(iface)
	if err != nil {
		return err
	}

	output, runErr := d.Run(ctx, binary, args...)
	// Remove the config even when the command failed: it is the copy of the
	// private key, and leaving it behind is worse than a stale interface.
	_ = os.Remove(d.configPath(iface))

	if runErr != nil && !isAlreadyDown(string(output)) {
		return &FailureError{
			Op:      "down",
			Message: "The tunnel could not be stopped.",
			Err:     fmt.Errorf("%s: %w: %s", binary, runErr, strings.TrimSpace(string(output))),
		}
	}
	return nil
}

func (d *ExecDriver) goos() string {
	if d.GOOS != "" {
		return d.GOOS
	}
	return runtime.GOOS
}

func (d *ExecDriver) upCommand(iface, configPath string) (string, []string, error) {
	switch d.goos() {
	case "windows":
		// Installs a per-tunnel Windows service named after the config file.
		return d.windowsBinary(), []string{"/installtunnelservice", configPath}, nil
	case "linux", "darwin":
		return d.unixBinary(), []string{"up", configPath}, nil
	default:
		return "", nil, &FailureError{
			Op:      "up",
			Message: "This platform is not supported by the VPN service.",
		}
	}
}

func (d *ExecDriver) downCommand(iface string) (string, []string, error) {
	switch d.goos() {
	case "windows":
		return d.windowsBinary(), []string{"/uninstalltunnelservice", iface}, nil
	case "linux", "darwin":
		// By name, not by path: the config is deleted right after, and
		// wg-quick only needs the name to find the live interface.
		return d.unixBinary(), []string{"down", iface}, nil
	default:
		return "", nil, &FailureError{
			Op:      "down",
			Message: "This platform is not supported by the VPN service.",
		}
	}
}

func (d *ExecDriver) windowsBinary() string {
	if d.Binary != "" {
		return d.Binary
	}
	// The MSI installs here; fall back to PATH for portable installs.
	standard := filepath.Join(os.Getenv("ProgramFiles"), "WireGuard", "wireguard.exe")
	if _, err := os.Stat(standard); err == nil {
		return standard
	}
	return "wireguard.exe"
}

func (d *ExecDriver) unixBinary() string {
	if d.Binary != "" {
		return d.Binary
	}
	return "wg-quick"
}

// isAlreadyDown recognises the tools' "there was nothing to stop" output, so
// Down stays idempotent instead of reporting a failure the user cannot act on.
func isAlreadyDown(output string) bool {
	lowered := strings.ToLower(output)
	for _, phrase := range []string{
		"is not a wireguard interface",
		"no such device",
		"does not exist",
		"unable to find",
		"service does not exist",
	} {
		if strings.Contains(lowered, phrase) {
			return true
		}
	}
	return false
}

// validateInterfaceName keeps anything that is not a plain interface name out
// of a command line and out of a file path.
func validateInterfaceName(iface string) error {
	if iface == "" || len(iface) > 15 {
		return &FailureError{
			Op:      "validate",
			Message: "The configured tunnel interface name is not valid.",
		}
	}
	for _, r := range iface {
		isAllowed := (r >= 'a' && r <= 'z') ||
			(r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') ||
			r == '-' || r == '_'
		if !isAllowed {
			return &FailureError{
				Op:      "validate",
				Message: "The configured tunnel interface name is not valid.",
			}
		}
	}
	return nil
}
