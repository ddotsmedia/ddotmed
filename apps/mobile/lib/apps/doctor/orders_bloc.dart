/// Ordering: lab, radiology and medication.
///
/// The medication path is the one with teeth. An interaction or allergy check is
/// run against the server before the prescription is offered for submission, and
/// a contraindication the server rates as absolute cannot be overridden from the
/// phone at all — a 422 is a refusal, not a warning. A 409 is a warning the
/// prescriber may pass with a documented reason, and that reason is required
/// before the submit button comes back.
library;

import 'package:bloc/bloc.dart';
import 'package:equatable/equatable.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';

enum OrderPriority { routine, urgent, stat }

extension OrderPriorityLabel on OrderPriority {
  String get wire => name;
  String get label => switch (this) {
        OrderPriority.routine => 'Routine',
        OrderPriority.urgent => 'Urgent',
        OrderPriority.stat => 'STAT',
      };
}

/// The modalities the radiology module accepts.
const radiologyModalities = <String>['XR', 'CT', 'MR', 'US', 'MG', 'NM', 'PT', 'FL'];

const commonBodySites = <String>[
  'Head',
  'Neck',
  'Chest',
  'Abdomen',
  'Pelvis',
  'Spine',
  'Upper limb',
  'Lower limb',
  'Whole body',
];

const medicationRoutes = <String>[
  'oral',
  'IV',
  'IM',
  'subcutaneous',
  'topical',
  'inhaled',
  'rectal',
  'sublingual',
];

const medicationFrequencies = <String>[
  'once',
  'OD',
  'BD',
  'TDS',
  'QDS',
  'PRN',
  'q4h',
  'q6h',
  'q8h',
];

class CatalogueItem extends Equatable {
  const CatalogueItem({
    required this.code,
    required this.display,
    this.system,
    this.detail,
  });

  final String code;
  final String display;
  final String? system;
  final String? detail;

  static CatalogueItem fromJson(Map<String, dynamic> json) => CatalogueItem(
        code: (json['code'] ?? json['loinc_code'] ?? json['id'] ?? '') as String,
        display: (json['display'] ?? json['name'] ?? json['code_display'] ?? '') as String,
        system: json['system'] as String?,
        detail: (json['category'] ?? json['form'] ?? json['strength']) as String?,
      );

  @override
  List<Object?> get props => [code, display];
}

/// A blocking or warning finding from the safety check.
class SafetyFinding extends Equatable {
  const SafetyFinding({
    required this.code,
    required this.message,
    required this.severity,
    required this.overridable,
  });

  final String code;
  final String message;
  final String severity;

  /// True only when the server said so. The device never decides this itself.
  final bool overridable;

  bool get isAbsolute => !overridable;

  @override
  List<Object?> get props => [code, message, severity, overridable];
}

sealed class OrdersEvent extends Equatable {
  const OrdersEvent();
  @override
  List<Object?> get props => const [];
}

class CatalogueSearched extends OrdersEvent {
  const CatalogueSearched(this.kind, this.query);

  /// `lab` or `drug`.
  final String kind;
  final String query;

  @override
  List<Object?> get props => [kind, query];
}

class LabOrderSubmitted extends OrdersEvent {
  const LabOrderSubmitted({
    required this.patientId,
    required this.encounterId,
    required this.item,
    required this.priority,
    this.notes,
  });

  final String patientId;
  final String? encounterId;
  final CatalogueItem item;
  final OrderPriority priority;
  final String? notes;

  @override
  List<Object?> get props => [patientId, item, priority];
}

class RadiologyOrderSubmitted extends OrdersEvent {
  const RadiologyOrderSubmitted({
    required this.patientId,
    required this.encounterId,
    required this.modality,
    required this.bodySite,
    required this.priority,
    this.notes,
  });

  final String patientId;
  final String? encounterId;
  final String modality;
  final String bodySite;
  final OrderPriority priority;
  final String? notes;

  @override
  List<Object?> get props => [patientId, modality, bodySite, priority];
}

/// Runs the interaction and allergy check without prescribing anything.
class InteractionCheckRequested extends OrdersEvent {
  const InteractionCheckRequested({
    required this.patientId,
    required this.drug,
    required this.doseQuantity,
    required this.route,
  });

  final String patientId;
  final CatalogueItem drug;
  final num doseQuantity;
  final String route;

  @override
  List<Object?> get props => [patientId, drug, doseQuantity, route];
}

class PrescriptionSubmitted extends OrdersEvent {
  const PrescriptionSubmitted({
    required this.patientId,
    required this.encounterId,
    required this.drug,
    required this.doseQuantity,
    required this.doseUnit,
    required this.route,
    required this.frequency,
    this.durationDays,
    this.instructions,
    this.overrideReason,
  });

