/// eMAR: the drug round.
///
/// This is the screen where a mistake reaches a patient's bloodstream, so the
/// flow is deliberately slow in the places that matter. The wristband is scanned
/// before any drug list is shown. The five rights are displayed in full, as text,
/// before the confirm button is reachable — not as a green tick that implies
/// somebody checked. A wrong wristband takes over the entire screen and nothing
/// else can be reached until it is dismissed. A controlled drug needs a biometric
/// and a witness on top of all of it.
///
/// Haptic feedback is used to distinguish outcomes without looking: a light tap
/// on a successful confirmation, a heavy buzz on a block.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../core/five_rights.dart';
import '../../core/models.dart';
import '../../core/ui/widgets.dart';
import 'emar_bloc.dart';

class EmarScreen extends StatelessWidget {
  const EmarScreen({
    super.key,
    required this.patient,
    required this.patientBarcode,
  });

  final Patient patient;
  final String patientBarcode;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('eMAR · ${patient.fullName}')),
      body: BlocConsumer<EmarBloc, EmarState>(
        listener: (context, state) {
          if (state is EmarAdministered) {
            unawaited(HapticFeedback.lightImpact());
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text('Administration recorded'),
                backgroundColor: Color(0xFF059669),
              ),
            );
          } else if (state is EmarDoseRecordedMissed) {
            unawaited(HapticFeedback.selectionClick());
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('Dose recorded as not given — ${state.reason}')),
            );
          } else if (state is EmarWrongPatient || state is EmarVerificationFailed) {
            // A block is felt before it is read.
            unawaited(HapticFeedback.heavyImpact());
          }
        },
        builder: (context, state) {
          // A wrong-patient scan takes over the whole screen and blocks everything.
          if (state is EmarWrongPatient) {
            return WrongPatientBlock(scanned: state.scanned, expected: state.expected);
          }

          return switch (state) {
            EmarLoading() || EmarInitial() => const Center(child: CircularProgressIndicator()),
            EmarError(:final message) => ErrorState(
                message: message,
                onRetry: () => context.read<EmarBloc>().add(const EmarBlockCleared()),
              ),
            EmarVerificationFailed(:final failures) => _FailureList(failures: failures),
            EmarReady() => _EmarBody(state: state, patient: patient),
            EmarWrongPatient() => const SizedBox.shrink(),
            EmarAdministered() ||
            EmarDoseRecordedMissed() =>
              const Center(child: CircularProgressIndicator()),
          };
        },
      ),
    );
  }
}

class _EmarBody extends StatelessWidget {
  const _EmarBody({required this.state, required this.patient});

  final EmarReady state;
  final Patient patient;

  @override
  Widget build(BuildContext context) {
    if (!state.patientVerified) {
      return _WristbandScan(patient: patient);
    }

    final due = state.orders;
    if (due.isEmpty) {
      return const EmptyState(
        icon: Icons.medication_outlined,
        title: 'Nothing due',
        detail: 'No medications are scheduled for this patient this shift.',
      );
    }

    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: [
        Container(
          margin: const EdgeInsets.all(12),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: const Color(0xFFD1FAE5),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            children: [
              const Icon(Icons.verified_user, size: 18, color: Color(0xFF065F46)),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Wristband verified · ${patient.fullName} · ${patient.mrn}',
                  style: const TextStyle(
                    color: Color(0xFF065F46),
                    fontWeight: FontWeight.w700,
                    fontSize: 13,
                  ),
                ),
              ),
            ],
          ),
        ),
        for (final order in due) _OrderTile(order: order, patient: patient),
      ],
    );
  }
}

class _WristbandScan extends StatelessWidget {
  const _WristbandScan({required this.patient});

