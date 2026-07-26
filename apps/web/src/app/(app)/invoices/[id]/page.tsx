'use client';

import { use, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { keys, useApiMutation, useInvoice } from '@/lib/queries';
import { PageHeader, QueryState, Field } from '@/components/ui';

interface FormattedInvoice {
  documentTitle: string;
  taxLabel: string;
  regulatoryFields: Record<string, string>;
  lines: Array<{ description: string; qty: number; unit: string; tax: string; total: string }>;
  subtotal: string;
  tax: string;
  discount: string;
  total: string;
  amountInWords?: string;
}

const METHODS = ['cash', 'card', 'bank_transfer', 'apple_pay', 'google_pay', 'cheque'] as const;

export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, money, date } = useI18n();
  const { can } = usePermissions();

  const invoice = useInvoice(id);

  // The printable rendering comes from the tenant's country pack, so tax labels,
  // regulatory fields and amount-in-words match local requirements.
  const printable = useQuery<{ formatted: FormattedInvoice }>({
    queryKey: ['invoice', id, 'print'],
    queryFn: () => api.get<{ formatted: FormattedInvoice }>(`/billing/invoices/${id}/print`),
  });

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<(typeof METHODS)[number]>('cash');

  const pay = useApiMutation<
    { invoice_id: string; method: string; amount_minor: number },
    { balance_minor: number }
  >('/billing/payments', [keys.invoice(id), keys.invoices({})]);

  const record = invoice.data as Record<string, unknown> | undefined;
  const currency = String(record?.currency ?? 'USD');
  const formatted = printable.data?.formatted;

  return (
    <QueryState isLoading={invoice.isLoading} error={invoice.error}>
      {record && (
        <>
          <PageHeader
            title={String(record.invoice_number)}
            subtitle={formatted?.documentTitle}
            actions={
              <button type="button" className="btn-secondary" onClick={() => window.print()}>
                {t('common.print')}
              </button>
            }
          />

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="card lg:col-span-2">
              {formatted && (
                <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {Object.entries(formatted.regulatoryFields).map(([key, value]) => (
                    <div key={key} className="contents">
                      <dt className="text-slate-500">{key}</dt>
                      <dd className="font-medium">{value}</dd>
                    </div>
                  ))}
                </dl>
              )}

              <table className="table">
                <thead>
                  <tr>
                    <th>{t('common.notes')}</th>
                    <th className="text-end">Qty</th>
                    <th className="text-end">{t('billing.amount')}</th>
                    <th className="text-end">{formatted?.taxLabel ?? t('billing.tax')}</th>
                    <th className="text-end">{t('billing.total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {((record.line_items ?? []) as Record<string, unknown>[]).map((li) => (
                    <tr key={String(li.id)}>
                      <td>{String(li.description)}</td>
                      <td className="text-end tabular-nums">{String(li.quantity)}</td>
                      <td className="text-end tabular-nums">
                        {money(Number(li.unit_price_minor), currency)}
                      </td>
                      <td className="text-end tabular-nums">
                        {money(Number(li.tax_minor), currency)}
                      </td>
                      <td className="text-end tabular-nums font-medium">
                        {money(Number(li.total_minor), currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} className="text-end font-medium">
                      {t('billing.subtotal')}
                    </td>
                    <td className="text-end tabular-nums">
                      {money(Number(record.subtotal_minor), currency)}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={4} className="text-end font-medium">
                      {formatted?.taxLabel ?? t('billing.tax')}
                    </td>
                    <td className="text-end tabular-nums">
                      {money(Number(record.tax_minor), currency)}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={4} className="text-end font-bold">
                      {t('billing.total')}
                    </td>
                    <td className="text-end tabular-nums font-bold">
                      {money(Number(record.total_minor), currency)}
                    </td>
                  </tr>
                </tfoot>
              </table>

              {formatted?.amountInWords && (
                <p className="mt-3 text-xs italic text-slate-600">{formatted.amountInWords}</p>
              )}
            </div>

            <div className="space-y-4">
              <div className="card">
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <dt>{t('billing.paid')}</dt>
                    <dd className="tabular-nums">{money(Number(record.paid_minor), currency)}</dd>
                  </div>
                  <div className="flex justify-between font-bold">
                    <dt>{t('billing.balance')}</dt>
                    <dd className="tabular-nums">{money(Number(record.balance_minor), currency)}</dd>
                  </div>
                  <div className="flex justify-between text-xs text-slate-500">
                    <dt>{t('billing.insurance')}</dt>
                    <dd className="tabular-nums">
                      {money(Number(record.payer_share_minor), currency)}
                    </dd>
                  </div>
                  <div className="flex justify-between text-xs text-slate-500">
                    <dt>{t('clinical.patient')}</dt>
                    <dd className="tabular-nums">
                      {money(Number(record.patient_share_minor), currency)}
                    </dd>
                  </div>
                </dl>
              </div>

              {can('payment:write') && Number(record.balance_minor) > 0 && (
                <form
                  className="card space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    // Amount is entered in major units and converted to integer minor units.
                    pay.mutate(
                      {
                        invoice_id: id,
                        method,
                        amount_minor: Math.round(Number(amount) * 100),
                      },
                      { onSuccess: () => setAmount('') },
                    );
                  }}
                >
                  <h3 className="font-semibold">{t('billing.payment')}</h3>

                  <Field label={t('billing.amount')} required>
                    <input
                      className="input"
                      type="number"
                      step="0.01"
                      min="0.01"
                      max={Number(record.balance_minor) / 100}
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      required
                    />
                  </Field>

                  <Field label={t('billing.payment')}>
                    <select
                      className="input"
                      value={method}
                      onChange={(e) => setMethod(e.target.value as typeof method)}
                    >
                      {METHODS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <button type="submit" className="btn-primary w-full" disabled={pay.isPending}>
                    {t('common.confirm')}
                  </button>

                  {pay.error && (
                    <p className="text-sm text-red-700" role="alert">
                      {pay.error.message}
                    </p>
                  )}
                </form>
              )}

              <div className="card">
                <h3 className="mb-2 font-semibold">{t('billing.receipt')}</h3>
                <ul className="space-y-1 text-xs">
                  {((record.payments ?? []) as Record<string, unknown>[]).map((p) => (
                    <li key={String(p.id)} className="flex justify-between">
                      <span className="font-mono">{String(p.receipt_number)}</span>
                      <span className="tabular-nums">
                        {money(Number(p.amount_minor), String(p.currency))}
                      </span>
                      <span className="text-slate-500">{date(String(p.received_at))}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </>
      )}
    </QueryState>
  );
}
