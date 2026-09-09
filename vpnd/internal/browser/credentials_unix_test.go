//go:build !windows

package browser

import (
	"errors"
	"os/exec"
	"os/user"
	"syscall"
	"testing"
)

func TestTheDefaultAccountExists(t *testing.T) {
	// The helper drops to this account rather than staying root, and the drop
	// fails closed: no account means no browser-only mode. A default that is
	// not real on the systems this ships to would take the feature with it,
	// and the failure only appears on the machine, at the button.
	if _, err := user.Lookup(DefaultUser); err != nil {
		t.Fatalf("there is no %q account on this system: %v", DefaultUser, err)
	}
}

func TestParseIDAcceptsTheNegativeIdMacOsUses(t *testing.T) {
	// macOS gives nobody the id -2, which is that number as a signed value and
	// 4294967294 as the unsigned one the kernel wants. Refusing it would leave
	// browser-only mode unavailable on every Mac.
	got, err := parseID("-2")
	if err != nil {
		t.Fatal(err)
	}
	if got != 4294967294 {
		t.Fatalf("parseID(-2) = %d", got)
	}

	if _, err := parseID("not a number"); err == nil {
		t.Fatal("a non-numeric id was accepted")
	}
}

func TestAnUnprivilegedDaemonDropsNothing(t *testing.T) {
	// Run from a normal shell — which is how this is developed, and how a
	// user-session install works — there is nothing to drop. Trying would fail
	// on a machine where nothing was wrong.
	if syscall.Geteuid() == 0 {
		t.Skip("running as root; this is the case where dropping does happen")
	}

	cmd := exec.Command("/bin/true")
	if err := applyCredentials(cmd, Credentials{}); err != nil {
		t.Fatalf("applyCredentials as an ordinary user: %v", err)
	}
	if cmd.SysProcAttr != nil {
		t.Fatal("credentials were set on a process that had nothing to drop")
	}
}

func TestAMissingAccountIsRefusedNotIgnored(t *testing.T) {
	if syscall.Geteuid() != 0 {
		t.Skip("only root reaches the account lookup")
	}

	cmd := exec.Command("/bin/true")
	err := applyCredentials(cmd, Credentials{User: "definitely-not-an-account"})
	if err == nil {
		t.Fatal("a missing account was ignored, leaving the helper as root")
	}

	// And it says which flag fixes it. This is the one error an operator has
	// to act on rather than retry.
	var setup *SetupError
	if !errors.As(err, &setup) {
		t.Fatalf("not reported as a setup problem: %v", err)
	}
}
