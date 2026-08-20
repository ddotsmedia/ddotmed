import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:bloc/bloc.dart';
import 'package:equatable/equatable.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../core/api_client.dart';
import '../../core/flavour.dart';

class LinkedEvidence extends Equatable {
  const LinkedEvidence({
    required this.sentence,
    required this.audioOffsetMs,
    required this.confidence,
  });

  final String sentence;
  final int audioOffsetMs;
  final double confidence;

  static LinkedEvidence fromJson(Map<String, dynamic> json) => LinkedEvidence(
        sentence: json['sentence'] as String,
        audioOffsetMs: json['audio_offset_ms'] as int,
        confidence: (json['confidence'] as num).toDouble(),
      );

  @override
  List<Object?> get props => [sentence, audioOffsetMs, confidence];
}

class SoapDraft extends Equatable {
  const SoapDraft({
    this.subjective = '',
    this.objective = '',
    this.assessment = '',
    this.plan = '',
  });

  final String subjective;
  final String objective;
  final String assessment;
  final String plan;

  static SoapDraft fromJson(Map<String, dynamic> json) => SoapDraft(
        subjective: (json['subjective'] as String?) ?? '',
        objective: (json['objective'] as String?) ?? '',
        assessment: (json['assessment'] as String?) ?? '',
        plan: (json['plan'] as String?) ?? '',
      );

  Map<String, dynamic> toJson() => {
        'subjective': subjective,
        'objective': objective,
        'assessment': assessment,
        'plan': plan,
      };

  @override
  List<Object?> get props => [subjective, objective, assessment, plan];
}

sealed class ScribeEvent extends Equatable {
  const ScribeEvent();
  @override
  List<Object?> get props => const [];
}

class ScribeStartRequested extends ScribeEvent {
  const ScribeStartRequested(this.patientId, this.encounterId);
  final String patientId;
  final String encounterId;
  @override
  List<Object?> get props => [patientId, encounterId];
}

class ScribeAudioCaptured extends ScribeEvent {
  const ScribeAudioCaptured(this.chunk);
  final Uint8List chunk;
  @override
  List<Object?> get props => [chunk.length];
}

class ScribeStopRequested extends ScribeEvent {
  const ScribeStopRequested();
}

class ScribeDraftEdited extends ScribeEvent {
  const ScribeDraftEdited(this.draft);
  final SoapDraft draft;
  @override
  List<Object?> get props => [draft];
}

class ScribeApproved extends ScribeEvent {
  const ScribeApproved();
}

class ScribeDiscarded extends ScribeEvent {
  const ScribeDiscarded();
}

/// The four parts of the note, reviewed one at a time.
enum SoapSection { subjective, objective, assessment, plan }

extension SoapSectionLabel on SoapSection {
  String get label => switch (this) {
        SoapSection.subjective => 'Subjective',
        SoapSection.objective => 'Objective',
        SoapSection.assessment => 'Assessment',
        SoapSection.plan => 'Plan',
      };
}

/// Accepts one section as drafted.
class ScribeSectionApproved extends ScribeEvent {
  const ScribeSectionApproved(this.section);
  final SoapSection section;
  @override
  List<Object?> get props => [section];
}

/// Replaces one section's text and marks it approved — an edit *is* an approval,
/// because the clinician has just written the words themselves.
class ScribeSectionEdited extends ScribeEvent {
  const ScribeSectionEdited(this.section, this.text);
  final SoapSection section;
  final String text;
  @override
  List<Object?> get props => [section, text];
}

/// Drops one section. It is excluded from the note entirely rather than filed empty.
class ScribeSectionDiscarded extends ScribeEvent {
  const ScribeSectionDiscarded(this.section);
  final SoapSection section;
  @override
  List<Object?> get props => [section];
}

/// Highlights the audio position a drafted sentence came from.
class ScribeEvidenceSelected extends ScribeEvent {
  const ScribeEvidenceSelected(this.evidence);
  final LinkedEvidence? evidence;
  @override
  List<Object?> get props => [evidence];
}

