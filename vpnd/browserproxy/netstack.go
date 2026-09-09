package main

import (
	"context"
	"fmt"
	"net/netip"
	"os"
	"sync"

	"golang.zx2c4.com/wireguard/tun"
	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv6"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
)

// netTun is a WireGuard device whose "wire" is a TCP/IP stack in this process.
//
// This is the piece that makes browser-only mode possible. An ordinary tunnel
// hands packets to the kernel through a TUN device, which is why it needs
// privileges and why it changes the whole machine's routing. Here both ends
// live in userspace: wireguard-go writes decrypted packets into a stack that
// only this process can see, and the SOCKS server dials through that stack. The
// operating system is never told the tunnel exists.
//
// It has to satisfy two interfaces at once, which read backwards from each
// other and are the easiest thing to get wrong:
//
//   - tun.Device, for wireguard-go. Read means "give me a packet to encrypt and
//     send to the server"; Write means "here is a packet that arrived from the
//     server".
//   - stack.LinkEndpoint, for gvisor. WritePackets means "the stack is sending";
//     the dispatcher is how the stack receives.
//
// So a packet the browser sends travels stack -> WritePackets -> Read ->
// encrypt -> server, and a reply travels server -> decrypt -> Write ->
// dispatcher -> stack -> browser.
//
// The queue in the middle is a gvisor channel endpoint, which already
// implements the LinkEndpoint half correctly, including the parts that are
// tedious to get right by hand.
type netTun struct {
	ep     *channel.Endpoint
	stack  *stack.Stack
	events chan tun.Event
	mtu    int

	closeOnce sync.Once
	closed    chan struct{}
}

// The NIC number is arbitrary but must be consistent; there is only one.
const nicID tcpip.NICID = 1

// newNetTun builds the stack, gives it the tunnel addresses, and returns a
// device wireguard-go can drive.
//
// addresses are the client's own tunnel addresses, exactly as the config's
// Address line lists them.
func newNetTun(addresses []netip.Addr, mtu int) (*netTun, error) {
	s := stack.New(stack.Options{
		NetworkProtocols:   []stack.NetworkProtocolFactory{ipv4.NewProtocol, ipv6.NewProtocol},
		TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol, udp.NewProtocol},
		HandleLocal:        true,
	})

	dev := &netTun{
		// Deep enough that a burst arriving while the reader is busy queues
		// rather than being dropped. A drop here looks like packet loss to
		// the far end, and TCP answers loss by slowing down — which is how a
		// fast line ends up delivering a fraction of itself.
		ep:     channel.New(2048, uint32(mtu), ""),
		stack:  s,
		events: make(chan tun.Event, 4),
		mtu:    mtu,
		closed: make(chan struct{}),
	}

	if err := s.CreateNIC(nicID, dev.ep); err != nil {
		return nil, fmt.Errorf("create nic: %v", err)
	}

	if err := tuneTCP(s); err != nil {
		return nil, err
	}

	for _, addr := range addresses {
		proto := ipv4.ProtocolNumber
		if addr.Is6() {
			proto = ipv6.ProtocolNumber
		}
		protoAddr := tcpip.ProtocolAddress{
			Protocol:          proto,
			AddressWithPrefix: tcpip.AddrFromSlice(addr.AsSlice()).WithPrefix(),
		}
		if err := s.AddProtocolAddress(nicID, protoAddr, stack.AddressProperties{}); err != nil {
			return nil, fmt.Errorf("add address %s: %v", addr, err)
		}
	}

	// Everything goes to the tunnel. There is no other interface in this
	// stack, so a default route for both families is the whole table.
	s.SetRouteTable([]tcpip.Route{
		{Destination: header.IPv4EmptySubnet, NIC: nicID},
		{Destination: header.IPv6EmptySubnet, NIC: nicID},
	})

	dev.events <- tun.EventUp
	return dev, nil
}

