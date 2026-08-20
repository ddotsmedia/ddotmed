/// Vitals entry with a live EWS.
///
/// The score band sits at the top of the form and updates as fields are filled,
/// so escalation is prompted while the nurse is still at the bedside. It also
/// says plainly how many parameters are missing: a score of 1 from two readings
/// is not the same as a score of 1 from seven, and presenting them identically
/// would be the more dangerous choice.
library;

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/ews.dart';
import '../../core/ui/widgets.dart';
import 'vitals_bloc.dart';

class VitalsScreen extends StatelessWidget {
  const VitalsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<VitalsBloc, VitalsState>(
      builder: (context, state) => switch (state) {
        VitalsSearching() => _PatientSearch(state: state),
        VitalsEntry() => _EntryForm(state: state),
        VitalsSaved() => _SavedView(state: state),
        VitalsError(:final message) => ErrorState(
            message: message,
            onRetry: () => context.read<VitalsBloc>().add(const VitalsFormReset()),
          ),
      },
    );
  }
}

class _PatientSearch extends StatefulWidget {
  const _PatientSearch({required this.state});

  final VitalsSearching state;

  @override
  State<_PatientSearch> createState() => _PatientSearchState();
}

class _PatientSearchState extends State<_PatientSearch> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(16),
          child: TextField(
            controller: _controller,
            autofocus: true,
            decoration: const InputDecoration(
              labelText: 'Find a patient',
              hintText: 'Name, MRN or bed',
              prefixIcon: Icon(Icons.search),
              border: OutlineInputBorder(),
            ),
            onChanged: (value) => context.read<VitalsBloc>().add(VitalsPatientSearched(value)),
          ),
        ),
        if (widget.state.busy) const LinearProgressIndicator(),
        Expanded(
          child: widget.state.results.isEmpty
              ? const EmptyState(
                  icon: Icons.person_search,
                  title: 'Search for a patient',
                  detail: 'Observations attach to a named patient.',
                )
              : ListView(
                  children: [
                    for (final patient in widget.state.results)
                      ListTile(
                        leading: CircleAvatar(child: Text(patient.initials)),
                        title: Text(patient.fullName),
                        subtitle: Text(
                          [patient.mrn, if (patient.location != null) patient.location!]
                              .join(' · '),
                        ),
                        onTap: () => context.read<VitalsBloc>().add(VitalsPatientSelected(patient)),
                      ),
                  ],
                ),
        ),
      ],
    );
  }
}

class _EntryForm extends StatefulWidget {
  const _EntryForm({required this.state});

  final VitalsEntry state;

  @override
  State<_EntryForm> createState() => _EntryFormState();
}

class _EntryFormState extends State<_EntryForm> {
  final _respiratoryRate = TextEditingController();
  final _spo2 = TextEditingController();
  final _temperature = TextEditingController();
  final _systolic = TextEditingController();
  final _diastolic = TextEditingController();
  final _heartRate = TextEditingController();
  final _pain = TextEditingController();

  bool _supplementalO2 = false;
  Consciousness? _consciousness = Consciousness.alert;

  @override
  void dispose() {
    _respiratoryRate.dispose();
    _spo2.dispose();
    _temperature.dispose();
    _systolic.dispose();
    _diastolic.dispose();
    _heartRate.dispose();
    _pain.dispose();
    super.dispose();
  }

  EwsInput get _input => EwsInput(
        respiratoryRate: int.tryParse(_respiratoryRate.text.trim()),
        spo2: int.tryParse(_spo2.text.trim()),
        supplementalO2: _supplementalO2,
        temperatureC: double.tryParse(_temperature.text.trim()),
        systolicBp: int.tryParse(_systolic.text.trim()),
        heartRate: int.tryParse(_heartRate.text.trim()),
        consciousness: _consciousness,
      );

  void _recalculate() => context.read<VitalsBloc>().add(VitalsFieldChanged(_input));

