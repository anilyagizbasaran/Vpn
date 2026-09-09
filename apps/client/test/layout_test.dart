import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:vpn_api/vpn_api.dart';
import 'package:vpn_client/vpn_client.dart';
import 'package:vpn_tunnel/vpn_tunnel.dart';

import 'package:vpn_client_app/ui/enroll_screen.dart';
import 'package:vpn_client_app/ui/home_screen.dart';
import 'package:vpn_client_app/ui/theme.dart';

/// The window is 380x640 and cannot be scrolled to reach the button.
///
/// A layout that overflows is not a cosmetic problem here: Flutter paints the
/// yellow-and-black stripe over whatever ran out of room, which on this screen
/// is the thing the user opened the app to press. These tests render at the
/// real window size and fail if anything does not fit — which is the only way
/// to check a window that cannot be opened on the machine that builds it.
const _window = Size(380, 640);

/// The narrowest phone worth caring about, to catch a layout that only fits
/// because the desktop window happens to be wide enough.
const _smallPhone = Size(320, 568);

/// Present so the mode switch is drawn at all.
///
/// Without one the app hides the choice — which is right in production and
/// wrong here: it would leave the widget with the most text on this screen
/// laid out nowhere, on a window that cannot be opened on the machine that
/// builds it.
class _FakeBrowserTunnel implements BrowserTunnel {
  BrowserTunnelState _state = BrowserTunnelState.off;

  @override
  Future<BrowserTunnelState> state() async => _state;

  @override
  Future<BrowserTunnelState> start() async {
    _state = const BrowserTunnelState(
      running: true,
      host: '127.0.0.1',
      port: 49152,
    );
    return _state;
  }

  @override
  Future<void> stop() async {
    _state = BrowserTunnelState.off;
  }
}

class _FakeTunnel implements Tunnel {
  final _stages = StreamController<TunnelStage>.broadcast();
  TunnelStage current = TunnelStage.disconnected;

  @override
  Stream<TunnelStage> get stages => _stages.stream;

  @override
  Future<TunnelStage> currentStage() async => current;

  @override
  Future<void> initialize() async {}

  @override
  Future<bool> hasPermission() async => true;

  @override
  Future<void> start({
    required String wgQuickConfig,
    required String serverAddress,
  }) async {}

  @override
  Future<bool> startFromOwnIdentity() async => false;

  @override
  Future<void> stop() async {}

  @override
  Future<void> dispose() async {
    await _stages.close();
  }
}

/// Secure storage lives behind a platform channel that does not exist in a
/// test binding, so it is answered from a map.
void _installStorage(Map<String, String> values) {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (call) async {
        final args = (call.arguments as Map?)?.cast<String, Object?>() ?? {};
        final key = args['key'] as String?;
        switch (call.method) {
          case 'read':
            return values[key];
          case 'write':
            values[key!] = args['value'] as String;
            return null;
          case 'delete':
            values.remove(key);
            return null;
          case 'deleteAll':
            values.clear();
            return null;
          case 'readAll':
            return Map<String, String>.from(values);
          case 'containsKey':
            return values.containsKey(key);
          default:
            return null;
        }
      });
}

Widget _wrap(
  Widget child, {
  required Brightness brightness,
  VpnController? vpn,
}) {
  final store = SecureStore();
  final api = ApiClient(store: store, baseUrl: 'https://vpn.example.com');

  return MultiProvider(
    providers: [
      ChangeNotifierProvider(
        create: (_) =>
            vpn ??
            VpnController(
              devices: DeviceRepository(api: api),
              store: store,
              tunnel: _FakeTunnel(),
              browserTunnel: _FakeBrowserTunnel(),
            ),
      ),
      ChangeNotifierProvider(
        create: (_) => EnrollController(
          repository: EnrollmentRepository(api: api, store: store),
          session: store,
          devices: store,
        ),
      ),
      ChangeNotifierProvider(
        create: (_) => VpnServerAddress(
          store: store,
          api: api,
          buildDefault: 'https://vpn.example.com',
        ),
      ),
    ],
    child: MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: buildTheme(brightness),
      home: child,
    ),
  );
}

