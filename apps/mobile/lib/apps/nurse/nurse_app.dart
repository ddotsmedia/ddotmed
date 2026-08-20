/// The nurse app shell.
///
/// Four destinations matching the shape of a shift: what is due, the drug round,
/// observations, and the handover at the end. eMAR is reached through a patient
/// because it cannot mean anything without one — the wristband scan is the first
/// step, not an afterthought.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/api_client.dart';
import '../../core/auth_bloc.dart';
import '../../core/biometric_auth.dart';
import '../../core/models.dart';
import '../../core/notification_service.dart';
import '../../core/sync_status.dart';
import '../../core/ui/widgets.dart';
import 'emar_bloc.dart';
import 'emar_screen.dart';
import 'handover_bloc.dart';
import 'handover_screen.dart';
import 'task_board_bloc.dart';
import 'task_board_screen.dart';
import 'vitals_bloc.dart';
import 'vitals_screen.dart';

/// Which ward this device is working. Configured per deployment; a real build
/// reads it from the signed-in user's assignment.
const _defaultWard = String.fromEnvironment('WARD', defaultValue: 'WARD3');

class NurseApp extends StatefulWidget {
  const NurseApp({super.key});

  @override
  State<NurseApp> createState() => _NurseAppState();
}

class _NurseAppState extends State<NurseApp> {
  int _tab = 0;
  StreamSubscription<PushAlert>? _pushSub;

  @override
  void initState() {
    super.initState();
    // Registered after sign-in so the token belongs to a named nurse.
    final notifications = context.read<NotificationService>();
    unawaited(notifications.initialise());
    // A pushed task or deterioration warning lands on the task board.
    _pushSub = notifications.onAlertTapped.listen((_) {
      if (mounted) setState(() => _tab = 0);
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
        BlocProvider(
          create: (_) => TaskBoardBloc(api: api)..add(const TaskBoardRequested(_defaultWard)),
        ),
        BlocProvider(create: (_) => VitalsBloc(api: api)),
        BlocProvider(
          create: (_) => HandoverBloc(api: api)..add(const HandoverRequested(_defaultWard)),
        ),
      ],
      child: Builder(
        builder: (context) => Scaffold(
          appBar: AppBar(
            title: const Text('MediCore Nurse'),
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
              TaskBoardScreen(ward: _defaultWard),
              _EmarPatientPicker(ward: _defaultWard),
              VitalsScreen(),
              HandoverScreen(ward: _defaultWard),
            ],
          ),
          bottomNavigationBar: BlocBuilder<TaskBoardBloc, TaskBoardState>(
            builder: (context, state) {
              final overdue = state is TaskBoardReady ? state.overdueCount : 0;
              return NavigationBar(
                selectedIndex: _tab,
                onDestinationSelected: (index) => setState(() => _tab = index),
                destinations: [
                  NavigationDestination(
                    icon: Badge(
                      isLabelVisible: overdue > 0,
                      label: Text('$overdue'),
                      child: const Icon(Icons.checklist_outlined),
                    ),
                    selectedIcon: const Icon(Icons.checklist),
                    label: 'Tasks',
                  ),
                  const NavigationDestination(
                    icon: Icon(Icons.medication_outlined),
                    selectedIcon: Icon(Icons.medication),
                    label: 'eMAR',
                  ),
                  const NavigationDestination(
                    icon: Icon(Icons.monitor_heart_outlined),
                    selectedIcon: Icon(Icons.monitor_heart),
                    label: 'Vitals',
                  ),
                  const NavigationDestination(
                    icon: Icon(Icons.assignment_outlined),
                    selectedIcon: Icon(Icons.assignment),
                    label: 'Handover',
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

/// eMAR starts from a patient. This is that list.
class _EmarPatientPicker extends StatelessWidget {
  const _EmarPatientPicker({required this.ward});

  final String ward;

  @override
  Widget build(BuildContext context) {
    // The handover bloc already holds this ward's admitted patients, so the drug
    // round reuses it rather than issuing a second identical request.
    return BlocBuilder<HandoverBloc, HandoverState>(
      builder: (context, state) => switch (state) {
        HandoverLoading() => const Center(child: CircularProgressIndicator()),
        HandoverError(:final message) => ErrorState(
            message: message,
            onRetry: () => context.read<HandoverBloc>().add(HandoverRequested(ward)),
          ),
        HandoverReady(:final patients) => patients.isEmpty
            ? const EmptyState(
                icon: Icons.medication_outlined,
                title: 'No patients on this ward',
                detail: 'There is no drug round to do.',
              )
            : ListView(
                padding: const EdgeInsets.only(top: 8, bottom: 24),
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 10),
                    child: Text(
                      'Pick a patient, then scan their wristband',
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                  ),
                  for (final patient in patients)
                    ListTile(
                      leading: CircleAvatar(child: Text(patient.initials)),
                      title: Text(patient.fullName),
                      subtitle: Text(
                        [patient.mrn, if (patient.location != null) patient.location!].join(' · '),
                      ),
                      trailing: const Icon(Icons.qr_code_scanner),
                      onTap: () => _openEmar(context, patient),
                    ),
                ],
              ),
      },
    );
  }

  void _openEmar(BuildContext context, Patient patient) {
    final api = context.read<ApiClient>();
    final biometrics = BiometricAuth();

    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => BlocProvider(
          create: (_) => EmarBloc(
            api: api,
            // A controlled drug is signed for with a fingerprint, not a passcode.
            onControlledDrugReauth: (reason) async => (await biometrics.confirm(reason)).isSuccess,
          )..add(EmarLoaded(patient.id, patient.mrn)),
          child: EmarScreen(patient: patient, patientBarcode: patient.mrn),
        ),
      ),
    );
  }
}
