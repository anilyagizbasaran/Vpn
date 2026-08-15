import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vpn_client/vpn_client.dart';

import '../config.dart';
import 'widgets/message_banner.dart';

/// Walks the user into Android's own always-on VPN setting.
///
/// This is deliberately instructions plus a shortcut rather than an in-app
/// toggle: the OS setting is enforced below every app and cannot leak, while
/// an in-app VpnService kill switch always has a gap when the tunnel drops.
class KillSwitchScreen extends StatefulWidget {
  const KillSwitchScreen({super.key});

  @override
  State<KillSwitchScreen> createState() => _KillSwitchScreenState();
}

class _KillSwitchScreenState extends State<KillSwitchScreen> {
  String? _error;

  Future<void> _open() async {
    final opened = await context.read<SystemSettings>().openVpnSettings();
    if (!mounted) return;
    setState(() {
      _error = opened
          ? null
          : 'This device has no VPN settings screen to open. Follow the steps '
                'below in the Settings app instead.';
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('Kill switch')),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          Text(
            'Block traffic when the VPN drops',
            style: theme.textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 12),
          Text(
            'Android can block all traffic whenever the tunnel is down. It is '
            'enforced by the system itself, so nothing can slip past it — not '
            'even while this app restarts.',
            style: theme.textTheme.bodyMedium?.copyWith(height: 1.45),
          ),
          const SizedBox(height: 24),

          if (_error != null) ...[
            MessageBanner(
              message: _error!,
              icon: Icons.info_outline,
              onDismiss: () => setState(() => _error = null),
            ),
            const SizedBox(height: 20),
          ],

          const _Step(
            number: 1,
            text:
                'Open VPN settings and tap the gear next to "${AppConfig.vpnName}".',
          ),
          const _Step(number: 2, text: 'Turn on "Always-on VPN".'),
          const _Step(
            number: 3,
            text: 'Turn on "Block connections without VPN".',
          ),
          const SizedBox(height: 24),

          FilledButton.icon(
            onPressed: _open,
            icon: const Icon(Icons.settings_outlined),
            style: FilledButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 16),
            ),
            label: const Text('Open VPN settings'),
          ),
          const SizedBox(height: 20),

          Card(
            margin: EdgeInsets.zero,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.lightbulb_outline,
                    size: 20,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      'Connect once before turning this on, so the VPN profile '
                      'appears in the list. With "Block connections without '
                      'VPN" enabled you will have no internet until the tunnel '
                      'comes up.',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                        height: 1.4,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Step extends StatelessWidget {
  const _Step({required this.number, required this.text});

  final int number;
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CircleAvatar(
            radius: 13,
            backgroundColor: theme.colorScheme.primaryContainer,
            child: Text(
              '$number',
              style: theme.textTheme.labelMedium?.copyWith(
                color: theme.colorScheme.onPrimaryContainer,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text(
                text,
                style: theme.textTheme.bodyMedium?.copyWith(height: 1.4),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
