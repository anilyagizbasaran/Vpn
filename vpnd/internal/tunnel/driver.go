// Package tunnel owns the privileged half of the product: it is the only code
// that touches a network interface.
package tunnel

import (
	"context"
	"fmt"
)

// Driver brings one WireGuard interface up and down.
//
// An interface rather than a concrete type for the same reason the control
// plane has one: the real implementations shell out to tooling that cannot run
// in a test, and a state machine that can only be exercised on a configured
// VPS is a state machine that is never exercised.
type Driver interface {
	// Up installs and starts the tunnel. Must be idempotent: calling it while
	// the tunnel is already up reconfigures it rather than failing.
	Up(ctx context.Context, iface string, config string) error

	// Down stops the tunnel and removes any config written to disk. Bringing
	// down an interface that is not up is not an error.
	Down(ctx context.Context, iface string) error

	// Name identifies the driver in logs and in the version handshake.
	Name() string
}

// FailureError marks a driver failure whose message is safe to show a user.
// Anything else is logged and reported as a generic internal error, because
// tool output can contain paths and configuration details.
type FailureError struct {
	Op      string
	Message string
	Err     error
}

func (e *FailureError) Error() string {
	if e.Err == nil {
		return fmt.Sprintf("%s: %s", e.Op, e.Message)
	}
	return fmt.Sprintf("%s: %s: %v", e.Op, e.Message, e.Err)
}

func (e *FailureError) Unwrap() error { return e.Err }

// UserMessage is what the GUI shows. Deliberately excludes Err.
func (e *FailureError) UserMessage() string { return e.Message }
