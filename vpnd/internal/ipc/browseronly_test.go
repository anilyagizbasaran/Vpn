package ipc

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"vpnd/internal/browser"
	"vpnd/internal/protocol"
)

// fakeHelper stands in for the browser tunnel process.
type fakeHelper struct {
	mu      sync.Mutex
	port    int
	stopped int
	exited  chan struct{}
}

func newFakeHelper(port int) *fakeHelper {
	return &fakeHelper{port: port, exited: make(chan struct{})}
}

func (f *fakeHelper) Port() int               { return f.port }
func (f *fakeHelper) Exited() <-chan struct{} { return f.exited }

func (f *fakeHelper) Stop() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stopped++
	select {
	case <-f.exited:
	default:
		close(f.exited)
	}
	return nil
}

// withBrowser builds a harness whose daemon can run a browser-only tunnel,
// and hands back what the launcher was given.
func withBrowser(t *testing.T, port int) (*harness, func() string) {
	t.Helper()

	var mu sync.Mutex
	var launched string

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	supervisor := browser.New(func(_ context.Context, config string) (browser.Session, error) {
		mu.Lock()
		launched = config
		mu.Unlock()
		return newFakeHelper(port), nil
	}, log)

	h := newHarnessWith(t, func(s *Server) { s.SetBrowser(supervisor) })
	return h, func() string {
		mu.Lock()
		defer mu.Unlock()
		return launched
	}
}

// remember gives the daemon a config to start the browser tunnel from,
// without leaving the system-wide tunnel up.
func (h *harness) remember(t *testing.T, id uint64) {
	t.Helper()
	h.send(id, protocol.MethodUp, protocol.UpParams{
		Config: testConfig, ServerAddress: "vpn.example.com:51820",
	})
	if response := h.response(id); !response.OK {
		t.Fatalf("up failed: %v", response.Error)
	}
	h.send(id+1, protocol.MethodDown, nil)
	if response := h.response(id + 1); !response.OK {
		t.Fatalf("down failed: %v", response.Error)
	}
}

