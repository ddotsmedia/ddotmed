'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ConfirmModal } from '@medicore/ui-components';
import { useI18n } from '@/lib/i18n';
import { api } from '@/lib/api-client';

export interface LinkedEvidence {
  sentence: string;
  audio_offset_ms: number;
  confidence: number;
}

export interface SoapDraft {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

export interface ScribeMeta {
  model_version: string;
  confidence: number;
  session_id: string;
}

interface FinaliseResponse {
  session_id: string;
  transcript: string;
  draft: SoapDraft;
  linked_evidence: LinkedEvidence[];
  suggested_codes: Array<{ system: string; code: string; display: string; confidence: number }>;
  confidence_score: number;
  low_confidence: boolean;
  model_version: string;
  requires_approval: true;
  audio_duration_ms: number;
}

type Phase = 'idle' | 'recording' | 'processing' | 'review';

const SECTIONS: Array<keyof SoapDraft> = ['subjective', 'objective', 'assessment', 'plan'];
const SECTION_KEY: Record<keyof SoapDraft, string> = {
  subjective: 'clinical.soapSubjective',
  objective: 'clinical.soapObjective',
  assessment: 'clinical.soapAssessment',
  plan: 'clinical.soapPlan',
};

const SAMPLE_BUFFER = 4096;

const seconds = (ms: number): string => `${Math.floor(ms / 1000)}s`;

/**
 * One-tap ambient scribe.
 *
 * The clinician presses record once, talks to the patient, presses stop, and is
 * shown a draft they must accept section by section. Nothing here writes to the
 * chart: approval is a separate, explicit act on the note itself.
 */
export function AiScribe({
  patientId,
  encounterId,
  onApproved,
  disabled,
}: {
  patientId: string;
  encounterId: string;
  onApproved: (draft: SoapDraft, evidence: LinkedEvidence[], meta: ScribeMeta) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<SoapDraft | null>(null);
  const [accepted, setAccepted] = useState<Record<keyof SoapDraft, boolean>>({
    subjective: true,
    objective: true,
    assessment: true,
    plan: true,
  });
  const [result, setResult] = useState<FinaliseResponse | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<LinkedEvidence | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  const [transcript, setTranscript] = useState('');

  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const stopCapture = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    void audioContextRef.current?.close();
    socketRef.current?.close();
    streamRef.current = null;
    audioContextRef.current = null;
    socketRef.current = null;
  }, []);

  // A navigation away mid-consultation must release the microphone, not leave it
  // recording behind a closed screen.
  useEffect(() => stopCapture, [stopCapture]);

  const start = useCallback(async () => {
    setError(null);
    setTranscript('');
    setDurationMs(0);
    try {
      const session = await api.post<{ session_id: string; websocket_url: string; sample_rate: number }>(
        '/ai/scribe/start',
        {
          patient_id: patientId,
          encounter_id: encounterId,
          language: 'en',
          consent_obtained: true,
        },
      );
      sessionIdRef.current = session.session_id;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: session.sample_rate, echoCancellation: true },
      });
      streamRef.current = stream;

      const socket = new WebSocket(session.websocket_url);
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;

