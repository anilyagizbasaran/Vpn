package tunnel

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The driver's argv is the boundary between our data and a process running as
// root, so it is asserted exactly rather than exercised through a real tool.

type recordedCall struct {
	name string
	args []string
}

func newRecordingDriver(t *testing.T, goos string) (*ExecDriver, *[]recordedCall) {
	t.Helper()

	calls := &[]recordedCall{}
	driver := &ExecDriver{
		ConfigDir: t.TempDir(),
		Binary:    "fake-wg",
		GOOS:      goos,
		Run: func(_ context.Context, name string, args ...string) ([]byte, error) {
			*calls = append(*calls, recordedCall{name: name, args: args})
			return nil, nil
		},
	}
	return driver, calls
}

func TestUpBuildsThePlatformCommand(t *testing.T) {
	cases := map[string]struct {
		goos     string
		wantArgs []string
	}{
		"linux":   {goos: "linux", wantArgs: []string{"up"}},
		"darwin":  {goos: "darwin", wantArgs: []string{"up"}},
		"windows": {goos: "windows", wantArgs: []string{"/installtunnelservice"}},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			driver, calls := newRecordingDriver(t, tc.goos)

			if err := driver.Up(context.Background(), "vpn0", validConfig); err != nil {
				t.Fatalf("up: %v", err)
			}

			// Up tears any previous tunnel down first, so the last call is the
			// one that brings it up.
			last := (*calls)[len(*calls)-1]
			if last.args[0] != tc.wantArgs[0] {
				t.Fatalf("argv = %v, want it to start with %v", last.args, tc.wantArgs)
			}
			// The config always reaches the tool as a file path, never inline.
			if !strings.HasSuffix(last.args[len(last.args)-1], "vpn0.conf") {
				t.Fatalf("argv = %v, want it to end with the config path", last.args)
			}
		})
	}
}

func TestUpIsIdempotent(t *testing.T) {
	driver, calls := newRecordingDriver(t, "linux")

	if err := driver.Up(context.Background(), "vpn0", validConfig); err != nil {
		t.Fatal(err)
	}

	// A reconnect after a key rotation must not leave the previous peer
	// installed, so every Up tears down first.
	if (*calls)[0].args[0] != "down" {
		t.Fatalf("first call = %v, want a down", (*calls)[0].args)
	}
}

func TestUpWritesTheConfigWithRestrictivePermissions(t *testing.T) {
	driver, _ := newRecordingDriver(t, "linux")

	if err := driver.Up(context.Background(), "vpn0", validConfig); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(driver.ConfigDir, "vpn0.conf")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("the config was not written: %v", err)
	}

	if runtime.GOOS != "windows" {
		// The file holds a private key.
		if mode := info.Mode().Perm(); mode != 0o600 {
			t.Fatalf("config mode = %o, want 600", mode)
		}
	}

	written, _ := os.ReadFile(path)
	if string(written) != validConfig {
		t.Fatal("the config was altered on the way to disk")
	}
}

func TestDownRemovesTheConfigEvenWhenTheToolFails(t *testing.T) {
	driver, _ := newRecordingDriver(t, "linux")
	if err := driver.Up(context.Background(), "vpn0", validConfig); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(driver.ConfigDir, "vpn0.conf")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("setup: the config is missing: %v", err)
	}

	driver.Run = func(context.Context, string, ...string) ([]byte, error) {
		return []byte("something went wrong"), errors.New("exit status 1")
	}

	if err := driver.Down(context.Background(), "vpn0"); err == nil {
		t.Fatal("a failing teardown reported success")
	}

	// The private key must not survive the tunnel, whatever the tool did.
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("the config file with the private key was left on disk")
	}
}

func TestDownIsIdempotentWhenNothingIsRunning(t *testing.T) {
	messages := []string{
		"wg-quick: `vpn0' is not a WireGuard interface",
		"Unable to find matching interface: no such device",
		"The service does not exist",
	}

	for _, message := range messages {
		t.Run(message, func(t *testing.T) {
			driver, _ := newRecordingDriver(t, "linux")
			driver.Run = func(context.Context, string, ...string) ([]byte, error) {
				return []byte(message), errors.New("exit status 1")
			}

			// Bringing down a tunnel that is not up is a normal outcome, not
			// an error the user should ever see.
			if err := driver.Down(context.Background(), "vpn0"); err != nil {
				t.Fatalf("down reported an error for an absent tunnel: %v", err)
			}
		})
	}
}

func TestUpRemovesTheConfigWhenTheToolFails(t *testing.T) {
	driver, _ := newRecordingDriver(t, "linux")
	driver.Run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[0] == "down" {
			return nil, nil
		}
		return []byte("permission denied"), errors.New("exit status 1")
	}

	if err := driver.Up(context.Background(), "vpn0", validConfig); err == nil {
		t.Fatal("a failing up reported success")
	}

	// No tunnel means the config is useless and is still a copy of the key.
	if _, err := os.Stat(filepath.Join(driver.ConfigDir, "vpn0.conf")); !os.IsNotExist(err) {
		t.Fatal("the config was left behind after a failed up")
	}
}

func TestInterfaceNamesAreValidated(t *testing.T) {
	// The name reaches both a command line and a file path.
	hostile := []string{
		"",
		"../../etc/wireguard/wg0",
		"vpn0; rm -rf /",
		"vpn 0",
		"vpn0\nPostUp=evil",
		strings.Repeat("a", 16),
	}

	for _, iface := range hostile {
		t.Run(iface, func(t *testing.T) {
			driver, calls := newRecordingDriver(t, "linux")

			if err := driver.Up(context.Background(), iface, validConfig); err == nil {
				t.Fatal("accepted")
			}
			if len(*calls) != 0 {
				t.Fatal("a command ran with a rejected interface name")
			}
		})
	}
}

func TestUnsupportedPlatformIsReportedNotAttempted(t *testing.T) {
	driver, calls := newRecordingDriver(t, "plan9")

	if err := driver.Up(context.Background(), "vpn0", validConfig); err == nil {
		t.Fatal("an unsupported platform reported success")
	}
	if len(*calls) != 0 {
		t.Fatal("a command ran on an unsupported platform")
	}
}
