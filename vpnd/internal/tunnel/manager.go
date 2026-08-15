package tunnel

import (
	"context"
	"log/slog"
	"sync"

	"vpnd/internal/protocol"
)

// Manager serialises every tunnel operation and is the single source of truth
// for the current stage.
//
// Serialisation is not an optimisation. Two `up` calls racing on the same
// interface leave it in a state neither caller expects, and the GUI can send a
// second one whenever a user double-taps or a reconnect fires mid-connect.
type Manager struct {
	driver Driver
	iface  string
	log    *slog.Logger

	// Whether to keep the last config in memory so a client with no account —
	// the browser extension — can reconnect.
	//
	// The trade is explicit: while the tunnel is up the private key is already
	// in a file on disk, and this keeps a copy in the daemon's memory after it
	// comes down, for as long as the daemon runs. It never reaches disk in
	// that state and never survives a restart. Operators who would rather not
	// make that trade can turn it off.
	rememberConfig bool

	// Blocks traffic that is not going through the tunnel. Never nil — a
	// platform that does not need one here gets [NoKillSwitch], so no call
	// site has to remember to check.
	killSwitch KillSwitch

	// Guards every field below and is held for the whole of an Up/Down, so
	// operations queue rather than interleave.
	mu         sync.Mutex
	stage      protocol.Stage
	failure    string
	lastConfig string
	lastServer string

	// Host:port of the control plane, kept reachable while the kill switch is
	// on so a dropped tunnel can be rebuilt. Empty until something enrols.
	controlPlane string

	subsMu sync.Mutex
	subs   map[int]chan protocol.Event
	nextID int
}

func NewManager(driver Driver, iface string, log *slog.Logger) *Manager {
	return &Manager{
		driver:         driver,
		iface:          iface,
		log:            log,
		stage:          protocol.StageDisconnected,
		subs:           make(map[int]chan protocol.Event),
		rememberConfig: true,
		killSwitch:     NoKillSwitch{Reason: "not enabled"},
	}
}

// SetKillSwitch installs the leak protection. Call before serving.
func (m *Manager) SetKillSwitch(k KillSwitch) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.killSwitch = k
}

// SetControlPlane records the server to keep reachable while the kill switch
// is on.
//
// Without it a tunnel that drops can never be rebuilt: fetching a fresh config
// needs the control plane, and the kill switch is blocking exactly that. The
// exception is one address on one port, and it is the same machine the tunnel
// endpoint is on in most installs.
func (m *Manager) SetControlPlane(hostPort string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.controlPlane = hostPort
}

// KillSwitchName reports the active implementation, for the startup log.
func (m *Manager) KillSwitchName() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.killSwitch.Name()
}

// ReleaseKillSwitch clears any block, including one a previous run left behind.
//
// Called at startup. A daemon that crashed with the rules installed leaves a
// machine with no network and no obvious cause, so the first thing a fresh
// process does is take that possibility away.
func (m *Manager) ReleaseKillSwitch(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.killSwitch.Release(ctx)
}

// SetRememberConfig controls whether the last config is kept for [Reconnect].
func (m *Manager) SetRememberConfig(remember bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rememberConfig = remember
	if !remember {
		m.lastConfig = ""
		m.lastServer = ""
	}
}

// ForgetConfig drops the config held for [Reconnect].
//
// Called when this machine's identity is erased. Leaving it behind would let
// the tunnel come back up on credentials the server has already deleted, and
// report the machine as still set up.
func (m *Manager) ForgetConfig() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lastConfig = ""
	m.lastServer = ""
}

// CanReconnect reports whether a config is held for [Reconnect].
func (m *Manager) CanReconnect() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lastConfig != ""
}

// Reconnect brings the tunnel back up with the last config this daemon
// accepted, for clients that cannot produce one themselves.
func (m *Manager) Reconnect(ctx context.Context) error {
	m.mu.Lock()
	config, server := m.lastConfig, m.lastServer
	m.mu.Unlock()

	if config == "" {
		// The caller decides what to do next: with a stored identity the
		// daemon fetches a config itself, and without one there is genuinely
		// nothing to reconnect to. Telling the user to open the app would be
		// wrong now that the extension can set this machine up on its own.
		return &protocol.Error{
			Code:    protocol.CodeUnsupported,
			Message: "This computer is not set up yet. Enter your server address and invite code.",
		}
	}
	return m.Up(ctx, config, server)
}

// Status reports the current stage. Cheap and lock-light so the GUI can poll
// it on a timer without contending with a connect in progress.
func (m *Manager) Status() protocol.StatusResult {
	m.mu.Lock()
	defer m.mu.Unlock()
	return protocol.StatusResult{
		Stage:     m.stage,
		Message:   m.failure,
		Interface: m.iface,
	}
}

// Subscribe returns a channel of stage changes and a function to release it.
//
// The channel is buffered and a slow reader is dropped rather than blocking
// the state machine: a GUI that stops reading must never be able to wedge the
// daemon mid-connect.
func (m *Manager) Subscribe() (<-chan protocol.Event, func()) {
	m.subsMu.Lock()
	defer m.subsMu.Unlock()

	id := m.nextID
	m.nextID++
	ch := make(chan protocol.Event, 16)
	m.subs[id] = ch

	return ch, func() {
		m.subsMu.Lock()
		defer m.subsMu.Unlock()
		if existing, ok := m.subs[id]; ok {
			delete(m.subs, id)
			close(existing)
		}
	}
}

