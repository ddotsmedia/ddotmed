'use client';

import { useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { formatMoney } from '@/lib/money';
import { useInvoiceList } from '@/lib/queries';
import { PageHeader, QueryState } from '@/components/ui';

const STATUS_TONE: Record<string, string> = {
  paid: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200',
  partially_paid: 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200',
  issued: 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200',
  overdue: 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200',
  cancelled: 'bg-slate-200 text-slate-600 line-through dark:bg-slate-800 dark:text-slate-400',
  written_off: 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  draft: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
};

const PAYER_TONE: Record<string, string> = {
  insurance: 'bg-violet-100 text-violet-900 dark:bg-violet-950/50 dark:text-violet-200',
  corporate: 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950/50 dark:text-indigo-200',
  cash: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
};

const STATUSES = ['', 'open', 'issued', 'partially_paid', 'paid', 'overdue', 'cancelled'];

export default function InvoicesPage() {
  const { t, date } = useI18n();
  const { can } = usePermissions();

  const [status, setStatus] = useState('open');
  const [payerType, setPayerType] = useState('');

  const invoices = useInvoiceList({
    status: status || undefined,
    payerType: payerType || undefined,
    limit: '50',
  });

  const rows = invoices.data?.data ?? [];

  return (
    <>
      <PageHeader
        title={t('billing.invoices')}
        subtitle={invoices.data ? `${invoices.data.total}` : undefined}
        actions={
          <>
            <Link href="/billing/dashboard" className="btn-secondary">
              {t('billing.arAging')}
            </Link>
            {can('invoice:write') && (
              <Link href="/invoices/new" className="btn-primary">
                {t('billing.newInvoice')}
              </Link>
            )}
          </>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">{t('common.status')}</span>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((value) => (
              <option key={value || 'all'} value={value}>
                {value || t('common.all')}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">{t('billing.payerTypeLabel')}</span>
          <select className="input" value={payerType} onChange={(e) => setPayerType(e.target.value)}>
            <option value="">{t('common.all')}</option>
            <option value="cash">cash</option>
            <option value="insurance">insurance</option>
            <option value="corporate">corporate</option>
          </select>
        </label>
      </div>

      <QueryState
        isLoading={invoices.isLoading}
        error={invoices.error}
        isEmpty={rows.length === 0}
        emptyMessage={t('common.noData')}
      >
        {/* Cards on a phone; the same data reads as a table from tablet up. */}
        <ul className="space-y-2">
          {rows.map((invoice) => (
            <li key={invoice.id} className="card">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/invoices/${invoice.id}`}
                  className="font-mono text-sm font-semibold underline"
                >
                  {invoice.invoice_number}
                </Link>
                <span
                  className={clsx(
                    'rounded px-1.5 py-0.5 text-xs font-medium',
                    STATUS_TONE[invoice.status] ?? STATUS_TONE.draft,
                  )}
                >
                  {invoice.status}
                </span>
                <span
                  className={clsx(
                    'rounded px-1.5 py-0.5 text-xs font-medium',
                    PAYER_TONE[invoice.payer_type] ?? PAYER_TONE.cash,
                  )}
                >
                  {invoice.payer_type}
                </span>
                <span className="ms-auto font-semibold tabular-nums">
                  {formatMoney(invoice.total_minor, invoice.currency)}
                </span>
              </div>

              <p className="mt-0.5 text-sm">
                {invoice.patient
                  ? `${invoice.patient.given_names.join(' ')} ${invoice.patient.family_name}`
                  : invoice.patient_id}
                {invoice.patient && (
                  <span className="ms-2 font-mono text-xs text-slate-500">{invoice.patient.mrn}</span>
                )}
              </p>

              <p className="text-xs text-slate-500">
                {invoice.issued_at ? date(invoice.issued_at) : date(invoice.created_at)}
                {invoice.balance_minor > 0 && (
                  <span className="ms-2 font-medium text-amber-700">
                    {t('billing.outstanding')}{' '}
                    {formatMoney(invoice.balance_minor, invoice.currency)}
                  </span>
                )}
              </p>
            </li>
          ))}
        </ul>
      </QueryState>
    </>
  );
}
