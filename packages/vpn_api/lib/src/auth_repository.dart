import 'api_client.dart';
import 'models.dart';
import 'session_store.dart';

class AuthRepository {
  AuthRepository({required this.api, required this.store});

  final ApiClient api;
  final SessionStore store;

  Future<AccountUser> register({
    required String email,
    required String password,
  }) => _authenticate('/auth/register', email, password);

  Future<AccountUser> login({
    required String email,
    required String password,
  }) => _authenticate('/auth/login', email, password);

  Future<AccountUser> _authenticate(
    String path,
    String email,
    String password,
  ) async {
    final json = await api.post(
      path,
      body: {'email': email, 'password': password},
      authenticated: false,
    );
    final session = AuthSession.fromJson(json);
    await store.saveSession(
      accessToken: session.tokens.accessToken,
      refreshToken: session.tokens.refreshToken,
      email: session.user.email,
    );
    return session.user;
  }

  Future<AccountUser> currentUser() async {
    final json = await api.get('/auth/me');
    return AccountUser.fromJson(json['user'] as Map<String, dynamic>);
  }

  /// Irreversible erasure. Throws if the password is wrong or the request
  /// fails, so the caller can leave the session intact — the session is only
  /// cleared once the server has confirmed with a 204.
  Future<void> deleteAccount({required String password}) async {
    await api.delete('/auth/account', body: {'password': password});
    await store.clearSession();
  }

  /// Best-effort server-side revoke; the local session is cleared regardless
  /// so a network failure can never trap the user in a signed-in state.
  ///
  /// Only the *session* is cleared here. Wiping the device's WireGuard key is
  /// the tunnel layer's job, and it has to happen before this call while the
  /// access token is still usable.
  Future<void> logout() async {
    final refreshToken = await store.readRefreshToken();
    if (refreshToken != null) {
      try {
        await api.post(
          '/auth/logout',
          body: {'refreshToken': refreshToken},
          authenticated: false,
        );
      } catch (_) {
        // Ignored on purpose.
      }
    }
    await store.clearSession();
  }
}
