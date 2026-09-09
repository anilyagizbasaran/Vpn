import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vpn_api/vpn_api.dart';
import 'package:vpn_client/vpn_client.dart';
import 'package:vpn_tunnel/vpn_tunnel.dart';

import 'theme.dart';
import 'widgets/message_banner.dart';

/// The whole app, on one screen: a switch, what it is doing, and where.
///
/// Laid out for a 380-wide window rather than a page. Everything is in one
/// column with no scrolling, because a VPN client that needs scrolling to
/// reach its own button is asking too much of somebody who opened it to press
/// one thing.
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

  /// Removes this device from the server and forgets it here.
  ///
  /// What used to be "delete your account" — there is no account to delete,
  /// and no password to confirm with. Removing the device is the whole of it:
  /// the code stays valid, so the same person can set the device up again.
  Future<void> _confirmRemoveDevice() async {
    final enrol = context.read<EnrollController>();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Remove this device?'),
        content: const Text(
          'This device stops being able to connect, and its key is deleted '
          'from this computer. Your code still works, so you can set it up '
          'again.',
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

    if (confirmed ?? false) await enrol.removeDevice();
  }

  @override
  Widget build(BuildContext context) {
    final vpn = context.watch<VpnController>();

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 20,
        title: const Text('VPN'),
        actions: [_menu(context), const SizedBox(width: 8)],
      ),
      body: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: Column(
            children: [
              if (vpn.error != null) ...[
                MessageBanner(message: vpn.error!, onDismiss: vpn.clearError),
                const SizedBox(height: 12),
              ],

              // Centred while there is room, scrollable when there is not.
              // Browser-only mode is the crowded state — a mode switch, a
              // longer explanation and an extra row in the card — and on a
              // narrow window that came to eighty-two pixels more than the
              // screen had. Overflowing paints a striped bar over the button
              // the user opened the app to press; scrolling keeps it
              // reachable, and on an ordinary window nothing moves.
              Expanded(
                child: LayoutBuilder(
                  builder: (context, constraints) => SingleChildScrollView(
                    child: ConstrainedBox(
                      constraints: BoxConstraints(
                        minHeight: constraints.maxHeight,
                      ),
                      child: Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            _PowerButton(
                              connected: vpn.isActive,
                              busy: vpn.isBusy,
                              failed: vpn.stage == TunnelStage.failed,
                              onPressed: vpn.isBusy ? null : vpn.toggle,
                            ),
                            const SizedBox(height: 26),
                            _StatusLine(vpn: vpn),
                            if (vpn.supportsBrowserOnly) ...[
                              const SizedBox(height: 22),
                              _ModeSwitch(vpn: vpn),
                            ],
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),

              _ConnectionCard(
                serverAddress: context.watch<VpnServerAddress>().current,
                region: vpn.regionLabel,
                publicAddress: vpn.publicAddress,
                checking: vpn.checkingAddress,
                connected: vpn.isConnected,
                browserProxy: vpn.browserTunnel.endpoint,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _menu(BuildContext context) {
    final theme = Theme.of(context);
    return PopupMenuButton<String>(
      icon: const Icon(Icons.more_horiz),
      tooltip: 'More',
      position: PopupMenuPosition.under,
      onSelected: (value) {
        if (value == 'remove') _confirmRemoveDevice();
      },
      itemBuilder: (_) => [
        PopupMenuItem(
          value: 'remove',
          height: 40,
          child: Text(
            'Remove this device',
            style: TextStyle(color: theme.colorScheme.error),
          ),
        ),
      ],
    );
  }
}

/// Two lines under the button: what is happening, and what that means.
class _StatusLine extends StatelessWidget {
  const _StatusLine({required this.vpn});

  final VpnController vpn;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final browserOnly = vpn.browserTunnel.running;
    final connected = vpn.isActive;

    final Color colour;
    if (vpn.stage == TunnelStage.permissionDenied ||
        vpn.stage == TunnelStage.failed) {
      colour = theme.colorScheme.error;
    } else if (connected) {
      colour = VpnColors.connected;
    } else {
      colour = theme.colorScheme.onSurface;
    }

    return Column(
      children: [
        Text(
          vpn.statusLabel.toUpperCase(),
          textAlign: TextAlign.center,
          style: TextStyle(
            color: colour,
            fontSize: 13,
            fontWeight: FontWeight.w700,
            letterSpacing: 1.4,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          // Three states, not two. Saying "all traffic" in browser-only mode
          // would be the one sentence on this screen that is actively false —
          // everything except the browser is on the ordinary connection, on
          // purpose, and the user chose that.
          browserOnly
              ? 'Your browser goes through the VPN. Nothing else on this '
                    'computer does.'
              : connected
              ? 'All traffic on this computer goes through the VPN.'
              : 'Your traffic is not protected.',
          textAlign: TextAlign.center,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
            height: 1.4,
          ),
        ),
      ],
    );
  }
}

/// Chooses what the power button protects.
///
/// Locked while either tunnel is up, because the two exclude each other and
/// the service refuses to run both. Switching silently would mean taking one
/// down to start the other, with a gap in between that nobody asked for.
class _ModeSwitch extends StatelessWidget {
  const _ModeSwitch({required this.vpn});

  final VpnController vpn;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final locked = vpn.isActive || vpn.isBusy;

    return Column(
      children: [
        SegmentedButton<VpnMode>(
          segments: const [
            ButtonSegment(
              value: VpnMode.system,
              icon: Icon(Icons.computer_outlined, size: 18),
              label: Text('Whole computer'),
            ),
            ButtonSegment(
              value: VpnMode.browser,
              icon: Icon(Icons.public_outlined, size: 18),
              label: Text('Browser only'),
            ),
          ],
          selected: {vpn.mode},
          showSelectedIcon: false,
          onSelectionChanged: locked
              ? null
              : (selection) => vpn.setMode(selection.first),
          style: const ButtonStyle(
            visualDensity: VisualDensity.compact,
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
        ),
        if (locked) ...[
          const SizedBox(height: 8),
          Text(
            'Disconnect to change this.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ] else if (vpn.mode == VpnMode.browser) ...[
          const SizedBox(height: 8),
          Text(
            'No network settings are changed. Only your browser is tunnelled.',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
              height: 1.4,
            ),
          ),
        ],
      ],
    );
  }
}

/// The switch. One target, large enough to hit without looking.
class _PowerButton extends StatelessWidget {
  const _PowerButton({
    required this.connected,
    required this.busy,
    required this.failed,
    required this.onPressed,
  });

  final bool connected;
  final bool busy;
  final bool failed;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final Color colour;
    if (failed) {
      colour = theme.colorScheme.error;
    } else if (connected) {
      colour = VpnColors.connected;
    } else {
      colour = VpnColors.accent;
    }

    final enabled = onPressed != null;

    return Semantics(
      button: true,
      label: connected ? 'Disconnect' : 'Connect',
      child: MouseRegion(
        cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
        child: GestureDetector(
          onTap: onPressed,
          child: SizedBox(
            height: 168,
            width: 168,
            child: Stack(
              alignment: Alignment.center,
              children: [
                // A ring rather than a filled disc: the glow reads as "on"
                // from the corner of an eye, and a solid 168px circle of
                // colour is a lot of screen for a window this size.
                AnimatedContainer(
                  duration: const Duration(milliseconds: 260),
                  height: 168,
                  width: 168,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: colour.withValues(alpha: connected ? 0.55 : 0.25),
                      width: 1.5,
                    ),
                    boxShadow: connected
                        ? [
                            BoxShadow(
                              color: colour.withValues(alpha: 0.22),
                              blurRadius: 32,
                              spreadRadius: 2,
                            ),
                          ]
                        : null,
                  ),
                ),
                AnimatedContainer(
                  duration: const Duration(milliseconds: 260),
                  height: 124,
                  width: 124,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: enabled ? colour : colour.withValues(alpha: 0.35),
                  ),
                  child: Center(
                    child: busy
                        ? const SizedBox(
                            height: 34,
                            width: 34,
                            child: CircularProgressIndicator(
                              strokeWidth: 2.5,
                              color: Colors.white,
                            ),
                          )
                        : Icon(
                            connected
                                ? Icons.shield_outlined
                                : Icons.power_settings_new_rounded,
                            size: 46,
                            color: Colors.white,
                          ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Where you are connected, in three lines that fit the width.
class _ConnectionCard extends StatelessWidget {
  const _ConnectionCard({
    required this.serverAddress,
    required this.region,
    required this.publicAddress,
    required this.checking,
    required this.connected,
    required this.browserProxy,
  });

  final String serverAddress;
  final String? region;
  final PublicAddress? publicAddress;
  final bool checking;
  final bool connected;

  /// `host:port` while browser-only mode is on, otherwise null.
  final String? browserProxy;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
        child: Column(
          children: [
            _Row(
              icon: Icons.dns_outlined,
              label: 'Server',
              value: _host(serverAddress),
            ),
            const Divider(height: 1),
            _Row(icon: Icons.public, label: 'Region', value: region ?? '—'),
            const Divider(height: 1),
            // The line people actually check. `throughTunnel` is the server
            // saying the request reached it through the tunnel, so a green
            // address is confirmation rather than a restatement of the stage
            // the app already thinks it is in.
            _Row(
              icon: connected ? Icons.lock_outline : Icons.location_on_outlined,
              // In browser-only mode this address is measured by the app,
              // which is not the browser and is not proxied. Labelling it
              // "This computer" says so: the real address here alongside a
              // tunnelled browser is the mode working, not failing.
              label: browserProxy != null
                  ? 'This computer'
                  : connected
                  ? 'VPN IP'
                  : 'Your IP',
              value: checking && publicAddress == null
                  ? 'Checking...'
                  : (publicAddress?.ip ?? '—'),
              highlight: publicAddress?.throughTunnel ?? false,
            ),
            if (browserProxy != null) ...[
              const Divider(height: 1),
              _Row(
                icon: Icons.swap_horiz,
                label: 'Browser proxy',
                value: browserProxy!,
              ),
            ],
          ],
        ),
      ),
    );
  }

  /// `https://vpn.example.com` reads as `vpn.example.com`. The scheme is the
  /// same on every row it could ever show, so it is 8 characters of nothing.
  static String _host(String url) {
    final parsed = Uri.tryParse(url);
    if (parsed == null || parsed.host.isEmpty) return url;
    return parsed.hasPort ? '${parsed.host}:${parsed.port}' : parsed.host;
  }
}

class _Row extends StatelessWidget {
  const _Row({
    required this.icon,
    required this.label,
    required this.value,
    this.highlight = false,
  });

  final IconData icon;
  final String label;
  final String value;

  /// Drawn in the connected colour. Used for the one value that is a claim
  /// about the outside world rather than a setting.
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 11),
      child: Row(
        children: [
          Icon(icon, size: 16, color: theme.colorScheme.onSurfaceVariant),
          const SizedBox(width: 10),
          Text(
            label,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const Spacer(),
          Flexible(
            child: Text(
              value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.right,
              style: theme.textTheme.bodySmall?.copyWith(
                fontWeight: highlight ? FontWeight.w600 : FontWeight.w500,
                color: highlight ? VpnColors.connected : null,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
