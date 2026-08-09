import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Everything sensitive the app holds: JWTs and the WireGuard private key.
///
/// The private key is the one secret the server cannot re-issue — it is
/// returned exactly once by `POST /peers` and never stored server-side. If it
/// is lost, the device has to be re-registered.
class SecureStore {
  SecureStore({FlutterSecureStorage? storage})
    : _storage =
          storage ??
          const FlutterSecureStorage(
            aOptions: AndroidOptions(encryptedSharedPreferences: true),
            iOptions: IOSOptions(
              accessibility: KeychainAccessibility.first_unlock_this_device,
            ),
          );

  final FlutterSecureStorage _storage;

  static const _accessToken = 'auth.access_token';
  static const _refreshToken = 'auth.refresh_token';
  static const _email = 'auth.email';
  static const _peerId = 'peer.id';
  static const _peerPrivateKey = 'peer.private_key';
  static const _peerPublicKey = 'peer.public_key';
  static const _peerKeyCreatedAt = 'peer.key_created_at';

  Future<String?> readAccessToken() => _storage.read(key: _accessToken);
  Future<String?> readRefreshToken() => _storage.read(key: _refreshToken);
  Future<String?> readEmail() => _storage.read(key: _email);

  Future<void> saveSession({
    required String accessToken,
    required String refreshToken,
    required String email,
  }) async {
    await _storage.write(key: _accessToken, value: accessToken);
    await _storage.write(key: _refreshToken, value: refreshToken);
    await _storage.write(key: _email, value: email);
  }

  Future<void> saveTokens({
    required String accessToken,
    required String refreshToken,
  }) async {
    await _storage.write(key: _accessToken, value: accessToken);
    await _storage.write(key: _refreshToken, value: refreshToken);
  }

  Future<void> clearSession() async {
    await _storage.delete(key: _accessToken);
    await _storage.delete(key: _refreshToken);
    await _storage.delete(key: _email);
  }

  Future<int?> readPeerId() async {
    final raw = await _storage.read(key: _peerId);
    return raw == null ? null : int.tryParse(raw);
  }

  Future<String?> readPeerPrivateKey() => _storage.read(key: _peerPrivateKey);

  /// The public half is stored alongside the private one so the app can tell
  /// whether the server still accepts this key. Without it, an interrupted
  /// rotation leaves a device whose key the server has forgotten, and nothing
  /// can detect it — the tunnel just never handshakes.
  Future<String?> readPeerPublicKey() => _storage.read(key: _peerPublicKey);

  Future<DateTime?> readKeyCreatedAt() async {
    final raw = await _storage.read(key: _peerKeyCreatedAt);
    return raw == null ? null : DateTime.tryParse(raw);
  }

  Future<void> saveDevice({
    required int peerId,
    required String privateKey,
    required String publicKey,
    DateTime? keyCreatedAt,
  }) async {
    await _storage.write(key: _peerId, value: peerId.toString());
    await _storage.write(key: _peerPrivateKey, value: privateKey);
    await _storage.write(key: _peerPublicKey, value: publicKey);
    await _storage.write(
      key: _peerKeyCreatedAt,
      value: (keyCreatedAt ?? DateTime.now().toUtc()).toIso8601String(),
    );
  }

  Future<void> clearDevice() async {
    await _storage.delete(key: _peerId);
    await _storage.delete(key: _peerPrivateKey);
    await _storage.delete(key: _peerPublicKey);
    await _storage.delete(key: _peerKeyCreatedAt);
  }

  /// Full wipe on sign-out: without the private key the peer is useless, and
  /// leaving it behind would keep a working tunnel credential on the device.
  Future<void> clearAll() async {
    await clearSession();
    await clearDevice();
  }
}
