/// Windows, macOS and Linux tunnel, driven through the vpnd daemon.
///
/// Layer 2, and the only [Tunnel] implementation left: phones connect over
/// IKEv2 from their own Settings and never run this app. The contract stays,
/// because it is also what keeps the daemon client testable against a fake.
library;

export 'src/daemon_client.dart'
    show DaemonClient, DaemonStage, kProtocolVersion;
export 'src/daemon_enrolment.dart' show DaemonEnrolment;
export 'src/desktop_tunnel.dart'
    show DesktopTunnel, defaultSocketPath, stageFromDaemon;
