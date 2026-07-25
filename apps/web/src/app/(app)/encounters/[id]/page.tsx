'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { keys, useApiMutation, useEncounter, useNotes } from '@/lib/queries';
import { PageHeader, QueryState, Field } from '@/components/ui';
import { AiScribe } from '@/components/AiScribe';

interface NoteBody {
  patient_id: string;
  encounter_id: string;
  type: string;
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
  ai_drafted?: boolean;
  ai_model_version?: string;
  ai_confidence?: number;
  linked_evidence?: unknown[];
}

export default function ConsultationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, date } = useI18n();
  const { can } = usePermissions();

  const encounter = useEncounter(id);
  const notes = useNotes(id);

  const patientId = String((encounter.data as Record<string, unknown> | undefined)?.patient_id ?? '');

  const [soap, setSoap] = useState({ subjective: '', objective: '', assessment: '', plan: '' });

  const saveNote = useApiMutation<NoteBody, { id: string }>('/notes', [keys.notes(id)]);
  const signNote = useApiMutation<{ noteId: string }, unknown>(
    (body) => `/notes/${body.noteId}/sign`,
    [keys.notes(id)],
  );

  return (
    <QueryState isLoading={encounter.isLoading} error={encounter.error}>
      <PageHeader
        title={t('clinical.encounter')}
        subtitle={patientId ? undefined : undefined}
        actions={
          patientId && (
            <Link href={`/patients/${patientId}`} className="btn-secondary">
              {t('clinical.patient')}
            </Link>
          )
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          {can('ai:use') && patientId && (
            <AiScribe
              patientId={patientId}
              encounterId={id}
              onApproved={(draft, evidence, meta) => {
                setSoap(draft);
                saveNote.mutate({
                  patient_id: patientId,
                  encounter_id: id,
                  type: 'soap',
                  ...draft,
                  ai_drafted: true,
                  ai_model_version: meta.model_version,
                  ai_confidence: meta.confidence,
                  linked_evidence: evidence,
                });
              }}
            />
          )}

          <form
            className="card space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              saveNote.mutate({ patient_id: patientId, encounter_id: id, type: 'soap', ...soap });
            }}
          >
            <h3 className="font-semibold">{t('clinical.clinicalNotes')}</h3>

            <Field label={t('clinical.soapSubjective')}>
              <textarea
                className="input min-h-20"
                value={soap.subjective}
                onChange={(e) => setSoap({ ...soap, subjective: e.target.value })}
              />
            </Field>
            <Field label={t('clinical.soapObjective')}>
              <textarea
                className="input min-h-20"
                value={soap.objective}
                onChange={(e) => setSoap({ ...soap, objective: e.target.value })}
              />
            </Field>
            <Field label={t('clinical.soapAssessment')}>
              <textarea
                className="input min-h-20"
                value={soap.assessment}
                onChange={(e) => setSoap({ ...soap, assessment: e.target.value })}
              />
            </Field>
            <Field label={t('clinical.soapPlan')}>
              <textarea
                className="input min-h-20"
                value={soap.plan}
                onChange={(e) => setSoap({ ...soap, plan: e.target.value })}
              />
            </Field>

            <button type="submit" className="btn-primary" disabled={saveNote.isPending || !can('note:write')}>
              {t('common.save')}
            </button>
            {saveNote.error && (
              <p className="text-sm text-red-700" role="alert">
                {saveNote.error.message}
              </p>
            )}
          </form>
        </div>

        <div className="space-y-4">
          <div className="card">
            <h3 className="mb-2 font-semibold">{t('common.actions')}</h3>
            <div className="flex flex-wrap gap-2">
              <Link href={`/encounters/${id}/vitals`} className="btn-secondary">
                {t('clinical.vitals')}
              </Link>
              <Link href={`/lab?encounter=${id}`} className="btn-secondary">
                {t('clinical.labResults')}
              </Link>
              <Link href={`/radiology?encounter=${id}`} className="btn-secondary">
                {t('clinical.radiology')}
              </Link>
            </div>
          </div>

          <QueryState isLoading={notes.isLoading} error={notes.error} isEmpty={notes.data?.length === 0}>
            <div className="space-y-2">
              {notes.data?.map((n) => {
                const note = n as Record<string, unknown>;
                const signed = note.status === 'signed';
                return (
                  <article key={String(note.id)} className="card">
                    <header className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded bg-slate-100 px-2 py-0.5 font-medium dark:bg-slate-800">
                        {String(note.type)}
                      </span>
                      <span
                        className={
                          signed ? 'text-emerald-700' : note.ai_drafted ? 'text-amber-700' : 'text-slate-500'
                        }
                      >
                        {String(note.status)}
                      </span>
                      {Boolean(note.ai_drafted) && (
                        <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-900">
                          {t('clinical.aiDraft')}
                        </span>
                      )}
                      <span className="ms-auto text-slate-500">v{String(note.version)}</span>
                      <span className="text-slate-500">{date(String(note.created_at), true)}</span>
                    </header>

                    <dl className="space-y-1 text-sm">
                      {(['subjective', 'objective', 'assessment', 'plan'] as const).map((section) =>
                        note[section] ? (
                          <div key={section}>
                            <dt className="text-xs font-semibold text-slate-500">
                              {t(`clinical.soap${section[0]!.toUpperCase()}${section.slice(1)}`)}
                            </dt>
                            <dd className="whitespace-pre-wrap">{String(note[section])}</dd>
                          </div>
                        ) : null,
                      )}
                    </dl>

                    {!signed && can('note:sign') && (
                      <button
                        type="button"
                        className="btn-primary mt-3"
                        onClick={() => signNote.mutate({ noteId: String(note.id) })}
                        disabled={signNote.isPending}
                      >
                        {t('clinical.approveDraft')}
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          </QueryState>
        </div>
      </div>
    </QueryState>
  );
}
