/// Vitals entry.
///
/// The score is computed on the device as the fields are filled, so a nurse sees
/// the EWS band before they press submit rather than after. That is the whole
/// point: a score that arrives after the observation has been filed is a report,
/// but a score that appears while the cuff is still on the arm is a prompt to
/// escalate.
///
/// Submission goes through the offline queue. A ward with no signal is the normal
/// case, not the exception, and an observation held on the device is still an
/// observation — provided the nurse can see that it has not synced yet.
library;

import 'package:bloc/bloc.dart';
import 'package:equatable/equatable.dart';

import '../../core/api_client.dart';
import '../../core/ews.dart';
import '../../core/models.dart';

sealed class VitalsEvent extends Equatable {
  const VitalsEvent();
  @override
  List<Object?> get props => const [];
}

class VitalsPatientSearched extends VitalsEvent {
  const VitalsPatientSearched(this.query);
  final String query;
  @override
  List<Object?> get props => [query];
}

class VitalsPatientSelected extends VitalsEvent {
  const VitalsPatientSelected(this.patient);
  final Patient patient;
  @override
  List<Object?> get props => [patient];
}

/// Recomputes the score from whatever has been entered so far.
class VitalsFieldChanged extends VitalsEvent {
  const VitalsFieldChanged(this.input);
  final EwsInput input;
  @override
  List<Object?> get props => [
        input.respiratoryRate,
        input.spo2,
        input.supplementalO2,
        input.temperatureC,
        input.systolicBp,
        input.heartRate,
        input.consciousness,
      ];
}

class VitalsSubmitted extends VitalsEvent {
  const VitalsSubmitted({required this.input, this.diastolicBp, this.painScore});
  final EwsInput input;
  final int? diastolicBp;
  final int? painScore;
  @override
  List<Object?> get props => [diastolicBp, painScore];
}

class VitalsFormReset extends VitalsEvent {
  const VitalsFormReset();
}

sealed class VitalsState extends Equatable {
  const VitalsState();
  @override
  List<Object?> get props => const [];
}

class VitalsSearching extends VitalsState {
  const VitalsSearching(this.results, {this.busy = false});
  final List<Patient> results;
  final bool busy;
  @override
  List<Object?> get props => [results, busy];
}

class VitalsEntry extends VitalsState {
  const VitalsEntry({
    required this.patient,
    required this.input,
    required this.result,
    required this.critical,
  });

  final Patient patient;
  final EwsInput input;
  final EwsResult result;

  /// Values that warrant escalation on their own, irrespective of the aggregate.
  final List<CriticalVital> critical;

  /// Nothing entered yet — the score is 2 from supplemental oxygen alone, so an
  /// empty form must not present as a real reading.
  bool get isEmpty => result.missing.length >= 6;

  @override
  List<Object?> get props => [
        patient,
        result.score,
        result.risk,
        result.missing.length,
        critical.length,
      ];
}

class VitalsSaved extends VitalsState {
  const VitalsSaved({
    required this.patient,
    required this.result,
    required this.queuedOffline,
  });

  final Patient patient;
  final EwsResult result;

  /// True when the reading is held on the device rather than confirmed by the server.
  final bool queuedOffline;

  @override
  List<Object?> get props => [patient, result.score, queuedOffline];
}

class VitalsError extends VitalsState {
  const VitalsError(this.message);
  final String message;
  @override
  List<Object?> get props => [message];
}

class VitalsBloc extends Bloc<VitalsEvent, VitalsState> {
  VitalsBloc({required this.api}) : super(const VitalsSearching([])) {
    on<VitalsPatientSearched>(_onSearch);
    on<VitalsPatientSelected>(_onSelect);
    on<VitalsFieldChanged>(_onFieldChanged);
    on<VitalsSubmitted>(_onSubmit);
    on<VitalsFormReset>((_, emit) => emit(const VitalsSearching([])));
  }

  final ApiClient api;
  Patient? _patient;

  Future<void> _onSearch(VitalsPatientSearched event, Emitter<VitalsState> emit) async {
    final query = event.query.trim();
    if (query.length < 2) {
      emit(const VitalsSearching([]));
      return;
    }

    emit(const VitalsSearching([], busy: true));
    try {
      final rows = await api.get<dynamic>('/patients', query: {'q': query, 'limit': '15'});
      emit(VitalsSearching(asRows(rows).map(Patient.fromJson).toList(growable: false)));
    } on ApiException catch (e) {
      emit(VitalsError(e.message));
    }
  }

  void _onSelect(VitalsPatientSelected event, Emitter<VitalsState> emit) {
    _patient = event.patient;
    const input = EwsInput();
    emit(VitalsEntry(
      patient: event.patient,
      input: input,
      result: calculateEws(input),
      critical: detectCriticalVitals(input),
    ));
  }

  void _onFieldChanged(VitalsFieldChanged event, Emitter<VitalsState> emit) {
    final patient = _patient;
    if (patient == null) return;
    emit(VitalsEntry(
      patient: patient,
      input: event.input,
      result: calculateEws(event.input),
      critical: detectCriticalVitals(event.input),
    ));
  }

  Future<void> _onSubmit(VitalsSubmitted event, Emitter<VitalsState> emit) async {
    final patient = _patient;
    if (patient == null) return;

    final result = calculateEws(event.input);
    final input = event.input;

    try {
      // The score is sent along with the readings. The server recomputes it and
      // its answer wins, but sending ours means an observation queued offline
      // still carries the band the nurse acted on.
      final response = await api.write(
        '/vitals',
        {
          'patient_id': patient.id,
          if (input.respiratoryRate != null) 'respiratory_rate': input.respiratoryRate,
          if (input.spo2 != null) 'spo2': input.spo2,
          'supplemental_o2': input.supplementalO2,
          if (input.temperatureC != null) 'temperature_c': input.temperatureC,
          if (input.systolicBp != null) 'systolic_bp': input.systolicBp,
          if (event.diastolicBp != null) 'diastolic_bp': event.diastolicBp,
          if (input.heartRate != null) 'heart_rate': input.heartRate,
          if (input.consciousness != null) 'consciousness': input.consciousness!.code,
          if (event.painScore != null) 'pain_score': event.painScore,
          'ews_score': result.score,
          'ews_risk': result.risk.name,
          'recorded_at': DateTime.now().toUtc().toIso8601String(),
        },
        entityType: 'vitals',
      );

      emit(VitalsSaved(
        patient: patient,
        result: result,
        queuedOffline: response == null,
      ));
    } on ApiException catch (e) {
      emit(VitalsError(e.message));
    }
  }
}
