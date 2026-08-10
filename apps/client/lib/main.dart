import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vpn_api/vpn_api.dart';
import 'package:vpn_client/vpn_client.dart';
import 'package:vpn_tunnel/vpn_tunnel.dart';
import 'package:vpn_tunnel_desktop/vpn_tunnel_desktop.dart';
import 'package:vpn_tunnel_mobile/vpn_tunnel_mobile.dart';

import 'config.dart';
import 'ui/home_screen.dart';
import 'ui/login_screen.dart';
import 'unsupported_tunnel.dart';

/// Composition root. Everything below is wired here and nowhere else, which is
/// what lets the desktop build swap one line — the [Tunnel] — without any
/// other layer knowing.
void main() {
  WidgetsFlutterBinding.ensureInitialized();

  final store = SecureStore();
  final api = ApiClient(
    store: store,
    baseUrl: AppConfig.apiBaseUrl,
    timeout: AppConfig.requestTimeout,
  );

  // The one line that differs between platforms. Everything above the tunnel
  // contract — controllers, storage, rotation policy, UI — is identical.
  final Tunnel tunnel;
  if (AppConfig.hasMobileTunnel) {
    tunnel = MobileTunnel(
      interfaceName: AppConfig.interfaceName,
      vpnName: AppConfig.vpnName,
      providerBundleIdentifier: AppConfig.providerBundleIdentifier,
    );
  } else if (AppConfig.hasDesktopTunnel) {
    tunnel = DesktopTunnel();
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
    deviceLabel: AppConfig.deviceLabel,
    devicePlatform: AppConfig.devicePlatform,
    keyRotationInterval: AppConfig.keyRotationInterval,
  );

  final auth = AuthController(
    repository: AuthRepository(api: api, store: store),
    store: store,
    api: api,
  );
  auth.onSessionEnd = vpn.endSession;
  auth.bootstrap();

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: auth),
        ChangeNotifierProvider.value(value: vpn),
        Provider.value(
          value: SystemSettings(isSupported: AppConfig.hasSystemVpnSettings),
        ),
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
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF2F6BFF)),
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF2F6BFF),
          brightness: Brightness.dark,
        ),
      ),
      home: const _AuthGate(),
    );
  }
}

/// Chooses the screen from auth state. Keeping this in one place means no
/// screen has to defend against being shown while signed out.
class _AuthGate extends StatelessWidget {
  const _AuthGate();

  @override
  Widget build(BuildContext context) {
    final status = context.select<AuthController, AuthStatus>((c) => c.status);

    return switch (status) {
      AuthStatus.checking => const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      ),
      AuthStatus.signedOut => const LoginScreen(),
      AuthStatus.signedIn => const HomeScreen(),
    };
  }
}
