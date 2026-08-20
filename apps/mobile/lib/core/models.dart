/// Domain models shared by the three apps.
///
/// Every `fromJson` is deliberately forgiving about absence and strict about
/// type: a field the server has not sent becomes null or an empty list, never a
/// thrown exception, because one unexpected null must not blank a whole ward
/// list. Where a value is clinically load-bearing — an id, a dose — it is read
/// without a fallback so a malformed record fails loudly rather than rendering
/// as a plausible wrong number.
library;

import 'package:equatable/equatable.dart';

String? _str(Map<String, dynamic> json, String key) {
  final value = json[key];
  return value is String ? value : null;
}

num? _num(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is num) return value;
  if (value is String) return num.tryParse(value);
  return null;
}

DateTime? _date(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! String || value.isEmpty) return null;
  return DateTime.tryParse(value)?.toLocal();
}

List<String> _strings(Map<String, dynamic> json, String key) =>
    ((json[key] as List<dynamic>?) ?? const <dynamic>[])
        .whereType<String>()
        .toList(growable: false);

/// Normalises the two list shapes the API uses: a bare array, or `{data: [...]}`
/// from the paginated endpoints.
List<Map<String, dynamic>> asRows(dynamic value) {
  if (value is List) {
    return value.whereType<Map<String, dynamic>>().toList(growable: false);
  }
  if (value is Map<String, dynamic> && value['data'] is List) {
    return (value['data'] as List<dynamic>)
        .whereType<Map<String, dynamic>>()
        .toList(growable: false);
  }
  return const [];
}

class Patient extends Equatable {
  const Patient({
    required this.id,
    required this.mrn,
    required this.givenNames,
    required this.familyName,
    this.birthDate,
    this.gender,
    this.bed,
    this.ward,
    this.chiefComplaint,
    this.isVip = false,
  });

  final String id;
  final String mrn;
  final List<String> givenNames;
  final String familyName;
  final DateTime? birthDate;
  final String? gender;
  final String? bed;
  final String? ward;
  final String? chiefComplaint;
  final bool isVip;

  String get fullName => [...givenNames, familyName].where((p) => p.isNotEmpty).join(' ');

  /// Initials for the avatar, so a list renders before any photo loads.
  String get initials {
    final first = givenNames.isNotEmpty && givenNames.first.isNotEmpty ? givenNames.first[0] : '';
    final last = familyName.isNotEmpty ? familyName[0] : '';
    final joined = (first + last).toUpperCase();
    return joined.isEmpty ? '?' : joined;
  }

  int? get ageYears {
    final dob = birthDate;
    if (dob == null) return null;
    final now = DateTime.now();
    var age = now.year - dob.year;
    final hadBirthday = now.month > dob.month || (now.month == dob.month && now.day >= dob.day);
    if (!hadBirthday) age -= 1;
    return age < 0 ? null : age;
  }

  /// `Ward · Bed` where both are known, otherwise whichever half exists.
  String? get location {
    final parts = [ward, bed].where((p) => p != null && p.isNotEmpty).cast<String>().toList();
    return parts.isEmpty ? null : parts.join(' · ');
  }

  static Patient fromJson(Map<String, dynamic> json) {
    final bed = json['bed'];
    final bedMap = bed is Map<String, dynamic> ? bed : null;
    return Patient(
      id: json['id'] as String,
      mrn: _str(json, 'mrn') ?? '',
      givenNames: _strings(json, 'given_names'),
      familyName: _str(json, 'family_name') ?? '',
      birthDate: _date(json, 'birth_date'),
      gender: _str(json, 'gender'),
      bed: bedMap != null ? _str(bedMap, 'bed_number') : _str(json, 'bed_number'),
      ward: bedMap != null ? _str(bedMap, 'ward') : _str(json, 'ward'),
      chiefComplaint: _str(json, 'chief_complaint') ??
          _str(json, 'reason_text') ??
          _str(json, 'admission_reason'),
      isVip: (json['is_vip'] as bool?) ?? false,
    );
  }

  @override
  List<Object?> get props => [id, mrn, familyName, bed, ward];
}