      socket.onmessage = (event) => {
        const payload = JSON.parse(String(event.data)) as {
          type: string;
          duration_ms?: number;
          text?: string;
          detail?: string;
        };
        if (payload.type === 'ack' && payload.duration_ms !== undefined) {
          setDurationMs(payload.duration_ms);
        }
        // Interim transcript, when the service is configured to stream one.
        if (payload.type === 'transcript' && payload.text) {
          setTranscript((prior) => `${prior}${prior ? ' ' : ''}${payload.text}`.trim());
        }
        if (payload.type === 'error') setError(payload.detail ?? t('errors.generic'));
      };

      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error(t('errors.network')));
      });

      const context = new AudioContext({ sampleRate: session.sample_rate });
      audioContextRef.current = context;
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(SAMPLE_BUFFER, 1, 1);

      processor.onaudioprocess = (event) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        // Convert float32 [-1,1] to PCM s16le, which is what the service expects.
        const pcm = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const clamped = Math.max(-1, Math.min(1, input[i]!));
          pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        }
        socket.send(pcm.buffer);
      };

      source.connect(processor);
      processor.connect(context.destination);
      setPhase('recording');
    } catch (e) {
      stopCapture();
      setError(e instanceof Error ? e.message : t('errors.generic'));
    }
  }, [patientId, encounterId, t, stopCapture]);

  const finalise = useCallback(async () => {
    stopCapture();
    setPhase('processing');
    try {
      const response = await api.post<FinaliseResponse>('/ai/scribe/finalise', {
        session_id: sessionIdRef.current,
      });
      setResult(response);
      setDraft(response.draft);
      setTranscript(response.transcript);
      setAccepted({
        subjective: Boolean(response.draft.subjective.trim()),
        objective: Boolean(response.draft.objective.trim()),
        assessment: Boolean(response.draft.assessment.trim()),
        plan: Boolean(response.draft.plan.trim()),
      });
      setPhase('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errors.generic'));
      setPhase('idle');
    }
  }, [stopCapture, t]);

  const discard = () => {
    setConfirmDiscard(false);
    setDraft(null);
    setResult(null);
    setTranscript('');
    setPhase('idle');
  };

  const evidenceFor = (sentence: string): LinkedEvidence | undefined =>
    result?.linked_evidence.find((e) => sentence.includes(e.sentence));

  const nothingAccepted = !Object.values(accepted).some(Boolean);

  return (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{t('clinical.aiDraft')}</h3>
        {phase === 'recording' && (
          <span className="inline-flex items-center gap-1 rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
            <span className="size-2 animate-pulse rounded-full bg-red-600" aria-hidden />
            {t('clinical.listening')} · {seconds(durationMs)}
          </span>
        )}
        <div className="ms-auto flex gap-2">
          {phase === 'idle' && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => void start()}
              disabled={disabled}
            >
              🎙 {t('clinical.startScribe')}
            </button>
          )}
          {phase === 'recording' && (
            <button type="button" className="btn-danger" onClick={() => void finalise()}>
              ⏹ {t('clinical.stopScribe')}
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      )}

      {(phase === 'recording' || (phase !== 'idle' && transcript)) && (
        <section className="mb-3" aria-label={t('clinical.liveTranscript')}>
          <p className="label">{t('clinical.liveTranscript')}</p>
          <div
            className="max-h-32 overflow-y-auto rounded border border-slate-200 bg-slate-50 p-2 text-sm leading-relaxed dark:border-slate-700 dark:bg-slate-900"
            aria-live="polite"
          >
            {transcript || <span className="text-slate-400">{t('clinical.listening')}…</span>}
          </div>
        </section>
      )}

      {phase === 'processing' && <p className="text-sm text-slate-500">{t('common.loading')}</p>}

      {phase === 'review' && draft && result && (
        <>
          <div className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <p className="font-semibold">{t('clinical.requiresApproval')}</p>
            {result.low_confidence && <p className="mt-1">{t('clinical.lowConfidence')}</p>}
            <p className="mt-1 text-xs opacity-80">
              {result.model_version} — {(result.confidence_score * 100).toFixed(0)}% ·{' '}
              {seconds(result.audio_duration_ms)}
            </p>
          </div>

          <div className="space-y-3">
            {SECTIONS.map((section) => (
              <div
                key={section}
                className={clsx(
                  'rounded border p-2',
                  accepted[section]
                    ? 'border-slate-200 dark:border-slate-700'
                    : 'border-slate-200 opacity-50 dark:border-slate-700',
                )}
              >
                <div className="mb-1 flex items-center gap-2">
                  <label className="label mb-0 flex-1" htmlFor={`scribe-${section}`}>
                    {t(SECTION_KEY[section])}
                  </label>
                  <label className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={accepted[section]}
                      onChange={(e) => setAccepted({ ...accepted, [section]: e.target.checked })}
                    />
                    {t('common.confirm')}
                  </label>
                </div>
                <textarea
                  id={`scribe-${section}`}
                  className="input min-h-24 font-sans"
                  value={draft[section]}
                  onChange={(e) => setDraft({ ...draft, [section]: e.target.value })}
                />
                <div className="mt-1 flex flex-wrap gap-1">
                  {draft[section]
                    .split(/(?<=[.!?])\s+/)
                    .filter(Boolean)
                    .map((sentence) => {
                      const evidence = evidenceFor(sentence);
                      if (!evidence) return null;
                      return (
                        <button
                          key={sentence}
                          type="button"
                          onClick={() => setSelectedEvidence(evidence)}
                          title={`${t('clinical.aiDraft')} @ ${(evidence.audio_offset_ms / 1000).toFixed(1)}s`}
                          className={clsx(
                            'rounded px-1.5 py-0.5 text-xs',
                            evidence.confidence >= 0.7
                              ? 'bg-emerald-100 text-emerald-900'
                              : 'bg-amber-100 text-amber-900',
                          )}
                        >
                          ▶ {(evidence.audio_offset_ms / 1000).toFixed(1)}s ·{' '}
                          {(evidence.confidence * 100).toFixed(0)}%
                        </button>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>

          {result.suggested_codes.length > 0 && (
            <div className="mt-3">
              <p className="label">{t('clinical.diagnosis')}</p>
              <ul className="flex flex-wrap gap-2">
                {result.suggested_codes.map((c) => (
                  <li key={`${c.system}-${c.code}`} className="rounded border border-slate-300 px-2 py-1 text-xs">
                    <span className="font-mono font-semibold">{c.code}</span> {c.display}{' '}
                    <span className="opacity-60">{(c.confidence * 100).toFixed(0)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={nothingAccepted}
              onClick={() => {
                // Only the sections the clinician kept are carried into the note.
                const kept: SoapDraft = {
                  subjective: accepted.subjective ? draft.subjective : '',
                  objective: accepted.objective ? draft.objective : '',
                  assessment: accepted.assessment ? draft.assessment : '',
                  plan: accepted.plan ? draft.plan : '',
                };
                onApproved(kept, result.linked_evidence, {
                  model_version: result.model_version,
                  confidence: result.confidence_score,
                  session_id: result.session_id,
                });
                setPhase('idle');
                setDraft(null);
                setResult(null);
              }}
            >
              {t('clinical.approveDraft')}
            </button>
            <button type="button" className="btn-danger" onClick={() => setConfirmDiscard(true)}>
              {t('clinical.discardDraft')}
            </button>
          </div>

          {selectedEvidence && (
            <div className="mt-3 rounded border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900">
              <p className="font-semibold">{t('clinical.aiDraft')}</p>
              <p className="mt-1 italic">&ldquo;{selectedEvidence.sentence}&rdquo;</p>
              <p className="mt-1 text-xs">
                {(selectedEvidence.audio_offset_ms / 1000).toFixed(1)}s ·{' '}
                {(selectedEvidence.confidence * 100).toFixed(0)}%
              </p>
              <button
                type="button"
                className="mt-2 text-xs underline"
                onClick={() => setSelectedEvidence(null)}
              >
                {t('common.close')}
              </button>
            </div>
          )}
        </>
      )}

      <ConfirmModal
        open={confirmDiscard}
        title={t('clinical.discardDraft')}
        message={t('common.confirm')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={discard}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  );
}