sealed class ScribeState extends Equatable {
  const ScribeState();
  @override
  List<Object?> get props => const [];
}

class ScribeIdle extends ScribeState {
  const ScribeIdle();
}

class ScribeRecording extends ScribeState {
  const ScribeRecording({required this.sessionId, required this.durationMs, this.partial = ''});
  final String sessionId;
  final int durationMs;

  /// Live partial transcript pushed back over the socket.
  final String partial;
  @override
  List<Object?> get props => [sessionId, durationMs, partial];
}

class ScribeProcessing extends ScribeState {
  const ScribeProcessing();
}

class ScribeReview extends ScribeState {
  const ScribeReview({
    required this.sessionId,
    required this.draft,
    required this.evidence,
    required this.confidence,
    required this.lowConfidence,
    required this.modelVersion,
    this.approved = const {},
    this.discarded = const {},
    this.selectedEvidence,
  });

  final String sessionId;
  final SoapDraft draft;
  final List<LinkedEvidence> evidence;
  final double confidence;
  final bool lowConfidence;
  final String modelVersion;

  /// Sections the clinician has accepted. Nothing is approved by default —
  /// `requires_approval` is always true, and silence is not approval.
  final Set<SoapSection> approved;

  /// Sections explicitly rejected. Kept apart from "not yet reviewed" so the
  /// screen can tell an untouched section from a refused one.
  final Set<SoapSection> discarded;

  /// The evidence sentence currently highlighted, with its audio offset.
  final LinkedEvidence? selectedEvidence;

  String textFor(SoapSection section) => switch (section) {
        SoapSection.subjective => draft.subjective,
        SoapSection.objective => draft.objective,
        SoapSection.assessment => draft.assessment,
        SoapSection.plan => draft.plan,
      };

  bool isReviewed(SoapSection section) => approved.contains(section) || discarded.contains(section);

  /// Sections that carry text and have not been reviewed yet.
  List<SoapSection> get outstanding => SoapSection.values
      .where((s) => textFor(s).trim().isNotEmpty && !isReviewed(s))
      .toList(growable: false);

  /// Filing is allowed once nothing is outstanding and at least one section stands.
  bool get canFile => outstanding.isEmpty && approved.isNotEmpty;

  /// Only approved sections reach the record; discarded ones are sent empty.
  SoapDraft get approvedDraft => SoapDraft(
        subjective: approved.contains(SoapSection.subjective) ? draft.subjective : '',
        objective: approved.contains(SoapSection.objective) ? draft.objective : '',
        assessment: approved.contains(SoapSection.assessment) ? draft.assessment : '',
        plan: approved.contains(SoapSection.plan) ? draft.plan : '',
      );

  /// Evidence sentences that appear in a section the clinician kept.
  List<LinkedEvidence> get approvedEvidence {
    final kept = approvedDraft;
    final body = [kept.subjective, kept.objective, kept.assessment, kept.plan].join('\n');
    return evidence.where((e) => body.contains(e.sentence)).toList(growable: false);
  }

  ScribeReview copyWith({
    SoapDraft? draft,
    Set<SoapSection>? approved,
    Set<SoapSection>? discarded,
    LinkedEvidence? selectedEvidence,
    bool clearSelection = false,
  }) =>
      ScribeReview(
        sessionId: sessionId,
        draft: draft ?? this.draft,
        evidence: evidence,
        confidence: confidence,
        lowConfidence: lowConfidence,
        modelVersion: modelVersion,
        approved: approved ?? this.approved,
        discarded: discarded ?? this.discarded,
        selectedEvidence: clearSelection ? null : (selectedEvidence ?? this.selectedEvidence),
      );

  @override
  List<Object?> get props => [
        sessionId,
        draft,
        evidence,
        confidence,
        lowConfidence,
        approved,
        discarded,
        selectedEvidence,
      ];
}

class ScribeError extends ScribeState {
  const ScribeError(this.message);
  final String message;
  @override
  List<Object?> get props => [message];
}

