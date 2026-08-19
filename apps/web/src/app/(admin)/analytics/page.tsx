'use client';

/**
 * Analytics, in three tabs.
 *
 * The date range is owned here and passed down, so switching tabs keeps the
 * period the user chose — a clinical figure and a financial figure over different
 * windows sitting side by side is how two people leave a meeting with different
 * numbers.
 *
 * Only the visible tab's query runs. These are aggregate scans over clinical
 * tables; fetching all three to render one is three times the load for no benefit.
 */

import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
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
import {
  useClinicalAnalytics,
  useFinancialAnalytics,
  useOperationalAnalytics,
} from '@/lib/queries';
import { PageHeader, QueryState, StatTile } from '@/components/ui';

type Tab = 'clinical' | 'financial' | 'operational';

const TAB_LABEL: Record<Tab, string> = {
  clinical: 'Clinical',
  financial: 'Financial',
  operational: 'Operational',
};

/** Aging deepens from green to red as the money gets older. */
const AGING_FILL = ['#10b981', '#f59e0b', '#f97316', '#dc2626'];
const PAYER_FILL = ['#0ea5e9', '#8b5cf6', '#14b8a6', '#f59e0b', '#ec4899'];
const PRESETS = [7, 30, 90] as const;

const isoDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

export default function AnalyticsPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('clinical');
  const [preset, setPreset] = useState<number | 'custom'>(30);
  const [from, setFrom] = useState(() => isoDay(-30));
  const [to, setTo] = useState(() => isoDay(0));

  /**
   * The API takes a window in days rather than two dates, so a custom range is
   * converted to its span. Clamped to at least one day so a same-day range still
   * asks for something.
   */
  const days = useMemo(() => {
    if (preset !== 'custom') return preset;
    const span = Math.round(
      (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000,
    );
    return Math.min(365, Math.max(1, span || 1));
  }, [preset, from, to]);

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle={
          preset === 'custom' ? `${from} to ${to} (${days} days)` : `Last ${days} days`
        }
      />

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Date range">
          {PRESETS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setPreset(option)}
              className={
                preset === option
                  ? 'rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white'
                  : 'rounded bg-slate-100 px-3 py-1.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200'
              }
            >
              {option} days
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPreset('custom')}
            className={
              preset === 'custom'
                ? 'rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white'
                : 'rounded bg-slate-100 px-3 py-1.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200'
            }
          >
            Custom
          </button>
        </div>

        {preset === 'custom' && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              className="input w-auto py-1 text-xs"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              aria-label="From"
            />
            <span className="text-xs text-slate-500">to</span>
            <input
              type="date"
              className="input w-auto py-1 text-xs"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              aria-label="To"
            />
          </div>
        )}
      </div>

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-700">
        {(Object.keys(TAB_LABEL) as Tab[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={
              tab === key
                ? 'whitespace-nowrap border-b-2 border-sky-600 px-3 py-2 text-sm font-semibold text-sky-700 dark:text-sky-300'
                : 'whitespace-nowrap px-3 py-2 text-sm text-slate-600 dark:text-slate-300'
            }
            aria-current={tab === key ? 'page' : undefined}
          >
            {TAB_LABEL[key]}
          </button>
        ))}
      </div>

      {tab === 'clinical' && <ClinicalTab days={days} emptyLabel={t('common.noData')} />}
      {tab === 'financial' && <FinancialTab days={days} emptyLabel={t('common.noData')} />}
      {tab === 'operational' && <OperationalTab days={days} />}
    </>
  );
}

