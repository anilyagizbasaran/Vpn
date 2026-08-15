/// Windows, macOS and Linux tunnel, driven through the vpnd daemon.
///
/// Layer 2, the desktop counterpart to `vpn_tunnel_mobile`. Both satisfy the
/// same [Tunnel] contract, which is why the composition root can pick one with
/// a single conditional and nothing above notices the difference.
library;

export 'src/daemon_client.dart'
    show DaemonClient, DaemonStage, kProtocolVersion;
export 'src/daemon_enrolment.dart' show DaemonEnrolment;
export 'src/desktop_tunnel.dart'
    show DesktopTunnel, defaultSocketPath, stageFromDaemon;
