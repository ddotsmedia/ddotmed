/// Clinical alerts: critical results, deterioration and appointment changes.
///
/// Acknowledgement is the point of the screen. An alert that has been seen but
/// not acknowledged is, as far as the record is concerned, an alert nobody
/// responded to — so the button is on every row rather than behind a tap, and a
/// critical alert keeps its red edge until somebody presses it.
library;

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/models.dart';
import '../../core/ui/widgets.dart';
import 'doctor_blocs.dart';
import 'patient_chart_screen.dart';

class AlertsScreen extends StatelessWidget {
  const AlertsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<AlertsBloc, AlertsState>(
      builder: (context, state) => switch (state) {
        AlertsLoading() => const Center(child: CircularProgressIndicator()),
        AlertsError(:final message) => ErrorState(
            message: message,
            onRetry: () => context.read<AlertsBloc>().add(const AlertsRequested()),
          ),
        AlertsReady() => _AlertsList(state: state),
      },
    );
  }
}

class _AlertsList extends StatelessWidget {
  const _AlertsList({required this.state});

  final AlertsReady state;

  @override
  Widget build(BuildContext context) {
    final alerts = state.sorted;

    if (alerts.isEmpty) {
      return RefreshIndicator(
        onRefresh: () async => context.read<AlertsBloc>().add(const AlertsRequested()),
        child: ListView(
          children: const [
            SizedBox(height: 120),
            EmptyState(
              icon: Icons.notifications_none,
              title: 'Nothing outstanding',
              detail: 'Critical results and deterioration warnings appear here.',
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () async => context.read<AlertsBloc>().add(const AlertsRequested()),
      child: ListView(
        padding: const EdgeInsets.symmetric(vertical: 8),
        children: [
          if (state.criticalCount > 0)
            Container(
              margin: const EdgeInsets.fromLTRB(12, 4, 12, 8),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: const Color(0xFFDC2626),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  const Icon(Icons.priority_high, color: Colors.white, size: 18),
                  const SizedBox(width: 8),
                  Text(
                    '${state.criticalCount} critical '
                    'alert${state.criticalCount == 1 ? '' : 's'} awaiting acknowledgement',
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700),
                  ),
                ],
              ),
            ),
          for (final alert in alerts)
            _AlertCard(alert: alert, busy: state.acknowledging.contains(alert.id)),
        ],
      ),
    );
  }
}

class _AlertCard extends StatelessWidget {
  const _AlertCard({required this.alert, required this.busy});

  final ClinicalAlert alert;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final (accent, background, icon) = switch (alert.severity) {
      'critical' || 'life-threatening' => (
          const Color(0xFFDC2626),
          const Color(0xFFFEF2F2),
          Icons.dangerous,
        ),
      'warning' => (
          const Color(0xFFD97706),
          const Color(0xFFFFFBEB),
          Icons.warning_amber,
        ),
      _ => (const Color(0xFF0284C7), Colors.white, Icons.info_outline),
    };

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      color: background,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: accent.withValues(alpha: 0.4)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(icon, color: accent, size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        alert.title,
                        style: TextStyle(fontWeight: FontWeight.w800, color: accent),
                      ),
                      const SizedBox(height: 2),
                      Text(alert.body, style: const TextStyle(fontSize: 13)),
                      const SizedBox(height: 4),
                      Text(
                        '${alert.category} · ${dayTime(alert.createdAt)}',
                        style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                if (alert.patientId != null)
                  TextButton.icon(
                    icon: const Icon(Icons.person_outline, size: 16),
                    label: const Text('Open chart'),
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => PatientChartScreen(patientId: alert.patientId!),
                      ),
                    ),
                  ),
                const SizedBox(width: 6),
                FilledButton.icon(
                  icon: busy
                      ? const SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.check, size: 16),
                  label: const Text('Acknowledge'),
                  style: FilledButton.styleFrom(backgroundColor: accent),
                  onPressed: busy
                      ? null
                      : () => context.read<AlertsBloc>().add(AlertAcknowledged(alert.id)),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
