import 'api_client.dart';
import 'api_exception.dart';
import 'models.dart';
import 'session_store.dart';

/// Enrolment: an invite code and a server address, and the device is on.
///
/// This is what replaces registering and signing in. There is no account to
/// create, no password to choose and no session to keep alive — the operator
/// decided who is allowed on when they minted the invite.
///
/// The invite is a credential to *register* a key, never a key itself. The
/// caller generates the pair and passes only the public half, exactly as the
/// account path did, so nothing that could decrypt traffic is ever sent.
class EnrollmentRepository {
  EnrollmentRepository({required this.api, required this.store});

  final ApiClient api;
  final SessionStore store;

  /// Trades an invite for a registered device and the token it will use from
  /// now on.
  ///
  /// The device token is stored before returning, so a caller that crashes
  /// between the response and its own bookkeeping still has a device it can
  /// authenticate as — rather than a device registered on the server that this
  /// app can no longer talk to.
  Future<DeviceConfig> enrol({
    required String inviteToken,
    required String publicKey,
  }) async {
    final json = await api.post(
      '/enroll',
      authenticated: false,
      body: {'inviteToken': inviteToken, 'publicKey': publicKey},
    );

    final token = json['deviceToken'] as String?;
    if (token == null || token.isEmpty) {
      throw const ApiException(
        message: 'The server did not return a device token.',
        code: 'malformed_response',
      );
    }
    await store.saveDeviceToken(token);

    return DeviceConfig.fromJson(json);
  }

  /// This device, as the server sees it.
  Future<Device> me() async {
    final json = await api.get('/device');
    return Device.fromJson(json['device'] as Map<String, dynamic>);
  }

  Future<DeviceConfig> config({int? serverId}) async {
    final query = serverId == null ? '' : '?serverId=$serverId';
    return DeviceConfig.fromJson(await api.get('/device/config$query'));
  }

  Future<DeviceConfig> rotate({required String publicKey}) async {
    return DeviceConfig.fromJson(
      await api.post('/device/rotate', body: {'publicKey': publicKey}),
    );
  }

  /// Removes this device from the server and forgets its token.
  ///
  /// Order matters: the token is cleared only after the server has accepted
  /// the removal, so a failed call leaves the device able to try again instead
  /// of stranded with a registration it can no longer reach.
  Future<void> remove() async {
    await api.delete('/device');
    await store.clearSession();
  }
}
