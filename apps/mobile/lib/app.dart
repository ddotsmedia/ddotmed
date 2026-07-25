import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:hive_flutter/hive_flutter.dart';

import 'blocs/auth_bloc.dart';
import 'core/api_client.dart';
import 'core/flavour.dart';
import 'core/offline_queue.dart';
import 'screens/doctor_home.dart';
import 'screens/login_screen.dart';
import 'screens/nurse_home.dart';
import 'screens/patient_home.dart';

Future<void> bootstrap(FlavourConfig config) async {
  WidgetsFlutterBinding.ensureInitialized();
  FlavourConfig.current = config;

  await Hive.initFlutter();
  final box = await Hive.openBox<String>(OfflineQueue.boxName);
  final api = ApiClient(queue: OfflineQueue(box));

  runApp(MediCoreApp(api: api));
}

class MediCoreApp extends StatelessWidget {
  const MediCoreApp({super.key, required this.api});

  final ApiClient api;

  @override
  Widget build(BuildContext context) {
    return RepositoryProvider.value(
      value: api,
      child: BlocProvider(
        create: (_) => AuthBloc(api: api)..add(const AuthStarted()),
        child: MaterialApp(
          title: FlavourConfig.current.appName,
          debugShowCheckedModeBanner: false,
          theme: ThemeData(
            colorSchemeSeed: switch (FlavourConfig.current.flavour) {
              AppFlavour.doctor => const Color(0xFF0369A1),
              AppFlavour.nurse => const Color(0xFF047857),
              AppFlavour.patient => const Color(0xFF7C3AED),
            },
            useMaterial3: true,
          ),
          localizationsDelegates: const [
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          supportedLocales: const [
            Locale('en'),
            Locale('ar'),
            Locale('hi'),
            Locale('fr'),
            Locale('es'),
            Locale('zh'),
          ],
          // Arabic flips the whole app; Flutter handles this from the locale.
          localeResolutionCallback: (locale, supported) =>
              supported.firstWhere(
                (l) => l.languageCode == locale?.languageCode,
                orElse: () => const Locale('en'),
              ),
          home: const _Root(),
        ),
      ),
    );
  }
}

class _Root extends StatelessWidget {
  const _Root();

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<AuthBloc, AuthState>(
      builder: (context, state) => switch (state) {
        AuthLocked() => const _LockScreen(),
        AuthAuthenticated() => switch (FlavourConfig.current.flavour) {
            AppFlavour.doctor => const DoctorHome(),
            AppFlavour.nurse => const NurseHome(),
            AppFlavour.patient => const PatientHome(),
          },
        _ => const LoginScreen(),
      },
    );
  }
}

class _LockScreen extends StatelessWidget {
  const _LockScreen();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.lock_outline, size: 64),
            const SizedBox(height: 16),
            Text(FlavourConfig.current.appName,
                style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 24),
            FilledButton.icon(
              icon: const Icon(Icons.fingerprint),
              label: const Text('Unlock'),
              onPressed: () => context
                  .read<AuthBloc>()
                  .add(const AuthBiometricUnlockRequested()),
            ),
          ],
        ),
      ),
    );
  }
}
