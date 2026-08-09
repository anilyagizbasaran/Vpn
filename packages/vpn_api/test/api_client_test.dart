import 'dart:io';

import 'package:test/test.dart';
import 'package:vpn_api/vpn_api.dart';

import 'helpers/fakes.dart';

/// The refresh-and-replay logic here is the single most dangerous piece of the
/// client: the backend rotates refresh tokens and treats a replay as a leak,
/// revoking the whole session. Getting this wrong logs users out at random.

late FakeHttpClient http;
late InMemorySessionStore store;
late ApiClient api;

const base = 'https://api.test';

Map<String, dynamic> refreshBody({
  String access = 'access-2',
  String refresh = 'refresh-2',
}) => {
  'user': {'id': 1, 'email': 'a@b.co'},
  'tokens': {
    'accessToken': access,
    'refreshToken': refresh,
    'expiresIn': 900,
  },
};

void main() {
  setUp(() async {
    http = FakeHttpClient();
    store = InMemorySessionStore();
    api = ApiClient(store: store, httpClient: http, baseUrl: base);
    await store.saveSession(
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      email: 'a@b.co',
    );
  });

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

    test('flags a failed password confirmation as its own case', () async {
      http.enqueue('DELETE', '/auth/account', status: 403, body: {
        'error': {'code': 'invalid_password', 'message': 'Password is incorrect'},
      });

      await expectLater(
        api.delete('/auth/account', body: {'password': 'nope'}),
        throwsA(
          isA<ApiException>()
              .having((e) => e.isInvalidPassword, 'isInvalidPassword', true)
              .having((e) => e.isSessionExpired, 'isSessionExpired', false),
        ),
      );
      // 403, so no refresh attempt: a typo must not end the session.
      expect(http.callCount('POST', '/auth/refresh'), 0);
    });

    test('treats an empty 200 body as an empty map', () async {
      http.enqueue('GET', '/peers');
      await expectLater(api.get('/peers'), completion(isEmpty));
    });

    test('maps a dead network to a readable message', () async {
      http.failWith = const SocketException('connection refused');

      await expectLater(
        api.get('/peers'),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'network_error')),
      );
    });

    test('maps a TLS handshake failure to a readable message too', () async {
      // An expired or untrusted certificate on the API domain. Without the
      // catch-all this would escape ApiClient and crash the calling future.
      http.failWith = const HandshakeException('certificate verify failed');

      await expectLater(
        api.get('/peers'),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'network_error')),
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
      http.enqueue('POST', '/auth/refresh', body: refreshBody());
      http.enqueue('GET', '/peers', body: {'peers': []});

      final result = await api.get('/peers');

      expect(result['peers'], isEmpty);
      expect(http.callCount('POST', '/auth/refresh'), 1);
      // The replay carries the new token, not the stale one.
      expect(http.requests.last.path, '/peers');
      expect(http.requests.last.bearer, 'access-2');
      // Rotated tokens are persisted for the next launch.
      expect(await store.readAccessToken(), 'access-2');
      expect(await store.readRefreshToken(), 'refresh-2');
    });

    test('sends the stored refresh token, not the access token', () async {
      http.enqueue('GET', '/peers', status: 401, body: {'error': {}});
      http.enqueue('POST', '/auth/refresh', status: 401, body: {'error': {}});

      await api.get('/peers').catchError((_) => <String, dynamic>{});

      final refreshCall = http.requests.firstWhere((r) => r.path == '/auth/refresh');
      expect(refreshCall.json['refreshToken'], 'refresh-1');
      // The refresh endpoint is unauthenticated; a dead bearer must not ride along.
      expect(refreshCall.headers.containsKey('authorization'), isFalse);
    });

    test('does not retry a second time if the replay also 401s', () async {
      http.enqueue('GET', '/peers', status: 401, body: {'error': {}});
      http.enqueue('POST', '/auth/refresh', body: refreshBody());
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
      store.values.remove('refresh');
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
      http.enqueue('POST', '/auth/refresh', body: refreshBody());
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
      Future<void> cycle(String access, String refresh) async {
        http.enqueue('GET', '/peers', status: 401, body: {'error': {}});
        http.enqueue(
          'POST',
          '/auth/refresh',
          body: refreshBody(access: access, refresh: refresh),
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
