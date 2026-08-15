package ipc

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"testing"

	"vpnd/internal/enroll"
	"vpnd/internal/protocol"
	"vpnd/internal/tunnel"
)

// A control plane that answers without a network. The real client is covered
// in its own package; what matters here is what the daemon does with a config
// once it has one.
type stubEnroller struct {
	// The daemon calls these from its own goroutine while the test reads the
	// counters from its own. net.Pipe happens to order them, but a mutex is
	// cheaper than finding out in CI that it stopped doing so.
	mu sync.Mutex

	config      string
	endpoint    string
	deviceToken string
	enrolErr    error
	fetchErr    error

	enrolCalls int
	fetchCalls int
	sentInvite string
	sentToken  string
	sentKeys   enroll.Keys
}

// What the desktop app hands in: a finished config, key already substituted.
const goodConfWithKey = "[Interface]\n" +
	"PrivateKey = cHJpdmF0ZWtleXByaXZhdGVrZXlwcml2YXRla2V5cHI=\n" +
	"Address = 10.8.0.2/32\n[Peer]\n" +
	"PublicKey = c2VydmVycHVibGlja2V5c2VydmVycHVibGlja2V5c2VydmU=\n" +
	"AllowedIPs = 0.0.0.0/0\nEndpoint = vpn.test:51820\n"

const goodConf = "[Interface]\nPrivateKey = <PRIVATE_KEY>\nAddress = 10.8.0.2/32\n" +
	"[Peer]\nPublicKey = c2VydmVycHVibGlja2V5c2VydmVycHVibGlja2V5c2VydmU=\n" +
	"AllowedIPs = 0.0.0.0/0\nEndpoint = vpn.test:51820\n"

func (s *stubEnroller) Enrol(_ context.Context, inviteToken string) (enroll.Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.enrolCalls++
	s.sentInvite = inviteToken
	if s.enrolErr != nil {
		return enroll.Result{}, s.enrolErr
	}

	keys, err := enroll.GenerateKeys()
	if err != nil {
		return enroll.Result{}, err
	}
	s.sentKeys = keys

	conf := s.config
	if conf == "" {
		conf = goodConf
	}
	endpoint := s.endpoint
	if endpoint == "" {
		endpoint = "vpn.test:51820"
	}
	token := s.deviceToken
	if token == "" {
		token = "vpndev_stub"
	}

	return enroll.Result{
		Config:      strings.ReplaceAll(conf, enroll.PrivateKeyPlaceholder, keys.Private),
		Endpoint:    endpoint,
		DeviceToken: token,
		Keys:        keys,
	}, nil
}

// Accessors so a test never reads a field the daemon may still be writing.
func (s *stubEnroller) calls() (enrolled, fetched int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.enrolCalls, s.fetchCalls
}

func (s *stubEnroller) sent() (token string, keys enroll.Keys) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sentToken, s.sentKeys
}

func (s *stubEnroller) FetchConfig(
	_ context.Context,
	deviceToken string,
	keys enroll.Keys,
) (enroll.Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.fetchCalls++
	s.sentToken = deviceToken
	s.sentKeys = keys
	if s.fetchErr != nil {
		return enroll.Result{}, s.fetchErr
	}

	conf := s.config
	if conf == "" {
		conf = goodConf
	}
	return enroll.Result{
		Config:   strings.ReplaceAll(conf, enroll.PrivateKeyPlaceholder, keys.Private),
		Endpoint: "vpn.test:51820",
		Keys:     keys,
	}, nil
}

// enrolHarness wires a server against a stub so a test can watch both sides.
type enrolHarness struct {
	*harness
	stub  *stubEnroller
	store *enroll.Store
}

