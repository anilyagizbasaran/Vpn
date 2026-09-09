package main

import (
	"strings"
	"testing"
)

// Fixed vectors rather than a round trip through the same encoders: a base64
// string and the hex it must become, written out by hand. Deriving the
// expectation with the same library would pass even if both sides were wrong.
const (
	privB64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
	privHex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
	pubB64  = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8="
	pubHex  = "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f"
	pskB64  = "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s="
	pskHex  = "abababababababababababababababababababababababababababababababab"
)

// sample is a config of the shape the control plane issues.
func sample(extra ...string) string {
	lines := []string{
		"[Interface]",
		"PrivateKey = " + privB64,
		"Address = 10.9.0.4/32, fd00::4/128",
		"DNS = 10.9.0.1",
		"MTU = 1380",
		"",
		"[Peer]",
		"PublicKey = " + pubB64,
		"Endpoint = vpn.example.com:51820",
		"AllowedIPs = 0.0.0.0/0, ::/0",
		"PersistentKeepalive = 25",
	}
	return strings.Join(append(lines, extra...), "\n") + "\n"
}

func TestAConfigIsReadAsWgQuickWritesIt(t *testing.T) {
	cfg, err := parseConfig(sample())
	if err != nil {
		t.Fatal(err)
	}

	if cfg.PrivateKey != privB64 || cfg.PublicKey != pubB64 {
		t.Fatalf("keys read as %q / %q", cfg.PrivateKey, cfg.PublicKey)
	}
	if cfg.Endpoint != "vpn.example.com:51820" {
		t.Fatalf("endpoint %q", cfg.Endpoint)
	}
	if cfg.MTU != 1380 || cfg.Keepalive != 25 {
		t.Fatalf("mtu %d keepalive %d", cfg.MTU, cfg.Keepalive)
	}

	// The prefix length is dropped: the stack is given an address, and the
	// routing is a default route regardless of what the config claims.
	if len(cfg.Addresses) != 2 ||
		cfg.Addresses[0].String() != "10.9.0.4" ||
		cfg.Addresses[1].String() != "fd00::4" {
		t.Fatalf("addresses %v", cfg.Addresses)
	}
	if len(cfg.DNS) != 1 || cfg.DNS[0].String() != "10.9.0.1" {
		t.Fatalf("dns %v", cfg.DNS)
	}
}

func TestKeysAreConvertedToTheHexUapiWants(t *testing.T) {
	// This is the conversion whose failure mode is invisible: a wrong key
	// produces a tunnel that builds, starts, reports no error, and then never
	// completes a handshake with anything.
	cfg, err := parseConfig(sample("PresharedKey = " + pskB64))
	if err != nil {
		t.Fatal(err)
	}

	uapi, err := cfg.uapi()
	if err != nil {
		t.Fatal(err)
	}

	for _, want := range []string{
		"private_key=" + privHex,
		"public_key=" + pubHex,
		"preshared_key=" + pskHex,
		"endpoint=vpn.example.com:51820",
		"persistent_keepalive_interval=25",
	} {
		if !strings.Contains(uapi, want+"\n") {
			t.Errorf("uapi is missing %q:\n%s", want, uapi)
		}
	}

	// The base64 form must not survive into the device configuration at all;
	// wireguard-go would take it as a malformed key and refuse the whole set.
	if strings.Contains(uapi, privB64) || strings.Contains(uapi, pubB64) {
		t.Errorf("a key was passed through unconverted:\n%s", uapi)
	}
}

func TestTheWholeInternetIsRoutedIntoTheTunnel(t *testing.T) {
	// Narrower allowed IPs would mean the netstack quietly declining to carry
	// some destinations, which the browser would show as a site that does not
	// load rather than as a tunnel that is misconfigured.
	cfg, err := parseConfig(sample())
	if err != nil {
		t.Fatal(err)
	}
	uapi, err := cfg.uapi()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"allowed_ip=0.0.0.0/0\n", "allowed_ip=::/0\n"} {
		if !strings.Contains(uapi, want) {
			t.Errorf("uapi is missing %q:\n%s", want, uapi)
		}
	}
}

func TestAConfigWithoutDnsIsRefused(t *testing.T) {
	// Refusing is the whole point. With no resolver inside the tunnel the
	// proxy would have to look names up some other way, and every site the
	// browser visited would go to the local network's DNS in the clear while
	// the connections themselves looked private.
	without := strings.ReplaceAll(sample(), "DNS = 10.9.0.1\n", "")
	if _, err := parseConfig(without); err == nil {
		t.Fatal("a config with no DNS server was accepted")
	}
}

func TestAnIncompleteConfigIsRefused(t *testing.T) {
	cases := map[string]string{
		"no private key":    "PrivateKey = " + privB64 + "\n",
		"no peer key":       "PublicKey = " + pubB64 + "\n",
		"no endpoint":       "Endpoint = vpn.example.com:51820\n",
		"no tunnel address": "Address = 10.9.0.4/32, fd00::4/128\n",
	}
	for name, line := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := parseConfig(strings.ReplaceAll(sample(), line, "")); err == nil {
				t.Fatalf("accepted a config with %s", name)
			}
		})
	}
}

func TestAMalformedKeyIsReportedNotTruncated(t *testing.T) {
	// A short key is the dangerous case: base64 decodes fine, and only the
	// length says anything is wrong. Silently padding it would produce a
	// tunnel keyed with something nobody chose.
	short := strings.ReplaceAll(sample(), privB64, "AAECAwQFBgcICQoL")
	cfg, err := parseConfig(short)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cfg.uapi(); err == nil {
		t.Fatal("a 12-byte private key was accepted")
	}

	notBase64 := strings.ReplaceAll(sample(), pubB64, "this is not a key")
	cfg, err = parseConfig(notBase64)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cfg.uapi(); err == nil {
		t.Fatal("a non-base64 peer key was accepted")
	}
}

func TestCommentsAndBlankLinesAreIgnored(t *testing.T) {
	// wg-quick configs written by hand carry comments, and the control plane
	// puts a header on the ones it issues.
	raw := "# issued by the control plane\n\n" +
		strings.ReplaceAll(sample(), "[Peer]", "# the server\n[Peer]")
	if _, err := parseConfig(raw); err != nil {
		t.Fatal(err)
	}
}
