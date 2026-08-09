import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vpn_client/services/system_settings.dart';

/// The kill switch is a shortcut into an OS screen, so the only thing that can
/// break is the bridge. A silent failure here would leave the user believing
/// they enabled protection they never enabled.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.example.vpn_client/system');
  final calls = <MethodCall>[];

  void mock(Object? Function(MethodCall) handler) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return handler(call);
        });
  }

  SystemSettings supported() =>
      SystemSettings(channel: channel, isSupported: true);

  setUp(calls.clear);

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('defaults to Android-only support', () {
    expect(SystemSettings().isSupported, Platform.isAndroid);
  });

  test('short-circuits without touching the channel when unsupported', () async {
    mock((_) => true);
    final settings = SystemSettings(channel: channel, isSupported: false);

    await expectLater(settings.openVpnSettings(), completion(isFalse));
    await expectLater(settings.isAlwaysOnSupported(), completion(isFalse));
    expect(calls, isEmpty);
  });

  test('passes through a successful open', () async {
    mock((_) => true);

    await expectLater(supported().openVpnSettings(), completion(isTrue));
    expect(calls.single.method, 'openVpnSettings');
  });

  test('reports false when no settings activity exists', () async {
    // Some OEM builds have no VPN settings screen; the UI then falls back to
    // written instructions rather than a button that does nothing.
    mock((_) => false);

    await expectLater(supported().openVpnSettings(), completion(isFalse));
  });

  test('treats a platform error as "could not open"', () async {
    mock((_) => throw PlatformException(code: 'boom'));

    await expectLater(supported().openVpnSettings(), completion(isFalse));
  });

  test('treats a missing implementation as "could not open"', () async {
    mock((_) => throw MissingPluginException());

    await expectLater(supported().openVpnSettings(), completion(isFalse));
  });

  test('treats a null reply as "could not open"', () async {
    mock((_) => null);

    await expectLater(supported().openVpnSettings(), completion(isFalse));
  });

  test('queries always-on support separately', () async {
    mock((call) => call.method == 'isAlwaysOnSupported');

    await expectLater(supported().isAlwaysOnSupported(), completion(isTrue));
    expect(calls.single.method, 'isAlwaysOnSupported');
  });
}
