/// Blocs for the doctor app.
///
/// Each screen owns one bloc, and each bloc owns exactly the fetches its screen
/// needs. Nothing here caches across screens: a chart opened twice re-reads the
/// record, because a stale allergy list is the kind of stale that harms someone.
library;

import 'package:bloc/bloc.dart';
import 'package:equatable/equatable.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';

// ── Today ─────────────────────────────────────────────────────────────────────

sealed class TodayEvent extends Equatable {
  const TodayEvent();
  @override
  List<Object?> get props => const [];
}

class TodayRequested extends TodayEvent {
  const TodayRequested();
}

sealed class TodayState extends Equatable {
  const TodayState();
  @override
  List<Object?> get props => const [];
}

class TodayLoading extends TodayState {
  const TodayLoading();
}

class TodayReady extends TodayState {
  const TodayReady({
    required this.appointments,
    required this.inpatients,
    required this.latestVitals,
    required this.loadedAt,
  });

  final List<Appointment> appointments;
  final List<Patient> inpatients;

  /// Most recent vital per patient id, so a card can carry an EWS badge without
  /// each row firing its own request.
  final Map<String, VitalReading> latestVitals;
  final DateTime loadedAt;

  List<Appointment> get upcoming {
    final rows = appointments.where((a) => a.isUpcoming(loadedAt)).toList()
      ..sort((a, b) => a.start.compareTo(b.start));
    return rows;
  }

  List<Appointment> get earlier {
    final upcomingIds = upcoming.map((a) => a.id).toSet();
    return appointments.where((a) => !upcomingIds.contains(a.id)).toList();
  }

  /// Sickest first. A ward list ordered by bed number buries the patient who
  /// needs seeing next behind whoever happens to be in bed 1.
  List<Patient> get inpatientsByAcuity {
    final rows = [...inpatients];
    rows.sort((a, b) {
      final aScore = latestVitals[a.id]?.ewsScore ?? -1;
      final bScore = latestVitals[b.id]?.ewsScore ?? -1;
      if (aScore != bScore) return bScore.compareTo(aScore);
      return (a.location ?? '').compareTo(b.location ?? '');
    });
    return rows;
  }

  @override
  List<Object?> get props => [appointments, inpatients, loadedAt];
}

class TodayError extends TodayState {
  const TodayError(this.message);
  final String message;
  @override
  List<Object?> get props => [message];
}

class TodayBloc extends Bloc<TodayEvent, TodayState> {
  TodayBloc({required this.api, DateTime Function()? clock})
      : _clock = clock ?? DateTime.now,
        super(const TodayLoading()) {
    on<TodayRequested>(_onRequested);
  }

  final ApiClient api;
  final DateTime Function() _clock;

  Future<void> _onRequested(TodayRequested event, Emitter<TodayState> emit) async {
    emit(const TodayLoading());
    final now = _clock();
    final dayStart = DateTime(now.year, now.month, now.day);

    try {
      // Issued together: the two lists describe one moment on the ward.
      final results = await Future.wait([
        api.get<dynamic>('/appointments', query: {
          'from': dayStart.toUtc().toIso8601String(),
          'to': dayStart.add(const Duration(days: 1)).toUtc().toIso8601String(),
        }),
        api.get<dynamic>('/admissions', query: {'status': 'admitted'}),
      ]);

      final appointments = asRows(results[0]).map(Appointment.fromJson).toList(growable: false);
      final admissions = asRows(results[1]);

      final inpatients = <Patient>[];
      for (final row in admissions) {
        final patient = row['patient'];
        if (patient is! Map<String, dynamic>) continue;
        final bed = row['bed'];
        inpatients.add(
          Patient.fromJson({
            ...patient,
            if (bed is Map<String, dynamic>) 'bed': bed,
            'admission_reason': row['admission_reason'],
          }),
        );
      }

      emit(TodayReady(
        appointments: appointments,
        inpatients: inpatients,
        latestVitals: await _latestVitals(inpatients),
        loadedAt: now,
      ));
    } on ApiException catch (e) {
      emit(TodayError(e.message));
    }
  }

