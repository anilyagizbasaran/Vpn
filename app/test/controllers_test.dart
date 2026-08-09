import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:vpn_client/core/api_client.dart';
import 'package:vpn_client/core/secure_store.dart';
import 'package:vpn_client/core/wireguard_keys.dart';
import 'package:vpn_client/services/auth_repository.dart';
import 'package:vpn_client/services/peer_repository.dart';
import 'package:vpn_client/services/tunnel_service.dart';
import 'package:vpn_client/state/auth_controller.dart';
import 'package:vpn_client/state/vpn_controller.dart';
import 'package:wireguard_flutter_plus/wireguard_flutter_plus.dart';

import 'helpers/fakes.dart';

late FakeHttpClient http;
late FakeSecureStorageChannel storage;
late FakeWireGuard tunnelPlugin;
late SecureStore store;
late ApiClient api;
late AuthController auth;
late VpnController vpn;

const base = 'https://api.test';
const privateKey = 'cHJpdmF0ZWtleXByaXZhdGVrZXlwcml2YXRla2V5cHJpdmE=';

/// Must match the key inside [peerBody], otherwise the controller decides the
/// stored key is orphaned and re-keys.
const publicKey = 'cHVibGlja2V5cHVibGlja2V5cHVibGlja2V5cHVibGljMQ==';

Map<String, dynamic> sessionBody({
  String access = 'access-1',
  String refresh = 'refresh-1',
  String email = 'a@b.co',
}) => {
  'user': {'id': 1, 'email': email, 'createdAt': '2026-01-01T00:00:00.000Z'},
  'tokens': {
    'tokenType': 'Bearer',
    'accessToken': access,
    'expiresIn': 900,
    'refreshToken': refresh,
    'refreshExpiresAt': '2026-02-01T00:00:00.000Z',
  },
};

