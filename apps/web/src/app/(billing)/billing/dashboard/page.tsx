'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useI18n } from '@/lib/i18n';
import { formatBp, formatMoney } from '@/lib/money';
import { useBillingDashboard } from '@/lib/queries';
import { PageHeader, QueryState, StatTile } from '@/components/ui';

/**
 * Aging deepens from green to red as the money gets older; payer slices reuse the
 * same ramp so the two charts read as one system.
 */
const AGING_FILL = ['#10b981', '#f59e0b', '#f97316', '#dc2626'];
const PAYER_FILL = ['#0ea5e9', '#8b5cf6', '#14b8a6', '#f59e0b'];

/** Recharts hands the formatter a widened value; narrow it back before formatting. */
const majorToMoney = (currency: string) => (value: unknown) =>
  formatMoney(Math.round(Number(value ?? 0) * 100), currency);

export default function BillingDashboardPage() {
  const { t, date } = useI18n();
  const dashboard = useBillingDashboard();
  const data = dashboard.data;

  // Charts plot major units; every stored figure stays an integer minor unit.
  const currency = 'AED';
  const toMajor = (minor: number) => minor / 100;

  const agingData = useMemo(
    () =>
      (data?.aging.buckets ?? []).map((bucket) => ({
        bucket: `${bucket.bucket} days`,
        outstanding: toMajor(bucket.balance_minor),
        invoices: bucket.invoice_count,
        raw: bucket.balance_minor,
      })),
    [data],
  );

  const payerData = useMemo(
    () =>
      (data?.revenue_by_payer ?? []).map((row) => ({
        name: row.payer_type,
        value: toMajor(row.billed_minor),
        raw: row.billed_minor,
      })),
    [data],
  );

  return (
    <>
      <PageHeader
        title={t('billing.arAging')}
        subtitle={data ? date(data.period_start) : undefined}
        actions={
          <Link href="/invoices" className="btn-secondary">
            {t('billing.invoices')}
          </Link>
        }
      />

      <QueryState isLoading={dashboard.isLoading} error={dashboard.error}>
        {data && (
          <>
            <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
              <StatTile
                label={t('billing.outstanding')}
                value={formatMoney(data.aging.total_outstanding_minor, currency)}
                tone={data.aging.total_outstanding_minor > 0 ? 'warning' : 'ok'}
              />
              <StatTile
                label="90+"
                value={formatMoney(data.aging.over_90_minor, currency)}
                tone={data.aging.over_90_minor > 0 ? 'critical' : 'ok'}
              />
              <StatTile
                label={t('billing.collectionRate')}
                value={formatBp(data.collection.rate_bp)}
                hint={formatMoney(data.collection.collected_minor, currency)}
                tone={data.collection.rate_bp >= 8_000 ? 'ok' : 'warning'}
              />
              <StatTile
                label={t('billing.denialRateLabel')}
                value={formatBp(data.denials.rate_bp)}
                hint={`${data.denials.denied}/${data.denials.responses}`}
                tone={data.denials.rate_bp > 1_000 ? 'critical' : 'ok'}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <section className="card">
                <h2 className="mb-2 font-semibold">{t('billing.arAging')}</h2>
                {/* Fixed height: a responsive container needs one to lay out at all. */}
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={agingData} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                      <XAxis dataKey="bucket" fontSize={11} tickLine={false} />
                      <YAxis fontSize={11} tickLine={false} width={56} />
                      <Tooltip formatter={majorToMoney(currency)} />
                      <Bar dataKey="outstanding" radius={[4, 4, 0, 0]}>
                        {agingData.map((entry, index) => (
                          <Cell key={entry.bucket} fill={AGING_FILL[index] ?? AGING_FILL[3]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <ul className="mt-2 space-y-0.5 text-xs text-slate-600 dark:text-slate-300">
                  {data.aging.buckets.map((bucket) => (
                    <li key={bucket.bucket} className="flex justify-between">
                      <span>
                        {bucket.bucket} · {bucket.invoice_count}
                      </span>
                      <span className="tabular-nums">
                        {formatMoney(bucket.balance_minor, currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="card">
                <h2 className="mb-2 font-semibold">{t('billing.revenueByPayer')}</h2>
                {payerData.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('common.noData')}</p>
                ) : (
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={payerData}
                          dataKey="value"
                          nameKey="name"
                          innerRadius="45%"
                          outerRadius="75%"
                          paddingAngle={2}
                        >
                          {payerData.map((entry, index) => (
                            <Cell key={entry.name} fill={PAYER_FILL[index % PAYER_FILL.length]} />
                          ))}
                        </Pie>
                        <Legend />
                        <Tooltip formatter={majorToMoney(currency)} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                )}
                <ul className="mt-2 space-y-0.5 text-xs text-slate-600 dark:text-slate-300">
                  {data.revenue_by_payer.map((row) => (
                    <li key={row.payer_type} className="flex justify-between">
                      <span>
                        {row.payer_type} · {row.invoice_count}
                      </span>
                      <span className="tabular-nums">
                        {formatMoney(row.collected_minor, currency)} /{' '}
                        {formatMoney(row.billed_minor, currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="card lg:col-span-2">
                <h2 className="mb-2 font-semibold">{t('billing.topDenials')}</h2>
                {data.top_denial_reasons.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('common.noData')}</p>
                ) : (
                  <ul className="space-y-1">
                    {data.top_denial_reasons.map((reason) => (
                      <li
                        key={reason.code}
                        className="flex flex-wrap items-center gap-2 rounded border border-slate-200 px-2 py-1 text-sm dark:border-slate-700"
                      >
                        <span className="font-mono font-semibold">{reason.code}</span>
                        <span className="text-xs text-slate-500">×{reason.count}</span>
                        <span className="ms-auto font-semibold tabular-nums text-red-700">
                          {formatMoney(reason.denied_minor, currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        )}
      </QueryState>
    </>
  );
}
