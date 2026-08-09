// Package ipc exposes the daemon to the unprivileged GUI over a local socket.
package ipc

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
)

// DefaultSocketPath is where the GUI looks for the daemon.
//
// A filesystem socket, never a TCP port on loopback. Loopback TCP is reachable
// by every process on the machine with no way to apply an ACL, and browsers
// can be made to POST at it — which is how Tailscale's Windows client ended up
// with a local API vulnerability. A socket file carries permissions.
//
// AF_UNIX is used on Windows too: it has been supported since Windows 10
// build 17063, which lets the daemon keep one implementation instead of a
// named-pipe fork with its own security-descriptor code.
func DefaultSocketPath() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(os.Getenv("ProgramData"), "vpnd", "vpnd.sock")
	}
	return "/run/vpnd/vpnd.sock"
}

// Listen creates the socket, replacing a stale one left by a crash.
//
// The permission story differs by platform and neither is the last line of
// defence: whatever can reach this socket can still only ask for a *validated*
// tunnel config (see tunnel.ValidateConfig), which is what actually stops a
// local user turning the daemon into a root shell.
func Listen(path string) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("creating the socket directory: %w", err)
	}

	// A socket file left behind by a crash makes Listen fail with "address
	// already in use"; removing it is safe because a live daemon holds an
	// exclusive lock on the same path through the OS.
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("removing the stale socket: %w", err)
	}

	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("listening on %s: %w", path, err)
	}

	if runtime.GOOS != "windows" {
		// 0660 with a `vpn` group: members of that group may drive the tunnel,
		// nobody else can. The installer adds the desktop user to it.
		if err := os.Chmod(path, 0o660); err != nil {
			listener.Close()
			return nil, fmt.Errorf("restricting the socket permissions: %w", err)
		}
	}

	return listener, nil
}
