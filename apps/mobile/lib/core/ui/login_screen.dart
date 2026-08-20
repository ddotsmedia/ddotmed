import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../auth_bloc.dart';
import '../flavour.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _tenant = TextEditingController(text: 'demo');
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _code = TextEditingController();

  @override
  void dispose() {
    _tenant.dispose();
    _email.dispose();
    _password.dispose();
    _code.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: BlocBuilder<AuthBloc, AuthState>(
          builder: (context, state) {
            final mfa = state is AuthMfaRequired;
            return ListView(
              padding: const EdgeInsets.all(24),
              children: [
                const SizedBox(height: 48),
                Text(
                  FlavourConfig.current.appName,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
                const SizedBox(height: 32),
                if (!mfa) ...[
                  TextField(
                    controller: _tenant,
                    decoration:
                        const InputDecoration(labelText: 'Facility', border: OutlineInputBorder()),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _email,
                    keyboardType: TextInputType.emailAddress,
                    autofillHints: const [AutofillHints.username],
                    decoration:
                        const InputDecoration(labelText: 'Email', border: OutlineInputBorder()),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _password,
                    obscureText: true,
                    autofillHints: const [AutofillHints.password],
                    decoration:
                        const InputDecoration(labelText: 'Password', border: OutlineInputBorder()),
                  ),
                ] else
                  TextField(
                    controller: _code,
                    keyboardType: TextInputType.number,
                    autofillHints: const [AutofillHints.oneTimeCode],
                    decoration: const InputDecoration(
                      labelText: 'Authentication code',
                      border: OutlineInputBorder(),
                    ),
                  ),
                const SizedBox(height: 20),
                if (state is AuthFailure)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Text(
                      state.message,
                      style: TextStyle(color: Theme.of(context).colorScheme.error),
                    ),
                  ),
                FilledButton(
                  onPressed: state is AuthLoading
                      ? null
                      : () => context.read<AuthBloc>().add(
                            mfa
                                ? AuthMfaSubmitted(_code.text)
                                : AuthLoginRequested(_tenant.text, _email.text, _password.text),
                          ),
                  child: Text(state is AuthLoading ? '…' : (mfa ? 'Verify' : 'Sign in')),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}
