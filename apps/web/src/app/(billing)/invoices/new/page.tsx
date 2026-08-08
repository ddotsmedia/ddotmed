'use client';

import { Suspense, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { formatMoney, parseMoney } from '@/lib/money';
import { keys, useApiMutation, type InvoiceRow } from '@/lib/queries';
import { PageHeader, Field } from '@/components/ui';

const CURRENCIES = ['AED', 'SAR', 'INR', 'USD', 'EUR', 'GBP'] as const;
const PAYER_TYPES = ['cash', 'insurance', 'corporate'] as const;

interface DraftLine {
  key: string;
  service_code: string;
  description: string;
  quantity: string;
  unit_price: string;
  discount: string;
  tax_rate_bp: string;
}

const emptyLine = (): DraftLine => ({
  key: Math.random().toString(36).slice(2),
  service_code: '',
  description: '',
  quantity: '1',
  unit_price: '',
  discount: '0',
  tax_rate_bp: '500',
});

/**
 * Line arithmetic, mirrored for preview only.
 *
 * The server recomputes every figure from the same inputs and its answer is the
 * one that is stored — this exists so the clerk sees a total before they commit,
 * not so the total is decided here.
 */
function previewLine(line: DraftLine, currency: string) {
  const unit = parseMoney(line.unit_price, currency) ?? 0;
  const quantity = Math.max(1, Number(line.quantity) || 1);
  const discount = Math.min(parseMoney(line.discount, currency) ?? 0, unit * quantity);
  const net = unit * quantity - discount;
  const bp = Number(line.tax_rate_bp) || 0;
  // Half-up on an integer pair, matching the server's divRound.
  const tax = Math.sign(net * bp) * Math.floor((Math.abs(net * bp) * 2 + 10_000) / 20_000);
  return { net, tax, total: net + tax };
}

function NewInvoiceInner() {
  const { t } = useI18n();
  const router = useRouter();
  const search = useSearchParams();

  const [patientId, setPatientId] = useState(search.get('patientId') ?? '');
  const [encounterId, setEncounterId] = useState(search.get('encounterId') ?? '');
  const [coverageId, setCoverageId] = useState('');
  const [payerType, setPayerType] = useState<(typeof PAYER_TYPES)[number]>('cash');
  const [currency, setCurrency] = useState<(typeof CURRENCIES)[number]>('AED');
  const [dueDays, setDueDays] = useState('30');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);

  const create = useApiMutation<Record<string, unknown>, InvoiceRow>('/invoices', [
    keys.invoiceList({ status: 'open', payerType: undefined, limit: '50' }),
  ]);

  const totals = useMemo(() => {
    return lines.reduce(
      (acc, line) => {
        const p = previewLine(line, currency);
        return {
          subtotal: acc.subtotal + p.net,
          tax: acc.tax + p.tax,
          total: acc.total + p.total,
        };
      },
      { subtotal: 0, tax: 0, total: 0 },
    );
  }, [lines, currency]);

  const setLine = (key: string, patch: Partial<DraftLine>) =>
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const complete = lines.every(
    (l) => l.service_code.trim() && l.description.trim() && parseMoney(l.unit_price, currency) !== null,
  );
  const error = create.error instanceof ApiError ? create.error : null;

  return (
    <>
      <PageHeader title={t('billing.newInvoice')} />

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(
            {
              patient_id: patientId.trim(),
              encounter_id: encounterId.trim() || null,
              coverage_id: coverageId.trim() || null,
              payer_type: payerType,
              currency,
              due_days: Number(dueDays) || 30,
              line_items: lines.map((line) => ({
                service_code: line.service_code.trim(),
                description: line.description.trim(),
                quantity: Math.max(1, Number(line.quantity) || 1),
                unit_price_minor: parseMoney(line.unit_price, currency) ?? 0,
                discount_minor: parseMoney(line.discount, currency) ?? 0,
                tax_rate_bp: Number(line.tax_rate_bp) || 0,
              })),
            },
            { onSuccess: (invoice) => router.push(`/invoices/${invoice.id}`) },
          );
        }}
      >
        <section className="card grid gap-3 sm:grid-cols-2">
          <Field label={t('clinical.patient')} required>
            <input
              className="input"
              value={patientId}
              placeholder="Patient id"
              onChange={(e) => setPatientId(e.target.value.trim())}
            />
          </Field>
          <Field label={t('clinical.encounter')}>
            <input
              className="input"
              value={encounterId}
              placeholder="Encounter id"
              onChange={(e) => setEncounterId(e.target.value.trim())}
            />
          </Field>
          <Field label={t('billing.payerTypeLabel')} required>
            <select
              className="input"
              value={payerType}
              onChange={(e) => setPayerType(e.target.value as (typeof PAYER_TYPES)[number])}
            >
              {PAYER_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('billing.currency')} required>
            <select
              className="input"
              value={currency}
              onChange={(e) => setCurrency(e.target.value as (typeof CURRENCIES)[number])}
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </Field>
          {payerType === 'insurance' && (
            <Field label={t('billing.insurance')}>
              <input
                className="input"
                value={coverageId}
                placeholder="Coverage id"
                onChange={(e) => setCoverageId(e.target.value.trim())}
              />
            </Field>
          )}
          <Field label={t('billing.dueDate')}>
            <input
              type="number"
              min="0"
              className="input"
              value={dueDays}
              onChange={(e) => setDueDays(e.target.value)}
            />
          </Field>
        </section>

        <section className="card space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold">{t('billing.lineItems')}</h2>
            <button
              type="button"
              className="btn-secondary ms-auto py-1 text-xs"
              onClick={() => setLines((current) => [...current, emptyLine()])}
            >
              + {t('billing.addLine')}
            </button>
          </div>

          {lines.map((line) => {
            const preview = previewLine(line, currency);
            return (
              <div
                key={line.key}
                className="rounded border border-slate-200 p-2 dark:border-slate-700"
              >
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
                  <Field label={t('billing.serviceCode')} required>
                    <input
                      className="input font-mono"
                      value={line.service_code}
                      onChange={(e) => setLine(line.key, { service_code: e.target.value })}
                    />
                  </Field>
                  <div className="col-span-2 sm:col-span-2">
                    <Field label={t('common.notes')} required>
                      <input
                        className="input"
                        value={line.description}
                        onChange={(e) => setLine(line.key, { description: e.target.value })}
                      />
                    </Field>
                  </div>
                  <Field label={t('clinical.quantity')} required>
                    <input
                      type="number"
                      min="1"
                      className="input"
                      value={line.quantity}
                      onChange={(e) => setLine(line.key, { quantity: e.target.value })}
                    />
                  </Field>
                  <Field label={t('billing.unitPrice')} required>
                    <input
                      inputMode="decimal"
                      className="input"
                      value={line.unit_price}
                      onChange={(e) => setLine(line.key, { unit_price: e.target.value })}
                    />
                  </Field>
                  <Field label={t('billing.discount')}>
                    <input
                      inputMode="decimal"
                      className="input"
                      value={line.discount}
                      onChange={(e) => setLine(line.key, { discount: e.target.value })}
                    />
                  </Field>
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                  <span>
                    {t('billing.taxLabel')} {(Number(line.tax_rate_bp) / 100).toFixed(2)}% ={' '}
                    {formatMoney(preview.tax, currency)}
                  </span>
                  <span className="font-semibold">
                    {t('billing.lineTotal')} {formatMoney(preview.total, currency)}
                  </span>
                  {lines.length > 1 && (
                    <button
                      type="button"
                      className="ms-auto text-red-700 underline"
                      onClick={() => setLines((c) => c.filter((l) => l.key !== line.key))}
                    >
                      {t('common.delete')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        {/* Preview only. The server recomputes and its figures are what get stored. */}
        <section className="card">
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt>{t('billing.subtotal')}</dt>
              <dd className="tabular-nums">{formatMoney(totals.subtotal, currency)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>{t('billing.taxLabel')}</dt>
              <dd className="tabular-nums">{formatMoney(totals.tax, currency)}</dd>
            </div>
            <div className="flex justify-between border-t border-slate-200 pt-1 font-bold dark:border-slate-700">
              <dt>{t('billing.grandTotal')}</dt>
              <dd className="tabular-nums">{formatMoney(totals.total, currency)}</dd>
            </div>
          </dl>
        </section>

        {error && (
          <p className="rounded border border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
            {error.message}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="submit"
            className="btn-primary"
            disabled={!patientId || !complete || create.isPending}
          >
            {t('billing.newInvoice')}
          </button>
          <button type="button" className="btn-secondary" onClick={() => router.push('/invoices')}>
            {t('common.cancel')}
          </button>
        </div>
      </form>
    </>
  );
}

export default function NewInvoicePage() {
  return (
    <Suspense fallback={null}>
      <NewInvoiceInner />
    </Suspense>
  );
}
