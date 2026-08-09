/// Build-time configuration. Override per environment, e.g.
///
///   flutter run --dart-define=API_BASE_URL=https://api.example.com
class AppConfig {
  const AppConfig._();

  /// `10.0.2.2` is the host machine as seen from the Android emulator.
  /// Use `http://localhost:3000` for the iOS simulator.
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://10.0.2.2:3000',
  );

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
  /// connect. Rotation is what makes a leaked config expire on its own — the
  /// old public key stops routing the moment the new one takes over.
  /// Matches Mullvad's default of 7 days.
  static const Duration keyRotationInterval = Duration(
    days: int.fromEnvironment('KEY_ROTATION_DAYS', defaultValue: 7),
  );
}
