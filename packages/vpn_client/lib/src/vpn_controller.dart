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
    required PeerRepository peers,
    required DeviceStore store,
    required Tunnel tunnel,
    required String deviceLabel,
    String devicePlatform = 'unknown',
    Duration keyRotationInterval = const Duration(days: 7),
  }) : _peers = peers,
       _store = store,
       _tunnel = tunnel,
       _deviceLabel = deviceLabel,
       _devicePlatform = devicePlatform,
       _keyRotationInterval = keyRotationInterval;

  final PeerRepository _peers;
  final DeviceStore _store;
  final Tunnel _tunnel;

  /// Supplied by the app, which is the only layer that knows what platform it
  /// is running on. Keeps dart:io out of this package.
  final String _deviceLabel;

  /// Which kind of machine this is, so the device list can tell five entries
  /// apart. Supplied by the app for the same reason as the label.
  final String _devicePlatform;

  /// How old a device key may get before it is replaced on the next connect.
  /// Rotation is what makes a leaked config expire on its own.
  final Duration _keyRotationInterval;

  StreamSubscription<TunnelStage>? _stageSubscription;

  TunnelStage _stage = TunnelStage.disconnected;
  VpnAction _action = VpnAction.idle;
  String? _error;
  Peer? _device;
  bool _initialized = false;

  TunnelStage get stage => _stage;
  VpnAction get action => _action;
  String? get error => _error;
  Peer? get device => _device;

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
      // Reached again when a second account signs in on the same launch; the
      // tunnel is already wired, but the device panel must be repopulated.
      await _loadDevice();
      return;
    }
    _initialized = true;

    try {
      await _tunnel.initialize();
      _stageSubscription = _tunnel.stages.listen((stage) {
        _stage = stage;
        if (stage == TunnelStage.permissionDenied) {
          _error =
              'The system VPN profile was not allowed. Approve the prompt, then try again.';
        }
        notifyListeners();
      });
      _stage = await _tunnel.currentStage();
    } on TunnelException catch (error) {
      _error = error.message;
    }

    await _loadDevice();
    notifyListeners();
  }

  Future<void> _loadDevice() async {
    final peerId = await _store.readPeerId();
    if (peerId == null) return;
    try {
      final matches = (await _peers.list()).where((p) => p.id == peerId);
      _device = matches.isEmpty ? null : matches.first;
      notifyListeners();
    } on ApiException {
      // Offline at launch is fine; connect() will resolve it properly.
    }
  }

  /// Registers this device if needed and returns a config with the private key
  /// filled in.
  ///
  /// The keypair is generated here, on the device. Only the public half is
  /// sent, so the private key exists in exactly one place: this machine's
  /// secure storage.
  Future<({String conf, String endpoint})> _prepareConfig() async {
    final peerId = await _store.readPeerId();
    final privateKey = await _store.readPeerPrivateKey();

    if (peerId != null && privateKey != null) {
      try {
        final config = await _peers.config(peerId);

        // The server's idea of our key must match ours. A mismatch means a
        // rotation was interrupted or storage was restored from a backup —
        // the tunnel would silently never handshake, so re-key instead.
        final storedPublicKey = await _store.readPeerPublicKey();
        final keyIsOrphaned =
            storedPublicKey != null && storedPublicKey != config.peer.publicKey;

        if (keyIsOrphaned || await _keyIsStale()) {
          final rotated = await _rotateKey(peerId);
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

        _device = config.peer;
        return (conf: config.resolveConf(privateKey), endpoint: config.endpoint);
      } on ApiException catch (error) {
        // Revoked from another device, or the account was reset.
        if (error.statusCode != 404) rethrow;
        await _store.clearDevice();
      }
    }

    return _registerDevice();
  }

  Future<({String conf, String endpoint})> _registerDevice() async {
    final pair = await WireGuardKeys.generate();
    final created = await _peers.create(
      deviceLabel: _deviceLabel,
      publicKey: pair.publicKey,
      platform: _devicePlatform,
    );

    // Persist before anything else: the server has no copy to fall back on.
    await _store.saveDevice(
      peerId: created.peer.id,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
    );
    _device = created.peer;

    return (
      conf: created.conf.replaceFirst(
        PeerConfig.privateKeyPlaceholder,
        pair.privateKey,
      ),
      endpoint: created.endpoint,
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
  Future<({String conf, String endpoint})?> _rotateKey(int peerId) async {
    try {
      final pair = await WireGuardKeys.generate();
      final config = await _peers.rotateKey(peerId, publicKey: pair.publicKey);

      await _store.saveDevice(
        peerId: peerId,
        privateKey: pair.privateKey,
        publicKey: pair.publicKey,
      );
      _device = config.peer;

      return (
        conf: config.resolveConf(pair.privateKey),
        endpoint: config.endpoint,
      );
    } on ApiException {
      return null;
    }
  }

  Future<void> connect() async {
    if (isBusy) return;

    _action = VpnAction.preparing;
    _error = null;
    notifyListeners();

    try {
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
      // Nothing running, or the platform refused. Never block sign-out on this.
    }
  }

  Future<void> _revokeCurrentDevice() async {
    final peerId = await _store.readPeerId();
    if (peerId != null) await _peers.revoke(peerId);
    await _store.clearDevice();
    _device = null;
  }

  /// Revokes this device server-side and forgets its key. The next connect
  /// registers a fresh peer.
  Future<void> forgetDevice() async {
    if (isBusy) return;

    _action = VpnAction.preparing;
    _error = null;
    notifyListeners();

    try {
      if (isConnected) await _tunnel.stop();
      await _revokeCurrentDevice();
    } on ApiException catch (error) {
      // A peer the server no longer knows about is already "forgotten".
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
      // Account deleted: the server already dropped every peer, so there is
      // nothing to revoke, but the local key is now unusable.
      await _store.clearDevice();
    }

    _device = null;
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
