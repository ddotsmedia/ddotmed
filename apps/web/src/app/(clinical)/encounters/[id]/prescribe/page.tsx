'use client';

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { useDebounced } from '@/lib/use-debounced';
import {
  keys,
  useApiMutation,
  useDrugSearch,
  useEncounter,
  usePrescriptions,
  type DrugMatch,
  type Prescription,
} from '@/lib/queries';
import { PageHeader, QueryState, Field } from '@/components/ui';
import { SafetyPanel, type Preflight } from '@/components/encounter/SafetyPanel';

/**
 * Prescribing defaults by class, mirroring the server's own table.
 *
 * Duplicated deliberately and narrowly: these only pre-fill a form the clinician
 * then reads and confirms, so a drift here changes what is typed, never what is
 * checked. The gates that decide whether an order may be written live on the
 * server and are not mirrored anywhere.
 */
const CLASS_DEFAULTS: Record<string, { frequency: string; duration: number | null; note?: string }> = {
  analgesic: { frequency: 'QDS', duration: 5 },
  nsaid: { frequency: 'TDS', duration: 5, note: 'Take with food; check renal function' },
  opioid: { frequency: 'QDS PRN', duration: 3, note: 'Shortest effective course' },
  antibiotic: { frequency: 'TDS', duration: 7, note: 'Complete the course' },
  antifungal: { frequency: 'OD', duration: 7 },
  anticoagulant: { frequency: 'OD', duration: null, note: 'Dose is INR-guided' },
  antiplatelet: { frequency: 'OD', duration: null },
  antihypertensive: { frequency: 'OD', duration: 28 },
  diuretic: { frequency: 'OM', duration: 28, note: 'Monitor electrolytes' },
  statin: { frequency: 'ON', duration: 28 },
  antidiabetic: { frequency: 'BD', duration: 28, note: 'Take with meals' },
  ppi: { frequency: 'OM', duration: 28 },
  antidepressant: { frequency: 'OM', duration: 28, note: 'Review at 2 weeks' },
  antipsychotic: { frequency: 'ON', duration: 28, note: 'Requires level monitoring' },
  benzodiazepine: { frequency: 'ON PRN', duration: 7, note: 'Short course only' },
  bronchodilator: { frequency: 'QDS PRN', duration: null, note: 'Check inhaler technique' },
  corticosteroid: { frequency: 'OM', duration: 5, note: 'Morning dose, with food' },
  antiemetic: { frequency: 'TDS PRN', duration: 3 },
  thyroid: { frequency: 'OM', duration: 28, note: 'Empty stomach, 30 min before food' },
  other: { frequency: 'OD', duration: 7 },
};

const ROUTE_BY_FORM: Record<string, string> = {
  tablet: 'oral',
  capsule: 'oral',
  syrup: 'oral',
  suspension: 'oral',
  injection: 'intravenous',
  inhaler: 'inhaled',
  cream: 'topical',
  drops: 'ophthalmic',
  patch: 'transdermal',
  suppository: 'rectal',
};

const DOSES_PER_DAY: Record<string, number> = { OD: 1, OM: 1, ON: 1, BD: 2, TDS: 3, QDS: 4 };

const ROUTES = ['oral', 'intravenous', 'intramuscular', 'subcutaneous', 'inhaled', 'topical', 'rectal', 'transdermal', 'ophthalmic'];
const FREQUENCIES = ['OD', 'OM', 'ON', 'BD', 'TDS', 'QDS', 'QDS PRN', 'TDS PRN', 'ON PRN', 'weekly'];

const suggestedQuantity = (dose: number, frequency: string, days: number | null): number => {
  const key = frequency.replace(/\s*PRN$/i, '').trim().toUpperCase();
  return Math.max(1, Math.ceil(dose * (DOSES_PER_DAY[key] ?? 1) * (days ?? 28)));
};

interface FormState {
  dose_quantity: string;
  dose_unit: string;
  route: string;
  frequency: string;
  duration_days: string;
  quantity: string;
  refills: string;
  instructions: string;
  is_prn: boolean;
  witness_id: string;
}

const EMPTY_FORM: FormState = {
  dose_quantity: '1',
  dose_unit: 'tablet',
  route: 'oral',
  frequency: 'OD',
  duration_days: '7',
  quantity: '7',
  refills: '0',
  instructions: '',
  is_prn: false,
  witness_id: '',
};