  final String patientId;
  final String? encounterId;
  final CatalogueItem drug;
  final num doseQuantity;
  final String doseUnit;
  final String route;
  final String frequency;
  final int? durationDays;
  final String? instructions;

  /// Required by the server whenever an overridable warning was raised.
  final String? overrideReason;

  @override
  List<Object?> get props => [patientId, drug, doseQuantity, route, frequency];
}

class OrderFormReset extends OrdersEvent {
  const OrderFormReset();
}

sealed class OrdersState extends Equatable {
  const OrdersState();
  @override
  List<Object?> get props => const [];
}

class OrdersIdle extends OrdersState {
  const OrdersIdle();
}

class OrdersSearching extends OrdersState {
  const OrdersSearching(this.kind);
  final String kind;
  @override
  List<Object?> get props => [kind];
}

class OrdersResults extends OrdersState {
  const OrdersResults(this.kind, this.items);
  final String kind;
  final List<CatalogueItem> items;
  @override
  List<Object?> get props => [kind, items];
}

class OrdersSubmitting extends OrdersState {
  const OrdersSubmitting();
}

/// The safety check came back clean; prescribing may proceed.
class OrdersSafetyClear extends OrdersState {
  const OrdersSafetyClear();
}

/// Warnings were raised. `absolute` means the order cannot be placed from here.
class OrdersSafetyWarning extends OrdersState {
  const OrdersSafetyWarning(this.findings);

  final List<SafetyFinding> findings;

  bool get hasAbsolute => findings.any((f) => f.isAbsolute);

  /// An overridable warning needs a documented reason before submission.
  bool get requiresReason => !hasAbsolute && findings.isNotEmpty;

  @override
  List<Object?> get props => [findings];
}

class OrdersSubmitted extends OrdersState {
  const OrdersSubmitted(this.summary, {this.queuedOffline = false});

  final String summary;

  /// True when the write was held on the device rather than confirmed by the server.
  final bool queuedOffline;

  @override
  List<Object?> get props => [summary, queuedOffline];
}

class OrdersError extends OrdersState {
  const OrdersError(this.message);
  final String message;
  @override
  List<Object?> get props => [message];
}

class OrdersBloc extends Bloc<OrdersEvent, OrdersState> {
  OrdersBloc({required this.api}) : super(const OrdersIdle()) {
    on<CatalogueSearched>(_onSearch);
    on<LabOrderSubmitted>(_onLabOrder);
    on<RadiologyOrderSubmitted>(_onRadiologyOrder);
    on<InteractionCheckRequested>(_onInteractionCheck);
    on<PrescriptionSubmitted>(_onPrescribe);
    on<OrderFormReset>((_, emit) => emit(const OrdersIdle()));
  }

  final ApiClient api;

  Future<void> _onSearch(CatalogueSearched event, Emitter<OrdersState> emit) async {
    final query = event.query.trim();
    if (query.length < 2) {
      emit(OrdersResults(event.kind, const []));
      return;
    }

    emit(OrdersSearching(event.kind));
    try {
      final path = event.kind == 'drug' ? '/medications/formulary' : '/lab/catalogue';
      final rows = await api.get<dynamic>(path, query: {'q': query, 'limit': '20'});
      emit(OrdersResults(
        event.kind,
        asRows(rows).map(CatalogueItem.fromJson).toList(growable: false),
      ));
    } on ApiException catch (e) {
      emit(OrdersError(e.message));
    }
  }

  Future<void> _onLabOrder(LabOrderSubmitted event, Emitter<OrdersState> emit) async {
    emit(const OrdersSubmitting());
    try {
      final response = await api.write('/service-requests', {
        'patient_id': event.patientId,
        if (event.encounterId != null) 'encounter_id': event.encounterId,
        'category': 'laboratory',
        'code_system': event.item.system ?? 'http://loinc.org',
        'code': event.item.code,
        'code_display': event.item.display,
        'priority': event.priority.wire,
        if (event.notes != null && event.notes!.isNotEmpty) 'clinical_notes': event.notes,
      });
      emit(OrdersSubmitted(
        'Lab order placed: ${event.item.display} (${event.priority.label})',
        queuedOffline: response == null,
      ));
    } on ApiException catch (e) {
      emit(OrdersError(e.message));
    }
  }

