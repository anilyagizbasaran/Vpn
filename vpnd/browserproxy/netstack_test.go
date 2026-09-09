package main

import (
	"net/netip"
	"testing"
	"time"

	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
)

// ipv4Packet builds the smallest thing the endpoint will carry: a header with
// the version nibble set, which is the only field this layer reads.
func ipv4Packet(payload byte) []byte {
	pkt := make([]byte, header.IPv4MinimumSize+1)
	pkt[0] = 4 << 4
	pkt[len(pkt)-1] = payload
	return pkt
}

func newTestTun(t *testing.T) *netTun {
	t.Helper()
	dev, err := newNetTun([]netip.Addr{netip.MustParseAddr("10.9.0.4")}, 1420)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { dev.Close() })
	return dev
}

// queue puts a packet on the endpoint's outbound side, where Read takes them
// from — the direction the stack sends and wireguard-go encrypts. This is the
// call the stack itself makes when it has something to transmit.
func queue(t *testing.T, dev *netTun, payload byte) {
	t.Helper()

	pkt := stack.NewPacketBuffer(stack.PacketBufferOptions{
		Payload: buffer.MakeWithData(ipv4Packet(payload)),
	})
	defer pkt.DecRef()

	var list stack.PacketBufferList
	list.PushBack(pkt)
	if _, err := dev.ep.WritePackets(list); err != nil {
		t.Fatalf("queueing a packet: %v", err)
	}
}

func TestReadTakesEveryQueuedPacketAtOnce(t *testing.T) {
	// One packet per Read is the obvious implementation and the expensive
	// one: every packet then pays for its own wake-up and its own trip
	// through the encryption pipeline. Measured on a real tunnel, batching
	// was worth several times the transfer rate.
	dev := newTestTun(t)

	const queued = 5
	for i := 0; i < queued; i++ {
		queue(t, dev, byte(i))
	}

	bufs := make([][]byte, dev.BatchSize())
	sizes := make([]int, dev.BatchSize())
	for i := range bufs {
		bufs[i] = make([]byte, 2048)
	}

	n, err := dev.Read(bufs, sizes, 0)
	if err != nil {
		t.Fatal(err)
	}
	if n != queued {
		t.Fatalf("Read returned %d packets, want all %d that were waiting", n, queued)
	}

	// In order, and each one whole.
	for i := 0; i < n; i++ {
		if sizes[i] != header.IPv4MinimumSize+1 {
			t.Fatalf("packet %d is %d bytes", i, sizes[i])
		}
		if got := bufs[i][sizes[i]-1]; got != byte(i) {
			t.Fatalf("packet %d carries %d", i, got)
		}
	}
}

func TestReadDoesNotWaitToFillABatch(t *testing.T) {
	// Waiting for a full batch would trade throughput for latency on exactly
	// the traffic where latency is what gets noticed: a click, a keystroke.
	dev := newTestTun(t)
	queue(t, dev, 1)

	bufs := make([][]byte, dev.BatchSize())
	sizes := make([]int, dev.BatchSize())
	for i := range bufs {
		bufs[i] = make([]byte, 2048)
	}

	done := make(chan int, 1)
	go func() {
		n, _ := dev.Read(bufs, sizes, 0)
		done <- n
	}()

	select {
	case n := <-done:
		if n != 1 {
			t.Fatalf("Read returned %d, want the one packet that was there", n)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Read waited for more packets instead of returning the one it had")
	}
}

func TestABatchLargerThanTheBuffersIsNotOverrun(t *testing.T) {
	dev := newTestTun(t)
	for i := 0; i < 4; i++ {
		queue(t, dev, byte(i))
	}

	// A caller with room for two must be given two, and the rest must stay
	// queued rather than being dropped on the floor.
	bufs := [][]byte{make([]byte, 2048), make([]byte, 2048)}
	sizes := make([]int, 2)

	n, err := dev.Read(bufs, sizes, 0)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("Read returned %d with room for 2", n)
	}

	n, err = dev.Read(bufs, sizes, 0)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("the remaining packets were lost: second Read returned %d", n)
	}
}

func TestWriteDropsWhatIsNotIP(t *testing.T) {
	// The version nibble is the only thing identifying the protocol; there is
	// no link header. Anything else is noise or an attack, and this stack
	// carries IP.
	dev := newTestTun(t)

	junk := make([]byte, 40)
	junk[0] = 0x99

	n, err := dev.Write([][]byte{junk}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("Write accepted %d non-IP packets", n)
	}
}

func TestTheStackIsToldToOpenALargeWindow(t *testing.T) {
	// At sixty milliseconds round trip a connection cannot go faster than its
	// window divided by that round trip, so the default buffer is a hard
	// ceiling well below the line underneath. This asserts the tuning ran at
	// all — a silent failure would show up only as a slow tunnel.
	dev := newTestTun(t)

	var got tcpip.TCPReceiveBufferSizeRangeOption
	if err := dev.Stack().TransportProtocolOption(tcp.ProtocolNumber, &got); err != nil {
		t.Fatalf("reading the receive buffer option: %v", err)
	}
	if got.Max < 8<<20 {
		t.Fatalf("receive buffer max is %d, too small to fill a long link", got.Max)
	}
}
