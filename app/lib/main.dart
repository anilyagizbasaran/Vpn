import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'core/api_client.dart';
import 'core/secure_store.dart';
import 'services/auth_repository.dart';
import 'services/peer_repository.dart';
import 'services/tunnel_service.dart';
import 'state/auth_controller.dart';
import 'state/vpn_controller.dart';
import 'ui/home_screen.dart';
import 'ui/login_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  final store = SecureStore();
  final api = ApiClient(store: store);
  final tunnel = TunnelService();

  // Built eagerly rather than lazily by provider, because the two controllers
  // have to know about each other: ending a session must also tear down the
  // tunnel it authorised.
  final vpn = VpnController(
    peers: PeerRepository(api: api),
    store: store,
    tunnel: tunnel,
  );

  final auth = AuthController(
    repository: AuthRepository(api: api, store: store),
    store: store,
    api: api,
  );

  // Plain assignments, not a cascade: `..x = () => f()` would parse the next
  // `..` as part of the lambda body rather than as another cascade on `auth`.
  auth.onSignedOut = () => vpn.reset(revokeDevice: true);
  auth.onSessionLost = () => vpn.reset(revokeDevice: false);
  auth.bootstrap();

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: auth),
        ChangeNotifierProvider.value(value: vpn),
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
