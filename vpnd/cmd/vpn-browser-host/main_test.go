package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

// framed builds a native-messaging message the way Chrome does.
func framed(payload string) []byte {
	var buffer bytes.Buffer
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(payload)))
	buffer.Write(header[:])
	buffer.WriteString(payload)
	return buffer.Bytes()
}

func decodeReplies(t *testing.T, raw []byte) []reply {
	t.Helper()

	var replies []reply
	reader := bytes.NewReader(raw)
	for {
		payload, err := readMessage(reader)
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			return replies
		}
		if err != nil {
			t.Fatalf("reading a reply: %v", err)
		}
		var r reply
		if err := json.Unmarshal(payload, &r); err != nil {
			t.Fatalf("decoding a reply: %v", err)
		}
		replies = append(replies, r)
	}
}

// The extension is the least trusted client in the system, so what it is
// allowed to ask for is asserted rather than assumed.
func TestOnlyThreeActionsAreExposed(t *testing.T) {
	allowed := map[string]string{
		"status":     "status",
		"connect":    "reconnect",
		"disconnect": "down",
	}

	for action, want := range allowed {
		got, ok := methodFor(action)
		if !ok || got != want {
			t.Fatalf("methodFor(%q) = %q, %v; want %q", action, got, ok, want)
		}
	}
}

func TestUpIsNotReachableFromTheBrowser(t *testing.T) {
	// `up` carries a config with a private key. An extension must never be
	// able to submit one, and must never be able to make the daemon install a
	// tunnel of its choosing.
	for _, action := range []string{"up", "Up", "UP", "subscribe", "version", ""} {
		if _, ok := methodFor(action); ok {
			t.Fatalf("action %q is reachable from the browser", action)
		}
	}
}

func TestMalformedJsonGetsAnErrorNotACrash(t *testing.T) {
	var out bytes.Buffer

	err := serve(bytes.NewReader(framed("{not json")), &out, "/nonexistent.sock")
	if err != nil && err != io.EOF {
		t.Fatalf("serve returned %v", err)
	}

	replies := decodeReplies(t, out.Bytes())
	if len(replies) != 1 || replies[0].OK {
		t.Fatalf("expected one failed reply, got %+v", replies)
	}
	if replies[0].Error != "malformed request" {
		t.Fatalf("error = %q", replies[0].Error)
	}
}

func TestAMissingDaemonIsReportedNotFatal(t *testing.T) {
	var out bytes.Buffer

	err := serve(bytes.NewReader(framed(`{"action":"status"}`)), &out, "/nonexistent.sock")
	if err != nil && err != io.EOF {
		t.Fatalf("serve returned %v", err)
	}

	replies := decodeReplies(t, out.Bytes())
	if len(replies) != 1 {
		t.Fatalf("expected one reply, got %d", len(replies))
	}
	if replies[0].OK {
		t.Fatal("reported success with no daemon")
	}
	// The popup shows this verbatim, so it has to be a sentence.
	if !strings.Contains(replies[0].Error, "not running") {
		t.Fatalf("error = %q", replies[0].Error)
	}
}

func TestUnsupportedActionIsRejectedWithoutDialling(t *testing.T) {
	var out bytes.Buffer

	// A socket path that would fail if it were dialled at all.
	_ = serve(bytes.NewReader(framed(`{"action":"up"}`)), &out, "/nonexistent.sock")

	replies := decodeReplies(t, out.Bytes())
	if len(replies) != 1 || replies[0].OK {
		t.Fatalf("expected a rejection, got %+v", replies)
	}
	if !strings.Contains(replies[0].Error, "unsupported action") {
		t.Fatalf("error = %q — it should be rejected before the daemon is contacted", replies[0].Error)
	}
}

func TestOversizedMessagesAreRefused(t *testing.T) {
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], maxIncoming+1)

	if _, err := readMessage(bytes.NewReader(header[:])); err == nil {
		t.Fatal("an oversized length prefix was accepted")
	}

	binary.LittleEndian.PutUint32(header[:], 0)
	if _, err := readMessage(bytes.NewReader(header[:])); err == nil {
		t.Fatal("a zero-length message was accepted")
	}
}

func TestFramingRoundTrips(t *testing.T) {
	var buffer bytes.Buffer
	if err := writeMessage(&buffer, reply{OK: true, Stage: "connected"}); err != nil {
		t.Fatal(err)
	}

	payload, err := readMessage(bytes.NewReader(buffer.Bytes()))
	if err != nil {
		t.Fatal(err)
	}

	var decoded reply
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if !decoded.OK || decoded.Stage != "connected" {
		t.Fatalf("round trip lost data: %+v", decoded)
	}
}
