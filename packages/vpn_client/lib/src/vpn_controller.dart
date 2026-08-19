import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:vpn_api/vpn_api.dart';
import 'package:vpn_crypto/vpn_crypto.dart';
import 'package:vpn_tunnel/vpn_tunnel.dart';

import 'device_store.dart';
import 'session_end_reason.dart';

/// What the app is doing on top of the tunnel's own stage — fetching a config
/// is not a tunnel stage, but the user still needs to see that something is
/// happening.
enum VpnAction { idle, preparing, connecting, disconnecting }

class VpnController extends ChangeNotifier {
  VpnController({
    required DeviceRepository devices,
    required DeviceStore store,
    required Tunnel tunnel,
    Duration keyRotationInterval = const Duration(days: 7),
    // Scales the waits above. Tests set it to zero; nothing else changes it.
    double settleScale = 1,
  }) : _devices = devices,
       _store = store,
       _tunnel = tunnel,
       _keyRotationInterval = keyRotationInterval,
       _settleScale = settleScale;

  final DeviceRepository _devices;
  final DeviceStore _store;
  final Tunnel _tunnel;

  /// How old a device key may get before it is replaced on the next connect.
  /// Rotation is what makes a leaked config expire on its own.
  final Duration _keyRotationInterval;

  final double _settleScale;

  StreamSubscription<TunnelStage>? _stageSubscription;

  TunnelStage _stage = TunnelStage.disconnected;
  PublicAddress? _publicAddress;
  bool _checkingAddress = false;

  /// Set when the tunnel changed state while a lookup was already running, so
  /// the answer that is on its way is known to be about the old state.
  bool _refreshAgain = false;

  /// How many times the answer has been rejected as "too early" since the last
  /// settled one.
  int _settleAttempt = 0;

  /// Spaced out rather than a single long wait: the routes are usually there
  /// within a few hundred milliseconds, and the later tries only exist for a
  /// machine that is slower than that.
  static const _settleDelays = [
    Duration(milliseconds: 400),
    Duration(milliseconds: 900),
    Duration(seconds: 2),
  ];

  VpnAction _action = VpnAction.idle;
  String? _error;
  Device? _device;
  List<VpnServer> _servers = const [];
  int? _selectedServerId;
  bool _initialized = false;

  TunnelStage get stage => _stage;

  /// What the internet sees for this device, or null until it has been asked.
  ///
  /// Refreshed whenever the tunnel comes up or goes down, because that is
  /// exactly when the answer changes and exactly when somebody looks.
  PublicAddress? get publicAddress => _publicAddress;
  bool get checkingAddress => _checkingAddress;
  VpnAction get action => _action;
  String? get error => _error;
  Device? get device => _device;

  /// Regions the account can connect through. Empty until [initialize].
  List<VpnServer> get servers => _servers;

  /// The region the next connect will use. Null means "whatever the server
  /// considers default", which is what a client that has never chosen wants.
  int? get selectedServerId => _selectedServerId;

  VpnServer? get selectedServer {
    final id = _selectedServerId;
    final matches = _servers.where(
      (server) => id == null ? server.isDefault : server.id == id,
    );
    if (matches.isNotEmpty) return matches.first;
    return _servers.isEmpty ? null : _servers.first;
  }

  /// Where this device appears to be, as the line beside the address.
  ///
  /// It changes meaning with the tunnel, and that is the point: connected it
  /// is the node the traffic came out of, disconnected it is the country the
  /// user is actually in. Read together with the address above it, the pair
  /// says either "you are covered, and here is where you look like you are" or
  /// "you are not, and here is where you really are".
  ///
  /// Both answers come from the server, which sees the address the request
  /// arrived from and resolves it locally. Nothing is asked of anyone else.
  String? get regionLabel {
    // Whatever the server says, tunnelled or not. Connected it names the node
    // the traffic came out of; disconnected it names the country the request
    // came from, which is the user's own — and that is the pairing that makes
    // the line worth reading. Showing the node's region while disconnected
    // would claim protection that is not there.
    final region = _publicAddress?.region;
    if (region != null && region.isNotEmpty) return region;

    // Nothing heard back yet, or no location database on the server. Falling
    // back to the picked region is only honest while connected: otherwise it
    // would name a place the traffic is not going through.
    if (isConnected) return selectedServer?.displayName;
    return null;
  }

