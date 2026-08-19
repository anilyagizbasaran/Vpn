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
      // The retry spacing is real time in production and pointless here.
      settleScale: 0,
    );
    enrol = EnrollController(
      repository: EnrollmentRepository(api: api, store: store),
      session: store,
      devices: store,
    );
    enrol.onSessionEnd = vpn.endSession;
  });

  /// Lets the fire-and-forget work started by initialize() finish.
  ///
  /// The address lookup is deliberately not awaited in production — the first
  /// frame must not wait on a network call. That leaves a request in flight
  /// when a test ends, and tearDown then pulls the storage channel out from
  /// under it, which surfaces as MissingPluginException blamed on whichever
  /// test happened to be running next.
  Future<void> settle() async {
    for (var i = 0; i < 12; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  tearDown(() async {
    // Before the channel goes: see settle().
    await settle();
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

  group('a machine that enrols on the app\'s behalf', () {
    // Desktop. The daemon holds the key so the browser extension can connect
    // without one, which means the app must not enrol a second time: same
    // computer, two rows on the server, and an invite code typed twice.
    late FakeMachine machine;
    late EnrollController shared;

    setUp(() {
      machine = FakeMachine();
      shared = EnrollController(
        repository: EnrollmentRepository(api: api, store: store),
        session: store,
        devices: store,
        machine: machine,
      );
    });

    test('adopts an identity this machine already holds', () async {
      machine.stored = const MachineIdentity(
        controlPlane: base,
        deviceToken: 'vpndev_from_extension',
      );

      await shared.bootstrap();

      expect(shared.status, EnrollStatus.enrolled);
      expect(await store.readDeviceToken(), 'vpndev_from_extension');
    });

    test('adopts the server that issued the identity', () async {
      final adopted = <String>[];
      shared.onControlPlane = (address) async => adopted.add(address);
      machine.stored = const MachineIdentity(
        controlPlane: 'https://elsewhere.example.com',
        deviceToken: 'vpndev_from_extension',
      );

      await shared.bootstrap();

      // A token issued by one control plane means nothing to another. Getting
      // this backwards produces a 401 on every call and no clue why.
      expect(adopted, ['https://elsewhere.example.com']);
    });

    test('shows the setup screen when the machine has no identity', () async {
      await shared.bootstrap();

      expect(shared.status, EnrollStatus.notEnrolled);
      expect(await store.readDeviceToken(), isNull);
    });

    test('shows the setup screen when the daemon cannot be reached', () async {
      machine.identityError = const TunnelException('no daemon');

      await shared.bootstrap();

      expect(shared.status, EnrollStatus.notEnrolled);
    });

    test('enrols through the machine rather than registering a key', () async {
      final ok = await shared.enrol(
        inviteToken: '  ABCD234567  ',
        serverAddress: base,
      );

      expect(ok, isTrue);
      expect(shared.status, EnrollStatus.enrolled);
      expect(machine.enrolments.single.serverAddress, base);
      expect(machine.enrolments.single.inviteToken, 'ABCD234567');
      expect(await store.readDeviceToken(), 'vpndev_from_daemon');

      // The point of the whole arrangement: no second device on the server,
      // and no key in this process at all.
      expect(http.callCount('POST', '/enroll'), 0);
      expect(await store.readPeerPrivateKey(), isNull);
    });

    test('reports what the daemon said when a code is refused', () async {
      machine.enrolError = const TunnelException('That code is not valid.');

      final ok = await shared.enrol(inviteToken: 'nope', serverAddress: base);

      expect(ok, isFalse);
      expect(shared.error, 'That code is not valid.');
      // Left at [checking] the app shows a spinner over an error nobody can
      // dismiss.
      expect(shared.status, EnrollStatus.notEnrolled);
      expect(shared.isBusy, isFalse);
    });

    test('removing the device erases the machine copy too', () async {
      machine.stored = const MachineIdentity(
        controlPlane: base,
        deviceToken: 'vpndev_from_extension',
      );
      await shared.bootstrap();
      http.enqueue('DELETE', '/device', status: 204);

      expect(await shared.removeDevice(), isTrue);

      // Clearing only the app would leave the daemon holding a credential the
      // server has deleted, reconnecting the extension into a 401 forever.
      expect(machine.forgetCalls, 1);
      expect(shared.status, EnrollStatus.notEnrolled);
      expect(await store.readDeviceToken(), isNull);
    });

    test('asks for an address before spending the code', () async {
      final ok = await shared.enrol(inviteToken: 'code', serverAddress: '');

      expect(ok, isFalse);
      expect(machine.enrolments, isEmpty);
      expect(shared.error, contains('address'));
    });
  });

  group('a tunnel that holds its own identity', () {
    test('connect lets the tunnel bring itself up', () async {
      await enrolled();
      tunnel.ownIdentity = true;
      http.enqueue('GET', '/servers', body: {'servers': []});

      await vpn.initialize();
      await vpn.connect();

      expect(tunnel.ownIdentityStarts, 1);
      // No config was prepared, because there is no private key here to
      // prepare one with — the daemon has it.
      expect(tunnel.startedConfigs, isEmpty);
      expect(vpn.error, isNull);
    });
  });

  group('which region is on screen', () {
    Map<String, dynamic> whereAmI({
      String ip = '203.0.113.9',
      bool tunnelled = true,
      String? region = 'Frankfurt',
    }) => {'ip': ip, 'throughTunnel': tunnelled, 'region': region};

    test('disconnected it is where the user actually is', () async {
      await enrolled();
      http.enqueue('GET', '/servers', body: {'servers': serverList});
      http.enqueue(
        'GET',
        '/whoami',
        body: whereAmI(ip: '88.240.1.1', tunnelled: false, region: 'Türkiye'),
      );

      await vpn.initialize();
      await settle();

      // Not the node this would connect to. Naming Frankfurt here would read
      // as protection that is not switched on.
      expect(vpn.regionLabel, 'Türkiye');
    });

    test('connected it is the node the traffic came out of', () async {
      await enrolled();
      tunnel.emit(TunnelStage.connected);
      http.enqueue('GET', '/servers', body: {'servers': serverList});
      http.enqueue('GET', '/whoami', body: whereAmI(region: 'Amsterdam'));

      await vpn.initialize();
      await settle();

      // The server recognised the address it was contacted from, so this is
      // evidence rather than a restatement of what the app already assumed.
      expect(vpn.regionLabel, 'Amsterdam');
    });

    test('connected with no answer it falls back to the picked region',
        () async {
      await enrolled();
      tunnel.emit(TunnelStage.connected);
      http.enqueue('GET', '/servers', body: {'servers': serverList});
      http.enqueue('GET', '/whoami', body: whereAmI(region: null));

      await vpn.initialize();
      await settle();

      expect(vpn.regionLabel, 'Frankfurt');
    });

    test('disconnected with no answer it shows nothing', () async {
      await enrolled();
      http.enqueue('GET', '/servers', body: {'servers': serverList});
      http.enqueue('GET', '/whoami', body: whereAmI(tunnelled: false, region: null));

      await vpn.initialize();
      await settle();

      // A server with no location database. Blank is the honest answer; the
      // picked region would claim the traffic goes somewhere it does not.
      expect(vpn.regionLabel, isNull);
    });

    test('a connect during the launch lookup still updates the line', () async {
      await enrolled();
      http.enqueue('GET', '/servers', body: {'servers': serverList});
      // The answer for "not connected yet", which is what the launch lookup
      // asks for.
      http.enqueue(
        'GET',
        '/whoami',
        body: whereAmI(ip: '88.240.1.1', tunnelled: false, region: 'Türkiye'),
      );
      // And the answer once the tunnel is up.
      http.enqueue('GET', '/whoami', body: whereAmI(region: 'Frankfurt'));

      // The tunnel has to come up *while the launch lookup is running*, which
      // is the whole scenario. The fake otherwise answers within one event-loop
      // turn, so held open until the stage has changed underneath it.
      final gate = http.hold('/whoami');

      final booting = vpn.initialize();
      await settle();
      expect(vpn.checkingAddress, isTrue, reason: 'lookup never started');

      tunnel.emit(TunnelStage.connected);
      gate.complete();

      await booting;
      await settle();

      // Dropping the second lookup would leave "Türkiye" on screen for the
      // rest of the session, next to a tunnel that is up.
      expect(vpn.regionLabel, 'Frankfurt');
      expect(vpn.publicAddress?.throughTunnel, isTrue);
    });

    test('an answer from before the routes were up is not the final word',
        () async {
      await enrolled();
      tunnel.emit(TunnelStage.connected);
      http.enqueue('GET', '/servers', body: {'servers': serverList});
      // The interface reports "up" before its routes exist, so the first
      // lookup after a connect can still leave by the old path and come back
      // with the address the user had a second ago.
      http.enqueue(
        'GET',
        '/whoami',
        body: whereAmI(ip: '88.240.1.1', tunnelled: false, region: 'Türkiye'),
      );
      http.enqueue('GET', '/whoami', body: whereAmI(region: 'Frankfurt'));

      await vpn.initialize();
      await settle();

      // Taking the first answer would leave the line reading "unprotected,
      // Türkiye" for the rest of the session, over a tunnel that is fine.
      expect(vpn.publicAddress?.throughTunnel, isTrue);
      expect(vpn.regionLabel, 'Frankfurt');
      expect(http.callCount('GET', '/whoami'), 2);
    });

    test('it stops asking rather than insisting the tunnel is up', () async {
      await enrolled();
      tunnel.emit(TunnelStage.connected);
      http.enqueue('GET', '/servers', body: {'servers': serverList});
      // Every answer says the traffic is not tunnelled. That may be the truth
      // — a tunnel that is up and carrying nothing — and it must be shown as
      // such rather than retried forever.
      for (var i = 0; i < 8; i++) {
        http.enqueue(
          'GET',
          '/whoami',
          body: whereAmI(ip: '88.240.1.1', tunnelled: false, region: 'Türkiye'),
        );
      }

      await vpn.initialize();
      await settle();

      expect(vpn.publicAddress?.throughTunnel, isFalse);
      expect(http.callCount('GET', '/whoami'), lessThanOrEqualTo(4));
    });

    test('the region list is retried after a failure at launch', () async {
      await enrolled();
      // Offline at launch: no /servers stub, so the first attempt 500s.
      http.enqueue('GET', '/whoami', body: whereAmI(tunnelled: false, region: null));

      await vpn.initialize();
      await settle();
      expect(vpn.servers, isEmpty);

      // Back online. Without the retry this stays empty for the whole session
      // and the region picker has nothing in it.
      http.enqueue('GET', '/servers', body: {'servers': serverList});
      http.enqueue('GET', '/whoami', body: whereAmI(tunnelled: false, region: null));
      await vpn.refreshPublicAddress();

      expect(vpn.servers, hasLength(1));
    });
  });
}
