/// Appointments: upcoming, past, and booking.
///
/// Booking is a four-step wizard — specialty, clinician, slot, confirm — because
/// on a phone a single form with four dependent dropdowns is unusable. Each step
/// only asks one thing, and the back arrow undoes exactly one decision.
library;

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../core/ui/widgets.dart';
import 'patient_blocs.dart';
import 'video_room_screen.dart';

/// The specialties a patient may self-book into.
const bookableSpecialties = <(String, IconData)>[
  ('General practice', Icons.local_hospital_outlined),
  ('Cardiology', Icons.favorite_outline),
  ('Dermatology', Icons.face_outlined),
  ('Paediatrics', Icons.child_care_outlined),
  ('Obstetrics', Icons.pregnant_woman_outlined),
  ('Orthopaedics', Icons.accessibility_new_outlined),
  ('Ophthalmology', Icons.visibility_outlined),
  ('ENT', Icons.hearing_outlined),
];

class PatientAppointmentsScreen extends StatelessWidget {
  const PatientAppointmentsScreen({super.key});

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
        PatientDashboardReady() => _AppointmentsBody(state: state),
      },
    );
  }
}

class _AppointmentsBody extends StatelessWidget {
  const _AppointmentsBody({required this.state});

  final PatientDashboardReady state;

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final upcoming = state.upcoming;
    final past = state.past;

    return Scaffold(
      body: RefreshIndicator(
        onRefresh: () async =>
            context.read<PatientDashboardBloc>().add(const PatientDashboardRequested()),
        child: ListView(
          padding: const EdgeInsets.only(bottom: 90),
          children: [
            if (upcoming.isEmpty && past.isEmpty)
              const Padding(
                padding: EdgeInsets.only(top: 80),
                child: EmptyState(
                  icon: Icons.event_available,
                  title: 'No appointments',
                  detail: 'Tap Book to arrange one.',
                ),
              ),
            if (upcoming.isNotEmpty) const _Heading('Upcoming'),
            for (final appointment in upcoming)
              _AppointmentCard(appointment: appointment, now: now, past: false),
            if (past.isNotEmpty) const _Heading('Past'),
            for (final appointment in past)
              _AppointmentCard(appointment: appointment, now: now, past: true),
          ],
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _openBooking(context),
        icon: const Icon(Icons.add),
        label: const Text('Book'),
      ),
    );
  }

  void _openBooking(BuildContext context) {
    final api = context.read<ApiClient>();
    final dashboard = context.read<PatientDashboardBloc>();

    Navigator.of(context)
        .push(
      MaterialPageRoute<bool>(
        builder: (_) => BlocProvider(
          create: (_) => BookingBloc(api: api),
          child: const BookingFlow(),
        ),
      ),
    )
        .then((booked) {
      // Re-read the list so a newly booked appointment appears immediately.
      if (booked ?? false) dashboard.add(const PatientDashboardRequested());
    });
  }
}

class _Heading extends StatelessWidget {
  const _Heading(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Text(
        label,
        style: Theme.of(context)
            .textTheme
            .labelLarge
            ?.copyWith(color: Theme.of(context).colorScheme.primary),
      ),
    );
  }
}

class _AppointmentCard extends StatelessWidget {
  const _AppointmentCard({
    required this.appointment,
    required this.now,
    required this.past,
  });

  final Appointment appointment;
  final DateTime now;
  final bool past;

  @override
  Widget build(BuildContext context) {
    final joinable = appointment.joinable(now);

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Opacity(
          opacity: past ? 0.7 : 1,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      appointment.serviceType,
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: Colors.grey.shade200,
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Text(
                      appointment.status.replaceAll('_', ' '),
                      style: const TextStyle(fontSize: 10),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Row(
                children: [
                  const Icon(Icons.schedule, size: 14),
                  const SizedBox(width: 6),
                  Text(dayTime(appointment.start), style: const TextStyle(fontSize: 13)),
                ],
              ),
              if (appointment.practitionerName != null) ...[
                const SizedBox(height: 4),
                Row(
                  children: [
                    const Icon(Icons.person_outline, size: 14),
                    const SizedBox(width: 6),
                    Text(
                      appointment.practitionerName!,
                      style: const TextStyle(fontSize: 13),
                    ),
                  ],
                ),
              ],
              if (appointment.isTelehealth && !past) ...[
                const SizedBox(height: 10),
                if (joinable)
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton.icon(
                      icon: const Icon(Icons.videocam, size: 18),
                      label: const Text('Join video'),
                      style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFF0D9488),
                      ),
                      onPressed: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => VideoRoomScreen(appointment: appointment),
                        ),
                      ),
                    ),
                  )
                else
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: Colors.grey.shade100,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      'Video consultation — the Join button appears '
                      '${Appointment.joinWindowMinutes} minutes before your '
                      'appointment.',
                      style: TextStyle(fontSize: 11, color: Colors.grey.shade700),
                    ),
                  ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Specialty → clinician → slot → confirm.
class BookingFlow extends StatefulWidget {
  const BookingFlow({super.key});

  @override
  State<BookingFlow> createState() => _BookingFlowState();
}

