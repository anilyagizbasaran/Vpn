package tunnel

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"strings"
	"testing"

	"vpnd/internal/protocol"
)

// recordingKillSwitch captures what the manager asked for.
type recordingKillSwitch struct {
	engaged   int
	released  int
	iface     string
	allow     []Allow
	engageErr error
}

func (k *recordingKillSwitch) Engage(_ context.Context, iface string, allow []Allow) error {
	k.engaged++
	k.iface = iface
	k.allow = allow
	return k.engageErr
}

func (k *recordingKillSwitch) Release(context.Context) error {
	k.released++
	return nil
}

func (k *recordingKillSwitch) Name() string { return "recording" }

func TestNftScriptDeniesByDefault(t *testing.T) {
	script, err := NftScript("wg0", nil)
	if err != nil {
		t.Fatal(err)
	}

	// The single most important line in the file. A trailing `drop` rule would
	// do the same thing today and permit everything the moment someone edits
	// the chain and removes it.
	if !strings.Contains(script, "policy drop") {
		t.Fatalf("the chain does not deny by default:\n%s", script)
	}
	if !strings.Contains(script, `oifname "wg0" accept`) {
		t.Fatalf("the tunnel itself is not allowed out:\n%s", script)
	}
	if !strings.Contains(script, `oifname "lo" accept`) {
		t.Fatalf("loopback is blocked, which breaks the machine itself:\n%s", script)
	}

	// Without DHCP the machine cannot get an address, and without an address
	// it cannot reach the VPN server to connect in the first place.
	if !strings.Contains(script, "udp dport { 67, 68, 546, 547 } accept") {
		t.Fatalf("DHCP is blocked:\n%s", script)
	}

	// Idempotence: a reconnect must replace the ruleset, not stack a second
	// chain that also has to match.
	if !strings.HasPrefix(script, "destroy table inet "+NftTable) {
		t.Fatalf("the script does not replace an existing table:\n%s", script)
	}
}

func TestNftScriptAllowsTheServerItNeeds(t *testing.T) {
	script, err := NftScript("wg0", []Allow{
		{IP: net.ParseIP("203.0.113.10"), Port: 51820, Proto: "udp"},
		{IP: net.ParseIP("2001:db8::1"), Port: 443, Proto: "tcp"},
	})
	if err != nil {
		t.Fatal(err)
	}

	// A tunnel that cannot reach its own endpoint can never come back up, and
	// the block would then be permanent from the user's point of view.
	if !strings.Contains(script, "ip daddr 203.0.113.10 udp dport 51820 accept") {
		t.Fatalf("the WireGuard endpoint is unreachable:\n%s", script)
	}
	if !strings.Contains(script, "ip6 daddr 2001:db8::1 tcp dport 443 accept") {
		t.Fatalf("the v6 control plane rule is wrong:\n%s", script)
	}
}

func TestNftScriptRefusesWhatItCannotRenderExactly(t *testing.T) {
	// Every one of these reaches a command line running as root. Rendering
	// something approximate would be worse than failing to connect.
	cases := map[string]Allow{
		"no address":     {Port: 51820, Proto: "udp"},
		"port zero":      {IP: net.ParseIP("203.0.113.10"), Port: 0, Proto: "udp"},
		"port too large": {IP: net.ParseIP("203.0.113.10"), Port: 70000, Proto: "udp"},
		"odd protocol":   {IP: net.ParseIP("203.0.113.10"), Port: 51820, Proto: "icmp"},
		"injection":      {IP: net.ParseIP("203.0.113.10"), Port: 51820, Proto: "udp accept; drop"},
	}

	for name, rule := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := NftScript("wg0", []Allow{rule}); err == nil {
				t.Fatal("the rule was accepted")
			}
		})
	}
}

func TestNftScriptRefusesAnInterfaceNameItCannotQuote(t *testing.T) {
	k := &NftKillSwitch{Run: func(context.Context, string, string, ...string) ([]byte, error) {
		t.Fatal("nft was run with an interface name that should have been refused")
		return nil, nil
	}}

	err := k.Engage(context.Background(), `wg0" accept; drop #`, nil)

	if err == nil {
		t.Fatal("an interface name that would break out of the quotes was accepted")
	}
}

func TestReleaseIsSilentWhenThereIsNothingToRelease(t *testing.T) {
	// Runs at startup to clear what a crash left behind, so "no such table" is
	// the expected case, not a failure.
	k := &NftKillSwitch{Run: func(context.Context, string, string, ...string) ([]byte, error) {
		return []byte("Error: No such file or directory"), errors.New("exit status 1")
	}}

	if err := k.Release(context.Background()); err != nil {
		t.Fatalf("releasing an absent table failed: %v", err)
	}
}

