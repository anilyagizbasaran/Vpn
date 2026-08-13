import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api_exception.dart';
import 'session_store.dart';

/// HTTP client for the control plane.
///
/// Adds the device's bearer token and turns every failure into an
/// [ApiException]. There is no refresh path and no retry: a device token is a
/// lookup, not a claim that ages out, so a 401 means the device was revoked and
/// replaying the request would only fail the same way.
class ApiClient {
  ApiClient({
    required this.store,
    required String baseUrl,
    http.Client? httpClient,
    Duration timeout = const Duration(seconds: 20),
  }) : _http = httpClient ?? http.Client(),
       _baseUrl = baseUrl.replaceAll(RegExp(r'/+$'), ''),
       _timeout = timeout;

  final SessionStore store;
  final http.Client _http;
  String _baseUrl;
  final Duration _timeout;

  /// Where requests go. Settable because a self-hosted deployment can move,
  /// and rebuilding every installed client to follow it is not a reasonable
  /// answer. Changing it is only safe while unenrolled: a device token and the
  /// device it names belong to one control plane, so the caller has to clear
  /// them — see [VpnServerAddress].
  String get baseUrl => _baseUrl;
  set baseUrl(String value) => _baseUrl = value.replaceAll(RegExp(r'/+$'), '');

  /// Invoked when the server no longer recognises this device — the UI must
  /// send the user back to enrolment.
  void Function()? onSessionExpired;

  void dispose() => _http.close();

  Future<Map<String, dynamic>> get(String path, {bool authenticated = true}) =>
      _send('GET', path, authenticated: authenticated);

  Future<Map<String, dynamic>> post(
    String path, {
    Map<String, dynamic>? body,
    bool authenticated = true,
  }) => _send('POST', path, body: body, authenticated: authenticated);

  Future<Map<String, dynamic>> delete(
    String path, {
    Map<String, dynamic>? body,
    bool authenticated = true,
  }) => _send('DELETE', path, body: body, authenticated: authenticated);

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Map<String, dynamic>? body,
    bool authenticated = true,
  }) async {
    final uri = Uri.parse('$_baseUrl$path');
    final headers = <String, String>{
      'accept': 'application/json',
      if (body != null) 'content-type': 'application/json',
    };

    if (authenticated) {
      final token = await store.readDeviceToken();
      if (token == null) {
        throw const ApiException(
          message:
              'This device is not set up yet. Enter your server address '
              'and invite code.',
          code: 'unauthorized',
          statusCode: 401,
        );
      }
      headers['authorization'] = 'Bearer $token';
    }

    final request = http.Request(method, uri)..headers.addAll(headers);
    if (body != null) request.body = jsonEncode(body);

    http.Response response;
    try {
      final streamed = await _http.send(request).timeout(_timeout);
      response = await http.Response.fromStream(streamed);
    } on TimeoutException {
      throw ApiException.timeout();
    } catch (error) {
      // Everything the transport can throw becomes one readable failure:
      // SocketException, HandshakeException (bad TLS certificate),
      // ClientException on the web. Catching by type would need dart:io, which
      // this package cannot import. The try block wraps only the two transport
      // calls, so nothing else can land here.
      throw ApiException.network(error);
    }

    // Nothing to retry: a device token is a lookup, not a claim that can go
    // stale. A 401 means the server no longer knows this device, so the app has
    // to enrol again rather than replay a request that will keep failing the
    // same way.
    if (response.statusCode == 401 && authenticated) onSessionExpired?.call();

    return _decode(response);
  }

  Map<String, dynamic> _decode(http.Response response) {
    if (response.statusCode == 204 || response.body.isEmpty) {
      if (response.statusCode >= 400) {
        throw ApiException(
          message: 'Request failed (${response.statusCode})',
          statusCode: response.statusCode,
        );
      }
      return const {};
    }

    Map<String, dynamic> json;
    try {
      json = jsonDecode(response.body) as Map<String, dynamic>;
    } on FormatException {
      throw ApiException(
        message: 'The VPN service returned an unexpected response.',
        code: 'bad_response',
        statusCode: response.statusCode,
      );
    }

    if (response.statusCode >= 400) {
      final error = json['error'] as Map<String, dynamic>?;
      throw ApiException(
        message:
            error?['message'] as String? ??
            'Request failed (${response.statusCode})',
        code: error?['code'] as String? ?? 'unknown',
        statusCode: response.statusCode,
        details: error?['details'],
      );
    }

    return json;
  }
}
