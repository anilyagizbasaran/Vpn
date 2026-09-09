package browser

import (
	"fmt"
	"os/exec"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// applyCredentials runs the helper on a restricted token.
//
// Windows has no cheap equivalent of dropping to another uid: the daemon is a
// service running as LocalSystem, and starting a process as the logged-in user
// means finding their session and duplicating their token — a large amount of
// code with a lot of ways to be subtly wrong.
//
// A restricted token is the part that is both small and worth having. Every
// privilege is removed and the Administrators group becomes a deny-only entry,
// so the helper cannot use an access right it was granted by being SYSTEM. It
// still runs as SYSTEM; what it can do with that is close to nothing.
func applyCredentials(cmd *exec.Cmd, _ Credentials) error {
	var self windows.Token
	err := windows.OpenProcessToken(
		windows.CurrentProcess(),
		windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY|windows.TOKEN_ASSIGN_PRIMARY,
		&self,
	)
	if err != nil {
		return fmt.Errorf("could not read this process's token: %w", err)
	}
	defer self.Close()

	restricted, err := restrictToken(self)
	if err != nil {
		return err
	}

	// Not closed here: os/exec needs it live through Start, and there is no
	// hook that runs at the right moment afterwards. One handle per start.
	cmd.SysProcAttr = &syscall.SysProcAttr{Token: syscall.Token(restricted)}
	return nil
}

// disableMaxPrivilege is CreateRestrictedToken's DISABLE_MAX_PRIVILEGE: strip
// every privilege rather than naming them, so a privilege added to the service
// account later is stripped too.
const disableMaxPrivilege = 0x1

// createRestrictedToken is not wrapped by golang.org/x/sys/windows. Declaring
// it is nine integer arguments and no callbacks — unlike the service control
// protocol this daemon deliberately does not hand-roll.
var (
	advapi32                  = windows.NewLazySystemDLL("advapi32.dll")
	procCreateRestrictedToken = advapi32.NewProc("CreateRestrictedToken")
)

func restrictToken(self windows.Token) (windows.Token, error) {
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return 0, fmt.Errorf("could not name the administrators group: %w", err)
	}
	deny := []windows.SIDAndAttributes{{Sid: admins}}

	var restricted windows.Token
	ret, _, callErr := syscall.SyscallN(
		procCreateRestrictedToken.Addr(),
		uintptr(self),
		uintptr(disableMaxPrivilege),
		uintptr(len(deny)),
		uintptr(unsafe.Pointer(&deny[0])),
		0, 0,
		0, 0,
		uintptr(unsafe.Pointer(&restricted)),
	)
	runtime.KeepAlive(admins)
	runtime.KeepAlive(deny)

	if ret == 0 {
		return 0, fmt.Errorf("could not build an unprivileged token: %w", callErr)
	}
	return restricted, nil
}
