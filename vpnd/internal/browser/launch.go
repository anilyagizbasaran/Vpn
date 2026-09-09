package browser

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

// HelperName is the binary the daemon starts. It ships beside vpnd.
const HelperName = "vpn-browser-proxy"

// startTimeout bounds how long the helper gets to report its port. Long
// enough for a cold start on a slow disk, short enough that a helper which
// will never answer does not leave the caller waiting on a button press.
const startTimeout = 15 * time.Second

// process is a helper running as a child of this daemon.
type process struct {
	cmd  *exec.Cmd
	port int

	// The pipe the configuration went down, held open for the helper's whole
	// life. It is how the helper learns this daemon has gone: if vpnd is
	// killed rather than asked to stop, no signal is sent, but the operating
	// system closes this and the helper sees the end of its own stdin.
	stdin io.WriteCloser

	exited   chan struct{}
	stopOnce sync.Once
}

func (p *process) Port() int               { return p.port }
func (p *process) Exited() <-chan struct{} { return p.exited }

// stopWait bounds how long a helper gets to be gone. Nothing can survive a
// kill this long, so reaching it means something is wrong enough to report.
const stopWait = 5 * time.Second

func (p *process) Stop() error {
	var err error
	p.stopOnce.Do(func() {
		// Closed first: it is the polite half, and the helper exits when its
		// stdin does. Most of the time it is gone before the kill lands.
		if p.stdin != nil {
			_ = p.stdin.Close()
		}

		// Killed rather than signalled. The helper holds no state worth
		// flushing, and a graceful shutdown path would be one more thing that
		// can hang while the user is waiting for the proxy to go away.
		if killErr := p.cmd.Process.Kill(); killErr != nil {
			// Killing races with the helper leaving of its own accord, and
			// losing that race is reported as a failure — os.ErrProcessDone
			// once Wait has caught up, and TerminateProcess answering "access
			// denied" on Windows before it has. Neither is a problem. The only
			// question that matters is whether the process is gone.
			if !p.gone(stopWait) {
				err = killErr
			}
			return
		}
		if !p.gone(stopWait) {
			err = fmt.Errorf("the browser tunnel did not exit after being stopped")
		}
	})
	return err
}

// gone reports whether the process has ended within d.
func (p *process) gone(d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()

	select {
	case <-p.exited:
		return true
	case <-timer.C:
		return false
	}
}

// NewLauncher returns a [Launcher] that runs the helper binary.
//
// helperPath may be empty, in which case the binary is looked for next to this
// executable — an install puts them in the same directory, and searching PATH
// would let anything earlier on it answer as the VPN.
func NewLauncher(helperPath string, drop Credentials) Launcher {
	return func(ctx context.Context, config string) (Session, error) {
		path, err := resolveHelper(helperPath)
		if err != nil {
			return nil, err
		}
		return start(ctx, path, config, drop)
	}
}

func resolveHelper(helperPath string) (string, error) {
	if helperPath != "" {
		if _, err := os.Stat(helperPath); err != nil {
			return "", &SetupError{
				Message: "The browser tunnel helper is not at " + helperPath,
				Err:     err,
			}
		}
		return helperPath, nil
	}

	self, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("could not locate the browser tunnel helper: %w", err)
	}
	name := HelperName
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(filepath.Dir(self), name)
	if _, err := os.Stat(path); err != nil {
		// Named, because this is the actionable case: a daemon upgraded on
		// top of an older install has everything except this one file, and
		// "the browser tunnel could not be started" would send the user
		// looking at their network for a problem that is on their disk.
		return "", &SetupError{
			Message: "The browser tunnel helper (" + name + ") is not installed next to the VPN service.",
			Err:     err,
		}
	}
	return path, nil
}

func start(ctx context.Context, path, config string, drop Credentials) (Session, error) {
	// Not exec.CommandContext: the helper has to outlive the request that
	// started it. Its lifetime is the supervisor's, not this call's.
	cmd := exec.Command(path)

	// The configuration goes in on stdin, never in an argument. Arguments are
	// readable by every process on the machine, and this one is a private key.
	//
	// A pipe rather than cmd.Stdin, because it has to stay open afterwards:
	// see [process.stdin].
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	// Discarded rather than logged. The helper writes nothing it should say
	// out loud, and a crash trace from a network stack would be full of
	// addresses the user is here to not have recorded.
	cmd.Stderr = io.Discard

	if err := applyCredentials(cmd, drop); err != nil {
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("could not start the browser tunnel: %w", err)
	}

	p := &process{cmd: cmd, stdin: stdin, exited: make(chan struct{})}
	go func() {
		_ = cmd.Wait()
		close(p.exited)
	}()

	if err := writeConfig(stdin, config); err != nil {
		_ = cmd.Process.Kill()
		<-p.exited
		return nil, err
	}

	port, err := readPort(ctx, stdout, p.exited)
	if err != nil {
		_ = cmd.Process.Kill()
		<-p.exited
		return nil, err
	}
	p.port = port

	// Drained from here on so the helper cannot block on a full pipe if it
	// ever writes a second line.
	go func() { _, _ = io.Copy(io.Discard, stdout) }()

	return p, nil
}

// readPort waits for the one line the helper prints on startup.
func readPort(ctx context.Context, stdout io.Reader, exited <-chan struct{}) (int, error) {
	type answer struct {
		port int
		err  error
	}
	answers := make(chan answer, 1)

	go func() {
		reader := bufio.NewReader(stdout)
		line, err := reader.ReadBytes('\n')
		if err != nil && len(line) == 0 {
			answers <- answer{err: fmt.Errorf("the browser tunnel said nothing before exiting")}
			return
		}
		var reply struct {
			SocksPort int `json:"socksPort"`
		}
		if err := json.Unmarshal(line, &reply); err != nil {
			answers <- answer{err: fmt.Errorf("the browser tunnel reported something unreadable")}
			return
		}
		answers <- answer{port: reply.SocksPort}
	}()

	timer := time.NewTimer(startTimeout)
	defer timer.Stop()

	select {
	case a := <-answers:
		return a.port, a.err
	case <-exited:
		// Racy with the read above only in the good case; give the goroutine
		// the moment it needs to deliver a line already in the pipe.
		select {
		case a := <-answers:
			return a.port, a.err
		case <-time.After(time.Second):
			return 0, fmt.Errorf("the browser tunnel stopped before it was ready")
		}
	case <-timer.C:
		return 0, fmt.Errorf("the browser tunnel did not start in time")
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

// writeConfig hands the configuration over and leaves the pipe open.
//
// The sentinel is what lets it stay open: without one the helper would have to
// read to end-of-stream, and closing the pipe is the only signal this daemon
// has that it is still alive.
func writeConfig(stdin io.Writer, config string) error {
	payload := []byte(config + "\n" + configEnd + "\n")
	_, err := stdin.Write(payload)

	// Overwritten once handed over. It does not remove every copy — the child
	// has one, and Go may have moved the string — but it takes the obvious one
	// out of a long-lived daemon's heap.
	for i := range payload {
		payload[i] = 0
	}

	if err != nil {
		return fmt.Errorf("could not send the configuration to the browser tunnel: %w", err)
	}
	return nil
}

// configEnd matches the sentinel the helper reads up to. A lone dot cannot
// occur in a wg-quick config, whose every line is a section header or a
// key = value.
const configEnd = "."