// tuneTCP raises the window this stack is willing to open.
//
// The defaults are sized for a stack talking to something nearby. This one is
// talking through a tunnel to another country: at 60 ms round trip a
// connection cannot go faster than its window divided by the round trip, so a
// few hundred kilobytes of buffer is a hard ceiling of about twenty megabits
// however fast the line underneath is. Measured before and after on a real
// tunnel, not assumed.
//
// Auto-tuning is what makes the large maximum safe: a connection that does not
// need the window does not hold the memory.
func tuneTCP(s *stack.Stack) error {
	sizes := tcpip.TCPReceiveBufferSizeRangeOption{
		Min:     4 << 10,  // 4 KiB
		Default: 1 << 20,  // 1 MiB
		Max:     16 << 20, // 16 MiB
	}
	if err := s.SetTransportProtocolOption(tcp.ProtocolNumber, &sizes); err != nil {
		return fmt.Errorf("tcp receive buffer: %v", err)
	}

	send := tcpip.TCPSendBufferSizeRangeOption(sizes)
	if err := s.SetTransportProtocolOption(tcp.ProtocolNumber, &send); err != nil {
		return fmt.Errorf("tcp send buffer: %v", err)
	}

	moderate := tcpip.TCPModerateReceiveBufferOption(true)
	if err := s.SetTransportProtocolOption(tcp.ProtocolNumber, &moderate); err != nil {
		return fmt.Errorf("tcp receive buffer moderation: %v", err)
	}

	// Selective acknowledgement. Without it a single lost packet costs the
	// whole window rather than the packet, which over a tunnel crossing a
	// continent is the difference between a slow moment and a stalled one.
	sack := tcpip.TCPSACKEnabled(true)
	if err := s.SetTransportProtocolOption(tcp.ProtocolNumber, &sack); err != nil {
		return fmt.Errorf("tcp sack: %v", err)
	}
	return nil
}

// Stack exposes the network stack so the SOCKS server can dial through it.
func (d *netTun) Stack() *stack.Stack { return d.stack }

// --- tun.Device ------------------------------------------------------------

// File has no meaning here: there is no file descriptor, which is the point.
func (d *netTun) File() *os.File { return nil }

func (d *netTun) Events() <-chan tun.Event { return d.events }

func (d *netTun) MTU() (int, error) { return d.mtu, nil }

// Name is only ever used in log lines. There is no interface to name.
func (d *netTun) Name() (string, error) { return "browser", nil }

// BatchSize of one keeps the loop below simple. Throughput here is bounded by
// a browser's connections, not by syscall batching, so the trade is free.
// batchSize is how many packets wireguard-go is offered per Read.
//
// One at a time is the obvious implementation and it is what costs the
// throughput: every packet then pays for a channel wake-up and a trip through
// the encryption pipeline on its own. Measured on a real tunnel, batching is
// worth several times the transfer rate.
const batchSize = 128

func (d *netTun) BatchSize() int { return batchSize }

// Read hands wireguard-go the next packet the stack wants to send.
//
// Blocking is correct: wireguard-go calls this from its own goroutine and
// expects it to wait. Returning an error is how the loop is told to stop.
func (d *netTun) Read(bufs [][]byte, sizes []int, offset int) (int, error) {
	// Blocking for the first, then taking whatever else is already queued.
	// Waiting for a full batch would trade throughput for latency on exactly
	// the traffic — a click, a keystroke — where latency is what is noticed.
	pkt := d.ep.ReadContext(d.readContext())
	if pkt == nil {
		return 0, os.ErrClosed
	}

	count := 0
	for {
		size, err := pkt.ToView().Read(bufs[count][offset:])
		pkt.DecRef()
		if err != nil {
			return count, err
		}
		sizes[count] = size
		count++

		if count == len(bufs) {
			break
		}
		if pkt = d.ep.Read(); pkt == nil {
			break
		}
	}
	return count, nil
}

// Write injects packets that arrived from the server into the stack.
func (d *netTun) Write(bufs [][]byte, offset int) (int, error) {
	written := 0
	for _, buf := range bufs {
		packet := buf[offset:]
		if len(packet) == 0 {
			continue
		}

		// The version nibble is the only thing that says which protocol this
		// is; there is no link header to read it from.
		var proto tcpip.NetworkProtocolNumber
		switch header.IPVersion(packet) {
		case header.IPv4Version:
			proto = header.IPv4ProtocolNumber
		case header.IPv6Version:
			proto = header.IPv6ProtocolNumber
		default:
			// Not addressed to any stack we run. Dropping is right: this is a
			// tunnel for IP, and anything else is noise or an attack.
			continue
		}

		pkt := stack.NewPacketBuffer(stack.PacketBufferOptions{
			Payload: buffer.MakeWithData(packet),
		})
		d.ep.InjectInbound(proto, pkt)
		pkt.DecRef()
		written++
	}
	return written, nil
}

func (d *netTun) Close() error {
	d.closeOnce.Do(func() {
		close(d.closed)
		d.ep.Close()
		d.stack.Close()
		close(d.events)
	})
	return nil
}

// readContext turns the close channel into the context ReadContext wants, so
// a shutdown unblocks the read rather than leaving wireguard-go's goroutine
// parked on a queue nobody will ever fill again.
func (d *netTun) readContext() context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		select {
		case <-d.closed:
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx
}
