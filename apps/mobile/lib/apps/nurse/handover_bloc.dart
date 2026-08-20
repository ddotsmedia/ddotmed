/// Shift handover, structured as SBAR.
///
/// The AI draft is a starting point and is treated as one throughout: it arrives
/// unsigned, every field stays editable, and the sign action is a separate,
/// explicit step that records who signed it. A handover note is what the incoming
/// nurse relies on for the next twelve hours, so an unreviewed model output must
/// never be able to reach it by default.
library;

import 'package:bloc/bloc.dart';
import 'package:equatable/equatable.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';

class SbarNote extends Equatable {
  const SbarNote({
    this.situation = '',
    this.background = '',
    this.assessment = '',
    this.recommendation = '',
  });

  final String situation;
  final String background;
  final String assessment;
  final String recommendation;

  bool get isEmpty =>
      situation.trim().isEmpty &&
      background.trim().isEmpty &&
      assessment.trim().isEmpty &&
      recommendation.trim().isEmpty;

  /// Every section has to say something before this can be signed. A handover
  /// with an empty Recommendation is the one that gets misread at 3am.
  bool get isComplete =>
      situation.trim().isNotEmpty &&
      background.trim().isNotEmpty &&
      assessment.trim().isNotEmpty &&
      recommendation.trim().isNotEmpty;

  SbarNote copyWith({
    String? situation,
    String? background,
    String? assessment,
    String? recommendation,
  }) =>
      SbarNote(
        situation: situation ?? this.situation,
        background: background ?? this.background,
        assessment: assessment ?? this.assessment,
        recommendation: recommendation ?? this.recommendation,
      );

  static SbarNote fromJson(Map<String, dynamic> json) => SbarNote(
        situation: (json['situation'] as String?) ?? '',
        background: (json['background'] as String?) ?? '',
        assessment: (json['assessment'] as String?) ?? '',
        recommendation: (json['recommendation'] as String?) ?? '',
      );

  Map<String, dynamic> toJson() => {
        'situation': situation,
        'background': background,
        'assessment': assessment,
        'recommendation': recommendation,
      };

  /// The flat body filed against the note record, for readers that do not
  /// understand the SBAR fields.
  String get body => [
        'S: $situation',
        'B: $background',
        'A: $assessment',
        'R: $recommendation',
      ].join('\n\n');

  @override
  List<Object?> get props => [situation, background, assessment, recommendation];
}

sealed class HandoverEvent extends Equatable {
  const HandoverEvent();
  @override
  List<Object?> get props => const [];
}

class HandoverRequested extends HandoverEvent {
  const HandoverRequested(this.ward);
  final String ward;
  @override
  List<Object?> get props => [ward];
}

class HandoverPatientSelected extends HandoverEvent {
  const HandoverPatientSelected(this.patientId);
  final String patientId;
  @override
  List<Object?> get props => [patientId];
}

class HandoverDraftRequested extends HandoverEvent {
  const HandoverDraftRequested(this.patientId);
  final String patientId;
  @override
  List<Object?> get props => [patientId];
}

class HandoverEdited extends HandoverEvent {
  const HandoverEdited(this.patientId, this.note);
  final String patientId;
  final SbarNote note;
  @override
  List<Object?> get props => [patientId, note];
}

class HandoverSigned extends HandoverEvent {
  const HandoverSigned(this.patientId);
  final String patientId;
  @override
  List<Object?> get props => [patientId];
}

sealed class HandoverState extends Equatable {
  const HandoverState();
  @override
  List<Object?> get props => const [];
}

class HandoverLoading extends HandoverState {
  const HandoverLoading();
}

class HandoverReady extends HandoverState {
  const HandoverReady({
    required this.patients,
    required this.notes,
    required this.aiDrafted,
    required this.signed,
    this.selectedPatientId,
    this.drafting,
    this.message,
  });

  final List<Patient> patients;
  final Map<String, SbarNote> notes;

  /// Which notes came from the model. Shown on the card so the signing nurse
  /// knows what they are putting their name to.
  final Set<String> aiDrafted;
  final Set<String> signed;
  final String? selectedPatientId;

  /// Patient id whose draft is being generated, if any.
  final String? drafting;
  final String? message;

  SbarNote noteFor(String patientId) => notes[patientId] ?? const SbarNote();

  int get outstanding => patients.where((p) => !signed.contains(p.id)).length;

