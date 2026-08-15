import 'dart:async';
import 'dart:io';

import 'package:vpn_tunnel/vpn_tunnel.dart';

import 'daemon_client.dart';

/// Where the GUI looks for vpnd. Must match the daemon's DefaultSocketPath.
String defaultSocketPath() {
  if (Platform.isWindows) {
    final programData =
        Platform.environment['ProgramData'] ?? r'C:\ProgramData';
    return '$programData\\vpnd\\vpnd.sock';
  }
  return '/run/vpnd/vpnd.sock';
}

/// Desktop tunnel, driven through the privileged daemon.
///
/// The GUI cannot configure a network interface, so everything here is a
/// request to vpnd. The daemon is the only component that can, and it is
/// deliberately ignorant of the account — this class hands it a finished
/// config and nothing else.
class DesktopTunnel implements Tunnel {
  DesktopTunnel({
    String? socketPath,
    Future<DaemonClient> Function(String path)? connect,
  }) : _socketPath = socketPath ?? defaultSocketPath(),
       _connect = connect ?? DaemonClient.connect;

  final String _socketPath;
  final Future<DaemonClient> Function(String path) _connect;

  final _stages = StreamController<TunnelStage>.broadcast();
  DaemonClient? _client;
  Future<DaemonClient>? _connecting;
  bool _disposed = false;

  @override
  Stream<TunnelStage> get stages => _stages.stream;

  /// Opens the connection, checks the daemon speaks our protocol, and
  /// subscribes to stage changes.
  ///
  /// Connecting is single-flight: `initialize` and a user tapping Connect can
  /// race, and two sockets would mean two subscriptions and duplicated events.
  Future<DaemonClient> _ensureClient() {
    final existing = _client;
    if (existing != null) return Future.value(existing);
    return _connecting ??= _openConnection().whenComplete(() {
      _connecting = null;
    });
  }

  Future<DaemonClient> _openConnection() async {
    final client = await _connect(_socketPath);

    try {
      final version = await client.call('version');
      final protocol = (version['protocol'] as num?)?.toInt();
      if (protocol != kProtocolVersion) {
        await client.close();
        // A half-finished upgrade leaves an old service behind. Driving it
        // anyway is how a "connected" indicator ends up lying.
        throw TunnelException(
          'The VPN service is out of date (protocol $protocol, this app needs '
          '$kProtocolVersion). Reinstall the app to update it.',
        );
      }

      final status = await client.call('subscribe');
      _emitFromStatus(status);
    } on Object {
      await client.close();
      rethrow;
    }

    client.events.listen(_onEvent);
    // A daemon restart or crash must not leave the UI showing "connected".
    unawaited(
      client.closed.then((_) {
        if (_client == client) {
          _client = null;
          _emit(TunnelStage.disconnected);
        }
      }),
    );

    _client = client;
    return client;
  }

  void _onEvent(Map<String, dynamic> event) {
    if (event['event'] != 'stage') return;
    _emit(stageFromDaemon(event['stage'] as String?));
  }

  void _emitFromStatus(Map<String, dynamic> status) =>
      _emit(stageFromDaemon(status['stage'] as String?));

  void _emit(TunnelStage stage) {
    if (_disposed || _stages.isClosed) return;
    _lastStage = stage;
    _stages.add(stage);
  }

  TunnelStage _lastStage = TunnelStage.disconnected;

  @override
  Future<void> initialize() async {
    await _ensureClient();
  }

  @override
  Future<TunnelStage> currentStage() async {
    try {
      final client = await _ensureClient();
      final status = await client.call('status');
      _lastStage = stageFromDaemon(status['stage'] as String?);
    } on TunnelException {
      // Reporting "not connected" is the safe direction when the service
      // cannot be reached: the alternative is claiming protection that is not
      // there. The real error surfaces when the user tries to connect.
      _lastStage = TunnelStage.disconnected;
    }
    return _lastStage;
  }

  /// The daemon is the privileged component; there is no per-user permission
  /// prompt on desktop the way there is on mobile.
  @override
  Future<bool> hasPermission() async {
    try {
      await _ensureClient();
      return true;
    } on TunnelException {
      return false;
    }
  }

  @override
  Future<void> start({
    required String wgQuickConfig,
    required String serverAddress,
  }) async {
    final client = await _ensureClient();
    final status = await client.call(
      'up',
      params: {'config': wgQuickConfig, 'serverAddress': serverAddress},
    );
    _emitFromStatus(status);
  }

  /// Asks the daemon to bring the tunnel up from the identity it holds.
  ///
  /// This is the normal path on desktop. The daemon enrolled this machine and
  /// kept the private key, so it can fetch a fresh config itself — the app
  /// could not build one even if it wanted to. Falls back to false when the
  /// daemon has no identity, which is a machine set up by an older version of
  /// the app that still holds its own key.
  @override
  Future<bool> startFromOwnIdentity() async {
    final client = await _ensureClient();
    try {
      _emitFromStatus(await client.call('reconnect'));
      return true;
    } on TunnelException catch (error) {
      if (error.cause == 'unsupported') return false;
      rethrow;
    }
  }

  @override
  Future<void> stop() async {
    final client = await _ensureClient();
    final status = await client.call('down');
    _emitFromStatus(status);
  }

  @override
  Future<void> dispose() async {
    _disposed = true;
    await _client?.close();
    _client = null;
    if (!_stages.isClosed) await _stages.close();
  }
}

/// Maps the daemon's vocabulary onto the shared contract.
///
/// An unknown stage degrades to [TunnelStage.disconnected] rather than
/// throwing: a newer daemon inventing a stage must not crash an older app, and
/// "off" is the safe thing to claim when we do not understand the answer.
TunnelStage stageFromDaemon(String? stage) => switch (stage) {
  DaemonStage.disconnected => TunnelStage.disconnected,
  DaemonStage.preparing => TunnelStage.preparing,
  DaemonStage.connecting => TunnelStage.connecting,
  DaemonStage.connected => TunnelStage.connected,
  DaemonStage.disconnecting => TunnelStage.disconnecting,
  DaemonStage.failed => TunnelStage.failed,
  _ => TunnelStage.disconnected,
};
