import 'package:wireguard_flutter_plus/wireguard_flutter_plus.dart';
// The barrel only re-exports `VpnStage`; the interface type used for
// dependency injection lives in the platform-interface library.
import 'package:wireguard_flutter_plus/wireguard_flutter_platform_interface.dart';

import '../config.dart';

/// Thin wrapper over the platform tunnel so the controller never touches the
/// plugin singleton directly (and can be faked in tests).
class TunnelService {
  TunnelService({WireGuardFlutterInterface? plugin})
    : _wg = plugin ?? WireGuardFlutter.instance;

  final WireGuardFlutterInterface _wg;
  bool _initialized = false;

  Stream<VpnStage> get stageStream => _wg.vpnStageSnapshot;

  /// Creating the interface is idempotent but not free; do it once per launch.
  Future<void> ensureInitialized() async {
    if (_initialized) return;
    await _wg.initialize(
      interfaceName: AppConfig.interfaceName,
      vpnName: AppConfig.vpnName,
    );
    _initialized = true;
  }

  Future<VpnStage> currentStage() => _wg.stage();

  Future<void> refreshStage() => _wg.refreshStage();

  /// True once the user has granted the system VPN profile.
  Future<bool> hasPermission() => _wg.checkVpnPermission();

  Future<void> start({
    required String wgQuickConfig,
    required String serverAddress,
  }) async {
    await ensureInitialized();
    await _wg.startVpn(
      serverAddress: serverAddress,
      wgQuickConfig: wgQuickConfig,
      providerBundleIdentifier: AppConfig.providerBundleIdentifier,
    );
  }

  Future<void> stop() => _wg.stopVpn();
}

/// Human-readable label for a [VpnStage].
String describeStage(VpnStage stage) => switch (stage) {
  VpnStage.connected => 'Connected',
  VpnStage.connecting => 'Connecting…',
  VpnStage.disconnecting => 'Disconnecting…',
  VpnStage.disconnected => 'Not connected',
  VpnStage.waitingConnection => 'Waiting for the server…',
  VpnStage.authenticating => 'Authenticating…',
  VpnStage.reconnect => 'Reconnecting…',
  VpnStage.noConnection => 'No connection',
  VpnStage.preparing => 'Preparing…',
  VpnStage.denied => 'VPN permission denied',
  VpnStage.exiting => 'Shutting down…',
};

bool isBusyStage(VpnStage stage) => switch (stage) {
  VpnStage.connecting ||
  VpnStage.disconnecting ||
  VpnStage.waitingConnection ||
  VpnStage.authenticating ||
  VpnStage.reconnect ||
  VpnStage.preparing ||
  VpnStage.exiting => true,
  _ => false,
};
