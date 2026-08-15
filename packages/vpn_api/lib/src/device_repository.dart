import 'api_client.dart';
import 'models.dart';

class DeviceRepository {
  DeviceRepository({required this.api});

  final ApiClient api;

  /// This device. A list of one, because a device token authenticates exactly
  /// one device and there is no way to name another.
  Future<List<Device>> list() async {
    final json = await api.get('/device');
    final device = json['device'];
    if (device == null) return const [];
    return [Device.fromJson(device as Map<String, dynamic>)];
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
  // There is no create() any more. A device comes into existence exactly once,
  // at enrolment, which is EnrollmentRepository's job — leaving a second way to
  // register one would mean two paths that must agree about quotas, tokens and
  // key ownership forever.

  /// Fetches the config for one region. Omitting [serverId] gives the default.
  Future<DeviceConfig> config(int deviceId, {int? serverId}) async {
    final query = serverId == null ? '' : '?serverId=$serverId';
    final json = await api.get('/device/config$query');
    return DeviceConfig.fromJson(json);
  }

  /// Replaces the device's key, keeping its identity and every address it
  /// holds. Nodes pick the change up on their next sync.
  Future<DeviceConfig> rotateKey(
    int deviceId, {
    required String publicKey,
  }) async {
    final json = await api.post(
      '/device/rotate',
      body: {'publicKey': publicKey},
    );
    return DeviceConfig.fromJson(json);
  }

  Future<void> revoke(int deviceId) => api.delete('/device');

  /// The address the internet currently sees for this device, answered by the
  /// user's own server rather than by a third-party "what is my IP" service —
  /// which would hand the real address to a stranger every time the app opens.
  Future<PublicAddress> whereAmI() async {
    return PublicAddress.fromJson(await api.get('/whoami'));
  }
}
