import 'package:flutter_test/flutter_test.dart';
import 'package:vpn_api/vpn_api.dart';
import 'package:vpn_client/vpn_client.dart';

import 'helpers/fakes.dart';

const _build = 'https://build.example.com';

void main() {
  // Without this, installing the fake storage channel throws in setUp and
  // every test in the file fails before it runs — including the four that
  // only check string validation and never touch storage at all.
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeSecureStorageChannel storage;
  late SecureStore store;
  late ApiClient api;
  late VpnServerAddress address;

  setUp(() {
    storage = FakeSecureStorageChannel()..install();
    store = SecureStore();
    api = ApiClient(store: store, baseUrl: _build);
    address = VpnServerAddress(store: store, api: api, buildDefault: _build);
  });

  tearDown(() => storage.uninstall());

  group('validation', () {
    test('accepts https', () {
      expect(
        () => VpnServerAddress.validate('https://vpn.example.com'),
        returnsNormally,
      );
    });

    test(
      'rejects http, because the device token would travel in the clear',
      () {
        expect(
          () => VpnServerAddress.validate('http://vpn.example.com'),
          throwsA(isA<ServerAddressError>()),
        );
      },
    );

    test('rejects an address with no scheme', () {
      expect(
        () => VpnServerAddress.validate('vpn.example.com'),
        throwsA(isA<ServerAddressError>()),
      );
    });

    test('rejects empty', () {
      expect(
        () => VpnServerAddress.validate('  '),
        throwsA(isA<ServerAddressError>()),
      );
    });
  });

  test('a trailing slash never reaches the request path', () async {
    await address.change('https://vpn.example.com/');
    expect(address.current, 'https://vpn.example.com');
    expect(api.baseUrl, 'https://vpn.example.com');
  });

  test(
    'changing the address forgets the device registered with the old one',
    () async {
      await store.saveDevice(
        peerId: 7,
        privateKey: 'private',
        publicKey: 'public',
        keyCreatedAt: DateTime.now(),
      );
      await store.saveDeviceToken('vpndev_old');

      await address.change('https://other.example.com');

      // The keypair is registered with the previous control plane and means
      // nothing to the new one; leaving it would fail as "connecting" forever.
      expect(await store.readPeerId(), isNull);
      expect(await store.readPeerPrivateKey(), isNull);
      expect(await store.readDeviceToken(), isNull);
    },
  );

  test('the override survives a restart', () async {
    await address.change('https://moved.example.com');

    final freshApi = ApiClient(store: store, baseUrl: _build);
    final reloaded = VpnServerAddress(
      store: store,
      api: freshApi,
      buildDefault: _build,
    );
    expect(reloaded.current, _build, reason: 'not loaded yet');

    await reloaded.load();
    expect(reloaded.current, 'https://moved.example.com');
    expect(freshApi.baseUrl, 'https://moved.example.com');
  });

  test(
    'reset returns to the compiled-in address and drops the override',
    () async {
      await address.change('https://moved.example.com');
      expect(address.isOverridden, isTrue);

      await address.reset();

      expect(address.current, _build);
      expect(address.isOverridden, isFalse);
      expect(
        await store.readServerUrl(),
        isNull,
        reason: 'a reset should leave nothing behind to reload',
      );
    },
  );

  test('setting the same address again does not wipe the device', () async {
    await store.saveDevice(
      peerId: 7,
      privateKey: 'private',
      publicKey: 'public',
      keyCreatedAt: DateTime.now(),
    );

    await address.change(_build);

    expect(await store.readPeerId(), 7);
  });

  group('with no address compiled in', () {
    // The shape a released build actually ships in: everyone who runs this has
    // their own server, so there is nothing to bake in and the app has to ask.
    late SecureStore freshStore;
    late VpnServerAddress blank;

    setUp(() {
      freshStore = SecureStore();
      blank = VpnServerAddress(
        store: freshStore,
        api: ApiClient(store: freshStore, baseUrl: ''),
        buildDefault: '',
      );
    });

    test('starts unconfigured, so the app knows to ask', () {
      expect(blank.isConfigured, isFalse);
      expect(blank.current, isEmpty);
    });

    test('is configured once an address is entered', () async {
      await blank.change('https://vpn.example.com');

      expect(blank.isConfigured, isTrue);
      expect(blank.current, 'https://vpn.example.com');
    });

    test('remembers it across a restart', () async {
      await blank.change('https://vpn.example.com');

      // Stored even though there is no default to differ from. Writing null
      // when the value equals the default is right only when the default is
      // real; here it would make the next launch ask all over again.
      expect(await freshStore.readServerUrl(), 'https://vpn.example.com');

      final reloaded = VpnServerAddress(
        store: freshStore,
        api: ApiClient(store: freshStore, baseUrl: ''),
        buildDefault: '',
      );
      await reloaded.load();

      expect(reloaded.current, 'https://vpn.example.com');
      expect(reloaded.isConfigured, isTrue);
    });
  });
}
