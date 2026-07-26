'use client';

import { useCallback, useRef, useState } from 'react';
import clsx from 'clsx';
import { ConfirmModal } from '@medicore/ui-components';
import { useI18n } from '@/lib/i18n';
import { api } from '@/lib/api-client';

interface LinkedEvidence {
  sentence: string;
  audio_offset_ms: number;
  confidence: number;
}

interface SoapDraft {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

interface FinaliseResponse {
  session_id: string;
  transcript: string;
  soap: SoapDraft;
  linked_evidence: LinkedEvidence[];
  suggested_codes: Array<{ system: string; code: string; display: string; confidence: number }>;
  confidence_score: number;
  low_confidence: boolean;
  model_version: string;
  requires_approval: true;
}

type Phase = 'idle' | 'recording' | 'processing' | 'review';

const SECTIONS: Array<keyof SoapDraft> = ['subjective', 'objective', 'assessment', 'plan'];
const SECTION_KEY: Record<keyof SoapDraft, string> = {
  subjective: 'clinical.soapSubjective',
  objective: 'clinical.soapObjective',
  assessment: 'clinical.soapAssessment',
  plan: 'clinical.soapPlan',
};

export function AiScribe({
  patientId,
  encounterId,
  onApproved,
}: {
  patientId: string;
  encounterId: string;
  onApproved: (draft: SoapDraft, evidence: LinkedEvidence[], meta: { model_version: string; confidence: number }) => void;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<SoapDraft | null>(null);
  const [result, setResult] = useState<FinaliseResponse | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<LinkedEvidence | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [durationMs, setDurationMs] = useState(0);

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

  const start = useCallback(async () => {
    setError(null);
    try {
      const session = await api.post<{ session_id: string; websocket_url: string; sample_rate: number }>(
        '/ai/scribe/start',
        { patient_id: patientId, encounter_id: encounterId, consent_obtained: true },
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
        const payload = JSON.parse(String(event.data)) as { type: string; duration_ms?: number; detail?: string };
        if (payload.type === 'ack' && payload.duration_ms !== undefined) setDurationMs(payload.duration_ms);
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
      setDraft(response.soap);
      setPhase('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errors.generic'));
      setPhase('idle');
    }
  }, [stopCapture, t]);

  const evidenceFor = (sentence: string): LinkedEvidence | undefined =>
    result?.linked_evidence.find((e) => sentence.includes(e.sentence));

  return (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{t('clinical.aiDraft')}</h3>
        {phase === 'recording' && (
          <span className="inline-flex items-center gap-1 rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
            <span className="size-2 animate-pulse rounded-full bg-red-600" aria-hidden />
            {Math.floor(durationMs / 1000)}s
          </span>
        )}
        <div className="ms-auto flex gap-2">
          {phase === 'idle' && (
            <button type="button" className="btn-primary" onClick={() => void start()}>
              {t('common.submit')}
            </button>
          )}
          {phase === 'recording' && (
            <button type="button" className="btn-danger" onClick={() => void finalise()}>
              {t('common.close')}
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

      {phase === 'review' && draft && result && (
        <>
          <div className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <p className="font-semibold">{t('clinical.requiresApproval')}</p>
            {result.low_confidence && <p className="mt-1">{t('clinical.lowConfidence')}</p>}
            <p className="mt-1 text-xs opacity-80">
              {result.model_version} — {(result.confidence_score * 100).toFixed(0)}%
            </p>
          </div>

          <div className="space-y-3">
            {SECTIONS.map((section) => (
              <div key={section}>
                <label className="label">{t(SECTION_KEY[section])}</label>
                <textarea
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
              onClick={() => {
                onApproved(draft, result.linked_evidence, {
                  model_version: result.model_version,
                  confidence: result.confidence_score,
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
        onConfirm={() => {
          setConfirmDiscard(false);
          setDraft(null);
          setResult(null);
          setPhase('idle');
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  );
}