Future<void> _pumpAt(
  WidgetTester tester,
  Widget screen,
  Size size, {
  Brightness brightness = Brightness.dark,
  VpnController? vpn,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(_wrap(screen, brightness: brightness, vpn: vpn));
  await tester.pump();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => _installStorage({}));

  group('the home screen fits its window', () {
    for (final brightness in Brightness.values) {
      testWidgets('at 380x640 in ${brightness.name}', (tester) async {
        await _pumpAt(
          tester,
          const HomeScreen(),
          _window,
          brightness: brightness,
        );
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('on a 320-wide phone', (tester) async {
      await _pumpAt(tester, const HomeScreen(), _smallPhone);
      expect(tester.takeException(), isNull);
    });

    testWidgets('shows the switch and where it connects', (tester) async {
      await _pumpAt(tester, const HomeScreen(), _window);

      // The three things the screen exists to say. `Server` shows the host
      // without the scheme, which is the whole reason it is trimmed.
      expect(find.text('Server'), findsOneWidget);
      expect(find.text('vpn.example.com'), findsOneWidget);
      expect(find.text('Region'), findsOneWidget);

      // Disconnected, so it offers to tell you your own address rather than
      // the VPN's. The value is a dash until the server answers, which it
      // cannot do in a test.
      expect(find.text('Your IP'), findsOneWidget);
      expect(find.text('VPN IP'), findsNothing);
      expect(find.byIcon(Icons.power_settings_new_rounded), findsOneWidget);
    });

    testWidgets('offers the two modes, and locks them once one is on', (
      tester,
    ) async {
      final vpn = VpnController(
        devices: DeviceRepository(
          api: ApiClient(store: SecureStore(), baseUrl: 'https://x.example'),
        ),
        store: SecureStore(),
        tunnel: _FakeTunnel(),
        browserTunnel: _FakeBrowserTunnel(),
      );

      await _pumpAt(tester, const HomeScreen(), _window, vpn: vpn);

      expect(find.text('Whole computer'), findsOneWidget);
      expect(find.text('Browser only'), findsOneWidget);
      expect(tester.takeException(), isNull);

      // Turn the browser tunnel on and let the screen catch up. This is the
      // wider of the two states — a proxy row appears in the card and the
      // detail line grows to two lines — so it is the one that overflows.
      vpn.setMode(VpnMode.browser);
      await tester.pump();
      await vpn.toggle();
      await tester.pumpAndSettle();

      expect(find.text('Browser proxy'), findsOneWidget);
      expect(find.text('127.0.0.1:49152'), findsOneWidget);
      expect(find.text('Disconnect to change this.'), findsOneWidget);
      // The address on screen is this computer's, because the app is not the
      // browser and is not proxied. Labelled so, or it reads as a failure.
      expect(find.text('This computer'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('browser-only mode fits the narrow window', () {
    testWidgets('on a 320-wide phone with the proxy showing', (tester) async {
      final vpn = VpnController(
        devices: DeviceRepository(
          api: ApiClient(store: SecureStore(), baseUrl: 'https://x.example'),
        ),
        store: SecureStore(),
        tunnel: _FakeTunnel(),
        browserTunnel: _FakeBrowserTunnel(),
      );
      vpn.setMode(VpnMode.browser);
      await vpn.toggle();

      await _pumpAt(tester, const HomeScreen(), _smallPhone, vpn: vpn);
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
    });
  });

  group('the setup screen fits its window', () {
    testWidgets('at 380x640', (tester) async {
      await _pumpAt(tester, const EnrollScreen(), _window);
      expect(tester.takeException(), isNull);

      // Both fields, because a code without an address is useless and the
      // screen used to hide the address behind a menu.
      expect(find.text('Server address'), findsOneWidget);
      expect(find.text('Invite code'), findsOneWidget);
    });

    testWidgets('on a 320-wide phone', (tester) async {
      await _pumpAt(tester, const EnrollScreen(), _smallPhone);
      expect(tester.takeException(), isNull);
    });
  });
}
