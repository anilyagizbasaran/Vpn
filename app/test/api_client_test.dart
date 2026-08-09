import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vpn_client/core/api_client.dart';
import 'package:vpn_client/core/api_exception.dart';
import 'package:vpn_client/core/secure_store.dart';

import 'helpers/fakes.dart';

/// The refresh-and-replay logic here is the single most dangerous piece of the
/// client: the backend rotates refresh tokens and treats a replay as a leak,
/// revoking the whole session. Getting this wrong logs users out at random.

late FakeHttpClient http;
late FakeSecureStorageChannel storage;
late SecureStore store;
late ApiClient api;

const base = 'https://api.test';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    http = FakeHttpClient();
    storage = FakeSecureStorageChannel()..install();
    store = SecureStore();
    api = ApiClient(store: store, httpClient: http, baseUrl: base);
    await store.saveSession(
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      email: 'a@b.co',
    );
  });

  tearDown(() => storage.uninstall());

  group('request building', () {
    test('attaches the bearer token and sends JSON', () async {
      http.enqueue('POST', '/peers', status: 201, body: {'ok': true});

      await api.post('/peers', body: {'deviceLabel': 'Phone'});

      final sent = http.requests.single;
      expect(sent.method, 'POST');
      expect(sent.url, '$base/peers');
      expect(sent.bearer, 'access-1');
      expect(sent.headers['content-type'], 'application/json');
      expect(sent.json['deviceLabel'], 'Phone');
    });

    test('omits the body and content-type on a plain GET', () async {
      http.enqueue('GET', '/peers', body: {'peers': []});

      await api.get('/peers');

      expect(http.requests.single.body, isEmpty);
      expect(http.requests.single.headers.containsKey('content-type'), isFalse);
    });

    test('supports a body on DELETE, which account deletion needs', () async {
      http.enqueue('DELETE', '/auth/account', status: 204);

      await api.delete('/auth/account', body: {'password': 'secret'});

      expect(http.requests.single.json['password'], 'secret');
    });

    test('strips trailing slashes from the base URL', () async {
      final client = ApiClient(
        store: store,
        httpClient: http,
        baseUrl: '$base///',
      );
      http.enqueue('GET', '/peers', body: {'peers': []});

      await client.get('/peers');

      expect(http.requests.single.url, '$base/peers');
    });

    test('fails fast when there is no access token', () async {
      await store.clearSession();

      await expectLater(
        api.get('/peers'),
        throwsA(isA<ApiException>().having((e) => e.statusCode, 'status', 401)),
      );
      expect(http.requests, isEmpty);
    });
  });

  group('error mapping', () {
    test('surfaces the backend error code and message', () async {
      http.enqueue(
        'POST',
        '/peers',
        status: 409,
        body: {
          'error': {
            'code': 'peer_quota_exceeded',
            'message': 'Device limit reached (5).',
            'details': {'limit': 5},
          },
        },
      );

      await expectLater(
        api.post('/peers'),
        throwsA(
          isA<ApiException>()
              .having((e) => e.code, 'code', 'peer_quota_exceeded')
              .having((e) => e.isQuotaExceeded, 'isQuotaExceeded', true)
              .having((e) => e.message, 'message', 'Device limit reached (5).'),
        ),
      );
    });

    test('treats a non-JSON body as a bad response, not a crash', () async {
      http.enqueue('GET', '/peers');
      // An empty 200 body decodes to {} rather than throwing.
      await expectLater(api.get('/peers'), completion(isEmpty));
    });

    test('maps a dead network to a readable message', () async {
      http.failWith = const SocketException('connection refused');

      await expectLater(
        api.get('/peers'),
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'network_error'),
        ),
      );
    });

    test('maps a TLS handshake failure to a readable message too', () async {
      // An expired or untrusted certificate on the API domain. Without this
      // the exception escapes ApiClient and crashes the calling future.
      http.failWith = const HandshakeException('certificate verify failed');

      await expectLater(
        api.get('/peers'),
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'network_error'),
        ),
      );
    });

    test('returns an empty map for 204 instead of failing to parse', () async {
      http.enqueue('DELETE', '/peers/1', status: 204);
      await expectLater(api.delete('/peers/1'), completion(isEmpty));
    });
  });

  group('401 handling', () {
    test('refreshes once and replays the original request', () async {
      http.enqueue('GET', '/peers', status: 401, body: {'error': {'code': 'unauthorized'}});
      http.enqueue(
        'POST',
        '/auth/refresh',
        body: {
          'user': {'id': 1, 'email': 'a@b.co'},
          'tokens': {
            'accessToken': 'access-2',
            'refreshToken': 'refresh-2',
            'expiresIn': 900,
          },
        },
      );
      http.enqueue('GET', '/peers', body: {'peers': []});

      final result = await api.get('/peers');

      expect(result['peers'], isEmpty);
      expect(http.callCount('POST', '/auth/refresh'), 1);
      // The replay carries the new token, not the stale one.
      final replay = http.requests.last;
      expect(replay.path, '/peers');
      expect(replay.bearer, 'access-2');
      // Rotated tokens are persisted for the next launch.
      expect(await store.readAccessToken(), 'access-2');
      expect(await store.readRefreshToken(), 'refresh-2');
    });

    test('sends the stored refresh token, not the access token', () async {
      http.enqueue('GET', '/peers', status: 401, body: {'error': {'code': 'unauthorized'}});
      http.enqueue('POST', '/auth/refresh', status: 401, body: {'error': {}});

      await api.get('/peers').catchError((_) => <String, dynamic>{});

      final refreshCall = http.requests.firstWhere(
        (r) => r.path == '/auth/refresh',
      );
      expect(refreshCall.json['refreshToken'], 'refresh-1');
      // The refresh endpoint is unauthenticated; a dead bearer must not ride along.
      expect(refreshCall.headers.containsKey('authorization'), isFalse);
    });

    test('does not retry a second time if the replay also 401s', () async {
      http.enqueue('GET', '/peers', status: 401, body: {'error': {}});
      http.enqueue(
        'POST',
        '/auth/refresh',
        body: {
          'user': {'id': 1, 'email': 'a@b.co'},
          'tokens': {
            'accessToken': 'access-2',
            'refreshToken': 'refresh-2',
            'expiresIn': 900,
          },
        },
      );
      http.enqueue('GET', '/peers', status: 401, body: {'error': {}});

      await expectLater(api.get('/peers'), throwsA(isA<ApiException>()));

      // Two attempts, one refresh — never an infinite loop.
      expect(http.callCount('GET', '/peers'), 2);
      expect(http.callCount('POST', '/auth/refresh'), 1);
    });

    test('clears the session and signals when the refresh token is rejected', () async {
      var signalled = 0;
      api.onSessionExpired = () => signalled += 1;

      http.enqueue('GET', '/peers', status: 401, body: {'error': {}});
      http.enqueue('POST', '/auth/refresh', status: 401, body: {'error': {}});

      await expectLater(api.get('/peers'), throwsA(isA<ApiException>()));

      expect(signalled, 1);
      expect(await store.readAccessToken(), isNull);
      expect(await store.readRefreshToken(), isNull);
    });

    test('does not attempt a refresh when there is no refresh token', () async {
      await store.saveTokens(accessToken: 'access-1', refreshToken: '');
      await SecureStore().clearSession();
      await store.saveSession(
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        email: 'a@b.co',
      );
      // Remove only the refresh token.
      storage.values.remove('auth.refresh_token');

      http.enqueue('GET', '/peers', status: 401, body: {'error': {}});

      await expectLater(api.get('/peers'), throwsA(isA<ApiException>()));
      expect(http.callCount('POST', '/auth/refresh'), 0);
    });
  });

  group('single-flight refresh', () {
    test('three parallel 401s trigger exactly one refresh', () async {
      for (var i = 0; i < 3; i += 1) {
        http.enqueue('GET', '/peers', status: 401, body: {'error': {}});
      }
      // Only one refresh response is queued on purpose: a second refresh would
      // fall through to the not-stubbed 500 and fail the test.
      http.enqueue(
        'POST',
        '/auth/refresh',
        body: {
          'user': {'id': 1, 'email': 'a@b.co'},
          'tokens': {
            'accessToken': 'access-2',
            'refreshToken': 'refresh-2',
            'expiresIn': 900,
          },
        },
      );
      for (var i = 0; i < 3; i += 1) {
        http.enqueue('GET', '/peers', body: {'peers': []});
      }

      final results = await Future.wait([
        api.get('/peers'),
        api.get('/peers'),
        api.get('/peers'),
      ]);

      expect(results, hasLength(3));
      // The whole point: the backend revokes the session if a rotated refresh
      // token is presented twice.
      expect(http.callCount('POST', '/auth/refresh'), 1);
      expect(http.callCount('GET', '/peers'), 6);
    });

    test('a later request can refresh again after the first flight ends', () async {
      Future<void> cycle(String newAccess, String newRefresh) async {
        http.enqueue('GET', '/peers', status: 401, body: {'error': {}});
        http.enqueue(
          'POST',
          '/auth/refresh',
          body: {
            'user': {'id': 1, 'email': 'a@b.co'},
            'tokens': {
              'accessToken': newAccess,
              'refreshToken': newRefresh,
              'expiresIn': 900,
            },
          },
        );
        http.enqueue('GET', '/peers', body: {'peers': []});
        await api.get('/peers');
      }

      await cycle('access-2', 'refresh-2');
      await cycle('access-3', 'refresh-3');

      expect(http.callCount('POST', '/auth/refresh'), 2);
      expect(await store.readAccessToken(), 'access-3');
    });
  });
}
