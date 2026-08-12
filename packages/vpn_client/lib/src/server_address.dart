import 'package:flutter/foundation.dart';
import 'package:vpn_api/vpn_api.dart';

import 'secure_store.dart';

/// Thrown when an address cannot be used, with a message meant for the user.
class ServerAddressError implements Exception {
  const ServerAddressError(this.message);
  final String message;

  @override
  String toString() => message;
}

/// The address of the control plane, changeable at runtime.
///
/// A self-hosted deployment moves — a new VPS, a new address — and the answer
/// to that cannot be "rebuild and reinstall every client". The build-time
/// value stays the default; this remembers an override.
///
/// Changing it is deliberately restricted to being signed out. Access tokens
/// are issued by one control plane and the registered device exists in one
/// database, so pointing an existing session at a different server produces a
/// string of failures that each look like something else. The device state is
/// cleared here for the same reason: the stored keypair is registered with the
/// old server and means nothing to the new one.
class VpnServerAddress extends ChangeNotifier {
  VpnServerAddress({
    required SecureStore store,
    required ApiClient api,
    required String buildDefault,
  }) : _store = store,
       _api = api,
       _default = normalise(buildDefault),
       _current = normalise(buildDefault);

  final SecureStore _store;
  final ApiClient _api;
  final String _default;
  String _current;

  /// The address in use.
  String get current => _current;

  /// The address compiled into this build, restored by [reset].
  String get buildDefault => _default;

  bool get isOverridden => _current != _default;

  static String normalise(String value) =>
      value.trim().replaceAll(RegExp(r'/+$'), '');

  /// Reads any stored override and applies it. Call before the first request.
  Future<void> load() async {
    final stored = await _store.readServerUrl();
    if (stored == null || stored.isEmpty) return;
    _current = stored;
    _api.baseUrl = stored;
    notifyListeners();
  }

  /// Validates [value], stores it, and forgets the device registered with the
  /// previous server. Returns without doing anything if nothing changed.
  Future<void> change(String value) async {
    final next = normalise(value);
    validate(next);
    if (next == _current) return;

    await _store.writeServerUrl(next == _default ? null : next);
    // Before the address moves, so a failure here cannot leave the app
    // pointing at a new server while still holding the old one's device.
    await _store.clearDevice();
    await _store.clearSession();

    _current = next;
    _api.baseUrl = next;
    notifyListeners();
  }

  Future<void> reset() => change(_default);

  /// Throws [ServerAddressError] with a message worth showing.
  static void validate(String value) {
    if (value.isEmpty) {
      throw const ServerAddressError('Enter a server address');
    }

    final uri = Uri.tryParse(value);
    if (uri == null || !uri.hasScheme || uri.host.isEmpty) {
      throw const ServerAddressError(
        'Use a full address, like https://vpn.example.com',
      );
    }

    if (uri.scheme == 'https') return;

    // http is rejected rather than warned about: every request carries the
    // password on sign-in and the access token afterwards, and a warning is
    // not what stops those crossing the network in the clear. Loopback is the
    // exception, because a debug build talking to a laptop has no network to
    // cross.
    const loopback = {'localhost', '127.0.0.1', '::1', '10.0.2.2'};
    if (uri.scheme == 'http' && kDebugMode && loopback.contains(uri.host)) {
      return;
    }

    throw const ServerAddressError(
      'The address must start with https:// — http would send your password '
      'in the clear',
    );
  }
}
