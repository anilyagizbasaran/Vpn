import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:vpn_api/vpn_api.dart';

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

  /// Thrown instead of responding, to simulate a transport failure.
  Object? failWith;

  /// [bodyText] queues a raw body, for the cases where the server does not
  /// answer with JSON at all — a proxy error page, say.
  void enqueue(
    String method,
    String path, {
    int status = 200,
    Map<String, dynamic>? body,
    String? bodyText,
  }) {
    _queued
        .putIfAbsent('$method $path', () => [])
        .add(
          http.Response(
            bodyText ?? (body == null ? '' : jsonEncode(body)),
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

/// The whole point of the [SessionStore] interface: this layer can be tested
/// without a platform channel or a keychain.
class InMemorySessionStore implements SessionStore {
  final Map<String, String> values = {};

  @override
  Future<String?> readDeviceToken() async => values['device'];

  @override
  Future<void> saveDeviceToken(String token) async => values['device'] = token;

  @override
  Future<void> clearSession() async => values.remove('device');
}
