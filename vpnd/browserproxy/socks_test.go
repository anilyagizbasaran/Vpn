package main

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/netip"
	"testing"
	"time"
)

// fakeDialer stands in for the tunnel. What it records is the point of most of
// these tests: whether a name was resolved here or leaked to the client's own
// resolver is not visible in the bytes on the wire, only in who was asked.
type fakeDialer struct {
	resolved []string
	dialed   []string

	resolveTo  netip.Addr
	resolveErr error
	dialErr    error

	// server is handed back as the far end of every dial, so a test can watch
	// bytes arrive.
	server net.Conn
}

func (f *fakeDialer) Resolve(_ context.Context, host string) ([]netip.Addr, error) {
	f.resolved = append(f.resolved, host)
	if f.resolveErr != nil {
		return nil, f.resolveErr
	}
	return []netip.Addr{f.resolveTo}, nil
}

func (f *fakeDialer) DialTCP(_ context.Context, addr netip.Addr, port uint16) (net.Conn, error) {
	f.dialed = append(f.dialed, netip.AddrPortFrom(addr, port).String())
	if f.dialErr != nil {
		return nil, f.dialErr
	}
	return f.server, nil
}

// newTestServer runs one SOCKS server over an in-memory pipe pair.
func newTestServer(t *testing.T, d *fakeDialer) net.Conn {
	t.Helper()

	client, serverSide := net.Pipe()
	srv := newSocksServer(d, nil, func(string, ...any) {})

	go func() {
		defer serverSide.Close()
		_ = srv.handle(serverSide)
	}()

	t.Cleanup(func() { client.Close() })
	_ = client.SetDeadline(time.Now().Add(5 * time.Second))
	return client
}

// greet performs the method negotiation from the client side.
func greet(t *testing.T, c net.Conn) {
	t.Helper()
	if _, err := c.Write([]byte{socksVersion, 1, authNone}); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(c, reply); err != nil {
		t.Fatal(err)
	}
	if reply[0] != socksVersion || reply[1] != authNone {
		t.Fatalf("greeting refused: %v", reply)
	}
}

func connectDomain(t *testing.T, c net.Conn, host string, port uint16) {
	t.Helper()
	req := []byte{socksVersion, cmdConnect, 0x00, atypDomain, byte(len(host))}
	req = append(req, host...)
	var p [2]byte
	binary.BigEndian.PutUint16(p[:], port)
	req = append(req, p[:]...)
	if _, err := c.Write(req); err != nil {
		t.Fatal(err)
	}
}

func readReply(t *testing.T, c net.Conn) byte {
	t.Helper()
	head := make([]byte, 4)
	if _, err := io.ReadFull(c, head); err != nil {
		t.Fatal(err)
	}
	switch head[3] {
	case atypIPv4:
		io.ReadFull(c, make([]byte, 4+2))
	case atypIPv6:
		io.ReadFull(c, make([]byte, 16+2))
	}
	return head[1]
}

func TestNamesAreResolvedThroughTheTunnel(t *testing.T) {
	far, _ := net.Pipe()
	d := &fakeDialer{resolveTo: netip.MustParseAddr("203.0.113.7"), server: far}

	client := newTestServer(t, d)
	greet(t, client)
	connectDomain(t, client, "example.com", 443)

	if code := readReply(t, client); code != replySuccess {
		t.Fatalf("reply code %d", code)
	}

	// The whole reason this proxy resolves names itself: if the browser's own
	// resolver did it, every site visited would go to the local network's DNS
	// in the clear, while the connection itself looked private.
	if len(d.resolved) != 1 || d.resolved[0] != "example.com" {
		t.Fatalf("name was not resolved through the tunnel: %v", d.resolved)
	}
	if len(d.dialed) != 1 || d.dialed[0] != "203.0.113.7:443" {
		t.Fatalf("dialed %v", d.dialed)
	}
}

func TestLiteralAddressesAreNotResolved(t *testing.T) {
	far, _ := net.Pipe()
	d := &fakeDialer{server: far}

	client := newTestServer(t, d)
	greet(t, client)

	req := []byte{socksVersion, cmdConnect, 0x00, atypIPv4, 198, 51, 100, 9, 0x01, 0xBB}
	if _, err := client.Write(req); err != nil {
		t.Fatal(err)
	}
	if code := readReply(t, client); code != replySuccess {
		t.Fatalf("reply code %d", code)
	}

	if len(d.resolved) != 0 {
		t.Fatalf("a literal address was sent to the resolver: %v", d.resolved)
	}
	if len(d.dialed) != 1 || d.dialed[0] != "198.51.100.9:443" {
		t.Fatalf("dialed %v", d.dialed)
	}
}

