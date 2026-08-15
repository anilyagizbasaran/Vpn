package tunnel

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
)

// Allow is one destination that stays reachable while the kill switch is on.
//
// There are only ever a couple: the WireGuard endpoint, because a tunnel that
// cannot reach its own server can never come back, and the control plane, so a
// dropped tunnel can be rebuilt rather than needing the user to turn the kill
// switch off by hand.
type Allow struct {
	IP    net.IP
	Port  int
	Proto string // "udp" or "tcp"
}

// KillSwitch stops traffic leaving by any route but the tunnel.
//
// This is the thing that makes a VPN a privacy tool rather than a proxy. A
// tunnel that drops without one does not fail visibly — it fails by quietly
// sending the next request over the ordinary route, from the real address, and
// nothing on screen changes.
type KillSwitch interface {
	// Engage blocks everything except the tunnel and [Allow]. Idempotent:
	// calling it twice replaces the rules rather than stacking them.
	Engage(ctx context.Context, iface string, allow []Allow) error

	// Release removes the rules. Must succeed when nothing is installed —
	// it runs at startup to clear anything a crash left behind.
	Release(ctx context.Context) error

	// Name identifies the implementation in logs.
	Name() string
}

// NoKillSwitch is the implementation for platforms that do not need one here.
//
// Windows is the case that matters: wireguard.exe installs WFP filters that
// drop untunneled traffic whenever the config has a single peer with a default
// route and no Table key, which is exactly what this daemon accepts and what
// config_test.go pins. Adding a second mechanism on top would mean two things
// that can each strand a machine offline, for no extra protection.
type NoKillSwitch struct{ Reason string }

func (n NoKillSwitch) Engage(context.Context, string, []Allow) error { return nil }
func (n NoKillSwitch) Release(context.Context) error                 { return nil }
func (n NoKillSwitch) Name() string                                  { return "none: " + n.Reason }

// NftKillSwitch blocks untunneled traffic with nftables, for Linux.
//
// wg-quick sets up policy routing but no filtering, so when an interface goes
// away the default route takes over and traffic leaves in the clear. This adds
// the filter wg-quick does not.
type NftKillSwitch struct {
	Run ScriptRunner

	// Binary overrides the nft path, for tests and unusual installs.
	Binary string
}

// NftTable is the table name. Its own table, so releasing it cannot disturb a
// firewall the operator configured themselves.
const NftTable = "vpnkill"

// NewNftKillSwitch builds one that shells out to nft.
func NewNftKillSwitch() *NftKillSwitch {
	return &NftKillSwitch{Run: realScriptRunner}
}

func (k *NftKillSwitch) Name() string { return "nftables" }

func (k *NftKillSwitch) binary() string {
	if k.Binary != "" {
		return k.Binary
	}
	return "nft"
}

func (k *NftKillSwitch) Engage(ctx context.Context, iface string, allow []Allow) error {
	if err := validateInterfaceName(iface); err != nil {
		return err
	}

	script, err := NftScript(iface, allow)
	if err != nil {
		return err
	}

	// One `nft -f` for the delete and the rebuild together: nftables applies a
	// script as a single transaction, so there is no instant where the old
	// rules are gone and the new ones are not yet there.
	if output, runErr := k.Run(ctx, script, k.binary(), "-f", "-"); runErr != nil {
		return &FailureError{
			Op:      "killswitch",
			Message: "Traffic outside the tunnel could not be blocked.",
			Err:     fmt.Errorf("nft: %w: %s", runErr, strings.TrimSpace(string(output))),
		}
	}
	return nil
}

func (k *NftKillSwitch) Release(ctx context.Context) error {
	// `destroy` does not fail when the table is absent; `delete` does. Release
	// runs at startup to clear what a crash left behind, so it has to be
	// silent about there being nothing to clear.
	script := "destroy table inet " + NftTable + "\n"

	if output, err := k.Run(ctx, script, k.binary(), "-f", "-"); err != nil {
		if isMissingTable(string(output)) {
			return nil
		}
		return &FailureError{
			Op:      "killswitch",
			Message: "The traffic block could not be removed. Run: nft delete table inet " + NftTable,
			Err:     fmt.Errorf("nft: %w: %s", err, strings.TrimSpace(string(output))),
		}
	}
	return nil
}

