import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../blocs/auth_bloc.dart';
import '../blocs/emar_bloc.dart';
import '../blocs/task_board_bloc.dart';
import '../core/api_client.dart';
import '../core/five_rights.dart';

class NurseHome extends StatefulWidget {
  const NurseHome({super.key});

  @override
  State<NurseHome> createState() => _NurseHomeState();
}

class _NurseHomeState extends State<NurseHome> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return Scaffold(
      appBar: AppBar(
        title: const Text('MediCore Nurse'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () => context.read<AuthBloc>().add(const AuthSignOutRequested()),
          ),
        ],
      ),
      body: IndexedStack(
        index: _tab,
        children: [
          BlocProvider(
            create: (_) => TaskBoardBloc(api: api)..add(const TaskBoardRequested('WARD3')),
            child: const _TaskBoard(),
          ),
          BlocProvider(
            create: (_) => EmarBloc(
              api: api,
              onControlledDrugReauth: (reason) =>
                  context.read<AuthBloc>().confirmWithBiometric(reason),
            ),
            child: const EmarScreen(patientId: '', patientBarcode: ''),
          ),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.checklist), label: 'Tasks'),
          NavigationDestination(icon: Icon(Icons.medication), label: 'eMAR'),
        ],
      ),
    );
  }
}

class _TaskBoard extends StatelessWidget {
  const _TaskBoard();

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<TaskBoardBloc, TaskBoardState>(
      builder: (context, state) => switch (state) {
        TaskBoardLoading() => const Center(child: CircularProgressIndicator()),
        TaskBoardError(:final message) => Center(child: Text(message)),
        TaskBoardReady(:final now) => ListView(
            children: [
              if (state.overdueCount > 0)
                Container(
                  color: Colors.red.shade100,
                  padding: const EdgeInsets.all(12),
                  child: Text(
                    '${state.overdueCount} overdue',
                    style: TextStyle(
                      color: Colors.red.shade900,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              for (final task in state.sorted)
                ListTile(
                  // Overdue is carried by an icon and a label, not by colour alone.
                  leading: Icon(
                    task.isOverdue(now) ? Icons.warning_amber : Icons.schedule,
                    color: task.isOverdue(now) ? Colors.red.shade700 : null,
                  ),
                  tileColor: task.isOverdue(now) ? Colors.red.shade50 : null,
                  title: Text(task.title),
                  subtitle: Text(
                    '${task.patientName} ${task.patientMrn} · due ${_hhmm(task.dueAt)}'
                    '${task.isOverdue(now) ? ' · OVERDUE' : ''}',
                  ),
                  trailing: IconButton(
                    icon: const Icon(Icons.check_circle_outline),
                    onPressed: () =>
                        context.read<TaskBoardBloc>().add(TaskCompleted(task.id)),
                  ),
                ),
            ],
          ),
      },
    );
  }

  static String _hhmm(DateTime value) =>
      '${value.hour.toString().padLeft(2, '0')}:${value.minute.toString().padLeft(2, '0')}';
}

class EmarScreen extends StatelessWidget {
  const EmarScreen({super.key, required this.patientId, required this.patientBarcode});

  final String patientId;
  final String patientBarcode;

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<EmarBloc, EmarState>(
      listener: (context, state) {
        if (state is EmarAdministered) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Administration recorded')),
          );
        }
      },
      builder: (context, state) {
        // A wrong-patient scan takes over the entire screen and blocks everything.
        if (state is EmarWrongPatient) {
          return _WrongPatientOverlay(scanned: state.scanned, expected: state.expected);
        }

        return switch (state) {
          EmarLoading() => const Center(child: CircularProgressIndicator()),
          EmarError(:final message) => Center(child: Text(message)),
          EmarVerificationFailed(:final failures) => _FailureList(failures: failures),
          EmarReady() => _MedicationList(state: state),
          _ => const Center(child: Text('Scan a patient wristband to begin')),
        };
      },
    );
  }
}

class _MedicationList extends StatelessWidget {
  const _MedicationList({required this.state});

  final EmarReady state;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        if (!state.patientVerified)
          Expanded(
            child: MobileScanner(
              onDetect: (capture) {
                final code = capture.barcodes.firstOrNull?.rawValue;
                if (code != null) {
                  context.read<EmarBloc>().add(EmarPatientScanned(code));
                }
              },
            ),
          )
        else
          Expanded(
            child: ListView(
              children: [
                for (final order in state.orders)
                  ListTile(
                    title: Text(order.display),
                    subtitle: Text(
                      '${order.doseQuantity} ${order.doseUnit} · ${order.route} · ${order.frequency}',
                    ),
                    trailing: order.isControlled
                        ? const Chip(label: Text('CD'), backgroundColor: Color(0xFFFECACA))
                        : null,
                    onTap: () => _scanMedication(context, order),
                  ),
              ],
            ),
          ),
      ],
    );
  }

  Future<void> _scanMedication(BuildContext context, MedicationOrder order) async {
    final bloc = context.read<EmarBloc>();
    final code = await showModalBottomSheet<String>(
      context: context,
      builder: (sheetContext) => SizedBox(
        height: 320,
        child: MobileScanner(
          onDetect: (capture) {
            final value = capture.barcodes.firstOrNull?.rawValue;
            if (value != null) Navigator.of(sheetContext).pop(value);
          },
        ),
      ),
    );
    if (code == null) return;
    bloc.add(EmarMedicationScanned(order, code));
  }
}

class _FailureList extends StatelessWidget {
  const _FailureList({required this.failures});

  final List<RightCheck> failures;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.orange.shade50,
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Administration blocked',
              style: Theme.of(context).textTheme.titleLarge?.copyWith(color: Colors.orange.shade900)),
          const SizedBox(height: 12),
          for (final failure in failures)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text('• ${failure.detail}'),
            ),
          const Spacer(),
          FilledButton(
            onPressed: () => context.read<EmarBloc>().add(const EmarBlockCleared()),
            child: const Text('Back'),
          ),
        ],
      ),
    );
  }
}

/// Full-screen red block. Nothing else on the nurse app is reachable from here.
class _WrongPatientOverlay extends StatelessWidget {
  const _WrongPatientOverlay({required this.scanned, required this.expected});

  final String scanned;
  final String expected;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.red.shade700,
      width: double.infinity,
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.dangerous, size: 96, color: Colors.white),
          const SizedBox(height: 24),
          const Text(
            'WRONG PATIENT',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white, fontSize: 40, fontWeight: FontWeight.w900),
          ),
          const SizedBox(height: 16),
          const Text(
            'Do not administer. The scanned wristband does not match this order.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white, fontSize: 18),
          ),
          const SizedBox(height: 24),
          Text('Scanned: $scanned', style: const TextStyle(color: Colors.white70)),
          Text('Expected: $expected', style: const TextStyle(color: Colors.white70)),
          const SizedBox(height: 40),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.white, foregroundColor: Colors.red),
            onPressed: () => context.read<EmarBloc>().add(const EmarBlockCleared()),
            child: const Text('Acknowledge and rescan'),
          ),
        ],
      ),
    );
  }
}

extension _FirstOrNull<T> on List<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
