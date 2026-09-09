package browser

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

func quiet() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// fakeSession stands in for the helper process.
type fakeSession struct {
	port int

	mu      sync.Mutex
	stopped int
	exited  chan struct{}
	stopErr error
}

func newFake(port int) *fakeSession {
	return &fakeSession{port: port, exited: make(chan struct{})}
}

func (f *fakeSession) Port() int               { return f.port }
func (f *fakeSession) Exited() <-chan struct{} { return f.exited }

func (f *fakeSession) Stop() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stopped++
	select {
	case <-f.exited:
	default:
		close(f.exited)
	}
	return f.stopErr
}

func (f *fakeSession) stops() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stopped
}

// die simulates the helper going away by itself.
func (f *fakeSession) die() {
	f.mu.Lock()
	defer f.mu.Unlock()
	select {
	case <-f.exited:
	default:
		close(f.exited)
	}
}

// waitFor polls a condition rather than sleeping a fixed time, so the tests
// that watch a goroutine do not become the slow ones or the flaky ones.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestStartingReportsWhereTheBrowserShouldConnect(t *testing.T) {
	session := newFake(41234)
	s := New(func(context.Context, string) (Session, error) { return session, nil }, quiet())

	port, err := s.Start(context.Background(), "[Interface]\n")
	if err != nil {
		t.Fatal(err)
	}
	if port != 41234 {
		t.Fatalf("port %d", port)
	}

	got, running := s.Running()
	if !running || got != 41234 {
		t.Fatalf("Running reported %d, %v", got, running)
	}
}

func TestStartingAgainReplacesTheRunningTunnel(t *testing.T) {
	// The config may have changed — a new key, a different server. Handing
	// back the old port would point the browser at a tunnel nobody asked for,
	// and leaving the old process alive would be a second way out of the
	// machine that nothing is tracking.
	first, second := newFake(1111), newFake(2222)
	next := []Session{first, second}

	s := New(func(context.Context, string) (Session, error) {
		session := next[0]
		next = next[1:]
		return session, nil
	}, quiet())

	if _, err := s.Start(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	port, err := s.Start(context.Background(), "b")
	if err != nil {
		t.Fatal(err)
	}

	if port != 2222 {
		t.Fatalf("port %d, want the new one", port)
	}
	if first.stops() != 1 {
		t.Fatalf("the replaced tunnel was stopped %d times", first.stops())
	}
	if got, _ := s.Running(); got != 2222 {
		t.Fatalf("Running reports %d", got)
	}
}

func TestTheReplacedTunnelsWatcherDoesNotClearTheNewOne(t *testing.T) {
	// The old session's watcher fires when it dies, which is a moment after
	// the new one is already installed. Getting this wrong reports the live
	// tunnel as gone and leaves the browser pointed at a proxy the status
	// screen says is not running.
	first, second := newFake(1111), newFake(2222)
	next := []Session{first, second}
	s := New(func(context.Context, string) (Session, error) {
		session := next[0]
		next = next[1:]
		return session, nil
	}, quiet())

	if _, err := s.Start(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Start(context.Background(), "b"); err != nil {
		t.Fatal(err)
	}
	first.die()

	// Given a moment to do the wrong thing, if it is going to.
	time.Sleep(50 * time.Millisecond)
	if port, running := s.Running(); !running || port != 2222 {
		t.Fatalf("the new tunnel was cleared: %d, %v", port, running)
	}
}

func TestStoppingWhenNothingRunsIsNotAFailure(t *testing.T) {
	// The caller that most needs this is a browser extension being switched
	// off, which has no way to know whether anything is running.
	s := New(func(context.Context, string) (Session, error) {
		t.Fatal("nothing should have been launched")
		return nil, nil
	}, quiet())

	if err := s.Stop(); err != nil {
		t.Fatalf("Stop with nothing running: %v", err)
	}
	if _, running := s.Running(); running {
		t.Fatal("Running is true with nothing started")
	}
}

func TestAHelperThatDiesStopsBeingReportedAsRunning(t *testing.T) {
	// The browser fails closed when the proxy goes away — a refused connection
	// is not a leak. But the status the user reads must not go on claiming a
	// tunnel that is not there.
	session := newFake(3333)
	s := New(func(context.Context, string) (Session, error) { return session, nil }, quiet())

	if _, err := s.Start(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	session.die()

	waitFor(t, "the dead tunnel to be cleared", func() bool {
		_, running := s.Running()
		return !running
	})
}

func TestAHelperThatNeverReportsAPortIsNotLeftRunning(t *testing.T) {
	session := newFake(0)
	s := New(func(context.Context, string) (Session, error) { return session, nil }, quiet())

	if _, err := s.Start(context.Background(), "a"); err == nil {
		t.Fatal("a helper with no port was accepted")
	}
	if session.stops() != 1 {
		t.Fatal("a helper that could not be used was left running")
	}
	if _, running := s.Running(); running {
		t.Fatal("Running is true after a failed start")
	}
}

func TestAFailedLaunchLeavesNothingBehind(t *testing.T) {
	s := New(func(context.Context, string) (Session, error) {
		return nil, errors.New("no helper installed")
	}, quiet())

	if _, err := s.Start(context.Background(), "a"); err == nil {
		t.Fatal("a failed launch was reported as a success")
	}
	if _, running := s.Running(); running {
		t.Fatal("Running is true after a launch that failed")
	}
}

func TestStopEndsTheHelperAndClearsTheState(t *testing.T) {
	session := newFake(4444)
	s := New(func(context.Context, string) (Session, error) { return session, nil }, quiet())

	if _, err := s.Start(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	if session.stops() != 1 {
		t.Fatalf("stopped %d times", session.stops())
	}
	if _, running := s.Running(); running {
		t.Fatal("Running is true after Stop")
	}
	// Twice must be quiet, for the same reason as stopping when nothing runs.
	if err := s.Stop(); err != nil {
		t.Fatalf("second Stop: %v", err)
	}
}