func TestTrafficIsCarriedBothWays(t *testing.T) {
	far, upstream := net.Pipe()
	d := &fakeDialer{resolveTo: netip.MustParseAddr("203.0.113.7"), server: far}

	client := newTestServer(t, d)
	greet(t, client)
	connectDomain(t, client, "example.com", 80)
	if code := readReply(t, client); code != replySuccess {
		t.Fatalf("reply code %d", code)
	}

	_ = upstream.SetDeadline(time.Now().Add(5 * time.Second))

	if _, err := client.Write([]byte("GET / HTTP/1.1\r\n")); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 16)
	if _, err := io.ReadFull(upstream, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != "GET / HTTP/1.1\r\n" {
		t.Fatalf("upstream saw %q", got)
	}

	if _, err := upstream.Write([]byte("HTTP/1.1 200 OK\r\n")); err != nil {
		t.Fatal(err)
	}
	back := make([]byte, 17)
	if _, err := io.ReadFull(client, back); err != nil {
		t.Fatal(err)
	}
	if string(back) != "HTTP/1.1 200 OK\r\n" {
		t.Fatalf("browser saw %q", back)
	}
}

func TestOnlyConnectIsOffered(t *testing.T) {
	// BIND and UDP ASSOCIATE are refused rather than half-implemented. A UDP
	// path that silently falls back to the host's networking is how a tunnel
	// leaks, and a browser needs neither.
	for _, cmd := range []byte{0x02, 0x03} {
		far, _ := net.Pipe()
		d := &fakeDialer{server: far}
		client := newTestServer(t, d)
		greet(t, client)

		req := []byte{socksVersion, cmd, 0x00, atypIPv4, 1, 1, 1, 1, 0x00, 0x35}
		// Written from a goroutine: the server stops reading the moment it
		// refuses the command, and an unbuffered pipe would deadlock here.
		go func() { _, _ = client.Write(req) }()

		if code := readReply(t, client); code != replyCommandNotSupp {
			t.Fatalf("command %d answered with %d, want %d", cmd, code, replyCommandNotSupp)
		}
		if len(d.dialed) != 0 {
			t.Fatalf("command %d still dialled: %v", cmd, d.dialed)
		}
	}
}

func TestAFailedLookupIsReportedNotBypassed(t *testing.T) {
	far, _ := net.Pipe()
	d := &fakeDialer{resolveErr: errors.New("no answer"), server: far}

	client := newTestServer(t, d)
	greet(t, client)
	connectDomain(t, client, "nowhere.invalid", 443)

	if code := readReply(t, client); code != replyHostUnreachable {
		t.Fatalf("reply code %d, want %d", code, replyHostUnreachable)
	}
	// The failure must not turn into a direct connection. There is no path
	// from here to the host's network, and this is the test that says so.
	if len(d.dialed) != 0 {
		t.Fatalf("dialled anyway: %v", d.dialed)
	}
}

func TestAClientOfferingNoAcceptableAuthIsRejected(t *testing.T) {
	far, _ := net.Pipe()
	client := newTestServer(t, &fakeDialer{server: far})

	// 0x02 is username/password, which this proxy does not offer.
	if _, err := client.Write([]byte{socksVersion, 1, 0x02}); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(client, reply); err != nil {
		t.Fatal(err)
	}
	if reply[1] != authUnsupported {
		t.Fatalf("answered %v", reply)
	}
}

func TestNonSocksTrafficIsRefused(t *testing.T) {
	far, _ := net.Pipe()
	client := newTestServer(t, &fakeDialer{server: far})

	// Something pointed a plain HTTP request at the proxy port. It has to be
	// dropped rather than guessed at: answering would turn this into a second,
	// unaudited way out of the machine.
	go func() { _, _ = client.Write([]byte("GET / HTTP/1.1\r\n\r\n")) }()

	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 8)
	n, err := client.Read(buf)
	if err == nil && n > 0 {
		t.Fatalf("the proxy answered non-SOCKS traffic with %q", buf[:n])
	}
}