function ClinicalTab({ days, emptyLabel }: { days: number; emptyLabel: string }) {
  const clinical = useClinicalAnalytics(days);
  const data = clinical.data;

  const wardData = useMemo(
    () => (data?.alos_by_ward ?? []).slice(0, 10).map((w) => ({ ...w, name: w.ward })),
    [data],
  );
  const diagnosisData = useMemo(
    () =>
      (data?.top_diagnoses ?? []).slice(0, 10).map((d) => ({
        name: d.display ?? d.code,
        count: d.count,
      })),
    [data],
  );

  return (
    <QueryState isLoading={clinical.isLoading} error={clinical.error}>
      {data && (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="30-day readmission rate"
              value={formatBp(data.readmission_rate_30d.rate_bp)}
              hint={`${data.readmission_rate_30d.readmissions} of ${data.readmission_rate_30d.discharges} discharges`}
              tone={data.readmission_rate_30d.rate_bp >= 1_500 ? 'warning' : 'ok'}
            />
            <StatTile
              label="Active isolation"
              value={data.infection_alerts_active}
              hint="occupied isolation beds"
              tone={data.infection_alerts_active > 0 ? 'warning' : 'ok'}
            />
            <StatTile
              label="Medication errors MTD"
              value={data.medication_error_count_mtd}
              hint="five-rights failures"
              tone={data.medication_error_count_mtd > 0 ? 'critical' : 'ok'}
            />
            <StatTile label="Wards reporting" value={data.alos_by_ward.length} />
          </div>

          <section className="card mb-4">
            <h2 className="mb-2 font-semibold">Average length of stay by ward</h2>
            {wardData.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">{emptyLabel}</p>
            ) : (
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={wardData} margin={{ top: 8, right: 8, bottom: 8, left: -16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-20} textAnchor="end" height={56} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="alos_days" name="Days" fill="#0ea5e9" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          <section className="card">
            <h2 className="mb-2 font-semibold">Top diagnoses</h2>
            {diagnosisData.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">{emptyLabel}</p>
            ) : (
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={diagnosisData} layout="vertical" margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={130}
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v: string) => (v.length > 20 ? `${v.slice(0, 19)}…` : v)}
                    />
                    <Tooltip />
                    <Bar dataKey="count" name="Cases" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>
        </>
      )}
    </QueryState>
  );
}

function FinancialTab({ days, emptyLabel }: { days: number; emptyLabel: string }) {
  const financial = useFinancialAnalytics(days);
  const data = financial.data;
  const currency = data?.currency ?? 'AED';

  // Charts plot major units; every stored figure stays an integer minor unit.
  const toMajor = (minor: number) => minor / 100;

  const agingData = useMemo(
    () =>
      (data?.ar_aging.buckets ?? []).map((b) => ({
        bucket: `${b.bucket} days`,
        outstanding: toMajor(b.balance_minor),
        invoices: b.invoice_count,
      })),
    [data],
  );

  const payerData = useMemo(
    () =>
      (data?.revenue_by_payer ?? []).map((p) => ({
        name: p.payer_type,
        value: toMajor(p.billed_minor),
      })),
    [data],
  );

  const departmentData = useMemo(
    () =>
      (data?.revenue_by_department ?? []).slice(0, 10).map((d) => ({
        name: d.department,
        billed: toMajor(d.billed_minor),
      })),
    [data],
  );

  return (
    <QueryState isLoading={financial.isLoading} error={financial.error}>
      {data && (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Outstanding AR"
              value={formatMoney(data.ar_aging.total_minor, currency)}
              hint={`${formatMoney(data.ar_aging.over90_minor, currency)} over 90 days`}
              tone={data.ar_aging.over90_minor > 0 ? 'warning' : 'ok'}
            />
            <StatTile
              label="Collection rate MTD"
              value={formatBp(data.collection_rate_mtd.rate_bp)}
              hint={`${formatMoney(data.collection_rate_mtd.collected_minor, currency)} of ${formatMoney(
                data.collection_rate_mtd.billed_minor,
                currency,
              )}`}
              tone={data.collection_rate_mtd.rate_bp >= 8_500 ? 'ok' : 'warning'}
            />
            <StatTile
              label="Denial rate MTD"
              value={formatBp(data.denial_rate_mtd.rate_bp)}
              hint={`${data.denial_rate_mtd.denied} of ${data.denial_rate_mtd.responses} responses`}
              tone={data.denial_rate_mtd.rate_bp >= 1_500 ? 'critical' : 'ok'}
            />
            <StatTile
              label="Denied value MTD"
              value={formatMoney(data.denial_rate_mtd.denied_minor, currency)}
            />
          </div>

          <section className="card mb-4">
            <h2 className="mb-2 font-semibold">AR aging</h2>
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={agingData} margin={{ top: 8, right: 8, bottom: 8, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: unknown) => formatMoney(Math.round(Number(v ?? 0) * 100), currency)} />
                  <Bar dataKey="outstanding" name="Outstanding" radius={[4, 4, 0, 0]}>
                    {agingData.map((entry, index) => (
                      <Cell key={entry.bucket} fill={AGING_FILL[index % AGING_FILL.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="mb-4 grid gap-4 lg:grid-cols-2">
            <div className="card">
              <h2 className="mb-2 font-semibold">Revenue by payer (MTD)</h2>
              {payerData.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-500">{emptyLabel}</p>
              ) : (
                <div className="h-56 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={payerData} dataKey="value" nameKey="name" innerRadius="50%" outerRadius="80%" paddingAngle={2}>
                        {payerData.map((entry, index) => (
                          <Cell key={entry.name} fill={PAYER_FILL[index % PAYER_FILL.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v: unknown) => formatMoney(Math.round(Number(v ?? 0) * 100), currency)} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div className="card">
              <h2 className="mb-2 font-semibold">Revenue by department</h2>
              {departmentData.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-500">{emptyLabel}</p>
              ) : (
                <div className="h-56 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={departmentData} layout="vertical" margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 11 }} />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={110}
                        tick={{ fontSize: 11 }}
                        tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
                      />
                      <Tooltip formatter={(v: unknown) => formatMoney(Math.round(Number(v ?? 0) * 100), currency)} />
                      <Bar dataKey="billed" name="Billed" fill="#14b8a6" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </section>

          <section className="card">
            <h2 className="mb-2 font-semibold">Top denial reasons</h2>
            {data.top_denial_reasons.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500">No denials this month.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th className="text-end">Occurrences</th>
                      <th className="text-end">Value denied</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.top_denial_reasons.map((row) => (
                      <tr key={row.code}>
                        <td className="font-mono text-xs">{row.code}</td>
                        <td className="text-end tabular-nums">{row.count}</td>
                        <td className="text-end tabular-nums font-semibold">
                          {formatMoney(row.denied_minor, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </QueryState>
  );
}

function OperationalTab({ days }: { days: number }) {
  const operational = useOperationalAnalytics(days);
  const data = operational.data;

  /** Null means nothing completed in the window, which is not the same as zero. */
  const minutes = (value: number | null) => (value === null ? '—' : `${Math.round(value)} min`);

  return (
    <QueryState isLoading={operational.isLoading} error={operational.error}>
      {data && (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <StatTile
              label="Average OPD wait"
              value={minutes(data.avg_wait_minutes_opd)}
              hint="queue join to called, today"
              tone={
                data.avg_wait_minutes_opd !== null && data.avg_wait_minutes_opd > 45
                  ? 'warning'
                  : 'ok'
              }
            />
            <StatTile
              label="Bed turnover"
              value={data.bed_turnover_rate}
              hint={`${data.discharges_in_period} discharges over ${days} days`}
            />
            <StatTile
              label="Discharge delays"
              value={data.discharge_delay_count}
              hint="past expected discharge, still in a bed"
              tone={data.discharge_delay_count > 0 ? 'warning' : 'ok'}
            />
            <StatTile
              label="Theatre occupancy"
              value={`${data.ot_utilisation_pct}%`}
              hint={`${data.ot_beds_total} theatre bay${data.ot_beds_total === 1 ? '' : 's'}`}
            />
            <StatTile label="Lab turnaround" value={minutes(data.lab_tat_avg_minutes)} hint="order to result" />
            <StatTile
              label="Radiology turnaround"
              value={minutes(data.radiology_tat_avg_minutes)}
              hint="order to study complete"
            />
          </div>

          <section className="card">
            <h2 className="mb-2 font-semibold">Flow</h2>
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={[
                    { name: 'OPD wait (min)', value: data.avg_wait_minutes_opd ?? 0 },
                    { name: 'Lab TAT (min)', value: data.lab_tat_avg_minutes ?? 0 },
                    { name: 'Radiology TAT (min)', value: data.radiology_tat_avg_minutes ?? 0 },
                  ]}
                  margin={{ top: 8, right: 8, bottom: 8, left: -8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="value" name="Minutes" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              A bar reading zero means nothing completed in the window, not an instant turnaround —
              the tiles above show those as an em dash.
            </p>
          </section>
        </>
      )}
    </QueryState>
  );
}
