/// Model parsing and the derived values screens depend on.
///
/// The parsing tests are all about a server response that is not quite what was
/// expected — a missing key, a null relation, a number sent as a string. Every
/// one of those has to render as an absence rather than crash a ward list.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:medicore_mobile/core/models.dart';

void main() {
  group('asRows', () {
    test('reads a bare array', () {
      expect(
          asRows([
            {'id': '1'},
            {'id': '2'},
          ]).length,
          2);
    });

    test('reads the paginated envelope', () {
      expect(
        asRows({
          'data': [
            {'id': '1'},
          ],
          'total': 1,
        }).length,
        1,
      );
    });

    test('returns empty for anything else rather than throwing', () {
      expect(asRows(null), isEmpty);
      expect(asRows('nonsense'), isEmpty);
      expect(asRows({'unexpected': true}), isEmpty);
    });

    test('skips non-object entries inside a list', () {
      expect(
        asRows([
          {'id': '1'},
          'junk',
          null,
        ]).length,
        1,
      );
    });
  });

  group('Patient', () {
    Map<String, dynamic> json({Map<String, dynamic> over = const {}}) => {
          'id': 'p1',
          'mrn': 'MRN26000001',
          'given_names': ['Amina', 'Noor'],
          'family_name': 'Rahman',
          'birth_date': '1990-03-14',
          'gender': 'female',
          ...over,
        };

    test('joins the full name and derives initials', () {
      final patient = Patient.fromJson(json());
      expect(patient.fullName, 'Amina Noor Rahman');
      expect(patient.initials, 'AR');
    });

    test('survives an absent name without throwing', () {
      final patient = Patient.fromJson({'id': 'p1'});
      expect(patient.fullName, '');
      expect(patient.initials, '?');
      expect(patient.mrn, '');
    });

    test('reads the bed from a nested relation', () {
      final patient = Patient.fromJson(json(over: {
        'bed': {'ward': 'ICU', 'bed_number': '4'},
      }));
      expect(patient.ward, 'ICU');
      expect(patient.bed, '4');
      expect(patient.location, 'ICU · 4');
    });

    test('reads the bed from flat fields when there is no relation', () {
      final patient = Patient.fromJson(json(over: {'ward': 'Ward A', 'bed_number': '12'}));
      expect(patient.location, 'Ward A · 12');
    });

    test('reports no location rather than an empty separator', () {
      expect(Patient.fromJson(json()).location, isNull);
    });

    test('gives just the half it has', () {
      expect(Patient.fromJson(json(over: {'ward': 'Ward A'})).location, 'Ward A');
    });

    test('computes age, accounting for whether the birthday has passed', () {
      final born = DateTime.now().subtract(const Duration(days: 365 * 30 + 8));
      final patient = Patient.fromJson(json(over: {
        'birth_date': born.toIso8601String(),
      }));
      expect(patient.ageYears, anyOf(29, 30));
    });

    test('has no age when no birth date was sent', () {
      expect(Patient.fromJson({'id': 'p1'}).ageYears, isNull);
    });

    test('falls back through the chief-complaint spellings', () {
      expect(
        Patient.fromJson(json(over: {'admission_reason': 'Chest pain'})).chiefComplaint,
        'Chest pain',
      );
      expect(
        Patient.fromJson(json(over: {'reason_text': 'Review'})).chiefComplaint,
        'Review',
      );
    });
  });

  group('Appointment.joinable', () {
    final start = DateTime(2026, 8, 21, 14);

    Appointment appointment({
      bool telehealth = true,
      String status = 'booked',
    }) =>
        Appointment(
          id: 'a1',
          start: start,
          serviceType: 'Follow-up',
          status: status,
          minutesDuration: 15,
          isTelehealth: telehealth,
        );

    test('opens exactly fifteen minutes before the start', () {
      expect(
        appointment().joinable(start.subtract(const Duration(minutes: 16))),
        isFalse,
      );
      expect(
        appointment().joinable(start.subtract(const Duration(minutes: 15))),
        isTrue,
      );
    });

    test('stays open through the consultation', () {
      expect(appointment().joinable(start), isTrue);
      expect(appointment().joinable(start.add(const Duration(minutes: 45))), isTrue);
    });

    test('closes when the room expires two hours in', () {
      expect(
        appointment().joinable(start.add(const Duration(minutes: 119))),
        isTrue,
      );
      expect(appointment().joinable(start.add(const Duration(hours: 2))), isFalse);
    });

    test('is never joinable for an in-person appointment', () {
      expect(appointment(telehealth: false).joinable(start), isFalse);
    });

    test('is never joinable once cancelled or marked a no-show', () {
      expect(appointment(status: 'cancelled').joinable(start), isFalse);
      expect(appointment(status: 'noshow').joinable(start), isFalse);
    });

    test('uses the same window the server does', () {
      expect(Appointment.joinWindowMinutes, 15);
    });
  });

  group('Appointment.isUpcoming', () {
    final start = DateTime(2026, 8, 21, 14);
    final before = start.subtract(const Duration(hours: 1));

    Appointment appointment(String status) => Appointment(
          id: 'a1',
          start: start,
          serviceType: 'Follow-up',
          status: status,
          minutesDuration: 15,
        );

    test('a booked future appointment is upcoming', () {
      expect(appointment('booked').isUpcoming(before), isTrue);
    });

    test('a finished or abandoned appointment never is', () {
      for (final status in ['cancelled', 'noshow', 'fulfilled']) {
        expect(appointment(status).isUpcoming(before), isFalse, reason: status);
      }
    });

    test('a past appointment is not upcoming', () {
      expect(
        appointment('booked').isUpcoming(start.add(const Duration(minutes: 1))),
        isFalse,
      );
    });
  });

  group('LabResult flags', () {
    LabResult result({
      num? value,
      num? low,
      num? high,
      String? interpretation,
      bool critical = false,
    }) =>
        LabResult.fromJson({
          'id': 'r1',
          'display': 'Potassium',
          'performed_at': '2026-08-21T09:00:00Z',
          'value_quantity': value,
          'reference_low': low,
          'reference_high': high,
          'interpretation': interpretation,
          'is_critical': critical,
          'unit': 'mmol/L',
        });

    test('prefers the interpretation the lab supplied', () {
      expect(result(value: 5.0, low: 3.5, high: 5.3, interpretation: 'H').flag, 'H');
    });

    test('derives the flag from the reference range when none was supplied', () {
      expect(result(value: 6.0, low: 3.5, high: 5.3).flag, 'H');
      expect(result(value: 2.9, low: 3.5, high: 5.3).flag, 'L');
      expect(result(value: 4.2, low: 3.5, high: 5.3).flag, isNull);
    });

    test('treats a normal interpretation code as no flag', () {
      expect(result(value: 4.2, interpretation: 'N').flag, isNull);
    });

    test('has no flag without a value to compare', () {
      expect(result(low: 3.5, high: 5.3).flag, isNull);
    });

    test('marks panic values apart from ordinary abnormals', () {
      expect(result(value: 7.5, interpretation: 'HH').isPanic, isTrue);
      expect(result(value: 6.0, low: 3.5, high: 5.3).isPanic, isFalse);
      expect(result(value: 6.0, low: 3.5, high: 5.3, critical: true).isPanic, isTrue);
    });

    test('formats a whole number without a spurious decimal', () {
      expect(result(value: 5).valueLabel, '5 mmol/L');
      expect(result(value: 5.25).valueLabel, '5.25 mmol/L');
    });

    test('falls back to the string value, then to an em dash', () {
      final textual = LabResult.fromJson({
        'id': 'r2',
        'display': 'Culture',
        'performed_at': '2026-08-21T09:00:00Z',
        'value_string': 'No growth',
      });
      expect(textual.valueLabel, 'No growth');

      final empty = LabResult.fromJson({
        'id': 'r3',
        'display': 'Pending',
        'performed_at': '2026-08-21T09:00:00Z',
      });
      expect(empty.valueLabel, '—');
    });

    test('renders the reference range only when there is one', () {
      expect(result(value: 5, low: 3.5, high: 5.3).referenceLabel, '3.5–5.3 mmol/L');
      expect(result(value: 5).referenceLabel, isNull);
    });
  });

  group('Invoice', () {
    Invoice invoice({int balance = 5000, String status = 'issued', String? dueAt}) =>
        Invoice.fromJson({
          'id': 'i1',
          'invoice_number': 'INV-2026-000001',
          'currency': 'AED',
          'total_minor': 10000,
          'paid_minor': 10000 - balance,
          'balance_minor': balance,
          'status': status,
          'due_at': dueAt,
        });

    test('is outstanding while a balance remains', () {
      expect(invoice().isOutstanding, isTrue);
      expect(invoice(balance: 0, status: 'paid').isOutstanding, isFalse);
    });

    test('a cancelled invoice is never outstanding, balance or not', () {
      expect(invoice(status: 'cancelled').isOutstanding, isFalse);
    });

    test('is overdue only when unpaid and past the due date', () {
      final past = DateTime(2026, 8, 1).toIso8601String();
      final now = DateTime(2026, 8, 21);
      expect(invoice(dueAt: past).isOverdue(now), isTrue);
      expect(invoice(balance: 0, status: 'paid', dueAt: past).isOverdue(now), isFalse);
      expect(invoice().isOverdue(now), isFalse);
    });
  });

  group('formatMoney', () {
    test('uses two minor digits by default', () {
      expect(formatMoney(12345, 'AED'), 'AED 123.45');
    });

    test('uses three for the Gulf dinars', () {
      // Getting this wrong reads as a thousandfold billing error.
      expect(formatMoney(12345, 'KWD'), 'KWD 12.345');
      expect(formatMoney(12345, 'BHD'), 'BHD 12.345');
    });

    test('uses none for yen', () {
      expect(formatMoney(12345, 'JPY'), 'JPY 12345');
    });

    test('normalises the currency code to upper case', () {
      expect(formatMoney(100, 'usd'), 'USD 1.00');
    });

    test('handles zero and negatives', () {
      expect(formatMoney(0, 'AED'), 'AED 0.00');
      expect(formatMoney(-500, 'AED'), 'AED -5.00');
    });
  });

  group('Prescription', () {
    test('builds the dose label the chart shows', () {
      final prescription = Prescription.fromJson({
        'id': 'm1',
        'code_display': 'Amoxicillin',
        'dose_quantity': 500,
        'dose_unit': 'mg',
        'route': 'oral',
        'frequency': 'TDS',
      });
      expect(prescription.doseLabel, '500 mg · oral · TDS');
    });

    test('reads a numeric dose sent as a string', () {
      final prescription = Prescription.fromJson({
        'id': 'm1',
        'code_display': 'Amoxicillin',
        'dose_quantity': '500',
        'dose_unit': 'mg',
        'route': 'oral',
        'frequency': 'TDS',
      });
      expect(prescription.doseQuantity, 500);
    });
  });

  group('Allergy', () {
    test('distinguishes high criticality, case-insensitively', () {
      expect(
        Allergy.fromJson({'id': 'a1', 'substance': 'Penicillin', 'criticality': 'HIGH'}).isHigh,
        isTrue,
      );
      expect(
        Allergy.fromJson({'id': 'a2', 'substance': 'Pollen', 'criticality': 'low'}).isHigh,
        isFalse,
      );
    });

    test('names an unknown substance rather than showing a blank', () {
      expect(Allergy.fromJson({'id': 'a3'}).substance, 'Unknown substance');
    });
  });

  group('ClinicalAlert', () {
    test('treats critical and life-threatening alike', () {
      for (final severity in ['critical', 'life-threatening']) {
        expect(
          ClinicalAlert.fromJson({'id': 'n1', 'severity': severity}).isCritical,
          isTrue,
          reason: severity,
        );
      }
      expect(ClinicalAlert.fromJson({'id': 'n2', 'severity': 'warning'}).isCritical, isFalse);
    });

    test('is unacknowledged until a timestamp arrives', () {
      expect(ClinicalAlert.fromJson({'id': 'n1'}).isAcknowledged, isFalse);
      expect(
        ClinicalAlert.fromJson({'id': 'n1', 'acknowledged_at': '2026-08-21T09:00:00Z'})
            .isAcknowledged,
        isTrue,
      );
    });
  });
}
