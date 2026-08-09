package protocol

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

func TestRedactConfigRemovesKeyMaterial(t *testing.T) {
	config := `[Interface]
PrivateKey = SUPERSECRETPRIVATEKEY=
Address = 10.8.0.5/32

[Peer]
PublicKey = PUBLICKEYISNOTASECRET=
PresharedKey = SUPERSECRETPRESHAREDKEY=
Endpoint = vpn.example.com:51820
`

	redacted := RedactConfig(config)

	for _, secret := range []string{"SUPERSECRETPRIVATEKEY", "SUPERSECRETPRESHAREDKEY"} {
		if strings.Contains(redacted, secret) {
			t.Fatalf("%s survived redaction:\n%s", secret, redacted)
		}
	}

	// Everything that helps diagnose a failure has to survive, or the log is
	// useless and somebody will disable redaction to debug.
	for _, kept := range []string{"[Interface]", "Address = 10.8.0.5/32", "PUBLICKEYISNOTASECRET", "vpn.example.com:51820"} {
		if !strings.Contains(redacted, kept) {
			t.Fatalf("%q was removed but is not a secret:\n%s", kept, redacted)
		}
	}
}

func TestRedactConfigHandlesFormattingVariations(t *testing.T) {
	cases := []string{
		"privatekey=secret",
		"  PrivateKey   =   secret",
		"PRIVATEKEY = secret",
		"PresharedKey=secret",
	}

	for _, line := range cases {
		if strings.Contains(RedactConfig(line), "secret") {
			t.Fatalf("redaction missed %q", line)
		}
	}
}

func TestDecoderReadsNewlineDelimitedMessages(t *testing.T) {
	input := "{\"id\":1,\"method\":\"status\"}\n\n{\"id\":2,\"method\":\"down\"}\n"
	decoder := NewDecoder(strings.NewReader(input))

	var first, second Request
	if err := decoder.Decode(&first); err != nil {
		t.Fatalf("first: %v", err)
	}
	// The blank line between them is tolerated rather than fatal, so a
	// keepalive newline cannot drop the connection.
	if err := decoder.Decode(&second); err != nil {
		t.Fatalf("second: %v", err)
	}

	if first.ID != 1 || second.ID != 2 {
		t.Fatalf("ids = %d, %d; want 1, 2", first.ID, second.ID)
	}

	if err := decoder.Decode(&first); err != io.EOF {
		t.Fatalf("expected io.EOF at the end, got %v", err)
	}
}

func TestDecoderRefusesAnOversizedMessage(t *testing.T) {
	// A client that can reach the socket must not be able to make the daemon
	// allocate without bound.
	huge := "{\"id\":1,\"method\":\"" + strings.Repeat("x", MaxMessageBytes) + "\"}\n"

	var request Request
	if err := NewDecoder(strings.NewReader(huge)).Decode(&request); err == nil {
		t.Fatal("an oversized message was accepted")
	}
}

func TestEncoderWritesOneLinePerMessage(t *testing.T) {
	var buffer bytes.Buffer
	encoder := NewEncoder(&buffer)

	if err := encoder.Encode(Response{ID: 1, OK: true}); err != nil {
		t.Fatal(err)
	}
	if err := encoder.Encode(Event{Event: "stage", Stage: StageConnected}); err != nil {
		t.Fatal(err)
	}

	lines := strings.Split(strings.TrimRight(buffer.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d lines, want 2:\n%s", len(lines), buffer.String())
	}
	for _, line := range lines {
		if strings.Contains(line, "\n") {
			t.Fatal("a message contained an embedded newline")
		}
	}
}

// Responses carry an id and events do not; that is how the client tells them
// apart on a single stream.
func TestEventsAreDistinguishableFromResponses(t *testing.T) {
	var buffer bytes.Buffer
	encoder := NewEncoder(&buffer)

	_ = encoder.Encode(Event{Event: "stage", Stage: StageConnecting})
	line := buffer.String()

	if strings.Contains(line, "\"id\"") {
		t.Fatalf("an event carried an id: %s", line)
	}
	if !strings.Contains(line, "\"event\"") {
		t.Fatalf("an event had no event field: %s", line)
	}
}
