/// Bedside five-rights verification, mirrored from the server so the device can
/// block a wrong-patient scan before any request is made.
library;

enum MedicationRight { patient, medication, dose, route, time }

class RightCheck {
  const RightCheck({required this.right, required this.ok, required this.detail});

  final MedicationRight right;
  final bool ok;
  final String detail;
}

class FiveRightsResult {
  const FiveRightsResult({
    required this.verified,
    required this.wrongPatient,
    required this.checks,
  });

  final bool verified;

  /// A wrong patient is fatal: the UI must show a full-screen block and stop.
  final bool wrongPatient;
  final List<RightCheck> checks;

  List<RightCheck> get failures => checks.where((c) => !c.ok).toList();
}

String _normalise(String value) => value.trim().toUpperCase();

FiveRightsResult verifyFiveRights({
  required String scannedPatientBarcode,
  required String expectedPatientBarcode,
  required String scannedMedicationBarcode,
  required String expectedMedicationBarcode,
  required num doseGiven,
  required num doseOrdered,
  required String routeGiven,
  required String routeOrdered,
  DateTime? scheduledAt,
  required DateTime administeredAt,
  int timeWindowMinutes = 60,
}) {
  final patientOk = _normalise(scannedPatientBarcode) == _normalise(expectedPatientBarcode);
  final medicationOk =
      _normalise(scannedMedicationBarcode) == _normalise(expectedMedicationBarcode);
  final doseOk = doseGiven == doseOrdered;
  final routeOk = _normalise(routeGiven) == _normalise(routeOrdered);

  final driftMinutes = scheduledAt == null
      ? 0
      : administeredAt.difference(scheduledAt).inMinutes.abs();
  final timeOk = scheduledAt == null || driftMinutes <= timeWindowMinutes;

  final checks = <RightCheck>[
    RightCheck(
      right: MedicationRight.patient,
      ok: patientOk,
      detail: patientOk
          ? 'Patient wristband matches'
          : 'WRONG PATIENT — wristband does not match this order',
    ),
    RightCheck(
      right: MedicationRight.medication,
      ok: medicationOk,
      detail: medicationOk
          ? 'Medication barcode matches'
          : 'Medication barcode does not match this order',
    ),
    RightCheck(
      right: MedicationRight.dose,
      ok: doseOk,
      detail: doseOk ? 'Dose matches the order' : 'Dose $doseGiven does not match ordered $doseOrdered',
    ),
    RightCheck(
      right: MedicationRight.route,
      ok: routeOk,
      detail: routeOk ? 'Route matches the order' : 'Route $routeGiven does not match ordered $routeOrdered',
    ),
    RightCheck(
      right: MedicationRight.time,
      ok: timeOk,
      detail: timeOk
          ? 'Within the administration window'
          : '$driftMinutes minutes outside the $timeWindowMinutes-minute window',
    ),
  ];

  return FiveRightsResult(
    verified: checks.every((c) => c.ok),
    wrongPatient: !patientOk,
    checks: checks,
  );
}
