import 'package:flutter/material.dart';
import 'package:vpn_api/vpn_api.dart';

/// The reason this dashboard exists: revoking a device you no longer have.
///
/// The app can do it too, but not from a phone that was stolen — which is
/// exactly when it matters.
class DevicesPage extends StatefulWidget {
  const DevicesPage({
    super.key,
    required this.user,
    required this.peers,
    required this.auth,
    required this.onSignedOut,
  });

  final AccountUser user;
  final PeerRepository peers;
  final AuthRepository auth;
  final VoidCallback onSignedOut;

  @override
  State<DevicesPage> createState() => _DevicesPageState();
}

class _DevicesPageState extends State<DevicesPage> {
  List<Peer>? _devices;
  String? _error;
  int? _revoking;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final devices = await widget.peers.list();
      if (mounted) setState(() => _devices = devices);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    }
  }

  Future<void> _revoke(Peer peer) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('Remove ${peer.deviceLabel}?'),
        content: const Text(
          'The device loses access immediately and its key stops working. If '
          'you still have it, the app will register it again the next time it '
          'connects.',
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
    if (confirmed != true) return;

    setState(() => _revoking = peer.id);
    try {
      await widget.peers.revoke(peer.id);
      await _load();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _revoking = null);
    }
  }

  Future<void> _signOut() async {
    await widget.auth.logout();
    widget.onSignedOut();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final devices = _devices;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Your devices'),
        actions: [
          IconButton(
            onPressed: _load,
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh',
          ),
          TextButton.icon(
            onPressed: _signOut,
            icon: const Icon(Icons.logout, size: 18),
            label: const Text('Sign out'),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 720),
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              Text(widget.user.email, style: theme.textTheme.titleMedium),
              const SizedBox(height: 4),
              Text(
                'Removing a device here frees a slot and revokes its VPN key '
                'on the server.',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 20),

              if (_error != null) ...[
                Card(
                  color: theme.colorScheme.errorContainer,
                  margin: EdgeInsets.zero,
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Text(
                      _error!,
                      style: TextStyle(color: theme.colorScheme.onErrorContainer),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
              ],

              if (devices == null)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 40),
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (devices.isEmpty)
                _EmptyState()
              else
                ...devices.map(
                  (peer) => _DeviceTile(
                    peer: peer,
                    busy: _revoking == peer.id,
                    onRemove: () => _revoke(peer),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DeviceTile extends StatelessWidget {
  const _DeviceTile({
    required this.peer,
    required this.busy,
    required this.onRemove,
  });

  final Peer peer;
  final bool busy;
  final VoidCallback onRemove;

  /// `unknown` covers peers created before the server recorded a platform, so
  /// it needs an icon rather than a blank.
  static const _icons = {
    'android': Icons.phone_android,
    'ios': Icons.phone_iphone,
    'windows': Icons.desktop_windows_outlined,
    'macos': Icons.laptop_mac,
    'linux': Icons.dvr_outlined,
    'unknown': Icons.devices_other,
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        leading: Icon(_icons[peer.platform] ?? Icons.devices_other),
        title: Text(peer.deviceLabel),
        subtitle: Text(
          '${peer.region} · ${peer.allowedIp}'
          '${peer.keyRotatedAt != null ? ' · key rotated' : ''}',
          style: theme.textTheme.bodySmall,
        ),
        trailing: busy
            ? const SizedBox(
                height: 18,
                width: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : IconButton(
                onPressed: onRemove,
                icon: const Icon(Icons.delete_outline),
                tooltip: 'Remove this device',
              ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 48),
      child: Column(
        children: [
          Icon(
            Icons.devices_other,
            size: 40,
            color: theme.colorScheme.onSurfaceVariant,
          ),
          const SizedBox(height: 12),
          Text('No devices yet', style: theme.textTheme.titleMedium),
          const SizedBox(height: 4),
          Text(
            'Install the app and connect once; the device appears here.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}