  bool get isConnected => _stage == TunnelStage.connected;
  bool get isBusy => _action != VpnAction.idle || isBusyStage(_stage);

  String get statusLabel => switch (_action) {
    VpnAction.preparing => 'Preparing your device…',
    VpnAction.connecting => 'Connecting…',
    VpnAction.disconnecting => 'Disconnecting…',
    VpnAction.idle => describeStage(_stage),
  };

  void clearError() {
    if (_error == null) return;
    _error = null;
    notifyListeners();
  }

  Future<void> initialize() async {
    if (_initialized) {
      // Reached again when a second account signs in on the same launch.
      await _loadAccount();
      return;
    }
    _initialized = true;

    try {
      await _tunnel.initialize();
      _stageSubscription = _tunnel.stages.listen((stage) {
        final was = _stage;
        _stage = stage;
        if (stage == TunnelStage.permissionDenied) {
          _error =
              'The system VPN profile was not allowed. Approve the prompt, then try again.';
        }
        notifyListeners();

        // Settled states only. Asking mid-handshake would answer about the
        // route that is on its way out and then look wrong for a few seconds.
        if (stage != was &&
            (stage == TunnelStage.connected ||
                stage == TunnelStage.disconnected)) {
          unawaited(refreshPublicAddress());
        }
      });
      _stage = await _tunnel.currentStage();
    } on TunnelException catch (error) {
      _error = error.message;
    }

    await _loadAccount();
    notifyListeners();
    unawaited(refreshPublicAddress());
  }

  /// Asks the server what address it sees. Failure is silent by design: this
  /// is a line of information, and a VPN that pops an error because it could
  /// not display one would be worse than one that shows nothing.
  Future<void> refreshPublicAddress() async {
    // A refresh that arrives mid-flight is remembered, not dropped. The
    // launch refresh is often still waiting when the user presses Connect, and
    // returning here left the pre-connect answer on screen for the whole
    // session: the address and region kept saying where the user was before
    // they connected, which is the one moment the line must not be stale.
    if (_checkingAddress) {
      _refreshAgain = true;
      return;
    }
    _checkingAddress = true;
    notifyListeners();

    try {
      _publicAddress = await _devices.whereAmI();
    } on ApiException {
      _publicAddress = null;
    } finally {
      _checkingAddress = false;
      notifyListeners();
    }

    // A second chance at the region list. The first attempt runs at launch,
    // which on a machine that was offline then leaves the region blank for the
    // rest of the session — including before the first connect, which is
    // exactly when someone looks at it to see where they are about to come out.
    await _ensureServers();

    if (_refreshAgain) {
      _refreshAgain = false;
      await refreshPublicAddress();
      return;
    }

    // Connected, yet the server saw the request arrive from outside the
    // tunnel. The interface reports "up" before its routes are in place, so a
    // lookup fired the instant a connect completes can still leave by the old
    // path — and the answer is then the address the user had a second ago.
    //
    // Left alone it sticks: nothing else asks again, so the line reads as
    // unprotected for the rest of the session while the tunnel is fine. A few
    // spaced retries cover the gap; after that the answer is taken at face
    // value, because a tunnel that really is not carrying traffic must not be
    // painted as if it were.
    if (isConnected &&
        _publicAddress?.throughTunnel == false &&
        _settleAttempt < _settleDelays.length) {
      final wait = _settleDelays[_settleAttempt];
      _settleAttempt += 1;
      await Future<void>.delayed(wait * _settleScale);
      await refreshPublicAddress();
      return;
    }

    _settleAttempt = 0;
  }

  /// Loads the region list if an earlier attempt came back empty.
  Future<void> _ensureServers() async {
    if (_servers.isNotEmpty) return;
    try {
      _servers = await _devices.servers();
      if (_servers.isNotEmpty) notifyListeners();
    } on ApiException {
      // Still unreachable. The address line beside it already says so.
    }
  }

