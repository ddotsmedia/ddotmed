/// NEWS2 scoring.
///
/// These figures are transcribed from the RCP scoring table and cross-checked
/// against the server's `calculateEws`. A device that computes a different score
/// from the same observations is worse than one that computes none: the nurse
/// escalates on the number they were shown, and the chart shows a different one.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:medicore_mobile/core/ews.dart';

void main() {
  /// A completely normal adult. Every parameter scores zero.
  EwsInput normal({
    int? respiratoryRate = 16,
    int? spo2 = 98,
    bool supplementalO2 = false,
    double? temperatureC = 36.8,
    int? systolicBp = 120,
    int? heartRate = 70,
    Consciousness? consciousness = Consciousness.alert,
  }) =>
      EwsInput(
        respiratoryRate: respiratoryRate,
        spo2: spo2,
        supplementalO2: supplementalO2,
        temperatureC: temperatureC,
        systolicBp: systolicBp,
        heartRate: heartRate,
        consciousness: consciousness,
      );

  group('parameter bands', () {
    test('a normal set scores zero and is low risk', () {
      final result = calculateEws(normal());
      expect(result.score, 0);
      expect(result.risk, EwsRisk.low);
      expect(result.hasRedScore, isFalse);
      expect(result.missing, isEmpty);
      expect(result.isComplete, isTrue);
    });

    test('respiratory rate bands match the RCP table', () {
      expect(calculateEws(normal(respiratoryRate: 8)).components['respiratory_rate'], 3);
      expect(calculateEws(normal(respiratoryRate: 9)).components['respiratory_rate'], 1);
      expect(calculateEws(normal(respiratoryRate: 12)).components['respiratory_rate'], 0);
      expect(calculateEws(normal(respiratoryRate: 20)).components['respiratory_rate'], 0);
      expect(calculateEws(normal(respiratoryRate: 21)).components['respiratory_rate'], 2);
      // Anything above the last band is the most deranged score.
      expect(calculateEws(normal(respiratoryRate: 25)).components['respiratory_rate'], 3);
    });

    test('SpO2 bands match the RCP table, scale 1', () {
      expect(calculateEws(normal(spo2: 91)).components['spo2'], 3);
      expect(calculateEws(normal(spo2: 92)).components['spo2'], 2);
      expect(calculateEws(normal(spo2: 94)).components['spo2'], 1);
      expect(calculateEws(normal(spo2: 96)).components['spo2'], 0);
      expect(calculateEws(normal(spo2: 100)).components['spo2'], 0);
    });

    test('supplemental oxygen adds two', () {
      expect(calculateEws(normal(supplementalO2: true)).score, 2);
      expect(calculateEws(normal(supplementalO2: true)).components['supplemental_o2'], 2);
    });

    test('temperature bands match the RCP table', () {
      expect(calculateEws(normal(temperatureC: 35.0)).components['temperature_c'], 3);
      expect(calculateEws(normal(temperatureC: 35.5)).components['temperature_c'], 1);
      expect(calculateEws(normal(temperatureC: 37.0)).components['temperature_c'], 0);
      expect(calculateEws(normal(temperatureC: 38.5)).components['temperature_c'], 1);
      expect(calculateEws(normal(temperatureC: 39.5)).components['temperature_c'], 2);
    });

    test('systolic BP bands match the RCP table', () {
      expect(calculateEws(normal(systolicBp: 90)).components['systolic_bp'], 3);
      expect(calculateEws(normal(systolicBp: 95)).components['systolic_bp'], 2);
      expect(calculateEws(normal(systolicBp: 105)).components['systolic_bp'], 1);
      expect(calculateEws(normal(systolicBp: 150)).components['systolic_bp'], 0);
      // Hypertension above 219 scores 3, the same as shock.
      expect(calculateEws(normal(systolicBp: 230)).components['systolic_bp'], 3);
    });

    test('heart rate bands match the RCP table', () {
      expect(calculateEws(normal(heartRate: 40)).components['heart_rate'], 3);
      expect(calculateEws(normal(heartRate: 45)).components['heart_rate'], 1);
      expect(calculateEws(normal(heartRate: 70)).components['heart_rate'], 0);
      expect(calculateEws(normal(heartRate: 100)).components['heart_rate'], 1);
      expect(calculateEws(normal(heartRate: 120)).components['heart_rate'], 2);
      expect(calculateEws(normal(heartRate: 140)).components['heart_rate'], 3);
    });

    test('anything other than Alert scores three', () {
      expect(calculateEws(normal()).components['consciousness'], 0);
      for (final level in [
        Consciousness.confusion,
        Consciousness.voice,
        Consciousness.pain,
        Consciousness.unresponsive,
      ]) {
        expect(
          calculateEws(normal(consciousness: level)).components['consciousness'],
          3,
          reason: '${level.name} must score 3',
        );
      }
    });
  });

  group('risk banding', () {
    test('escalates to high at an aggregate of seven', () {
      // 3 (RR) + 2 (SpO2) + 2 (O2) = 7.
      final result = calculateEws(normal(respiratoryRate: 8, spo2: 92, supplementalO2: true));
      expect(result.score, 7);
      expect(result.risk, EwsRisk.high);
    });

    test('escalates to medium at an aggregate of five', () {
      // 2 (RR 21) + 2 (SpO2 92) + 1 (HR 100) = 5.
      final result = calculateEws(normal(respiratoryRate: 21, spo2: 92, heartRate: 100));
      expect(result.score, 5);
      expect(result.risk, EwsRisk.medium);
    });

    test('a single red score escalates even when the aggregate is low', () {
      // This is the clause that catches the deteriorating patient whose other
      // observations are still compensating.
      final result = calculateEws(normal(systolicBp: 88));
      expect(result.score, 3);
      expect(result.hasRedScore, isTrue);
      expect(result.risk, EwsRisk.medium);
    });

    test('an aggregate of three without a red score stays low risk', () {
      // 1 (RR 9) + 1 (temp 35.5) + 1 (HR 100) = 3, no single parameter at 3.
      final result = calculateEws(
        normal(respiratoryRate: 9, temperatureC: 35.5, heartRate: 100),
      );
      expect(result.score, 3);
      expect(result.hasRedScore, isFalse);
      expect(result.risk, EwsRisk.low);
    });
  });

  group('missing parameters', () {
    test('lists what was not recorded rather than scoring it zero', () {
      final result = calculateEws(const EwsInput(respiratoryRate: 16, spo2: 98));
      expect(
        result.missing,
        containsAll(['temperature_c', 'systolic_bp', 'heart_rate', 'consciousness']),
      );
      expect(result.isComplete, isFalse);
    });

    test('an empty observation set is not a score of zero-with-confidence', () {
      final result = calculateEws(const EwsInput());
      expect(result.score, 0);
      expect(result.missing.length, 6);
      expect(result.isComplete, isFalse);
    });
  });

  group('response guidance', () {
    test('names the escalation for each band', () {
      expect(
        calculateEws(normal(respiratoryRate: 8, spo2: 92, supplementalO2: true)).response,
        contains('critical care'),
      );
      expect(
        calculateEws(normal(respiratoryRate: 21, spo2: 92, heartRate: 100)).response,
        contains('Urgent review'),
      );
      expect(calculateEws(normal(heartRate: 100)).response, contains('Ward-based'));
      expect(calculateEws(normal()).response, contains('Routine'));
    });
  });

  group('detectCriticalVitals', () {
    test('flags values that warrant escalation on their own', () {
      expect(detectCriticalVitals(normal(spo2: 85)).single.parameter, 'SpO2');
      expect(detectCriticalVitals(normal(systolicBp: 75)).single.parameter, 'Systolic BP');
      expect(detectCriticalVitals(normal(systolicBp: 230)).single.threshold, '> 220 mmHg');
      expect(detectCriticalVitals(normal(heartRate: 150)).single.parameter, 'Heart rate');
      expect(
        detectCriticalVitals(normal(respiratoryRate: 6)).single.parameter,
        'Respiratory rate',
      );
    });

    test('reports nothing for a normal set', () {
      expect(detectCriticalVitals(normal()), isEmpty);
    });

    test('reports every breach, not just the first', () {
      final critical = detectCriticalVitals(normal(spo2: 80, heartRate: 150));
      expect(critical.map((c) => c.parameter), containsAll(['SpO2', 'Heart rate']));
    });

    test('ignores a parameter that was not recorded', () {
      expect(detectCriticalVitals(const EwsInput()), isEmpty);
    });
  });

  group('ACVPU codes', () {
    test('map to the single letters the server expects', () {
      expect(Consciousness.alert.code, 'A');
      expect(Consciousness.confusion.code, 'C');
      expect(Consciousness.voice.code, 'V');
      expect(Consciousness.pain.code, 'P');
      expect(Consciousness.unresponsive.code, 'U');
    });
  });
}
