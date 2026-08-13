// Compiled to JavaScript in CI. It exists to fail the build the moment someone
// adds Flutter or dart:io to this layer: neither survives dart2js, and this is
// the only place that would notice. The web dashboard used to serve that
// purpose; it was an account UI and went with the accounts.
//
// Nothing runs it. The compile is the test.
import 'package:vpn_api/vpn_api.dart';

class _NoStore implements SessionStore {
  @override
  Future<String?> readDeviceToken() async => null;
  @override
  Future<void> saveDeviceToken(String token) async {}
  @override
  Future<void> clearSession() async {}
}

void main() {
  final api = ApiClient(store: _NoStore(), baseUrl: 'https://example.invalid');
  DeviceRepository(api: api);
  EnrollmentRepository(api: api, store: _NoStore());
}
