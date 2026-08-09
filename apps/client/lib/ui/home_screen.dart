import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vpn_client/vpn_client.dart';
import 'package:vpn_tunnel/vpn_tunnel.dart';

import '../config.dart';
import 'kill_switch_screen.dart';
import 'widgets/message_banner.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  @override
  void initState() {
    super.initState();
    // Runs after the first frame so the tunnel plugin's platform channel is
    // ready and errors can be shown on a mounted widget.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) context.read<VpnController>().initialize();
    });
  }

  Future<void> _confirmForgetDevice() async {
    final vpn = context.read<VpnController>();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Remove this device?'),
        content: const Text(
          'This revokes the device on the server and deletes its key from this '
          'phone. Reconnecting registers a new device and uses one of your '
          'device slots.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );

    if (confirmed ?? false) await vpn.forgetDevice();
  }

  Future<void> _confirmDeleteAccount() async {
    final auth = context.read<AuthController>();
    final controller = TextEditingController();

    final password = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Delete your account?'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'This permanently deletes your account, all of your devices and '
              'their VPN keys. It cannot be undone.\n\n'
              'Enter your password to confirm.',
            ),
            const SizedBox(height: 16),
            TextField(
              controller: controller,
              obscureText: true,
              autofocus: true,
              decoration: const InputDecoration(
                labelText: 'Password',
                border: OutlineInputBorder(),
              ),
              onSubmitted: (value) => Navigator.pop(dialogContext, value),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(context).colorScheme.error,
            ),
            onPressed: () => Navigator.pop(dialogContext, controller.text),
            child: const Text('Delete forever'),
          ),
        ],
      ),
    );

    controller.dispose();
    if (password == null || password.isEmpty) return;

    // On success the auth gate swaps this screen out for the login screen;
    // on failure `auth.error` renders on the login screen's banner.
    await auth.deleteAccount(password: password);
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthController>();
    final vpn = context.watch<VpnController>();
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('VPN'),
        actions: [
          PopupMenuButton<String>(
            onSelected: (value) {
              if (value == 'killswitch') {
                Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => const KillSwitchScreen(),
                  ),
                );
              }
              if (value == 'forget') _confirmForgetDevice();
              if (value == 'logout') auth.logout();
              if (value == 'delete') _confirmDeleteAccount();
            },
            itemBuilder: (_) => [
              // Only Android exposes a system always-on VPN screen to send the
              // user to; offering it elsewhere would be a dead end.
              if (AppConfig.hasSystemVpnSettings)
                const PopupMenuItem(
                  value: 'killswitch',
                  child: ListTile(
                    leading: Icon(Icons.block_outlined),
                    title: Text('Kill switch'),
                    contentPadding: EdgeInsets.zero,
                  ),
                ),
              const PopupMenuItem(
                value: 'forget',
                child: ListTile(
                  leading: Icon(Icons.phonelink_erase_outlined),
                  title: Text('Remove this device'),
                  contentPadding: EdgeInsets.zero,
                ),
              ),
              const PopupMenuItem(
                value: 'logout',
                child: ListTile(
                  leading: Icon(Icons.logout),
                  title: Text('Sign out'),
                  contentPadding: EdgeInsets.zero,
                ),
              ),
              const PopupMenuDivider(),
              PopupMenuItem(
                value: 'delete',
                child: ListTile(
                  leading: Icon(
                    Icons.delete_forever_outlined,
                    color: theme.colorScheme.error,
                  ),
                  title: Text(
                    'Delete account',
                    style: TextStyle(color: theme.colorScheme.error),
                  ),
                  contentPadding: EdgeInsets.zero,
                ),
              ),
            ],
          ),
        ],
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            children: [
              if (vpn.error != null) ...[
                MessageBanner(message: vpn.error!, onDismiss: vpn.clearError),
                const SizedBox(height: 20),
              ],

              Expanded(
                child: Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      _ConnectButton(
                        connected: vpn.isConnected,
                        busy: vpn.isBusy,
                        onPressed: vpn.isBusy ? null : vpn.toggle,
                      ),
                      const SizedBox(height: 28),
                      Text(
                        vpn.statusLabel,
                        style: theme.textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                          color: _statusColor(theme, vpn),
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        vpn.isConnected
                            ? 'Your traffic is routed through the VPN.'
                            : 'Tap to connect.',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ),

              _DetailsCard(
                email: auth.user?.email ?? '',
                deviceLabel: vpn.device?.deviceLabel,
                region: vpn.device?.region,
                address: vpn.device?.allowedIp,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Color? _statusColor(ThemeData theme, VpnController vpn) {
    if (vpn.stage == TunnelStage.permissionDenied) return theme.colorScheme.error;
    if (vpn.isConnected) return const Color(0xFF1B873F);
    return theme.colorScheme.onSurface;
  }
}

class _ConnectButton extends StatelessWidget {
  const _ConnectButton({
    required this.connected,
    required this.busy,
    required this.onPressed,
  });

  final bool connected;
  final bool busy;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final background = connected ? const Color(0xFF1B873F) : scheme.primary;

    return Semantics(
      button: true,
      label: connected ? 'Disconnect from VPN' : 'Connect to VPN',
      child: GestureDetector(
        onTap: onPressed,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 220),
          height: 180,
          width: 180,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: onPressed == null
                ? background.withValues(alpha: 0.45)
                : background,
            boxShadow: [
              BoxShadow(
                color: background.withValues(alpha: 0.32),
                blurRadius: connected ? 36 : 18,
                spreadRadius: connected ? 4 : 0,
              ),
            ],
          ),
          child: Center(
            child: busy
                ? const SizedBox(
                    height: 44,
                    width: 44,
                    child: CircularProgressIndicator(
                      strokeWidth: 3,
                      color: Colors.white,
                    ),
                  )
                : Icon(
                    connected ? Icons.lock_outline : Icons.power_settings_new,
                    size: 64,
                    color: Colors.white,
                  ),
          ),
        ),
      ),
    );
  }
}

class _DetailsCard extends StatelessWidget {
  const _DetailsCard({
    required this.email,
    required this.deviceLabel,
    required this.region,
    required this.address,
  });

  final String email;
  final String? deviceLabel;
  final String? region;
  final String? address;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Column(
          children: [
            _row(context, Icons.person_outline, 'Account', email),
            _row(
              context,
              Icons.smartphone,
              'Device',
              deviceLabel ?? 'Not registered yet',
            ),
            _row(context, Icons.public, 'Region', region ?? '—'),
            _row(context, Icons.route_outlined, 'Tunnel IP', address ?? '—'),
          ],
        ),
      ),
    );
  }

  Widget _row(BuildContext context, IconData icon, String label, String value) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          Icon(icon, size: 18, color: theme.colorScheme.onSurfaceVariant),
          const SizedBox(width: 12),
          Text(label, style: theme.textTheme.bodyMedium),
          const Spacer(),
          Flexible(
            child: Text(
              value,
              textAlign: TextAlign.right,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