class Appointment extends Equatable {
  const Appointment({
    required this.id,
    required this.start,
    required this.serviceType,
    required this.status,
    required this.minutesDuration,
    this.patient,
    this.practitionerName,
    this.specialty,
    this.reasonText,
    this.isTelehealth = false,
    this.queueToken,
  });

  final String id;
  final DateTime start;
  final String serviceType;
  final String status;
  final int minutesDuration;
  final Patient? patient;
  final String? practitionerName;
  final String? specialty;
  final String? reasonText;
  final bool isTelehealth;
  final String? queueToken;

  /// How early a participant may enter the video room, matching the server.
  static const joinWindowMinutes = 15;
  static const _roomLifetime = Duration(hours: 2);

  /// Whether the Join Video button should be live.
  ///
  /// Opens 15 minutes before the start and closes when the room expires. A button
  /// that leads to a dead room is worse than no button: the patient tries it, it
  /// fails, and they telephone the clinic anyway.
  bool joinable(DateTime now) {
    if (!isTelehealth) return false;
    if (status == 'cancelled' || status == 'noshow') return false;
    final opens = start.subtract(const Duration(minutes: joinWindowMinutes));
    return !now.isBefore(opens) && now.isBefore(start.add(_roomLifetime));
  }

  bool isUpcoming(DateTime now) =>
      !start.isBefore(now) && !const {'cancelled', 'noshow', 'fulfilled'}.contains(status);

  static Appointment fromJson(Map<String, dynamic> json) {
    final patient = json['patient'];
    return Appointment(
      id: json['id'] as String,
      start: _date(json, 'start') ?? DateTime.now(),
      serviceType: _str(json, 'service_type') ?? 'Consultation',
      status: _str(json, 'status') ?? 'booked',
      minutesDuration: (_num(json, 'minutes_duration') ?? 15).toInt(),
      patient: patient is Map<String, dynamic> ? Patient.fromJson(patient) : null,
      practitionerName: _personName(json['practitioner']),
      specialty: _str(json, 'specialty'),
      reasonText: _str(json, 'reason_text'),
      isTelehealth: (json['is_telehealth'] as bool?) ?? false,
      queueToken: _str(json, 'queue_token'),
    );
  }

  static String? _personName(dynamic value) {
    if (value is! Map<String, dynamic>) return null;
    final name = [..._strings(value, 'given_names'), _str(value, 'family_name') ?? '']
        .where((p) => p.isNotEmpty)
        .join(' ');
    return name.isEmpty ? null : name;
  }

  @override
  List<Object?> get props => [id, start, status];
}

class Allergy extends Equatable {
  const Allergy({
    required this.id,
    required this.substance,
    required this.criticality,
    this.reaction,
    this.category,
  });

  final String id;
  final String substance;
  final String criticality;
  final String? reaction;
  final String? category;

  /// High criticality turns the chart banner red; anything else is amber.
  bool get isHigh => criticality.toLowerCase() == 'high';

  static Allergy fromJson(Map<String, dynamic> json) => Allergy(
        id: json['id'] as String,
        substance: _str(json, 'substance') ?? _str(json, 'code_display') ?? 'Unknown substance',
        criticality: _str(json, 'criticality') ?? 'low',
        reaction: _str(json, 'reaction'),
        category: _str(json, 'category'),
      );

  @override
  List<Object?> get props => [id, substance, criticality];
}

class LabResult extends Equatable {
  const LabResult({
    required this.id,
    required this.display,
    required this.performedAt,
    this.valueQuantity,
    this.valueString,
    this.unit,
    this.referenceLow,
    this.referenceHigh,
    this.interpretation,
    this.isCritical = false,
    this.status,
  });

  final String id;
  final String display;
  final DateTime performedAt;
  final num? valueQuantity;
  final String? valueString;
  final String? unit;
  final num? referenceLow;
  final num? referenceHigh;
  final String? interpretation;
  final bool isCritical;
  final String? status;

  /// H / L / HH / LL as the lab reported it, falling back to the reference range
  /// when the result carries no interpretation code.
  String? get flag {
    final code = interpretation?.toUpperCase();
    if (code != null && code.isNotEmpty && code != 'N') return code;
    final value = valueQuantity;
    if (value == null) return null;
    final high = referenceHigh;
    final low = referenceLow;
    if (high != null && value > high) return 'H';
    if (low != null && value < low) return 'L';
    return null;
  }

