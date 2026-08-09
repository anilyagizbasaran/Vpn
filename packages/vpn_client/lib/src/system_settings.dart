import 'package:flutter/services.dart';

/// Access to OS screens the app cannot replicate.
///
/// The kill switch is the reason this exists. Android enforces "Always-on VPN
/// + Block connections without VPN" in the platform, below every app; an
/// in-app version built on VpnService cannot be leak-free, because only one
/// VpnService can be active at a time and there is always a window between the
/// tunnel stopping and a blocking service starting.
class SystemSettings {
  SystemSettings({required this.isSupported, MethodChannel? channel})
    : _channel = channel ?? const MethodChannel(defaultChannelName);

  /// Kept in sync with the name registered in the Android host.
  static const defaultChannelName = 'com.example.vpn_client/system';

  /// Passed in rather than read from `Platform` here, so this layer stays free
  /// of dart:io and every branch is reachable from a host-VM test. An
  /// untestable kill-switch shortcut is exactly the kind that rots silently.
  final bool isSupported;

  final MethodChannel _channel;

  /// True when the settings screen actually opened.
  Future<bool> openVpnSettings() => _invoke('openVpnSettings');

  /// Always-on VPN arrived in Android 7.
  Future<bool> isAlwaysOnSupported() => _invoke('isAlwaysOnSupported');

  Future<bool> _invoke(String method) async {
    if (!isSupported) return false;
    try {
      return await _channel.invokeMethod<bool>(method) ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }
}
