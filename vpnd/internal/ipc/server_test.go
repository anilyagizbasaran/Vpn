package ipc

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"strings"
	"testing"
	"time"

	"vpnd/internal/enroll"
	"vpnd/internal/protocol"
	"vpnd/internal/tunnel"
)

// End-to-end over a real socket pair: the daemon's only entry point is this
// protocol, so a bug here is a bug nothing else can catch.

type harness struct {
	t       *testing.T
	client  net.Conn
	decoder *protocol.Decoder
	encoder *protocol.Encoder
	driver  *tunnel.MockDriver
	manager *tunnel.Manager
	cancel  context.CancelFunc
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	serverConn, clientConn := net.Pipe()
	driver := &tunnel.MockDriver{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	manager := tunnel.NewManager(driver, "vpn0", log)

	ctx, cancel := context.WithCancel(context.Background())
	// A store in the test's own temp directory: enrolment writes a private
	// key, and a test that wrote one into /etc/wireguard would be a surprise.
	server := NewServer(manager, enroll.NewStore(t.TempDir()), log)
	server.newClient = func(string) enroller { return &stubEnroller{} }
	go server.handle(ctx, serverConn)

	h := &harness{
		t:       t,
		client:  clientConn,
		decoder: protocol.NewDecoder(clientConn),
		encoder: protocol.NewEncoder(clientConn),
		driver:  driver,
		manager: manager,
		cancel:  cancel,
	}
	t.Cleanup(func() {
		cancel()
		clientConn.Close()
	})
	return h
}

func (h *harness) send(id uint64, method string, params any) {
	h.t.Helper()
	request := protocol.Request{ID: id, Method: method}
	if params != nil {
		encoded, err := json.Marshal(params)
		if err != nil {
			h.t.Fatalf("encoding params: %v", err)
		}
		request.Params = encoded
	}
	_ = h.client.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if err := h.encoder.Encode(request); err != nil {
		h.t.Fatalf("sending %s: %v", method, err)
	}
}

// next reads one frame, which may be a response or an event.
func (h *harness) next() map[string]json.RawMessage {
	h.t.Helper()
	_ = h.client.SetReadDeadline(time.Now().Add(2 * time.Second))
	var frame map[string]json.RawMessage
	if err := h.decoder.Decode(&frame); err != nil {
		h.t.Fatalf("reading a frame: %v", err)
	}
	return frame
}

// response skips events until it finds the reply to id.
func (h *harness) response(id uint64) protocol.Response {
	h.t.Helper()
	for i := 0; i < 20; i++ {
		frame := h.next()
		if _, isEvent := frame["event"]; isEvent {
			continue
		}
		raw, _ := json.Marshal(frame)
		var response protocol.Response
		if err := json.Unmarshal(raw, &response); err != nil {
			h.t.Fatalf("decoding a response: %v", err)
		}
		if response.ID == id {
			return response
		}
	}
	h.t.Fatalf("no response for request %d", id)
	return protocol.Response{}
}

func (h *harness) event() protocol.Event {
	h.t.Helper()
	for i := 0; i < 20; i++ {
		frame := h.next()
		if _, isEvent := frame["event"]; !isEvent {
			continue
		}
		raw, _ := json.Marshal(frame)
		var event protocol.Event
		if err := json.Unmarshal(raw, &event); err != nil {
			h.t.Fatalf("decoding an event: %v", err)
		}
		return event
	}
	h.t.Fatal("no event arrived")
	return protocol.Event{}
}

const testConfig = `[Interface]
PrivateKey = cHJpdmF0ZWtleXByaXZhdGVrZXlwcml2YXRla2V5cHJpdmE=
Address = 10.8.0.5/32

[Peer]
PublicKey = c2VydmVycHVibGlja2V5c2VydmVycHVibGlja2V5c2VydmU=
AllowedIPs = 0.0.0.0/0
Endpoint = vpn.example.com:51820
`

func TestVersionHandshake(t *testing.T) {
	h := newHarness(t)
	h.send(1, protocol.MethodVersion, nil)

	response := h.response(1)
	if !response.OK {
		t.Fatalf("version failed: %v", response.Error)
	}

	var result protocol.VersionResult
	if err := json.Unmarshal(response.Result, &result); err != nil {
		t.Fatalf("decoding: %v", err)
	}
	// The GUI refuses to drive a daemon speaking a different revision.
	if result.Protocol != protocol.ProtocolVersion {
		t.Fatalf("protocol = %d, want %d", result.Protocol, protocol.ProtocolVersion)
	}
}

func TestUpAndDown(t *testing.T) {
	h := newHarness(t)

	h.send(1, protocol.MethodUp, protocol.UpParams{
		Config:        testConfig,
		ServerAddress: "vpn.example.com:51820",
	})
	response := h.response(1)
	if !response.OK {
		t.Fatalf("up failed: %v", response.Error)
	}
	if !h.driver.IsUp() {
		t.Fatal("the driver was never asked to bring the tunnel up")
	}

	var status protocol.StatusResult
	_ = json.Unmarshal(response.Result, &status)
	if status.Stage != protocol.StageConnected {
		t.Fatalf("stage = %q, want connected", status.Stage)
	}

	h.send(2, protocol.MethodDown, nil)
	if response := h.response(2); !response.OK {
		t.Fatalf("down failed: %v", response.Error)
	}
	if h.driver.IsUp() {
		t.Fatal("the tunnel is still up after down")
	}
}

// The daemon is reachable by an unprivileged process, so this is the boundary
// where a malicious config would turn it into a root shell.
func TestUpRejectsAConfigWithAShellHook(t *testing.T) {
	h := newHarness(t)

	hostile := "[Interface]\nPrivateKey = k\nPostUp = /bin/sh -c 'id > /tmp/pwned'\n" +
		"\n[Peer]\nPublicKey = p\nAllowedIPs = 0.0.0.0/0\n"

	h.send(1, protocol.MethodUp, protocol.UpParams{Config: hostile})

	response := h.response(1)
	if response.OK {
		t.Fatal("a config with PostUp was accepted")
	}
	if response.Error.Code != protocol.CodeBadRequest {
		t.Fatalf("code = %q, want bad_request", response.Error.Code)
	}
	// Rejected before the driver, so it never reached disk or a command line.
	if h.driver.UpCalls != 0 {
		t.Fatal("the driver was invoked with a rejected config")
	}
}

func TestUpReportsADriverFailureWithoutLeakingDetail(t *testing.T) {
	h := newHarness(t)
	h.driver.UpErr = &tunnel.FailureError{
		Op:      "up",
		Message: "The VPN service could not start the tunnel.",
		Err:     io.ErrUnexpectedEOF,
	}

	h.send(1, protocol.MethodUp, protocol.UpParams{Config: testConfig})

	response := h.response(1)
	if response.OK {
		t.Fatal("a failing driver reported success")
	}
	if response.Error.Code != protocol.CodeTunnelFailure {
		t.Fatalf("code = %q, want tunnel_failure", response.Error.Code)
	}
	if strings.Contains(response.Error.Message, "EOF") {
		t.Fatalf("the underlying error leaked to the client: %q", response.Error.Message)
	}

	h.send(2, protocol.MethodStatus, nil)
	var status protocol.StatusResult
	_ = json.Unmarshal(h.response(2).Result, &status)
	if status.Stage != protocol.StageFailed {
		t.Fatalf("stage = %q, want failed", status.Stage)
	}
}

func TestSubscribeStreamsStageChanges(t *testing.T) {
	h := newHarness(t)

	h.send(1, protocol.MethodSubscribe, nil)
	if response := h.response(1); !response.OK {
		t.Fatalf("subscribe failed: %v", response.Error)
	}

	h.send(2, protocol.MethodUp, protocol.UpParams{Config: testConfig})

	// connecting, then connected — the GUI drives its whole progress display
	// from these.
	if stage := h.event().Stage; stage != protocol.StageConnecting {
		t.Fatalf("first event = %q, want connecting", stage)
	}
	if stage := h.event().Stage; stage != protocol.StageConnected {
		t.Fatalf("second event = %q, want connected", stage)
	}
}

func TestSubscribingTwiceOnOneConnectionIsRejected(t *testing.T) {
	h := newHarness(t)

	h.send(1, protocol.MethodSubscribe, nil)
	h.response(1)

	h.send(2, protocol.MethodSubscribe, nil)
	if response := h.response(2); response.OK {
		t.Fatal("a second subscription on the same connection was accepted")
	}
}

func TestUnknownMethodIsRejected(t *testing.T) {
	h := newHarness(t)
	h.send(1, "rm-rf", nil)

	response := h.response(1)
	if response.OK {
		t.Fatal("an unknown method was accepted")
	}
	if response.Error.Code != protocol.CodeBadRequest {
		t.Fatalf("code = %q, want bad_request", response.Error.Code)
	}
}

func TestMalformedUpParamsAreRejected(t *testing.T) {
	h := newHarness(t)

	// Valid JSON, wrong shape.
	h.send(1, protocol.MethodUp, []string{"not", "an", "object"})

	if response := h.response(1); response.OK {
		t.Fatal("malformed params were accepted")
	}
}

// A GUI that stops reading must not be able to wedge the daemon mid-connect.
func TestASlowSubscriberDoesNotBlockTheStateMachine(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	driver := &tunnel.MockDriver{}
	manager := tunnel.NewManager(driver, "vpn0", log)

	// Subscribe and never read: the buffer fills, then events are dropped.
	_, unsubscribe := manager.Subscribe()
	defer unsubscribe()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 100; i++ {
			_ = manager.Up(context.Background(), testConfig, "vpn.example.com:51820")
			_ = manager.Down(context.Background())
		}
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the state machine blocked on a subscriber that was not reading")
	}
}