/// Streams PCM audio to ai-service and manages the approve/edit/discard cycle.
/// Nothing produced here reaches the record without an explicit approval.
class ScribeBloc extends Bloc<ScribeEvent, ScribeState> {
  ScribeBloc({required this.api}) : super(const ScribeIdle()) {
    on<ScribeStartRequested>(_onStart);
    on<ScribeAudioCaptured>(_onAudio);
    on<ScribeStopRequested>(_onStop);
    on<ScribeDraftEdited>(_onEdited);
    on<ScribeApproved>(_onApproved);
    on<ScribeDiscarded>((_, emit) => emit(const ScribeIdle()));
    on<ScribeSectionApproved>(_onSectionApproved);
    on<ScribeSectionEdited>(_onSectionEdited);
    on<ScribeSectionDiscarded>(_onSectionDiscarded);
    on<ScribeEvidenceSelected>(_onEvidenceSelected);
  }

  final ApiClient api;
  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _socketSub;
  String? _sessionId;
  String? _patientId;
  String? _encounterId;

  Future<void> _onStart(ScribeStartRequested event, Emitter<ScribeState> emit) async {
    _patientId = event.patientId;
    _encounterId = event.encounterId;
    try {
      final response = await api.write('/ai/scribe/start', {
        'patient_id': event.patientId,
        'encounter_id': event.encounterId,
        'consent_obtained': true,
      });
      if (response == null) {
        emit(const ScribeError('The ambient scribe requires a live connection'));
        return;
      }

      _sessionId = response['session_id'] as String;
      final url = (response['websocket_url'] as String).replaceFirst(
        RegExp(r'^https?'),
        FlavourConfig.current.wsBaseUrl.startsWith('wss') ? 'wss' : 'ws',
      );

      _channel = WebSocketChannel.connect(Uri.parse(url));
      _socketSub = _channel!.stream.listen((message) {
        final payload = jsonDecode(message as String) as Map<String, dynamic>;
        final current = state;
        if (payload['type'] == 'ack' && current is ScribeRecording) {
          emit(ScribeRecording(
            sessionId: current.sessionId,
            durationMs: (payload['duration_ms'] as int?) ?? current.durationMs,
            partial: (payload['partial'] as String?) ?? current.partial,
          ));
        }
      }, onError: (Object error) => emit(ScribeError('$error')));

      emit(ScribeRecording(sessionId: _sessionId!, durationMs: 0));
    } on ApiException catch (e) {
      emit(ScribeError(e.message));
    }
  }

  void _onAudio(ScribeAudioCaptured event, Emitter<ScribeState> emit) {
    _channel?.sink.add(event.chunk);
  }

  Future<void> _onStop(ScribeStopRequested event, Emitter<ScribeState> emit) async {
    await _socketSub?.cancel();
    await _channel?.sink.close();
    _channel = null;
    emit(const ScribeProcessing());

    try {
      final response = await api.write('/ai/scribe/finalise', {'session_id': _sessionId});
      if (response == null) {
        emit(const ScribeError('Finalising requires a live connection'));
        return;
      }
      emit(ScribeReview(
        sessionId: _sessionId!,
        // `draft` is the gateway's shape; `soap` is what the AI service returns
        // when the app is pointed straight at it.
        draft: SoapDraft.fromJson(
          (response['draft'] ?? response['soap']) as Map<String, dynamic>,
        ),
        evidence: ((response['linked_evidence'] as List<dynamic>?) ?? const [])
            .cast<Map<String, dynamic>>()
            .map(LinkedEvidence.fromJson)
            .toList(growable: false),
        confidence: ((response['confidence_score'] as num?) ?? 0).toDouble(),
        lowConfidence: (response['low_confidence'] as bool?) ?? true,
        modelVersion: (response['model_version'] as String?) ?? 'unknown',
      ));
    } on ApiException catch (e) {
      emit(ScribeError(e.message));
    }
  }

