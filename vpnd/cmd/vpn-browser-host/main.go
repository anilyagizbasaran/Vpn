// Command vpn-browser-host bridges a browser extension to vpnd.
//
// A browser extension cannot open a WireGuard tunnel: chrome.vpnProvider is
// ChromeOS-only, and nothing in an extension can touch a network interface.
// The honest arrangement is a companion — the extension shows status and
// flips the tunnel, and this process is the only thing that talks to the
// daemon.
//
// Chrome launches it over native messaging: 4-byte little-endian length
// prefix, then UTF-8 JSON, on stdin and stdout. Only the extension IDs listed
// in the host manifest's allowed_origins can start it.
//
// It deliberately exposes less than the daemon does. There is no `up`: a
// config carries a private key, and an extension has no business holding one.
package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"time"

	"vpnd/internal/ipc"
	"vpnd/internal/protocol"
)

// Chrome refuses anything larger from an extension, so neither do we.
const maxIncoming = 1024 * 1024

type request struct {
	Action string `json:"action"`
	// Only `enroll` uses these. They are what the user typed into the popup:
	// where their server is, and the code that lets this machine on.
	ServerAddress string `json:"serverAddress,omitempty"`
	InviteToken   string `json:"inviteToken,omitempty"`
}

type reply struct {
	OK    bool   `json:"ok"`
	Stage string `json:"stage,omitempty"`
	Error string `json:"error,omitempty"`
	// Whether this machine has a device identity. The extension shows its
	// setup form on this rather than on a failed connect, so a first run does
	// not start with an error message.
	Enrolled bool `json:"enrolled"`
}

func main() {
	socketPath := flag.String("socket", ipc.DefaultSocketPath(), "path of the vpnd control socket")
	flag.Parse()

	if err := serve(os.Stdin, os.Stdout, *socketPath); err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintln(os.Stderr, "vpn-browser-host:", err)
		os.Exit(1)
	}
}

func serve(in io.Reader, out io.Writer, socketPath string) error {
	for {
		message, err := readMessage(in)
		if err != nil {
			// EOF is the browser closing the port, which is normal.
			return err
		}

		var req request
		if err := json.Unmarshal(message, &req); err != nil {
			if err := writeMessage(out, reply{Error: "malformed request"}); err != nil {
				return err
			}
			continue
		}

		if err := writeMessage(out, handle(req, socketPath)); err != nil {
			return err
		}
	}
}

// handle opens a short-lived connection per request.
//
// The alternative — one long-lived connection — would keep a socket open for
// as long as the browser runs, for a client that asks a question every few
// seconds. Connecting is cheap on a local socket.
func handle(req request, socketPath string) reply {
	method, ok := methodFor(req.Action)
	if !ok {
		return reply{Error: "unsupported action: " + req.Action}
	}

	conn, err := net.DialTimeout("unix", socketPath, 3*time.Second)
	if err != nil {
		return reply{Error: "The VPN service is not running."}
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))

	encoder := protocol.NewEncoder(conn)
	decoder := protocol.NewDecoder(conn)

	outgoing := protocol.Request{ID: 1, Method: method}
	if method == protocol.MethodEnroll {
		params, err := json.Marshal(protocol.EnrollParams{
			ServerAddress: req.ServerAddress,
			InviteToken:   req.InviteToken,
		})
		if err != nil {
			return reply{Error: "The enrolment request could not be encoded."}
		}
		outgoing.Params = params
	}

	if err := encoder.Encode(outgoing); err != nil {
		return reply{Error: "The VPN service could not be reached."}
	}

	var response protocol.Response
	if err := decoder.Decode(&response); err != nil {
		return reply{Error: "The VPN service did not answer."}
	}
	if !response.OK {
		message := "The VPN service rejected the request."
		if response.Error != nil {
			message = response.Error.Message
		}
		return reply{Error: message}
	}

	var status protocol.StatusResult
	_ = json.Unmarshal(response.Result, &status)
	return reply{OK: true, Stage: string(status.Stage), Enrolled: status.Enrolled}
}

// methodFor is an allowlist, not a pass-through. `up` is absent on purpose:
// it takes a config containing a private key, and this process exists so the
// extension never handles one.
//
// `enroll` is here even though it sets the machine up, because it moves in the
// safe direction: an address and a code go in, a stage comes back. The daemon
// generates the keypair and keeps it. Nothing key-shaped crosses this pipe in
// either direction.
func methodFor(action string) (string, bool) {
	switch action {
	case "status":
		return protocol.MethodStatus, true
	case "connect":
		return protocol.MethodReconnect, true
	case "disconnect":
		return protocol.MethodDown, true
	case "enroll":
		return protocol.MethodEnroll, true
	default:
		return "", false
	}
}

func readMessage(r io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}

	length := binary.LittleEndian.Uint32(header[:])
	if length == 0 || length > maxIncoming {
		return nil, fmt.Errorf("message length %d is out of range", length)
	}

	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func writeMessage(w io.Writer, v any) error {
	payload, err := json.Marshal(v)
	if err != nil {
		return err
	}

	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(payload)))
	if _, err := w.Write(header[:]); err != nil {
		return err
	}
	_, err = w.Write(payload)
	return err
}
