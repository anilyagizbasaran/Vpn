import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vpn_api/vpn_api.dart';
import 'package:vpn_client/vpn_client.dart';
import 'package:vpn_crypto/vpn_crypto.dart';
import 'package:vpn_tunnel/vpn_tunnel.dart';

import 'helpers/fakes.dart';

late FakeHttpClient http;
late FakeSecureStorageChannel storage;
late FakeTunnel tunnel;
late SecureStore store;
late ApiClient api;
late EnrollController enrol;
late VpnController vpn;

const base = 'https://api.test';

/// A real 32-byte key, not just something base64-shaped. The previous fixture
/// decoded to 35 bytes, which every string comparison accepted and X25519 threw
/// on the moment a test actually did arithmetic with it.
const privateKey = 'cHJpdmF0ZWtleXByaXZhdGVrZXlwcml2YXRla2V5cHI=';

/// Must match the key inside [peerBody], otherwise the controller decides the
/// stored key is orphaned and re-keys.
const publicKey = 'cHVibGlja2V5cHVibGlja2V5cHVibGlja2V5cHVibDE=';

/// The region list /servers answers with.
const serverList = [
  {
    'id': 1,
    'region': 'de-fra',
    'displayName': 'Frankfurt',
    'endpoint': 'vpn.test:51820',
    'isDefault': true,
    'online': true,
  },
];

