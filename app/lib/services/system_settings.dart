import 'dart:io';

import 'package:flutter/services.dart';

/// Access to OS screens the app cannot replicate.
///
/// The kill switch is the reason this exists. Android enforces "Always-on VPN
/// + Block connections without VPN" in the platform, below every app; an
/// in-app version built on VpnService cannot be leak-free, because only one
/// VpnService can be active at a time and there is always a window between the
/// tunnel stopping and a blocking service starting.
class SystemSettings {
  SystemSettings({MethodChannel? channel, bool? isSupported})
    : _channel = channel ?? const MethodChannel('com.example.vpn_client/system'),
      // Injectable so the bridge is testable on a host VM. Without it every
      // channel test would be skipped off-device, which is how a kill switch
      // shortcut silently rots.
      isSupported = isSupported ?? Platform.isAndroid;

  final MethodChannel _channel;

  /// False where there is no always-on VPN screen to open.
  final bool isSupported;

  /// True when the settings screen actually opened.
  Future<bool> openVpnSettings() async {
    if (!isSupported) return false;
    try {
      return await _channel.invokeMethod<bool>('openVpnSettings') ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// Always-on VPN arrived in Android 7.
  Future<bool> isAlwaysOnSupported() async {
    if (!isSupported) return false;
    try {
      return await _channel.invokeMethod<bool>('isAlwaysOnSupported') ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }
}
