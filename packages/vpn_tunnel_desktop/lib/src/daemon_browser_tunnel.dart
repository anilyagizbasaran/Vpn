import 'package:vpn_tunnel/vpn_tunnel.dart';

import 'daemon_client.dart';
import 'desktop_tunnel.dart';

/// Browser-only mode, driven through vpnd.
///
/// The daemon does the work for the same reason it owns enrolment: the tunnel
/// needs this device's private key, which has never left the daemon and is not
/// going to start now. The app sends a verb and gets a loopback port back.
///
/// A short-lived connection per call, like [DaemonEnrolment] and for the same
/// reason: this is asked a handful of times a launch, and a second socket
/// costs less than sharing a lifetime with a long-running subscription.
class DaemonBrowserTunnel implements BrowserTunnel {
  DaemonBrowserTunnel({
    String? socketPath,
    Future<DaemonClient> Function(String path)? connect,
  }) : _socketPath = socketPath ?? defaultSocketPath(),
       _connect = connect ?? DaemonClient.connect;

  final String _socketPath;
  final Future<DaemonClient> Function(String path) _connect;

  @override
  Future<BrowserTunnelState> state() async {
    try {
      return await _call('status');
    } on TunnelException {
      // No daemon means no browser tunnel. Reporting "off" is both honest and
      // the safe direction: the alternative is a switch claiming the browser
      // is protected by something that is not running.
      return BrowserTunnelState.off;
    }
  }

  @override
  Future<BrowserTunnelState> start() => _call('start_browser_only');

  @override
  Future<void> stop() async {
    try {
      await _call('stop_browser_only');
    } on TunnelException {
      // Nothing to stop. Turning a switch off must not fail because the thing
      // being switched off has already gone.
    }
  }

  Future<BrowserTunnelState> _call(String method) async {
    final client = await _connect(_socketPath);
    try {
      return _stateFrom(await client.call(method));
    } finally {
      await client.close();
    }
  }

  BrowserTunnelState _stateFrom(Map<String, dynamic> result) {
    if (result['browserOnly'] != true) return BrowserTunnelState.off;
    return BrowserTunnelState(
      running: true,
      host: result['socksHost'] as String?,
      port: result['socksPort'] as int?,
    );
  }
}
