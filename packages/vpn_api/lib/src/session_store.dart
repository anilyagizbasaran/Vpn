/// Where the session tokens live.
///
/// An interface rather than a concrete class so this layer stays free of
/// Flutter: the apps back it with `flutter_secure_storage`, the web dashboard
/// with something browser-appropriate, and tests with a map.
///
/// Note what is *not* here: the device's WireGuard private key. That is a
/// tunnel concern, and this layer has no business touching it — clearing a
/// session must never be able to silently destroy a device key.
abstract interface class SessionStore {
  Future<String?> readAccessToken();
  Future<String?> readRefreshToken();

  /// Called after a successful sign-in or registration.
  Future<void> saveSession({
    required String accessToken,
    required String refreshToken,
    required String email,
  });

  /// Called after a refresh rotates the pair, leaving the email alone.
  Future<void> saveTokens({
    required String accessToken,
    required String refreshToken,
  });

  Future<void> clearSession();
}
