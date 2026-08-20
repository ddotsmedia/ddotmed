/// The patient chart.
///
/// Order on this screen is a clinical decision, not a layout one. The allergy
/// banner is first and is never collapsible, because it is the thing that stops
/// a prescription being written. Then what is being given now, then what the
/// numbers are doing, then the narrative. Quick actions sit in a bar that stays
/// put while the chart scrolls under it.
library;

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../core/ui/widgets.dart';
import 'doctor_blocs.dart';
import 'orders_bloc.dart';
import 'orders_screen.dart';
import 'scribe_bloc.dart';
import 'scribe_screen.dart';

class PatientChartScreen extends StatelessWidget {
  const PatientChartScreen({super.key, required this.patientId});

  final String patientId;

  @override
  Widget build(BuildContext context) {
    return BlocProvider(
      create: (_) => ChartBloc(api: context.read<ApiClient>())..add(ChartRequested(patientId)),
      child: const _ChartView(),
    );
  }
}

class _ChartView extends StatelessWidget {
  const _ChartView();

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<ChartBloc, ChartState>(
      builder: (context, state) {
        return Scaffold(
          appBar: AppBar(
            title: Text(
              switch (state) {
                ChartReady(:final patient) => patient.fullName,
                _ => 'Patient chart',
              },
            ),
          ),
          body: switch (state) {
            ChartLoading() => const Center(child: CircularProgressIndicator()),
            ChartError(:final message) => ErrorState(message: message),
            ChartReady() => _ChartBody(state: state),
          },
          bottomNavigationBar: state is ChartReady ? _QuickActions(state: state) : null,
        );
      },
    );
  }
}

class _ChartBody extends StatelessWidget {
  const _ChartBody({required this.state});

  final ChartReady state;

  @override
  Widget build(BuildContext context) {
    final patient = state.patient;

    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
          child: AllergyBanner(allergies: state.allergies),
        ),
        _Demographics(patient: patient, latest: state.latestVital),
        _Medications(medications: state.medications),
        _Labs(labs: state.labs),
        _Vitals(state: state),
        _Timeline(entries: state.timeline),
      ],
    );
  }
}

class _Demographics extends StatelessWidget {
  const _Demographics({required this.patient, required this.latest});

  final Patient patient;
  final VitalReading? latest;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: patient.fullName,
      icon: Icons.badge_outlined,
      trailing: latest == null ? null : EwsBadge.fromVital(latest!),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            [
              patient.mrn,
              if (patient.ageYears != null) '${patient.ageYears} years',
              if (patient.gender != null) patient.gender!,
            ].where((p) => p.isNotEmpty).join(' · '),
            style: TextStyle(color: Colors.grey.shade700),
          ),
          if (patient.location != null) ...[
            const SizedBox(height: 4),
            Row(
              children: [
                const Icon(Icons.bed, size: 14),
                const SizedBox(width: 4),
                Text(patient.location!),
              ],
            ),
          ],
          if (patient.chiefComplaint != null && patient.chiefComplaint!.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(patient.chiefComplaint!),
          ],
        ],
      ),
    );
  }
}

class _Medications extends StatelessWidget {
  const _Medications({required this.medications});

  final List<Prescription> medications;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: 'Active medications',
      icon: Icons.medication_outlined,
      trailing: Text(
        '${medications.length}',
        style: TextStyle(color: Colors.grey.shade600, fontSize: 12),
      ),
      child: medications.isEmpty
          ? Text('None active', style: TextStyle(color: Colors.grey.shade600))
          : Column(
              children: [
                for (final medication in medications)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(Icons.circle, size: 7, color: Color(0xFF0369A1)),
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
                                style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
                              ),
                              if (medication.instructions != null &&
                                  medication.instructions!.isNotEmpty)
                                Text(
                                  medication.instructions!,
                                  style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
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

class _Labs extends StatelessWidget {
  const _Labs({required this.labs});

  final List<LabResult> labs;

  @override
  Widget build(BuildContext context) {
    final recent = labs.take(8).toList();
    final abnormal = labs.where((l) => l.isAbnormal).length;

    return SectionCard(
      title: 'Recent results',
      icon: Icons.science_outlined,
      trailing: abnormal == 0
          ? null
          : Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                color: const Color(0xFFFEF3C7),
                borderRadius: BorderRadius.circular(4),
              ),
              child: const Text(
                'abnormal',
                style: TextStyle(fontSize: 10, color: Color(0xFF78350F)),
              ),
            ),
      child: recent.isEmpty
          ? Text('No results filed', style: TextStyle(color: Colors.grey.shade600))
          : Column(
              children: [
                for (final result in recent)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(result.display, style: const TextStyle(fontSize: 13)),
                              Text(
                                dayTime(result.performedAt),
                                style: TextStyle(fontSize: 11, color: Colors.grey.shade500),
                              ),
                            ],
                          ),
                        ),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            LabFlagChip(result: result),
                            if (result.referenceLabel != null)
                              Text(
                                result.referenceLabel!,
                                style: TextStyle(fontSize: 10, color: Colors.grey.shade500),
                              ),
                          ],
                        ),
                      ],
                    ),
                  ),
              ],
            ),
    );
  }
}

class _Vitals extends StatelessWidget {
  const _Vitals({required this.state});

  final ChartReady state;