  bool get isAbnormal => flag != null;

  /// Panic values, which render red rather than amber.
  bool get isPanic => isCritical || const {'HH', 'LL'}.contains(flag);

  String get valueLabel {
    final value = valueQuantity;
    if (value != null) {
      final formatted = value % 1 == 0 ? value.toInt().toString() : value.toStringAsFixed(2);
      final suffix = unit;
      return suffix == null || suffix.isEmpty ? formatted : '$formatted $suffix';
    }
    return valueString ?? '—';
  }

  String? get referenceLabel {
    if (referenceLow == null && referenceHigh == null) return null;
    final suffix = unit == null || unit!.isEmpty ? '' : ' $unit';
    return '${referenceLow ?? ''}–${referenceHigh ?? ''}$suffix';
  }

  static LabResult fromJson(Map<String, dynamic> json) => LabResult(
        id: json['id'] as String,
        display: _str(json, 'display') ?? 'Result',
        performedAt: _date(json, 'performed_at') ?? DateTime.now(),
        valueQuantity: _num(json, 'value_quantity'),
        valueString: _str(json, 'value_string'),
        unit: _str(json, 'unit'),
        referenceLow: _num(json, 'reference_low'),
        referenceHigh: _num(json, 'reference_high'),
        interpretation: _str(json, 'interpretation'),
        isCritical: (json['is_critical'] as bool?) ?? false,
        status: _str(json, 'status'),
      );

  @override
  List<Object?> get props => [id, display, performedAt, valueQuantity];
}

class VitalReading extends Equatable {
  const VitalReading({
    required this.id,
    required this.recordedAt,
    this.systolic,
    this.diastolic,
    this.heartRate,
    this.spo2,
    this.temperatureC,
    this.respiratoryRate,
    this.ewsScore,
    this.ewsRisk,
  });

  final String id;
  final DateTime recordedAt;
  final int? systolic;
  final int? diastolic;
  final int? heartRate;
  final int? spo2;
  final double? temperatureC;
  final int? respiratoryRate;
  final int? ewsScore;
  final String? ewsRisk;

  static VitalReading fromJson(Map<String, dynamic> json) => VitalReading(
        id: json['id'] as String,
        recordedAt: _date(json, 'recorded_at') ?? DateTime.now(),
        systolic: _num(json, 'systolic_bp')?.toInt(),
        diastolic: _num(json, 'diastolic_bp')?.toInt(),
        heartRate: _num(json, 'heart_rate')?.toInt(),
        spo2: _num(json, 'spo2')?.toInt(),
        temperatureC: _num(json, 'temperature_c')?.toDouble(),
        respiratoryRate: _num(json, 'respiratory_rate')?.toInt(),
        ewsScore: _num(json, 'ews_score')?.toInt(),
        ewsRisk: _str(json, 'ews_risk'),
      );

  @override
  List<Object?> get props => [id, recordedAt, ewsScore];
}

class Prescription extends Equatable {
  const Prescription({
    required this.id,
    required this.display,
    required this.doseQuantity,
    required this.doseUnit,
    required this.route,
    required this.frequency,
    this.instructions,
    this.status,
    this.endDate,
    this.refills,
    this.refillsUsed,
  });

  final String id;
  final String display;
  final num doseQuantity;
  final String doseUnit;
  final String route;
  final String frequency;
  final String? instructions;
  final String? status;
  final DateTime? endDate;
  final int? refills;
  final int? refillsUsed;

  String get doseLabel => '$doseQuantity $doseUnit · $route · $frequency';

  static Prescription fromJson(Map<String, dynamic> json) => Prescription(
        id: json['id'] as String,
        display: _str(json, 'code_display') ?? _str(json, 'display') ?? 'Medication',
        doseQuantity: _num(json, 'dose_quantity') ?? 0,
        doseUnit: _str(json, 'dose_unit') ?? '',
        route: _str(json, 'route') ?? '',
        frequency: _str(json, 'frequency') ?? '',
        instructions: _str(json, 'instructions'),
        status: _str(json, 'status'),
        endDate: _date(json, 'end_date'),
        refills: _num(json, 'refills')?.toInt(),
        refillsUsed: _num(json, 'refills_used')?.toInt(),
      );