Map<String, dynamic> peerBody({
  int id = 7,
  String? key,
  String peerPublicKey = publicKey,
}) => {
  'peer': {
    'id': id,
    'deviceLabel': 'Android device',
    'publicKey': peerPublicKey,
    'allowedIp': '10.8.0.$id/32',
    'serverId': 1,
    'region': 'de-fra',
    'endpoint': 'vpn.test:51820',
    'createdAt': '2026-01-01T00:00:00.000Z',
    'keyRotatedAt': null,
  },
  'server': {
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
    tunnelPlugin = FakeWireGuard();
    store = SecureStore();
    api = ApiClient(store: store, httpClient: http, baseUrl: base);

    vpn = VpnController(
      peers: PeerRepository(api: api),
      store: store,
      tunnel: TunnelService(plugin: tunnelPlugin),
    );
    auth = AuthController(
      repository: AuthRepository(api: api, store: store),
      store: store,
      api: api,
    );
    auth.onSignedOut = () => vpn.reset(revokeDevice: true);
    auth.onSessionLost = () => vpn.reset(revokeDevice: false);
  });

  tearDown(() async {
    storage.uninstall();
    await tunnelPlugin.dispose();
  });

  group('AuthController', () {
    test('starts signed out when there is no stored token', () async {
      await auth.bootstrap();

      expect(auth.status, AuthStatus.signedOut);
      expect(http.requests, isEmpty);
    });

    test('verifies a stored token against the server before trusting it', () async {
      await store.saveSession(
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        email: 'a@b.co',
      );
      http.enqueue('GET', '/auth/me', body: {
        'user': {'id': 1, 'email': 'a@b.co', 'createdAt': '2026-01-01T00:00:00.000Z'},
      });

      await auth.bootstrap();

      expect(auth.status, AuthStatus.signedIn);
      expect(auth.user?.email, 'a@b.co');
    });

    test('signs out and clears storage when the stored token is dead', () async {
      await store.saveSession(
        accessToken: 'stale',
        refreshToken: 'stale',
        email: 'a@b.co',
      );
      http.enqueue('GET', '/auth/me', status: 401, body: {'error': {}});
      http.enqueue('POST', '/auth/refresh', status: 401, body: {'error': {}});

      await auth.bootstrap();

      expect(auth.status, AuthStatus.signedOut);
      expect(await store.readAccessToken(), isNull);
    });

    test('login persists the session', () async {
      http.enqueue('POST', '/auth/login', body: sessionBody());

      await expectLater(
        auth.login(email: 'a@b.co', password: 'a-long-enough-password'),
        completion(isTrue),
      );

      expect(auth.status, AuthStatus.signedIn);
      expect(await store.readAccessToken(), 'access-1');
      expect(await store.readRefreshToken(), 'refresh-1');
    });

    test('a rejected login surfaces the server message and stays signed out', () async {
      http.enqueue('POST', '/auth/login', status: 401, body: {
        'error': {'code': 'unauthorized', 'message': 'Email or password is incorrect'},
      });

      await expectLater(
        auth.login(email: 'a@b.co', password: 'wrong-password'),
        completion(isFalse),
      );

      expect(auth.status, AuthStatus.signedOut);
      expect(auth.error, 'Email or password is incorrect');
      expect(auth.isBusy, isFalse);
    });

    test('deleteAccount signs out and stops the tunnel on success', () async {
      http.enqueue('POST', '/auth/login', body: sessionBody());
      await auth.login(email: 'a@b.co', password: 'a-long-enough-password');
      await store.saveDevice(peerId: 7, privateKey: privateKey, publicKey: publicKey);
      http.enqueue('DELETE', '/auth/account', status: 204);

      await expectLater(
        auth.deleteAccount(password: 'a-long-enough-password'),
        completion(isTrue),
      );

      expect(auth.status, AuthStatus.signedOut);
      expect(await store.readAccessToken(), isNull);
      expect(tunnelPlugin.stopCalls, greaterThan(0));
      // The server already deleted every peer; a client revoke would 401.
      expect(http.callCount('DELETE', '/peers/7'), 0);
    });

    test('a wrong password leaves the user signed in', () async {
      http.enqueue('POST', '/auth/login', body: sessionBody());
      await auth.login(email: 'a@b.co', password: 'a-long-enough-password');
      // 403 on purpose: a 401 here would look like an expired token and send
      // the client down its refresh-then-sign-out path.
      http.enqueue('DELETE', '/auth/account', status: 403, body: {
        'error': {'code': 'invalid_password', 'message': 'Password is incorrect'},
      });

      await expectLater(
        auth.deleteAccount(password: 'wrong-password'),
        completion(isFalse),
      );

      // Losing the session here would be a nasty surprise for a typo.
      expect(auth.status, AuthStatus.signedIn);
      expect(auth.error, 'Password is incorrect');
      expect(await store.readAccessToken(), 'access-1');
    });

    test('clearError removes the banner', () async {
      http.enqueue('POST', '/auth/login', status: 401, body: {'error': {}});
      await auth.login(email: 'a@b.co', password: 'a-long-enough-password');

      auth.clearError();

      expect(auth.error, isNull);
    });
  });

  group('sign-out', () {
    Future<void> signIn() async {
      http.enqueue('POST', '/auth/login', body: sessionBody());
      await auth.login(email: 'a@b.co', password: 'a-long-enough-password');
    }

    test('stops the tunnel, revokes the device, then clears credentials', () async {
      await signIn();
      await store.saveDevice(peerId: 7, privateKey: privateKey, publicKey: publicKey);
      tunnelPlugin.emit(VpnStage.connected);

      http.enqueue('DELETE', '/peers/7', status: 204);
      http.enqueue('POST', '/auth/logout', status: 204);

      await auth.logout();

      // The tunnel must not outlive the session.
      expect(tunnelPlugin.stopCalls, greaterThan(0));

      // The peer is released rather than left consuming a device slot with a
      // private key that is about to be deleted and can never be recovered.
      final revoke = http.requests.firstWhere((r) => r.path == '/peers/7');
      expect(revoke.method, 'DELETE');
      // It has to happen while the access token is still valid.
      expect(revoke.bearer, 'access-1');

      expect(auth.status, AuthStatus.signedOut);
      expect(await store.readAccessToken(), isNull);
      expect(await store.readPeerPrivateKey(), isNull);
      expect(await store.readPeerId(), isNull);
    });

    test('does not leak the previous account into the next session', () async {
      await signIn();
      await store.saveDevice(peerId: 7, privateKey: privateKey, publicKey: publicKey);
      http.enqueue('GET', '/peers', body: {'peers': [peerBody()['peer']]});
      await vpn.initialize();
      expect(vpn.device, isNotNull);

      http.enqueue('DELETE', '/peers/7', status: 204);
      http.enqueue('POST', '/auth/logout', status: 204);
      await auth.logout();

      // The device panel would otherwise still show the previous user's label
      // and tunnel IP to whoever signs in next on this phone.
      expect(vpn.device, isNull);
    });

    test('completes even when the revoke call fails', () async {
      await signIn();
      await store.saveDevice(peerId: 7, privateKey: privateKey, publicKey: publicKey);

      http.failWith = const SocketException('connection refused');

      await auth.logout();

      expect(auth.status, AuthStatus.signedOut);
      expect(await store.readAccessToken(), isNull);
      expect(tunnelPlugin.stopCalls, greaterThan(0));
    });

    test('an expired session stops the tunnel but keeps the device key', () async {
      await signIn();
      await store.saveDevice(peerId: 7, privateKey: privateKey, publicKey: publicKey);

      // The saved device makes connect() fetch its config; the token is dead.
      http.enqueue('GET', '/peers/7/config', status: 401, body: {'error': {}});
      http.enqueue('POST', '/auth/refresh', status: 401, body: {'error': {}});
      await vpn.connect();

      expect(auth.status, AuthStatus.signedOut);
      expect(tunnelPlugin.stopCalls, greaterThan(0));
      // Kept on purpose: the token is already dead so a revoke would fail, and
      // signing back in should reuse the same peer instead of burning a slot.
      expect(await store.readPeerPrivateKey(), privateKey);
      expect(http.callCount('DELETE', '/peers/7'), 0);
    });
  });

  group('VpnController.connect', () {
    setUp(() async {
      await store.saveSession(
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        email: 'a@b.co',
      );
      // Mirrors HomeScreen: the stage subscription is wired before any connect.
      await vpn.initialize();
    });

    test('generates the keypair locally and sends only the public half', () async {
      http.enqueue('POST', '/peers', status: 201, body: peerBody());

      await vpn.connect();

      final create = http.requests.firstWhere((r) => r.path == '/peers');
      final sentPublicKey = create.json['publicKey'] as String;

      // The private key must never appear in anything sent to the server.
      expect(WireGuardKeys.isValidKey(sentPublicKey), isTrue);
      expect(create.json.containsKey('privateKey'), isFalse);

      final storedPrivate = await store.readPeerPrivateKey();
      expect(storedPrivate, isNotNull);
      expect(create.body, isNot(contains(storedPrivate!)));

      // ...and the stored pair really is a pair.
      final derived = await WireGuardKeys.publicKeyFor(
        Uint8List.fromList(base64.decode(storedPrivate)),
      );
      expect(base64.encode(derived), sentPublicKey);
      expect(await store.readPeerPublicKey(), sentPublicKey);

      expect(await store.readPeerId(), 7);
      expect(vpn.isConnected, isTrue);
      expect(tunnelPlugin.startedConfigs.single, contains('PrivateKey = $storedPrivate'));
      expect(tunnelPlugin.startedConfigs.single, isNot(contains('<PRIVATE_KEY>')));
      expect(tunnelPlugin.startedServers.single, 'vpn.test:51820');
    });

    test('ignores a private key the server volunteers', () async {
      // Older servers still return one; the device already has its own.
      http.enqueue('POST', '/peers', status: 201, body: peerBody(key: privateKey));

      await vpn.connect();

      expect(await store.readPeerPrivateKey(), isNot(privateKey));
    });

    test('reuses a saved device and substitutes the stored key', () async {
      await store.saveDevice(peerId: 7, privateKey: privateKey, publicKey: publicKey);
      http.enqueue('GET', '/peers/7/config', body: peerBody());

      await vpn.connect();

      // No new peer: creating one per connect would exhaust the device quota.
      expect(http.callCount('POST', '/peers'), 0);
      expect(tunnelPlugin.startedConfigs.single, contains('PrivateKey = $privateKey'));
      expect(tunnelPlugin.startedConfigs.single, isNot(contains('<PRIVATE_KEY>')));
    });

    test('re-registers when the saved peer was revoked elsewhere', () async {
      await store.saveDevice(
        peerId: 7,
        privateKey: privateKey,
        publicKey: publicKey,
      );
      http.enqueue('GET', '/peers/7/config', status: 404, body: {
        'error': {'code': 'not_found', 'message': 'Peer not found'},
      });
      http.enqueue('POST', '/peers', status: 201, body: peerBody(id: 9));

      await vpn.connect();

      expect(await store.readPeerId(), 9);
      // A brand new pair, not the key of the peer that no longer exists.
      expect(await store.readPeerPrivateKey(), isNot(privateKey));
      expect(vpn.isConnected, isTrue);
    });

    test('shows the quota message with an actionable hint', () async {
      http.enqueue('POST', '/peers', status: 409, body: {
        'error': {
          'code': 'peer_quota_exceeded',
          'message': 'Device limit reached (5).',
          'details': {'limit': 5},
        },
      });

      await vpn.connect();

      expect(vpn.isConnected, isFalse);
      expect(vpn.error, contains('Device limit reached (5).'));
      expect(vpn.error, contains('remove a device'));
      expect(tunnelPlugin.startedConfigs, isEmpty);
    });

    test('reports a network failure instead of hanging', () async {
      http.failWith = const SocketException('connection refused');

      await vpn.connect();

      expect(vpn.error, contains('Cannot reach the VPN service'));
      expect(vpn.action, VpnAction.idle);
    });

    test('surfaces a tunnel start failure and stays disconnected', () async {
      http.enqueue('POST', '/peers', status: 201, body: peerBody(key: privateKey));
      tunnelPlugin.startError = Exception('tun device busy');

      await vpn.connect();

      expect(vpn.isConnected, isFalse);
      expect(vpn.error, contains('Unexpected error while connecting'));
      // The device was still registered, so a retry will not create a second.
      expect(await store.readPeerId(), 7);
    });

    test('ignores a second tap while a connect is in flight', () async {
      http.enqueue('POST', '/peers', status: 201, body: peerBody(key: privateKey));

      final first = vpn.connect();
      final second = vpn.connect();
      await Future.wait([first, second]);

      expect(http.callCount('POST', '/peers'), 1);
      expect(tunnelPlugin.startedConfigs, hasLength(1));
    });
  });

  group('key rotation', () {
    setUp(() async {
      await store.saveSession(
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        email: 'a@b.co',
      );
      await vpn.initialize();
    });

    /// A device whose key was issued [age] ago.
    Future<void> deviceAged(Duration age) => store.saveDevice(
      peerId: 7,
      privateKey: privateKey,
      publicKey: publicKey,
      keyCreatedAt: DateTime.now().toUtc().subtract(age),
    );

    test('leaves a fresh key alone', () async {
      await deviceAged(const Duration(days: 1));
      http.enqueue('GET', '/peers/7/config', body: peerBody());

      await vpn.connect();

      expect(http.callCount('POST', '/peers/7/rotate'), 0);
      expect(await store.readPeerPrivateKey(), privateKey);
    });

    test('replaces a key older than the rotation interval', () async {
      await deviceAged(const Duration(days: 8));
      final rotatedPublicKey = base64.encode(List.filled(32, 9));
      http.enqueue('GET', '/peers/7/config', body: peerBody());
      http.enqueue(
        'POST',
        '/peers/7/rotate',
        body: peerBody(peerPublicKey: rotatedPublicKey),
      );

      await vpn.connect();

      final rotate = http.requests.firstWhere((r) => r.path == '/peers/7/rotate');
      final sent = rotate.json['publicKey'] as String;
      expect(WireGuardKeys.isValidKey(sent), isTrue);

      // The new private key replaced the old one and is what the tunnel uses.
      final stored = await store.readPeerPrivateKey();
      expect(stored, isNot(privateKey));
      expect(await store.readPeerPublicKey(), sent);
      expect(tunnelPlugin.startedConfigs.single, contains('PrivateKey = $stored'));
      expect(vpn.isConnected, isTrue);
    });

    test('keeps the device id and address across a rotation', () async {
      await deviceAged(const Duration(days: 30));
      http.enqueue('GET', '/peers/7/config', body: peerBody());
      http.enqueue('POST', '/peers/7/rotate', body: peerBody());

      await vpn.connect();

      expect(await store.readPeerId(), 7);
      expect(vpn.device?.allowedIp, '10.8.0.7/32');
      // Rotation must not burn a device slot.
      expect(http.callCount('POST', '/peers'), 0);
    });

    test('connects with the old key when rotation fails', () async {
      await deviceAged(const Duration(days: 8));
      http.enqueue('GET', '/peers/7/config', body: peerBody());
      http.enqueue('POST', '/peers/7/rotate', status: 502, body: {
        'error': {'code': 'wireguard_error', 'message': 'Could not install the new key'},
      });

      await vpn.connect();

      // A failed rotation must never stand between the user and their VPN.
      expect(vpn.isConnected, isTrue);
      expect(await store.readPeerPrivateKey(), privateKey);
      expect(tunnelPlugin.startedConfigs.single, contains('PrivateKey = $privateKey'));
    });

    test('rotates a device stored before rotation existed', () async {
      // No key_created_at: an app upgrade, so the key age is unknown.
      await store.saveDevice(
        peerId: 7,
        privateKey: privateKey,
        publicKey: publicKey,
        keyCreatedAt: DateTime.utc(2020),
      );
      http.enqueue('GET', '/peers/7/config', body: peerBody());
      http.enqueue('POST', '/peers/7/rotate', body: peerBody());

      await vpn.connect();

      expect(http.callCount('POST', '/peers/7/rotate'), 1);
    });

    test('re-keys when the server no longer recognises the stored key', () async {
      // An interrupted rotation, or storage restored from a backup.
      await store.saveDevice(
        peerId: 7,
        privateKey: privateKey,
        publicKey: base64.encode(List.filled(32, 3)),
      );
      http.enqueue('GET', '/peers/7/config', body: peerBody());
      http.enqueue('POST', '/peers/7/rotate', body: peerBody());

      await vpn.connect();

      // Without this the tunnel would sit on "connecting" forever with no error.
      expect(http.callCount('POST', '/peers/7/rotate'), 1);
      expect(vpn.isConnected, isTrue);
    });

    test('refuses to start the tunnel with a key the server rejected', () async {
      await store.saveDevice(
        peerId: 7,
        privateKey: privateKey,
        publicKey: base64.encode(List.filled(32, 3)),
      );
      http.enqueue('GET', '/peers/7/config', body: peerBody());
      http.enqueue('POST', '/peers/7/rotate', status: 502, body: {'error': {}});

      await vpn.connect();

      expect(vpn.isConnected, isFalse);
      expect(vpn.error, contains('needs a new VPN key'));
      expect(tunnelPlugin.startedConfigs, isEmpty);
    });
  });

  group('VpnController stage handling', () {
    test('mirrors the platform stage and labels it', () async {
      await vpn.initialize();

      tunnelPlugin.emit(VpnStage.connecting);
      await Future<void>.delayed(Duration.zero);
      expect(vpn.statusLabel, describeStage(VpnStage.connecting));
      expect(vpn.isBusy, isTrue);

      tunnelPlugin.emit(VpnStage.connected);
      await Future<void>.delayed(Duration.zero);
      expect(vpn.isConnected, isTrue);
      expect(vpn.statusLabel, 'Connected');
    });

    test('explains a denied VPN permission', () async {
      await vpn.initialize();

      tunnelPlugin.emit(VpnStage.denied);
      await Future<void>.delayed(Duration.zero);

      expect(vpn.error, contains('was not allowed'));
    });

    test('disconnect stops the tunnel', () async {
      await vpn.initialize();
      tunnelPlugin.emit(VpnStage.connected);
      await Future<void>.delayed(Duration.zero);

      await vpn.disconnect();

      expect(tunnelPlugin.stopCalls, 1);
      expect(vpn.isConnected, isFalse);
    });

    test('toggle connects when down and disconnects when up', () async {
      await store.saveSession(
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        email: 'a@b.co',
      );
      await store.saveDevice(peerId: 7, privateKey: privateKey, publicKey: publicKey);
      http.enqueue('GET', '/peers/7/config', body: peerBody());
      await vpn.initialize();

      await vpn.toggle();
      expect(vpn.isConnected, isTrue);

      await vpn.toggle();
      expect(tunnelPlugin.stopCalls, 1);
    });
  });

  group('VpnController.forgetDevice', () {
    setUp(() async {
      await store.saveSession(
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        email: 'a@b.co',
      );
      await store.saveDevice(peerId: 7, privateKey: privateKey, publicKey: publicKey);
    });

    test('revokes on the server and forgets the key locally', () async {
      http.enqueue('DELETE', '/peers/7', status: 204);

      await vpn.forgetDevice();

      expect(await store.readPeerId(), isNull);
      expect(await store.readPeerPrivateKey(), isNull);
      expect(vpn.device, isNull);
      expect(vpn.error, isNull);
    });

    test('treats an already-missing peer as forgotten', () async {
      http.enqueue('DELETE', '/peers/7', status: 404, body: {'error': {}});

      await vpn.forgetDevice();

      expect(await store.readPeerId(), isNull);
      expect(vpn.error, isNull);
    });

    test('keeps the key and reports the error on a real failure', () async {
      http.enqueue('DELETE', '/peers/7', status: 500, body: {
        'error': {'code': 'internal_error', 'message': 'Something went wrong'},
      });

      await vpn.forgetDevice();

      expect(vpn.error, 'Something went wrong');
      expect(await store.readPeerPrivateKey(), privateKey);
    });
  });
}

