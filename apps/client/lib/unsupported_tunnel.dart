import 'dart:async';

import 'package:vpn_tunnel/vpn_tunnel.dart';

/// Stands in on platforms that have no tunnel implementation yet.
///
/// Desktop targets build and run — you can sign in, see your devices and read
/// the kill-switch guidance — but connecting needs the privileged daemon,
/// which is the next phase. Failing here with a sentence the user can act on
/// beats a MissingPluginException from three layers down.
class UnsupportedTunnel implements Tunnel {
  UnsupportedTunnel(this.platformName);

  final String platformName;
  final _stages = StreamController<TunnelStage>.broadcast();

  static const _message =
      'Connecting is not available in this build yet. The desktop tunnel needs '
      'the background service, which is not installed.';

  @override
  Stream<TunnelStage> get stages => _stages.stream;

  @override
  Future<void> initialize() async {}

  @override
  Future<TunnelStage> currentStage() async => TunnelStage.disconnected;

  @override
  Future<bool> hasPermission() async => false;

  @override
  Future<void> start({
    required String wgQuickConfig,
    required String serverAddress,
  }) async {
    throw const TunnelException(_message);
  }

  @override
  Future<void> stop() async {}

  @override
  Future<void> dispose() => _stages.close();
}
