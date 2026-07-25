'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { keys, useApiMutation, usePharmacyQueue } from '@/lib/queries';
import { PageHeader, QueryState, Field } from '@/components/ui';

interface DispenseBody {
  medication_id: string;
  quantity: number;
  scanned_patient_barcode: string;
  scanned_medication_barcode: string;
  witness_id?: string | null;
  allow_substitution: boolean;
  substitution_reason?: string;
}

interface DispenseResult {
  picked: Array<{ batch_number: string; expiry_date: string; quantity: number }>;
  substituted: boolean;
}

export default function PharmacyPage() {
  const { t, date } = useI18n();
  const queue = usePharmacyQueue();

  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [form, setForm] = useState({
    quantity: '',
    patientBarcode: '',
    medBarcode: '',
    witnessId: '',
    allowSubstitution: false,
    substitutionReason: '',
  });

  const dispense = useApiMutation<DispenseBody, DispenseResult>('/pharmacy/dispense', [
    keys.pharmacyQueue(),
  ]);

  const errorBody =
    dispense.error instanceof ApiError
      ? (dispense.error.body as {
          code?: string;
          picked?: Array<{ batch_number: string }>;
          skipped?: Array<{ batch_number: string; reason: string }>;
        })
      : null;

  return (
    <>
      <PageHeader title={t('clinical.dispense')} />

      <div className="grid gap-4 lg:grid-cols-2">
        <QueryState isLoading={queue.isLoading} error={queue.error} isEmpty={queue.data?.length === 0}>
          <div className="card overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('clinical.patient')}</th>
                  <th>{t('clinical.medications')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {queue.data?.map((m) => {
                  const med = m as Record<string, unknown>;
                  const patient = med.patient as { mrn?: string; family_name?: string } | undefined;
                  return (
                    <tr key={String(med.id)} className={med.is_controlled ? 'bg-red-50' : undefined}>
                      <td>
                        {patient?.family_name}{' '}
                        <span className="font-mono text-xs">{patient?.mrn}</span>
                      </td>
                      <td>
                        {String(med.code_display)}
                        {Boolean(med.is_controlled) && (
                          <span className="ms-2 rounded bg-red-600 px-1 text-xs font-bold text-white">
                            CD
                          </span>
                        )}
                        <div className="text-xs text-slate-500">
                          {String(med.quantity)} · {date(String(med.created_at), true)}
                        </div>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn-secondary py-1 text-xs"
                          onClick={() => {
                            setSelected(med);
                            setForm((f) => ({ ...f, quantity: String(med.quantity) }));
                          }}
                        >
                          {t('clinical.dispense')}
                        </button>
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
              dispense.mutate({
                medication_id: String(selected.id),
                quantity: Number(form.quantity),
                scanned_patient_barcode: form.patientBarcode,
                scanned_medication_barcode: form.medBarcode,
                witness_id: form.witnessId || null,
                allow_substitution: form.allowSubstitution,
                substitution_reason: form.substitutionReason || undefined,
              });
            }}
          >
            <h3 className="font-semibold">{String(selected.code_display)}</h3>

            <Field label={t('common.actions')} required>
              <input
                className="input"
                type="number"
                min={1}
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                required
              />
            </Field>

            <Field label={`${t('clinical.patient')} — barcode`} required>
              <input
                className="input font-mono"
                value={form.patientBarcode}
                onChange={(e) => setForm({ ...form, patientBarcode: e.target.value })}
                required
              />
            </Field>

            <Field label={`${t('clinical.medications')} — barcode`} required>
              <input
                className="input font-mono"
                value={form.medBarcode}
                onChange={(e) => setForm({ ...form, medBarcode: e.target.value })}
                required
              />
            </Field>

            {Boolean(selected.is_controlled) && (
              <Field label={t('controlled:witness')} required>
                <input
                  className="input"
                  value={form.witnessId}
                  onChange={(e) => setForm({ ...form, witnessId: e.target.value })}
                  required
                />
              </Field>
            )}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.allowSubstitution}
                onChange={(e) => setForm({ ...form, allowSubstitution: e.target.checked })}
              />
              {t('common.edit')} — generic
            </label>

            {form.allowSubstitution && (
              <Field label={t('common.notes')} required>
                <input
                  className="input"
                  value={form.substitutionReason}
                  onChange={(e) => setForm({ ...form, substitutionReason: e.target.value })}
                  required
                />
              </Field>
            )}

            <div className="flex gap-2">
              <button type="submit" className="btn-primary" disabled={dispense.isPending}>
                {t('common.confirm')}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setSelected(null)}>
                {t('common.cancel')}
              </button>
            </div>

            {dispense.error && (
              <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                <p className="font-semibold">{dispense.error.message}</p>
                {errorBody?.skipped?.map((s) => (
                  <p key={s.batch_number} className="mt-1 text-xs">
                    {s.batch_number}: {s.reason}
                  </p>
                ))}
              </div>
            )}

            {dispense.data && (
              <div className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                <p className="font-semibold">{t('common.success')}</p>
                {dispense.data.picked.map((p) => (
                  <p key={p.batch_number} className="text-xs">
                    {p.batch_number} × {p.quantity} — {date(p.expiry_date)}
                  </p>
                ))}
                {dispense.data.substituted && <p className="mt-1 text-xs">generic</p>}
              </div>
            )}
          </form>
        )}
      </div>
    </>
  );
}
