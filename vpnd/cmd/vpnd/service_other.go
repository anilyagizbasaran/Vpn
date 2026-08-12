//go:build !windows

package main

import (
	"context"
	"log/slog"
)

// Everywhere else the init system runs a plain foreground process and reads
// its exit status — systemd and launchd both — so there is nothing to
// integrate with and these stay stubs.

func runService(*slog.Logger, string, func(ctx context.Context) error) error {
	panic("runService is only reachable on Windows")
}

func isWindowsService() bool { return false }
