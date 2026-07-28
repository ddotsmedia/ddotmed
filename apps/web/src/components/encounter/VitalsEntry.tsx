'use client';

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { calculateEws, detectCriticalVitals, type EwsInput } from '@medicore/shared-types';
import { useI18n } from '@/lib/i18n';
import { Field } from '@/components/ui';

export interface VitalsPayload extends EwsInput {
  patient_id: string;
  encounter_id: string;
  diastolic_bp?: number | null;
  pain_score?: number | null;
}

type FormState = Record<string, string> & { consciousness: string; supplemental_o2: string };

const EMPTY: FormState = {
  respiratory_rate: '',
  spo2: '',
  temperature_c: '',
  systolic_bp: '',
  diastolic_bp: '',
  heart_rate: '',
  pain_score: '',
  consciousness: 'A',
  supplemental_o2: 'false',
};

const num = (value: string): number | null => {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const RISK_STYLE: Record<string, string> = {
  low: 'border-emerald-400 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200',
  medium: 'border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200',
  high: 'border-red-500 bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200',
};

/** Per-parameter tint, so the field that is driving the score is obvious at a glance. */
const componentStyle = (score: number | undefined): string =>
  score === undefined
    ? ''
    : score >= 3
      ? 'border-red-500'
      : score === 2
        ? 'border-amber-500'
        : score === 1
          ? 'border-amber-300'
          : 'border-emerald-400';

export function VitalsEntry({
  patientId,
  encounterId,
  onSubmit,
  saving,
  disabled,
  error,
  latest,
}: {
  patientId: string;
  encounterId: string;
  onSubmit: (payload: VitalsPayload) => void;
  saving: boolean;
  disabled?: boolean;
  error?: string | null;
  latest?: { ews_score: number | null; ews_risk: string | null; recorded_at: string } | null;
}) {
  const { t, date } = useI18n();
  const [form, setForm] = useState<FormState>(EMPTY);

  const input: EwsInput = useMemo(
    () => ({
      respiratory_rate: num(form.respiratory_rate),
      spo2: num(form.spo2),
      temperature_c: num(form.temperature_c),
      systolic_bp: num(form.systolic_bp),
      heart_rate: num(form.heart_rate),
      supplemental_o2: form.supplemental_o2 === 'true',
      consciousness: (form.consciousness || 'A') as EwsInput['consciousness'],
    }),
    [form],
  );

  // Scored on every keystroke with the same NEWS2 module the server uses, so the
  // number on screen is the number that will be stored.
  const ews = useMemo(() => calculateEws(input), [input]);
  const critical = useMemo(() => detectCriticalVitals(input), [input]);
  const anyEntered = ews.missing.length < 5;

  const set = (key: keyof FormState) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const numericField = (
    key: 'respiratory_rate' | 'spo2' | 'temperature_c' | 'systolic_bp' | 'diastolic_bp' | 'heart_rate' | 'pain_score',
    label: string,
    step?: string,
  ) => (
    <Field label={label}>
      <input
        type="number"
        inputMode="decimal"
        step={step}
        className={clsx('input', componentStyle(ews.components[key]))}
        value={form[key]}
        disabled={disabled}
        onChange={(e) => set(key)(e.target.value)}
      />
    </Field>
  );

  return (
    <form
      className="card space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          patient_id: patientId,
          encounter_id: encounterId,
          respiratory_rate: input.respiratory_rate,
          spo2: input.spo2,
          temperature_c: input.temperature_c,
          systolic_bp: input.systolic_bp,
          diastolic_bp: num(form.diastolic_bp),
          heart_rate: input.heart_rate,
          supplemental_o2: input.supplemental_o2,
          consciousness: input.consciousness,
          pain_score: num(form.pain_score),
        });
        setForm(EMPTY);
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{t('clinical.recordVitals')}</h3>
        {latest?.ews_risk && (
          <span className="text-xs text-slate-500">
            {t('clinical.ews')} {latest.ews_score} · {date(latest.recorded_at, true)}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {numericField('respiratory_rate', t('clinical.respiratoryRate'))}
        {numericField('spo2', t('clinical.spo2'))}
        {numericField('temperature_c', t('clinical.temperature'), '0.1')}
        {numericField('systolic_bp', `${t('clinical.bloodPressure')} ↑`)}
        {numericField('diastolic_bp', `${t('clinical.bloodPressure')} ↓`)}
        {numericField('heart_rate', t('clinical.heartRate'))}
        {numericField('pain_score', t('clinical.painScore'))}

        <Field label={t('clinical.consciousness')}>
          <select
            className={clsx('input', componentStyle(ews.components.consciousness))}
            value={form.consciousness}
            disabled={disabled}
            onChange={(e) => set('consciousness')(e.target.value)}
          >
            {(['A', 'C', 'V', 'P', 'U'] as const).map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('clinical.supplementalOxygen')}>
          <select
            className={clsx('input', componentStyle(ews.components.supplemental_o2))}
            value={form.supplemental_o2}
            disabled={disabled}
            onChange={(e) => set('supplemental_o2')(e.target.value)}
          >
            <option value="false">{t('common.no')}</option>
            <option value="true">{t('common.yes')}</option>
          </select>
        </Field>
      </div>

      {anyEntered && (
        <div className={clsx('rounded border px-3 py-2 text-sm', RISK_STYLE[ews.risk])} role="status">
          <p className="font-semibold">
            {t('clinical.ews')} {ews.score} — {ews.risk}
            {ews.hasRedScore && <span className="ms-2" aria-hidden>⚠</span>}
          </p>
          <p className="mt-0.5 text-xs">{ews.response}</p>
          {ews.missing.length > 0 && (
            <p className="mt-0.5 text-xs opacity-80">
              {t('common.noData')}: {ews.missing.join(', ')}
            </p>
          )}
          {critical.length > 0 && (
            <ul className="mt-1 text-xs font-medium">
              {critical.map((c) => (
                <li key={c.parameter}>
                  {c.parameter} {c.value} ({c.threshold})
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <button type="submit" className="btn-primary" disabled={saving || disabled || !anyEntered}>
        {t('common.save')}
      </button>

      {error && (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
