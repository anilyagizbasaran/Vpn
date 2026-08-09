import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:wireguard_flutter_plus/wireguard_flutter_plus.dart';

import '../config.dart';
import '../core/api_exception.dart';
import '../core/secure_store.dart';
import '../core/wireguard_keys.dart';
import '../models/models.dart';
import '../services/peer_repository.dart';
import '../services/tunnel_service.dart';

/// What the app is doing on top of the tunnel's own stage — fetching a config
/// is not a VPN stage, but the user still needs to see that something is
/// happening.
enum VpnAction { idle, preparing, connecting, disconnecting }

class VpnController extends ChangeNotifier {
  VpnController({required PeerRepository peers, required SecureStore store, required TunnelService tunnel})
    : _peers = peers,
      _store = store,
      _tunnel = tunnel;

  final PeerRepository _peers;
  final SecureStore _store;
  final TunnelService _tunnel;

  StreamSubscription<VpnStage>? _stageSubscription;

  VpnStage _stage = VpnStage.disconnected;
  VpnAction _action = VpnAction.idle;
  String? _error;
  Peer? _device;
  bool _initialized = false;

  VpnStage get stage => _stage;
  VpnAction get action => _action;
  String? get error => _error;
  Peer? get device => _device;

  bool get isConnected => _stage == VpnStage.connected;
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
      // plugin is already wired, but the device panel must be repopulated.
      await _loadDevice();
      return;
    }
    _initialized = true;

    try {
      await _tunnel.ensureInitialized();
      _stageSubscription = _tunnel.stageStream.listen((stage) {
        _stage = stage;
        if (stage == VpnStage.denied) {
          _error =
              'The system VPN profile was not allowed. Approve the prompt, then try again.';
        }
        notifyListeners();
      });
      _stage = await _tunnel.currentStage();
    } on PlatformException catch (error) {
      _error = 'The VPN engine could not start: ${error.message ?? error.code}';
    } on MissingPluginException {
      _error =
          'VPN support is not available on this platform build. Run on Android or iOS.';
    }

    // Shows the saved device without requiring a connect first.
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
  /// sent, so the private key exists in exactly one place: this phone's secure
  /// storage. Losing it costs the peer; leaking it is the only way it can leak.
  Future<({String conf, String endpoint})> _prepareConfig() async {
    final peerId = await _store.readPeerId();
    final privateKey = await _store.readPeerPrivateKey();

    if (peerId != null && privateKey != null) {
      try {
        var config = await _peers.config(peerId);

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
      deviceLabel: _deviceLabel(),
      publicKey: pair.publicKey,
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
    return DateTime.now().toUtc().difference(createdAt) >=
        AppConfig.keyRotationInterval;
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
    } on PlatformException catch (error) {
      _error = 'The tunnel could not start: ${error.message ?? error.code}';
    } on MissingPluginException {
      _error = 'VPN support is not available in this build.';
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
    } on PlatformException catch (error) {
      _error = 'Could not stop the tunnel: ${error.message ?? error.code}';
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

  /// Tears the tunnel down when the session ends. The tunnel must never
  /// outlive the account that authorised it, and no state from the previous
  /// account may still be on screen when the next one signs in.
  ///
  /// [revokeDevice] is true for a deliberate sign-out: the peer is released on
  /// the server so it stops consuming a device slot, since its private key is
  /// about to be wiped from this phone and can never be recovered. It is false
  /// when the session merely expired — the access token is already dead so the
  /// revoke would fail anyway, and keeping the key lets the same peer be
  /// reused after signing back in.
  Future<void> reset({required bool revokeDevice}) async {
    await _stopQuietly();

    if (revokeDevice) {
      try {
        await _revokeCurrentDevice();
      } catch (_) {
        // Offline or already revoked; sign-out proceeds either way.
      }
    }

    _device = null;
    _error = null;
    _action = VpnAction.idle;
    notifyListeners();
  }

  String _deviceLabel() {
    if (Platform.isAndroid) return 'Android device';
    if (Platform.isIOS) return 'iPhone';
    if (Platform.isMacOS) return 'Mac';
    if (Platform.isWindows) return 'Windows PC';
    if (Platform.isLinux) return 'Linux PC';
    return 'My device';
  }

  @override
  void dispose() {
    _stageSubscription?.cancel();
    super.dispose();
  }
}
