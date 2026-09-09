package browser

// Credentials says what the helper is allowed to be.
//
// The daemon runs with CAP_NET_ADMIN or as LocalSystem. The helper parses
// packets from the network with eighty-odd third-party modules and needs no
// privileges at all, so it is given none: on Unix it drops to an unprivileged
// account, and on Windows it runs on a token with its privileges stripped.
type Credentials struct {
	// User is the account to drop to on Unix when the daemon is root.
	// Empty means [DefaultUser]. Ignored on Windows.
	User string
}

// DefaultUser exists on every Linux and macOS install, owns nothing, and can
// log in nowhere. The helper writes no files, so it needs nothing else.
const DefaultUser = "nobody"

func (c Credentials) user() string {
	if c.User != "" {
		return c.User
	}
	return DefaultUser
}