  Future<void> _loadAccount() async {
    // Restore the region the user chose last time before anything can connect.
    _selectedServerId = await _store.readSelectedServerId();

    try {
      _servers = await _devices.servers();
    } on ApiException {
      // Offline at launch is fine; connect() resolves it properly.
    }

    final deviceId = await _store.readPeerId();
    if (deviceId == null) return;
    try {
      final matches = (await _devices.list()).where((d) => d.id == deviceId);
      _device = matches.isEmpty ? null : matches.first;
    } on ApiException {
      // Same.
    }
    notifyListeners();
  }

  /// Picks the region the next connect uses. Reconnects if already connected,
  /// because a region change that does nothing until the user notices would be
  /// worse than a brief interruption.
  Future<void> selectServer(int? serverId) async {
    if (_selectedServerId == serverId) return;
    _selectedServerId = serverId;
    await _store.saveSelectedServerId(serverId);
    notifyListeners();

    if (isConnected) await connect();
  }

  /// Registers this device if needed and returns a config with the private key
  /// filled in.
  ///
  /// The keypair is generated here, on the device. Only the public half is
  /// sent, so the private key exists in exactly one place: this machine's
  /// secure storage.
  Future<({String conf, String endpoint})> _prepareConfig() async {
    final deviceId = await _store.readPeerId();
    final privateKey = await _store.readPeerPrivateKey();

    if (deviceId != null && privateKey != null) {
      try {
        final config = await _devices.config(
          deviceId,
          serverId: _selectedServerId,
        );

        // The server's idea of our key must match ours. A mismatch means a
        // rotation was interrupted or storage was restored from a backup —
        // the tunnel would silently never handshake, so re-key instead.
        final storedPublicKey = await _store.readPeerPublicKey();
        final keyIsOrphaned =
            storedPublicKey != null &&
            storedPublicKey != config.device.publicKey;

        if (keyIsOrphaned || await _keyIsStale()) {
          final rotated = await _rotateKey(deviceId);
          if (rotated != null) return rotated;
          if (keyIsOrphaned) {
            // Rotation failed and the stored key is known-dead: starting the
            // tunnel with it would just hang on "connecting".
            throw const ApiException(
              message:
                  'This device needs a new VPN key and the server could not issue one. '
                  'Check your connection and try again.',
              code: 'key_out_of_sync',
            );
          }
        }

        _device = config.device;
        return (
          conf: config.resolveConf(privateKey),
          endpoint: config.endpoint,
        );
      } on ApiException catch (error) {
        // Revoked from another device, or the account was reset.
        if (error.statusCode != 404) rethrow;
        await _store.clearDevice();
      }
    }

    // Connecting no longer registers anything. A device comes into existence
    // exactly once, at enrolment, and that already happened — reaching here
    // means the stored key is gone while the device token still works, which
    // no amount of retrying fixes.
    //
    // Registering here as well would mean two paths that have to agree about
    // quotas, tokens and key ownership forever, and one of them silently
    // burning a device slot every time a key went missing.
    throw const ApiException(
      message: 'This device needs to be set up again. Enter your invite code.',
      code: 'not_enrolled',
      statusCode: 401,
    );
  }

  Future<bool> _keyIsStale() async {
    final createdAt = await _store.readKeyCreatedAt();
    // A device from before rotation existed has no timestamp; treat it as due
    // so it picks up a fresh key on the next connect.
    if (createdAt == null) return true;
    return DateTime.now().toUtc().difference(createdAt) >= _keyRotationInterval;
  }

