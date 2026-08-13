import 'dart:convert';

import 'package:test/test.dart';
import 'package:vpn_api/vpn_api.dart';

import 'helpers/fakes.dart';

const _base = 'https://vpn.example.com';

Map<String, dynamic> _configJson({String publicKey = 'pub'}) => {
  'device': {
    'id': 1,
    'label': 'My device',
    'platform': 'linux',
    'publicKey': publicKey,
    'createdAt': '2026-01-01T00:00:00.000Z',
    'keyRotatedAt': null,
    'usage': {'rxBytes': 0, 'txBytes': 0},
    'locations': const <dynamic>[],
  },
  'server': {
    'id': 1,
    'region': 'de-fra',
    'publicKey': 'serverkey',
    'endpoint': 'vpn.example.com:51820',
    'dns': '1.1.1.1',
    'allowedIps': '0.0.0.0/0',
    'persistentKeepalive': 25,
    'mtu': 1420,
  },
  'presharedKey': null,
  'privateKey': null,
  'privateKeyIncluded': false,
  'conf': '[Interface]\nPrivateKey = <PRIVATE_KEY>\n',
};

void main() {
  late FakeHttpClient http;
  late InMemorySessionStore store;
  late ApiClient api;
  late EnrollmentRepository enrolment;

  setUp(() {
    http = FakeHttpClient();
    store = InMemorySessionStore();
    api = ApiClient(store: store, httpClient: http, baseUrl: _base);
    enrolment = EnrollmentRepository(api: api, store: store);
  });

  test('enrolment sends the public key and never a private one', () async {
    http.enqueue(
      'POST',
      '/enroll',
      status: 201,
      body: {
        ..._configJson(publicKey: 'mypub'),
        'deviceToken': 'vpndev_abc',
      },
    );

    final config = await enrolment.enrol(
      inviteToken: 'vpninv_x',
      publicKey: 'mypub',
      platform: 'linux',
    );

    final sent = jsonDecode(http.requests.single.body) as Map<String, dynamic>;
    expect(sent['publicKey'], 'mypub');
    expect(sent.containsKey('privateKey'), isFalse);
    expect(config.conf, contains('<PRIVATE_KEY>'));
  });

  test('the device token is stored before the call returns', () async {
    http.enqueue(
      'POST',
      '/enroll',
      status: 201,
      body: {..._configJson(), 'deviceToken': 'vpndev_stored'},
    );

    await enrolment.enrol(inviteToken: 'vpninv_x', publicKey: 'p');

    // A crash after this point still leaves a device this app can authenticate
    // as, rather than one registered on the server and unreachable from here.
    expect(await store.readDeviceToken(), 'vpndev_stored');
  });

  test(
    'a response without a device token is an error, not a silent success',
    () async {
      http.enqueue('POST', '/enroll', status: 201, body: _configJson());

      expect(
        () => enrolment.enrol(inviteToken: 'vpninv_x', publicKey: 'p'),
        throwsA(isA<ApiException>()),
      );
    },
  );

  test('enrolment itself is unauthenticated', () async {
    http.enqueue(
      'POST',
      '/enroll',
      status: 201,
      body: {..._configJson(), 'deviceToken': 'vpndev_abc'},
    );

    await enrolment.enrol(inviteToken: 'vpninv_x', publicKey: 'p');

    // There is nothing to authenticate with yet; sending a stale header would
    // be the difference between "invalid invite" and "signed out".
    expect(http.requests.single.headers.containsKey('authorization'), isFalse);
  });

  test('subsequent calls carry the device token', () async {
    await store.saveDeviceToken('vpndev_live');
    http.enqueue('GET', '/device', body: {'device': _configJson()['device']});

    await enrolment.me();

    expect(http.requests.single.headers['authorization'], 'Bearer vpndev_live');
  });

  test('a 401 on a device token is not retried', () async {
    await store.saveDeviceToken('vpndev_revoked');
    http.enqueue(
      'GET',
      '/device',
      status: 401,
      body: {
        'error': {
          'code': 'unauthorized',
          'message': 'This device is no longer registered.',
        },
      },
    );

    var expired = 0;
    api.onSessionExpired = () => expired++;

    await expectLater(enrolment.me(), throwsA(isA<ApiException>()));

    // One attempt, not two: a device token cannot be refreshed, so retrying
    // would only fail the same way and hide why.
    expect(http.requests, hasLength(1));
    expect(expired, 1);
  });

  test(
    'removing the device clears the token only after the server agrees',
    () async {
      await store.saveDeviceToken('vpndev_live');
      http.enqueue(
        'DELETE',
        '/device',
        status: 500,
        body: {
          'error': {
            'code': 'internal_error',
            'message': 'Something went wrong',
          },
        },
      );

      await expectLater(enrolment.remove(), throwsA(isA<ApiException>()));
      expect(
        await store.readDeviceToken(),
        'vpndev_live',
        reason: 'a failed removal must leave the device able to try again',
      );
    },
  );
}
