'use client';

import { useState } from 'react';
import { CriticalAlert } from '@medicore/ui-components';
import { useI18n } from '@/lib/i18n';
import { api, ApiError } from '@/lib/api';
import { keys, useApiMutation, useBedBoard, useEmar } from '@/lib/queries';
import { PageHeader, QueryState, Field } from '@/components/ui';

interface AdministerBody {
  medication_id: string;
  dose_given: number;
  dose_unit: string;
  route: string;
  scanned_patient_barcode: string;
  scanned_medication_barcode: string;
  witness_id?: string | null;
}

interface RightCheck {
  right: string;
  ok: boolean;
  detail: string;
}

export default function NursingPage() {
  const { t, date } = useI18n();
  const beds = useBedBoard();

  const [patientId, setPatientId] = useState('');
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [patientBarcode, setPatientBarcode] = useState('');
  const [medBarcode, setMedBarcode] = useState('');
  const [wrongPatient, setWrongPatient] = useState<RightCheck[] | null>(null);

  const emar = useEmar(patientId);

  const administer = useApiMutation<AdministerBody, { rights: RightCheck[] }>(
    '/pharmacy/administer',
    [keys.emar(patientId)],
  );

  const submit = (medication: Record<string, unknown>) => {
    setWrongPatient(null);
    administer.mutate(
      {
        medication_id: String(medication.id),
        dose_given: Number(medication.dose_quantity),
        dose_unit: String(medication.dose_unit),
        route: String(medication.route),
        scanned_patient_barcode: patientBarcode,
        scanned_medication_barcode: medBarcode,
      },
      {
        onError: (error) => {
          if (error instanceof ApiError) {
            const body = error.body as { code?: string; checks?: RightCheck[]; failures?: RightCheck[] };
            // A wrong-patient scan blocks the whole screen — nothing else may proceed.
            if (body.code === 'WRONG_PATIENT') setWrongPatient(body.checks ?? []);
          }
        },
        onSuccess: () => {
          setPatientBarcode('');
          setMedBarcode('');
          setSelected(null);
        },
      },
    );
  };

  return (
    <>
      {wrongPatient && (
        <CriticalAlert
          severity="life-threatening"
          title={t('errors.wrongPatient')}
          detail={wrongPatient.filter((c) => !c.ok).map((c) => c.detail).join(' · ')}
          fullScreen
          acknowledgeLabel={t('common.close')}
          onAcknowledge={() => {
            setWrongPatient(null);
            setPatientBarcode('');
            setMedBarcode('');
          }}
        />
      )}

      <PageHeader title={t('clinical.administer')} subtitle={t('clinical.ward')} />

      <div className="card mb-4">
        <Field label={t('clinical.patient')}>
          <input
            className="input"
            placeholder={t('clinical.mrn')}
            value={patientId}
            onChange={(e) => setPatientId(e.target.value.trim())}
          />
        </Field>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section>
          <h2 className="mb-2 font-semibold">{t('clinical.medications')}</h2>
          <QueryState
            isLoading={emar.isLoading}
            error={emar.error}
            isEmpty={!patientId || emar.data?.length === 0}
            emptyMessage={t('common.noData')}
          >
            <div className="space-y-2">
              {emar.data?.map((m) => {
                const med = m as Record<string, unknown>;
                const administrations = (med.administrations ?? []) as Array<{
                  administered_at?: string;
                  status?: string;
                }>;
                return (
                  <article key={String(med.id)} className="card">
                    <header className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium">{String(med.code_display)}</h3>
                      {Boolean(med.is_controlled) && (
                        <span className="rounded bg-red-100 px-1.5 text-xs font-bold text-red-800">
                          CD {String(med.controlled_schedule ?? '')}
                        </span>
                      )}
                    </header>
                    <p className="text-xs text-slate-600">
                      {String(med.dose_quantity)} {String(med.dose_unit)} · {String(med.route)} ·{' '}
                      {String(med.frequency)}
                    </p>
                    {administrations[0]?.administered_at && (
                      <p className="mt-1 text-xs text-slate-500">
                        {t('clinical.administer')}: {date(administrations[0].administered_at, true)}
                      </p>
                    )}
                    <button
                      type="button"
                      className="btn-primary mt-2 py-1 text-xs"
                      onClick={() => setSelected(med)}
                    >
                      {t('clinical.administer')}
                    </button>
                  </article>
                );
              })}
            </div>
          </QueryState>
        </section>

        <section>
          {selected && (
            <form
              className="card space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                submit(selected);
              }}
            >
              <h3 className="font-semibold">{String(selected.code_display)}</h3>
              <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {t('common.required')}: {t('clinical.patient')} + {t('clinical.medications')}
              </p>

              <Field label={`${t('clinical.patient')} — barcode`} required>
                <input
                  className="input font-mono"
                  value={patientBarcode}
                  onChange={(e) => setPatientBarcode(e.target.value)}
                  autoFocus
                  required
                />
              </Field>

              <Field label={`${t('clinical.medications')} — barcode`} required>
                <input
                  className="input font-mono"
                  value={medBarcode}
                  onChange={(e) => setMedBarcode(e.target.value)}
                  required
                />
              </Field>

              <div className="flex gap-2">
                <button type="submit" className="btn-primary" disabled={administer.isPending}>
                  {t('common.confirm')}
                </button>
                <button type="button" className="btn-secondary" onClick={() => setSelected(null)}>
                  {t('common.cancel')}
                </button>
              </div>

              {administer.error && !wrongPatient && (
                <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                  <p className="font-semibold">{administer.error.message}</p>
                  {administer.error instanceof ApiError &&
                    ((administer.error.body as { failures?: RightCheck[] }).failures ?? []).map((f) => (
                      <p key={f.right} className="mt-1 text-xs">
                        {f.right}: {f.detail}
                      </p>
                    ))}
                </div>
              )}

              {administer.data && (
                <ul className="space-y-1 text-xs text-emerald-800">
                  {administer.data.rights.map((r) => (
                    <li key={r.right}>✓ {r.detail}</li>
                  ))}
                </ul>
              )}
            </form>
          )}

          <div className="card mt-4">
            <h3 className="mb-2 font-semibold">{t('clinical.ward')}</h3>
            <QueryState isLoading={beds.isLoading} error={beds.error}>
              <ul className="space-y-1 text-sm">
                {beds.data?.wards.map((w) => (
                  <li key={w.ward} className="flex justify-between">
                    <span>{w.ward}</span>
                    <span className="tabular-nums">
                      {w.occupied}/{w.total}
                    </span>
                  </li>
                ))}
              </ul>
            </QueryState>
          </div>
        </section>
      </div>
    </>
  );
}
