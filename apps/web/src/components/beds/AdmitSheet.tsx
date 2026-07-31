'use client';

import { useState } from 'react';
import type { ApiError } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { useDebounced } from '@/lib/use-debounced';
import { usePatients, type BedRow, type PatientRow } from '@/lib/queries';
import { Field } from '@/components/ui';

const ADMISSION_TYPES = ['emergency', 'elective', 'transfer', 'newborn'] as const;

export interface AdmitBody {
  patient_id: string;
  admission_type: string;
  admitting_practitioner_id: string;
  edd?: string | null;
  diagnosis_code?: string;
  diagnosis_display?: string;
  admission_reason?: string;
}

/**
 * Admit into a specific bed: find the patient, then confirm.
 *
 * The bed is fixed before this opens — it is the thing that was clicked — so the
 * only question left is who is going into it, which keeps the search first.
 */
export function AdmitSheet({
  bed,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  bed: BedRow;
  pending: boolean;
  error: ApiError | null;
  onSubmit: (body: AdmitBody) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();

  const [query, setQuery] = useState('');
  const debounced = useDebounced(query);
  const [patient, setPatient] = useState<PatientRow | null>(null);

  const [admissionType, setAdmissionType] = useState<(typeof ADMISSION_TYPES)[number]>('elective');
  const [practitionerId, setPractitionerId] = useState('');
  const [edd, setEdd] = useState('');
  const [diagnosisCode, setDiagnosisCode] = useState('');
  const [diagnosisDisplay, setDiagnosisDisplay] = useState('');
  const [reason, setReason] = useState('');

  const results = usePatients(
    { q: debounced, limit: 8 },
    { enabled: debounced.trim().length >= 2 },
  );

  const ready = Boolean(patient && practitionerId.trim());

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={t('clinical.admit')}
    >
      <div className="max-h-[90dvh] w-full overflow-y-auto rounded-t-xl bg-white p-4 shadow-xl sm:max-w-lg sm:rounded-xl dark:bg-slate-900">
        <div className="mb-3 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">{t('clinical.admit')}</h2>
            <p className="text-sm">
              {bed.ward} · {bed.room} · {t('clinical.bed')} {bed.bed_number}
            </p>
            {bed.gender_restriction && (
              <p className="text-xs text-amber-700">{bed.gender_restriction}</p>
            )}
          </div>
          <button type="button" className="text-sm underline" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!patient) return;
            onSubmit({
              patient_id: patient.id,
              admission_type: admissionType,
              admitting_practitioner_id: practitionerId.trim(),
              edd: edd || null,
              diagnosis_code: diagnosisCode.trim() || undefined,
              diagnosis_display: diagnosisDisplay.trim() || undefined,
              admission_reason: reason.trim() || undefined,
            });
          }}
        >
          {patient ? (
            <div className="flex flex-wrap items-center gap-2 rounded border border-slate-300 px-2 py-1 dark:border-slate-600">
              <span className="text-sm font-medium">
                {patient.given_names.join(' ')} {patient.family_name}
              </span>
              <span className="font-mono text-xs text-slate-500">{patient.mrn}</span>
              <button
                type="button"
                className="ms-auto text-xs underline"
                onClick={() => {
                  setPatient(null);
                  setQuery('');
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          ) : (
            <>
              <Field label={t('clinical.patient')} required>
                <input
                  type="search"
                  className="input"
                  value={query}
                  autoComplete="off"
                  placeholder="Name or MRN"
                  onChange={(e) => setQuery(e.target.value)}
                />
              </Field>
              {debounced.trim().length >= 2 && (
                <ul className="max-h-48 overflow-y-auto rounded border border-slate-200 dark:border-slate-700">
                  {results.data?.data.map((row) => (
                    <li key={row.id} className="border-b border-slate-100 last:border-b-0 dark:border-slate-800">
                      <button
                        type="button"
                        className="w-full p-2 text-start text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                        onClick={() => setPatient(row)}
                      >
                        {row.given_names.join(' ')} {row.family_name}
                        <span className="ms-2 font-mono text-xs text-slate-500">{row.mrn}</span>
                      </button>
                    </li>
                  ))}
                  {results.data?.data.length === 0 && (
                    <li className="p-2 text-sm text-slate-500">{t('common.noData')}</li>
                  )}
                </ul>
              )}
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label={t('clinical.admissionType')} required>
              <select
                className="input"
                value={admissionType}
                onChange={(e) => setAdmissionType(e.target.value as (typeof ADMISSION_TYPES)[number])}
              >
                {ADMISSION_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('clinical.edd')}>
              <input
                type="date"
                className="input"
                value={edd}
                onChange={(e) => setEdd(e.target.value)}
              />
            </Field>
          </div>

          <Field label={t('clinical.prescribe')} required>
            <input
              className="input"
              value={practitionerId}
              placeholder="Admitting practitioner id"
              onChange={(e) => setPractitionerId(e.target.value)}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t('clinical.diagnosis')}>
              <input
                className="input font-mono"
                value={diagnosisCode}
                placeholder="J18.9"
                onChange={(e) => setDiagnosisCode(e.target.value)}
              />
            </Field>
            <Field label={t('common.notes')}>
              <input
                className="input"
                value={diagnosisDisplay}
                placeholder="Pneumonia"
                onChange={(e) => setDiagnosisDisplay(e.target.value)}
              />
            </Field>
          </div>

          <Field label={t('clinical.admissionType')}>
            <textarea
              className="input min-h-16"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>

          {error && (
            <p
              className="rounded border border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-900"
              role="alert"
            >
              {error.message}
            </p>
          )}

          <div className="flex gap-2">
            <button type="submit" className="btn-primary flex-1" disabled={!ready || pending}>
              {t('clinical.admit')}
            </button>
            <button type="button" className="btn-secondary" onClick={onClose}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
