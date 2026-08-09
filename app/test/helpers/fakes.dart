import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:vpn_client/core/secure_store.dart';
import 'package:wireguard_flutter_plus/wireguard_flutter_platform_interface.dart';

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

  /// Thrown instead of responding, to simulate a dead network.
  Object? failWith;

  /// Completes before the response is produced, to control ordering in tests.
  Completer<void>? gate;

  void enqueue(
    String method,
    String path, {
    int status = 200,
    Map<String, dynamic>? body,
  }) {
    _queued.putIfAbsent('$method $path', () => []).add(
      http.Response(
        body == null ? '' : jsonEncode(body),
        status,
        headers: {'content-type': 'application/json'},
      ),
    );
  }

  int callCount(String method, String path) => requests
      .where((r) => r.method == method && r.path == path)
      .length;

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

    if (gate != null) await gate!.future;
    if (failWith != null) throw failWith!;

    final key = '${request.method} ${request.url.path}';
    final queue = _queued[key];
    final response = (queue == null || queue.isEmpty)
        ? http.Response('{"error":{"code":"not_stubbed","message":"$key"}}', 500)
        : queue.removeAt(0);

    return http.StreamedResponse(
      Stream.value(utf8.encode(response.body)),
      response.statusCode,
      headers: response.headers,
    );
  }
}

/// Backs flutter_secure_storage with an in-memory map by intercepting its
/// platform channel, so SecureStore itself is exercised rather than mocked.
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

/// In-memory stand-in for the platform tunnel.
class FakeWireGuard extends WireGuardFlutterInterface {
  final _stages = StreamController<VpnStage>.broadcast();
  final List<String> startedConfigs = [];
  final List<String> startedServers = [];

  VpnStage current = VpnStage.disconnected;
  int stopCalls = 0;
  int initializeCalls = 0;
  bool permissionGranted = true;

  /// Thrown by [startVpn] when set, to exercise the error path.
  Object? startError;

  /// Thrown by [stopVpn] when set.
  Object? stopError;

  @override
  Stream<VpnStage> get vpnStageSnapshot => _stages.stream;

  @override
  Stream<Map<String, dynamic>> get trafficSnapshot => const Stream.empty();

  void emit(VpnStage stage) {
    current = stage;
    _stages.add(stage);
  }

  @override
  Future<void> initialize({
    required String interfaceName,
    String? vpnName,
    String? iosAppGroup,
    String? extensionBundleId,
  }) async {
    initializeCalls += 1;
  }

  @override
  Future<void> startVpn({
    required String serverAddress,
    required String wgQuickConfig,
    required String providerBundleIdentifier,
    List<String>? excludedApps,
    List<String>? includedApps,
  }) async {
    if (startError != null) throw startError!;
    startedConfigs.add(wgQuickConfig);
    startedServers.add(serverAddress);
    emit(VpnStage.connected);
  }

  @override
  Future<void> stopVpn() async {
    stopCalls += 1;
    if (stopError != null) throw stopError!;
    emit(VpnStage.disconnected);
  }

  @override
  Future<void> refreshStage() async {}

  @override
  Future<VpnStage> stage() async => current;

  @override
  Future<bool> checkVpnPermission() async => permissionGranted;

  Future<void> dispose() => _stages.close();
}

/// Convenience: a SecureStore wired to the fake channel.
SecureStore secureStore() => SecureStore();
