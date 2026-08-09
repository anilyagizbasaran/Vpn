import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:vpn_tunnel/vpn_tunnel.dart';

/// Protocol revision this client speaks. Must match vpnd's ProtocolVersion.
const int kProtocolVersion = 1;

/// Stage names as the daemon reports them.
class DaemonStage {
  const DaemonStage._();

  static const disconnected = 'disconnected';
  static const preparing = 'preparing';
  static const connecting = 'connecting';
  static const connected = 'connected';
  static const disconnecting = 'disconnecting';
  static const failed = 'failed';
}

/// One request/response conversation with vpnd over its local socket.
///
/// Newline-delimited JSON in both directions. Responses carry an `id`, events
/// do not — that is the only thing distinguishing them on a single stream, so
/// it is checked explicitly rather than inferred.
class DaemonClient {
  DaemonClient._(this._socket, this._events);

  final Socket _socket;
  final StreamController<Map<String, dynamic>> _events;

  final Map<int, Completer<Map<String, dynamic>>> _pending = {};
  int _nextId = 1;
  bool _closed = false;

  /// Stage events pushed by the daemon after a successful `subscribe`.
  Stream<Map<String, dynamic>> get events => _events.stream;

  /// Completes when the connection drops for any reason.
  final Completer<void> _closedCompleter = Completer<void>();
  Future<void> get closed => _closedCompleter.future;

  static Future<DaemonClient> connect(
    String socketPath, {
    Duration timeout = const Duration(seconds: 5),
  }) async {
    final Socket socket;
    try {
      socket = await Socket.connect(
        InternetAddress(socketPath, type: InternetAddressType.unix),
        0,
      ).timeout(timeout);
    } on Object catch (error) {
      // The overwhelmingly likely cause is that the service is not installed
      // or not running, and that is something the user can act on.
      throw TunnelException(
        'The VPN service is not running. Install it, or start it from your '
        'system services, then try again.',
        cause: error,
      );
    }

    final events = StreamController<Map<String, dynamic>>.broadcast();
    final client = DaemonClient._(socket, events);
    client._listen();
    return client;
  }

  void _listen() {
    _socket
        .cast<List<int>>()
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(
          _onLine,
          onError: (Object error) => _teardown(error),
          onDone: () => _teardown(null),
          cancelOnError: true,
        );
  }

  void _onLine(String line) {
    if (line.trim().isEmpty) return;

    final Map<String, dynamic> frame;
    try {
      frame = jsonDecode(line) as Map<String, dynamic>;
    } on FormatException {
      // A daemon that emits garbage is a daemon we cannot trust to be driving
      // a tunnel correctly; drop the connection rather than guess.
      _teardown(const FormatException('the VPN service sent an unreadable message'));
      return;
    }

    if (frame.containsKey('event')) {
      _events.add(frame);
      return;
    }

    final id = (frame['id'] as num?)?.toInt();
    final completer = id == null ? null : _pending.remove(id);
    completer?.complete(frame);
  }

  void _teardown(Object? error) {
    if (_closed) return;
    _closed = true;

    final failure = TunnelException(
      'The connection to the VPN service was lost.',
      cause: error,
    );
    for (final completer in _pending.values) {
      if (!completer.isCompleted) completer.completeError(failure);
    }
    _pending.clear();

    if (!_events.isClosed) _events.close();
    if (!_closedCompleter.isCompleted) _closedCompleter.complete();
    _socket.destroy();
  }

  /// Sends a request and waits for its reply.
  Future<Map<String, dynamic>> call(
    String method, {
    Map<String, dynamic>? params,
    Duration timeout = const Duration(seconds: 30),
  }) async {
    if (_closed) {
      throw const TunnelException('The connection to the VPN service was lost.');
    }

    final id = _nextId++;
    final completer = Completer<Map<String, dynamic>>();
    _pending[id] = completer;

    final request = <String, dynamic>{
      'id': id,
      'method': method,
      if (params != null) 'params': params,
    };

    try {
      _socket.write('${jsonEncode(request)}\n');
    } on Object catch (error) {
      _pending.remove(id);
      throw TunnelException('The VPN service could not be reached.', cause: error);
    }

    final Map<String, dynamic> response;
    try {
      response = await completer.future.timeout(timeout);
    } on TimeoutException {
      _pending.remove(id);
      throw const TunnelException('The VPN service did not respond in time.');
    }

    if (response['ok'] == true) {
      return (response['result'] as Map<String, dynamic>?) ?? const {};
    }

    final error = response['error'] as Map<String, dynamic>?;
    throw TunnelException(
      error?['message'] as String? ?? 'The VPN service rejected the request.',
      cause: error?['code'],
    );
  }

  Future<void> close() async {
    _teardown(null);
  }
}
