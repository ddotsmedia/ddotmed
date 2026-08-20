/// Today: the clinic list and the ward list, in one scroll.
///
/// Two lists rather than one because they are answered differently — an
/// appointment is a time you must be somewhere, an admitted patient is a person
/// whose condition may have changed since you last looked. The ward list is
/// ordered by acuity, not by bed number.
library;

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/models.dart';
import '../../core/ui/widgets.dart';
import 'doctor_blocs.dart';
import 'patient_chart_screen.dart';

class TodayScreen extends StatelessWidget {
  const TodayScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<TodayBloc, TodayState>(
      builder: (context, state) => switch (state) {
        TodayLoading() => const Center(child: CircularProgressIndicator()),
        TodayError(:final message) => ErrorState(
            message: message,
            onRetry: () => context.read<TodayBloc>().add(const TodayRequested()),
          ),
        TodayReady() => _TodayBody(state: state),
      },
    );
  }
}

class _TodayBody extends StatelessWidget {
  const _TodayBody({required this.state});

  final TodayReady state;

  @override
  Widget build(BuildContext context) {
    final upcoming = state.upcoming;
    final earlier = state.earlier;
    final inpatients = state.inpatientsByAcuity;

    if (upcoming.isEmpty && earlier.isEmpty && inpatients.isEmpty) {
      return RefreshIndicator(
        onRefresh: () async => context.read<TodayBloc>().add(const TodayRequested()),
        child: ListView(
          children: const [
            SizedBox(height: 120),
            EmptyState(
              icon: Icons.event_available,
              title: 'Nothing scheduled',
              detail: 'No appointments today and no patients under your care.',
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () async => context.read<TodayBloc>().add(const TodayRequested()),
      child: ListView(
        padding: const EdgeInsets.only(bottom: 24),
        children: [
          if (upcoming.isNotEmpty)
            _Heading(label: 'Clinic', count: upcoming.length, icon: Icons.schedule),
          for (final appointment in upcoming)
            _AppointmentCard(appointment: appointment, past: false),
          if (inpatients.isNotEmpty)
            _Heading(label: 'Inpatients', count: inpatients.length, icon: Icons.local_hotel),
          for (final patient in inpatients)
            PatientCard(
              patient: patient,
              vital: state.latestVitals[patient.id],
              onTap: () => _openChart(context, patient.id),
            ),
          if (earlier.isNotEmpty)
            _Heading(label: 'Earlier today', count: earlier.length, icon: Icons.history),
          for (final appointment in earlier)
            Opacity(
              opacity: 0.65,
              child: _AppointmentCard(appointment: appointment, past: true),
            ),
        ],
      ),
    );
  }

  static void _openChart(BuildContext context, String patientId) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => PatientChartScreen(patientId: patientId),
      ),
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading({required this.label, required this.count, required this.icon});

  final String label;
  final int count;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Row(
        children: [
          Icon(icon, size: 16, color: Theme.of(context).colorScheme.primary),
          const SizedBox(width: 6),
          Text(
            '$label ($count)',
            style: Theme.of(context)
                .textTheme
                .labelLarge
                ?.copyWith(color: Theme.of(context).colorScheme.primary),
          ),
        ],
      ),
    );
  }
}

/// The card the spec calls for: name, MRN, chief complaint, bed, EWS badge.
class PatientCard extends StatelessWidget {
  const PatientCard({
    super.key,
    required this.patient,
    this.vital,
    this.onTap,
    this.trailing,
  });

  final Patient patient;
  final VitalReading? vital;
  final VoidCallback? onTap;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              CircleAvatar(
                radius: 20,
                backgroundColor: Theme.of(context).colorScheme.primaryContainer,
                child: Text(
                  patient.initials,
                  style: TextStyle(
                    fontWeight: FontWeight.w700,
                    color: Theme.of(context).colorScheme.onPrimaryContainer,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            patient.fullName,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
                          ),
                        ),
                        if (patient.isVip) ...[
                          const SizedBox(width: 4),
                          const Icon(Icons.star, size: 14, color: Color(0xFFD97706)),
                        ],
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      [
                        patient.mrn,
                        if (patient.ageYears != null) '${patient.ageYears}y',
                        if (patient.gender != null) patient.gender!,
                      ].where((p) => p.isNotEmpty).join(' · '),
                      style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                    ),
                    if (patient.chiefComplaint != null && patient.chiefComplaint!.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Text(
                        patient.chiefComplaint!,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 13),
                      ),
                    ],
                    if (patient.location != null) ...[
                      const SizedBox(height: 4),
                      Row(
                        children: [
                          Icon(Icons.bed, size: 13, color: Colors.grey.shade600),
                          const SizedBox(width: 4),
                          Text(
                            patient.location!,
                            style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  if (vital != null)
                    EwsBadge.fromVital(vital!, compact: true)
                  else
                    Text(
                      'EWS —',
                      style: TextStyle(fontSize: 11, color: Colors.grey.shade500),
                    ),
                  if (vital != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      hhmm(vital!.recordedAt),
                      style: TextStyle(fontSize: 10, color: Colors.grey.shade500),
                    ),
                  ],
                  if (trailing != null) ...[const SizedBox(height: 6), trailing!],
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AppointmentCard extends StatelessWidget {
  const _AppointmentCard({required this.appointment, required this.past});

  final Appointment appointment;
  final bool past;

  @override
  Widget build(BuildContext context) {
    final patient = appointment.patient;

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: patient == null
            ? null
            : () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => PatientChartScreen(patientId: patient.id),
                  ),
                ),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              SizedBox(
                width: 46,
                child: Text(
                  appointment.status == 'walk_in'
                      ? (appointment.queueToken ?? 'W/I')
                      : hhmm(appointment.start),
                  style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      patient?.fullName ?? 'Unassigned',
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      [
                        if (patient != null) patient.mrn,
                        appointment.serviceType,
                        '${appointment.minutesDuration}m',
                      ].where((p) => p.isNotEmpty).join(' · '),
                      style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                    ),
                    if (appointment.reasonText != null && appointment.reasonText!.isNotEmpty) ...[
                      const SizedBox(height: 3),
                      Text(
                        appointment.reasonText!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12),
                      ),
                    ],
                  ],
                ),
              ),
              if (appointment.isTelehealth)
                const Padding(
                  padding: EdgeInsets.only(left: 6),
                  child: Icon(Icons.videocam, size: 18, color: Color(0xFF0D9488)),
                ),
              _StatusPill(status: appointment.status),
            ],
          ),
        ),
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    final (background, foreground) = switch (status) {
      'fulfilled' => (const Color(0xFFD1FAE5), const Color(0xFF065F46)),
      'cancelled' => (const Color(0xFFE2E8F0), const Color(0xFF475569)),
      'noshow' => (const Color(0xFFFEE2E2), const Color(0xFF991B1B)),
      'checked_in' || 'arrived' => (const Color(0xFFE0E7FF), const Color(0xFF3730A3)),
      _ => (const Color(0xFFE0F2FE), const Color(0xFF075985)),
    };

    return Container(
      margin: const EdgeInsets.only(left: 6),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(4)),
      child: Text(
        status.replaceAll('_', ' '),
        style: TextStyle(fontSize: 10, color: foreground, fontWeight: FontWeight.w600),
      ),
    );
  }
}
