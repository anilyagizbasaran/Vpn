package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"sync"
	"time"
)

// SOCKS5 wire constants. Only the parts this proxy answers to are named.
const (
	socksVersion = 0x05

	authNone        = 0x00
	authUnsupported = 0xFF

	cmdConnect = 0x01

	atypIPv4   = 0x01
	atypDomain = 0x03
	atypIPv6   = 0x04

	replySuccess         = 0x00
	replyGeneralFailure  = 0x01
	replyHostUnreachable = 0x04
	replyCommandNotSupp  = 0x07
	replyAddressNotSupp  = 0x08
)

// socksServer is the browser's way into the tunnel.
//
// Bound to loopback only. That is the security boundary and it is a real one:
// nothing off this machine can reach it. It is not a boundary between programs
// on this machine — any local process could use it — which is the honest cost
// of a proxy the browser can point at without privileges.
//
// CONNECT only. BIND and UDP ASSOCIATE are refused rather than half-served: a
// browser does not use them, and a half-working UDP path is exactly how a
// tunnel starts leaking.
type socksServer struct {
	dialer   dialer
	listener net.Listener
	log      func(string, ...any)

	wg       sync.WaitGroup
	closing  chan struct{}
	closeOne sync.Once
}

// dialer is the seam that makes this testable without a tunnel, and the seam
// that guarantees there is no other way out: the server has no access to
// net.Dial, so it cannot accidentally reach the internet directly.
type dialer interface {
	// DialTCP connects to whichever of addrs answers, and reports which one
	// did — a list rather than one address because a name usually has several
	// and only some of them are reachable through a given tunnel.
	DialTCP(ctx context.Context, addrs []netip.Addr, port uint16) (net.Conn, netip.Addr, error)
	Resolve(ctx context.Context, host string) ([]netip.Addr, error)
}

func newSocksServer(dialer dialer, listener net.Listener, log func(string, ...any)) *socksServer {
	return &socksServer{
		dialer:   dialer,
		listener: listener,
		log:      log,
		closing:  make(chan struct{}),
	}
}

func (s *socksServer) Serve() error {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.closing:
				s.wg.Wait()
				return nil
			default:
			}
			return err
		}

		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer conn.Close()
			if err := s.handle(conn); err != nil && !errors.Is(err, io.EOF) {
				// Never the destination: a log line per site visited would be
				// a browsing history, which this project keeps nowhere else
				// either.
				s.log("a browser connection failed", "error", err)
			}
		}()
	}
}

func (s *socksServer) Close() error {
	s.closeOne.Do(func() { close(s.closing) })
	return s.listener.Close()
}

