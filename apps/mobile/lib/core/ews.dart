/// NEWS2 early-warning scoring, ported from `@medicore/shared-types`.
///
/// Duplicated on the device deliberately. A nurse entering observations at the
/// bedside needs the score and its colour the instant the last field is filled —
/// including on a ward with no signal — and a figure that appeared offline must
/// be the same figure the server computes when the reading finally syncs. The
/// bands below are therefore a literal transcription of `calculateEws`, not an
/// approximation of it.
///
/// Reference: RCP UK National Early Warning Score 2 (2017), SpO2 Scale 1.
library;

enum EwsRisk { low, medium, high }

/// ACVPU: Alert, new Confusion, Voice, Pain, Unresponsive.
enum Consciousness { alert, confusion, voice, pain, unresponsive }

extension ConsciousnessCode on Consciousness {
  String get code => switch (this) {
        Consciousness.alert => 'A',
        Consciousness.confusion => 'C',
        Consciousness.voice => 'V',
        Consciousness.pain => 'P',
        Consciousness.unresponsive => 'U',
      };

  String get label => switch (this) {
        Consciousness.alert => 'Alert',
        Consciousness.confusion => 'New confusion',
        Consciousness.voice => 'Responds to voice',
        Consciousness.pain => 'Responds to pain',
        Consciousness.unresponsive => 'Unresponsive',
      };
}

class EwsInput {
  const EwsInput({
    this.respiratoryRate,
    this.spo2,
    this.supplementalO2 = false,
    this.temperatureC,
    this.systolicBp,
    this.heartRate,
    this.consciousness,
  });

  final int? respiratoryRate;
  final int? spo2;
  final bool supplementalO2;
  final double? temperatureC;
  final int? systolicBp;
  final int? heartRate;
  final Consciousness? consciousness;
}

class EwsResult {
  const EwsResult({
    required this.score,
    required this.risk,
    required this.hasRedScore,
    required this.components,
    required this.missing,
    required this.response,
  });

  final int score;
  final EwsRisk risk;

  /// True when any single parameter scores 3 — that alone mandates escalation.
  final bool hasRedScore;
  final Map<String, int> components;

  /// Parameters that were not recorded. A score built on gaps is not comparable
  /// with a complete one, so the UI says which readings are absent.
  final List<String> missing;
  final String response;

  bool get isComplete => missing.isEmpty;
}

/// Returns the score for the first band the value falls in, or 3 when it falls
/// outside every band — which is always the most deranged end of the parameter.
int _band(num value, List<(num, num, int)> bands) {
  for (final (low, high, score) in bands) {
    if (value >= low && value <= high) return score;
  }
  return 3;
}

EwsResult calculateEws(EwsInput v) {
  final components = <String, int>{};
  final missing = <String>[];

  if (v.respiratoryRate == null) {
    missing.add('respiratory_rate');
  } else {
    components['respiratory_rate'] = _band(v.respiratoryRate!, const [
      (0, 8, 3),
      (9, 11, 1),
      (12, 20, 0),
      (21, 24, 2),
    ]);
  }

  if (v.spo2 == null) {
    missing.add('spo2');
  } else {
    components['spo2'] = _band(v.spo2!, const [
      (0, 91, 3),
      (92, 93, 2),
      (94, 95, 1),
      (96, 100, 0),
    ]);
  }

  components['supplemental_o2'] = v.supplementalO2 ? 2 : 0;

  if (v.temperatureC == null) {
    missing.add('temperature_c');
  } else {
    components['temperature_c'] = _band(v.temperatureC!, const [
      (0, 35.0, 3),
      (35.1, 36.0, 1),
      (36.1, 38.0, 0),
      (38.1, 39.0, 1),
      (39.1, 99, 2),
    ]);
  }

  if (v.systolicBp == null) {
    missing.add('systolic_bp');
  } else {
    components['systolic_bp'] = _band(v.systolicBp!, const [
      (0, 90, 3),
      (91, 100, 2),
      (101, 110, 1),
      (111, 219, 0),
    ]);
  }

  if (v.heartRate == null) {
    missing.add('heart_rate');
  } else {
    components['heart_rate'] = _band(v.heartRate!, const [
      (0, 40, 3),
      (41, 50, 1),
      (51, 90, 0),
      (91, 110, 1),
      (111, 130, 2),
    ]);
  }

  if (v.consciousness == null) {
    missing.add('consciousness');
  } else {
    components['consciousness'] = v.consciousness == Consciousness.alert ? 0 : 3;
  }

  final score = components.values.fold(0, (a, b) => a + b);
  final hasRedScore = components.values.any((c) => c == 3);

  // A single red score escalates even when the aggregate is low.
  final risk = score >= 7
      ? EwsRisk.high
      : (score >= 5 || hasRedScore)
          ? EwsRisk.medium
          : EwsRisk.low;

  final response = switch (risk) {
    EwsRisk.high => 'Emergency assessment by a critical care team; continuous monitoring',
    EwsRisk.medium =>
      'Urgent review by a clinician with acute competencies; monitor at least hourly',
    EwsRisk.low => score >= 1
        ? 'Ward-based response; minimum 4-6 hourly observations'
        : 'Routine monitoring; minimum 12 hourly observations',
  };

  return EwsResult(
    score: score,
    risk: risk,
    hasRedScore: hasRedScore,
    components: components,
    missing: missing,
    response: response,
  );
}

class CriticalVital {
  const CriticalVital({
    required this.parameter,
    required this.value,
    required this.threshold,
  });

  final String parameter;
  final num value;
  final String threshold;
}

/// Absolute values warranting an immediate alert regardless of the aggregate.
List<CriticalVital> detectCriticalVitals(EwsInput v) {
  final out = <CriticalVital>[];
  if (v.spo2 != null && v.spo2! < 88) {
    out.add(CriticalVital(parameter: 'SpO2', value: v.spo2!, threshold: '< 88%'));
  }
  if (v.systolicBp != null && v.systolicBp! < 80) {
    out.add(CriticalVital(parameter: 'Systolic BP', value: v.systolicBp!, threshold: '< 80 mmHg'));
  }
  if (v.systolicBp != null && v.systolicBp! > 220) {
    out.add(CriticalVital(parameter: 'Systolic BP', value: v.systolicBp!, threshold: '> 220 mmHg'));
  }
  if (v.heartRate != null && v.heartRate! > 130) {
    out.add(CriticalVital(parameter: 'Heart rate', value: v.heartRate!, threshold: '> 130 bpm'));
  }
  if (v.respiratoryRate != null && v.respiratoryRate! < 8) {
    out.add(CriticalVital(
        parameter: 'Respiratory rate', value: v.respiratoryRate!, threshold: '< 8/min'));
  }
  return out;
}
