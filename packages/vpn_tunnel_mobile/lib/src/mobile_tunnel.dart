import 'dart:async';

import 'package:flutter/services.dart';
import 'package:vpn_tunnel/vpn_tunnel.dart';
import 'package:wireguard_flutter_plus/wireguard_flutter_plus.dart';
import 'package:wireguard_flutter_plus/wireguard_flutter_platform_interface.dart';

/// Translates the plugin's vocabulary into [TunnelStage].
///
/// A plugin that grows a stage we do not know about must not crash the app, so
/// anything unrecognised degrades to [TunnelStage.disconnected] rather than
/// throwing.
TunnelStage stageFromPlugin(VpnStage stage) => switch (stage) {
  VpnStage.connected => TunnelStage.connected,
  VpnStage.connecting => TunnelStage.connecting,
  VpnStage.disconnecting => TunnelStage.disconnecting,
  VpnStage.disconnected => TunnelStage.disconnected,
  VpnStage.waitingConnection => TunnelStage.waitingForServer,
  VpnStage.authenticating => TunnelStage.authenticating,
  VpnStage.reconnect => TunnelStage.reconnecting,
  VpnStage.noConnection => TunnelStage.noConnection,
  VpnStage.preparing => TunnelStage.preparing,
  VpnStage.denied => TunnelStage.permissionDenied,
  VpnStage.exiting => TunnelStage.exiting,
};

class MobileTunnel implements Tunnel {
  MobileTunnel({
    required this.interfaceName,
    required this.vpnName,
    required this.providerBundleIdentifier,
    WireGuardFlutterInterface? plugin,
  }) : _wg = plugin ?? WireGuardFlutter.instance;

  final String interfaceName;
  final String vpnName;

  /// iOS/macOS Network Extension bundle id. Ignored on Android, but the plugin
  /// requires a non-empty value.
  final String providerBundleIdentifier;

  final WireGuardFlutterInterface _wg;
  bool _initialized = false;

  @override
  Stream<TunnelStage> get stages => _wg.vpnStageSnapshot.map(stageFromPlugin);

  @override
  Future<void> initialize() async {
    if (_initialized) return;
    try {
      await _wg.initialize(interfaceName: interfaceName, vpnName: vpnName);
      _initialized = true;
    } on PlatformException catch (error) {
      throw TunnelException(
        'The VPN engine could not start: ${error.message ?? error.code}',
        cause: error,
      );
    } on MissingPluginException catch (error) {
      throw TunnelException(
        'VPN support is not available in this build. Run on Android or iOS.',
        cause: error,
      );
    }
  }

  @override
  Future<TunnelStage> currentStage() async {
    try {
      return stageFromPlugin(await _wg.stage());
    } on PlatformException {
      return TunnelStage.disconnected;
    } on MissingPluginException {
      return TunnelStage.disconnected;
    }
  }

  @override
  Future<bool> hasPermission() async {
    try {
      return await _wg.checkVpnPermission();
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  @override
  Future<void> start({
    required String wgQuickConfig,
    required String serverAddress,
  }) async {
    await initialize();
    try {
      await _wg.startVpn(
        serverAddress: serverAddress,
        wgQuickConfig: wgQuickConfig,
        providerBundleIdentifier: providerBundleIdentifier,
      );
    } on PlatformException catch (error) {
      throw TunnelException(
        'The tunnel could not start: ${error.message ?? error.code}',
        cause: error,
      );
    } on MissingPluginException catch (error) {
      throw TunnelException(
        'VPN support is not available in this build.',
        cause: error,
      );
    }
  }

  /// The app holds this device's key on mobile — there is no daemon to hold
  /// it instead — so there is never a config the tunnel could fetch by itself.
  @override
  Future<bool> startFromOwnIdentity() async => false;

  @override
  Future<void> stop() async {
    try {
      await _wg.stopVpn();
    } on PlatformException catch (error) {
      throw TunnelException(
        'Could not stop the tunnel: ${error.message ?? error.code}',
        cause: error,
      );
    } on MissingPluginException {
      // Nothing was ever started.
    }
  }

  @override
  Future<void> dispose() async {
    // The plugin owns its stream; nothing to release on this side.
  }
}
