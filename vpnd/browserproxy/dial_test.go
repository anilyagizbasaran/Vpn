package main

import (
	"net/netip"
	"strings"
	"testing"
)

func addrs(list ...string) []netip.Addr {
	out := make([]netip.Addr, 0, len(list))
	for _, raw := range list {
		out = append(out, netip.MustParseAddr(raw))
	}
	return out
}

func TestOnlyTheFamiliesTheTunnelCarriesAreTried(t *testing.T) {
	// The control plane issues an IPv4-only tunnel. Half the internet answers
	// with an AAAA record as well, and the stack has no IPv6 source address to
	// send from — so those attempts cannot succeed, and trying them first
	// spends the browser's patience before the ones that can.
	d := &tunnelDialer{hasV4: true}

	got := d.reachable(addrs("2001:db8::1", "203.0.113.7", "2606:4700::1"))

	if len(got) != 1 || got[0].String() != "203.0.113.7" {
		t.Fatalf("kept %v, want only the IPv4 address", got)
	}
}

func TestADualStackTunnelKeepsBoth(t *testing.T) {
	d := &tunnelDialer{hasV4: true, hasV6: true}

	got := d.reachable(addrs("2001:db8::1", "203.0.113.7"))

	if len(got) != 2 {
		t.Fatalf("kept %v, want both", got)
	}
}

func TestNothingReachableFallsBackToTryingAnyway(t *testing.T) {
	// A tunnel with no IPv4 address and a name with only an A record. Failing
	// honestly at the dial beats refusing to try: the error the stack gives
	// says more than one invented here would.
	d := &tunnelDialer{hasV6: true}

	got := d.reachable(addrs("203.0.113.7"))

	if len(got) != 1 {
		t.Fatalf("kept %v, want the address tried anyway", got)
	}
}

func TestTheConfiguredAddressesDecideTheFamilies(t *testing.T) {
	// Read from the interface's own addresses rather than guessed, because
	// this is the thing the config actually determines.
	cfg, err := parseConfig(sample())
	if err != nil {
		t.Fatal(err)
	}

	d := newTunnelDialer(nil, cfg.Addresses, cfg.DNS)
	if !d.hasV4 || !d.hasV6 {
		t.Fatalf("a dual-stack config produced hasV4=%v hasV6=%v", d.hasV4, d.hasV6)
	}

	v4only := strings.ReplaceAll(sample(), "Address = 10.9.0.4/32, fd00::4/128", "Address = 10.9.0.4/32")
	cfg, err = parseConfig(v4only)
	if err != nil {
		t.Fatal(err)
	}
	d = newTunnelDialer(nil, cfg.Addresses, cfg.DNS)
	if !d.hasV4 || d.hasV6 {
		t.Fatalf("an IPv4-only config produced hasV4=%v hasV6=%v", d.hasV4, d.hasV6)
	}
}
