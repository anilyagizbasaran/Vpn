import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:vpn_client/vpn_client.dart';

import 'theme.dart';
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
  final _addressController = TextEditingController();

  /// Set when the address is rejected, so the message lands under the field
  /// that caused it rather than in the banner enrolment errors use.
  String? _addressError;

  @override
  void initState() {
    super.initState();
    _addressController.text = context.read<VpnServerAddress>().current;
  }

  @override
  void dispose() {
    _codeController.dispose();
    _addressController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() => _addressError = null);
    if (!(_formKey.currentState?.validate() ?? false)) return;

    // The address moves first. A code means nothing against the wrong server,
    // and enrolling before the address changed would spend it on whatever the
    // app happened to be pointing at.
    try {
      await context.read<VpnServerAddress>().change(_addressController.text);
    } on ServerAddressError catch (error) {
      setState(() => _addressError = error.message);
      return;
    }

    if (!mounted) return;
    await context.read<EnrollController>().enrol(
      inviteToken: _codeController.text,
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
                    // Centered rather than left to the column: the parent
                    // stretches its children, which would turn a 56x56 circle
                    // into a full-width oval.
                    Center(
                      child: Container(
                        height: 56,
                        width: 56,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: VpnColors.accent.withValues(alpha: 0.12),
                        ),
                        child: const Icon(
                          Icons.shield_outlined,
                          size: 28,
                          color: VpnColors.accent,
                        ),
                      ),
                    ),
                    const SizedBox(height: 18),
                    Text(
                      'Set up this device',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'Enter your server address and the code it printed.',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                        height: 1.4,
                      ),
                    ),
                    const SizedBox(height: 24),

                    if (enrol.error != null) ...[
                      MessageBanner(
                        message: enrol.error!,
                        onDismiss: enrol.clearError,
                      ),
                      const SizedBox(height: 16),
                    ],

                    // Asked for, not assumed: everyone who runs this has their
                    // own server, so there is no address worth compiling in.
                    // See AppConfig.apiBaseUrl.
                    TextFormField(
                      controller: _addressController,
                      enabled: !enrol.isBusy,
                      autocorrect: false,
                      autofocus: !address.isConfigured,
                      keyboardType: TextInputType.url,
                      textInputAction: TextInputAction.next,
                      decoration: InputDecoration(
                        labelText: 'Server address',
                        hintText: 'https://vpn.example.com',
                        prefixIcon: const Icon(Icons.dns_outlined),
                        border: const OutlineInputBorder(),
                        errorText: _addressError,
                      ),
                      validator: (value) => (value ?? '').trim().isEmpty
                          ? 'Enter the address your server printed'
                          : null,
                    ),
                    const SizedBox(height: 16),

                    TextFormField(
                      controller: _codeController,
                      enabled: !enrol.isBusy,
                      autocorrect: false,
                      autofocus: address.isConfigured,
                      textInputAction: TextInputAction.done,
                      onFieldSubmitted: (_) => _submit(),
                      decoration: const InputDecoration(
                        labelText: 'Invite code',
                        hintText: 'ABCD123456',
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

                    const SizedBox(height: 24),
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
}