  void _onEdited(ScribeDraftEdited event, Emitter<ScribeState> emit) {
    final current = state;
    if (current is ScribeReview) emit(current.copyWith(draft: event.draft));
  }

  void _onSectionApproved(ScribeSectionApproved event, Emitter<ScribeState> emit) {
    final current = state;
    if (current is! ScribeReview) return;
    emit(current.copyWith(
      approved: {...current.approved, event.section},
      discarded: {...current.discarded}..remove(event.section),
    ));
  }

  /// An edit counts as an approval: the clinician has just written the words.
  void _onSectionEdited(ScribeSectionEdited event, Emitter<ScribeState> emit) {
    final current = state;
    if (current is! ScribeReview) return;

    final draft = current.draft;
    final edited = switch (event.section) {
      SoapSection.subjective => SoapDraft(
          subjective: event.text,
          objective: draft.objective,
          assessment: draft.assessment,
          plan: draft.plan,
        ),
      SoapSection.objective => SoapDraft(
          subjective: draft.subjective,
          objective: event.text,
          assessment: draft.assessment,
          plan: draft.plan,
        ),
      SoapSection.assessment => SoapDraft(
          subjective: draft.subjective,
          objective: draft.objective,
          assessment: event.text,
          plan: draft.plan,
        ),
      SoapSection.plan => SoapDraft(
          subjective: draft.subjective,
          objective: draft.objective,
          assessment: draft.assessment,
          plan: event.text,
        ),
    };

    // An edit that empties a section is a discard, not an empty approval.
    final isEmpty = event.text.trim().isEmpty;
    emit(current.copyWith(
      draft: edited,
      approved: isEmpty
          ? ({...current.approved}..remove(event.section))
          : {...current.approved, event.section},
      discarded: isEmpty
          ? {...current.discarded, event.section}
          : ({...current.discarded}..remove(event.section)),
    ));
  }

  void _onSectionDiscarded(ScribeSectionDiscarded event, Emitter<ScribeState> emit) {
    final current = state;
    if (current is! ScribeReview) return;
    emit(current.copyWith(
      approved: {...current.approved}..remove(event.section),
      discarded: {...current.discarded, event.section},
    ));
  }

  void _onEvidenceSelected(ScribeEvidenceSelected event, Emitter<ScribeState> emit) {
    final current = state;
    if (current is! ScribeReview) return;
    emit(
      event.evidence == null
          ? current.copyWith(clearSelection: true)
          : current.copyWith(selectedEvidence: event.evidence),
    );
  }

  /// Files the note.
  ///
  /// Only approved sections are sent, and the note goes in as AI-drafted with the
  /// session id and model version attached — the server files an AI-drafted note
  /// as pending approval, so the audit trail records both that a model wrote it
  /// and which clinician accepted it.
  Future<void> _onApproved(ScribeApproved event, Emitter<ScribeState> emit) async {
    final current = state;
    if (current is! ScribeReview) return;
    if (!current.canFile) {
      emit(ScribeError(
        'Review every section before filing: '
        '${current.outstanding.map((s) => s.label).join(', ')} still outstanding',
      ));
      return;
    }

    try {
      await api.write('/notes', {
        'patient_id': _patientId,
        'encounter_id': _encounterId,
        'type': 'soap',
        ...current.approvedDraft.toJson(),
        'ai_drafted': true,
        'ai_session_id': current.sessionId,
        'ai_model_version': current.modelVersion,
        'ai_confidence': current.confidence,
        'linked_evidence': current.approvedEvidence
            .map((e) => {
                  'sentence': e.sentence,
                  'audio_offset_ms': e.audioOffsetMs,
                  'confidence': e.confidence,
                })
            .toList(),
      });
      emit(const ScribeIdle());
    } on ApiException catch (e) {
      emit(ScribeError(e.message));
    }
  }

  @override
  Future<void> close() async {
    await _socketSub?.cancel();
    await _channel?.sink.close();
    return super.close();
  }
}
