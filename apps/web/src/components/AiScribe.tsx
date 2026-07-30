'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  /** The gateway names it `draft`; the AI service itself names it `soap`. */
  draft?: SoapDraft;
  soap?: SoapDraft;
  linked_evidence: LinkedEvidence[];
  suggested_codes: Array<{ system: string; code: string; display: string; confidence: number }>;
  confidence_score: number;
  low_confidence: boolean;
  model_version: string;
  requires_approval: true;
}

type Phase = 'idle' | 'recording' | 'processing' | 'review';

const EMPTY_DRAFT: SoapDraft = { subjective: '', objective: '', assessment: '', plan: '' };

const SECTIONS: Array<keyof SoapDraft> = ['subjective', 'objective', 'assessment', 'plan'];
const SECTION_KEY: Record<keyof SoapDraft, string> = {
  subjective: 'clinical.soapSubjective',
  objective: 'clinical.soapObjective',
  assessment: 'clinical.soapAssessment',
  plan: 'clinical.soapPlan',
};

/** Matches the server's own sentence split, so evidence lines up with what it linked. */
const splitSentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export function AiScribe({
  patientId,
  encounterId,
  onApproved,
}: {
  patientId: string;
  encounterId: string;
  onApproved: (draft: SoapDraft, evidence: LinkedEvidence[], meta: ScribeMeta) => void;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<SoapDraft | null>(null);
  const [result, setResult] = useState<FinaliseResponse | null>(null);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [selected, setSelected] = useState<LinkedEvidence | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [durationMs, setDurationMs] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const stopCapture = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    void audioContextRef.current?.close().catch(() => undefined);
    socketRef.current?.close();
    streamRef.current = null;
    audioContextRef.current = null;
    socketRef.current = null;
  }, []);

  // A clinician who navigates away mid-consultation must not leave the microphone
  // live; the browser gives no second chance to clean this up.
  useEffect(() => stopCapture, [stopCapture]);

  const start = useCallback(async () => {
    setError(null);
    setLiveTranscript('');
    setDurationMs(0);
    try {
      const session = await api.post<{
        session_id: string;
        websocket_url: string;
        sample_rate: number;
      }>('/ai/scribe/start', {
        patient_id: patientId,
        encounter_id: encounterId,
        consent_obtained: true,
      });
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
        if (payload.type === 'transcript' && payload.text) setLiveTranscript(payload.text);
        if (payload.type === 'error') setError(payload.detail ?? t('errors.generic'));
      };

      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error(t('errors.network')));
      });

      const context = new AudioContext({ sampleRate: session.sample_rate });
      audioContextRef.current = context;
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);

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
      setDraft(response.draft ?? response.soap ?? EMPTY_DRAFT);
      setPhase('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errors.generic'));
      setPhase('idle');
    }
  }, [stopCapture, t]);

  const reset = useCallback(() => {
    setPhase('idle');
    setDraft(null);
    setResult(null);
    setSelected(null);
    setLiveTranscript('');
    setDurationMs(0);
  }, []);

  /** Evidence keyed by the sentence it explains, so lookup during render is free. */
  const evidenceBySentence = useMemo(() => {
    const map = new Map<string, LinkedEvidence>();
    for (const e of result?.linked_evidence ?? []) map.set(e.sentence, e);
    return map;
  }, [result]);

  const transcript = phase === 'review' ? (result?.transcript ?? '') : liveTranscript;

  return (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{t('clinical.aiDraft')}</h3>
        {phase === 'recording' && (
          <span className="inline-flex items-center gap-1 rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
            <span className="size-2 animate-pulse rounded-full bg-red-600" aria-hidden />
            {t('clinical.listening')} · {Math.floor(durationMs / 1000)}s
          </span>
        )}
        <div className="ms-auto flex gap-2">
          {phase === 'idle' && (
            <button type="button" className="btn-primary" onClick={() => void start()}>
              {t('clinical.startScribe')}
            </button>
          )}
          {phase === 'recording' && (
            <button type="button" className="btn-danger" onClick={() => void finalise()}>
              {t('clinical.stopScribe')}
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      )}

      {phase === 'processing' && <p className="text-sm text-slate-500">{t('common.loading')}</p>}

      {(phase === 'recording' || phase === 'review') && (
        <section className="mb-3">
          <h4 className="label">{t('clinical.liveTranscript')}</h4>
          <div
            className="max-h-40 overflow-y-auto rounded border border-slate-200 bg-slate-50 p-2 text-sm leading-relaxed dark:border-slate-700 dark:bg-slate-900"
            aria-live="polite"
          >
            {transcript ? (
              // Highlights the segment behind whichever drafted sentence is selected.
              <HighlightedTranscript text={transcript} highlight={selected?.sentence ?? null} />
            ) : (
              <span className="text-slate-400">{t('clinical.listening')}…</span>
            )}
          </div>
        </section>
      )}

      {phase === 'review' && draft && result && (
        <>
          <div className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <p className="font-semibold">{t('clinical.requiresApproval')}</p>
            {result.low_confidence && <p className="mt-1">{t('clinical.lowConfidence')}</p>}
            <p className="mt-1 text-xs opacity-80">
              {result.model_version} · {(result.confidence_score * 100).toFixed(0)}%
            </p>
          </div>

          <div className="space-y-3">
            {SECTIONS.map((section) => {
              const chips = splitSentences(draft[section])
                .map((sentence) => evidenceBySentence.get(sentence))
                .filter((e): e is LinkedEvidence => Boolean(e));

              return (
                <div key={section}>
                  <label className="label" htmlFor={`scribe-${section}`}>
                    {t(SECTION_KEY[section])}
                  </label>
                  <textarea
                    id={`scribe-${section}`}
                    className="input min-h-24 font-sans"
                    value={draft[section]}
                    onChange={(e) => setDraft({ ...draft, [section]: e.target.value })}
                  />
                  {chips.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {chips.map((evidence) => (
                        <button
                          key={evidence.sentence}
                          type="button"
                          onClick={() =>
                            setSelected(selected?.sentence === evidence.sentence ? null : evidence)
                          }
                          aria-pressed={selected?.sentence === evidence.sentence}
                          title={evidence.sentence}
                          className={clsx(
                            'rounded px-1.5 py-0.5 text-xs',
                            selected?.sentence === evidence.sentence && 'ring-2 ring-sky-500',
                            evidence.confidence >= 0.7
                              ? 'bg-emerald-100 text-emerald-900'
                              : 'bg-amber-100 text-amber-900',
                          )}
                        >
                          ▶ {seconds(evidence.audio_offset_ms)} ·{' '}
                          {(evidence.confidence * 100).toFixed(0)}%
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {result.suggested_codes.length > 0 && (
            <div className="mt-3">
              <p className="label">{t('clinical.diagnosis')}</p>
              <ul className="flex flex-wrap gap-2">
                {result.suggested_codes.map((c) => (
                  <li
                    key={`${c.system}-${c.code}`}
                    className="rounded border border-slate-300 px-2 py-1 text-xs"
                  >
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
              onClick={() => {
                onApproved(draft, result.linked_evidence, {
                  model_version: result.model_version,
                  confidence: result.confidence_score,
                  session_id: result.session_id,
                });
                reset();
              }}
            >
              {t('clinical.approveDraft')}
            </button>
            <button type="button" className="btn-danger" onClick={() => setConfirmDiscard(true)}>
              {t('clinical.discardDraft')}
            </button>
          </div>
        </>
      )}

      <ConfirmModal
        open={confirmDiscard}
        title={t('clinical.discardDraft')}
        message={t('common.confirm')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          setConfirmDiscard(false);
          reset();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  );
}

/**
 * Renders the transcript with the evidence sentence marked. The model paraphrases,
 * so an exact hit is not guaranteed — when there is none the transcript is shown
 * plain rather than highlighting something that only nearly matches.
 */
function HighlightedTranscript({ text, highlight }: { text: string; highlight: string | null }) {
  if (!highlight) return <>{text}</>;
  const at = text.toLowerCase().indexOf(highlight.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded bg-sky-200 px-0.5 text-sky-950">
        {text.slice(at, at + highlight.length)}
      </mark>
      {text.slice(at + highlight.length)}
    </>
  );
}
