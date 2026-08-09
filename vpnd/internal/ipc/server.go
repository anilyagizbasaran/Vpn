package ipc

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"runtime"
	"sync"

	"vpnd/internal/protocol"
	"vpnd/internal/tunnel"
)

// Version is stamped at build time with -ldflags.
var Version = "dev"

// Server answers requests from the GUI on a local socket.
type Server struct {
	manager *tunnel.Manager
	log     *slog.Logger
}

func NewServer(manager *tunnel.Manager, log *slog.Logger) *Server {
	return &Server{manager: manager, log: log}
}

// Serve accepts connections until ctx is cancelled or the listener closes.
func (s *Server) Serve(ctx context.Context, listener net.Listener) error {
	var wg sync.WaitGroup

	// Unblocks the Accept below on shutdown; there is no other way to
	// interrupt it.
	go func() {
		<-ctx.Done()
		listener.Close()
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				// Expected: shutdown closed the listener. Let the in-flight
				// connections finish before returning.
				wg.Wait()
				return nil
			}
			return err
		}

		wg.Add(1)
		go func() {
			defer wg.Done()
			s.handle(ctx, conn)
		}()
	}
}

// handle owns one client connection for its lifetime.
func (s *Server) handle(ctx context.Context, conn net.Conn) {
	defer conn.Close()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	decoder := protocol.NewDecoder(conn)
	writer := &syncWriter{encoder: protocol.NewEncoder(conn)}

	var unsubscribe func()
	defer func() {
		if unsubscribe != nil {
			unsubscribe()
		}
	}()

	for {
		var request protocol.Request
		if err := decoder.Decode(&request); err != nil {
			if !errors.Is(err, io.EOF) {
				// A malformed line is a client bug, not a daemon one. Report
				// it and drop the connection rather than trying to resync.
				s.log.Warn("dropping a client that sent an undecodable message", "error", err)
				_ = writer.write(protocol.Response{
					OK: false,
					Error: &protocol.Error{
						Code:    protocol.CodeBadRequest,
						Message: "The request could not be decoded.",
					},
				})
			}
			return
		}

		if request.Method == protocol.MethodSubscribe {
			if unsubscribe != nil {
				s.reply(writer, request.ID, nil, &protocol.Error{
					Code:    protocol.CodeBadRequest,
					Message: "This connection is already subscribed.",
				})
				continue
			}
			events, cancelSub := s.manager.Subscribe()
			unsubscribe = cancelSub
			s.reply(writer, request.ID, s.manager.Status(), nil)
			go s.pump(ctx, writer, events)
			continue
		}

		result, apiErr := s.dispatch(ctx, request)
		s.reply(writer, request.ID, result, apiErr)
	}
}

// pump forwards stage changes until the subscription or the connection ends.
func (s *Server) pump(ctx context.Context, writer *syncWriter, events <-chan protocol.Event) {
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-events:
			if !ok {
				return
			}
			if err := writer.write(event); err != nil {
				// The client is gone; the deferred unsubscribe cleans up.
				return
			}
		}
	}
}

func (s *Server) dispatch(ctx context.Context, request protocol.Request) (any, *protocol.Error) {
	switch request.Method {
	case protocol.MethodVersion:
		return protocol.VersionResult{
			Version:  Version,
			Platform: runtime.GOOS,
			Protocol: protocol.ProtocolVersion,
		}, nil

	case protocol.MethodStatus:
		return s.manager.Status(), nil

	case protocol.MethodUp:
		var params protocol.UpParams
		if err := json.Unmarshal(request.Params, &params); err != nil {
			return nil, &protocol.Error{
				Code:    protocol.CodeBadRequest,
				Message: "The connect request was malformed.",
			}
		}

		// Normalised once, then used everywhere: validating one string and
		// installing another is how a check gets bypassed.
		config := tunnel.NormalizeConfig(params.Config)

		// Validated before it reaches the driver, and before it is written to
		// disk: a config with a PostUp hook would otherwise run as root.
		if err := tunnel.ValidateConfig(config); err != nil {
			var failure *tunnel.FailureError
			if errors.As(err, &failure) {
				s.log.Warn("rejected a tunnel configuration", "error", failure.Err)
				return nil, &protocol.Error{
					Code:    protocol.CodeBadRequest,
					Message: failure.UserMessage(),
				}
			}
			return nil, &protocol.Error{
				Code:    protocol.CodeBadRequest,
				Message: "The tunnel configuration was rejected.",
			}
		}

		if err := s.manager.Up(ctx, config, params.ServerAddress); err != nil {
			return nil, asProtocolError(err)
		}
		return s.manager.Status(), nil

	case protocol.MethodReconnect:
		// No config in the request: the caller has no account and cannot
		// produce one. The daemon reuses what it already accepted.
		if err := s.manager.Reconnect(ctx); err != nil {
			return nil, asProtocolError(err)
		}
		return s.manager.Status(), nil

	case protocol.MethodDown:
		if err := s.manager.Down(ctx); err != nil {
			return nil, asProtocolError(err)
		}
		return s.manager.Status(), nil

	default:
		return nil, &protocol.Error{
			Code:    protocol.CodeBadRequest,
			Message: "Unknown method: " + request.Method,
		}
	}
}

func (s *Server) reply(writer *syncWriter, id uint64, result any, apiErr *protocol.Error) {
	response := protocol.Response{ID: id, OK: apiErr == nil, Error: apiErr}
	if result != nil && apiErr == nil {
		encoded, err := json.Marshal(result)
		if err != nil {
			s.log.Error("could not encode a result", "error", err)
			response.OK = false
			response.Error = &protocol.Error{
				Code:    protocol.CodeInternal,
				Message: "The daemon produced a response it could not encode.",
			}
		} else {
			response.Result = encoded
		}
	}
	if err := writer.write(response); err != nil {
		s.log.Debug("could not write a response", "error", err)
	}
}

func asProtocolError(err error) *protocol.Error {
	var protoErr *protocol.Error
	if errors.As(err, &protoErr) {
		return protoErr
	}
	return &protocol.Error{Code: protocol.CodeInternal, Message: "The daemon failed."}
}

// syncWriter serialises the two goroutines that write to one connection: the
// request loop and the event pump. Interleaved JSON would be unparseable.
type syncWriter struct {
	mu      sync.Mutex
	encoder *protocol.Encoder
}

func (w *syncWriter) write(v any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.encoder.Encode(v)
}
