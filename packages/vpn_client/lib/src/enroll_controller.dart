import 'package:flutter/foundation.dart';
import 'package:vpn_api/vpn_api.dart';
import 'package:vpn_crypto/vpn_crypto.dart';
import 'package:vpn_tunnel/vpn_tunnel.dart';

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
    MachineEnrolment? machine,
  }) : _repository = repository,
       _session = session,
       _devices = devices,
       _machine = machine;

  final EnrollmentRepository _repository;
  final SessionStore _session;
  final DeviceStore _devices;

  /// Set on platforms where something other than this app owns the machine's
  /// identity — desktop, where the daemon holds the key so the browser
  /// extension can connect without one. Null elsewhere.
  final MachineEnrolment? _machine;

  /// Invoked with the control plane a machine turned out to be enrolled
  /// against, so the app points at the same server its tunnel does.
  Future<void> Function(String address)? onControlPlane;

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
    if (token != null) {
      _status = EnrollStatus.enrolled;
      notifyListeners();
      return;
    }

    // Nothing stored, but this machine may already be set up — the browser
    // extension enrolled it, or an earlier install of this app did. Adopting
    // that is the difference between one device and two.
    _status = await _adoptMachineIdentity()
        ? EnrollStatus.enrolled
        : EnrollStatus.notEnrolled;
    notifyListeners();
  }

  /// Takes over the credential this machine already holds, if it holds one.
  ///
  /// Only the token: the private key stays in the daemon, which is what keeps
  /// the app from being one more place a key can leak from.
  Future<bool> _adoptMachineIdentity() async {
    final machine = _machine;
    if (machine == null) return false;

    try {
      final identity = await machine.identity();
      if (identity == null) return false;

      // The address first. A token issued by one control plane means nothing
      // to another, and pointing the app at the wrong one turns every later
      // call into an unexplained 401.
      await onControlPlane?.call(identity.controlPlane);
      await _session.saveDeviceToken(identity.deviceToken);
      return true;
    } on Object {
      // No daemon, or one too old to answer. The setup screen is the right
      // place to land, and it still works — enrolment falls back to this app.
      return false;
    }
  }

  Future<bool> enrol({
    required String inviteToken,
    String? serverAddress,
  }) async {
    _busy = true;
    _error = null;
    notifyListeners();

    try {
      if (_machine != null) {
        return await _enrolMachine(
          inviteToken: inviteToken.trim(),
          serverAddress: serverAddress,
        );
      }

      // Generated before the call and stored after it succeeds. Storing first
      // would leave a private key for a device the server rejected; storing
      // never would leave a registered device whose key we lost.
      final keys = await WireGuardKeys.generate();

      final config = await _repository.enrol(
        inviteToken: inviteToken.trim(),
        publicKey: keys.publicKey,
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

  /// Hands enrolment to whatever owns this machine's identity.
  ///
  /// No keypair is generated here on purpose. The daemon makes one, sends the
  /// public half and keeps the private half, so this computer is a single
  /// device however the user set it up — through the app, or through the
  /// browser extension, or one after the other.
  Future<bool> _enrolMachine({
    required String inviteToken,
    required String? serverAddress,
  }) async {
    if (serverAddress == null || serverAddress.isEmpty) {
      _error = 'Enter the address of your VPN server.';
      if (_status != EnrollStatus.enrolled) _status = EnrollStatus.notEnrolled;
      return false;
    }

    try {
      final identity = await _machine!.enrol(
        serverAddress: serverAddress,
        inviteToken: inviteToken,
      );
      await onControlPlane?.call(identity.controlPlane);
      await _session.saveDeviceToken(identity.deviceToken);
      _status = EnrollStatus.enrolled;
      return true;
    } on TunnelException catch (error) {
      _error = error.message;
      if (_status != EnrollStatus.enrolled) _status = EnrollStatus.notEnrolled;
      return false;
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

    // And the machine's own copy, where there is one. Clearing only this app
    // would leave the daemon holding a credential the server has deleted,
    // reconnecting the browser extension into a 401 forever.
    try {
      await _machine?.forget();
    } on Object {
      // Best effort. A daemon that cannot be reached must not stop the user
      // from removing a device the server has already been told about.
    }

    await _session.clearSession();
    await _devices.clearDevice();
    _status = EnrollStatus.notEnrolled;
    notifyListeners();
  }
}
