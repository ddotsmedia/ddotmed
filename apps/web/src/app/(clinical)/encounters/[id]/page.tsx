'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { PatientBanner } from '@medicore/ui-components';
import type { Allergy } from '@medicore/shared-types';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { useChannel } from '@/lib/realtime';
import {
  keys,
  useApiMutation,
  useEncounter,
  useEncounterConditions,
  useNotes,
  type DiagnosisMatch,
} from '@/lib/queries';
import { PageHeader, QueryState, EwsBadge } from '@/components/ui';
import { AiScribe, type LinkedEvidence, type ScribeMeta, type SoapDraft } from '@/components/AiScribe';
import { SoapEditor, type NoteType } from '@/components/encounter/SoapEditor';
import { VitalsEntry, type VitalsPayload } from '@/components/encounter/VitalsEntry';
import { DiagnosisPicker } from '@/components/encounter/DiagnosisPicker';
import { ClinicalTimeline } from '@/components/encounter/ClinicalTimeline';
import { EncounterLabs } from '@/components/encounter/EncounterLabs';

interface NoteBody {
  patient_id: string;
  encounter_id: string;
  note_type: NoteType;
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
  ai_drafted?: boolean;
  ai_session_id?: string | null;
  ai_model_version?: string;
  ai_confidence?: number;
  linked_evidence?: LinkedEvidence[];
}

interface EncounterMedication {
  id: string;
  code_display: string;
  dose_quantity: string | number;
  dose_unit: string;
  route: string;
  frequency: string;
  is_controlled: boolean;
}

interface EncounterPatient {
  id: string;
  mrn: string;
  given_names: string[];
  family_name: string;
  gender: 'male' | 'female' | 'other' | 'unknown';
  birth_date: string;
  is_vip: boolean;
  allergies: Allergy[];
  medications: EncounterMedication[];
}

interface EncounterVital {
  id: string;
  recorded_at: string;
  ews_score: number | null;
  ews_risk: string | null;
}

interface EncounterDetail {
  id: string;
  patient_id: string;
  status: string;
  class: string;
  period_start: string;
  period_end: string | null;
  type_display: string | null;
  reason_text: string | null;
  patient: EncounterPatient;
  vitals: EncounterVital[];
}

const EMPTY_SOAP: SoapDraft = { subjective: '', objective: '', assessment: '', plan: '' };

const CLOSED_STATUSES = new Set(['closed', 'cancelled']);

const NOTE_STATUS_STYLE: Record<string, string> = {
  signed: 'text-emerald-700',
  pending_approval: 'text-amber-700',
  amended: 'text-slate-500',
  entered_in_error: 'text-red-700',
};

