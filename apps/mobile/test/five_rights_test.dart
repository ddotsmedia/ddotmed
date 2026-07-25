import 'package:flutter_test/flutter_test.dart';
import 'package:medicore_mobile/core/five_rights.dart';

void main() {
  final scheduled = DateTime.utc(2026, 7, 25, 8);
  final onTime = DateTime.utc(2026, 7, 25, 8, 15);

  FiveRightsResult run({
    String scannedPatient = 'MRN26000001',
    String scannedMedication = 'DRUG-161',
    num doseGiven = 500,
    String routeGiven = 'oral',
    DateTime? administeredAt,
    DateTime? scheduledAt,
    int window = 60,
  }) =>
      verifyFiveRights(
        scannedPatientBarcode: scannedPatient,
        expectedPatientBarcode: 'MRN26000001',
        scannedMedicationBarcode: scannedMedication,
        expectedMedicationBarcode: 'DRUG-161',
        doseGiven: doseGiven,
        doseOrdered: 500,
        routeGiven: routeGiven,
        routeOrdered: 'oral',
        scheduledAt: scheduledAt ?? scheduled,
        administeredAt: administeredAt ?? onTime,
        timeWindowMinutes: window,
      );

  group('verifyFiveRights', () {
    test('passes when every right matches', () {
      final result = run();
      expect(result.verified, isTrue);
      expect(result.wrongPatient, isFalse);
      expect(result.failures, isEmpty);
    });

    test('flags a wrong patient distinctly', () {
      final result = run(scannedPatient: 'MRN26000099');
      expect(result.verified, isFalse);
      expect(result.wrongPatient, isTrue);
      expect(result.failures.first.detail, contains('WRONG PATIENT'));
    });

    test('flags a medication mismatch without a wrong-patient flag', () {
      final result = run(scannedMedication: 'DRUG-999');
      expect(result.verified, isFalse);
      expect(result.wrongPatient, isFalse);
      expect(result.failures.single.right, MedicationRight.medication);
    });

    test('flags dose and route mismatches', () {
      expect(run(doseGiven: 250).failures.single.right, MedicationRight.dose);
      expect(run(routeGiven: 'IV').failures.single.right, MedicationRight.route);
    });

    test('ignores case and whitespace on barcodes', () {
      expect(run(scannedPatient: '  mrn26000001 ').verified, isTrue);
    });

    test('fails outside the administration window, early or late', () {
      expect(
        run(administeredAt: DateTime.utc(2026, 7, 25, 10, 30)).failures.single.right,
        MedicationRight.time,
      );
      expect(
        run(administeredAt: DateTime.utc(2026, 7, 25, 6)).failures.single.right,
        MedicationRight.time,
      );
    });

    test('skips the time check for an unscheduled PRN dose', () {
      final result = verifyFiveRights(
        scannedPatientBarcode: 'MRN26000001',
        expectedPatientBarcode: 'MRN26000001',
        scannedMedicationBarcode: 'DRUG-161',
        expectedMedicationBarcode: 'DRUG-161',
        doseGiven: 500,
        doseOrdered: 500,
        routeGiven: 'oral',
        routeOrdered: 'oral',
        scheduledAt: null,
        administeredAt: DateTime.utc(2026, 7, 25, 23),
      );
      expect(result.verified, isTrue);
    });

    test('honours a narrower time window', () {
      expect(run(window: 10).failures.single.right, MedicationRight.time);
    });

    test('reports every failing right, not just the first', () {
      final result = run(scannedPatient: 'X', doseGiven: 1, routeGiven: 'IV');
      expect(
        result.failures.map((f) => f.right).toSet(),
        {MedicationRight.patient, MedicationRight.dose, MedicationRight.route},
      );
    });
  });
}
