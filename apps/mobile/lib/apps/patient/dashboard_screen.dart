/// The patient dashboard.
///
/// Ordered by what a patient actually opens the app for: when am I next seen,
/// what did my last test say, what am I supposed to be taking. The wearable card
/// is last and is labelled as self-recorded, because a watch reading sitting
/// above a hospital lab result would imply an equivalence that does not exist.
library;

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/models.dart';
import '../../core/ui/widgets.dart';
import 'patient_blocs.dart';
import 'video_room_screen.dart';

class PatientDashboardScreen extends StatelessWidget {
  const PatientDashboardScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<PatientDashboardBloc, PatientDashboardState>(
      builder: (context, state) => switch (state) {
        PatientDashboardLoading() => const Center(child: CircularProgressIndicator()),
        PatientDashboardError(:final message) => ErrorState(
            message: message,
            onRetry: () =>
                context.read<PatientDashboardBloc>().add(const PatientDashboardRequested()),
          ),
        PatientDashboardReady() => _DashboardBody(state: state),
      },
    );
  }
}

class _DashboardBody extends StatelessWidget {
  const _DashboardBody({required this.state});

  final PatientDashboardReady state;

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final joinable = state.joinableNow(now);
    final next = state.upcoming.isEmpty ? null : state.upcoming.first;

    return RefreshIndicator(
      onRefresh: () async =>
          context.read<PatientDashboardBloc>().add(const PatientDashboardRequested()),
      child: ListView(
        padding: const EdgeInsets.only(bottom: 24),
        children: [
          if (joinable != null) _JoinNowBanner(appointment: joinable),
          _NextAppointmentCard(appointment: next),
          _ResultsCard(results: state.recentResults),
          _MedicationsCard(medications: state.medications),
          _WearableCard(summary: state.wearable),
          if (state.outstandingInvoices.isNotEmpty)
            _BalanceCard(invoices: state.outstandingInvoices),
        ],
      ),
    );
  }
}

class _JoinNowBanner extends StatelessWidget {
  const _JoinNowBanner({required this.appointment});

  final Appointment appointment;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 12, 12, 4),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFF0D9488),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          const Icon(Icons.videocam, color: Colors.white, size: 28),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Your video consultation is ready',
                  style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800),
                ),
                Text(
                  '${appointment.serviceType} · ${hhmm(appointment.start)}',
                  style: const TextStyle(color: Colors.white70, fontSize: 12),
                ),
              ],
            ),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Colors.white,
              foregroundColor: const Color(0xFF0F766E),
            ),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => VideoRoomScreen(appointment: appointment),
              ),
            ),
            child: const Text('Join'),
          ),
        ],
      ),
    );
  }
}

class _NextAppointmentCard extends StatelessWidget {
  const _NextAppointmentCard({required this.appointment});

  final Appointment? appointment;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: 'Next appointment',
      icon: Icons.event_outlined,
      child: appointment == null
          ? Text(
              'Nothing booked. Use the Appointments tab to make one.',
              style: TextStyle(color: Colors.grey.shade600),
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  appointment!.serviceType,
                  style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    const Icon(Icons.schedule, size: 14),
                    const SizedBox(width: 6),
                    Text(dayTime(appointment!.start)),
                  ],
                ),
                if (appointment!.practitionerName != null) ...[
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      const Icon(Icons.person_outline, size: 14),
                      const SizedBox(width: 6),
                      Text(appointment!.practitionerName!),
                    ],
                  ),
                ],
                if (appointment!.isTelehealth) ...[
                  const SizedBox(height: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: const Color(0xFFCCFBF1),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.videocam, size: 14, color: Color(0xFF0F766E)),
                        SizedBox(width: 4),
                        Text(
                          'Video consultation · join 15 minutes before',
                          style: TextStyle(fontSize: 11, color: Color(0xFF0F766E)),
                        ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
    );
  }
}

class _ResultsCard extends StatelessWidget {
  const _ResultsCard({required this.results});

