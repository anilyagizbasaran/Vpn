import 'dart:io';

/// Build-time configuration. Override per environment, e.g.
///
///   flutter run --dart-define=API_BASE_URL=https://api.example.com
///
/// The composition root is the only layer allowed to read `--dart-define`;
/// everything below takes its configuration as constructor arguments so it can
/// be tested without a build flag.
class AppConfig {
  const AppConfig._();

  /// Empty by default, and that is deliberate.
  ///
  /// Everyone who runs this has their own server, so a released build with an
  /// address compiled in would ship pointing at somebody else's. The app asks
  /// on first launch instead.
  ///
  /// Still overridable for development — `--dart-define=API_BASE_URL=
  /// http://10.0.2.2:3000` is the Android emulator's view of the host machine
  /// — and for an organisation packaging this for its own people.
  static const String apiBaseUrl = String.fromEnvironment('API_BASE_URL');

  /// Name of the tunnel interface created on the device.
  static const String interfaceName = 'wg0';

  /// Label shown in the OS VPN settings screen.
  static const String vpnName = 'VPN Client';

  /// iOS/macOS Network Extension bundle id. Ignored on Android, but the
  /// plugin requires a non-empty value.
  static const String providerBundleIdentifier = String.fromEnvironment(
    'IOS_EXTENSION_BUNDLE_ID',
    defaultValue: 'com.example.vpnClient.WGExtension',
  );

  static const Duration requestTimeout = Duration(seconds: 20);

  /// How old a device key may get before the app replaces it on the next
  /// connect. Matches Mullvad's default of 7 days.
  static const Duration keyRotationInterval = Duration(
    days: int.fromEnvironment('KEY_ROTATION_DAYS', defaultValue: 7),
  );

  /// Mobile drives the tunnel in-process, through the OS VPN APIs.
  static bool get hasMobileTunnel => Platform.isAndroid || Platform.isIOS;

  /// Desktop drives it through the privileged vpnd service, because
  /// configuring an interface needs privileges the GUI must not hold.
  static bool get hasDesktopTunnel =>
      Platform.isWindows || Platform.isMacOS || Platform.isLinux;

  /// The system VPN settings shortcut only exists on Android.
  static bool get hasSystemVpnSettings => Platform.isAndroid;

  /// Which platform this build runs on, for the account's device list.
  static String get devicePlatform {
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    if (Platform.isWindows) return 'windows';
    if (Platform.isMacOS) return 'macos';
    if (Platform.isLinux) return 'linux';
    return 'unknown';
  }

  /// Shown as the device name in the account's device list.
  static String get deviceLabel {
    if (Platform.isAndroid) return 'Android device';
    if (Platform.isIOS) return 'iPhone';
    if (Platform.isMacOS) return 'Mac';
    if (Platform.isWindows) return 'Windows PC';
    if (Platform.isLinux) return 'Linux PC';
    return 'My device';
  }
}
