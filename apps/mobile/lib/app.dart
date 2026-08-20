/// Bootstrap and the root widget, shared by all three flavours.
///
/// One codebase, three apps. What differs is the flavour config: which shell is
/// mounted, which colour the theme takes, and whether the app locks itself behind
/// a biometric on resume. What does not differ is everything below the shell —
/// the client, the queue, the sync state and the auth flow are identical, because
/// three copies of a token refresh is three places for it to go wrong.
library;

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:hive_flutter/hive_flutter.dart';

import 'apps/doctor/doctor_app.dart';
import 'apps/nurse/nurse_app.dart';
import 'apps/patient/patient_app.dart';
import 'core/api_client.dart';
import 'core/auth_bloc.dart';
import 'core/flavour.dart';
import 'core/notification_service.dart';
import 'core/offline_queue.dart';
import 'core/sync_status.dart';
import 'core/ui/login_screen.dart';

Future<void> bootstrap(FlavourConfig config) async {
  WidgetsFlutterBinding.ensureInitialized();
  FlavourConfig.current = config;

  await Hive.initFlutter();
  final box = await Hive.openBox<String>(OfflineQueue.boxName);
  final api = ApiClient(queue: OfflineQueue(box));

  // Push is best-effort. A build without Firebase configuration, or a device
  // where the user declined notifications, must still get a fully working app —
  // the in-app alerts screen is the durable channel and push is the nudge.
  final notifications = NotificationService(api: api);
  try {
    await Firebase.initializeApp();
  } catch (error) {
    debugPrint('Firebase not configured; push notifications are off: $error');
  }

  runApp(MediCoreApp(api: api, notifications: notifications));
}

class MediCoreApp extends StatelessWidget {
  const MediCoreApp({super.key, required this.api, required this.notifications});

  final ApiClient api;
  final NotificationService notifications;

  @override
  Widget build(BuildContext context) {
    return MultiRepositoryProvider(
      providers: [
        RepositoryProvider.value(value: api),
        RepositoryProvider.value(value: notifications),
      ],
      child: MultiBlocProvider(
        providers: [
          BlocProvider(create: (_) => AuthBloc(api: api)..add(const AuthStarted())),
          // Above the shell so every screen in every flavour can read it.
          BlocProvider(create: (_) => SyncStatusCubit(api: api)),
        ],
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
          localeResolutionCallback: (locale, supported) => supported.firstWhere(
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
            AppFlavour.doctor => const DoctorApp(),
            AppFlavour.nurse => const NurseApp(),
            AppFlavour.patient => const PatientApp(),
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
            Text(
              FlavourConfig.current.appName,
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 8),
            Text(
              'This device holds patient information.',
              style: TextStyle(color: Colors.grey.shade600),
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              icon: const Icon(Icons.fingerprint),
              label: const Text('Unlock'),
              onPressed: () => context.read<AuthBloc>().add(const AuthBiometricUnlockRequested()),
            ),
          ],
        ),
      ),
    );
  }
}