func (m *Manager) setStage(stage protocol.Stage, failure string) {
	m.stage = stage
	m.failure = failure
	m.broadcast(protocol.Event{Event: "stage", Stage: stage, Message: failure})
}

func (m *Manager) broadcast(event protocol.Event) {
	m.subsMu.Lock()
	defer m.subsMu.Unlock()

	for id, ch := range m.subs {
		select {
		case ch <- event:
		default:
			m.log.Warn("dropping event for a subscriber that is not reading",
				"subscriber", id, "stage", event.Stage)
		}
	}
}

// Up brings the tunnel to [protocol.StageConnected].
//
// The config contains a private key, so it is never logged in full — only the
// redacted form, and only when something failed.
func (m *Manager) Up(ctx context.Context, config, serverAddress string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.setStage(protocol.StageConnecting, "")

	if err := m.driver.Up(ctx, m.iface, config); err != nil {
		message := "The tunnel could not be started."
		var failure *FailureError
		if ok := asFailure(err, &failure); ok {
			message = failure.UserMessage()
		}

		m.log.Error("tunnel up failed",
			"interface", m.iface,
			"server", serverAddress,
			"error", err,
			"config", protocol.RedactConfig(config))

		m.setStage(protocol.StageFailed, message)
		return &protocol.Error{Code: protocol.CodeTunnelFailure, Message: message}
	}

	// After the interface is up, because the rules name it and because the
	// lookups below have to happen while there is still a route to do them on.
	if err := m.engageKillSwitch(ctx, serverAddress); err != nil {
		// Down again. Connecting without the protection the user turned on is
		// the wrong direction to fail in: they would be browsing, unprotected,
		// looking at a screen that says connected.
		if downErr := m.driver.Down(ctx, m.iface); downErr != nil {
			m.log.Error("could not stop the tunnel after the kill switch failed",
				"error", downErr)
		}
		// Best effort, in case a partial ruleset landed.
		_ = m.killSwitch.Release(ctx)

		var failure *FailureError
		message := "Traffic outside the tunnel could not be blocked, so the tunnel was not started."
		if asFailure(err, &failure) {
			message = failure.UserMessage()
		}
		m.log.Error("kill switch failed", "interface", m.iface, "error", err)
		m.setStage(protocol.StageFailed, message)
		return &protocol.Error{Code: protocol.CodeTunnelFailure, Message: message}
	}

	if m.rememberConfig {
		m.lastConfig, m.lastServer = config, serverAddress
	}

	m.log.Info("tunnel up", "interface", m.iface, "server", serverAddress)
	m.setStage(protocol.StageConnected, "")
	return nil
}

// engageKillSwitch installs the block, with the tunnel's own server and the
// control plane carved out.
//
// Called with m.mu held.
func (m *Manager) engageKillSwitch(ctx context.Context, serverAddress string) error {
	if _, isNone := m.killSwitch.(NoKillSwitch); isNone {
		return nil
	}

	allow, err := ResolveAllow(ctx, serverAddress, "udp")
	if err != nil {
		return err
	}

	if m.controlPlane != "" {
		control, err := ResolveAllow(ctx, m.controlPlane, "tcp")
		if err != nil {
			// Not fatal. The tunnel and its endpoint are what protection
			// depends on; the control plane carve-out only makes recovery
			// smoother, and refusing to connect over it would be a worse
			// trade than reconnecting by hand.
			m.log.Warn("could not resolve the control plane for the kill switch",
				"server", m.controlPlane, "error", err)
		} else {
			allow = append(allow, control...)
		}
	}

	return m.killSwitch.Engage(ctx, m.iface, allow)
}

// Down stops the tunnel. Succeeds when nothing was running.
func (m *Manager) Down(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Report disconnected even if the driver fails below: leaving the GUI
	// showing "connected" after a failed teardown is the dangerous direction,
	// because the user would believe they are protected.
	m.setStage(protocol.StageDisconnecting, "")

	// Before the interface goes, so there is no window where the tunnel is
	// gone and the block is still up. A user who pressed Disconnect wants
	// their ordinary connection back, not a machine with no network.
	if err := m.killSwitch.Release(ctx); err != nil {
		m.log.Error("could not remove the traffic block", "error", err)
	}

	if err := m.driver.Down(ctx, m.iface); err != nil {
		m.log.Error("tunnel down failed", "interface", m.iface, "error", err)
		m.setStage(protocol.StageFailed, "The tunnel could not be stopped cleanly.")
		return &protocol.Error{
			Code:    protocol.CodeTunnelFailure,
			Message: "The tunnel could not be stopped cleanly. Retry, or disconnect from the system VPN settings.",
		}
	}

	m.log.Info("tunnel down", "interface", m.iface)
	m.setStage(protocol.StageDisconnected, "")
	return nil
}

// Shutdown tears the tunnel down and releases every subscriber. Called when
// the service stops so a crash or an upgrade cannot leave a live tunnel behind
// with nothing managing it.
func (m *Manager) Shutdown(ctx context.Context) {
	if err := m.Down(ctx); err != nil {
		m.log.Error("shutdown could not stop the tunnel", "error", err)
	}

	m.subsMu.Lock()
	defer m.subsMu.Unlock()
	for id, ch := range m.subs {
		delete(m.subs, id)
		close(ch)
	}
}

// asFailure is errors.As without importing errors into every call site.
func asFailure(err error, target **FailureError) bool {
	for err != nil {
		if failure, ok := err.(*FailureError); ok {
			*target = failure
			return true
		}
		unwrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapper.Unwrap()
	}
	return false
}