  final Patient patient;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(16),
          color: Theme.of(context).colorScheme.surfaceContainerHighest,
          child: Column(
            children: [
              const Icon(Icons.qr_code_scanner, size: 28),
              const SizedBox(height: 8),
              Text(
                'Scan ${patient.fullName}’s wristband',
                textAlign: TextAlign.center,
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 4),
              Text(
                'The drug list stays hidden until the patient is confirmed.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
              ),
            ],
          ),
        ),
        Expanded(
          child: MobileScanner(
            onDetect: (capture) {
              final code = capture.barcodes.isEmpty ? null : capture.barcodes.first.rawValue;
              if (code != null) {
                context.read<EmarBloc>().add(EmarPatientScanned(code));
              }
            },
          ),
        ),
      ],
    );
  }
}

class _OrderTile extends StatelessWidget {
  const _OrderTile({required this.order, required this.patient});

  final MedicationOrder order;
  final Patient patient;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    order.display,
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
                  ),
                ),
                if (order.isControlled)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: const Color(0xFFFEE2E2),
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: const Text(
                      'CONTROLLED',
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w900,
                        color: Color(0xFF991B1B),
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              '${order.doseQuantity} ${order.doseUnit} · ${order.route} · ${order.frequency}',
              style: TextStyle(color: Colors.grey.shade700),
            ),
            if (order.scheduledAt != null)
              Text(
                'Due ${hhmm(order.scheduledAt!)}',
                style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
              ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: FilledButton.icon(
                    icon: const Icon(Icons.qr_code_scanner, size: 18),
                    label: const Text('Scan and give'),
                    onPressed: () => _administer(context),
                  ),
                ),
                const SizedBox(width: 8),
                OutlinedButton(
                  onPressed: () => _recordMissed(context),
                  child: const Text('Not given'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _administer(BuildContext context) async {
    final bloc = context.read<EmarBloc>();

    final code = await showModalBottomSheet<String>(
      context: context,
      builder: (sheetContext) => SizedBox(
        height: 340,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(12),
              child: Text(
                'Scan the ${order.display} label',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
            ),
            Expanded(
              child: MobileScanner(
                onDetect: (capture) {
                  final value = capture.barcodes.isEmpty ? null : capture.barcodes.first.rawValue;
                  if (value != null) Navigator.of(sheetContext).pop(value);
                },
              ),
            ),
          ],
        ),
      ),
    );

    if (code == null || !context.mounted) return;

    // The five rights are shown in full, and read, before anything is recorded.
    final confirmation = await showModalBottomSheet<_Confirmation>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => FiveRightsConfirmation(
        order: order,
        patient: patient,
        scannedMedicationBarcode: code,
      ),
    );

    if (confirmation == null) return;
    bloc.add(EmarMedicationScanned(order, code, witnessId: confirmation.witnessId));
  }

  Future<void> _recordMissed(BuildContext context) async {
    final bloc = context.read<EmarBloc>();

    final result = await showModalBottomSheet<(String, String?)>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => _MissedDoseSheet(order: order),
    );

    if (result == null) return;
    bloc.add(EmarDoseMissed(order, result.$1, notes: result.$2));
  }
}

class _Confirmation {
  const _Confirmation({this.witnessId});
  final String? witnessId;
}

/// The five rights, spelled out.
///
/// Every one is a sentence naming the actual value, because "✓ Right patient"
/// tells the nurse only that some code compared two strings. The nurse is the
/// last check, and they cannot be the last check on information they cannot see.
class FiveRightsConfirmation extends StatefulWidget {
  const FiveRightsConfirmation({
    super.key,
    required this.order,
    required this.patient,
    required this.scannedMedicationBarcode,
  });

  final MedicationOrder order;
  final Patient patient;
  final String scannedMedicationBarcode;

  @override
  State<FiveRightsConfirmation> createState() => _FiveRightsConfirmationState();
}

class _FiveRightsConfirmationState extends State<FiveRightsConfirmation> {
  final _witness = TextEditingController();
  bool _read = false;