  HandoverReady copyWith({
    Map<String, SbarNote>? notes,
    Set<String>? aiDrafted,
    Set<String>? signed,
    String? selectedPatientId,
    String? drafting,
    bool clearDrafting = false,
    String? message,
  }) =>
      HandoverReady(
        patients: patients,
        notes: notes ?? this.notes,
        aiDrafted: aiDrafted ?? this.aiDrafted,
        signed: signed ?? this.signed,
        selectedPatientId: selectedPatientId ?? this.selectedPatientId,
        drafting: clearDrafting ? null : (drafting ?? this.drafting),
        message: message,
      );

  @override
  List<Object?> get props =>
      [patients, notes, aiDrafted, signed, selectedPatientId, drafting, message];
}

class HandoverError extends HandoverState {
  const HandoverError(this.message);
  final String message;
  @override
  List<Object?> get props => [message];
}

class HandoverBloc extends Bloc<HandoverEvent, HandoverState> {
  HandoverBloc({required this.api}) : super(const HandoverLoading()) {
    on<HandoverRequested>(_onRequested);
    on<HandoverPatientSelected>(_onSelected);
    on<HandoverDraftRequested>(_onDraft);
    on<HandoverEdited>(_onEdited);
    on<HandoverSigned>(_onSigned);
  }

  final ApiClient api;

  Future<void> _onRequested(HandoverRequested event, Emitter<HandoverState> emit) async {
    emit(const HandoverLoading());
    try {
      final rows = await api.get<dynamic>(
        '/admissions',
        query: {'status': 'admitted', 'ward': event.ward},
      );

      final patients = <Patient>[];
      for (final row in asRows(rows)) {
        final patient = row['patient'];
        if (patient is! Map<String, dynamic>) continue;
        final bed = row['bed'];
        patients.add(Patient.fromJson({
          ...patient,
          if (bed is Map<String, dynamic>) 'bed': bed,
          'admission_reason': row['admission_reason'],
        }));
      }

      emit(HandoverReady(
        patients: patients,
        notes: const {},
        aiDrafted: const {},
        signed: const {},
      ));
    } on ApiException catch (e) {
      emit(HandoverError(e.message));
    }
  }

  void _onSelected(HandoverPatientSelected event, Emitter<HandoverState> emit) {
    final current = state;
    if (current is! HandoverReady) return;
    emit(current.copyWith(
      selectedPatientId: current.selectedPatientId == event.patientId ? '' : event.patientId,
    ));
  }

  /// Asks the server for an SBAR draft built from the patient's recent record.
  ///
  /// A failure is reported and the field left as it was; a nurse who cannot get a
  /// draft writes the handover themselves, which is what they did before.
  Future<void> _onDraft(HandoverDraftRequested event, Emitter<HandoverState> emit) async {
    final current = state;
    if (current is! HandoverReady) return;

    emit(current.copyWith(drafting: event.patientId, message: null));
    try {
      final response = await api.write('/ai/handover', {
        'patient_id': event.patientId,
        'format': 'sbar',
      });

      if (response == null) {
        emit(current.copyWith(
          clearDrafting: true,
          message: 'Drafting needs a connection. Write the handover manually.',
        ));
        return;
      }

      final draft = response['draft'] ?? response['sbar'] ?? response;
      final note = draft is Map<String, dynamic> ? SbarNote.fromJson(draft) : const SbarNote();

      emit(current.copyWith(
        notes: {...current.notes, event.patientId: note},
        aiDrafted: {...current.aiDrafted, event.patientId},
        // A fresh draft is unsigned, even if this patient was signed off earlier.
        signed: {...current.signed}..remove(event.patientId),
        clearDrafting: true,
      ));
    } on ApiException catch (e) {
      emit(current.copyWith(clearDrafting: true, message: e.message));
    }
  }

  void _onEdited(HandoverEdited event, Emitter<HandoverState> emit) {
    final current = state;
    if (current is! HandoverReady) return;
    emit(current.copyWith(
      notes: {...current.notes, event.patientId: event.note},
      // Editing revokes the signature: what was signed is no longer what is there.
      signed: {...current.signed}..remove(event.patientId),
    ));
  }

  Future<void> _onSigned(HandoverSigned event, Emitter<HandoverState> emit) async {
    final current = state;
    if (current is! HandoverReady) return;

    final note = current.noteFor(event.patientId);
    if (!note.isComplete) {
      emit(current.copyWith(
        message: 'Complete every SBAR section before signing',
      ));
      return;
    }

    try {
      await api.write('/notes', {
        'patient_id': event.patientId,
        'type': 'sbar',
        'body': note.body,
        ...note.toJson(),
        'ai_drafted': current.aiDrafted.contains(event.patientId),
      });
      emit(current.copyWith(
        signed: {...current.signed, event.patientId},
        message: null,
      ));
    } on ApiException catch (e) {
      emit(current.copyWith(message: e.message));
    }
  }
}