  @override
  Widget build(BuildContext context) {
    if (state.vitals.isEmpty) {
      return SectionCard(
        title: 'Vitals',
        icon: Icons.monitor_heart_outlined,
        child: Text('No observations recorded', style: TextStyle(color: Colors.grey.shade600)),
      );
    }

    final latest = state.vitals.first;

    return SectionCard(
      title: 'Vitals',
      icon: Icons.monitor_heart_outlined,
      trailing: Text(
        dayTime(latest.recordedAt),
        style: TextStyle(fontSize: 11, color: Colors.grey.shade500),
      ),
      child: Column(
        children: [
          _VitalRow(
            label: 'Systolic BP',
            value: latest.systolic == null
                ? '—'
                : '${latest.systolic}/${latest.diastolic ?? '—'} mmHg',
            series: state.seriesFor((v) => v.systolic?.toDouble()),
            color: const Color(0xFFDC2626),
          ),
          _VitalRow(
            label: 'Heart rate',
            value: latest.heartRate == null ? '—' : '${latest.heartRate} bpm',
            series: state.seriesFor((v) => v.heartRate?.toDouble()),
            color: const Color(0xFFDB2777),
          ),
          _VitalRow(
            label: 'SpO₂',
            value: latest.spo2 == null ? '—' : '${latest.spo2}%',
            series: state.seriesFor((v) => v.spo2?.toDouble()),
            color: const Color(0xFF0284C7),
          ),
          _VitalRow(
            label: 'Temperature',
            value:
                latest.temperatureC == null ? '—' : '${latest.temperatureC!.toStringAsFixed(1)} °C',
            series: state.seriesFor((v) => v.temperatureC),
            color: const Color(0xFFEA580C),
          ),
          _VitalRow(
            label: 'Respiratory rate',
            value: latest.respiratoryRate == null ? '—' : '${latest.respiratoryRate}/min',
            series: state.seriesFor((v) => v.respiratoryRate?.toDouble()),
            color: const Color(0xFF7C3AED),
          ),
        ],
      ),
    );
  }
}

class _VitalRow extends StatelessWidget {
  const _VitalRow({
    required this.label,
    required this.value,
    required this.series,
    required this.color,
  });

  final String label;
  final String value;
  final List<double> series;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(
            width: 108,
            child: Text(label, style: const TextStyle(fontSize: 12)),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
            ),
          ),
          Sparkline(values: series, color: color),
        ],
      ),
    );
  }
}

class _Timeline extends StatelessWidget {
  const _Timeline({required this.entries});

  final List<TimelineEntry> entries;

  @override
  Widget build(BuildContext context) {
    final recent = entries.take(20).toList();

    return SectionCard(
      title: 'Clinical timeline',
      icon: Icons.timeline,
      child: recent.isEmpty
          ? Text('Nothing recorded yet', style: TextStyle(color: Colors.grey.shade600))
          : Column(
              children: [
                for (final entry in recent)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Column(
                          children: [
                            Container(
                              width: 8,
                              height: 8,
                              decoration: BoxDecoration(
                                color: _typeColour(entry.type),
                                shape: BoxShape.circle,
                              ),
                            ),
                            Container(width: 1, height: 26, color: Colors.grey.shade300),
                          ],
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                entry.summary,
                                style: const TextStyle(fontSize: 13),
                              ),
                              Text(
                                '${entry.type} · ${dayTime(entry.at)}',
                                style: TextStyle(fontSize: 11, color: Colors.grey.shade500),
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

  static Color _typeColour(String type) => switch (type) {
        'lab' || 'lab_result' => const Color(0xFF0284C7),
        'medication' || 'prescription' => const Color(0xFF7C3AED),
        'note' => const Color(0xFF059669),
        'admission' || 'discharge' => const Color(0xFFD97706),
        'vitals' => const Color(0xFFDB2777),
        _ => const Color(0xFF64748B),
      };
}

/// Start Scribe / New Order / Prescribe.
class _QuickActions extends StatelessWidget {
  const _QuickActions({required this.state});

  final ChartReady state;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surface,
          border: Border(top: BorderSide(color: Colors.grey.shade300)),
        ),
        child: Row(
          children: [
            Expanded(
              child: _ActionButton(
                icon: Icons.mic,
                label: 'Scribe',
                onPressed: () => _openScribe(context),
              ),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: _ActionButton(
                icon: Icons.add_chart,
                label: 'New order',
                onPressed: () => _openOrders(context, initialTab: 0),
              ),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: _ActionButton(
                icon: Icons.edit_note,
                label: 'Prescribe',
                onPressed: () => _openOrders(context, initialTab: 2),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _openScribe(BuildContext context) {
    final api = context.read<ApiClient>();
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => BlocProvider(
          create: (_) => ScribeBloc(api: api),
          child: ScribeScreen(
            patientId: state.patient.id,
            encounterId: state.encounterId ?? '',
            patientName: state.patient.fullName,
          ),
        ),
      ),
    );
  }

  void _openOrders(BuildContext context, {required int initialTab}) {
    final api = context.read<ApiClient>();
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => BlocProvider(
          create: (_) => OrdersBloc(api: api),
          child: OrdersScreen(
            patientId: state.patient.id,
            encounterId: state.encounterId,
            patientName: state.patient.fullName,
            initialTab: initialTab,
          ),
        ),
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  const _ActionButton({
    required this.icon,
    required this.label,
    required this.onPressed,
  });

  final IconData icon;
  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return FilledButton.tonalIcon(
      onPressed: onPressed,
      icon: Icon(icon, size: 18),
      label: Text(label, style: const TextStyle(fontSize: 12)),
      style: FilledButton.styleFrom(
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 4),
      ),
    );
  }
}
