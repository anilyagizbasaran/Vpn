/// Where this device's WireGuard identity lives.
///
/// Kept separate from `SessionStore` because the two have different lifetimes
/// and different consequences: losing a session means signing in again, while
/// losing the private key means the peer can never be used again — the server
/// keeps no copy.
abstract interface class DeviceStore {
  Future<int?> readPeerId();
  Future<String?> readPeerPrivateKey();

  /// The public half is stored too, so the app can tell whether the server
  /// still accepts this key. Without it an interrupted rotation leaves a
  /// device whose key the server has forgotten, and nothing can detect it —
  /// the tunnel just never handshakes.
  Future<String?> readPeerPublicKey();

  Future<DateTime?> readKeyCreatedAt();

  Future<void> saveDevice({
    required int peerId,
    required String privateKey,
    required String publicKey,
    DateTime? keyCreatedAt,
  });

  /// The region the user last chose. Null means the server's default.
  Future<int?> readSelectedServerId();
  Future<void> saveSelectedServerId(int? serverId);

  Future<void> clearDevice();
}
