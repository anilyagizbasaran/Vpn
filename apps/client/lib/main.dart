import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vpn_api/vpn_api.dart';
import 'package:vpn_client/vpn_client.dart';
import 'package:vpn_tunnel/vpn_tunnel.dart';
import 'package:vpn_tunnel_desktop/vpn_tunnel_desktop.dart';

import 'config.dart';
import 'ui/enroll_screen.dart';
import 'ui/home_screen.dart';
import 'ui/theme.dart';
import 'unsupported_tunnel.dart';

/// Composition root. Everything below is wired here and nowhere else, which is
/// what lets the desktop build swap one line — the [Tunnel] — without any
/// other layer knowing.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final store = SecureStore();
  final api = ApiClient(
    store: store,
    baseUrl: AppConfig.apiBaseUrl,
    timeout: AppConfig.requestTimeout,
  );

  // Loaded before anything issues a request, so the first call already goes to
  // the right place. A self-hosted server can move, and the alternative to this
  // is reinstalling every client when it does.
  final serverAddress = VpnServerAddress(
    store: store,
    api: api,
    buildDefault: AppConfig.apiBaseUrl,
  );
  await serverAddress.load();

  // The one line that differs between platforms. Everything above the tunnel
  // contract — controllers, storage, rotation policy, UI — is identical.
  //
  // No mobile branch any more, on purpose: phones connect over IKEv2 from
  // their own Settings screen and never run this app.
  final Tunnel tunnel;
  MachineEnrolment? machine;
  BrowserTunnel? browserTunnel;
  if (AppConfig.hasDesktopTunnel) {
    tunnel = DesktopTunnel();
    // The daemon owns this computer's identity, so the app and the browser
    // extension are one device rather than two — whichever set it up first.
    machine = DaemonEnrolment();
    // Browser-only mode. Left null anywhere else, and the app then does not
    // offer the choice rather than offering one that fails when taken.
    browserTunnel = DaemonBrowserTunnel();
  } else {
    tunnel = UnsupportedTunnel(AppConfig.deviceLabel);
  }

  // Built eagerly rather than lazily by provider, because the two controllers
  // have to know about each other: ending a session must also tear down the
  // tunnel it authorised.
  final vpn = VpnController(
    devices: DeviceRepository(api: api),
    store: store,
    tunnel: tunnel,
    browserTunnel: browserTunnel,
    keyRotationInterval: AppConfig.keyRotationInterval,
  );

  final enrol = EnrollController(
    repository: EnrollmentRepository(api: api, store: store),
    session: store,
    devices: store,
    machine: machine,
  );
  enrol.onSessionEnd = vpn.endSession;
  // Adopting an identity means adopting the server that issued it. Without
  // this the app would hold a working token and point it at the wrong place.
  enrol.onControlPlane = serverAddress.adopt;
  // A 401 means the server no longer knows this device, so the app has to go
  // back to the enrolment screen rather than retry into the same wall.
  api.onSessionExpired = () => enrol.handleRevoked();
  enrol.bootstrap();

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: enrol),
        ChangeNotifierProvider.value(value: vpn),
        ChangeNotifierProvider.value(value: serverAddress),
      ],
      child: const VpnApp(),
    ),
  );
}

class VpnApp extends StatelessWidget {
  const VpnApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'VPN',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      home: const _AuthGate(),
    );
  }
}

/// Chooses the screen from enrolment state. Keeping this in one place means no
/// screen has to defend against being shown before the device is set up.
class _AuthGate extends StatelessWidget {
  const _AuthGate();

  @override
  Widget build(BuildContext context) {
    final status = context.select<EnrollController, EnrollStatus>(
      (c) => c.status,
    );

    return switch (status) {
      EnrollStatus.checking => const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      ),
      EnrollStatus.notEnrolled => const EnrollScreen(),
      EnrollStatus.enrolled => const HomeScreen(),
    };
  }
}
