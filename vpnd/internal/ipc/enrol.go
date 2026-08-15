package ipc

import (
	"context"

	"vpnd/internal/enroll"
	"vpnd/internal/protocol"
	"vpnd/internal/tunnel"
)

// enrol registers this machine with a control plane and connects.
//
// The order matters. The tunnel comes up *before* the identity is saved, so a
// server that answers with something the interface refuses does not leave
// behind a stored credential that every later reconnect will try and fail on.
// The invite has been spent either way — but a failed enrolment should look
// like a failed enrolment, not like a device that exists and never works.
func (s *Server) enrol(ctx context.Context, params protocol.EnrollParams) (any, *protocol.Error) {
	if s.identity == nil {
		return nil, &protocol.Error{
			Code:    protocol.CodeUnsupported,
			Message: "This daemon was started without enrolment support.",
		}
	}

	address, err := enroll.ValidateAddress(params.ServerAddress)
	if err != nil {
		return nil, &protocol.Error{Code: protocol.CodeBadRequest, Message: err.Error()}
	}
	if params.InviteToken == "" {
		return nil, &protocol.Error{
			Code:    protocol.CodeBadRequest,
			Message: "Enter the invite code you were given.",
		}
	}

	result, err := s.newClient(address).Enrol(ctx, params.InviteToken)
	if err != nil {
		// Logged without the code: it is a credential, and this is the one
		// path where a failure tempts someone to log the request verbatim.
		s.log.Warn("enrolment refused", "server", address, "error", err)
		return nil, &protocol.Error{Code: protocol.CodeBadRequest, Message: err.Error()}
	}

	if err := s.bringUp(ctx, result); err != nil {
		return nil, err
	}

	if err := s.identity.Save(enroll.Identity{
		ControlPlane: address,
		DeviceToken:  result.DeviceToken,
		PrivateKey:   result.Keys.Private,
		PublicKey:    result.Keys.Public,
	}); err != nil {
		// The tunnel is up and usable, so this is not fatal to the request —
		// but it means the next reboot asks for a code again, and saying
		// nothing would make that look like the device was revoked.
		s.log.Error("could not store the device identity", "error", err)
	}

	s.log.Info("enrolled", "server", address)
	return s.status(), nil
}

// status is the manager's view plus the one thing it cannot know: whether this
// machine could connect if asked. Every reply goes through here so the
// extension gets a consistent answer no matter which call it made.
//
// "Could connect" and "has enrolled" are not the same, and the difference is
// visible. The desktop app enrols itself and hands the daemon a finished
// config, so there is no identity on disk — but the daemon can still reconnect
// from what it holds. Reporting only the stored identity would put a setup
// form in front of someone whose tunnel is working, and they would spend a
// second invite to fix a problem they did not have.
func (s *Server) status() protocol.StatusResult {
	result := s.manager.Status()
	result.Enrolled = s.manager.CanReconnect() || s.canRefetch()
	return result
}

// canRefetch reports whether this machine has an identity it could rebuild a
// config from.
func (s *Server) canRefetch() bool {
	if s.identity == nil {
		return false
	}
	stored, err := s.identity.Load()
	return err == nil && stored != nil
}

// reconnectFromIdentity is what makes the extension work after a reboot.
//
// The daemon keeps a key and a token rather than the config itself, and asks
// for the config again. A stored config would eventually name an address the
// server has since handed to somebody else, and the tunnel would come up
// against a peer that is not us.
func (s *Server) reconnectFromIdentity(ctx context.Context) (any, *protocol.Error) {
	stored, err := s.identity.Load()
	if err != nil || stored == nil {
		return nil, &protocol.Error{
			Code:    protocol.CodeUnsupported,
			Message: "This computer is not set up yet. Enter your server address and invite code.",
		}
	}

	keys := enroll.Keys{Private: stored.PrivateKey, Public: stored.PublicKey}
	result, err := s.newClient(stored.ControlPlane).FetchConfig(ctx, stored.DeviceToken, keys)
	if err != nil {
		s.log.Warn("could not refresh the configuration", "server", stored.ControlPlane, "error", err)
		return nil, &protocol.Error{Code: protocol.CodeBadRequest, Message: err.Error()}
	}

	if err := s.bringUp(ctx, result); err != nil {
		return nil, err
	}
	return s.status(), nil
}

// bringUp validates a config the daemon assembled itself and installs it.
//
// It goes through the same validation as one handed in over IPC. The config
// came from a server the user named, which is not the same as a server that
// can be trusted to put a PostUp hook in front of a process running as root.
func (s *Server) bringUp(ctx context.Context, result enroll.Result) *protocol.Error {
	config := tunnel.NormalizeConfig(result.Config)
	if err := tunnel.ValidateConfig(config); err != nil {
		s.log.Warn("rejected a configuration from the control plane",
			"config", protocol.RedactConfig(config))
		return &protocol.Error{
			Code:    protocol.CodeBadRequest,
			Message: "The VPN service returned a configuration this daemon will not install.",
		}
	}
	if err := s.manager.Up(ctx, config, result.Endpoint); err != nil {
		return asProtocolError(err)
	}
	return nil
}
