// Package browser runs the browser-only tunnel.
//
// Browser-only mode connects one browser to the VPN and leaves the rest of
// the machine alone: no interface is created, no route is changed, and every
// other program keeps its ordinary connection. The tunnel is terminated in
// userspace by a helper process that offers a SOCKS5 listener on loopback.
//
// The helper is a separate binary for two reasons. It needs a userspace
// network stack, which is eighty-odd third-party modules that would otherwise
// be parsing hostile packets inside a process running as root; and it needs no
// privileges of its own, so there is no reason for it to have any. What it
// does need is the configuration, which contains the device's private key and
// exists nowhere but this daemon — which is why the daemon starts it rather
// than the app doing so directly.
package browser

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
)

// Session is one running helper.
//
// An interface rather than the process itself so the state machine below can
// be tested without a binary on disk: the failures worth pinning here are
// "started twice", "reported running after it died" and "left behind after
// Stop", none of which are about process spawning.
type Session interface {
	// Port is the loopback port its SOCKS listener accepts on.
	Port() int

	// Stop ends it and waits. Must succeed when it has already exited.
	Stop() error

	// Exited closes when the helper ends on its own.
	Exited() <-chan struct{}
}

// Launcher starts one helper with the given wg-quick configuration.
type Launcher func(ctx context.Context, config string) (Session, error)

// SetupError is a failure the person at the keyboard can act on: the helper is
// not installed, or the account it should drop to does not exist.
//
// Distinguished from every other failure because the answer is different. A
// tunnel that would not come up is "try again"; a helper that is not there is
// "the install is incomplete", and reporting the second as the first sends
// someone looking at their network for a problem that is on their disk.
type SetupError struct {
	Message string
	Err     error
}

func (e *SetupError) Error() string {
	if e.Err == nil {
		return e.Message
	}
	return e.Message + ": " + e.Err.Error()
}

func (e *SetupError) Unwrap() error { return e.Err }

// Supervisor owns at most one helper at a time.
type Supervisor struct {
	launch Launcher
	log    *slog.Logger

	mu      sync.Mutex
	current Session
	// Bumped on every start so a watcher from an old session cannot clear the
	// state of a new one. Without it, stopping and starting quickly leaves a
	// goroutine that fires late and reports the live tunnel as gone.
	generation uint64
}

// New builds a supervisor over a launcher.
func New(launch Launcher, log *slog.Logger) *Supervisor {
	return &Supervisor{launch: launch, log: log}
}

// Start brings the browser-only tunnel up and returns the SOCKS port.
//
// Starting while one is already running replaces it. The configuration may
// have changed — a new device key, a different server — and answering with the
// old port would connect the browser to a tunnel the caller did not ask for.
func (s *Supervisor) Start(ctx context.Context, config string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.current != nil {
		s.stopLocked()
	}

	session, err := s.launch(ctx, config)
	if err != nil {
		return 0, err
	}
	if session.Port() <= 0 {
		// A helper that started but never said where it is listening is not
		// usable, and leaving it running would be a tunnel nothing can reach
		// and nothing will ever stop.
		_ = session.Stop()
		return 0, fmt.Errorf("the browser tunnel did not report a port")
	}

	s.current = session
	s.generation++
	go s.watch(session, s.generation)

	s.log.Info("browser-only tunnel started", "port", session.Port())
	return session.Port(), nil
}

// Stop ends it. Not an error when nothing is running: the caller that most
// needs this — an extension being switched off — cannot know whether it is.
func (s *Supervisor) Stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopLocked()
}

func (s *Supervisor) stopLocked() error {
	if s.current == nil {
		return nil
	}
	session := s.current
	s.current = nil
	// Bumped here as well, so the watcher for this session finds a stale
	// generation and does not log an exit the user asked for as a failure.
	s.generation++

	if err := session.Stop(); err != nil {
		s.log.Warn("the browser tunnel did not stop cleanly", "error", err)
		return err
	}
	s.log.Info("browser-only tunnel stopped")
	return nil
}

// Running reports the port, and whether anything is listening on it.
func (s *Supervisor) Running() (int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current == nil {
		return 0, false
	}
	return s.current.Port(), true
}

// watch clears the state when a helper dies on its own.
//
// The browser fails closed either way — a proxy that is not there refuses
// connections rather than sending them in the clear — but the status the user
// is looking at must not go on claiming a tunnel that is gone.
func (s *Supervisor) watch(session Session, generation uint64) {
	<-session.Exited()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation != generation || s.current != session {
		return // Already replaced or stopped on purpose.
	}
	s.current = nil
	s.log.Warn("the browser tunnel exited on its own")
}
