'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useInvoices } from '@/lib/queries';
import { PageHeader, QueryState } from '@/components/ui';

export default function PaymentsPage() {
  const { t, money, date } = useI18n();
  const [page, setPage] = useState(1);

  // Outstanding balances are the working list for a cashier.
  const outstanding = useInvoices({ status: 'partially_paid', page, limit: 25 });
  const issued = useInvoices({ status: 'issued', page: 1, limit: 25 });

  const rows = [...(issued.data?.data ?? []), ...(outstanding.data?.data ?? [])];

  return (
    <>
      <PageHeader title={t('billing.payments')} subtitle={t('billing.balance')} />

      <QueryState
        isLoading={outstanding.isLoading || issued.isLoading}
        error={outstanding.error ?? issued.error}
        isEmpty={rows.length === 0}
      >
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>{t('billing.invoice')}</th>
                <th>{t('billing.dueDate')}</th>
                <th className="text-end">{t('billing.total')}</th>
                <th className="text-end">{t('billing.balance')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => {
                const invoice = i as Record<string, unknown>;
                const currency = String(invoice.currency);
                const overdue =
                  invoice.due_at !== null && new Date(String(invoice.due_at)) < new Date();
                return (
                  <tr key={String(invoice.id)} className={overdue ? 'bg-red-50' : undefined}>
                    <td className="font-mono text-xs">{String(invoice.invoice_number)}</td>
                    <td className="text-xs">
                      {invoice.due_at ? date(String(invoice.due_at)) : '—'}
                      {overdue && (
                        <span className="ms-2 rounded bg-red-600 px-1 text-[10px] text-white">
                          {t('billing.dueDate')}
                        </span>
                      )}
                    </td>
                    <td className="text-end tabular-nums">
                      {money(Number(invoice.total_minor), currency)}
                    </td>
                    <td className="text-end tabular-nums font-semibold">
                      {money(Number(invoice.balance_minor), currency)}
                    </td>
                    <td>
                      <a
                        href={`/invoices/${String(invoice.id)}`}
                        className="text-xs text-sky-700 underline"
                      >
                        {t('billing.payment')}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex justify-end gap-2">
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
            disabled={page >= (outstanding.data?.pages ?? 1)}
            onClick={() => setPage((p) => p + 1)}
          >
            {t('common.next')}
          </button>
        </div>
      </QueryState>
    </>
  );
}