  @override
  List<Object?> get props => [id, display, doseQuantity, route];
}

class Invoice extends Equatable {
  const Invoice({
    required this.id,
    required this.invoiceNumber,
    required this.currency,
    required this.totalMinor,
    required this.paidMinor,
    required this.balanceMinor,
    required this.status,
    this.dueAt,
  });

  final String id;
  final String invoiceNumber;
  final String currency;
  final int totalMinor;
  final int paidMinor;
  final int balanceMinor;
  final String status;
  final DateTime? dueAt;

  bool get isOutstanding => balanceMinor > 0 && status != 'cancelled';

  bool isOverdue(DateTime now) {
    final due = dueAt;
    return isOutstanding && due != null && due.isBefore(now);
  }

  static Invoice fromJson(Map<String, dynamic> json) => Invoice(
        id: json['id'] as String,
        invoiceNumber: _str(json, 'invoice_number') ?? '',
        currency: _str(json, 'currency') ?? 'AED',
        totalMinor: (_num(json, 'total_minor') ?? 0).toInt(),
        paidMinor: (_num(json, 'paid_minor') ?? 0).toInt(),
        balanceMinor: (_num(json, 'balance_minor') ?? 0).toInt(),
        status: _str(json, 'status') ?? 'issued',
        dueAt: _date(json, 'due_at'),
      );

  @override
  List<Object?> get props => [id, invoiceNumber, balanceMinor, status];
}

class ClinicalAlert extends Equatable {
  const ClinicalAlert({
    required this.id,
    required this.title,
    required this.body,
    required this.severity,
    required this.category,
    required this.createdAt,
    this.acknowledgedAt,
    this.patientId,
    this.requiresAcknowledgement = false,
  });

  final String id;
  final String title;
  final String body;
  final String severity;
  final String category;
  final DateTime createdAt;
  final DateTime? acknowledgedAt;
  final String? patientId;
  final bool requiresAcknowledgement;

  bool get isAcknowledged => acknowledgedAt != null;

  bool get isCritical => severity == 'critical' || severity == 'life-threatening';

  static ClinicalAlert fromJson(Map<String, dynamic> json) => ClinicalAlert(
        id: json['id'] as String,
        title: _str(json, 'title') ?? 'Alert',
        body: _str(json, 'body') ?? '',
        severity: _str(json, 'severity') ?? 'info',
        category: _str(json, 'category') ?? 'general',
        createdAt: _date(json, 'created_at') ?? DateTime.now(),
        acknowledgedAt: _date(json, 'acknowledged_at'),
        patientId: _str(json, 'patient_id'),
        requiresAcknowledgement: (json['requires_acknowledgement'] as bool?) ?? false,
      );

  @override
  List<Object?> get props => [id, severity, acknowledgedAt];
}

class TimelineEntry extends Equatable {
  const TimelineEntry({
    required this.id,
    required this.type,
    required this.at,
    required this.summary,
  });

  final String id;
  final String type;
  final DateTime at;
  final String summary;

  static TimelineEntry fromJson(Map<String, dynamic> json) => TimelineEntry(
        id: _str(json, 'id') ?? '',
        type: _str(json, 'type') ?? 'event',
        at: _date(json, 'at') ?? DateTime.now(),
        summary: _str(json, 'summary') ?? '',
      );

  @override
  List<Object?> get props => [id, type, at];
}

/// Formats integer minor units for display. Never used to compute anything.
///
/// Minor-unit digits vary by currency: three for the Gulf dinars, none for yen.
/// Getting this wrong reads as a thousandfold billing error.
String formatMoney(int amountMinor, String currency) {
  const threeDigit = {'BHD', 'JOD', 'KWD', 'OMR', 'TND'};
  const zeroDigit = {'JPY', 'KRW'};
  final upper = currency.toUpperCase();
  final digits = threeDigit.contains(upper)
      ? 3
      : zeroDigit.contains(upper)
          ? 0
          : 2;
  var divisor = 1;
  for (var i = 0; i < digits; i++) {
    divisor *= 10;
  }
  final major = amountMinor / divisor;
  return '$upper ${major.toStringAsFixed(digits)}';
}
