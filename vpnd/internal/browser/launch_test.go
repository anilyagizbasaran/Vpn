package browser

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// These exercise the real spawning path against a real binary, because that is
// where the failures live: a configuration that never arrives, a port line
// nobody reads, a process left running. None of it is visible from the state
// machine in supervisor_test.go.
//
// The binary is a small Go program compiled by the test rather than the actual
// helper, which would need a WireGuard server to do anything at all.

// buildStub compiles a stand-in helper and returns its path.
func buildStub(t *testing.T, source string) string {
	t.Helper()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go toolchain to build the stub with")
	}

	dir := t.TempDir()
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("main.go", source)
	write("go.mod", "module stub\n\ngo 1.26\n")

	name := "stub"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(dir, name)

	build := exec.Command("go", "build", "-o", path, ".")
	build.Dir = dir
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("building the stub: %v\n%s", err, output)
	}
	return path
}

// goodStub reads a configuration, writes it out where the configuration's own
// first line says to, listens on loopback, announces the port, and exits when
// its stdin closes.
//
// The record path travels inside the configuration rather than in an
// environment variable, so the thing that proves the file was written is the
// same thing that proves the configuration arrived intact.
const goodStub = `package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
)

func main() {
	in := bufio.NewReader(os.Stdin)

	var config strings.Builder
	for {
		line, err := in.ReadString('\n')
		if strings.TrimRight(line, "\r\n") == "." {
			break
		}
		config.WriteString(line)
		if err != nil {
			break
		}
	}

	if path, rest, ok := strings.Cut(config.String(), "\n"); ok {
		_ = os.WriteFile(strings.TrimSpace(path), []byte(rest), 0o600)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		os.Exit(1)
	}
	fmt.Printf("{\"socksPort\":%d}\n", listener.Addr().(*net.TCPAddr).Port)

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()

	// The parent going away is the signal to stop.
	_, _ = io.Copy(io.Discard, in)
}
`

// silentStub starts and never says anything, which is what a helper that
// cannot build its tunnel looks like from out here.
const silentStub = `package main

import (
	"io"
	"os"
)

func main() {
	_, _ = io.Copy(io.Discard, os.Stdin)
	select {}
}
`

// exitingStub dies immediately, as one handed a configuration it cannot use
// would.
const exitingStub = `package main

func main() {}
`

func launchStub(t *testing.T, path, config string) (Session, error) {
	t.Helper()
	return NewLauncher(path, Credentials{})(context.Background(), config)
}

func loopback(port int) string {
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
}

func TestTheHelperGetsItsConfigurationAndAnnouncesAPort(t *testing.T) {
	stub := buildStub(t, goodStub)
	record := filepath.Join(t.TempDir(), "config")

	session, err := launchStub(t, stub, record+"\n[Interface]\nPrivateKey = k\n")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Stop() })

	if session.Port() <= 0 {
		t.Fatalf("port %d", session.Port())
	}

	// The port is not just a number in a reply: something is listening on it.
	conn, err := net.DialTimeout("tcp", loopback(session.Port()), 3*time.Second)
	if err != nil {
		t.Fatalf("nothing is listening on the announced port: %v", err)
	}
	conn.Close()

	written, err := os.ReadFile(record)
	if err != nil {
		t.Fatalf("the helper never received a configuration: %v", err)
	}
	if !strings.Contains(string(written), "PrivateKey = k") {
		t.Fatalf("the helper received %q", written)
	}
	// The sentinel is framing, not configuration.
	if strings.Contains(string(written), "\n"+configEnd+"\n") {
		t.Fatalf("the sentinel was passed through as configuration: %q", written)
	}
}

func TestTheConfigurationIsNeverAnArgument(t *testing.T) {
	// Arguments are readable by every process on the machine, and this one
	// contains a private key. This is the test that says so.
	stub := buildStub(t, goodStub)

	session, err := launchStub(t, stub, "[Interface]\nPrivateKey = k\n")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Stop() })

	spawned, ok := session.(*process)
	if !ok {
		t.Fatalf("not a process: %T", session)
	}
	if extra := spawned.cmd.Args[1:]; len(extra) > 0 {
		t.Fatalf("the helper was given arguments: %q", extra)
	}
}

func TestStoppingEndsTheProcessAndItsListener(t *testing.T) {
	stub := buildStub(t, goodStub)

	session, err := launchStub(t, stub, "[Interface]\n")
	if err != nil {
		t.Fatal(err)
	}
	port := session.Port()

	if err := session.Stop(); err != nil {
		t.Fatal(err)
	}

	select {
	case <-session.Exited():
	case <-time.After(5 * time.Second):
		t.Fatal("the helper was still running after Stop")
	}

	// And the listener went with it. A proxy that outlives the daemon is a
	// tunnel nothing can take down.
	if conn, err := net.DialTimeout("tcp", loopback(port), time.Second); err == nil {
		conn.Close()
		t.Fatal("something is still listening on the proxy port")
	}
}

func TestAHelperThatNeverAnswersIsNotLeftRunning(t *testing.T) {
	stub := buildStub(t, silentStub)

	// A context rather than waiting out the fifteen-second timeout: what is
	// under test is the cleanup, not the clock.
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	session, err := NewLauncher(stub, Credentials{})(ctx, "[Interface]\n")
	if err == nil {
		_ = session.Stop()
		t.Fatal("a helper that said nothing was accepted")
	}
}

func TestAHelperThatDiesAtStartupIsReported(t *testing.T) {
	stub := buildStub(t, exitingStub)

	if _, err := launchStub(t, stub, "[Interface]\n"); err == nil {
		t.Fatal("a helper that exited immediately was accepted")
	}
}

func TestAMissingHelperIsNamedNotGuessedAt(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "not-here")

	_, err := launchStub(t, missing, "[Interface]\n")
	if err == nil {
		t.Fatal("a missing helper was accepted")
	}
	// The operator has to be able to act on this, which means being told where
	// it was looked for.
	if !strings.Contains(err.Error(), "not-here") {
		t.Fatalf("the error does not name the path: %v", err)
	}
}