func TestReleaseReportsARealFailureWithARecovery(t *testing.T) {
	k := &NftKillSwitch{Run: func(context.Context, string, string, ...string) ([]byte, error) {
		return []byte("Error: Could not process rule: Operation not permitted"), errors.New("exit status 1")
	}}

	err := k.Release(context.Background())

	if err == nil {
		t.Fatal("a machine left with no network reported success")
	}
	// The user is offline at this point. The message has to carry the command
	// that gets them back, because nothing else can reach them.
	var failure *FailureError
	if !asFailure(err, &failure) {
		t.Fatalf("not a FailureError: %v", err)
	}
	if !strings.Contains(failure.UserMessage(), "nft delete table inet "+NftTable) {
		t.Fatalf("no recovery instruction: %q", failure.UserMessage())
	}
}

func TestTunnelDoesNotStartWhenTrafficCannotBeBlocked(t *testing.T) {
	driver := &MockDriver{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	manager := NewManager(driver, "wg0", log)
	kill := &recordingKillSwitch{engageErr: errors.New("nft is not installed")}
	manager.SetKillSwitch(kill)

	err := manager.Up(context.Background(), killSwitchConfig, "203.0.113.10:51820")

	// Connecting without the protection the user turned on is the wrong
	// direction to fail in: they would be browsing unprotected, looking at a
	// screen that says connected.
	if err == nil {
		t.Fatal("the tunnel came up without the kill switch")
	}
	if manager.Status().Stage != protocol.StageFailed {
		t.Fatalf("stage = %q, want failed", manager.Status().Stage)
	}
	if driver.DownCalls == 0 {
		t.Fatal("the tunnel was left up after the kill switch failed")
	}
	if kill.released == 0 {
		t.Fatal("a partial ruleset was left installed")
	}
}

func TestDisconnectingReleasesTheBlockBeforeTheInterfaceGoes(t *testing.T) {
	driver := &MockDriver{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	manager := NewManager(driver, "wg0", log)
	kill := &recordingKillSwitch{}
	manager.SetKillSwitch(kill)

	ctx := context.Background()
	if err := manager.Up(ctx, killSwitchConfig, "203.0.113.10:51820"); err != nil {
		t.Fatal(err)
	}
	if err := manager.Down(ctx); err != nil {
		t.Fatal(err)
	}

	// Someone who pressed Disconnect wants their ordinary connection back, not
	// a machine with no network.
	if kill.released == 0 {
		t.Fatal("the block outlived the tunnel")
	}
	if kill.engaged != 1 {
		t.Fatalf("engaged %d times, want 1", kill.engaged)
	}
	if kill.iface != "wg0" {
		t.Fatalf("the rules named %q", kill.iface)
	}
}

func TestTheEndpointStaysReachableWhileBlocking(t *testing.T) {
	driver := &MockDriver{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	manager := NewManager(driver, "wg0", log)
	kill := &recordingKillSwitch{}
	manager.SetKillSwitch(kill)

	// A literal address, so this test does not depend on DNS.
	if err := manager.Up(context.Background(), killSwitchConfig, "203.0.113.10:51820"); err != nil {
		t.Fatal(err)
	}

	if len(kill.allow) == 0 {
		t.Fatal("nothing was allowed out; the tunnel could never reconnect")
	}
	found := false
	for _, rule := range kill.allow {
		if rule.IP.String() == "203.0.113.10" && rule.Port == 51820 && rule.Proto == "udp" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the WireGuard endpoint was not allowed: %+v", kill.allow)
	}
}

func TestNoKillSwitchLeavesTheTunnelAlone(t *testing.T) {
	driver := &MockDriver{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	manager := NewManager(driver, "wg0", log)

	// The default, and what Windows uses: wireguard.exe blocks untunneled
	// traffic itself. A hostname here would be resolved by the carve-out code
	// if it ran, so this also pins that it does not.
	err := manager.Up(context.Background(), killSwitchConfig, "vpn.invalid:51820")

	if err != nil {
		t.Fatalf("the tunnel failed with no kill switch configured: %v", err)
	}
}

// A config the driver accepts. The mock does not parse it; the manager does
// not either — validation happens a layer up, in the IPC server.
const killSwitchConfig = "[Interface]\nPrivateKey = k\nAddress = 10.8.0.2/32\n" +
	"\n[Peer]\nPublicKey = p\nAllowedIPs = 0.0.0.0/0\nEndpoint = vpn.test:51820\n"
