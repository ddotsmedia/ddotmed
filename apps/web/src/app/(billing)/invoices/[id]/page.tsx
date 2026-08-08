'use client';

import { use, useState } from 'react';
import clsx from 'clsx';
import { ApiError } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { formatBp, formatMoney, parseMoney } from '@/lib/money';
import {
  keys,
  useApiMutation,
  useInvoiceDetail,
  type ClaimSubmitResult,
} from '@/lib/queries';
import { PageHeader, QueryState, Field } from '@/components/ui';

const METHODS = ['cash', 'card', 'online', 'insurance', 'bank_transfer', 'cheque'] as const;

const RISK_TONE: Record<string, string> = {
  low: 'border-emerald-400 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200',
  medium: 'border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200',
  high: 'border-red-500 bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200',
};

type Sheet = 'payment' | 'void' | 'claim' | null;

export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, date } = useI18n();
  const { can } = usePermissions();

  const invoice = useInvoiceDetail(id);
  const data = invoice.data;
  const currency = data?.currency ?? 'AED';

  const [sheet, setSheet] = useState<Sheet>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<(typeof METHODS)[number]>('cash');
  const [voidReason, setVoidReason] = useState('');
  const [payerId, setPayerId] = useState('');
  const [diagnosisCodes, setDiagnosisCodes] = useState('');
  const [procedureCodes, setProcedureCodes] = useState('');
  const [noteText, setNoteText] = useState('');

  const invalidate = [keys.invoiceDetail(id)];

  const pay = useApiMutation<Record<string, unknown>, unknown>('/payments', invalidate);
  const voidInvoice = useApiMutation<{ reason: string }, unknown>(
    `/invoices/${id}/void`,
    invalidate,
    'patch',
  );
  const submitClaim = useApiMutation<Record<string, unknown>, ClaimSubmitResult>(
    '/insurance-claims',
    invalidate,
  );

  const error =
    (pay.error ?? voidInvoice.error ?? submitClaim.error) instanceof ApiError
      ? ((pay.error ?? voidInvoice.error ?? submitClaim.error) as ApiError)
      : null;

  const closeSheet = () => {
    setSheet(null);
    pay.reset();
    voidInvoice.reset();
  };

  const voided = data?.status === 'cancelled';
  const settled = (data?.balance_minor ?? 0) <= 0;
  const claim = submitClaim.data;

  return (
    <QueryState isLoading={invoice.isLoading} error={invoice.error}>
      {data && (
        <>
          <PageHeader
            title={`${t('billing.invoice')} ${data.invoice_number}`}
            subtitle={data.issued_at ? date(data.issued_at) : undefined}
            actions={
              <>
                {/* The print stylesheet is the PDF route: no extra bundle, and the
                    browser's own "save as PDF" produces the file. */}
                <button type="button" className="btn-secondary print:hidden" onClick={() => window.print()}>
                  {t('billing.downloadPdf')}
                </button>
                {can('payment:write') && !voided && !settled && (
                  <button type="button" className="btn-primary print:hidden" onClick={() => setSheet('payment')}>
                    {t('billing.recordPayment')}
                  </button>
                )}
                {can('claim:submit') && data.payer_type === 'insurance' && !voided && (
                  <button type="button" className="btn-secondary print:hidden" onClick={() => setSheet('claim')}>
                    {t('billing.submitClaim')}
                  </button>
                )}
                {can('invoice:write') && !voided && data.paid_minor === 0 && (
                  <button type="button" className="btn-danger print:hidden" onClick={() => setSheet('void')}>
                    {t('billing.voidInvoice')}
                  </button>
                )}
              </>
            }
          />

          {voided && (
            <p className="card mb-4 border-2 border-slate-400 text-center font-bold uppercase tracking-widest">
              {t('billing.voidInvoice')}
            </p>
          )}

          <section className="card mb-4">
            <h2 className="mb-2 font-semibold">{t('billing.lineItems')}</h2>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('billing.serviceCode')}</th>
                    <th>{t('common.notes')}</th>
                    <th className="text-end">{t('clinical.quantity')}</th>
                    <th className="text-end">{t('billing.unitPrice')}</th>
                    <th className="text-end">{t('billing.taxLabel')}</th>
                    <th className="text-end">{t('billing.lineTotal')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.line_items?.map((line) => (
                    <tr key={line.id}>
                      <td className="font-mono text-xs">{line.charge_code}</td>
                      <td>{line.description}</td>
                      <td className="text-end tabular-nums">{line.quantity}</td>
                      <td className="text-end tabular-nums">
                        {formatMoney(line.unit_price_minor, currency)}
                      </td>
                      <td className="text-end tabular-nums">
                        {formatMoney(line.tax_minor, currency)}
                      </td>
                      <td className="text-end font-medium tabular-nums">
                        {formatMoney(line.total_minor, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <dt>{t('billing.subtotal')}</dt>
                <dd className="tabular-nums">{formatMoney(data.subtotal_minor, currency)}</dd>
              </div>
              {data.discount_minor > 0 && (
                <div className="flex justify-between">
                  <dt>{t('billing.discount')}</dt>
                  <dd className="tabular-nums">-{formatMoney(data.discount_minor, currency)}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt>{t('billing.taxLabel')}</dt>
                <dd className="tabular-nums">{formatMoney(data.tax_minor, currency)}</dd>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-1 font-bold dark:border-slate-700">
                <dt>{t('billing.grandTotal')}</dt>
                <dd className="tabular-nums">{formatMoney(data.total_minor, currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>{t('billing.paid')}</dt>
                <dd className="tabular-nums">{formatMoney(data.paid_minor, currency)}</dd>
              </div>
              <div
                className={clsx(
                  'flex justify-between font-semibold',
                  data.balance_minor > 0 && 'text-amber-700',
                )}
              >
                <dt>{t('billing.outstanding')}</dt>
                <dd className="tabular-nums">{formatMoney(data.balance_minor, currency)}</dd>
              </div>
            </dl>
          </section>

          <section className="card mb-4">
            <h2 className="mb-2 font-semibold">{t('billing.paymentHistory')}</h2>
            {(data.payments?.length ?? 0) === 0 ? (
              <p className="text-sm text-slate-500">{t('common.noData')}</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {data.payments?.map((payment) => (
                  <li key={payment.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{payment.receipt_number}</span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">
                      {payment.method}
                    </span>
                    <span className="text-xs text-slate-500">{date(payment.received_at, true)}</span>
                    <span className="ms-auto font-semibold tabular-nums">
                      {formatMoney(payment.amount_minor, currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {claim && (
            <section className={clsx('card mb-4 border-2', RISK_TONE[claim.denial_risk.level])}>
              <h2 className="font-semibold">
                {t('billing.denialRisk')} — {formatBp(claim.denial_risk.risk_bp)} (
                {claim.denial_risk.level})
              </h2>
              <p className="mt-0.5 text-sm">
                {claim.claim.claim_number} · {formatMoney(claim.claim.claimed_minor, currency)}
              </p>

              {claim.denial_risk.factors.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm">
                  {claim.denial_risk.factors.map((factor) => (
                    <li key={factor.code}>
                      <span className="font-semibold">{factor.detail}.</span> {factor.remedy}
                    </li>
                  ))}
                </ul>
              )}

              {claim.coding_suggestions.length > 0 && (
                <>
                  <h3 className="mt-3 text-sm font-semibold">{t('billing.codingSuggestions')}</h3>
                  <p className="text-xs opacity-80">
                    {claim.coding_model_version} · {t('clinical.requiresApproval')}
                  </p>
                  <ul className="mt-1 space-y-1 text-sm">
                    {claim.coding_suggestions.map((suggestion) => (
                      <li
                        key={`${suggestion.system}-${suggestion.code}`}
                        className={clsx(
                          'flex flex-wrap items-center gap-2 rounded border px-2 py-1',
                          suggestion.already_on_claim
                            ? 'border-slate-300 opacity-60 dark:border-slate-600'
                            : 'border-sky-300 dark:border-sky-700',
                        )}
                      >
                        <span className="font-mono font-semibold">{suggestion.code}</span>
                        <span>{suggestion.display}</span>
                        <span
                          className={clsx(
                            'ms-auto rounded px-1.5 py-0.5 text-xs font-semibold',
                            suggestion.low_confidence
                              ? 'bg-amber-100 text-amber-900'
                              : 'bg-emerald-100 text-emerald-900',
                          )}
                        >
                          {(suggestion.confidence * 100).toFixed(0)}%
                        </span>
                        {suggestion.already_on_claim && (
                          <span className="text-xs">✓ {t('billing.claim')}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}

          {error && (
            <p
              className="card mb-4 border-amber-500 bg-amber-50 text-sm text-amber-900"
              role="alert"
            >
              {error.message}
            </p>
          )}

          {sheet && (
            <div
              className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 print:hidden sm:items-center"
              role="dialog"
              aria-modal="true"
            >
              <form
                className="max-h-[90dvh] w-full overflow-y-auto rounded-t-xl bg-white p-4 shadow-xl sm:max-w-md sm:rounded-xl dark:bg-slate-900"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (sheet === 'payment') {
                    pay.mutate(
                      {
                        invoice_id: id,
                        amount_minor: parseMoney(amount, currency) ?? 0,
                        currency,
                        method,
                      },
                      { onSuccess: closeSheet },
                    );
                  } else if (sheet === 'void') {
                    voidInvoice.mutate({ reason: voidReason.trim() }, { onSuccess: closeSheet });
                  } else {
                    submitClaim.mutate(
                      {
                        invoice_id: id,
                        payer_id: payerId.trim(),
                        diagnosis_codes: diagnosisCodes.split(',').map((c) => c.trim()).filter(Boolean),
                        procedure_codes: procedureCodes.split(',').map((c) => c.trim()).filter(Boolean),
                        note_text: noteText.trim() || undefined,
                      },
                      { onSuccess: () => setSheet(null) },
                    );
                  }
                }}
              >
                {sheet === 'payment' && (
                  <>
                    <h2 className="mb-3 font-semibold">{t('billing.recordPayment')}</h2>
                    <Field label={t('billing.amount')} required>
                      <input
                        inputMode="decimal"
                        className="input"
                        value={amount}
                        placeholder={formatMoney(data.balance_minor, currency)}
                        onChange={(e) => setAmount(e.target.value)}
                      />
                    </Field>
                    <Field label={t('billing.paymentMethod')} required>
                      <select
                        className="input"
                        value={method}
                        onChange={(e) => setMethod(e.target.value as (typeof METHODS)[number])}
                      >
                        {METHODS.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </>
                )}

                {sheet === 'void' && (
                  <>
                    <h2 className="mb-3 font-semibold">{t('billing.voidInvoice')}</h2>
                    <Field label={t('billing.voidReason')} required>
                      <textarea
                        className="input min-h-20"
                        value={voidReason}
                        onChange={(e) => setVoidReason(e.target.value)}
                      />
                    </Field>
                  </>
                )}

                {sheet === 'claim' && (
                  <>
                    <h2 className="mb-3 font-semibold">{t('billing.submitClaim')}</h2>
                    <Field label={t('billing.payer')} required>
                      <input
                        className="input"
                        value={payerId}
                        placeholder="Payer id"
                        onChange={(e) => setPayerId(e.target.value.trim())}
                      />
                    </Field>
                    <Field label={t('clinical.diagnosis')} required>
                      <input
                        className="input font-mono"
                        value={diagnosisCodes}
                        placeholder="J18.9, E11.9"
                        onChange={(e) => setDiagnosisCodes(e.target.value)}
                      />
                    </Field>
                    <Field label={t('billing.serviceCode')}>
                      <input
                        className="input font-mono"
                        value={procedureCodes}
                        placeholder="99213"
                        onChange={(e) => setProcedureCodes(e.target.value)}
                      />
                    </Field>
                    <Field label={t('billing.aiCoding')}>
                      <textarea
                        className="input min-h-20"
                        value={noteText}
                        placeholder={t('clinical.clinicalNotes')}
                        onChange={(e) => setNoteText(e.target.value)}
                      />
                    </Field>
                  </>
                )}

                <div className="mt-3 flex gap-2">
                  <button
                    type="submit"
                    className={clsx('flex-1', sheet === 'void' ? 'btn-danger' : 'btn-primary')}
                    disabled={
                      pay.isPending ||
                      voidInvoice.isPending ||
                      submitClaim.isPending ||
                      (sheet === 'payment' && !parseMoney(amount, currency)) ||
                      (sheet === 'void' && voidReason.trim().length < 5) ||
                      (sheet === 'claim' && (!payerId || !diagnosisCodes.trim()))
                    }
                  >
                    {t('common.confirm')}
                  </button>
                  <button type="button" className="btn-secondary" onClick={closeSheet}>
                    {t('common.cancel')}
                  </button>
                </div>
              </form>
            </div>
          )}
        </>
      )}
    </QueryState>
  );
}
