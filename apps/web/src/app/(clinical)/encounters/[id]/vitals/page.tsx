'use client';

import { use, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { keys, useApiMutation, useEncounter, useVitals } from '@/lib/queries';
import { PageHeader, QueryState, Field, EwsBadge } from '@/components/ui';

interface VitalsBody {
  patient_id: string;
  encounter_id: string;
  systolic_bp?: number | null;
  diastolic_bp?: number | null;
  heart_rate?: number | null;
  respiratory_rate?: number | null;
  temperature_c?: number | null;
  spo2?: number | null;
  supplemental_o2: boolean;
  consciousness?: string | null;
  pain_score?: number | null;
  weight_kg?: number | null;
  height_cm?: number | null;
}

interface VitalsResult {
  id: string;
  ews: { score: number; risk: string; response: string; missing: string[]; hasRedScore: boolean };
  critical_values: Array<{ parameter: string; value: number; threshold: string }>;
}

const numeric = (v: string): number | null => (v === '' ? null : Number(v));

export default function VitalsEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, date } = useI18n();

  const encounter = useEncounter(id);
  const patientId = String((encounter.data as Record<string, unknown> | undefined)?.patient_id ?? '');
  const history = useVitals(patientId);

  const [form, setForm] = useState({
    systolic_bp: '',
    diastolic_bp: '',
    heart_rate: '',
    respiratory_rate: '',
    temperature_c: '',
    spo2: '',
    supplemental_o2: false,
    consciousness: 'A',
    pain_score: '',
    weight_kg: '',
    height_cm: '',
  });

  const record = useApiMutation<VitalsBody, VitalsResult>('/vitals', [
    keys.vitals(patientId),
    keys.vitalsTrend(patientId),
  ]);

  const bmi = useMemo(() => {
    const w = Number(form.weight_kg);
    const h = Number(form.height_cm);
    if (!w || !h) return null;
    return (w / (h / 100) ** 2).toFixed(1);
  }, [form.weight_kg, form.height_cm]);

  const result = record.data;

  return (
    <QueryState isLoading={encounter.isLoading} error={encounter.error}>
      <PageHeader title={t('clinical.vitals')} subtitle={t('clinical.ews')} />

      <div className="grid gap-4 lg:grid-cols-2">
        <form
          className="card grid grid-cols-2 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            record.mutate({
              patient_id: patientId,
              encounter_id: id,
              systolic_bp: numeric(form.systolic_bp),
              diastolic_bp: numeric(form.diastolic_bp),
              heart_rate: numeric(form.heart_rate),
              respiratory_rate: numeric(form.respiratory_rate),
              temperature_c: numeric(form.temperature_c),
              spo2: numeric(form.spo2),
              supplemental_o2: form.supplemental_o2,
              consciousness: form.consciousness,
              pain_score: numeric(form.pain_score),
              weight_kg: numeric(form.weight_kg),
              height_cm: numeric(form.height_cm),
            });
          }}
        >
          <Field label={`${t('clinical.bloodPressure')} (sys)`}>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              min={0}
              max={300}
              value={form.systolic_bp}
              onChange={(e) => setForm({ ...form, systolic_bp: e.target.value })}
            />
          </Field>
          <Field label={`${t('clinical.bloodPressure')} (dia)`}>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              min={0}
              max={200}
              value={form.diastolic_bp}
              onChange={(e) => setForm({ ...form, diastolic_bp: e.target.value })}
            />
          </Field>
          <Field label={t('clinical.heartRate')}>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              value={form.heart_rate}
              onChange={(e) => setForm({ ...form, heart_rate: e.target.value })}
            />
          </Field>
          <Field label={t('clinical.respiratoryRate')}>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              value={form.respiratory_rate}
              onChange={(e) => setForm({ ...form, respiratory_rate: e.target.value })}
            />
          </Field>
          <Field label={t('clinical.temperature')}>
            <input
              className="input"
              type="number"
              step="0.1"
              inputMode="decimal"
              value={form.temperature_c}
              onChange={(e) => setForm({ ...form, temperature_c: e.target.value })}
            />
          </Field>
          <Field label={t('clinical.spo2')}>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              value={form.spo2}
              onChange={(e) => setForm({ ...form, spo2: e.target.value })}
            />
          </Field>

          <label className="col-span-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.supplemental_o2}
              onChange={(e) => setForm({ ...form, supplemental_o2: e.target.checked })}
            />
            O₂
          </label>

          <Field label="ACVPU">
            <select
              className="input"
              value={form.consciousness}
              onChange={(e) => setForm({ ...form, consciousness: e.target.value })}
            >
              {['A', 'C', 'V', 'P', 'U'].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('clinical.painScore')}>
            <input
              className="input"
              type="number"
              min={0}
              max={10}
              value={form.pain_score}
              onChange={(e) => setForm({ ...form, pain_score: e.target.value })}
            />
          </Field>

          <Field label="kg">
            <input
              className="input"
              type="number"
              step="0.1"
              value={form.weight_kg}
              onChange={(e) => setForm({ ...form, weight_kg: e.target.value })}
            />
          </Field>
          <Field label="cm">
            <input
              className="input"
              type="number"
              step="0.1"
              value={form.height_cm}
              onChange={(e) => setForm({ ...form, height_cm: e.target.value })}
            />
          </Field>

          {bmi && <p className="col-span-2 text-sm text-slate-600">BMI {bmi}</p>}

          <button type="submit" className="btn-primary col-span-2" disabled={record.isPending}>
            {t('common.save')}
          </button>

          {record.error && (
            <p className="col-span-2 text-sm text-red-700" role="alert">
              {record.error.message}
            </p>
          )}
        </form>

        <div className="space-y-4">
          {result && (
            <div
              className={
                result.ews.risk === 'high'
                  ? 'card border-red-400 bg-red-50'
                  : result.ews.risk === 'medium'
                    ? 'card border-amber-400 bg-amber-50'
                    : 'card border-emerald-400 bg-emerald-50'
              }
              role="status"
            >
              <div className="flex items-center gap-2">
                <EwsBadge score={result.ews.score} risk={result.ews.risk} />
                {result.ews.hasRedScore && (
                  <span className="rounded bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
                    RED SCORE
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm font-medium">{result.ews.response}</p>

              {result.critical_values.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm text-red-800">
                  {result.critical_values.map((c) => (
                    <li key={c.parameter}>
                      <strong>{c.parameter}</strong> {c.value} ({c.threshold})
                    </li>
                  ))}
                </ul>
              )}

              {result.ews.missing.length > 0 && (
                <p className="mt-2 text-xs text-slate-600">
                  {t('common.required')}: {result.ews.missing.join(', ')}
                </p>
              )}
            </div>
          )}

          <QueryState
            isLoading={history.isLoading}
            error={history.error}
            isEmpty={history.data?.length === 0}
          >
            <div className="card overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('common.time')}</th>
                    <th>BP</th>
                    <th>HR</th>
                    <th>SpO₂</th>
                    <th>{t('clinical.ews')}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data?.slice(0, 20).map((v) => (
                    <tr key={String(v.id)}>
                      <td className="text-xs">{date(String(v.recorded_at), true)}</td>
                      <td className="tabular-nums">
                        {v.systolic_bp ? `${String(v.systolic_bp)}/${String(v.diastolic_bp ?? '')}` : '—'}
                      </td>
                      <td className="tabular-nums">{String(v.heart_rate ?? '—')}</td>
                      <td className="tabular-nums">{String(v.spo2 ?? '—')}</td>
                      <td>
                        <EwsBadge score={v.ews_score as number | null} risk={v.ews_risk as string | null} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </QueryState>
        </div>
      </div>
    </QueryState>
  );
}