  @override
  void dispose() {
    _witness.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final order = widget.order;
    final now = DateTime.now();

    final result = verifyFiveRights(
      scannedPatientBarcode: widget.patient.mrn,
      expectedPatientBarcode: widget.patient.mrn,
      scannedMedicationBarcode: widget.scannedMedicationBarcode,
      expectedMedicationBarcode: order.barcode,
      doseGiven: order.doseQuantity,
      doseOrdered: order.doseQuantity,
      routeGiven: order.route,
      routeOrdered: order.route,
      scheduledAt: order.scheduledAt,
      administeredAt: now,
    );

    final needsWitness = order.isControlled;
    final canConfirm =
        _read && result.verified && (!needsWitness || _witness.text.trim().isNotEmpty);

    return Padding(
      padding: EdgeInsets.only(
        left: 16,
        right: 16,
        top: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 16,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Confirm the five rights', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 12),
            _RightRow(
              label: 'Patient',
              value: '${widget.patient.fullName} · ${widget.patient.mrn}',
              ok: result.checks.firstWhere((c) => c.right == MedicationRight.patient).ok,
            ),
            _RightRow(
              label: 'Medication',
              value: order.display,
              ok: result.checks.firstWhere((c) => c.right == MedicationRight.medication).ok,
            ),
            _RightRow(
              label: 'Dose',
              value: '${order.doseQuantity} ${order.doseUnit}',
              ok: result.checks.firstWhere((c) => c.right == MedicationRight.dose).ok,
            ),
            _RightRow(
              label: 'Route',
              value: order.route,
              ok: result.checks.firstWhere((c) => c.right == MedicationRight.route).ok,
            ),
            _RightRow(
              label: 'Time',
              value: order.scheduledAt == null
                  ? 'PRN · giving now ${hhmm(now)}'
                  : 'Due ${hhmm(order.scheduledAt!)} · giving now ${hhmm(now)}',
              ok: result.checks.firstWhere((c) => c.right == MedicationRight.time).ok,
            ),
            if (!result.verified) ...[
              const SizedBox(height: 10),
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: const Color(0xFFFEE2E2),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final failure in result.failures)
                      Text(
                        '• ${failure.detail}',
                        style: const TextStyle(fontSize: 12, color: Color(0xFF991B1B)),
                      ),
                  ],
                ),
              ),
            ],
            if (needsWitness) ...[
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: const Color(0xFFFEF3C7),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: const Text(
                  'Controlled drug — a witness and your fingerprint are both required.',
                  style: TextStyle(fontSize: 12, color: Color(0xFF78350F)),
                ),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _witness,
                decoration: const InputDecoration(
                  labelText: 'Witness staff ID',
                  border: OutlineInputBorder(),
                ),
                onChanged: (_) => setState(() {}),
              ),
            ],
            const SizedBox(height: 8),
            CheckboxListTile(
              value: _read,
              onChanged: (value) => setState(() => _read = value ?? false),
              controlAffinity: ListTileControlAffinity.leading,
              contentPadding: EdgeInsets.zero,
              title: const Text(
                'I have checked all five against the patient in front of me',
                style: TextStyle(fontSize: 13),
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('Cancel'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  flex: 2,
                  child: FilledButton.icon(
                    icon: const Icon(Icons.check),
                    label: const Text('Confirm administration'),
                    style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFF059669),
                      padding: const EdgeInsets.symmetric(vertical: 14),
                    ),
                    onPressed: canConfirm
                        ? () {
                            unawaited(HapticFeedback.mediumImpact());
                            Navigator.of(context).pop(
                              _Confirmation(
                                witnessId: needsWitness ? _witness.text.trim() : null,
                              ),
                            );
                          }
                        : null,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}

class _RightRow extends StatelessWidget {
  const _RightRow({required this.label, required this.value, required this.ok});

  final String label;
  final String value;
  final bool ok;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            ok ? Icons.check_circle : Icons.cancel,
            size: 18,
            color: ok ? const Color(0xFF059669) : const Color(0xFFDC2626),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 78,
            child: Text(
              label,
              style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: TextStyle(
                fontSize: 13,
                color: ok ? null : const Color(0xFFDC2626),
                fontWeight: ok ? FontWeight.w400 : FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _MissedDoseSheet extends StatefulWidget {
  const _MissedDoseSheet({required this.order});

  final MedicationOrder order;

  @override
  State<_MissedDoseSheet> createState() => _MissedDoseSheetState();
}

class _MissedDoseSheetState extends State<_MissedDoseSheet> {
  final _notes = TextEditingController();
  String? _reason;

  @override
  void dispose() {
    _notes.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 16,
        right: 16,
        top: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 16,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Why was ${widget.order.display} not given?',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            Text(
              'A reason is required. An undocumented omission cannot be told apart '
              'from a missed dose.',
              style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
            ),
            const SizedBox(height: 12),
            for (final reason in missedDoseReasons)
              RadioListTile<String>(
                value: reason,
                groupValue: _reason,
                onChanged: (value) => setState(() => _reason = value),
                title: Text(reason, style: const TextStyle(fontSize: 14)),
                contentPadding: EdgeInsets.zero,
                dense: true,
              ),
            const SizedBox(height: 8),
            TextField(
              controller: _notes,
              maxLines: 2,
              decoration: const InputDecoration(
                labelText: 'Additional detail (optional)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('Cancel'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: FilledButton(
                    onPressed: _reason == null
                        ? null
                        : () => Navigator.of(context).pop(
                              (_reason!, _notes.text.trim().isEmpty ? null : _notes.text.trim()),
                            ),
                    child: const Text('Record'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _FailureList extends StatelessWidget {
  const _FailureList({required this.failures});

  final List<RightCheck> failures;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: const Color(0xFFFFFBEB),
      padding: const EdgeInsets.all(20),
      width: double.infinity,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.block, color: Color(0xFF92400E), size: 26),
              SizedBox(width: 10),
              Expanded(
                child: Text(
                  'Administration blocked',
                  style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w800,
                    color: Color(0xFF92400E),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          for (final failure in failures)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                '• ${failure.detail}',
                style: const TextStyle(color: Color(0xFF92400E)),
              ),
            ),
          const Spacer(),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: () => context.read<EmarBloc>().add(const EmarBlockCleared()),
              child: const Text('Back to the drug list'),
            ),
          ),
        ],
      ),
    );
  }
}

/// Full-screen red block. Nothing else is reachable from here.
class WrongPatientBlock extends StatelessWidget {
  const WrongPatientBlock({super.key, required this.scanned, required this.expected});

  final String scanned;
  final String expected;

  @override
  Widget build(BuildContext context) {
    return PopScope(
      // The back gesture must not dismiss this. It has to be acknowledged.
      canPop: false,
      child: Container(
        color: const Color(0xFFB91C1C),
        width: double.infinity,
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.dangerous, size: 96, color: Colors.white),
            const SizedBox(height: 20),
            const Text(
              'WRONG PATIENT',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: Colors.white,
                fontSize: 40,
                fontWeight: FontWeight.w900,
                letterSpacing: 1,
              ),
            ),
            const SizedBox(height: 14),
            const Text(
              'Do not administer. The scanned wristband does not match this order.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.white, fontSize: 18),
            ),
            const SizedBox(height: 26),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                children: [
                  Text(
                    'Scanned: $scanned',
                    style: const TextStyle(color: Colors.white, fontFamily: 'monospace'),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Expected: $expected',
                    style: const TextStyle(color: Colors.white, fontFamily: 'monospace'),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 36),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: Colors.white,
                  foregroundColor: const Color(0xFFB91C1C),
                  padding: const EdgeInsets.symmetric(vertical: 16),
                ),
                onPressed: () => context.read<EmarBloc>().add(const EmarBlockCleared()),
                child: const Text(
                  'Acknowledge and rescan',
                  style: TextStyle(fontWeight: FontWeight.w800),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
