import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:vpn_api/vpn_api.dart';

import 'device_store.dart';

/// Everything sensitive the app holds: the device credential and the WireGuard
/// private key.
///
/// Implements both storage contracts, but they stay separate interfaces so the
/// API layer physically cannot reach the device key — clearing the credential
/// must never be able to destroy an identity the server cannot reissue.
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

  /// Written by the account-based versions of this app. Never read any more,
  /// only deleted: an upgrade must not leave a signed-in session's tokens
  /// sitting in the keychain forever.
  static const _legacyAccountKeys = [
    'auth.access_token',
    'auth.refresh_token',
    'auth.email',
  ];

  static const _peerId = 'peer.id';
  static const _peerPrivateKey = 'peer.private_key';
  static const _peerPublicKey = 'peer.public_key';
  static const _peerKeyCreatedAt = 'peer.key_created_at';
  static const _selectedServer = 'peer.selected_server';
  static const _serverUrl = 'server.base_url';
  static const _deviceToken = 'device.token';

  // --- SessionStore ---------------------------------------------------------

  /// The credential an enrolled device authenticates with. It does not expire,
  /// so there is no refresh counterpart — a 401 means the device was revoked.
  @override
  Future<String?> readDeviceToken() => _storage.read(key: _deviceToken);

  @override
  Future<void> saveDeviceToken(String token) =>
      _storage.write(key: _deviceToken, value: token);

  @override
  Future<void> clearSession() async {
    await _storage.delete(key: _deviceToken);
    for (final key in _legacyAccountKeys) {
      await _storage.delete(key: key);
    }
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
  Future<int?> readSelectedServerId() async {
    final raw = await _storage.read(key: _selectedServer);
    return raw == null ? null : int.tryParse(raw);
  }

  @override
  Future<void> saveSelectedServerId(int? serverId) async {
    if (serverId == null) {
      await _storage.delete(key: _selectedServer);
      return;
    }
    await _storage.write(key: _selectedServer, value: serverId.toString());
  }

  @override
  Future<void> clearDevice() async {
    await _storage.delete(key: _selectedServer);
    await _storage.delete(key: _peerId);
    await _storage.delete(key: _peerPrivateKey);
    await _storage.delete(key: _peerPublicKey);
    await _storage.delete(key: _peerKeyCreatedAt);
  }

  /// The control plane address, when it differs from the one compiled in.
  /// Not a secret, but it lives here so there is one store to clear and one
  /// dependency to mock.
  Future<String?> readServerUrl() => _storage.read(key: _serverUrl);

  Future<void> writeServerUrl(String? url) async {
    if (url == null) {
      await _storage.delete(key: _serverUrl);
      return;
    }
    await _storage.write(key: _serverUrl, value: url);
  }
}
