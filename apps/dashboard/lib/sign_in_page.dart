import 'package:flutter/material.dart';
import 'package:vpn_api/vpn_api.dart';

class SignInPage extends StatefulWidget {
  const SignInPage({super.key, required this.auth, required this.onSignedIn});

  final AuthRepository auth;
  final ValueChanged<AccountUser> onSignedIn;

  @override
  State<SignInPage> createState() => _SignInPageState();
}

class _SignInPageState extends State<SignInPage> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();

  bool _busy = false;
  bool _registering = false;
  String? _error;

  /// The server rejects anything shorter, and finding that out from a 400
  /// after typing a password is worse than being told up front.
  static const _minPasswordLength = 10;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  void _toggleMode() {
    setState(() {
      _registering = !_registering;
      // The old error described the other mode and would read as a failure of
      // the one just switched to.
      _error = null;
    });
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final email = _email.text.trim();
      final user = _registering
          ? await widget.auth.register(email: email, password: _password.text)
          : await widget.auth.login(email: email, password: _password.text);
      widget.onSignedIn(user);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 380),
            child: Form(
              key: _formKey,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Icon(
                    Icons.shield_outlined,
                    size: 48,
                    color: theme.colorScheme.primary,
                  ),
                  const SizedBox(height: 16),
                  Text(
                    _registering ? 'Create your account' : 'Manage your devices',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    _registering
                        ? 'One account covers every device. Add them from the '
                              'app once you have signed in there.'
                        : 'Sign in to see the devices on your account and '
                              'remove any you no longer have.',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 28),

                  if (_error != null) ...[
                    _ErrorBanner(message: _error!),
                    const SizedBox(height: 16),
                  ],

                  TextFormField(
                    controller: _email,
                    enabled: !_busy,
                    keyboardType: TextInputType.emailAddress,
                    autofillHints: const [AutofillHints.email],
                    decoration: const InputDecoration(
                      labelText: 'Email',
                      border: OutlineInputBorder(),
                    ),
                    validator: (v) =>
                        (v ?? '').trim().isEmpty ? 'Enter your email' : null,
                  ),
                  const SizedBox(height: 14),
                  TextFormField(
                    controller: _password,
                    enabled: !_busy,
                    obscureText: true,
                    autofillHints: _registering
                        ? const [AutofillHints.newPassword]
                        : const [AutofillHints.password],
                    onFieldSubmitted: (_) => _submit(),
                    decoration: InputDecoration(
                      labelText: 'Password',
                      border: const OutlineInputBorder(),
                      helperText: _registering
                          ? 'At least $_minPasswordLength characters'
                          : null,
                    ),
                    validator: (v) {
                      final value = v ?? '';
                      if (value.isEmpty) return 'Enter your password';
                      // Only on the way in: an existing account may predate
                      // this rule, and refusing to even try would lock its
                      // owner out of a page that would have let them in.
                      if (_registering && value.length < _minPasswordLength) {
                        return 'At least $_minPasswordLength characters';
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 22),

                  FilledButton(
                    onPressed: _busy ? null : _submit,
                    style: FilledButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 15),
                    ),
                    child: _busy
                        ? const SizedBox(
                            height: 18,
                            width: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : Text(_registering ? 'Create account' : 'Sign in'),
                  ),

                  const SizedBox(height: 8),
                  TextButton(
                    onPressed: _busy ? null : _toggleMode,
                    child: Text(
                      _registering
                          ? 'I already have an account'
                          : 'Create a new account',
                    ),
                  ),

                  const SizedBox(height: 12),
                  Text(
                    'This page cannot connect to the VPN — a browser cannot '
                    'open a tunnel. Install the app to connect.',
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
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.errorContainer,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline, size: 18, color: scheme.onErrorContainer),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: TextStyle(color: scheme.onErrorContainer),
            ),
          ),
        ],
      ),
    );
  }
}