Map<String, dynamic> deviceBody({
  int id = 7,
  String? key,
  String peerPublicKey = publicKey,
}) => {
  'device': {
    'id': id,
    'publicKey': peerPublicKey,
    // A device now holds an address per region rather than one address.
    'locations': [
      {
        'serverId': 1,
        'region': 'de-fra',
        'displayName': 'Frankfurt',
        'endpoint': 'vpn.test:51820',
        'allowedIp': '10.8.0.$id/32',
        'online': true,
      },
    ],
  },
  'server': {
    'id': 1,
    'region': 'de-fra',
    'publicKey': 'c2VydmVycHVibGlja2V5c2VydmVycHVibGlja2V5c2VydmU=',
    'endpoint': 'vpn.test:51820',
    'dns': '1.1.1.1',
    'allowedIps': '0.0.0.0/0,::/0',
    'persistentKeepalive': 25,
    'mtu': 1420,
  },
  'presharedKey': null,
  'privateKey': key,
  'conf': key == null
      ? '[Interface]\nPrivateKey = <PRIVATE_KEY>\nAddress = 10.8.0.$id/32\n'
      : '[Interface]\nPrivateKey = $key\nAddress = 10.8.0.$id/32\n',
  'privateKeyIncluded': key != null,
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    http = FakeHttpClient();
    storage = FakeSecureStorageChannel()..install();
    tunnel = FakeTunnel();
    store = SecureStore();
    api = ApiClient(store: store, httpClient: http, baseUrl: base);

    vpn = VpnController(
      devices: DeviceRepository(api: api),
      store: store,
      tunnel: tunnel,
    );
    enrol = EnrollController(
      repository: EnrollmentRepository(api: api, store: store),
      session: store,
      devices: store,
    );
    enrol.onSessionEnd = vpn.endSession;
  });

  tearDown(() async {
    storage.uninstall();
    await tunnel.dispose();
  });

  /// Puts the app in the state it is in after a successful enrolment.
  Future<void> enrolled() => store.saveDeviceToken('vpndev_live');

  Future<void> saveDevice({DateTime? keyCreatedAt, String? pub}) =>
      store.saveDevice(
        peerId: 7,
        privateKey: privateKey,
        publicKey: pub ?? publicKey,
        keyCreatedAt: keyCreatedAt,
      );

  group('EnrollController', () {
    test('starts unenrolled when there is no stored device token', () async {
      await enrol.bootstrap();

      expect(enrol.status, EnrollStatus.notEnrolled);
    });

    test('trusts a stored token without asking the server', () async {
      await enrolled();

      await enrol.bootstrap();

      // Deliberately not verified on launch: offline should open the app, not
      // send someone back to a code they no longer have. A revoked device is
      // discovered on the first real request.
      expect(enrol.status, EnrollStatus.enrolled);
      expect(http.requests, isEmpty);
    });

    test(
      'enrolment generates the keypair here and sends only the public half',
      () async {
        http.enqueue(
          'POST',
          '/enroll',
          status: 201,
          body: {...deviceBody(), 'deviceToken': 'vpndev_new'},
        );

        final ok = await enrol.enrol(inviteToken: 'ABCD123456');

        expect(ok, isTrue);
        expect(enrol.status, EnrollStatus.enrolled);

        final sent = http.requests.single;
        expect(sent.path, '/enroll');
        expect(sent.body, contains('publicKey'));
        expect(sent.body, isNot(contains('privateKey')));

        // The private half is kept, and only here.
        expect(await store.readPeerPrivateKey(), isNotNull);
        expect(await store.readDeviceToken(), 'vpndev_new');
      },
    );

    test(
      'a rejected invite surfaces the server message and stays unenrolled',
      () async {
        http.enqueue(
          'POST',
          '/enroll',
          status: 403,
          body: {
            'error': {
              'code': 'forbidden',
              'message': 'That invite code has been revoked.',
            },
          },
        );

        final ok = await enrol.enrol(inviteToken: 'DEAD123456');

        expect(ok, isFalse);
        expect(enrol.status, EnrollStatus.notEnrolled);
        expect(enrol.error, 'That invite code has been revoked.');
        // Nothing half-written: no key for a device the server refused.
        expect(await store.readPeerPrivateKey(), isNull);
      },
    );

    test('a full invite reports the quota, not a generic failure', () async {
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

      final ok = await enrol.enrol(inviteToken: 'FULL123456');

      expect(ok, isFalse);
      expect(enrol.error, contains('Device limit reached (5).'));
      expect(enrol.status, EnrollStatus.notEnrolled);
      expect(await store.readPeerPrivateKey(), isNull);
    });

    test('clearError removes the banner', () async {
      http.enqueue('POST', '/enroll', status: 401, body: {'error': {}});
      await enrol.enrol(inviteToken: 'x');
      expect(enrol.error, isNotNull);

      enrol.clearError();

      expect(enrol.error, isNull);
    });
  });

  group('removing the device', () {
    test(
      'stops the tunnel, removes it on the server, clears credentials',
      () async {
        await enrolled();
        await saveDevice();
        tunnel.emit(TunnelStage.connected);

        http.enqueue('DELETE', '/device', status: 204);

        await enrol.removeDevice();

        // The tunnel must not outlive the device that authorised it.
        expect(tunnel.stopCalls, greaterThan(0));

        final removal = http.requests.firstWhere((r) => r.path == '/device');
        expect(removal.method, 'DELETE');
        // It has to happen while the device token still works.
        expect(removal.bearer, 'vpndev_live');

        expect(enrol.status, EnrollStatus.notEnrolled);
        expect(await store.readDeviceToken(), isNull);
        expect(await store.readPeerPrivateKey(), isNull);
        expect(await store.readPeerId(), isNull);
      },
    );

    test('does not leave the previous device on screen', () async {
      await enrolled();
      await saveDevice();
      http.enqueue('GET', '/device', body: {'device': deviceBody()['device']});
      http.enqueue('GET', '/servers', body: {'servers': serverList});
      await vpn.initialize();
      expect(vpn.device, isNotNull);

      http.enqueue('DELETE', '/device', status: 204);
      await enrol.removeDevice();

      expect(vpn.device, isNull);
    });

    test('a revoked device stops the tunnel but keeps nothing behind', () async {
      await enrolled();
      await saveDevice();
      tunnel.emit(TunnelStage.connected);

      await enrol.handleRevoked();

      expect(tunnel.stopCalls, greaterThan(0));
      expect(enrol.status, EnrollStatus.notEnrolled);
      expect(await store.readDeviceToken(), isNull);
      // The key belongs to a device the server has forgotten; keeping it would
      // only produce a tunnel that never handshakes.
      expect(await store.readPeerPrivateKey(), isNull);
    });
  });

  group('VpnController.connect', () {
    setUp(() async {
      await store.saveDeviceToken('vpndev_live');
      // Mirrors the app: the stage subscription is wired before any connect.
      http.enqueue('GET', '/servers', body: {'servers': serverList});
      await vpn.initialize();
    });

    test('uses the stored key and never asks the server for one', () async {
      await saveDevice();
      http.enqueue('GET', '/device/config', body: deviceBody());

      await vpn.connect();

      // Connecting is a read: it asks for a config and substitutes the key it
      // already has. Nothing it sends carries the private half.
      expect(http.requests.every((r) => !r.body.contains(privateKey)), isTrue);

      expect(vpn.isConnected, isTrue);
      expect(
        tunnel.startedConfigs.single,
        contains('PrivateKey = $privateKey'),
      );
      expect(tunnel.startedConfigs.single, isNot(contains('<PRIVATE_KEY>')));
      expect(tunnel.startedServers.single, 'vpn.test:51820');
    });

    test('ignores a private key the server volunteers', () async {
      await saveDevice();
      // Older servers still return one; the device already has its own, and a
      // key it did not generate is a key it cannot vouch for.
      final volunteered = base64.encode(List.filled(32, 3));
      http.enqueue(
        'GET',
        '/device/config',
        body: {
          ...deviceBody(),
          'privateKey': volunteered,
          'privateKeyIncluded': true,
        },
      );

      await vpn.connect();

      expect(await store.readPeerPrivateKey(), privateKey);
      expect(
        tunnel.startedConfigs.single,
        contains('PrivateKey = $privateKey'),
      );
      expect(tunnel.startedConfigs.single, isNot(contains(volunteered)));
    });

    test('never registers a device on connect', () async {
      await saveDevice();
      http.enqueue('GET', '/device/config', body: deviceBody());

      await vpn.connect();

      // A device is created exactly once, at enrolment. A second path here
      // would burn a device slot on every connect.
      expect(http.callCount('POST', '/enroll'), 0);
    });

    test(
      'a device the server has forgotten sends the user back to enrolment',
      () async {
        await saveDevice();
        http.enqueue(
          'GET',
          '/device/config',
          status: 404,
          body: {
            'error': {'code': 'not_found', 'message': 'Peer not found'},
          },
        );

        await vpn.connect();

        expect(vpn.isConnected, isFalse);
        expect(vpn.error, contains('set up again'));
        // The dead key is dropped rather than retried forever.
        expect(await store.readPeerId(), isNull);
        expect(tunnel.startedConfigs, isEmpty);
      },
    );

    test('refuses to connect when there is no stored key at all', () async {
      await vpn.connect();

      expect(vpn.isConnected, isFalse);
      expect(vpn.error, contains('invite code'));
      expect(tunnel.startedConfigs, isEmpty);
    });

    test('reports a network failure instead of hanging', () async {
      await saveDevice();
      http.failWith = const SocketException('connection refused');

      await vpn.connect();

      expect(vpn.error, contains('Cannot reach the VPN service'));
      expect(vpn.action, VpnAction.idle);
    });

    test('surfaces a tunnel failure as its own message', () async {
      await saveDevice();
      http.enqueue('GET', '/device/config', body: deviceBody());
      tunnel.startError = const TunnelException(
        'The tunnel could not start: busy',
      );

      await vpn.connect();

      expect(vpn.isConnected, isFalse);
      expect(vpn.error, 'The tunnel could not start: busy');
      // The device survives a failed start; a retry must not need re-enrolling.
      expect(await store.readPeerId(), 7);
    });

    test('ignores a second tap while a connect is in flight', () async {
      await saveDevice();
      http.enqueue('GET', '/device/config', body: deviceBody());

      await Future.wait([vpn.connect(), vpn.connect()]);

      expect(http.callCount('GET', '/device/config'), 1);
      expect(tunnel.startedConfigs, hasLength(1));
    });
  });

  group('key rotation', () {
    setUp(() async {
      await store.saveDeviceToken('vpndev_live');
      http.enqueue('GET', '/servers', body: {'servers': serverList});
      await vpn.initialize();
    });

    test('leaves a fresh key alone', () async {
      await saveDevice(keyCreatedAt: DateTime.now().toUtc());
      http.enqueue('GET', '/device/config', body: deviceBody());

      await vpn.connect();

      expect(http.callCount('POST', '/device/rotate'), 0);
      expect(await store.readPeerPrivateKey(), privateKey);
    });

    test('replaces a key older than the rotation interval', () async {
      await saveDevice(
        keyCreatedAt: DateTime.now().toUtc().subtract(const Duration(days: 8)),
      );
      final rotatedPublicKey = base64.encode(List.filled(32, 9));
      http.enqueue('GET', '/device/config', body: deviceBody());
      http.enqueue(
        'POST',
        '/device/rotate',
        body: deviceBody(peerPublicKey: rotatedPublicKey),
      );

      await vpn.connect();

      final rotate = http.requests.firstWhere(
        (r) => r.path == '/device/rotate',
      );
      final sent = rotate.json['publicKey'] as String;
      expect(WireGuardKeys.isValidKey(sent), isTrue);

      // The new private key replaced the old one and is what the tunnel uses.
      final stored = await store.readPeerPrivateKey();
      expect(stored, isNot(privateKey));
      expect(await store.readPeerPublicKey(), sent);
      expect(tunnel.startedConfigs.single, contains('PrivateKey = $stored'));
      expect(vpn.isConnected, isTrue);
    });

    test('keeps the device id and address across a rotation', () async {
      await saveDevice(
        keyCreatedAt: DateTime.now().toUtc().subtract(const Duration(days: 30)),
      );
      http.enqueue('GET', '/device/config', body: deviceBody());
      http.enqueue('POST', '/device/rotate', body: deviceBody());

      await vpn.connect();

      expect(await store.readPeerId(), 7);
      expect(vpn.device?.locations.first.allowedIp, '10.8.0.7/32');
      // Rotation must not burn a device slot.
      expect(http.callCount('POST', '/enroll'), 0);
    });

    test('connects with the old key when rotation fails', () async {
      await saveDevice(
        keyCreatedAt: DateTime.now().toUtc().subtract(const Duration(days: 8)),
      );
      http.enqueue('GET', '/device/config', body: deviceBody());
      http.enqueue(
        'POST',
        '/device/rotate',
        status: 502,
        body: {
          'error': {
            'code': 'wireguard_error',
            'message': 'Could not install the new key',
          },
        },
      );

      await vpn.connect();

      // A failed rotation must never stand between the user and their VPN.
      expect(vpn.isConnected, isTrue);
      expect(await store.readPeerPrivateKey(), privateKey);
      expect(
        tunnel.startedConfigs.single,
        contains('PrivateKey = $privateKey'),
      );
    });

    test('rotates a device stored before rotation existed', () async {
      // An app upgrade: the key age is effectively unknown.
      await saveDevice(keyCreatedAt: DateTime.utc(2020));
      http.enqueue('GET', '/device/config', body: deviceBody());
      http.enqueue('POST', '/device/rotate', body: deviceBody());

      await vpn.connect();

      expect(http.callCount('POST', '/device/rotate'), 1);
    });

    test('re-keys when the server no longer recognises the stored key', () async {
      // An interrupted rotation, or storage restored from a backup.
      await saveDevice(pub: base64.encode(List.filled(32, 3)));
      http.enqueue('GET', '/device/config', body: deviceBody());
      http.enqueue('POST', '/device/rotate', body: deviceBody());

      await vpn.connect();

      // Without this the tunnel would sit on "connecting" forever with no error.
      expect(http.callCount('POST', '/device/rotate'), 1);
      expect(vpn.isConnected, isTrue);
    });

    test(
      'refuses to start the tunnel with a key the server rejected',
      () async {
        await saveDevice(pub: base64.encode(List.filled(32, 3)));
        http.enqueue('GET', '/device/config', body: deviceBody());
        http.enqueue(
          'POST',
          '/device/rotate',
          status: 502,
          body: {'error': {}},
        );

        await vpn.connect();

        expect(vpn.isConnected, isFalse);
        expect(vpn.error, contains('needs a new VPN key'));
        expect(tunnel.startedConfigs, isEmpty);
      },
    );
  });

  group('VpnController stage handling', () {
    test('mirrors the tunnel stage and labels it', () async {
      http.enqueue('GET', '/servers', body: {'servers': serverList});
      await vpn.initialize();

      tunnel.emit(TunnelStage.connecting);
      await Future<void>.delayed(Duration.zero);
      expect(vpn.statusLabel, describeStage(TunnelStage.connecting));
      expect(vpn.isBusy, isTrue);

      tunnel.emit(TunnelStage.connected);
      await Future<void>.delayed(Duration.zero);
      expect(vpn.isConnected, isTrue);
      expect(vpn.statusLabel, 'Connected');
    });

    test('explains a denied VPN permission', () async {
      http.enqueue('GET', '/servers', body: {'servers': serverList});
      await vpn.initialize();

      tunnel.emit(TunnelStage.permissionDenied);
      await Future<void>.delayed(Duration.zero);

      expect(vpn.error, contains('was not allowed'));
    });

    test('surfaces a tunnel that cannot initialise at all', () async {
      tunnel.initializeError = const TunnelException(
        'VPN support is not available',
      );

      http.enqueue('GET', '/servers', body: {'servers': serverList});
      await vpn.initialize();

      expect(vpn.error, 'VPN support is not available');
    });

    test('disconnect stops the tunnel', () async {
      http.enqueue('GET', '/servers', body: {'servers': serverList});
      await vpn.initialize();
      tunnel.emit(TunnelStage.connected);
      await Future<void>.delayed(Duration.zero);

      await vpn.disconnect();

      expect(tunnel.stopCalls, 1);
      expect(vpn.isConnected, isFalse);
    });

    test('toggle connects when down and disconnects when up', () async {
      await store.saveDeviceToken('vpndev_live');
      await saveDevice();
      http.enqueue('GET', '/device/config', body: deviceBody());
      http.enqueue('GET', '/servers', body: {'servers': serverList});
      await vpn.initialize();

      await vpn.toggle();
      expect(vpn.isConnected, isTrue);

      await vpn.toggle();
      expect(tunnel.stopCalls, 1);
    });
  });

  group('VpnController.forgetDevice', () {
    setUp(() async {
      await store.saveDeviceToken('vpndev_live');
      await saveDevice();
    });

    test('revokes on the server and forgets the key locally', () async {
      http.enqueue('DELETE', '/device', status: 204);

      await vpn.forgetDevice();

      expect(await store.readPeerId(), isNull);
      expect(await store.readPeerPrivateKey(), isNull);
      expect(vpn.device, isNull);
      expect(vpn.error, isNull);
    });

    test('treats an already-missing peer as forgotten', () async {
      http.enqueue('DELETE', '/device', status: 404, body: {'error': {}});

      await vpn.forgetDevice();

      expect(await store.readPeerId(), isNull);
      expect(vpn.error, isNull);
    });

    test('keeps the key and reports the error on a real failure', () async {
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

      await vpn.forgetDevice();

      expect(vpn.error, 'Something went wrong');
      expect(await store.readPeerPrivateKey(), privateKey);
    });
  });
}
