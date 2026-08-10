import 'api_client.dart';
import 'models.dart';

class DeviceRepository {
  DeviceRepository({required this.api});

  final ApiClient api;

  Future<List<Device>> list() async {
    final json = await api.get('/devices');
    final items = json['devices'] as List<dynamic>? ?? const [];
    return items
        .map((item) => Device.fromJson(item as Map<String, dynamic>))
        .toList(growable: false);
  }

  /// The regions this account can connect through.
  Future<List<VpnServer>> servers() async {
    final json = await api.get('/servers');
    final items = json['servers'] as List<dynamic>? ?? const [];
    return items
        .map((item) => VpnServer.fromJson(item as Map<String, dynamic>))
        .toList(growable: false);
  }

  /// Registers a device. It receives an address on every server at once, so
  /// switching region later needs no further registration.
  ///
  /// [publicKey] is the public half of a keypair generated on the device, so
  /// the server never sees the private one. Omitting it makes the server
  /// generate the pair and return the private key once — only useful for
  /// clients that cannot do Curve25519.
  Future<DeviceConfig> create({
    required String label,
    String? publicKey,
    String? platform,
  }) async {
    // `?value` drops the entry entirely when null.
    final json = await api.post('/devices', body: {
      'label': label,
      'publicKey': ?publicKey,
      'platform': ?platform,
    });
    return DeviceConfig.fromJson(json);
  }

  /// Fetches the config for one region. Omitting [serverId] gives the default.
  Future<DeviceConfig> config(int deviceId, {int? serverId}) async {
    final query = serverId == null ? '' : '?serverId=$serverId';
    final json = await api.get('/devices/$deviceId/config$query');
    return DeviceConfig.fromJson(json);
  }

  /// Replaces the device's key, keeping its identity and every address it
  /// holds. Nodes pick the change up on their next sync.
  Future<DeviceConfig> rotateKey(int deviceId, {required String publicKey}) async {
    final json = await api.post(
      '/devices/$deviceId/rotate',
      body: {'publicKey': publicKey},
    );
    return DeviceConfig.fromJson(json);
  }

  Future<void> revoke(int deviceId) => api.delete('/devices/$deviceId');
}
