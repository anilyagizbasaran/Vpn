// Package protocol defines the wire format between the unprivileged GUI and
// the privileged daemon.
//
// Newline-delimited JSON, not gRPC: the payload is four verbs, the transport
// is a local pipe, and a hand-readable protocol can be debugged with a text
// editor at three in the morning. It also keeps the daemon dependency-free.
package protocol

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// Method names the daemon answers.
const (
	MethodVersion   = "version"
	MethodStatus    = "status"
	MethodUp        = "up"
	MethodDown      = "down"
	MethodSubscribe = "subscribe"

	// MethodReconnect brings the tunnel back up without being handed a
	// config. It exists for clients that cannot produce one — the browser
	// extension. The daemon reuses the config it last accepted, or fetches a
	// fresh one if this machine has enrolled.
	MethodReconnect = "reconnect"

	// MethodEnroll registers this machine with a control plane using an
	// invite code, then connects.
	//
	// The caller supplies an address and a code and gets back a stage. It
	// never sees key material: the daemon generates the pair, sends only the
	// public half, and keeps the private one. That is the whole reason this
	// method exists rather than the extension calling the API itself.
	MethodEnroll = "enroll"
)

// Stage mirrors the client's TunnelStage vocabulary so the GUI can map one to
// one without inventing a third set of names.
type Stage string

const (
	StageDisconnected  Stage = "disconnected"
	StagePreparing     Stage = "preparing"
	StageConnecting    Stage = "connecting"
	StageConnected     Stage = "connected"
	StageDisconnecting Stage = "disconnecting"
	StageFailed        Stage = "failed"
)

// Request is one call from the GUI.
type Request struct {
	ID     uint64          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// UpParams carries the full wg-quick config, private key included. It crosses
// only a local, ACL-protected pipe and is never logged — see redact.go.
type UpParams struct {
	Config        string `json:"config"`
	ServerAddress string `json:"serverAddress"`
}

// EnrollParams carries what the user typed: where their VPN server is, and the
// code that lets this device on. Neither is a secret the daemon keeps for the
// caller's benefit — the code is spent immediately and the token it returns
// stays here.
type EnrollParams struct {
	ServerAddress string `json:"serverAddress"`
	InviteToken   string `json:"inviteToken"`
}

// Response is the reply to a [Request]. Exactly one of Result or Error is set.
type Response struct {
	ID     uint64          `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *Error          `json:"error,omitempty"`
}

// Event is an unsolicited message pushed to subscribers. It has no ID, which
// is how the client tells events apart from responses on the same stream.
type Event struct {
	Event   string `json:"event"`
	Stage   Stage  `json:"stage,omitempty"`
	Message string `json:"message,omitempty"`
}

// Error is a failure the GUI can show verbatim.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

// Error codes. The GUI branches on these, never on message text.
const (
	CodeBadRequest    = "bad_request"
	CodeUnsupported   = "unsupported"
	CodeTunnelFailure = "tunnel_failure"
	CodeInternal      = "internal"
)

// StatusResult answers [MethodStatus].
type StatusResult struct {
	Stage Stage `json:"stage"`
	// Empty unless Stage is StageFailed.
	Message string `json:"message,omitempty"`
	// Interface name the daemon manages, for diagnostics.
	Interface string `json:"interface"`
	// Whether this machine has a device identity it could connect with.
	//
	// The browser extension asks so it can show a setup form the moment it
	// opens, rather than making the user press Connect to discover there is
	// nothing to connect to.
	Enrolled bool `json:"enrolled"`
}

// VersionResult answers [MethodVersion]. The GUI checks this on connect so a
// stale daemon left behind by a partial upgrade is reported, not misused.
type VersionResult struct {
	Version  string `json:"version"`
	Platform string `json:"platform"`
	// Protocol revision. Bumped only on a breaking wire change.
	Protocol int `json:"protocol"`
}

// ProtocolVersion is the revision this build speaks.
const ProtocolVersion = 1

// MaxMessageBytes bounds a single line. A wg-quick config is well under 4 KB;
// anything larger is a bug or an attempt to exhaust the daemon's memory.
const MaxMessageBytes = 64 * 1024

// Decoder reads newline-delimited JSON messages with a hard size limit.
type Decoder struct{ scanner *bufio.Scanner }

func NewDecoder(r io.Reader) *Decoder {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 4096), MaxMessageBytes)
	return &Decoder{scanner: scanner}
}

// Decode reads the next message into v. Returns io.EOF at end of stream.
func (d *Decoder) Decode(v any) error {
	for d.scanner.Scan() {
		line := strings.TrimSpace(d.scanner.Text())
		if line == "" {
			continue // Tolerate keepalive newlines.
		}
		return json.Unmarshal([]byte(line), v)
	}
	if err := d.scanner.Err(); err != nil {
		return err
	}
	return io.EOF
}

// Encoder writes newline-delimited JSON. Safe for concurrent use is *not*
// claimed here; the IPC server serialises writes itself.
type Encoder struct{ w io.Writer }

func NewEncoder(w io.Writer) *Encoder { return &Encoder{w: w} }

func (e *Encoder) Encode(v any) error {
	payload, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(payload) > MaxMessageBytes {
		return fmt.Errorf("message of %d bytes exceeds the %d byte limit", len(payload), MaxMessageBytes)
	}
	_, err = e.w.Write(append(payload, '\n'))
	return err
}