class _BookingFlowState extends State<BookingFlow> {
  int _step = 0;
  String? _specialty;
  Slot? _slot;
  bool _telehealth = false;
  final _reason = TextEditingController();

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  void _back() {
    if (_step == 0) {
      Navigator.of(context).pop(false);
      return;
    }
    setState(() => _step -= 1);
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: _step == 0,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(
            switch (_step) {
              0 => 'Choose a specialty',
              1 => 'Choose a time',
              _ => 'Confirm',
            },
          ),
          leading: IconButton(icon: const Icon(Icons.arrow_back), onPressed: _back),
        ),
        body: BlocConsumer<BookingBloc, BookingState>(
          listener: (context, state) {
            if (state is BookingConfirmedState) {
              Navigator.of(context).pop(true);
            }
          },
          builder: (context, state) => switch (_step) {
            0 => _SpecialtyStep(
                onSelected: (specialty) {
                  setState(() {
                    _specialty = specialty;
                    _step = 1;
                  });
                  context.read<BookingBloc>().add(
                        SlotsRequested(specialty: specialty, from: DateTime.now()),
                      );
                },
              ),
            1 => _SlotStep(
                state: state,
                onSelected: (slot) => setState(() {
                  _slot = slot;
                  _step = 2;
                }),
              ),
            _ => _ConfirmStep(
                specialty: _specialty!,
                slot: _slot!,
                reason: _reason,
                telehealth: _telehealth,
                submitting: state is BookingSubmitting,
                error: state is BookingError ? state.message : null,
                onTelehealthChanged: (value) => setState(() => _telehealth = value),
                onConfirm: () => context.read<BookingBloc>().add(
                      BookingConfirmed(
                        slot: _slot!,
                        serviceType: _specialty!,
                        reason: _reason.text,
                        telehealth: _telehealth,
                      ),
                    ),
              ),
          },
        ),
      ),
    );
  }
}

class _SpecialtyStep extends StatelessWidget {
  const _SpecialtyStep({required this.onSelected});

  final ValueChanged<String> onSelected;

  @override
  Widget build(BuildContext context) {
    return GridView.count(
      padding: const EdgeInsets.all(16),
      crossAxisCount: 2,
      childAspectRatio: 1.5,
      mainAxisSpacing: 12,
      crossAxisSpacing: 12,
      children: [
        for (final (name, icon) in bookableSpecialties)
          InkWell(
            onTap: () => onSelected(name),
            borderRadius: BorderRadius.circular(12),
            child: Container(
              decoration: BoxDecoration(
                border: Border.all(color: Colors.grey.shade300),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(icon, size: 28, color: Theme.of(context).colorScheme.primary),
                  const SizedBox(height: 8),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    child: Text(
                      name,
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _SlotStep extends StatelessWidget {
  const _SlotStep({required this.state, required this.onSelected});

  final BookingState state;
  final ValueChanged<Slot> onSelected;

  @override
  Widget build(BuildContext context) {
    if (state is BookingLoadingSlots) {
      return const Center(child: CircularProgressIndicator());
    }
    if (state is BookingError) {
      return ErrorState(message: (state as BookingError).message);
    }
    if (state is! BookingSlotsReady) {
      return const Center(child: CircularProgressIndicator());
    }

    final ready = state as BookingSlotsReady;
    if (ready.slots.isEmpty) {
      return const EmptyState(
        icon: Icons.event_busy,
        title: 'No appointments available',
        detail: 'Nothing is free in the next four weeks. Try another specialty, '
            'or telephone the clinic.',
      );
    }

    final byDay = ready.byDay;
    final days = byDay.keys.toList()..sort();

    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        for (final day in days) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 12, 4, 8),
            child: Text(
              _dayLabel(day),
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final slot in byDay[day]!)
                OutlinedButton(
                  onPressed: () => onSelected(slot),
                  child: Text(hhmm(slot.start)),
                ),
            ],
          ),
        ],
      ],
    );
  }

  static String _dayLabel(DateTime day) {
    const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return '${weekdays[day.weekday - 1]} ${day.day} ${months[day.month - 1]}';
  }
}

class _ConfirmStep extends StatelessWidget {
  const _ConfirmStep({
    required this.specialty,
    required this.slot,
    required this.reason,
    required this.telehealth,
    required this.submitting,
    required this.error,
    required this.onTelehealthChanged,
    required this.onConfirm,
  });

  final String specialty;
  final Slot slot;
  final TextEditingController reason;
  final bool telehealth;
  final bool submitting;
  final String? error;
  final ValueChanged<bool> onTelehealthChanged;
  final VoidCallback onConfirm;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  specialty,
                  style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    const Icon(Icons.schedule, size: 16),
                    const SizedBox(width: 8),
                    Text(dayTime(slot.start)),
                  ],
                ),
                if (slot.practitionerName != null) ...[
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      const Icon(Icons.person_outline, size: 16),
                      const SizedBox(width: 8),
                      Text(slot.practitionerName!),
                    ],
                  ),
                ],
                if (slot.locationName != null) ...[
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      const Icon(Icons.place_outlined, size: 16),
                      const SizedBox(width: 8),
                      Text(slot.locationName!),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        SwitchListTile(
          value: telehealth,
          onChanged: onTelehealthChanged,
          title: const Text('Video consultation'),
          subtitle: const Text('See the clinician from home instead of attending'),
          contentPadding: EdgeInsets.zero,
        ),
        const SizedBox(height: 8),
        TextField(
          controller: reason,
          maxLines: 3,
          decoration: const InputDecoration(
            labelText: 'What would you like to discuss?',
            helperText: 'Optional, but it helps the clinician prepare',
            border: OutlineInputBorder(),
          ),
        ),
        if (error != null) ...[
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: const Color(0xFFFEE2E2),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(error!, style: const TextStyle(color: Color(0xFF991B1B))),
          ),
        ],
        const SizedBox(height: 20),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            style: FilledButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 16),
            ),
            onPressed: submitting ? null : onConfirm,
            child: Text(submitting ? 'Booking…' : 'Confirm booking'),
          ),
        ),
      ],
    );
  }
}
