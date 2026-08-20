/// The doctor app shell.
///
/// Three destinations, because a doctor on a ward round is doing one of three
/// things: looking at who they have to see, ordering something, or answering an
/// alert. The scribe and the chart are reached from a patient, not from the nav
/// bar, since neither means anything without one.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/api_client.dart';
import '../../core/auth_bloc.dart';
import '../../core/models.dart';
import '../../core/notification_service.dart';
import '../../core/sync_status.dart';
import '../../core/ui/widgets.dart';
import 'alerts_screen.dart';
import 'doctor_blocs.dart';
import 'orders_bloc.dart';
import 'orders_screen.dart';
import 'today_screen.dart';

class DoctorApp extends StatefulWidget {
  const DoctorApp({super.key});

  @override
  State<DoctorApp> createState() => _DoctorAppState();
}

class _DoctorAppState extends State<DoctorApp> {
  int _tab = 0;
  StreamSubscription<PushAlert>? _pushSub;

  @override
  void initState() {
    super.initState();
    // Registration happens after sign-in, so the token is filed against a known
    // clinician rather than an anonymous handset.
    final notifications = context.read<NotificationService>();
    unawaited(notifications.initialise());
    // A tapped alert lands on the alerts tab, which is where it can be acted on.
    _pushSub = notifications.onAlertTapped.listen((_) {
      if (mounted) setState(() => _tab = 2);
    });
  }

  @override
  void dispose() {
    unawaited(_pushSub?.cancel());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();

    return MultiBlocProvider(
      providers: [
        BlocProvider(create: (_) => TodayBloc(api: api)..add(const TodayRequested())),
        BlocProvider(create: (_) => AlertsBloc(api: api)..add(const AlertsRequested())),
      ],
      child: Builder(
        builder: (context) => Scaffold(
          appBar: AppBar(
            title: const Text('MediCore Doctor'),
            actions: [
              BlocBuilder<SyncStatusCubit, SyncStatus>(
                builder: (context, status) => SyncChip(
                  status: status,
                  onTap: () => context.read<SyncStatusCubit>().drain(),
                ),
              ),
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
              TodayScreen(),
              _OrdersLanding(),
              AlertsScreen(),
            ],
          ),
          bottomNavigationBar: BlocBuilder<AlertsBloc, AlertsState>(
            builder: (context, state) {
              final critical = state is AlertsReady ? state.criticalCount : 0;
              return NavigationBar(
                selectedIndex: _tab,
                onDestinationSelected: (index) => setState(() => _tab = index),
                destinations: [
                  const NavigationDestination(
                    icon: Icon(Icons.today_outlined),
                    selectedIcon: Icon(Icons.today),
                    label: 'Today',
                  ),
                  const NavigationDestination(
                    icon: Icon(Icons.add_chart_outlined),
                    selectedIcon: Icon(Icons.add_chart),
                    label: 'Orders',
                  ),
                  NavigationDestination(
                    icon: Badge(
                      isLabelVisible: critical > 0,
                      label: Text('$critical'),
                      child: const Icon(Icons.notifications_outlined),
                    ),
                    selectedIcon: const Icon(Icons.notifications_active),
                    label: 'Alerts',
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

/// Ordering needs a patient. Rather than an empty form, this asks for one.
class _OrdersLanding extends StatelessWidget {
  const _OrdersLanding();

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<TodayBloc, TodayState>(
      builder: (context, state) {
        if (state is! TodayReady) {
          return const Center(child: CircularProgressIndicator());
        }

        final patients = [
          ...state.inpatientsByAcuity,
          ...state.upcoming.map((a) => a.patient).whereType<Patient>(),
        ];

        if (patients.isEmpty) {
          return const EmptyState(
            icon: Icons.person_search,
            title: 'No patient selected',
            detail: 'Orders attach to a patient. Pick one from Today to begin.',
          );
        }

        return ListView(
          padding: const EdgeInsets.only(top: 8, bottom: 24),
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              child: Text(
                'Who is this order for?',
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            for (final patient in patients)
              PatientCard(
                patient: patient,
                vital: state.latestVitals[patient.id],
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => BlocProvider(
                      create: (_) => OrdersBloc(api: context.read<ApiClient>()),
                      child: OrdersScreen(
                        patientId: patient.id,
                        encounterId: null,
                        patientName: patient.fullName,
                      ),
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}
