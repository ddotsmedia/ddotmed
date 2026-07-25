'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { useInvoices } from '@/lib/queries';
import { PageHeader, QueryState } from '@/components/ui';

const STATUS_TONE: Record<string, string> = {
  paid: 'bg-emerald-100 text-emerald-800',
  partially_paid: 'bg-amber-100 text-amber-800',
  overdue: 'bg-red-100 text-red-800',
  cancelled: 'bg-slate-200 text-slate-700',
  written_off: 'bg-slate-200 text-slate-700',
};

export default function InvoicesPage() {
  const { t, date, money } = useI18n();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  const invoices = useInvoices({ status: status || undefined, page, limit: 25 });

  return (
    <>
      <PageHeader
        title={t('billing.invoices')}
        actions={
          <select
            className="input w-auto"
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value);
            }}
          >
            <option value="">{t('common.all')}</option>
            {['draft', 'issued', 'partially_paid', 'paid', 'overdue', 'cancelled'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        }
      />

      <QueryState
        isLoading={invoices.isLoading}
        error={invoices.error}
        isEmpty={invoices.data?.data.length === 0}
      >
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>{t('billing.invoice')}</th>
                <th>{t('common.date')}</th>
                <th className="text-end">{t('billing.total')}</th>
                <th className="text-end">{t('billing.paid')}</th>
                <th className="text-end">{t('billing.balance')}</th>
                <th>{t('common.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invoices.data?.data.map((i) => {
                const invoice = i as Record<string, unknown>;
                const currency = String(invoice.currency);
                const invoiceStatus = String(invoice.status);
                return (
                  <tr key={String(invoice.id)}>
                    <td className="font-mono text-xs">{String(invoice.invoice_number)}</td>
                    <td className="text-xs">
                      {invoice.issued_at ? date(String(invoice.issued_at)) : '—'}
                    </td>
                    <td className="text-end tabular-nums font-medium">
                      {money(Number(invoice.total_minor), currency)}
                    </td>
                    <td className="text-end tabular-nums">
                      {money(Number(invoice.paid_minor), currency)}
                    </td>
                    <td className="text-end tabular-nums font-semibold">
                      {money(Number(invoice.balance_minor), currency)}
                    </td>
                    <td>
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${STATUS_TONE[invoiceStatus] ?? 'bg-slate-100'}`}
                      >
                        {invoiceStatus}
                      </span>
                    </td>
                    <td>
                      <Link
                        href={`/invoices/${String(invoice.id)}`}
                        className="text-xs text-sky-700 underline"
                      >
                        {t('common.print')}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="text-slate-600">
            {invoices.data?.total ?? 0} — {invoices.data?.page}/{invoices.data?.pages}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              {t('common.back')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={page >= (invoices.data?.pages ?? 1)}
              onClick={() => setPage((p) => p + 1)}
            >
              {t('common.next')}
            </button>
          </div>
        </div>
      </QueryState>
    </>
  );
}