  /// Best-effort: a ward list must still render when the vitals endpoint is slow
  /// or unavailable, just without the acuity badges.
  Future<Map<String, VitalReading>> _latestVitals(List<Patient> patients) async {
    if (patients.isEmpty) return const {};
    try {
      final rows = await api.get<dynamic>('/vitals/latest', query: {
        'patient_ids': patients.map((p) => p.id).join(','),
      });
      final out = <String, VitalReading>{};
      for (final row in asRows(rows)) {
        final patientId = row['patient_id'];
        if (patientId is String) out[patientId] = VitalReading.fromJson(row);
      }
      return out;
    } catch (_) {
      return const {};
    }
  }
}

// ── Patient chart ─────────────────────────────────────────────────────────────

sealed class ChartEvent extends Equatable {
  const ChartEvent();
  @override
  List<Object?> get props => const [];
}

class ChartRequested extends ChartEvent {
  const ChartRequested(this.patientId);
  final String patientId;
  @override
  List<Object?> get props => [patientId];
}

sealed class ChartState extends Equatable {
  const ChartState();
  @override
  List<Object?> get props => const [];
}

class ChartLoading extends ChartState {
  const ChartLoading();
}

class ChartReady extends ChartState {
  const ChartReady({
    required this.patient,
    required this.allergies,
    required this.medications,
    required this.labs,
    required this.vitals,
    required this.timeline,
    this.encounterId,
  });

  final Patient patient;
  final List<Allergy> allergies;
  final List<Prescription> medications;
  final List<LabResult> labs;
  final List<VitalReading> vitals;
  final List<TimelineEntry> timeline;

  /// The open encounter, if any — what a new order or a scribe session attaches to.
  final String? encounterId;

  List<LabResult> get abnormalLabs => labs.where((l) => l.isAbnormal).toList();

  VitalReading? get latestVital => vitals.isEmpty ? null : vitals.first;

  /// Oldest-first series for the sparkline; the chart reads left to right.
  List<double> seriesFor(double? Function(VitalReading) selector) =>
      vitals.reversed.map(selector).whereType<double>().toList(growable: false);

  @override
  List<Object?> get props => [patient, allergies, medications, labs, vitals, timeline];
}

class ChartError extends ChartState {
  const ChartError(this.message);
  final String message;
  @override
  List<Object?> get props => [message];
}

class ChartBloc extends Bloc<ChartEvent, ChartState> {
  ChartBloc({required this.api}) : super(const ChartLoading()) {
    on<ChartRequested>(_onRequested);
  }

  final ApiClient api;

  Future<void> _onRequested(ChartRequested event, Emitter<ChartState> emit) async {
    emit(const ChartLoading());
    final id = event.patientId;
    try {
      final results = await Future.wait([
        api.get<dynamic>('/patients/$id'),
        api.get<dynamic>('/allergies/patient/$id'),
        api.get<dynamic>('/medications/patient/$id', query: {'status': 'active'}),
        api.get<dynamic>('/lab/results/$id'),
        api.get<dynamic>('/vitals/patient/$id'),
        api.get<dynamic>('/patients/$id/timeline'),
      ]);

      final patientJson = results[0];
      if (patientJson is! Map<String, dynamic>) {
        emit(const ChartError('That patient record could not be read'));
        return;
      }

      final vitals = asRows(results[4]).map(VitalReading.fromJson).toList()
        ..sort((a, b) => b.recordedAt.compareTo(a.recordedAt));
      final labs = asRows(results[3]).map(LabResult.fromJson).toList()
        ..sort((a, b) => b.performedAt.compareTo(a.performedAt));

      emit(ChartReady(
        patient: Patient.fromJson(patientJson),
        allergies: asRows(results[1]).map(Allergy.fromJson).toList(growable: false),
        medications: asRows(results[2]).map(Prescription.fromJson).toList(growable: false),
        labs: labs,
        vitals: vitals,
        timeline: asRows(results[5]).map(TimelineEntry.fromJson).toList(growable: false),
        encounterId: _openEncounterId(patientJson),
      ));
    } on ApiException catch (e) {
      emit(ChartError(e.message));
    }
  }

