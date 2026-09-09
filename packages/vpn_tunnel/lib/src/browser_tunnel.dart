/// Tunnels one browser instead of the whole machine.
///
/// A separate contract from [Tunnel] rather than a mode on it, because the two
/// are genuinely different things. A [Tunnel] creates a network interface and
/// changes the routing table; this creates nothing, changes nothing, and hands
/// back a loopback address that a browser can be pointed at. Every other
/// program on the computer keeps its ordinary connection.
///
/// Only the desktop daemon can do this, which is also why it is optional: an
/// app running where nothing implements it holds null and never offers it.
library;

/// What the browser tunnel is doing, and where to reach it.
class BrowserTunnelState {
  const BrowserTunnelState({
    required this.running,
    this.host,
    this.port,
    this.failed = false,
  });

  /// The state to assume when nothing has been asked yet.
  static const off = BrowserTunnelState(running: false);

  final bool running;

  /// Whether it ended without being asked to.
  ///
  /// Kept apart from [running] because the two call for different words on
  /// screen. "Off" is what the user chose; this is something that happened to
  /// them, and the browser is now blocked rather than leaking — which they
  /// have no way to work out from a screen that just says off.
  final bool failed;

  /// Always loopback when running. Carried rather than assumed so nothing
  /// downstream invents an address of its own — that is how a proxy ends up
  /// advertised on a real interface.
  final String? host;
  final int? port;

  /// `host:port`, for showing the user where their browser should point.
  String? get endpoint =>
      running && host != null && port != null ? '$host:$port' : null;
}

/// Starts and stops the browser-only tunnel.
abstract interface class BrowserTunnel {
  /// What is running right now. Asked rather than remembered: the service that
  /// owns the tunnel outlives this app and may have been told something by
  /// another client — the browser extension drives the same daemon.
  Future<BrowserTunnelState> state();

  /// Starts it and reports where the browser should connect.
  ///
  /// Throws [TunnelException] with a message fit to show the user, including
  /// when the system-wide tunnel is up: the two exclude each other.
  Future<BrowserTunnelState> start();

  /// Stops it. Succeeds when nothing is running.
  Future<void> stop();
}