  final List<LabResult> results;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: 'Recent results',
      icon: Icons.science_outlined,
      child: results.isEmpty
          ? Text(
              'No results have been released to you yet.',
              style: TextStyle(color: Colors.grey.shade600),
            )
          : Column(
              children: [
                for (final result in results)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(result.display),
                              Text(
                                dayTime(result.performedAt),
                                style: TextStyle(
                                  fontSize: 11,
                                  color: Colors.grey.shade500,
                                ),
                              ),
                            ],
                          ),
                        ),
                        LabFlagChip(result: result),
                      ],
                    ),
                  ),
                if (results.any((r) => r.isAbnormal))
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: const Color(0xFFFEF3C7),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    // Results are shown, never interpreted for the patient.
                    child: const Text(
                      'A result outside the usual range is not necessarily a problem. '
                      'Your clinician will explain what it means for you.',
                      style: TextStyle(fontSize: 11, color: Color(0xFF78350F)),
                    ),
                  ),
              ],
            ),
    );
  }
}

class _MedicationsCard extends StatelessWidget {
  const _MedicationsCard({required this.medications});

  final List<Prescription> medications;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: 'Your medications',
      icon: Icons.medication_outlined,
      trailing: Text(
        '${medications.length}',
        style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
      ),
      child: medications.isEmpty
          ? Text('Nothing active', style: TextStyle(color: Colors.grey.shade600))
          : Column(
              children: [
                for (final medication in medications.take(5))
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(Icons.circle, size: 7, color: Color(0xFF7C3AED)),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                medication.display,
                                style: const TextStyle(fontWeight: FontWeight.w600),
                              ),
                              Text(
                                medication.doseLabel,
                                style: TextStyle(
                                  fontSize: 12,
                                  color: Colors.grey.shade700,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
    );
  }
}

class _WearableCard extends StatelessWidget {
  const _WearableCard({required this.summary});

  final WearableSummary summary;

  @override
  Widget build(BuildContext context) {
    if (!summary.available) {
      return const SizedBox.shrink();
    }

    return SectionCard(
      title: 'From your devices',
      icon: Icons.watch_outlined,
      trailing: summary.lastSyncedAt == null
          ? null
          : Text(
              dayTime(summary.lastSyncedAt!),
              style: TextStyle(fontSize: 11, color: Colors.grey.shade500),
            ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (summary.permissionDenied)
            Text(
              'Health access is turned off. Enable it in your device settings to '
              'see your activity here.',
              style: TextStyle(color: Colors.grey.shade700, fontSize: 13),
            )
          else if (!summary.hasData)
            Text(
              'No readings in the last 24 hours.',
              style: TextStyle(color: Colors.grey.shade600),
            )
          else ...[
            Wrap(
              spacing: 16,
              runSpacing: 12,
              children: [
                if (summary.steps != null)
                  _Metric(
                    icon: Icons.directions_walk,
                    label: 'Steps',
                    value: '${summary.steps}',
                  ),
                if (summary.restingHeartRate != null)
                  _Metric(
                    icon: Icons.favorite_outline,
                    label: 'Resting HR',
                    value: '${summary.restingHeartRate} bpm',
                  ),
                if (summary.sleepHours != null)
                  _Metric(
                    icon: Icons.bedtime_outlined,
                    label: 'Sleep',
                    value: '${summary.sleepHours} h',
                  ),
                if (summary.spo2 != null)
                  _Metric(
                    icon: Icons.air,
                    label: 'SpO₂',
                    value: '${summary.spo2}%',
                  ),
              ],
            ),
            const SizedBox(height: 10),
            Text(
              'Recorded by your own devices. These are not clinical measurements '
              'and are not part of your medical record.',
              style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
            ),
          ],
        ],
      ),
    );
  }
}

class _Metric extends StatelessWidget {
  const _Metric({required this.icon, required this.label, required this.value});

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 120,
      child: Row(
        children: [
          Icon(icon, size: 20, color: Theme.of(context).colorScheme.primary),
          const SizedBox(width: 8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(value, style: const TextStyle(fontWeight: FontWeight.w700)),
              Text(
                label,
                style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _BalanceCard extends StatelessWidget {
  const _BalanceCard({required this.invoices});

  final List<Invoice> invoices;

  @override
  Widget build(BuildContext context) {
    final total = invoices.fold<int>(0, (sum, invoice) => sum + invoice.balanceMinor);

    return SectionCard(
      title: 'Outstanding balance',
      icon: Icons.receipt_long_outlined,
      child: Row(
        children: [
          Expanded(
            child: Text(
              formatMoney(total, invoices.first.currency),
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
            ),
          ),
          Text(
            '${invoices.length} invoice${invoices.length == 1 ? '' : 's'}',
            style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
          ),
        ],
      ),
    );
  }
}
