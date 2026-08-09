import '../core/api_client.dart';
import '../core/secure_store.dart';
import '../models/models.dart';

class AuthRepository {
  AuthRepository({required this.api, required this.store});

  final ApiClient api;
  final SecureStore store;

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

  /// Irreversible erasure. The password is re-confirmed server-side, so a
  /// failure here (wrong password, network) must leave the session intact —
  /// hence no local clearing until the server returns 204.
  Future<void> deleteAccount({required String password}) async {
    await api.delete('/auth/account', body: {'password': password});
    await store.clearAll();
  }

  /// Best-effort server-side revoke; local state is cleared regardless so a
  /// network failure can never trap the user in a signed-in state.
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
    await store.clearAll();
  }
}
