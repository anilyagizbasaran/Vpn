//go:build !windows

package browser

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"syscall"
)

// applyCredentials drops the helper to an unprivileged account.
//
// Only when the daemon is actually root. Run from a normal shell — which is
// how it is developed and how a user-session install works — there is nothing
// to drop, and trying would fail on a machine where nothing was wrong.
func applyCredentials(cmd *exec.Cmd, creds Credentials) error {
	if os.Geteuid() != 0 {
		return nil
	}

	name := creds.user()
	account, err := user.Lookup(name)
	if err != nil {
		// Refused rather than run as root. This is the whole reason the helper
		// is a separate binary; starting it privileged because an account was
		// missing would quietly give up the thing being protected.
		return fmt.Errorf(
			"the browser tunnel cannot run unprivileged: there is no %q account. "+
				"Start the daemon with --browser-proxy-user naming one", name)
	}

	uid, err := parseID(account.Uid)
	if err != nil {
		return fmt.Errorf("the %q account has an unreadable user id", name)
	}
	gid, err := parseID(account.Gid)
	if err != nil {
		return fmt.Errorf("the %q account has an unreadable group id", name)
	}

	cmd.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{
			Uid: uid,
			Gid: gid,
			// No supplementary groups. Inheriting root's would hand back some
			// of what dropping the uid just took away.
			NoSetGroups: false,
			Groups:      []uint32{gid},
		},
	}
	return nil
}

// parseID reads a uid or gid. macOS gives nobody the id -2, which is that
// value as a signed number and 4294967294 as the unsigned one the kernel
// wants, so both spellings have to be accepted.
func parseID(raw string) (uint32, error) {
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, err
	}
	return uint32(value), nil
}
