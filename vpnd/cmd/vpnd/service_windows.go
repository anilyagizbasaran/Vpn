//go:build windows

package main

import (
	"context"
	"log/slog"

	"golang.org/x/sys/windows/svc"
)

// Windows starts a service and then waits to be told it is running. A program
// that simply begins working never sends that, so the service control manager
// waits its thirty seconds and reports that the service "did not respond to
// the start or control request in a timely fashion" — which describes the
// symptom and not the cause, and is what this file exists to prevent.
//
// Nothing here changes how vpnd behaves from a console. `svc.IsWindowsService`
// tells the two apart, so the same binary is both.

type vpndService struct {
	log *slog.Logger
	run func(ctx context.Context) error
}

// runService hands control to the SCM and blocks until the service stops.
func runService(log *slog.Logger, name string, run func(ctx context.Context) error) error {
	return svc.Run(name, &vpndService{log: log, run: run})
}

// isWindowsService reports whether this process was started by the SCM.
func isWindowsService() bool {
	inService, err := svc.IsWindowsService()
	if err != nil {
		// Guessing "yes" would make a console run hang waiting for a control
		// manager that is not there; guessing "no" only loses the service
		// integration, and the daemon still works.
		return false
	}
	return inService
}

func (s *vpndService) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown

	status <- svc.Status{State: svc.StartPending}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- s.run(ctx) }()

	status <- svc.Status{State: svc.Running, Accepts: accepted}

	for {
		select {
		case err := <-done:
			// The daemon stopped on its own — a socket it cannot bind, a
			// tunnel driver that is missing. Reporting a non-zero exit code
			// is what makes the SCM's restart policy apply.
			if err != nil {
				s.log.Error("vpnd stopped", "error", err)
				return false, 1
			}
			return false, 0

		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				status <- request.CurrentStatus

			case svc.Stop, svc.Shutdown:
				// StopPending before cancelling, so the SCM waits rather than
				// killing the process while the tunnel is coming down.
				status <- svc.Status{State: svc.StopPending}
				cancel()
				<-done
				return false, 0
			}
		}
	}
}