  @override
  Widget build(BuildContext context) {
    final state = widget.state;

    return Column(
      children: [
        _ScoreHeader(state: state),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              _Field(
                controller: _systolic,
                label: 'Systolic BP',
                suffix: 'mmHg',
                onChanged: _recalculate,
              ),
              _Field(
                controller: _diastolic,
                label: 'Diastolic BP',
                suffix: 'mmHg',
                // Not part of NEWS2, so it does not trigger a recalculation.
                onChanged: () {},
              ),
              _Field(
                controller: _heartRate,
                label: 'Heart rate',
                suffix: 'bpm',
                onChanged: _recalculate,
              ),
              _Field(
                controller: _spo2,
                label: 'SpO₂',
                suffix: '%',
                onChanged: _recalculate,
              ),
              SwitchListTile(
                value: _supplementalO2,
                onChanged: (value) {
                  setState(() => _supplementalO2 = value);
                  _recalculate();
                },
                title: const Text('On supplemental oxygen'),
                subtitle: const Text('Adds 2 to the NEWS2 score'),
                contentPadding: EdgeInsets.zero,
              ),
              _Field(
                controller: _temperature,
                label: 'Temperature',
                suffix: '°C',
                decimal: true,
                onChanged: _recalculate,
              ),
              _Field(
                controller: _respiratoryRate,
                label: 'Respiratory rate',
                suffix: '/min',
                onChanged: _recalculate,
              ),
              const SizedBox(height: 8),
              DropdownButtonFormField<Consciousness>(
                value: _consciousness,
                decoration: const InputDecoration(
                  labelText: 'Consciousness (ACVPU)',
                  border: OutlineInputBorder(),
                ),
                items: [
                  for (final level in Consciousness.values)
                    DropdownMenuItem(value: level, child: Text(level.label)),
                ],
                onChanged: (value) {
                  setState(() => _consciousness = value);
                  _recalculate();
                },
              ),
              const SizedBox(height: 12),
              _Field(
                controller: _pain,
                label: 'Pain score (0–10)',
                suffix: '',
                onChanged: () {},
              ),
              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  style: FilledButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 14),
                  ),
                  onPressed: state.isEmpty
                      ? null
                      : () => context.read<VitalsBloc>().add(
                            VitalsSubmitted(
                              input: _input,
                              diastolicBp: int.tryParse(_diastolic.text.trim()),
                              painScore: int.tryParse(_pain.text.trim()),
                            ),
                          ),
                  child: const Text('Record observations'),
                ),
              ),
              const SizedBox(height: 8),
              Center(
                child: TextButton(
                  onPressed: () => context.read<VitalsBloc>().add(const VitalsFormReset()),
                  child: const Text('Choose a different patient'),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _ScoreHeader extends StatelessWidget {
  const _ScoreHeader({required this.state});

  final VitalsEntry state;

  @override
  Widget build(BuildContext context) {
    final result = state.result;
    final (background, foreground) = switch (result.risk) {
      EwsRisk.high => (const Color(0xFFDC2626), Colors.white),
      EwsRisk.medium => (const Color(0xFFFEF3C7), const Color(0xFF78350F)),
      EwsRisk.low => (const Color(0xFFD1FAE5), const Color(0xFF065F46)),
    };

    return Container(
      width: double.infinity,
      color: state.isEmpty ? Colors.grey.shade200 : background,
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            state.patient.fullName,
            style: TextStyle(
              fontWeight: FontWeight.w800,
              color: state.isEmpty ? Colors.grey.shade800 : foreground,
            ),
          ),
          Text(
            [
              state.patient.mrn,
              if (state.patient.location != null) state.patient.location!,
            ].join(' · '),
            style: TextStyle(
              fontSize: 12,
              color: state.isEmpty ? Colors.grey.shade700 : foreground,
            ),
          ),
          const SizedBox(height: 10),
          if (state.isEmpty)
            Text(
              'Enter observations — the score appears here',
              style: TextStyle(color: Colors.grey.shade700),
            )
          else ...[
            Row(
              children: [
                Text(
                  'NEWS2 ${result.score}',
                  style: TextStyle(
                    fontSize: 26,
                    fontWeight: FontWeight.w900,
                    color: foreground,
                  ),
                ),
                const SizedBox(width: 10),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: foreground.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    switch (result.risk) {
                      EwsRisk.high => 'HIGH RISK',
                      EwsRisk.medium => 'MEDIUM RISK',
                      EwsRisk.low => 'LOW RISK',
                    },
                    style: TextStyle(
                      color: foreground,
                      fontWeight: FontWeight.w800,
                      fontSize: 12,
                    ),
                  ),
                ),
                if (result.hasRedScore) ...[
                  const SizedBox(width: 8),
                  Icon(Icons.priority_high, size: 18, color: foreground),
                  Text(
                    'red score',
                    style: TextStyle(color: foreground, fontSize: 11),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 6),
            Text(
              result.response,
              style: TextStyle(fontSize: 12, color: foreground),
            ),
            if (state.critical.isNotEmpty) ...[
              const SizedBox(height: 6),
              for (final critical in state.critical)
                Text(
                  '⚠ ${critical.parameter} ${critical.value} — ${critical.threshold}',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: foreground,
                  ),
                ),
            ],
            if (result.missing.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  '${result.missing.length} parameter'
                  '${result.missing.length == 1 ? '' : 's'} not recorded — '
                  'the score is incomplete',
                  style: TextStyle(
                    fontSize: 11,
                    fontStyle: FontStyle.italic,
                    color: foreground,
                  ),
                ),
              ),
          ],
        ],
      ),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({
    required this.controller,
    required this.label,
    required this.suffix,
    required this.onChanged,
    this.decimal = false,
  });

  final TextEditingController controller;
  final String label;
  final String suffix;
  final VoidCallback onChanged;
  final bool decimal;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextField(
        controller: controller,
        keyboardType: TextInputType.numberWithOptions(decimal: decimal),
        decoration: InputDecoration(
          labelText: label,
          suffixText: suffix.isEmpty ? null : suffix,
          border: const OutlineInputBorder(),
        ),
        onChanged: (_) => onChanged(),
      ),
    );
  }
}

class _SavedView extends StatelessWidget {
  const _SavedView({required this.state});

  final VitalsSaved state;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              state.queuedOffline ? Icons.cloud_upload_outlined : Icons.check_circle,
              size: 64,
              color: state.queuedOffline ? const Color(0xFFD97706) : const Color(0xFF059669),
            ),
            const SizedBox(height: 16),
            Text(
              state.queuedOffline ? 'Held on this device' : 'Observations recorded',
              style: Theme.of(context).textTheme.titleLarge,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            Text(
              state.queuedOffline
                  ? 'There is no connection right now. The reading for '
                      '${state.patient.fullName} will sync automatically — until then '
                      'nobody else can see it.'
                  : '${state.patient.fullName} · NEWS2 ${state.result.score}',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.grey.shade700),
            ),
            if (state.result.risk != EwsRisk.low) ...[
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: state.result.risk == EwsRisk.high
                      ? const Color(0xFFFEE2E2)
                      : const Color(0xFFFEF3C7),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  state.result.response,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: state.result.risk == EwsRisk.high
                        ? const Color(0xFF991B1B)
                        : const Color(0xFF78350F),
                  ),
                ),
              ),
            ],
            const SizedBox(height: 24),
            FilledButton(
              onPressed: () => context.read<VitalsBloc>().add(const VitalsFormReset()),
              child: const Text('Record for another patient'),
            ),
          ],
        ),
      ),
    );
  }
}