export default function PrescribePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useI18n();
  const { can } = usePermissions();

  const encounter = useEncounter(id);
  const patientId = String(
    (encounter.data as Record<string, unknown> | undefined)?.patient_id ?? '',
  );

  const [query, setQuery] = useState('');
  const debounced = useDebounced(query);
  const results = useDrugSearch(debounced);

  const [drug, setDrug] = useState<DrugMatch | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [overrideReason, setOverrideReason] = useState('');
  const [reviewing, setReviewing] = useState(false);

  const active = usePrescriptions(patientId, 'active');

  // Safety runs on the drug, not on the dose — so it fires the moment a drug is
  // chosen and the answer is on screen before the clinician has finished typing.
  const preflight = useQuery<Preflight>({
    queryKey: ['medications', 'preflight', patientId, drug?.rxnorm, drug?.generic_name],
    queryFn: () =>
      api.post<Preflight>('/medications/preflight', {
        patient_id: patientId,
        code: drug!.rxnorm,
        display: drug!.generic_name,
      }),
    enabled: Boolean(patientId && drug),
  });

  const prescribe = useApiMutation<Record<string, unknown>, { id: string }>('/medications', [
    keys.prescriptions(patientId, 'active'),
    keys.encounter(id),
  ]);
  const discontinue = useApiMutation<{ medId: string; reason: string }, unknown>(
    (body) => `/medications/${body.medId}`,
    [keys.prescriptions(patientId, 'active')],
    'patch',
  );

  // Choosing a drug pre-fills the form from its class; the clinician still confirms.
  useEffect(() => {
    if (!drug) return;
    const defaults = CLASS_DEFAULTS[drug.drug_class] ?? CLASS_DEFAULTS.other!;
    const unit = drug.dose_form === 'inhaler' ? 'puff' : drug.dose_form;
    const dose = drug.dose_form === 'inhaler' ? 2 : 1;
    setForm({
      ...EMPTY_FORM,
      dose_quantity: String(dose),
      dose_unit: unit,
      route: ROUTE_BY_FORM[drug.dose_form] ?? 'oral',
      frequency: defaults.frequency,
      duration_days: defaults.duration === null ? '' : String(defaults.duration),
      quantity: String(suggestedQuantity(dose, defaults.frequency, defaults.duration)),
      is_prn: defaults.frequency.toUpperCase().endsWith('PRN'),
    });
    setOverrideReason('');
    setReviewing(false);
  }, [drug]);

  const classNote = drug ? (CLASS_DEFAULTS[drug.drug_class] ?? CLASS_DEFAULTS.other!).note : undefined;
  const isControlled = Boolean(drug?.is_controlled);
  const check = preflight.data ?? null;

  const blocked = check ? !check.can_prescribe : false;
  const needsReason = Boolean(check?.requires_override);
  const reasonOk = !needsReason || overrideReason.trim().length >= 10;
  const witnessOk = !isControlled || form.witness_id.trim().length > 0;
  const readyToReview = Boolean(drug) && !blocked && reasonOk && witnessOk && !preflight.isLoading;

  const error = prescribe.error instanceof ApiError ? prescribe.error : null;

  const summary = useMemo(() => {
    if (!drug) return '';
    const duration = form.duration_days ? ` for ${form.duration_days} days` : '';
    return `${drug.generic_name} ${drug.strength} — ${form.dose_quantity} ${form.dose_unit} ${form.route} ${form.frequency}${duration}`;
  }, [drug, form]);

  const submit = () => {
    if (!drug) return;
    prescribe.mutate(
      {
        patient_id: patientId,
        encounter_id: id,
        drug_formulary_id: drug.formulary_id ?? null,
        code: drug.rxnorm,
        code_display: `${drug.generic_name} ${drug.strength}`.trim(),
        dose_quantity: Number(form.dose_quantity),
        dose_unit: form.dose_unit,
        route: form.route,
        frequency: form.frequency,
        duration_days: form.duration_days ? Number(form.duration_days) : null,
        quantity: Number(form.quantity),
        refills: Number(form.refills),
        instructions: form.instructions || undefined,
        is_prn: form.is_prn,
        witness_id: form.witness_id || null,
        override_reason: needsReason ? overrideReason.trim() : undefined,
      },
      {
        onSuccess: () => {
          setDrug(null);
          setQuery('');
          setForm(EMPTY_FORM);
          setOverrideReason('');
          setReviewing(false);
        },
      },
    );
  };

  return (
    <QueryState isLoading={encounter.isLoading} error={encounter.error}>
      <PageHeader
        title={t('clinical.newPrescription')}
        actions={
          <Link href={`/encounters/${id}`} className="btn-secondary">
            {t('clinical.encounter')}
          </Link>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Prescribing sheet — full width on a phone, a column on a desk. */}
        <section className="space-y-3">
          <div className="card space-y-3">
            <label className="block">
              <span className="label">{t('clinical.searchDrug')}</span>
              <input
                type="search"
                className="input"
                value={query}
                autoComplete="off"
                placeholder="amoxicillin / 723 / J01CA04"
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>

            {debounced.trim().length >= 2 && !drug && (
              <div className="max-h-64 overflow-y-auto rounded border border-slate-200 dark:border-slate-700">
                {results.isLoading && <p className="p-2 text-sm text-slate-500">{t('common.loading')}</p>}
                {!results.isLoading && (results.data?.length ?? 0) === 0 && (
                  <p className="p-2 text-sm text-slate-500">{t('common.noData')}</p>
                )}
                <ul>
                  {results.data?.map((match) => (
                    <li
                      key={`${match.source}-${match.rxnorm}-${match.generic_name}`}
                      className="border-b border-slate-100 last:border-b-0 dark:border-slate-800"
                    >
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 p-2 text-start hover:bg-slate-50 dark:hover:bg-slate-800"
                        onClick={() => setDrug(match)}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {match.generic_name} {match.strength}
                            {match.brand_name && (
                              <span className="ms-1 font-normal opacity-70">({match.brand_name})</span>
                            )}
                          </span>
                          <span className="block text-xs text-slate-500">
                            {match.dose_form} · {match.atc || match.rxnorm}
                          </span>
                        </span>
                        {match.is_controlled && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900">
                            {match.controlled_schedule}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {drug && (
              <div className="flex flex-wrap items-center gap-2 rounded border border-slate-300 px-2 py-1 dark:border-slate-600">
                <span className="text-sm font-medium">
                  {drug.generic_name} {drug.strength}
                </span>
                {isControlled && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900">
                    {t('clinical.controlledDrug')} {drug.controlled_schedule}
                  </span>
                )}
                <button
                  type="button"
                  className="ms-auto text-xs underline"
                  onClick={() => {
                    setDrug(null);
                    setQuery('');
                  }}
                >
                  {t('common.cancel')}
                </button>
              </div>
            )}
          </div>

          {drug && (
            <SafetyPanel
              preflight={check}
              checking={preflight.isLoading}
              drugName={drug.generic_name}
              overrideReason={overrideReason}
              onOverrideReasonChange={setOverrideReason}
            />
          )}

          {drug && (
            <form
              className="card space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (reviewing) submit();
                else setReviewing(true);
              }}
            >
              {classNote && (
                <p className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                  {classNote}
                </p>
              )}

              <div className="grid grid-cols-2 gap-3">
                <Field label={t('clinical.dose')} required>
                  <input
                    type="number"
                    step="0.001"
                    min="0"
                    className="input"
                    value={form.dose_quantity}
                    onChange={(e) => setForm({ ...form, dose_quantity: e.target.value })}
                  />
                </Field>
                <Field label={t('common.unit')} required>
                  <input
                    className="input"
                    value={form.dose_unit}
                    onChange={(e) => setForm({ ...form, dose_unit: e.target.value })}
                  />
                </Field>
                <Field label={t('clinical.route')} required>
                  <select
                    className="input"
                    value={form.route}
                    onChange={(e) => setForm({ ...form, route: e.target.value })}
                  >
                    {ROUTES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('clinical.frequency')} required>
                  <select
                    className="input"
                    value={form.frequency}
                    onChange={(e) => {
                      const frequency = e.target.value;
                      const days = form.duration_days ? Number(form.duration_days) : null;
                      setForm({
                        ...form,
                        frequency,
                        is_prn: frequency.toUpperCase().endsWith('PRN'),
                        quantity: String(
                          suggestedQuantity(Number(form.dose_quantity) || 1, frequency, days),
                        ),
                      });
                    }}
                  >
                    {FREQUENCIES.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('clinical.durationDays')}>
                  <input
                    type="number"
                    min="1"
                    className="input"
                    value={form.duration_days}
                    onChange={(e) => {
                      const duration_days = e.target.value;
                      setForm({
                        ...form,
                        duration_days,
                        quantity: String(
                          suggestedQuantity(
                            Number(form.dose_quantity) || 1,
                            form.frequency,
                            duration_days ? Number(duration_days) : null,
                          ),
                        ),
                      });
                    }}
                  />
                </Field>
                <Field label={t('clinical.quantity')} required>
                  <input
                    type="number"
                    min="1"
                    className="input"
                    value={form.quantity}
                    onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                  />
                </Field>
                <Field label={t('clinical.refills')}>
                  <input
                    type="number"
                    min="0"
                    className="input"
                    value={form.refills}
                    onChange={(e) => setForm({ ...form, refills: e.target.value })}
                  />
                </Field>
              </div>

              <Field label={t('clinical.instructions')}>
                <textarea
                  className="input min-h-16"
                  value={form.instructions}
                  onChange={(e) => setForm({ ...form, instructions: e.target.value })}
                />
              </Field>

              {/* The witness field exists only for a scheduled drug, and only then. */}
              {isControlled && (
                <Field label={`${t('clinical.witness')} — ${drug.controlled_schedule}`} required>
                  <input
                    className="input"
                    value={form.witness_id}
                    placeholder="Witness user id"
                    onChange={(e) => setForm({ ...form, witness_id: e.target.value })}
                  />
                </Field>
              )}

              {reviewing && (
                <div className="rounded border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:bg-sky-950/30 dark:text-sky-200">
                  <p className="font-semibold">{t('clinical.prescriptionSummary')}</p>
                  <p className="mt-1">{summary}</p>
                  <p className="mt-0.5 text-xs">
                    {t('clinical.quantity')}: {form.quantity} · {t('clinical.refills')}: {form.refills}
                  </p>
                  {form.instructions && <p className="mt-0.5 text-xs">{form.instructions}</p>}
                  {needsReason && (
                    <p className="mt-1 text-xs font-medium">
                      {t('clinical.overrideReason')}: {overrideReason}
                    </p>
                  )}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={!readyToReview || prescribe.isPending || !can('medication:prescribe')}
                >
                  {reviewing ? t('clinical.confirmPrescription') : t('common.next')}
                </button>
                {reviewing && (
                  <button type="button" className="btn-secondary" onClick={() => setReviewing(false)}>
                    {t('common.back')}
                  </button>
                )}
              </div>

              {error && (
                <div
                  className={clsx(
                    'rounded px-3 py-2 text-sm',
                    error.status === 422
                      ? 'border-2 border-red-600 bg-red-50 text-red-900'
                      : 'border border-amber-500 bg-amber-50 text-amber-900',
                  )}
                  role="alert"
                >
                  <p className="font-semibold">{error.message}</p>
                  {error.code && <p className="mt-0.5 font-mono text-xs opacity-75">{error.code}</p>}
                </div>
              )}
            </form>
          )}
        </section>

        <section className="space-y-3">
          <div className="card">
            <h3 className="mb-2 font-semibold">{t('clinical.activePrescriptions')}</h3>
            <QueryState
              isLoading={active.isLoading}
              error={active.error}
              isEmpty={active.data?.length === 0}
              emptyMessage={t('clinical.noActiveMedications')}
            >
              <ul className="space-y-2">
                {active.data?.map((med: Prescription) => (
                  <li
                    key={med.id}
                    className={clsx(
                      'rounded border p-2 text-sm',
                      med.is_controlled
                        ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/20'
                        : 'border-slate-200 dark:border-slate-700',
                    )}
                  >
                    <p className="font-medium">{med.code_display}</p>
                    <p className="text-xs text-slate-600 dark:text-slate-300">
                      {String(med.dose_quantity)} {med.dose_unit} · {med.route} · {med.frequency}
                      {med.duration_days ? ` · ${med.duration_days}d` : ''}
                    </p>
                    {med.instructions && <p className="mt-0.5 text-xs">{med.instructions}</p>}
                    {can('medication:prescribe') && (
                      <button
                        type="button"
                        className="mt-1 text-xs text-red-700 underline"
                        onClick={() =>
                          discontinue.mutate({
                            medId: med.id,
                            reason: 'Discontinued at consultation',
                          })
                        }
                        disabled={discontinue.isPending}
                      >
                        {t('clinical.discontinue')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </QueryState>
            {discontinue.error && (
              <p className="mt-2 text-sm text-red-700" role="alert">
                {discontinue.error.message}
              </p>
            )}
          </div>
        </section>
      </div>
    </QueryState>
  );
}
