import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:vpn_api/vpn_api.dart';

import 'device_store.dart';

/// Everything sensitive the app holds: JWTs and the WireGuard private key.
///
/// Implements both storage contracts, but they stay separate interfaces so the
/// API layer physically cannot reach the device key — clearing a session must
/// never be able to destroy an identity the server cannot reissue.
class SecureStore implements SessionStore, DeviceStore {
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

  // --- SessionStore ---------------------------------------------------------

  @override
  Future<String?> readAccessToken() => _storage.read(key: _accessToken);

  @override
  Future<String?> readRefreshToken() => _storage.read(key: _refreshToken);

  Future<String?> readEmail() => _storage.read(key: _email);

  @override
  Future<void> saveSession({
    required String accessToken,
    required String refreshToken,
    required String email,
  }) async {
    await _storage.write(key: _accessToken, value: accessToken);
    await _storage.write(key: _refreshToken, value: refreshToken);
    await _storage.write(key: _email, value: email);
  }

  @override
  Future<void> saveTokens({
    required String accessToken,
    required String refreshToken,
  }) async {
    await _storage.write(key: _accessToken, value: accessToken);
    await _storage.write(key: _refreshToken, value: refreshToken);
  }

  @override
  Future<void> clearSession() async {
    await _storage.delete(key: _accessToken);
    await _storage.delete(key: _refreshToken);
    await _storage.delete(key: _email);
  }

  // --- DeviceStore ----------------------------------------------------------

  @override
  Future<int?> readPeerId() async {
    final raw = await _storage.read(key: _peerId);
    return raw == null ? null : int.tryParse(raw);
  }

  @override
  Future<String?> readPeerPrivateKey() => _storage.read(key: _peerPrivateKey);

  @override
  Future<String?> readPeerPublicKey() => _storage.read(key: _peerPublicKey);

  @override
  Future<DateTime?> readKeyCreatedAt() async {
    final raw = await _storage.read(key: _peerKeyCreatedAt);
    return raw == null ? null : DateTime.tryParse(raw);
  }

  @override
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

  @override
  Future<void> clearDevice() async {
    await _storage.delete(key: _peerId);
    await _storage.delete(key: _peerPrivateKey);
    await _storage.delete(key: _peerPublicKey);
    await _storage.delete(key: _peerKeyCreatedAt);
  }
}