export default function ConsultationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, date } = useI18n();
  const { can } = usePermissions();

  const encounter = useEncounter(id);
  const notes = useNotes(id);
  const conditions = useEncounterConditions(id);

  const detail = encounter.data as unknown as EncounterDetail | undefined;
  const patientId = detail?.patient_id ?? '';
  const closed = detail ? CLOSED_STATUSES.has(detail.status) : false;

  // Vitals and critical results for this patient stay live while the chart is open.
  useChannel(patientId ? `patient:${patientId}` : '');

  const [soap, setSoap] = useState<SoapDraft>(EMPTY_SOAP);
  const [noteType, setNoteType] = useState<NoteType>('soap');
  const [aiMeta, setAiMeta] = useState<ScribeMeta | null>(null);
  const [evidence, setEvidence] = useState<LinkedEvidence[]>([]);

  const invalidateChart = [keys.encounter(id), keys.notes(id), keys.encounterConditions(id)];

  const saveNote = useApiMutation<NoteBody, { id: string }>('/clinical-notes', [keys.notes(id)]);
  const approveNote = useApiMutation<{ noteId: string }, unknown>(
    (body) => `/clinical-notes/${body.noteId}/approve`,
    [keys.notes(id)],
    'patch',
  );
  const saveVitals = useApiMutation<VitalsPayload, unknown>('/vitals', [keys.encounter(id)]);
  const addDiagnosis = useApiMutation<Record<string, unknown>, unknown>('/conditions', [
    keys.encounterConditions(id),
  ]);
  const closeEncounter = useApiMutation<Record<string, never>, unknown>(
    `/encounters/${id}/close`,
    invalidateChart,
    'patch',
  );

  const latestVital = detail?.vitals?.[0] ?? null;

  const bannerPatient = useMemo(
    () =>
      detail
        ? {
            id: detail.patient.id,
            mrn: detail.patient.mrn,
            name: {
              given: detail.patient.given_names,
              family: detail.patient.family_name,
            },
            gender: detail.patient.gender,
            birth_date: detail.patient.birth_date,
            blood_group: null,
            is_vip: detail.patient.is_vip,
          }
        : null,
    [detail],
  );

  const activeMeds = detail?.patient.medications ?? [];

  return (
    <QueryState isLoading={encounter.isLoading} error={encounter.error}>
      {bannerPatient && (
        <PatientBanner
          patient={bannerPatient as never}
          allergies={detail?.patient.allergies ?? []}
          encounterLabel={detail?.type_display ?? detail?.class}
          t={t as unknown as (key: string) => string}
          className="-mx-4 mb-3"
        />
      )}

      <PageHeader
        title={t('clinical.encounter')}
        subtitle={detail ? `${detail.status} · ${date(detail.period_start, true)}` : undefined}
        actions={
          <>
            {patientId && (
              <Link href={`/patients/${patientId}`} className="btn-secondary">
                {t('clinical.patient')}
              </Link>
            )}
            {latestVital && <EwsBadge score={latestVital.ews_score} risk={latestVital.ews_risk} />}
            {!closed && can('encounter:write') && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => closeEncounter.mutate({})}
                disabled={closeEncounter.isPending}
              >
                {t('clinical.closeEncounter')}
              </button>
            )}
            {closed && (
              <span className="rounded bg-slate-100 px-2 py-1 text-xs font-medium dark:bg-slate-800">
                {t('clinical.encounterClosed')}
              </span>
            )}
          </>
        }
      />

      {/* Active medications sit directly under the banner: they are the other half
          of the safety check a clinician makes before writing a plan. */}
      <section className="card mb-3" aria-label={t('clinical.activeMedications')}>
        <h3 className="mb-1 text-sm font-semibold">{t('clinical.activeMedications')}</h3>
        {activeMeds.length === 0 ? (
          <p className="text-sm text-slate-500">{t('clinical.noActiveMedications')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {activeMeds.map((med) => (
              <li
                key={med.id}
                className={clsx(
                  'rounded border px-2 py-1 text-xs',
                  med.is_controlled
                    ? 'border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200'
                    : 'border-slate-300 dark:border-slate-600',
                )}
              >
                <span className="font-medium">{med.code_display}</span>{' '}
                <span className="opacity-75">
                  {String(med.dose_quantity)} {med.dose_unit} {med.route} {med.frequency}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {closeEncounter.error && (
        <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {closeEncounter.error.message}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {can('ai:use') && patientId && !closed && (
            <AiScribe
              patientId={patientId}
              encounterId={id}
              onApproved={(accepted, linked, meta) => {
                // The draft lands in the editor, never straight into the record.
                setSoap({
                  subjective: accepted.subjective || soap.subjective,
                  objective: accepted.objective || soap.objective,
                  assessment: accepted.assessment || soap.assessment,
                  plan: accepted.plan || soap.plan,
                });
                setEvidence(linked);
                setAiMeta(meta);
              }}
            />
          )}

          <SoapEditor
            value={soap}
            onChange={setSoap}
            noteType={noteType}
            onNoteTypeChange={setNoteType}
            saving={saveNote.isPending}
            disabled={closed || !can('note:write')}
            aiDrafted={Boolean(aiMeta)}
            error={saveNote.error?.message ?? null}
            onSave={() =>
              saveNote.mutate(
                {
                  patient_id: patientId,
                  encounter_id: id,
                  note_type: noteType,
                  ...soap,
                  ai_drafted: Boolean(aiMeta),
                  ai_session_id: aiMeta?.session_id ?? null,
                  ai_model_version: aiMeta?.model_version,
                  ai_confidence: aiMeta?.confidence,
                  linked_evidence: aiMeta ? evidence : [],
                },
                {
                  onSuccess: () => {
                    setSoap(EMPTY_SOAP);
                    setAiMeta(null);
                    setEvidence([]);
                  },
                },
              )
            }
          />

          <QueryState
            isLoading={notes.isLoading}
            error={notes.error}
            isEmpty={notes.data?.length === 0}
          >
            <div className="space-y-2">
              {notes.data?.map((n) => {
                const note = n as Record<string, unknown>;
                const status = String(note.status);
                const approved = Boolean(note.approved_at);
                return (
                  <article key={String(note.id)} className="card">
                    <header className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded bg-slate-100 px-2 py-0.5 font-medium dark:bg-slate-800">
                        {String(note.type)}
                      </span>
                      <span className={NOTE_STATUS_STYLE[status] ?? 'text-slate-500'}>
                        {status === 'pending_approval' ? t('clinical.pendingApproval') : status}
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
                      {note.body ? <dd className="whitespace-pre-wrap">{String(note.body)}</dd> : null}
                    </dl>

                    <footer className="mt-3 flex flex-wrap items-center gap-2">
                      {!approved && can('note:sign') && (
                        <button
                          type="button"
                          className="btn-primary"
                          onClick={() => approveNote.mutate({ noteId: String(note.id) })}
                          disabled={approveNote.isPending}
                        >
                          {t('clinical.approveDraft')}
                        </button>
                      )}
                      {!approved && can('note:write') && !closed && (
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => {
                            setSoap({
                              subjective: String(note.subjective ?? ''),
                              objective: String(note.objective ?? ''),
                              assessment: String(note.assessment ?? ''),
                              plan: String(note.plan ?? ''),
                            });
                            setNoteType(String(note.type) as NoteType);
                          }}
                        >
                          {t('clinical.editDraft')}
                        </button>
                      )}
                      {approved && (
                        <span className="text-xs text-slate-500">
                          {t('clinical.approveDraft')} · {date(String(note.approved_at), true)}
                        </span>
                      )}
                    </footer>
                  </article>
                );
              })}
            </div>
          </QueryState>

          {approveNote.error && (
            <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
              {approveNote.error.message}
            </p>
          )}
        </div>

        <div className="space-y-4">
          {patientId && can('vitals:write') && (
            <VitalsEntry
              patientId={patientId}
              encounterId={id}
              saving={saveVitals.isPending}
              disabled={closed}
              error={saveVitals.error?.message ?? null}
              latest={latestVital}
              onSubmit={(payload) => saveVitals.mutate(payload)}
            />
          )}

          {patientId && can('condition:write') && (
            <DiagnosisPicker
              recorded={(conditions.data ?? []) as never}
              saving={addDiagnosis.isPending}
              disabled={closed}
              error={addDiagnosis.error?.message ?? null}
              onAdd={(match: DiagnosisMatch, isPrimary: boolean) =>
                addDiagnosis.mutate({
                  patient_id: patientId,
                  encounter_id: id,
                  code: match.code,
                  code_display: match.display,
                  category: 'encounter_diagnosis',
                  is_primary: isPrimary,
                })
              }
            />
          )}

          {patientId && <EncounterLabs patientId={patientId} encounterId={id} />}

          {patientId && <ClinicalTimeline patientId={patientId} encounterId={id} />}

          <div className="card">
            <h3 className="mb-2 font-semibold">{t('common.actions')}</h3>
            <div className="flex flex-wrap gap-2">
              {can('medication:prescribe') && (
                <Link href={`/encounters/${id}/prescribe`} className="btn-secondary">
                  {t('clinical.prescribe')}
                </Link>
              )}
              <Link href={`/encounters/${id}/vitals`} className="btn-secondary">
                {t('clinical.vitals')}
              </Link>
              <Link
                href={`/lab?patientId=${patientId}&encounterId=${id}`}
                className="btn-secondary"
              >
                {t('clinical.labOrders')}
              </Link>
              <Link href={`/radiology?encounter=${id}`} className="btn-secondary">
                {t('clinical.radiology')}
              </Link>
            </div>
          </div>
        </div>
      </div>
    </QueryState>
  );
}
