package tunnel

import (
	"context"
	"sync"
)

// MockDriver simulates a tunnel in memory.
//
// Two jobs: it makes the state machine testable on a machine with no
// WireGuard, and it backs the daemon's `--mock` flag so the desktop GUI can be
// developed without an elevated install. Same reasoning as the control plane's
// mock WireGuard controller.
type MockDriver struct {
	mu sync.Mutex

	Up_        bool
	LastConfig string
	UpCalls    int
	DownCalls  int

	// Set to make the next call fail.
	UpErr   error
	DownErr error
}

func (d *MockDriver) Name() string { return "mock" }

func (d *MockDriver) Up(_ context.Context, _ string, config string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	d.UpCalls++
	if d.UpErr != nil {
		return d.UpErr
	}
	d.Up_ = true
	d.LastConfig = config
	return nil
}

func (d *MockDriver) Down(_ context.Context, _ string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	d.DownCalls++
	if d.DownErr != nil {
		return d.DownErr
	}
	d.Up_ = false
	return nil
}

// IsUp reports the simulated interface state.
func (d *MockDriver) IsUp() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.Up_
}

// Config is the last config installed. Read through the mutex because the
// daemon writes it from its own goroutine, which -race is right to complain
// about when a test reads the field directly.
func (d *MockDriver) Config() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.LastConfig
}

// Calls is how many times the tunnel was brought up.
func (d *MockDriver) Calls() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.UpCalls
}