func browserResult(t *testing.T, response protocol.Response) protocol.StatusResult {
	t.Helper()
	if !response.OK {
		t.Fatalf("start_browser_only failed: %v", response.Error)
	}
	var result protocol.StatusResult
	if err := json.Unmarshal(response.Result, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestBrowserOnlyAnswersWithALoopbackProxy(t *testing.T) {
	h, launched := withBrowser(t, 49152)
	h.remember(t, 1)

	h.send(10, protocol.MethodStartBrowserOnly, nil)
	result := browserResult(t, h.response(10))

	if result.SocksPort != 49152 {
		t.Fatalf("port %d", result.SocksPort)
	}
	// The host is sent rather than assumed by the caller: a browser configured
	// from a constant of its own is how a proxy ends up advertised on a real
	// interface instead of loopback.
	if result.SocksHost != "127.0.0.1" {
		t.Fatalf("host %q", result.SocksHost)
	}
	if !result.BrowserOnly {
		t.Fatal("the reply does not say the browser tunnel is on")
	}
	if launched() == "" {
		t.Fatal("the helper was started without a configuration")
	}
}

func TestBrowserOnlyDoesNotTouchTheInterface(t *testing.T) {
	// The acceptance criterion for the whole mode: nothing system-wide
	// changes. If the driver is ever called here, `ip route` and `wg show`
	// would show a tunnel the user did not ask for.
	h, _ := withBrowser(t, 49152)
	h.remember(t, 1)

	before := h.driver.UpCalls

	h.send(10, protocol.MethodStartBrowserOnly, nil)
	browserResult(t, h.response(10))

	if h.driver.UpCalls != before {
		t.Fatalf("the interface was brought up %d extra times", h.driver.UpCalls-before)
	}

	h.send(11, protocol.MethodStatus, nil)
	var status protocol.StatusResult
	if err := json.Unmarshal(h.response(11).Result, &status); err != nil {
		t.Fatal(err)
	}
	if status.Stage != protocol.StageDisconnected {
		t.Fatalf("stage is %q; the system-wide tunnel should still be off", status.Stage)
	}
	if !status.BrowserOnly || status.SocksPort != 49152 {
		t.Fatalf("status does not report the browser tunnel: %+v", status)
	}
}

func TestTheTwoModesRefuseToRunTogether(t *testing.T) {
	// Two tunnels to the same peer would be two paths for the same traffic,
	// with nothing on the machine able to say which one carried a request.
	t.Run("browser-only while the full tunnel is up", func(t *testing.T) {
		h, _ := withBrowser(t, 49152)
		h.send(1, protocol.MethodUp, protocol.UpParams{
			Config: testConfig, ServerAddress: "vpn.example.com:51820",
		})
		if response := h.response(1); !response.OK {
			t.Fatalf("up failed: %v", response.Error)
		}

		h.send(2, protocol.MethodStartBrowserOnly, nil)
		if response := h.response(2); response.OK {
			t.Fatal("browser-only started on top of the full tunnel")
		}
	})

	t.Run("the full tunnel while browser-only is on", func(t *testing.T) {
		h, _ := withBrowser(t, 49152)
		h.remember(t, 1)

		h.send(10, protocol.MethodStartBrowserOnly, nil)
		browserResult(t, h.response(10))

		h.send(11, protocol.MethodUp, protocol.UpParams{
			Config: testConfig, ServerAddress: "vpn.example.com:51820",
		})
		response := h.response(11)
		if response.OK {
			t.Fatal("the full tunnel came up while browser-only was running")
		}
		if response.Error.Code != protocol.CodeBadRequest {
			t.Fatalf("code %q", response.Error.Code)
		}

		// Reconnect is the same door with no config attached; it has to be
		// closed too, or the extension's own button walks straight through.
		h.send(12, protocol.MethodReconnect, nil)
		if h.response(12).OK {
			t.Fatal("reconnect brought the full tunnel up during browser-only")
		}

		// And enrolment, which ends by bringing the tunnel up. Refused before
		// the invite is spent, because a code is only good once.
		h.send(13, protocol.MethodEnroll, protocol.EnrollParams{
			ServerAddress: "https://vpn.example.com",
			InviteToken:   "CODE",
		})
		if reply := h.response(13); reply.OK {
			t.Fatal("enrolment brought the full tunnel up during browser-only")
		} else if reply.Error.Code != protocol.CodeBadRequest {
			// Specifically the exclusion, not some unrelated refusal that
			// would let this test keep passing after the guard was removed.
			t.Fatalf("enrol refused with %q", reply.Error.Code)
		}
	})
}

func TestStoppingBrowserOnlyClearsTheStatus(t *testing.T) {
	h, _ := withBrowser(t, 49152)
	h.remember(t, 1)

	h.send(10, protocol.MethodStartBrowserOnly, nil)
	browserResult(t, h.response(10))

	h.send(11, protocol.MethodStopBrowserOnly, nil)
	response := h.response(11)
	if !response.OK {
		t.Fatalf("stop failed: %v", response.Error)
	}

	var status protocol.StatusResult
	if err := json.Unmarshal(response.Result, &status); err != nil {
		t.Fatal(err)
	}
	if status.BrowserOnly || status.SocksPort != 0 {
		t.Fatalf("still reported as running: %+v", status)
	}

	// Twice, because the caller that most needs this is an extension being
	// switched off, which cannot know whether anything is running.
	h.send(12, protocol.MethodStopBrowserOnly, nil)
	if !h.response(12).OK {
		t.Fatal("stopping an already stopped browser tunnel failed")
	}
}

func TestBrowserOnlyNeedsTheMachineToBeSetUp(t *testing.T) {
	h, _ := withBrowser(t, 49152)

	// Nothing enrolled and no config remembered: there is genuinely nothing
	// to build a tunnel from, and saying so beats starting a helper that
	// would fail somewhere the user cannot see.
	h.send(1, protocol.MethodStartBrowserOnly, nil)
	response := h.response(1)
	if response.OK {
		t.Fatal("a browser tunnel started with no configuration")
	}
	if response.Error.Code != protocol.CodeUnsupported {
		t.Fatalf("code %q", response.Error.Code)
	}
}

func TestADaemonWithoutBrowserSupportSaysSo(t *testing.T) {
	h := newHarness(t)

	for id, method := range map[uint64]string{
		1: protocol.MethodStartBrowserOnly,
		2: protocol.MethodStopBrowserOnly,
	} {
		h.send(id, method, nil)
		response := h.response(id)
		if response.OK {
			t.Fatalf("%s succeeded without a supervisor", method)
		}
		if response.Error.Code != protocol.CodeUnsupported {
			t.Fatalf("%s answered %q", method, response.Error.Code)
		}
	}
}

func TestAnIncompleteInstallSaysWhatIsMissing(t *testing.T) {
	// A daemon upgraded on top of an older install has everything except the
	// helper binary. "The browser tunnel could not be started" would send the
	// user looking at their network for a problem that is on their disk.
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	supervisor := browser.New(func(context.Context, string) (browser.Session, error) {
		return nil, &browser.SetupError{
			Message: "The browser tunnel helper (vpn-browser-proxy) is not installed.",
		}
	}, log)

	h := newHarnessWith(t, func(s *Server) { s.SetBrowser(supervisor) })
	h.remember(t, 1)

	h.send(10, protocol.MethodStartBrowserOnly, nil)
	response := h.response(10)
	if response.OK {
		t.Fatal("a missing helper was reported as a success")
	}
	if !strings.Contains(response.Error.Message, "vpn-browser-proxy") {
		t.Fatalf("the message does not name the missing file: %q", response.Error.Message)
	}
}
