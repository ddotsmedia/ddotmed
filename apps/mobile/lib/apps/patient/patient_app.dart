/// The patient app shell.
///
/// Four destinations, named in the words a patient would use rather than the
/// words a hospital would: Home, Appointments, Records, Payments.
library;

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/api_client.dart';
import '../../core/auth_bloc.dart';
import 'appointments_screen.dart';
import 'dashboard_screen.dart';
import 'patient_blocs.dart';
import 'payments_screen.dart';
import 'records_screen.dart';
import 'wearable_service.dart';

class PatientApp extends StatefulWidget {
  const PatientApp({super.key});

  @override
  State<PatientApp> createState() => _PatientAppState();
}

class _PatientAppState extends State<PatientApp> {
  int _tab = 0;
  final _wearables = WearableService();

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();

    return MultiBlocProvider(
      providers: [
        BlocProvider(
          create: (_) {
            final bloc = PatientDashboardBloc(api: api)..add(const PatientDashboardRequested());
            // Health data is read after the record loads and never blocks it —
            // a permission prompt must not be the first thing the app does.
            _wearables.read().then((summary) {
              if (!bloc.isClosed) bloc.add(WearableDataReceived(summary));
            });
            return bloc;
          },
        ),
        BlocProvider(create: (_) => RecordsBloc(api: api)..add(const RecordsRequested())),
        BlocProvider(create: (_) => PaymentsBloc(api: api)..add(const PaymentsRequested())),
      ],
      child: Builder(
        builder: (context) => Scaffold(
          appBar: AppBar(
            title: Text(
              switch (_tab) {
                0 => 'MediCore',
                1 => 'Appointments',
                2 => 'Your records',
                _ => 'Payments',
              },
            ),
            actions: [
              IconButton(
                icon: const Icon(Icons.logout),
                tooltip: 'Sign out',
                onPressed: () => context.read<AuthBloc>().add(const AuthSignOutRequested()),
              ),
            ],
          ),
          body: IndexedStack(
            index: _tab,
            children: const [
              PatientDashboardScreen(),
              PatientAppointmentsScreen(),
              RecordsScreen(),
              PaymentsScreen(),
            ],
          ),
          bottomNavigationBar: NavigationBar(
            selectedIndex: _tab,
            onDestinationSelected: (index) => setState(() => _tab = index),
            destinations: const [
              NavigationDestination(
                icon: Icon(Icons.home_outlined),
                selectedIcon: Icon(Icons.home),
                label: 'Home',
              ),
              NavigationDestination(
                icon: Icon(Icons.event_outlined),
                selectedIcon: Icon(Icons.event),
                label: 'Appointments',
              ),
              NavigationDestination(
                icon: Icon(Icons.folder_outlined),
                selectedIcon: Icon(Icons.folder),
                label: 'Records',
              ),
              NavigationDestination(
                icon: Icon(Icons.payments_outlined),
                selectedIcon: Icon(Icons.payments),
                label: 'Payments',
              ),
            ],
          ),
        ),
      ),
    );
  }
}
