package wgctl

import (
	"context"
	"errors"
	"strings"
	"testing"
)

const (
	keyA = "aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxkMTI="
	keyB = "Ynl0ZXNieXRlc2J5dGVzYnl0ZXNieXRlc2J5dGVzMTI="
	keyC = "Y2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2M="
	psk  = "cHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHM="
)

// A real `wg show wg0 dump`: interface line first, then one line per peer,
// tab separated.
const sampleDump = "PRIVATEKEYPRIVATEKEYPRIVATEKEYPRIVATEKEYPRI=\t" + keyA + "\t51820\toff\n" +
	keyB + "\t(none)\t203.0.113.9:44512\t10.8.0.2/32\t1786320000\t1024\t2048\t25\n" +
	keyC + "\t" + psk + "\t(none)\t10.8.0.3/32\t0\t0\t0\toff\n"

type recorder struct {
	calls  [][]string
	output string
	err    error
}

func (r *recorder) runner(_ context.Context, _ string, args ...string) ([]byte, error) {
	r.calls = append(r.calls, args)
	return []byte(r.output), r.err
}

func newController(output string) (*Controller, *recorder) {
	rec := &recorder{output: output}
	return &Controller{Interface: "wg0", Binary: "wg", Run: rec.runner}, rec
}

func TestDumpParsesTheInterfaceAndPeers(t *testing.T) {
	c, _ := newController(sampleDump)

	key, peers, err := c.Dump(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if key != keyA {
		t.Fatalf("interface key = %q, want %q", key, keyA)
	}
	if len(peers) != 2 {
		t.Fatalf("got %d peers, want 2", len(peers))
	}

	first := peers[0]
	if first.PublicKey != keyB {
		t.Fatalf("public key = %q", first.PublicKey)
	}
	if first.RxBytes != 1024 || first.TxBytes != 2048 {
		t.Fatalf("counters = %d/%d, want 1024/2048", first.RxBytes, first.TxBytes)
	}
	if first.LastHandshake.IsZero() {
		t.Fatal("last handshake was not parsed")
	}
	if first.Endpoint != "203.0.113.9:44512" {
		t.Fatalf("endpoint = %q", first.Endpoint)
	}

	// A peer that has never handshaked reports 0, which is "never" and not the
	// Unix epoch — reporting 1970 upstream would look like a stale device.
	if !peers[1].LastHandshake.IsZero() {
		t.Fatal("a zero handshake was parsed as a real time")
	}
	if peers[1].Endpoint != "" {
		t.Fatalf("(none) endpoint became %q", peers[1].Endpoint)
	}
}

func TestDumpRejectsGarbage(t *testing.T) {
	for name, output := range map[string]string{
		"empty":              "",
		"whitespace":         "   \n",
		"truncated headline": "onefield\n",
	} {
		t.Run(name, func(t *testing.T) {
			c, _ := newController(output)
			if _, _, err := c.Dump(context.Background()); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}

func TestSyncReconcilesInOneCall(t *testing.T) {
	c, rec := newController(sampleDump)

	// keyB stays, keyC goes, a new key arrives.
	result, err := c.Sync(context.Background(), []DesiredPeer{
		{PublicKey: keyB, AllowedIPs: []string{"10.8.0.2/32"}},
		{PublicKey: keyA, AllowedIPs: []string{"10.8.0.9/32"}},
	})
	if err != nil {
		t.Fatal(err)
	}

	if result.Added != 1 || result.Removed != 1 || result.Total != 2 {
		t.Fatalf("result = %+v, want added 1 removed 1 total 2", result)
	}

	// One dump, one set. A node with thousands of devices must not fork per
	// peer inside its poll interval.
	if len(rec.calls) != 2 {
		t.Fatalf("made %d calls, want 2", len(rec.calls))
	}

	set := strings.Join(rec.calls[1], " ")
	if !strings.HasPrefix(set, "set wg0 ") {
		t.Fatalf("second call = %q", set)
	}
	if !strings.Contains(set, keyC+" remove") {
		t.Fatalf("the departed peer was not removed: %q", set)
	}
	if !strings.Contains(set, keyA+" allowed-ips 10.8.0.9/32") {
		t.Fatalf("the new peer was not added: %q", set)
	}
}

func TestSyncPassesPresharedKeysByFile(t *testing.T) {
	c, rec := newController(sampleDump)

	if _, err := c.Sync(context.Background(), []DesiredPeer{
		{PublicKey: keyB, AllowedIPs: []string{"10.8.0.2/32"}, PresharedKey: psk},
	}); err != nil {
		t.Fatal(err)
	}

	set := strings.Join(rec.calls[1], " ")
	if !strings.Contains(set, "preshared-key") {
		t.Fatalf("no preshared-key argument: %q", set)
	}
	// The secret must never appear on a command line, where every process on
	// the box can read it from /proc.
	if strings.Contains(set, psk) {
		t.Fatalf("the preshared key was passed inline: %q", set)
	}
}

func TestSyncWipesEveryPeerWhenTheAnswerIsEmpty(t *testing.T) {
	c, rec := newController(sampleDump)

	result, err := c.Sync(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}

	if result.Removed != 2 {
		t.Fatalf("removed %d, want 2", result.Removed)
	}
	set := strings.Join(rec.calls[1], " ")
	if !strings.Contains(set, keyB+" remove") || !strings.Contains(set, keyC+" remove") {
		t.Fatalf("not everything was removed: %q", set)
	}
}

func TestSyncSkipsTheSubprocessWhenNothingChanges(t *testing.T) {
	// An interface with no peers, asked for no peers.
	c, rec := newController("PRIVATE=\t" + keyA + "\t51820\toff\n")

	if _, err := c.Sync(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if len(rec.calls) != 1 {
		t.Fatalf("made %d calls, want only the dump", len(rec.calls))
	}
}

// The control plane is trusted, but not trusted enough to inject arguments
// into a command running as root on every node.
func TestSyncRejectsAnythingThatIsNotAKey(t *testing.T) {
	hostile := []string{
		"",
		"short=",
		"; rm -rf /",
		"remove",
		strings.Repeat("A", 43) + "x",
		"../../etc/passwd",
	}

	for _, key := range hostile {
		t.Run(key, func(t *testing.T) {
			c, rec := newController(sampleDump)
			if _, err := c.Sync(context.Background(), []DesiredPeer{
				{PublicKey: key, AllowedIPs: []string{"10.8.0.2/32"}},
			}); err == nil {
				t.Fatal("accepted")
			}
			// Only the dump ran; nothing reached the interface.
			if len(rec.calls) != 1 {
				t.Fatalf("a command ran with a rejected key: %v", rec.calls)
			}
		})
	}
}

func TestSyncRejectsAHostilePresharedKey(t *testing.T) {
	c, _ := newController(sampleDump)

	if _, err := c.Sync(context.Background(), []DesiredPeer{
		{PublicKey: keyB, AllowedIPs: []string{"10.8.0.2/32"}, PresharedKey: "not-a-key"},
	}); err == nil {
		t.Fatal("accepted")
	}
}

func TestSudoPrefixesTheBinary(t *testing.T) {
	rec := &recorder{output: sampleDump}
	c := &Controller{Interface: "wg0", Binary: "wg", UseSudo: true, Run: rec.runner}

	if _, _, err := c.Dump(context.Background()); err != nil {
		t.Fatal(err)
	}
	// -n: never prompt. A password prompt would hang the agent loop.
	if rec.calls[0][0] != "-n" || rec.calls[0][1] != "wg" {
		t.Fatalf("argv = %v", rec.calls[0])
	}
}

func TestSyncPropagatesAFailure(t *testing.T) {
	rec := &recorder{output: sampleDump}
	c := &Controller{Interface: "wg0", Binary: "wg", Run: func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if args[0] == "show" {
			return []byte(sampleDump), nil
		}
		return []byte("Unable to access interface: Operation not permitted"), errors.New("exit status 1")
	}}
	_ = rec

	if _, err := c.Sync(context.Background(), []DesiredPeer{
		{PublicKey: keyA, AllowedIPs: []string{"10.8.0.9/32"}},
	}); err == nil {
		t.Fatal("a failing wg set reported success")
	}
}
