import 'package:flutter/foundation.dart';
import 'package:vpn_api/vpn_api.dart';
import 'package:vpn_crypto/vpn_crypto.dart';

import 'device_store.dart';
import 'session_end_reason.dart';

/// Whether this app has a device the server still recognises.
enum EnrollStatus { checking, notEnrolled, enrolled }

/// Enrolment, in place of signing in.
///
/// The whole flow is: a server address, an invite code, and one call. There is
/// no account, so there is nothing to remember a password for and no session
/// to keep alive — a device is either registered or it is not.
///
/// The keypair is generated here and the private half goes straight to the
/// device store. It is never sent, never logged and never leaves this device;
/// the invite only buys the right to register the public half.
class EnrollController extends ChangeNotifier {
  EnrollController({
    required EnrollmentRepository repository,
    required SessionStore session,
    required DeviceStore devices,
  }) : _repository = repository,
       _session = session,
       _devices = devices;

  final EnrollmentRepository _repository;
  final SessionStore _session;
  final DeviceStore _devices;

  /// Invoked when the device stops being recognised, so the tunnel it
  /// authorised can be torn down rather than left running on a dead config.
  Future<void> Function(SessionEndReason reason)? onSessionEnd;

  EnrollStatus _status = EnrollStatus.checking;
  String? _error;
  bool _busy = false;

  EnrollStatus get status => _status;
  String? get error => _error;
  bool get isBusy => _busy;

  void clearError() {
    if (_error == null) return;
    _error = null;
    notifyListeners();
  }

  /// Decides at startup which screen to show.
  ///
  /// A stored token is taken at face value rather than verified against the
  /// server: an offline launch should open the app, not send the user back to
  /// a code they no longer have. A revoked device is discovered on the first
  /// real request, which is what [onSessionEnd] is for.
  Future<void> bootstrap() async {
    final token = await _session.readDeviceToken();
    _status = token == null ? EnrollStatus.notEnrolled : EnrollStatus.enrolled;
    notifyListeners();
  }

  Future<bool> enrol({
    required String inviteToken,
    required String label,
    required String platform,
  }) async {
    _busy = true;
    _error = null;
    notifyListeners();

    try {
      // Generated before the call and stored after it succeeds. Storing first
      // would leave a private key for a device the server rejected; storing
      // never would leave a registered device whose key we lost.
      final keys = await WireGuardKeys.generate();

      final config = await _repository.enrol(
        inviteToken: inviteToken.trim(),
        publicKey: keys.publicKey,
        label: label,
        platform: platform,
      );

      await _devices.saveDevice(
        peerId: config.device.id,
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
      );

      _status = EnrollStatus.enrolled;
      return true;
    } on ApiException catch (error) {
      _error = error.message;
      // A rejected code has to land on a definite answer. Left at [checking],
      // the app decides there is nothing to show yet and the user is looking
      // at a screen with an error on it and no way to try again.
      //
      // Guarded rather than assigned outright: an already-enrolled device that
      // fails to enrol again is still enrolled, and saying otherwise would
      // throw away a working device over one bad request.
      if (_status != EnrollStatus.enrolled) _status = EnrollStatus.notEnrolled;
      return false;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// Removes this device from the server, then forgets it locally.
  Future<bool> removeDevice() async {
    _busy = true;
    _error = null;
    notifyListeners();

    try {
      await _repository.remove();
      await _forget(SessionEndReason.signedOut);
      return true;
    } on ApiException catch (error) {
      _error = error.message;
      return false;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// The server no longer knows this device. Called on a 401.
  Future<void> handleRevoked() => _forget(SessionEndReason.sessionExpired);

  Future<void> _forget(SessionEndReason reason) async {
    // The tunnel first: a device that is no longer registered must not be left
    // with a live tunnel the user believes is still theirs.
    await onSessionEnd?.call(reason);
    await _session.clearSession();
    await _devices.clearDevice();
    _status = EnrollStatus.notEnrolled;
    notifyListeners();
  }
}
