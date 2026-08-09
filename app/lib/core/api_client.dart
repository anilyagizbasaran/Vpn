import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../config.dart';
import 'api_exception.dart';
import 'secure_store.dart';

/// HTTP client for the control plane.
///
/// Adds the bearer token, and on a 401 refreshes once and replays the request.
/// The refresh is single-flight: the backend rotates refresh tokens and treats
/// a replayed one as a leak, revoking the whole session family. Two parallel
/// refreshes would therefore log the user out, so concurrent callers all wait
/// on the same in-flight refresh.
class ApiClient {
  ApiClient({required this.store, http.Client? httpClient, String? baseUrl})
    : _http = httpClient ?? http.Client(),
      _baseUrl = (baseUrl ?? AppConfig.apiBaseUrl).replaceAll(RegExp(r'/+$'), '');

  final SecureStore store;
  final http.Client _http;
  final String _baseUrl;

  Future<bool>? _refreshInFlight;

  /// Invoked when the refresh token is gone or rejected — the UI must sign out.
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
    bool allowRetry = true,
  }) async {
    final uri = Uri.parse('$_baseUrl$path');
    final headers = <String, String>{
      'accept': 'application/json',
      if (body != null) 'content-type': 'application/json',
    };

    if (authenticated) {
      final token = await store.readAccessToken();
      if (token == null) {
        throw const ApiException(
          message: 'You are signed out. Please sign in again.',
          code: 'unauthorized',
          statusCode: 401,
        );
      }
      headers['authorization'] = 'Bearer $token';
    }

    http.Response response;
    try {
      final request = http.Request(method, uri)..headers.addAll(headers);
      if (body != null) request.body = jsonEncode(body);
      final streamed = await _http
          .send(request)
          .timeout(AppConfig.requestTimeout);
      response = await http.Response.fromStream(streamed);
    } on TimeoutException {
      throw ApiException.timeout();
    } on IOException catch (error) {
      // IOException, not SocketException: it also covers HandshakeException
      // (bad or expired TLS certificate) and HttpException. Those would
      // otherwise escape as raw exceptions and crash the calling future
      // instead of showing the user a message.
      throw ApiException.network(error);
    } on http.ClientException catch (error) {
      throw ApiException.network(error);
    }

    if (response.statusCode == 401 && authenticated && allowRetry) {
      if (await _refreshTokens()) {
        return _send(
          method,
          path,
          body: body,
          authenticated: authenticated,
          allowRetry: false,
        );
      }
      onSessionExpired?.call();
    }

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

  Future<bool> _refreshTokens() {
    return _refreshInFlight ??= _performRefresh().whenComplete(() {
      _refreshInFlight = null;
    });
  }

  Future<bool> _performRefresh() async {
    final refreshToken = await store.readRefreshToken();
    if (refreshToken == null) return false;

    try {
      final json = await _send(
        'POST',
        '/auth/refresh',
        body: {'refreshToken': refreshToken},
        authenticated: false,
      );
      final tokens = json['tokens'] as Map<String, dynamic>;
      await store.saveTokens(
        accessToken: tokens['accessToken'] as String,
        refreshToken: tokens['refreshToken'] as String,
      );
      return true;
    } on ApiException {
      // Expired, revoked, or reused — either way the session is over.
      await store.clearSession();
      return false;
    }
  }
}