  /// Best effort by design: a rotation failure must never stop the user from
  /// connecting with the key they already have.
  Future<({String conf, String endpoint})?> _rotateKey(int deviceId) async {
    try {
      final pair = await WireGuardKeys.generate();
      final config = await _devices.rotateKey(
        deviceId,
        publicKey: pair.publicKey,
      );

      await _store.saveDevice(
        peerId: deviceId,
        privateKey: pair.privateKey,
        publicKey: pair.publicKey,
      );
      _device = config.device;

      // Rotation answers with the default region; honour the user's choice.
      if (_selectedServerId != null && _selectedServerId != config.serverId) {
        final chosen = await _devices.config(
          deviceId,
          serverId: _selectedServerId,
        );
        return (
          conf: chosen.resolveConf(pair.privateKey),
          endpoint: chosen.endpoint,
        );
      }

      return (
        conf: config.resolveConf(pair.privateKey),
        endpoint: config.endpoint,
      );
    } on ApiException {
      return null;
    }
  }

  Future<void> connect() async {
    if (_action != VpnAction.idle) return;

    _action = VpnAction.preparing;
    _error = null;
    notifyListeners();

    try {
      // Asked first, because on desktop the answer is yes and the app has no
      // private key to build a config with — the daemon enrolled this machine
      // and kept it. Everywhere else this is a cheap false and the old path
      // runs unchanged.
      if (await _tunnel.startFromOwnIdentity()) return;

      final config = await _prepareConfig();

      _action = VpnAction.connecting;
      notifyListeners();

      await _tunnel.start(
        wgQuickConfig: config.conf,
        serverAddress: config.endpoint,
      );
    } on ApiException catch (error) {
      _error = error.isQuotaExceeded
          ? '${error.message} You can remove a device from this screen.'
          : error.message;
    } on TunnelException catch (error) {
      _error = error.message;
    } catch (error) {
      _error = 'Unexpected error while connecting: $error';
    } finally {
      _action = VpnAction.idle;
      notifyListeners();
    }
  }

  Future<void> disconnect() async {
    if (_action != VpnAction.idle) return;

    _action = VpnAction.disconnecting;
    _error = null;
    notifyListeners();

    try {
      await _tunnel.stop();
    } on TunnelException catch (error) {
      _error = error.message;
    } finally {
      _action = VpnAction.idle;
      notifyListeners();
    }
  }

  Future<void> toggle() => isConnected ? disconnect() : connect();

  Future<void> _stopQuietly() async {
    try {
      await _tunnel.stop();
    } catch (_) {
      // Nothing running, or the platform refused. Never block sign-out.
    }
  }

  Future<void> _revokeCurrentDevice() async {
    final deviceId = await _store.readPeerId();
    if (deviceId != null) await _devices.revoke(deviceId);
    await _store.clearDevice();
    _device = null;
  }

  /// Revokes this device server-side and forgets its key. The next connect
  /// registers a fresh device.
  Future<void> forgetDevice() async {
    if (isBusy) return;

    _action = VpnAction.preparing;
    _error = null;
    notifyListeners();

    try {
      if (isConnected) await _tunnel.stop();
      await _revokeCurrentDevice();
    } on ApiException catch (error) {
      // A device the server no longer knows about is already "forgotten".
      if (error.statusCode == 404) {
        await _store.clearDevice();
        _device = null;
      } else {
        _error = error.message;
      }
    } finally {
      _action = VpnAction.idle;
      notifyListeners();
    }
  }

  /// Tears the tunnel down when a session ends. The tunnel must never outlive
  /// the account that authorised it, and no state from the previous account
  /// may still be on screen when the next one signs in.
  Future<void> endSession(SessionEndReason reason) async {
    await _stopQuietly();

    if (reason.revokesPeerOnServer) {
      try {
        await _revokeCurrentDevice();
      } catch (_) {
        // Offline or already revoked; sign-out proceeds either way.
      }
    } else if (reason.wipesStoredDevice) {
      // Account deleted: the server already dropped everything, but the local
      // key is now unusable.
      await _store.clearDevice();
    }

    _device = null;
    _servers = const [];
    _publicAddress = null;
    _selectedServerId = null;
    _error = null;
    _action = VpnAction.idle;
    notifyListeners();
  }

  @override
  void dispose() {
    _stageSubscription?.cancel();
    unawaited(_tunnel.dispose());
    super.dispose();
  }
}
