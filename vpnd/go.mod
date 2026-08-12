module vpnd

go 1.26

// One dependency, and the bar it had to clear.
//
// This binary runs with CAP_NET_ADMIN on Linux and as LocalSystem on Windows,
// so every dependency it takes runs at that privilege level. The rule is still
// no third-party code; golang.org/x/sys is the exception because it is the Go
// team's own package, it is what the official WireGuard client for Windows is
// built on, and the alternative is worse.
//
// The alternative was hand-rolling the service control protocol over advapi32
// with syscall.NewCallback: a C callback into Go, hand-laid struct memory and
// pointers that must outlive the call. Roughly two hundred lines that cannot
// be tested without installing a service, running as LocalSystem, to replace
// a package the Go team maintains.

require golang.org/x/sys v0.47.0
