import 'package:vpn_api/vpn_api.dart';
import 'package:web/web.dart' as web;

/// Browser-side session storage.
///
/// `sessionStorage`, not `localStorage`: the tokens die with the tab. A
/// dashboard is something you open, revoke a lost phone from, and close —
/// there is no reason for it to leave a refresh token on a machine that might
/// be shared, and an XSS against a token that survives restarts is far worse
/// than one against a token that does not.
///
/// The device private key is deliberately absent. A browser cannot run a
/// tunnel, so it has no business holding one — which is why this implements
/// only [SessionStore] and not `DeviceStore`.
class BrowserSessionStore implements SessionStore {
  static const _access = 'vpn.access_token';
  static const _refresh = 'vpn.refresh_token';
  static const _email = 'vpn.email';

  web.Storage get _storage => web.window.sessionStorage;

  @override
  Future<String?> readAccessToken() async => _storage.getItem(_access);

  @override
  Future<String?> readRefreshToken() async => _storage.getItem(_refresh);

  String? get email => _storage.getItem(_email);

  @override
  Future<void> saveSession({
    required String accessToken,
    required String refreshToken,
    required String email,
  }) async {
    _storage.setItem(_access, accessToken);
    _storage.setItem(_refresh, refreshToken);
    _storage.setItem(_email, email);
  }

  @override
  Future<void> saveTokens({
    required String accessToken,
    required String refreshToken,
  }) async {
    _storage.setItem(_access, accessToken);
    _storage.setItem(_refresh, refreshToken);
  }

  @override
  Future<void> clearSession() async {
    _storage.removeItem(_access);
    _storage.removeItem(_refresh);
    _storage.removeItem(_email);
  }
}
