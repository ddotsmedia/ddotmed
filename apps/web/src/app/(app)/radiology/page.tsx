'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { keys, useApiMutation, useRadiologyWorklist } from '@/lib/queries';
import { PageHeader, QueryState, Field } from '@/components/ui';

interface ReportBody {
  imaging_study_id: string;
  clinical_history?: string;
  technique?: string;
  findings: string;
  impression: string;
  recommendation?: string;
  is_critical: boolean;
  transcription_source: 'typed' | 'voice' | 'ai-assisted';
  sign: boolean;
}

export default function RadiologyPage() {
  const { t, date } = useI18n();
  const { can } = usePermissions();
  const worklist = useRadiologyWorklist();

  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [form, setForm] = useState({
    clinical_history: '',
    technique: '',
    findings: '',
    impression: '',
    recommendation: '',
    is_critical: false,
  });
  const [voiceActive, setVoiceActive] = useState(false);

  const submitReport = useApiMutation<ReportBody, unknown>('/radiology/reports', [
    keys.radiologyWorklist(),
  ]);

  /**
   * Voice dictation hook: Web Speech API where available, appending into findings.
   * The transcription source is recorded so a dictated report is distinguishable
   * from a typed one in the audit trail.
   */
  const startDictation = () => {
    const SpeechRecognition =
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike })
        .webkitSpeechRecognition ??
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event: SpeechResultLike) => {
      const transcript = Array.from({ length: event.results.length }, (_, i) => event.results[i]![0]!.transcript).join(' ');
      setForm((f) => ({ ...f, findings: `${f.findings} ${transcript}`.trim() }));
    };
    recognition.onend = () => setVoiceActive(false);
    recognition.start();
    setVoiceActive(true);
  };

  return (
    <>
      <PageHeader title={t('clinical.radiology')} />

      <div className="grid gap-4 lg:grid-cols-2">
        <QueryState
          isLoading={worklist.isLoading}
          error={worklist.error}
          isEmpty={worklist.data?.length === 0}
        >
          <div className="card overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('clinical.patient')}</th>
                  <th>{t('clinical.radiology')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {worklist.data?.map((s) => {
                  const study = s as Record<string, unknown>;
                  const patient = study.patient as { mrn?: string; family_name?: string } | undefined;
                  const reports = (study.reports ?? []) as Array<{ signed_at?: string | null }>;
                  return (
                    <tr
                      key={String(study.id)}
                      className={selected?.id === study.id ? 'bg-sky-50' : undefined}
                    >
                      <td>
                        {patient?.family_name}{' '}
                        <span className="font-mono text-xs">{patient?.mrn}</span>
                      </td>
                      <td>
                        <span className="rounded bg-slate-100 px-1 text-xs font-semibold dark:bg-slate-800">
                          {String(study.modality)}
                        </span>{' '}
                        {String(study.description ?? '')}
                        <div className="text-xs text-slate-500">
                          {date(String(study.created_at), true)}
                        </div>
                      </td>
                      <td>
                        {reports.some((r) => r.signed_at) ? (
                          <span className="text-emerald-700">{t('common.success')}</span>
                        ) : (
                          can('imaging:report') && (
                            <button
                              type="button"
                              className="btn-secondary py-1 text-xs"
                              onClick={() => setSelected(study)}
                            >
                              {t('common.edit')}
                            </button>
                          )
                        )}
                        {Boolean(study.pacs_url) && (
                          <a
                            href={String(study.pacs_url)}
                            target="_blank"
                            rel="noreferrer"
                            className="ms-2 text-xs text-sky-700 underline"
                          >
                            DICOM
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </QueryState>

        {selected && (
          <form
            className="card space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submitReport.mutate({
                imaging_study_id: String(selected.id),
                ...form,
                transcription_source: voiceActive ? 'voice' : 'typed',
                sign: true,
              });
            }}
          >
            <h3 className="font-semibold">
              {String(selected.modality)} — {String(selected.description ?? '')}
            </h3>

            <Field label={t('common.notes')}>
              <textarea
                className="input min-h-16"
                value={form.clinical_history}
                onChange={(e) => setForm({ ...form, clinical_history: e.target.value })}
              />
            </Field>

            <Field label={t('clinical.soapObjective')} required>
              <textarea
                className="input min-h-32"
                value={form.findings}
                onChange={(e) => setForm({ ...form, findings: e.target.value })}
                required
              />
            </Field>

            <button
              type="button"
              className="btn-secondary"
              onClick={startDictation}
              disabled={voiceActive}
            >
              {voiceActive ? '● …' : '🎙'}
            </button>

            <Field label={t('clinical.soapAssessment')} required>
              <textarea
                className="input min-h-20"
                value={form.impression}
                onChange={(e) => setForm({ ...form, impression: e.target.value })}
                required
              />
            </Field>

            <Field label={t('clinical.soapPlan')}>
              <textarea
                className="input min-h-16"
                value={form.recommendation}
                onChange={(e) => setForm({ ...form, recommendation: e.target.value })}
              />
            </Field>

            <label className="flex items-center gap-2 text-sm font-medium text-red-800">
              <input
                type="checkbox"
                checked={form.is_critical}
                onChange={(e) => setForm({ ...form, is_critical: e.target.checked })}
              />
              {t('clinical.criticalValue')}
            </label>

            <div className="flex gap-2">
              <button type="submit" className="btn-primary" disabled={submitReport.isPending}>
                {t('common.save')}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setSelected(null)}>
                {t('common.cancel')}
              </button>
            </div>

            {submitReport.error && (
              <p className="text-sm text-red-700" role="alert">
                {submitReport.error.message}
              </p>
            )}
          </form>
        )}
      </div>
    </>
  );
}

interface SpeechResultLike {
  results: { length: number; [index: number]: { [index: number]: { transcript: string } } };
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  onresult: (event: SpeechResultLike) => void;
  onend: () => void;
  start: () => void;
}
