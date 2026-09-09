package ipc

import (
	"context"
	"errors"

	"vpnd/internal/browser"
	"vpnd/internal/enroll"
	"vpnd/internal/protocol"
	"vpnd/internal/tunnel"
)

// SetBrowser gives the daemon the ability to run a browser-only tunnel.
//
// Optional, like the kill switch: a daemon started without it answers the two
// methods with "unsupported" rather than pretending, which is what `-mock` and
// the tests want.
func (s *Server) SetBrowser(supervisor *browser.Supervisor) {
	s.browser = supervisor
}

// startBrowserOnly tunnels the browser and leaves the machine alone.
//
// Nothing here touches an interface or a route. That is the feature, and it is
// also why the two modes have to exclude each other: with the system-wide
// tunnel up, the browser's traffic would already be going through it, and this
// would be a second encrypted path inside the first one.
func (s *Server) startBrowserOnly(ctx context.Context) (any, *protocol.Error) {
	if s.browser == nil {
		return nil, &protocol.Error{
			Code:    protocol.CodeUnsupported,
			Message: "This daemon was started without browser-only support.",
		}
	}

	switch s.manager.Status().Stage {
	case protocol.StageConnected, protocol.StageConnecting:
		// Refused rather than silently taking the other tunnel down. Stopping
		// a machine-wide tunnel is a thing the user should have asked for, not
		// a side effect of a button in a browser.
		return nil, &protocol.Error{
			Code:    protocol.CodeBadRequest,
			Message: "The full VPN is on. Turn it off first to tunnel only the browser.",
		}
	}

	config, apiErr := s.browserConfig(ctx)
	if apiErr != nil {
		return nil, apiErr
	}

	port, err := s.browser.Start(ctx, config)
	if err != nil {
		s.log.Error("could not start the browser-only tunnel", "error", err)

		// An incomplete install is passed through verbatim, because it names
		// the thing to fix. Everything else stays generic: the detail would be
		// a network error the user cannot act on.
		var setup *browser.SetupError
		if errors.As(err, &setup) {
			return nil, &protocol.Error{
				Code:    protocol.CodeUnsupported,
				Message: setup.Message,
			}
		}
		return nil, &protocol.Error{
			Code:    protocol.CodeTunnelFailure,
			Message: "The browser tunnel could not be started.",
		}
	}

	s.log.Info("browser-only tunnel ready", "port", port)
	return s.status(), nil
}

// stopBrowserOnly ends it, and says so even when there was nothing to end.
func (s *Server) stopBrowserOnly() (any, *protocol.Error) {
	if s.browser == nil {
		return nil, &protocol.Error{
			Code:    protocol.CodeUnsupported,
			Message: "This daemon was started without browser-only support.",
		}
	}
	if err := s.browser.Stop(); err != nil {
		return nil, &protocol.Error{
			Code:    protocol.CodeTunnelFailure,
			Message: "The browser tunnel could not be stopped.",
		}
	}
	return s.status(), nil
}

// browserConfig produces the configuration the helper needs.
//
// A fresh one from the control plane when this machine has enrolled, for the
// same reason [Server.reconnectFromIdentity] fetches rather than stores: a
// held config eventually names a tunnel address the server has since given to
// somebody else. The remembered one is the fallback for a daemon driven
// entirely over IPC, which never had an identity to fetch with.
func (s *Server) browserConfig(ctx context.Context) (string, *protocol.Error) {
	if s.canRefetch() {
		stored, err := s.identity.Load()
		if err == nil && stored != nil {
			keys := enroll.Keys{Private: stored.PrivateKey, Public: stored.PublicKey}
			result, err := s.newClient(stored.ControlPlane).FetchConfig(ctx, stored.DeviceToken, keys)
			if err == nil {
				return s.checkedConfig(result.Config)
			}
			// Not fatal on its own: a config already in memory still works,
			// and browser-only mode is the one place where being offline for a
			// moment does not also mean being unable to reach the server.
			s.log.Warn("could not refresh the configuration for the browser tunnel",
				"server", stored.ControlPlane, "error", err)
		}
	}

	if config, _ := s.manager.LastConfig(); config != "" {
		return s.checkedConfig(config)
	}

	return "", &protocol.Error{
		Code:    protocol.CodeUnsupported,
		Message: "This computer is not set up yet. Enter your server address and invite code.",
	}
}

// checkedConfig puts the config through the same validation an interface would
// get. The helper ignores keys it does not know, so a hook could not run — but
// a config this daemon would refuse to install is one it should refuse to hand
// to a subprocess as well, rather than having two standards.
func (s *Server) checkedConfig(raw string) (string, *protocol.Error) {
	config := tunnel.NormalizeConfig(raw)
	if err := tunnel.ValidateConfig(config); err != nil {
		s.log.Warn("rejected a configuration for the browser tunnel",
			"config", protocol.RedactConfig(config))
		return "", &protocol.Error{
			Code:    protocol.CodeBadRequest,
			Message: "The VPN service returned a configuration this daemon will not use.",
		}
	}
	return config, nil
}

// StopBrowser ends the browser tunnel at shutdown.
//
// The helper is a child process, not an interface: nothing takes it down by
// itself. Left behind it would go on proxying through a tunnel this daemon can
// no longer stop, which is worse than either mode being off.
func (s *Server) StopBrowser() error {
	if s.browser == nil {
		return nil
	}
	return s.browser.Stop()
}