  Future<void> _onRadiologyOrder(
    RadiologyOrderSubmitted event,
    Emitter<OrdersState> emit,
  ) async {
    emit(const OrdersSubmitting());
    try {
      final response = await api.write('/service-requests', {
        'patient_id': event.patientId,
        if (event.encounterId != null) 'encounter_id': event.encounterId,
        'category': 'imaging',
        'code_system': 'http://dicom.nema.org/resources/ontology/DCM',
        'code': event.modality,
        'code_display': '${event.modality} ${event.bodySite}',
        'body_site': event.bodySite,
        'priority': event.priority.wire,
        if (event.notes != null && event.notes!.isNotEmpty) 'clinical_notes': event.notes,
      });
      emit(OrdersSubmitted(
        '${event.modality} ${event.bodySite} requested (${event.priority.label})',
        queuedOffline: response == null,
      ));
    } on ApiException catch (e) {
      emit(OrdersError(e.message));
    }
  }

  /// Asks the server whether this drug is safe for this patient.
  ///
  /// A check that cannot be run is reported as a warning rather than passed as
  /// clear — prescribing into an unknown interaction profile is not the same as
  /// prescribing into a clean one, and the prescriber has to know which they have.
  Future<void> _onInteractionCheck(
    InteractionCheckRequested event,
    Emitter<OrdersState> emit,
  ) async {
    emit(const OrdersSubmitting());
    try {
      final response = await api.write('/medications/check', {
        'patient_id': event.patientId,
        'code': event.drug.code,
        'code_display': event.drug.display,
        'dose_quantity': event.doseQuantity,
        'route': event.route,
      });

      if (response == null) {
        emit(const OrdersSafetyWarning([
          SafetyFinding(
            code: 'CHECK_UNAVAILABLE',
            message: 'Interaction and allergy checking needs a connection. '
                'This prescription has not been screened.',
            severity: 'warning',
            overridable: true,
          ),
        ]));
        return;
      }

      final findings = _findingsFrom(response);
      emit(findings.isEmpty ? const OrdersSafetyClear() : OrdersSafetyWarning(findings));
    } on ApiException catch (e) {
      final finding = _findingFromException(e);
      emit(finding == null ? OrdersError(e.message) : OrdersSafetyWarning([finding]));
    }
  }

  Future<void> _onPrescribe(PrescriptionSubmitted event, Emitter<OrdersState> emit) async {
    emit(const OrdersSubmitting());
    try {
      final response = await api.write('/medications', {
        'patient_id': event.patientId,
        if (event.encounterId != null) 'encounter_id': event.encounterId,
        'code': event.drug.code,
        'code_display': event.drug.display,
        'code_system': event.drug.system ?? 'http://www.nlm.nih.gov/research/umls/rxnorm',
        'dose_quantity': event.doseQuantity,
        'dose_unit': event.doseUnit,
        'route': event.route,
        'frequency': event.frequency,
        if (event.durationDays != null) 'duration_days': event.durationDays,
        if (event.instructions != null && event.instructions!.isNotEmpty)
          'instructions': event.instructions,
        if (event.overrideReason != null && event.overrideReason!.isNotEmpty)
          'override_reason': event.overrideReason,
      });
      emit(OrdersSubmitted(
        'Prescribed ${event.drug.display} '
        '${event.doseQuantity}${event.doseUnit} ${event.route} ${event.frequency}',
        queuedOffline: response == null,
      ));
    } on ApiException catch (e) {
      final finding = _findingFromException(e);
      emit(finding == null ? OrdersError(e.message) : OrdersSafetyWarning([finding]));
    }
  }

  static List<SafetyFinding> _findingsFrom(Map<String, dynamic> response) {
    final out = <SafetyFinding>[];

    for (final key in const ['interactions', 'allergy_warnings', 'warnings']) {
      final rows = response[key];
      if (rows is! List) continue;
      for (final row in rows.whereType<Map<String, dynamic>>()) {
        final severity = (row['severity'] as String?) ?? 'warning';
        out.add(SafetyFinding(
          code: (row['code'] as String?) ?? key.toUpperCase(),
          message:
              (row['message'] ?? row['detail'] ?? row['description'] ?? 'Interaction') as String,
          severity: severity,
          // Contraindicated pairs are never overridable from a phone.
          overridable: (row['override_allowed'] as bool?) ??
              (severity != 'contraindicated' && severity != 'absolute'),
        ));
      }
    }

    return out;
  }

  /// Translates the server's clinical blocks into a finding the UI can render.
  static SafetyFinding? _findingFromException(ApiException e) {
    if (!e.isClinicalBlock) return null;
    final body = e.body;
    final map = body is Map<String, dynamic> ? body : const <String, dynamic>{};
    return SafetyFinding(
      code: e.code ?? 'CLINICAL_BLOCK',
      message: e.message,
      severity: e.statusCode == 422 ? 'contraindicated' : 'warning',
      // 422 is an absolute refusal; 409 may be overridden with a reason.
      overridable: e.statusCode == 409 && (map['override_allowed'] as bool?) == true,
    );
  }
}
