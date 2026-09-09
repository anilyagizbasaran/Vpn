package main

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"time"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv6"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
)

// tunnelDialer opens connections inside the userspace stack, which is the only
// way out of this process that goes through the tunnel.
//
// Nothing here may fall back to the operating system's networking. A fallback
// would be worse than a failure: the browser would keep working while quietly
// leaving from the real address, which is the exact thing the user turned this
// mode on to prevent.
type tunnelDialer struct {
	stack *stack.Stack

	// Resolver is deliberately built on top of this same dialer, so name
	// lookups go through the tunnel too. A SOCKS proxy that tunnels the
	// connection but resolves the name locally leaks every site visited to
	// whoever runs the local resolver — the ISP, usually.
	resolver *net.Resolver
}

func newTunnelDialer(s *stack.Stack, dnsServers []netip.Addr) *tunnelDialer {
	d := &tunnelDialer{stack: s}

	d.resolver = &net.Resolver{
		// PreferGo is what makes the Dial below actually used. Without it Go
		// may hand the lookup to the platform resolver, which does not know
		// this tunnel exists.
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var lastErr error
			for _, server := range dnsServers {
				conn, err := d.dialDNS(ctx, network, server)
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			if lastErr == nil {
				lastErr = fmt.Errorf("no DNS server is configured for the tunnel")
			}
			return nil, lastErr
		},
	}
	return d
}

func protoFor(addr netip.Addr) tcpip.NetworkProtocolNumber {
	if addr.Is4() {
		return ipv4.ProtocolNumber
	}
	return ipv6.ProtocolNumber
}

func fullAddr(addr netip.Addr, port uint16) tcpip.FullAddress {
	return tcpip.FullAddress{
		NIC:  nicID,
		Addr: tcpip.AddrFromSlice(addr.AsSlice()),
		Port: port,
	}
}

// dialDNS reaches a DNS server over the tunnel. UDP first, as resolvers do.
func (d *tunnelDialer) dialDNS(ctx context.Context, network string, server netip.Addr) (net.Conn, error) {
	remote := fullAddr(server, 53)

	switch network {
	case "udp", "udp4", "udp6":
		return gonet.DialUDP(d.stack, nil, &remote, protoFor(server))
	default:
		// Go falls back to TCP for truncated answers.
		return gonet.DialContextTCP(ctx, d.stack, remote, protoFor(server))
	}
}

// DialTCP opens a TCP connection to a literal address through the tunnel.
func (d *tunnelDialer) DialTCP(ctx context.Context, addr netip.Addr, port uint16) (net.Conn, error) {
	return gonet.DialContextTCP(ctx, d.stack, fullAddr(addr, port), protoFor(addr))
}

// Resolve turns a hostname into addresses, over the tunnel.
func (d *tunnelDialer) Resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	addrs, err := d.resolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("no address for %s", host)
	}

	// Unmap so an IPv4 answer is treated as IPv4 by the stack rather than as
	// a v4-in-v6 address the IPv6 protocol would try to route.
	out := make([]netip.Addr, 0, len(addrs))
	for _, a := range addrs {
		out = append(out, a.Unmap())
	}
	return out, nil
}
