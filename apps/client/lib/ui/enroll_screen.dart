import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:vpn_client/vpn_client.dart';

import '../config.dart';
import 'widgets/message_banner.dart';

/// Two fields and a button: where the server is, and the code that lets this
/// device on. That is the whole of setting the app up — there is no account to
/// create, so there is nothing else to ask for.
class EnrollScreen extends StatefulWidget {
  const EnrollScreen({super.key});

  @override
  State<EnrollScreen> createState() => _EnrollScreenState();
}

class _EnrollScreenState extends State<EnrollScreen> {
  final _formKey = GlobalKey<FormState>();
  final _codeController = TextEditingController();

  @override
  void dispose() {
    _codeController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;

    await context.read<EnrollController>().enrol(
      inviteToken: _codeController.text,
      label: AppConfig.deviceLabel,
      platform: AppConfig.devicePlatform,
    );
  }

  @override
  Widget build(BuildContext context) {
    final enrol = context.watch<EnrollController>();
    final address = context.watch<VpnServerAddress>();
    final theme = Theme.of(context);

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Icon(
                      Icons.shield_outlined,
                      size: 56,
                      color: theme.colorScheme.primary,
                    ),
                    const SizedBox(height: 16),
                    Text(
                      'Set up this device',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.headlineSmall?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Enter the invite code from whoever runs your server.',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 28),

                    if (enrol.error != null) ...[
                      MessageBanner(
                        message: enrol.error!,
                        onDismiss: enrol.clearError,
                      ),
                      const SizedBox(height: 16),
                    ],

                    TextFormField(
                      controller: _codeController,
                      enabled: !enrol.isBusy,
                      autocorrect: false,
                      autofocus: true,
                      textInputAction: TextInputAction.done,
                      onFieldSubmitted: (_) => _submit(),
                      decoration: const InputDecoration(
                        labelText: 'Invite code',
                        hintText: 'vpninv_…',
                        prefixIcon: Icon(Icons.vpn_key_outlined),
                        border: OutlineInputBorder(),
                      ),
                      validator: (value) => (value ?? '').trim().isEmpty
                          ? 'Enter the invite code you were given'
                          : null,
                    ),
                    const SizedBox(height: 24),

                    FilledButton(
                      onPressed: enrol.isBusy ? null : _submit,
                      style: FilledButton.styleFrom(
                        padding: const EdgeInsets.symmetric(vertical: 16),
                      ),
                      child: enrol.isBusy
                          ? const SizedBox(
                              height: 20,
                              width: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text('Connect this device'),
                    ),

                    const Divider(height: 40),

                    // Shown rather than hidden behind a menu: an invite code is
                    // useless against the wrong server, and "it says the code
                    // is invalid" is almost always this.
                    Row(
                      children: [
                        Icon(
                          Icons.dns_outlined,
                          size: 16,
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Server',
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                              Text(
                                address.current,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.bodySmall,
                              ),
                            ],
                          ),
                        ),
                        TextButton(
                          onPressed: enrol.isBusy
                              ? null
                              : () => _editAddress(context, address),
                          child: const Text('Change'),
                        ),
                      ],
                    ),

                    const SizedBox(height: 16),
                    Text(
                      'Your key is generated here and never leaves this device. '
                      'The server only ever sees its public half.',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _editAddress(
    BuildContext context,
    VpnServerAddress address,
  ) async {
    final controller = TextEditingController(text: address.current);
    final entered = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Server address'),
        content: TextField(
          controller: controller,
          autofocus: true,
          keyboardType: TextInputType.url,
          autocorrect: false,
          decoration: const InputDecoration(
            hintText: 'https://vpn.example.com',
            border: OutlineInputBorder(),
          ),
          onSubmitted: (value) => Navigator.pop(dialogContext, value),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, controller.text),
            child: const Text('Save'),
          ),
        ],
      ),
    );

    controller.dispose();
    if (entered == null || !context.mounted) return;

    try {
      await address.change(entered);
    } on ServerAddressError catch (error) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.message)));
      }
    }
  }
}
