import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:vpn_api/vpn_api.dart';

import 'session_end_reason.dart';

enum AuthStatus { checking, signedOut, signedIn }

class AuthController extends ChangeNotifier {
  AuthController({
    required AuthRepository repository,
    required SessionStore store,
    required ApiClient api,
  }) : _repository = repository,
       _store = store {
    // A refresh token that is expired, revoked, or replayed ends the session
    // from deep inside the HTTP layer; surface that as a sign-out.
    api.onSessionExpired = () {
      if (_status == AuthStatus.signedIn) {
        _status = AuthStatus.signedOut;
        _user = null;
        _error = 'Your session expired. Please sign in again.';
        unawaited(_endSession(SessionEndReason.sessionExpired));
        notifyListeners();
      }
    };
  }

  final AuthRepository _repository;
  final SessionStore _store;

  /// Set by the composition root so the tunnel layer can tear itself down.
  /// The reason decides what gets cleaned up — see [SessionEndReason].
  Future<void> Function(SessionEndReason reason)? onSessionEnd;

  AuthStatus _status = AuthStatus.checking;
  AccountUser? _user;
  String? _error;
  bool _busy = false;

  AuthStatus get status => _status;
  AccountUser? get user => _user;
  String? get error => _error;
  bool get isBusy => _busy;

  Future<void> _endSession(SessionEndReason reason) async =>
      onSessionEnd?.call(reason);

  void clearError() {
    if (_error == null) return;
    _error = null;
    notifyListeners();
  }

  /// Restores a session at launch. A stored token is not trusted blindly —
  /// `/auth/me` confirms the account still exists and is not disabled.
  Future<void> bootstrap() async {
    if (await _store.readAccessToken() == null) {
      _status = AuthStatus.signedOut;
      notifyListeners();
      return;
    }

    try {
      _user = await _repository.currentUser();
      _status = AuthStatus.signedIn;
    } on ApiException catch (error) {
      if (!error.isSessionExpired) _error = error.message;
      await _store.clearSession();
      _status = AuthStatus.signedOut;
    }
    notifyListeners();
  }

  Future<bool> login({required String email, required String password}) =>
      _run(() => _repository.login(email: email, password: password));

  Future<bool> register({required String email, required String password}) =>
      _run(() => _repository.register(email: email, password: password));

  Future<bool> _run(Future<AccountUser> Function() action) async {
    _busy = true;
    _error = null;
    notifyListeners();

    try {
      _user = await action();
      _status = AuthStatus.signedIn;
      return true;
    } on ApiException catch (error) {
      _error = error.message;
      // Never leave the gate on `checking` — that renders a spinner with no
      // way out. A rejected sign-in means signed out, not "still deciding".
      _status = AuthStatus.signedOut;
      return false;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// Deletes the account for good. Returns false and leaves the session alone
  /// when the server rejects it — a wrong password must not sign the user out.
  Future<bool> deleteAccount({required String password}) async {
    _busy = true;
    _error = null;
    notifyListeners();

    try {
      await _repository.deleteAccount(password: password);
      await _endSession(SessionEndReason.accountDeleted);
      _user = null;
      _status = AuthStatus.signedOut;
      return true;
    } on ApiException catch (error) {
      _error = error.message;
      return false;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  Future<void> logout() async {
    _busy = true;
    notifyListeners();

    // Must run first: releasing the peer needs the access token that
    // `_repository.logout()` is about to delete.
    await _endSession(SessionEndReason.signedOut);
    await _repository.logout();

    _user = null;
    _error = null;
    _status = AuthStatus.signedOut;
    _busy = false;
    notifyListeners();
  }
}