func (s *socksServer) handle(client net.Conn) error {
	// A browser that opens a connection and says nothing must not hold a
	// goroutine forever.
	_ = client.SetDeadline(time.Now().Add(30 * time.Second))

	if err := s.greet(client); err != nil {
		return err
	}

	host, port, err := readRequest(client)
	if err != nil {
		var refusal *socksRefusal
		if errors.As(err, &refusal) {
			_ = writeReply(client, refusal.code, netip.Addr{}, 0)
		}
		return err
	}

	targets, err := s.resolve(host)
	if err != nil {
		_ = writeReply(client, replyHostUnreachable, netip.Addr{}, 0)
		return fmt.Errorf("resolve: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	remote, target, err := s.dialer.DialTCP(ctx, targets, port)
	if err != nil {
		_ = writeReply(client, replyHostUnreachable, netip.Addr{}, 0)
		return fmt.Errorf("dial: %w", err)
	}
	defer remote.Close()

	if err := writeReply(client, replySuccess, target, port); err != nil {
		return err
	}

	// The handshake is done; from here the connection lives as long as the
	// browser keeps it, so the deadline has to go.
	_ = client.SetDeadline(time.Time{})
	pipe(client, remote)
	return nil
}

// greet performs the method negotiation. Only "no authentication" is offered,
// which is what a loopback proxy wants.
func (s *socksServer) greet(client net.Conn) error {
	header := make([]byte, 2)
	if _, err := io.ReadFull(client, header); err != nil {
		return err
	}
	if header[0] != socksVersion {
		return fmt.Errorf("not SOCKS5 (version byte %d)", header[0])
	}

	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(client, methods); err != nil {
		return err
	}

	for _, m := range methods {
		if m == authNone {
			_, err := client.Write([]byte{socksVersion, authNone})
			return err
		}
	}

	_, _ = client.Write([]byte{socksVersion, authUnsupported})
	return errors.New("client offered no acceptable authentication method")
}

// socksRefusal carries the reply code a malformed request should be answered
// with, so the browser sees a SOCKS error rather than a dropped connection.
type socksRefusal struct {
	code byte
	msg  string
}

func (e *socksRefusal) Error() string { return e.msg }

// readRequest parses the CONNECT request. host is either a literal address or
// a name; resolving it is the caller's job, and deliberately so — that is
// where the DNS decision lives.
func readRequest(client net.Conn) (host string, port uint16, err error) {
	head := make([]byte, 4)
	if _, err := io.ReadFull(client, head); err != nil {
		return "", 0, err
	}
	if head[0] != socksVersion {
		return "", 0, &socksRefusal{replyGeneralFailure, "bad SOCKS version in request"}
	}
	if head[1] != cmdConnect {
		return "", 0, &socksRefusal{replyCommandNotSupp, "only CONNECT is supported"}
	}

	switch head[3] {
	case atypIPv4:
		raw := make([]byte, 4)
		if _, err := io.ReadFull(client, raw); err != nil {
			return "", 0, err
		}
		addr, _ := netip.AddrFromSlice(raw)
		host = addr.String()

	case atypIPv6:
		raw := make([]byte, 16)
		if _, err := io.ReadFull(client, raw); err != nil {
			return "", 0, err
		}
		addr, _ := netip.AddrFromSlice(raw)
		host = addr.String()

	case atypDomain:
		length := make([]byte, 1)
		if _, err := io.ReadFull(client, length); err != nil {
			return "", 0, err
		}
		name := make([]byte, int(length[0]))
		if _, err := io.ReadFull(client, name); err != nil {
			return "", 0, err
		}
		host = string(name)

	default:
		return "", 0, &socksRefusal{replyAddressNotSupp, "unknown address type"}
	}

	rawPort := make([]byte, 2)
	if _, err := io.ReadFull(client, rawPort); err != nil {
		return "", 0, err
	}
	return host, binary.BigEndian.Uint16(rawPort), nil
}

// resolve turns whatever the browser asked for into one address, over the
// tunnel when it is a name.
func (s *socksServer) resolve(host string) ([]netip.Addr, error) {
	if addr, err := netip.ParseAddr(host); err == nil {
		return []netip.Addr{addr.Unmap()}, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	return s.dialer.Resolve(ctx, host)
}

func writeReply(client net.Conn, code byte, bound netip.Addr, port uint16) error {
	reply := []byte{socksVersion, code, 0x00}

	switch {
	case bound.Is4():
		reply = append(reply, atypIPv4)
		v4 := bound.As4()
		reply = append(reply, v4[:]...)
	case bound.Is6():
		reply = append(reply, atypIPv6)
		v6 := bound.As16()
		reply = append(reply, v6[:]...)
	default:
		// A failure reply still needs a well-formed address field.
		reply = append(reply, atypIPv4, 0, 0, 0, 0)
	}

	var portBytes [2]byte
	binary.BigEndian.PutUint16(portBytes[:], port)
	reply = append(reply, portBytes[:]...)

	_, err := client.Write(reply)
	return err
}

// pipe copies in both directions until either side finishes, then makes sure
// the other side is told rather than left waiting.
func pipe(a, b net.Conn) {
	done := make(chan struct{}, 2)

	copyOne := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if c, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		}
		done <- struct{}{}
	}

	go copyOne(a, b)
	go copyOne(b, a)
	<-done
	<-done
}