// isMissingTable recognises an nft too old for `destroy`, which reports the
// absent table as an error rather than ignoring it.
func isMissingTable(output string) bool {
	lowered := strings.ToLower(output)
	for _, phrase := range []string{"no such file or directory", "does not exist", "unknown command"} {
		if strings.Contains(lowered, phrase) {
			return true
		}
	}
	return false
}

// NftScript renders the ruleset. Separate from running it so the policy can be
// read and asserted without nftables installed — this is the file where a
// mistake means either a leak or a machine with no network.
func NftScript(iface string, allow []Allow) (string, error) {
	var b strings.Builder

	// Destroying first makes Engage idempotent: a reconnect replaces the rules
	// rather than adding a second chain that also has to match.
	b.WriteString("destroy table inet " + NftTable + "\n")
	b.WriteString("table inet " + NftTable + " {\n")
	b.WriteString("\tchain output {\n")

	// policy drop, not a trailing drop rule. If anything below fails to parse
	// nftables rejects the whole script, but if a rule is ever *removed* by a
	// future edit the chain still denies rather than permits.
	b.WriteString("\t\ttype filter hook output priority 0; policy drop;\n")

	b.WriteString("\t\toifname \"lo\" accept\n")
	b.WriteString("\t\toifname \"" + iface + "\" accept\n")

	// The local network stays reachable. Not a concession: without DHCP the
	// machine cannot get an address, and without an address it cannot reach
	// the VPN server either — the kill switch would lock the computer off
	// every network including the one it needs. None of this leaves the LAN.
	b.WriteString("\t\tudp dport { 67, 68, 546, 547 } accept\n")
	b.WriteString("\t\tip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, " +
		"169.254.0.0/16, 224.0.0.0/4, 255.255.255.255 } accept\n")
	b.WriteString("\t\tip6 daddr { fc00::/7, fe80::/10, ff00::/8 } accept\n")

	for _, rule := range allow {
		line, err := allowLine(rule)
		if err != nil {
			return "", err
		}
		b.WriteString("\t\t" + line + "\n")
	}

	b.WriteString("\t}\n}\n")
	return b.String(), nil
}

// allowLine renders one exception, refusing anything it cannot render exactly.
//
// Everything here reaches a root command line. It is built from literals and
// numbers only — an address is re-rendered from the parsed form rather than
// passed through, so a hostile endpoint string cannot become a rule.
func allowLine(rule Allow) (string, error) {
	if rule.IP == nil {
		return "", &FailureError{
			Op:      "killswitch",
			Message: "The VPN server address could not be resolved to block other traffic safely.",
		}
	}
	if rule.Port < 1 || rule.Port > 65535 {
		return "", &FailureError{
			Op:      "killswitch",
			Message: "The VPN server port is not valid.",
		}
	}

	proto := rule.Proto
	if proto != "udp" && proto != "tcp" {
		return "", &FailureError{
			Op:      "killswitch",
			Message: "The VPN service tried to allow an unsupported protocol.",
		}
	}

	family := "ip"
	if rule.IP.To4() == nil {
		family = "ip6"
	}

	return fmt.Sprintf("%s daddr %s %s dport %d accept",
		family, rule.IP.String(), proto, rule.Port), nil
}

// ResolveAllow turns a "host:port" into rules the kill switch can install.
//
// Resolved to addresses on purpose. A rule naming a hostname would be resolved
// by nft at load time anyway, and by then the kill switch may already be
// blocking DNS — so the lookup happens here, while the tunnel is still up.
//
// Every address a name resolves to is allowed, because a server behind a
// round-robin will otherwise be reachable only on whichever record was first.
func ResolveAllow(ctx context.Context, hostPort, proto string) ([]Allow, error) {
	host, portText, err := net.SplitHostPort(hostPort)
	if err != nil {
		return nil, &FailureError{
			Op:      "killswitch",
			Message: "The VPN server address could not be understood.",
			Err:     err,
		}
	}

	port, err := strconv.Atoi(portText)
	if err != nil {
		return nil, &FailureError{
			Op:      "killswitch",
			Message: "The VPN server port is not a number.",
			Err:     err,
		}
	}

	addresses, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil {
		return nil, &FailureError{
			Op:      "killswitch",
			Message: "The VPN server address could not be resolved.",
			Err:     err,
		}
	}

	rules := make([]Allow, 0, len(addresses))
	for _, address := range addresses {
		rules = append(rules, Allow{IP: address, Port: port, Proto: proto})
	}
	return rules, nil
}