  static String? _openEncounterId(Map<String, dynamic> patient) {
    final encounters = patient['encounters'];
    if (encounters is! List) return null;
    for (final row in encounters.whereType<Map<String, dynamic>>()) {
      if (row['status'] == 'in_progress' || row['status'] == 'arrived') {
        final id = row['id'];
        if (id is String) return id;
      }
    }
    return null;
  }
}

// ── Alerts ────────────────────────────────────────────────────────────────────

sealed class AlertsEvent extends Equatable {
  const AlertsEvent();
  @override
  List<Object?> get props => const [];
}

class AlertsRequested extends AlertsEvent {
  const AlertsRequested({this.onlyUnacknowledged = true});
  final bool onlyUnacknowledged;
  @override
  List<Object?> get props => [onlyUnacknowledged];
}

class AlertAcknowledged extends AlertsEvent {
  const AlertAcknowledged(this.alertId);
  final String alertId;
  @override
  List<Object?> get props => [alertId];
}

sealed class AlertsState extends Equatable {
  const AlertsState();
  @override
  List<Object?> get props => const [];
}

class AlertsLoading extends AlertsState {
  const AlertsLoading();
}

class AlertsReady extends AlertsState {
  const AlertsReady(this.alerts, {this.acknowledging = const {}});

  final List<ClinicalAlert> alerts;

  /// Ids with an acknowledgement in flight, so the button can disable itself
  /// without the whole list flickering back to a spinner.
  final Set<String> acknowledging;

  /// Critical first, then newest. The order is the triage.
  List<ClinicalAlert> get sorted {
    final rows = [...alerts];
    rows.sort((a, b) {
      if (a.isCritical != b.isCritical) return a.isCritical ? -1 : 1;
      return b.createdAt.compareTo(a.createdAt);
    });
    return rows;
  }

  int get criticalCount => alerts.where((a) => a.isCritical && !a.isAcknowledged).length;

  AlertsReady copyWith({List<ClinicalAlert>? alerts, Set<String>? acknowledging}) =>
      AlertsReady(alerts ?? this.alerts, acknowledging: acknowledging ?? this.acknowledging);

  @override
  List<Object?> get props => [alerts, acknowledging];
}

class AlertsError extends AlertsState {
  const AlertsError(this.message);
  final String message;
  @override
  List<Object?> get props => [message];
}

class AlertsBloc extends Bloc<AlertsEvent, AlertsState> {
  AlertsBloc({required this.api}) : super(const AlertsLoading()) {
    on<AlertsRequested>(_onRequested);
    on<AlertAcknowledged>(_onAcknowledged);
  }

  final ApiClient api;

  Future<void> _onRequested(AlertsRequested event, Emitter<AlertsState> emit) async {
    emit(const AlertsLoading());
    try {
      final rows = await api.get<dynamic>('/notifications', query: {
        if (event.onlyUnacknowledged) 'unacknowledged': 'true',
        'limit': '50',
      });
      emit(AlertsReady(asRows(rows).map(ClinicalAlert.fromJson).toList(growable: false)));
    } on ApiException catch (e) {
      emit(AlertsError(e.message));
    }
  }

  Future<void> _onAcknowledged(AlertAcknowledged event, Emitter<AlertsState> emit) async {
    final current = state;
    if (current is! AlertsReady) return;

    emit(current.copyWith(acknowledging: {...current.acknowledging, event.alertId}));
    try {
      await api.write('/notifications/${event.alertId}/acknowledge', const {}, method: 'PATCH');
      // Drop it from the list rather than re-fetching: the clinician is looking
      // at the row, and a full reload would move everything under their thumb.
      emit(AlertsReady(
        current.alerts.where((a) => a.id != event.alertId).toList(growable: false),
      ));
    } on ApiException catch (e) {
      emit(AlertsError(e.message));
    }
  }
}