func newEnrolHarness(t *testing.T, stub *stubEnroller) *enrolHarness {
	t.Helper()

	serverConn, clientConn := net.Pipe()
	driver := &tunnel.MockDriver{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	manager := tunnel.NewManager(driver, "vpn0", log)
	store := enroll.NewStore(t.TempDir())

	ctx, cancel := context.WithCancel(context.Background())
	server := NewServer(manager, store, log)
	server.newClient = func(string) enroller { return stub }
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
	return &enrolHarness{harness: h, stub: stub, store: store}
}

func enrolParams(address, invite string) protocol.EnrollParams {
	return protocol.EnrollParams{ServerAddress: address, InviteToken: invite}
}

var nextRequestID uint64

// call sends one request and waits for its reply, skipping stage events.
func (h *enrolHarness) call(method string, params any) protocol.Response {
	h.t.Helper()
	nextRequestID++
	h.send(nextRequestID, method, params)
	return h.response(nextRequestID)
}

func TestEnrolConnectsAndRemembersTheDevice(t *testing.T) {
	h := newEnrolHarness(t, &stubEnroller{})

	response := h.call(protocol.MethodEnroll, enrolParams("https://vpn.example.com", "vpninv_code"))
	if !response.OK {
		t.Fatalf("enrolment failed: %+v", response.Error)
	}

	var status protocol.StatusResult
	if err := json.Unmarshal(response.Result, &status); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if status.Stage != protocol.StageConnected {
		t.Fatalf("stage = %q, want connected", status.Stage)
	}

	stored, err := h.store.Load()
	if err != nil || stored == nil {
		t.Fatalf("identity not stored: %v", err)
	}
	if stored.DeviceToken != "vpndev_stub" {
		t.Fatalf("device token = %q", stored.DeviceToken)
	}
	if _, keys := h.stub.sent(); stored.PrivateKey != keys.Private {
		t.Fatal("the stored private key is not the one the tunnel was built with")
	}
	if stored.ControlPlane != "https://vpn.example.com" {
		t.Fatalf("control plane = %q", stored.ControlPlane)
	}
	if !status.Enrolled {
		t.Fatal("status did not report the machine as enrolled")
	}
}

func TestStatusReportsWhetherTheMachineHasEverEnrolled(t *testing.T) {
	h := newEnrolHarness(t, &stubEnroller{})

	// This is what puts the setup form on screen. Getting it wrong the other
	// way would show a Connect button with nothing behind it.
	var before protocol.StatusResult
	_ = json.Unmarshal(h.call(protocol.MethodStatus, nil).Result, &before)
	if before.Enrolled {
		t.Fatal("a machine that never enrolled reported as enrolled")
	}

	if !h.call(protocol.MethodEnroll, enrolParams("https://vpn.example.com", "vpninv_code")).OK {
		t.Fatal("enrolment failed")
	}

	var after protocol.StatusResult
	_ = json.Unmarshal(h.call(protocol.MethodStatus, nil).Result, &after)
	if !after.Enrolled {
		t.Fatal("an enrolled machine reported as not enrolled")
	}
}

func TestEnrolNeverReturnsKeyMaterial(t *testing.T) {
	h := newEnrolHarness(t, &stubEnroller{})

	response := h.call(protocol.MethodEnroll, enrolParams("https://vpn.example.com", "vpninv_code"))
	if !response.OK {
		t.Fatalf("enrolment failed: %+v", response.Error)
	}

	// The whole reason enrolment lives in the daemon: the caller is a browser
	// extension, and the answer it gets back must be a stage and nothing more.
	_, keys := h.stub.sent()
	body := string(response.Result)
	if strings.Contains(body, keys.Private) {
		t.Fatal("the response carried the private key")
	}
	if strings.Contains(body, "PrivateKey") || strings.Contains(body, "vpndev_") {
		t.Fatalf("the response carried a credential: %s", body)
	}
}

func TestEnrolRejectsPlainHTTP(t *testing.T) {
	h := newEnrolHarness(t, &stubEnroller{})

	response := h.call(protocol.MethodEnroll, enrolParams("http://vpn.example.com", "vpninv_code"))

	if response.OK {
		t.Fatal("a plain-HTTP control plane was accepted")
	}
	// Nothing may be sent before the address is checked: the invite code would
	// otherwise already be on the wire in the clear.
	if enrolled, _ := h.stub.calls(); enrolled != 0 {
		t.Fatal("the invite code was sent to an http:// address")
	}
	if !strings.Contains(response.Error.Message, "https://") {
		t.Fatalf("unhelpful message: %q", response.Error.Message)
	}
}

func TestEnrolDoesNotStoreAnIdentityWhenTheServerRefuses(t *testing.T) {
	stub := &stubEnroller{enrolErr: errors.New("That invite code has been revoked.")}
	h := newEnrolHarness(t, stub)

	response := h.call(protocol.MethodEnroll, enrolParams("https://vpn.example.com", "vpninv_dead"))

	if response.OK {
		t.Fatal("a revoked code was accepted")
	}
	if response.Error.Message != "That invite code has been revoked." {
		t.Fatalf("the server's message was lost: %q", response.Error.Message)
	}
	stored, _ := h.store.Load()
	if stored != nil {
		t.Fatal("a refused enrolment left an identity behind")
	}
}

func TestEnrolRefusesAConfigWithAHook(t *testing.T) {
	// The control plane is named by the user, not trusted: a PostUp line would
	// run as root on every connect.
	stub := &stubEnroller{
		config: goodConf + "PostUp = /bin/sh -c 'touch /tmp/owned'\n",
	}
	h := newEnrolHarness(t, stub)

	response := h.call(protocol.MethodEnroll, enrolParams("https://vpn.example.com", "vpninv_code"))

	if response.OK {
		t.Fatal("a config with a PostUp hook was installed")
	}
	if h.driver.Calls() != 0 {
		t.Fatal("the hostile config reached the driver")
	}
	stored, _ := h.store.Load()
	if stored != nil {
		t.Fatal("a rejected config still stored an identity")
	}
}

func TestStatusReportsConnectableAfterTheAppHandedInAConfig(t *testing.T) {
	// The desktop app enrols itself and calls `up`, so nothing is stored on
	// disk. The extension must not offer a setup form to someone whose tunnel
	// is already working — they would spend a second invite for nothing.
	h := newEnrolHarness(t, &stubEnroller{})

	up := protocol.UpParams{Config: goodConfWithKey, ServerAddress: "vpn.test:51820"}
	if response := h.call(protocol.MethodUp, up); !response.OK {
		t.Fatalf("up failed: %+v", response.Error)
	}

	var status protocol.StatusResult
	_ = json.Unmarshal(h.call(protocol.MethodStatus, nil).Result, &status)
	if !status.Enrolled {
		t.Fatal("a machine with a working tunnel was reported as needing setup")
	}

	stored, _ := h.store.Load()
	if stored != nil {
		t.Fatal("`up` wrote an identity; it has no token to write one from")
	}
}

func TestReconnectSurvivesARestartByFetchingAFreshConfig(t *testing.T) {
	// What the extension actually hits: the daemon has restarted, so it holds
	// no config, but the machine enrolled at some point in the past.
	stub := &stubEnroller{}
	h := newEnrolHarness(t, stub)

	keys, err := enroll.GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	if err := h.store.Save(enroll.Identity{
		ControlPlane: "https://vpn.example.com",
		DeviceToken:  "vpndev_stored",
		PrivateKey:   keys.Private,
		PublicKey:    keys.Public,
	}); err != nil {
		t.Fatal(err)
	}

	response := h.call(protocol.MethodReconnect, nil)

	if !response.OK {
		t.Fatalf("reconnect failed: %+v", response.Error)
	}
	_, fetched := stub.calls()
	if fetched != 1 {
		t.Fatalf("fetch calls = %d, want 1", fetched)
	}
	sentToken, sentKeys := stub.sent()
	if sentToken != "vpndev_stored" {
		t.Fatalf("sent token = %q", sentToken)
	}
	// The config is rebuilt around the key this machine already had, not a new
	// one: a fresh key would need registering and the old peer would linger.
	if sentKeys.Private != keys.Private {
		t.Fatal("reconnect used a different key than the one stored")
	}
	if !strings.Contains(h.driver.Config(), "PrivateKey = "+keys.Private) {
		t.Fatal("the tunnel was not built with the stored key")
	}
}

func TestReconnectStillAsksForACodeWhenNothingIsStored(t *testing.T) {
	h := newEnrolHarness(t, &stubEnroller{})

	response := h.call(protocol.MethodReconnect, nil)

	if response.OK {
		t.Fatal("reconnect succeeded with no identity and no config")
	}
	if !strings.Contains(response.Error.Message, "invite code") {
		t.Fatalf("the message does not say what to do: %q", response.Error.Message)
	}
}

func TestReconnectPrefersTheConfigItAlreadyHas(t *testing.T) {
	stub := &stubEnroller{}
	h := newEnrolHarness(t, stub)

	if !h.call(protocol.MethodEnroll, enrolParams("https://vpn.example.com", "vpninv_code")).OK {
		t.Fatal("enrolment failed")
	}
	h.call(protocol.MethodDown, nil)

	if !h.call(protocol.MethodReconnect, nil).OK {
		t.Fatal("reconnect failed")
	}

	// Still in memory, so there is nothing to ask the server for. Round-
	// tripping to the control plane on every toggle would make the kill switch
	// depend on the network being up.
	if _, fetched := stub.calls(); fetched != 0 {
		t.Fatalf("fetch calls = %d, want 0", fetched)
	}
}
