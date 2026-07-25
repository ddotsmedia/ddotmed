import 'package:bloc/bloc.dart';
import 'package:equatable/equatable.dart';

import '../core/api_client.dart';
import '../core/five_rights.dart';

class MedicationOrder extends Equatable {
  const MedicationOrder({
    required this.id,
    required this.display,
    required this.doseQuantity,
    required this.doseUnit,
    required this.route,
    required this.frequency,
    required this.barcode,
    required this.isControlled,
    this.scheduledAt,
  });

  final String id;
  final String display;
  final num doseQuantity;
  final String doseUnit;
  final String route;
  final String frequency;
  final String barcode;
  final bool isControlled;
  final DateTime? scheduledAt;

  static MedicationOrder fromJson(Map<String, dynamic> json) => MedicationOrder(
        id: json['id'] as String,
        display: json['code_display'] as String,
        doseQuantity: json['dose_quantity'] as num,
        doseUnit: json['dose_unit'] as String,
        route: json['route'] as String,
        frequency: json['frequency'] as String,
        barcode: json['code'] as String,
        isControlled: (json['is_controlled'] as bool?) ?? false,
        scheduledAt: json['scheduled_at'] == null
            ? null
            : DateTime.parse(json['scheduled_at'] as String),
      );

  @override
  List<Object?> get props => [id, display, doseQuantity, route, scheduledAt];
}

sealed class EmarEvent extends Equatable {
  const EmarEvent();
  @override
  List<Object?> get props => const [];
}

class EmarLoaded extends EmarEvent {
  const EmarLoaded(this.patientId, this.patientBarcode);
  final String patientId;
  final String patientBarcode;
  @override
  List<Object?> get props => [patientId, patientBarcode];
}

class EmarPatientScanned extends EmarEvent {
  const EmarPatientScanned(this.barcode);
  final String barcode;
  @override
  List<Object?> get props => [barcode];
}

class EmarMedicationScanned extends EmarEvent {
  const EmarMedicationScanned(this.order, this.barcode, {this.witnessId});
  final MedicationOrder order;
  final String barcode;
  final String? witnessId;
  @override
  List<Object?> get props => [order, barcode, witnessId];
}

class EmarBlockCleared extends EmarEvent {
  const EmarBlockCleared();
}

sealed class EmarState extends Equatable {
  const EmarState();
  @override
  List<Object?> get props => const [];
}

class EmarInitial extends EmarState {
  const EmarInitial();
}

class EmarLoading extends EmarState {
  const EmarLoading();
}

class EmarReady extends EmarState {
  const EmarReady({
    required this.orders,
    required this.patientBarcode,
    this.patientVerified = false,
  });

  final List<MedicationOrder> orders;
  final String patientBarcode;
  final bool patientVerified;

  EmarReady copyWith({bool? patientVerified}) => EmarReady(
        orders: orders,
        patientBarcode: patientBarcode,
        patientVerified: patientVerified ?? this.patientVerified,
      );

  @override
  List<Object?> get props => [orders, patientBarcode, patientVerified];
}

/// Terminal, blocking state. The UI must render a full-screen error and refuse
/// every further action until it is explicitly cleared.
class EmarWrongPatient extends EmarState {
  const EmarWrongPatient({required this.scanned, required this.expected});
  final String scanned;
  final String expected;
  @override
  List<Object?> get props => [scanned, expected];
}

class EmarVerificationFailed extends EmarState {
  const EmarVerificationFailed(this.failures);
  final List<RightCheck> failures;
  @override
  List<Object?> get props => [failures];
}

class EmarAdministered extends EmarState {
  const EmarAdministered(this.orderId);
  final String orderId;
  @override
  List<Object?> get props => [orderId];
}

class EmarError extends EmarState {
  const EmarError(this.message);
  final String message;
  @override
  List<Object?> get props => [message];
}

