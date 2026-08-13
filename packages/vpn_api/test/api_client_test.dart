import 'dart:io';

import 'package:test/test.dart';
import 'package:vpn_api/vpn_api.dart';

import 'helpers/fakes.dart';

/// The client carries one credential and never renews it. What used to be the
/// most dangerous code here — refresh-and-replay, with a rotated token the
/// backend revoked on reuse — no longer exists, and these tests are what keeps
/// it from coming back.

late FakeHttpClient http;
late InMemorySessionStore store;
late ApiClient api;

const base = 'https://api.test';

void main() {
  setUp(() async {
    http = FakeHttpClient();
    store = InMemorySessionStore();
    api = ApiClient(store: store, httpClient: http, baseUrl: base);
    await store.saveDeviceToken('vpndev_live');
  });

  group('request building', () {
    test('attaches the device token and sends JSON', () async {
      http.enqueue('POST', '/device/rotate', body: {'ok': true});

      await api.post('/device/rotate', body: {'publicKey': 'k'});

      final sent = http.requests.single;
      expect(sent.method, 'POST');
      expect(sent.url, '$base/device/rotate');
      expect(sent.bearer, 'vpndev_live');
      expect(sent.headers['content-type'], 'application/json');
      expect(sent.json['publicKey'], 'k');
    });

    test('omits the body and content-type on a plain GET', () async {
      http.enqueue('GET', '/device', body: {'device': null});

      await api.get('/device');

      expect(http.requests.single.body, isEmpty);
      expect(http.requests.single.headers.containsKey('content-type'), isFalse);
    });

    test('strips trailing slashes from the base URL', () async {
      final client = ApiClient(
        store: store,
        httpClient: http,
        baseUrl: '$base///',
      );
      http.enqueue('GET', '/device', body: {'device': null});

      await client.get('/device');

      expect(http.requests.single.url, '$base/device');
    });

    test('sends nothing at all when the device is not enrolled', () async {
      await store.clearSession();

      await expectLater(
        api.get('/device'),
        throwsA(
          isA<ApiException>()
              .having((e) => e.statusCode, 'status', 401)
              .having((e) => e.message, 'message', contains('invite code')),
        ),
      );
      expect(http.requests, isEmpty);
    });

    test('leaves an unauthenticated call unauthenticated', () async {
      // Enrolment is the one call made before there is a credential to send.
      http.enqueue('POST', '/enroll', status: 201, body: {'ok': true});

      await api.post(
        '/enroll',
        body: {'inviteToken': 'x'},
        authenticated: false,
      );

      expect(
        http.requests.single.headers.containsKey('authorization'),
        isFalse,
      );
    });
  });

  group('error mapping', () {
    test('surfaces the backend error code and message', () async {
      http.enqueue(
        'POST',
        '/enroll',
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
        api.post('/enroll', authenticated: false),
        throwsA(
          isA<ApiException>()
              .having((e) => e.code, 'code', 'peer_quota_exceeded')
              .having((e) => e.isQuotaExceeded, 'isQuotaExceeded', true)
              .having((e) => e.message, 'message', 'Device limit reached (5).'),
        ),
      );
    });

    test('treats an empty 200 body as an empty map', () async {
      http.enqueue('GET', '/device');
      await expectLater(api.get('/device'), completion(isEmpty));
    });

    test('maps a dead network to a readable message', () async {
      http.failWith = const SocketException('connection refused');

      await expectLater(
        api.get('/device'),
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'network_error'),
        ),
      );
    });

    test('maps a TLS handshake failure to a readable message too', () async {
      // An expired or untrusted certificate on the API domain. Without the
      // catch-all this would escape ApiClient and crash the calling future.
      http.failWith = const HandshakeException('certificate verify failed');

      await expectLater(
        api.get('/device'),
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'network_error'),
        ),
      );
    });

    test('returns an empty map for 204 instead of failing to parse', () async {
      http.enqueue('DELETE', '/device', status: 204);
      await expectLater(api.delete('/device'), completion(isEmpty));
    });

    test('does not leak a stack trace out of an unparseable body', () async {
      http.enqueue(
        'GET',
        '/device',
        status: 500,
        bodyText: '<html>oops</html>',
      );

      await expectLater(
        api.get('/device'),
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'bad_response'),
        ),
      );
    });
  });

  group('401 handling', () {
    test('signals once and does not retry', () async {
      var signalled = 0;
      api.onSessionExpired = () => signalled += 1;

      http.enqueue('GET', '/device', status: 401, body: {'error': {}});

      await expectLater(api.get('/device'), throwsA(isA<ApiException>()));

      // One attempt. A device token is a lookup, not a claim that ages out, so
      // a replay would fail identically — and a retry loop would hide the fact
      // that the device has to enrol again.
      expect(signalled, 1);
      expect(http.callCount('GET', '/device'), 1);
    });

    test('never calls a refresh endpoint, because there is none', () async {
      http.enqueue('GET', '/device', status: 401, body: {'error': {}});

      await api.get('/device').catchError((_) => <String, dynamic>{});

      expect(http.requests.every((r) => !r.path.contains('refresh')), isTrue);
      expect(http.requests, hasLength(1));
    });

    test('keeps the token so the user is not silently wiped', () async {
      api.onSessionExpired = () {};
      http.enqueue('GET', '/device', status: 401, body: {'error': {}});

      await expectLater(api.get('/device'), throwsA(isA<ApiException>()));

      // Clearing is the controller's decision, made once, in one place.
      expect(await store.readDeviceToken(), 'vpndev_live');
    });

    test('leaves a 403 alone: it is not a dead device', () async {
      var signalled = 0;
      api.onSessionExpired = () => signalled += 1;

      http.enqueue(
        'DELETE',
        '/device',
        status: 403,
        body: {
          'error': {'code': 'forbidden', 'message': 'Not allowed'},
        },
      );

      await expectLater(
        api.delete('/device'),
        throwsA(
          isA<ApiException>().having(
            (e) => e.isSessionExpired,
            'expired',
            false,
          ),
        ),
      );
      expect(signalled, 0);
    });
  });
}
