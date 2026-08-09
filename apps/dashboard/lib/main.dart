import 'package:flutter/material.dart';
import 'package:vpn_api/vpn_api.dart';

import 'devices_page.dart';
import 'session_store.dart';
import 'sign_in_page.dart';

/// Where the control plane lives. Same origin by default, so a dashboard
/// served by the same Caddy that proxies the API needs no configuration and
/// no CORS.
const apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: '');

void main() {
  final store = BrowserSessionStore();
  final api = ApiClient(store: store, baseUrl: apiBaseUrl);

  runApp(DashboardApp(api: api, store: store));
}

class DashboardApp extends StatefulWidget {
  const DashboardApp({super.key, required this.api, required this.store});

  final ApiClient api;
  final BrowserSessionStore store;

  @override
  State<DashboardApp> createState() => _DashboardAppState();
}

class _DashboardAppState extends State<DashboardApp> {
  late final AuthRepository _auth = AuthRepository(
    api: widget.api,
    store: widget.store,
  );
  late final PeerRepository _peers = PeerRepository(api: widget.api);

  AccountUser? _user;
  bool _checking = true;

  @override
  void initState() {
    super.initState();
    // A token in sessionStorage is not trusted on its own; /auth/me confirms
    // the account still exists and is not disabled.
    widget.api.onSessionExpired = () {
      if (mounted) setState(() => _user = null);
    };
    _restore();
  }

  Future<void> _restore() async {
    try {
      if (await widget.store.readAccessToken() != null) {
        _user = await _auth.currentUser();
      }
    } on ApiException {
      await widget.store.clearSession();
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'VPN account',
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
      home: switch ((_checking, _user)) {
        (true, _) => const Scaffold(
          body: Center(child: CircularProgressIndicator()),
        ),
        (_, final AccountUser user) => DevicesPage(
          user: user,
          peers: _peers,
          auth: _auth,
          onSignedOut: () => setState(() => _user = null),
        ),
        _ => SignInPage(
          auth: _auth,
          onSignedIn: (user) => setState(() => _user = user),
        ),
      },
    );
  }
}
