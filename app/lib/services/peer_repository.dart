import '../core/api_client.dart';
import '../models/models.dart';

class PeerRepository {
  PeerRepository({required this.api});

  final ApiClient api;

  Future<List<Peer>> list() async {
    final json = await api.get('/peers');
    final items = json['peers'] as List<dynamic>? ?? const [];
    return items
        .map((item) => Peer.fromJson(item as Map<String, dynamic>))
        .toList(growable: false);
  }

  /// Registers a new device.
  ///
  /// [publicKey] is the public half of a keypair generated on this device, so
  /// the server never sees the private one. Omitting it makes the server
  /// generate the pair and return the private key once — only useful for
  /// clients that cannot do Curve25519.
  Future<PeerConfig> create({
    required String deviceLabel,
    String? publicKey,
  }) async {
    // `?publicKey` drops the entry entirely when null, so the server falls
    // back to generating the keypair itself.
    final json = await api.post('/peers', body: {
      'deviceLabel': deviceLabel,
      'publicKey': ?publicKey,
    });
    return PeerConfig.fromJson(json);
  }

  /// Replaces the device's key, keeping its id and tunnel address. The old
  /// public key stops routing as soon as this returns.
  Future<PeerConfig> rotateKey(int peerId, {required String publicKey}) async {
    final json = await api.post(
      '/peers/$peerId/rotate',
      body: {'publicKey': publicKey},
    );
    return PeerConfig.fromJson(json);
  }

  Future<PeerConfig> config(int peerId) async {
    final json = await api.get('/peers/$peerId/config');
    return PeerConfig.fromJson(json);
  }

  Future<void> revoke(int peerId) => api.delete('/peers/$peerId');
}
