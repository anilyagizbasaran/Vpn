module vpnd

go 1.26

// No third-party dependencies on purpose. This binary runs with CAP_NET_ADMIN
// or as a Windows service under LocalSystem, so every dependency it takes is a
// dependency running at that privilege level. The standard library plus the
// official WireGuard tooling already covers what it needs.
