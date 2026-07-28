import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:bloc/bloc.dart';
import 'package:equatable/equatable.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/api_client.dart';
import '../core/flavour.dart';

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
  });

  final String sessionId;
  final SoapDraft draft;
  final List<LinkedEvidence> evidence;
  final double confidence;
  final bool lowConfidence;
  final String modelVersion;

  ScribeReview copyWith({SoapDraft? draft}) => ScribeReview(
        sessionId: sessionId,
        draft: draft ?? this.draft,
        evidence: evidence,
        confidence: confidence,
        lowConfidence: lowConfidence,
        modelVersion: modelVersion,
      );

  @override
  List<Object?> get props => [sessionId, draft, evidence, confidence, lowConfidence];
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

  Future<void> _onApproved(ScribeApproved event, Emitter<ScribeState> emit) async {
    final current = state;
    if (current is! ScribeReview) return;
    try {
      await api.write('/notes', {
        'patient_id': _patientId,
        'encounter_id': _encounterId,
        'type': 'soap',
        ...current.draft.toJson(),
        'ai_drafted': true,
        'ai_session_id': current.sessionId,
        'ai_model_version': current.modelVersion,
        'ai_confidence': current.confidence,
        'linked_evidence': current.evidence
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
