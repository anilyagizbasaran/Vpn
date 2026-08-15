import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:vpn_tunnel/vpn_tunnel.dart';

/// One recorded HTTP call, so tests can assert what was actually sent.
class RecordedRequest {
  RecordedRequest(this.method, this.url, this.headers, this.body);

  final String method;
  final String url;
  final Map<String, String> headers;
  final String body;

  String get path => Uri.parse(url).path;
  Map<String, dynamic> get json =>
      body.isEmpty ? {} : jsonDecode(body) as Map<String, dynamic>;
  String? get bearer => headers['authorization']?.replaceFirst('Bearer ', '');
}

/// Queued canned responses keyed by `METHOD /path`, with a recording of every
/// request that went through.
class FakeHttpClient extends http.BaseClient {
  final List<RecordedRequest> requests = [];
  final Map<String, List<http.Response>> _queued = {};

  Object? failWith;

  void enqueue(
    String method,
    String path, {
    int status = 200,
    Map<String, dynamic>? body,
  }) {
    _queued
        .putIfAbsent('$method $path', () => [])
        .add(
          http.Response(
            body == null ? '' : jsonEncode(body),
            status,
            headers: {'content-type': 'application/json'},
          ),
        );
  }

  int callCount(String method, String path) =>
      requests.where((r) => r.method == method && r.path == path).length;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final body = request is http.Request ? request.body : '';
    requests.add(
      RecordedRequest(
        request.method,
        request.url.toString(),
        Map.of(request.headers),
        body,
      ),
    );

    if (failWith != null) throw failWith!;

    final key = '${request.method} ${request.url.path}';
    final queue = _queued[key];
    final response = (queue == null || queue.isEmpty)
        ? http.Response(
            '{"error":{"code":"not_stubbed","message":"$key"}}',
            500,
          )
        : queue.removeAt(0);

    return http.StreamedResponse(
      Stream.value(utf8.encode(response.body)),
      response.statusCode,
      headers: response.headers,
    );
  }
}

/// Backs flutter_secure_storage with an in-memory map by intercepting its
/// platform channel, so the real SecureStore is exercised rather than mocked.
class FakeSecureStorageChannel {
  static const _channel = MethodChannel(
    'plugins.it_nomads.com/flutter_secure_storage',
  );

  final Map<String, String> values = {};

  void install() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, (call) async {
          final args = (call.arguments as Map?)?.cast<String, Object?>() ?? {};
          final key = args['key'] as String?;

          switch (call.method) {
            case 'read':
              return values[key];
            case 'write':
              values[key!] = args['value'] as String;
              return null;
            case 'delete':
              values.remove(key);
              return null;
            case 'deleteAll':
              values.clear();
              return null;
            case 'readAll':
              return Map<String, String>.from(values);
            case 'containsKey':
              return values.containsKey(key);
            default:
              return null;
          }
        });
  }

  void uninstall() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, null);
  }
}

/// In-memory [Tunnel].
///
/// Note what this no longer has to do: implement a plugin's interface. The
/// `vpn_tunnel` contract is small and platform-free, so the fake is too — and
/// the same fake will serve the desktop daemon client unchanged.
class FakeTunnel implements Tunnel {
  final _stages = StreamController<TunnelStage>.broadcast();

  final List<String> startedConfigs = [];
  final List<String> startedServers = [];

  TunnelStage current = TunnelStage.disconnected;
  int stopCalls = 0;
  int initializeCalls = 0;
  bool permissionGranted = true;

  /// Set by a test that wants the tunnel to bring itself up, the way the
  /// desktop daemon does once it holds this machine's identity.
  bool ownIdentity = false;
  int ownIdentityStarts = 0;

  Object? startError;
  Object? stopError;
  Object? initializeError;

  void emit(TunnelStage stage) {
    current = stage;
    _stages.add(stage);
  }

  @override
  Stream<TunnelStage> get stages => _stages.stream;

  @override
  Future<void> initialize() async {
    initializeCalls += 1;
    if (initializeError != null) throw initializeError!;
  }

  @override
  Future<TunnelStage> currentStage() async => current;

  @override
  Future<bool> hasPermission() async => permissionGranted;

  @override
  Future<void> start({
    required String wgQuickConfig,
    required String serverAddress,
  }) async {
    if (startError != null) throw startError!;
    startedConfigs.add(wgQuickConfig);
    startedServers.add(serverAddress);
    emit(TunnelStage.connected);
  }

  @override
  Future<bool> startFromOwnIdentity() async {
    if (!ownIdentity) return false;
    ownIdentityStarts += 1;
    if (startError != null) throw startError!;
    emit(TunnelStage.connected);
    return true;
  }

  @override
  Future<void> stop() async {
    stopCalls += 1;
    if (stopError != null) throw stopError!;
    emit(TunnelStage.disconnected);
  }

  @override
  Future<void> dispose() => _stages.close();
}

/// Stands in for vpnd: something on this machine that already holds, or can
/// obtain, the one identity every client here shares.
class FakeMachine implements MachineEnrolment {
  FakeMachine({this.stored});

  MachineIdentity? stored;

  /// Thrown by [enrol], the way the daemon refuses a bad code.
  Object? enrolError;

  /// Thrown by [identity] — a daemon that is not running at all.
  Object? identityError;

  final List<({String serverAddress, String inviteToken})> enrolments = [];
  int identityCalls = 0;

  @override
  Future<MachineIdentity?> identity() async {
    identityCalls += 1;
    if (identityError != null) throw identityError!;
    return stored;
  }

  int forgetCalls = 0;

  @override
  Future<void> forget() async {
    forgetCalls += 1;
    stored = null;
  }

  @override
  Future<MachineIdentity> enrol({
    required String serverAddress,
    required String inviteToken,
  }) async {
    enrolments.add((serverAddress: serverAddress, inviteToken: inviteToken));
    if (enrolError != null) throw enrolError!;
    return stored = MachineIdentity(
      controlPlane: serverAddress,
      deviceToken: 'vpndev_from_daemon',
    );
  }
}
