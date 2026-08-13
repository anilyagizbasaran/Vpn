/// Where the device credential lives.
///
/// An interface rather than a concrete class so this layer stays free of
/// Flutter: the apps back it with `flutter_secure_storage` and tests with a
/// map.
///
/// Note what is *not* here: the device's WireGuard private key. That is a
/// tunnel concern, and this layer has no business touching it — clearing the
/// credential must never be able to silently destroy a device key.
abstract interface class SessionStore {
  /// The credential an enrolled device authenticates with.
  ///
  /// It does not expire and there is nothing to refresh, so a 401 while
  /// holding one means the device was revoked — not that a token aged out.
  /// That is the whole reason there is no refresh machinery here.
  Future<String?> readDeviceToken();
  Future<void> saveDeviceToken(String token);

  /// Forgets the credential. The device key is cleared separately, by whoever
  /// owns it.
  Future<void> clearSession();
}
