import 'package:vpn_tunnel/vpn_tunnel.dart';

import 'daemon_client.dart';
import 'desktop_tunnel.dart';

/// Enrols this computer through vpnd, so the machine is one device.
///
/// The daemon generates the keypair, sends only the public half, and keeps the
/// private one. This class never sees a key — it asks the daemon to enrol and
/// then borrows the device token, which is enough to read this device from the
/// API and no use at all for decrypting traffic.
///
/// A short-lived connection per call, rather than sharing [DesktopTunnel]'s.
/// These calls happen twice a launch at most, and a second socket costs less
/// than a lifetime shared between a long-running event subscription and a
/// setup form.
class DaemonEnrolment implements MachineEnrolment {
  DaemonEnrolment({
    String? socketPath,
    Future<DaemonClient> Function(String path)? connect,
  }) : _socketPath = socketPath ?? defaultSocketPath(),
       _connect = connect ?? DaemonClient.connect;

  final String _socketPath;
  final Future<DaemonClient> Function(String path) _connect;

  @override
  Future<MachineIdentity?> identity() async {
    try {
      return await _withClient((client) async {
        final result = await client.call('identity');
        return _identityFrom(result);
      });
    } on TunnelException {
      // Not set up yet, or no daemon running at all. Both mean "this machine
      // has no identity to adopt", which is a state the app handles by showing
      // the setup screen — not an error worth surfacing.
      return null;
    }
  }

  @override
  Future<MachineIdentity> enrol({
    required String serverAddress,
    required String inviteToken,
  }) async {
    return _withClient((client) async {
      await client.call(
        'enroll',
        params: {'serverAddress': serverAddress, 'inviteToken': inviteToken},
        // Enrolment is two round trips to a server the user just named, one of
        // them bringing an interface up. The default is tuned for local calls.
        timeout: const Duration(seconds: 45),
      );

      // Enrolment answers with a stage, never a credential, so the token is
      // fetched separately. Keeping it that way means the reply the browser
      // extension gets stays free of anything key-shaped.
      final result = await client.call('identity');
      return _identityFrom(result);
    });
  }

  @override
  Future<void> forget() async {
    try {
      await _withClient((client) => client.call('forget'));
    } on TunnelException {
      // No daemon running, so there is nothing holding an identity. Removing a
      // device must not fail because the thing being cleaned up is absent.
    }
  }

  MachineIdentity _identityFrom(Map<String, dynamic> result) {
    final controlPlane = result['controlPlane'] as String?;
    final deviceToken = result['deviceToken'] as String?;
    if (controlPlane == null ||
        controlPlane.isEmpty ||
        deviceToken == null ||
        deviceToken.isEmpty) {
      throw const TunnelException(
        'The VPN service did not return a usable device identity.',
      );
    }
    return MachineIdentity(
      controlPlane: controlPlane,
      deviceToken: deviceToken,
    );
  }

  Future<T> _withClient<T>(Future<T> Function(DaemonClient client) body) async {
    final client = await _connect(_socketPath);
    try {
      return await body(client);
    } finally {
      await client.close();
    }
  }
}