class EmarBloc extends Bloc<EmarEvent, EmarState> {
  EmarBloc({required this.api, this.onControlledDrugReauth})
      : super(const EmarInitial()) {
    on<EmarLoaded>(_onLoaded);
    on<EmarPatientScanned>(_onPatientScanned);
    on<EmarMedicationScanned>(_onMedicationScanned);
    on<EmarBlockCleared>((_, emit) => emit(const EmarInitial()));
  }

  final ApiClient api;

  /// Invoked before any controlled-drug administration; must return true to proceed.
  final Future<bool> Function(String reason)? onControlledDrugReauth;

  Future<void> _onLoaded(EmarLoaded event, Emitter<EmarState> emit) async {
    emit(const EmarLoading());
    try {
      final rows = await api.get<List<dynamic>>('/pharmacy/emar/${event.patientId}');
      emit(EmarReady(
        orders: rows
            .cast<Map<String, dynamic>>()
            .map(MedicationOrder.fromJson)
            .toList(growable: false),
        patientBarcode: event.patientBarcode,
      ));
    } on ApiException catch (e) {
      emit(EmarError(e.message));
    }
  }

  void _onPatientScanned(EmarPatientScanned event, Emitter<EmarState> emit) {
    final current = state;
    if (current is! EmarReady) return;

    if (event.barcode.trim().toUpperCase() != current.patientBarcode.trim().toUpperCase()) {
      emit(EmarWrongPatient(scanned: event.barcode, expected: current.patientBarcode));
      return;
    }
    emit(current.copyWith(patientVerified: true));
  }

  Future<void> _onMedicationScanned(
    EmarMedicationScanned event,
    Emitter<EmarState> emit,
  ) async {
    final current = state;
    if (current is! EmarReady) return;

    final now = DateTime.now();
    final result = verifyFiveRights(
      scannedPatientBarcode: current.patientVerified ? current.patientBarcode : '',
      expectedPatientBarcode: current.patientBarcode,
      scannedMedicationBarcode: event.barcode,
      expectedMedicationBarcode: event.order.barcode,
      doseGiven: event.order.doseQuantity,
      doseOrdered: event.order.doseQuantity,
      routeGiven: event.order.route,
      routeOrdered: event.order.route,
      scheduledAt: event.order.scheduledAt,
      administeredAt: now,
    );

    if (result.wrongPatient) {
      emit(EmarWrongPatient(scanned: 'unverified', expected: current.patientBarcode));
      return;
    }
    if (!result.verified) {
      emit(EmarVerificationFailed(result.failures));
      return;
    }

    // Controlled drugs require a fresh biometric confirmation at the bedside.
    if (event.order.isControlled) {
      final confirmed = await onControlledDrugReauth?.call(
            'Confirm administration of ${event.order.display}',
          ) ??
          false;
      if (!confirmed) {
        emit(const EmarError('Biometric confirmation is required for a controlled drug'));
        return;
      }
      if (event.witnessId == null || event.witnessId!.isEmpty) {
        emit(const EmarError('A witness is required for a controlled drug'));
        return;
      }
    }

    try {
      await api.write('/pharmacy/administer', {
        'medication_id': event.order.id,
        'dose_given': event.order.doseQuantity,
        'dose_unit': event.order.doseUnit,
        'route': event.order.route,
        'scanned_patient_barcode': current.patientBarcode,
        'scanned_medication_barcode': event.barcode,
        if (event.witnessId != null) 'witness_id': event.witnessId,
        if (event.order.scheduledAt != null)
          'scheduled_at': event.order.scheduledAt!.toIso8601String(),
      });
      emit(EmarAdministered(event.order.id));
      emit(current.copyWith(patientVerified: false));
    } on ApiException catch (e) {
      if (e.isWrongPatient) {
        emit(EmarWrongPatient(scanned: event.barcode, expected: current.patientBarcode));
        return;
      }
      emit(EmarError(e.message));
    }
  }
}
