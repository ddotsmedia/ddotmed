'use client';

/**
 * The executive dashboard.
 *
 * Mobile-first: the KPI tiles stack into a single column on a phone and the charts
 * fall below them, because on a ward round the numbers are what gets looked at and
 * a chart squeezed into 320px is decoration.
 *
 * Everything refreshes on a sixty-second interval, matching the server-side cache
 * exactly — polling faster would only re-read the same cached payload.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { formatBp, formatMoney } from '@/lib/money';
import {
  keys,
  useAdmissionTrend,
  useClinicalAnalytics,
  useExecutiveKpis,
  useNotifications,
  type AppNotification,
} from '@/lib/queries';
import { PageHeader, QueryState, StatTile } from '@/components/ui';

/** Occupied against free; the ramp is shared with the analytics tabs. */
const OCCUPANCY_FILL = ['#0ea5e9', '#e2e8f0'];
const DIAGNOSIS_FILL = '#8b5cf6';

const SEVERITY_TONE: Record<string, string> = {
  critical: 'border-red-400 bg-red-50 text-red-900',
  warning: 'border-amber-300 bg-amber-50 text-amber-900',
  info: 'border-slate-200 bg-slate-50 text-slate-800',
};

export default function ExecutiveDashboardPage() {
  const { t, date } = useI18n();
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [trendDays, setTrendDays] = useState(7);

  const kpis = useExecutiveKpis();
  const trend = useAdmissionTrend(trendDays);
  const clinical = useClinicalAnalytics(30);
  const alerts = useNotifications({ unacknowledged: 'true' });

  const data = kpis.data;

  const occupancyData = useMemo(
    () =>
      data
        ? [
            { name: 'Occupied', value: data.beds_occupied },
            { name: 'Free', value: Math.max(0, data.beds_total - data.beds_occupied) },
          ]
        : [],
    [data],
  );

  const diagnosisData = useMemo(
    () =>
      (clinical.data?.top_diagnoses ?? []).slice(0, 8).map((d) => ({
        name: d.display ?? d.code,
        code: d.code,
        count: d.count,
      })),
    [clinical.data],
  );

  const acknowledge = useMutation<unknown, Error, string>({
    mutationFn: (id) => api.patch(`/notifications/${id}/acknowledge`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.notifications({ unacknowledged: 'true' }) });
      void queryClient.invalidateQueries({ queryKey: keys.notificationCount() });
    },
  });

  const alertRows: AppNotification[] = (alerts.data ?? []).slice(0, 8);

  return (
    <>
      <PageHeader
        title={t('common.dashboard')}
        subtitle={data ? `Updated ${date(data.generated_at, true)}` : user?.email}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/analytics" className="btn-secondary">
              {t('common.dashboard')}
            </Link>
            <Link href="/reports" className="btn-secondary">
              {t('common.export')}
            </Link>
          </div>
        }
      />

      <QueryState isLoading={kpis.isLoading} error={kpis.error}>
        {data && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <StatTile label="Inpatients" value={data.inpatients_today} hint="currently admitted" />
            <StatTile
              label="Bed occupancy"
              value={`${data.bed_occupancy_pct}%`}
              hint={`${data.beds_occupied}/${data.beds_total}`}
              tone={
                data.bed_occupancy_pct >= 95
                  ? 'critical'
                  : data.bed_occupancy_pct >= 85
                    ? 'warning'
                    : 'ok'
              }
            />
            <StatTile label="OPD visits today" value={data.opd_visits_today} />
            <StatTile
              label="Revenue today"
              value={formatMoney(data.revenue_today_minor, data.revenue_currency)}
              hint="net of refunds"
            />
            <StatTile
              label="Critical labs pending"
              value={data.pending_critical_labs}
              hint="unacknowledged"
              tone={data.pending_critical_labs > 0 ? 'critical' : 'ok'}
            />
            <StatTile
              label="Denial rate MTD"
              value={formatBp(data.denial_rate_mtd)}
              tone={data.denial_rate_mtd >= 1_500 ? 'warning' : 'ok'}
            />
            <StatTile
              label="Average length of stay"
              // Null means nobody has been discharged this month, which is not zero days.
              value={data.avg_los_days === null ? '—' : `${data.avg_los_days} d`}
            />
            <StatTile label="New patients today" value={data.new_patients_today} />
          </div>
        )}
      </QueryState>

      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="card">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Admissions and discharges</h2>
            <select
              className="input w-auto py-1 text-xs"
              value={trendDays}
              onChange={(e) => setTrendDays(Number(e.target.value))}
              aria-label="Trend window"
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
            </select>
          </div>
          <QueryState isLoading={trend.isLoading} error={trend.error}>
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={trend.data?.points ?? []}
                  margin={{ top: 8, right: 8, bottom: 8, left: -16 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v: string) => v.slice(5)}
                  />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="admissions"
                    name="Admissions"
                    stroke="#0ea5e9"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="discharges"
                    name="Discharges"
                    stroke="#14b8a6"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </QueryState>
        </div>

        <div className="card">
          <h2 className="mb-2 font-semibold">Bed occupancy</h2>
          <QueryState isLoading={kpis.isLoading} error={kpis.error}>
            {data && data.beds_total > 0 ? (
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={occupancyData}
                      dataKey="value"
                      nameKey="name"
                      innerRadius="55%"
                      outerRadius="80%"
                      paddingAngle={2}
                    >
                      {occupancyData.map((entry, index) => (
                        <Cell key={entry.name} fill={OCCUPANCY_FILL[index % OCCUPANCY_FILL.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-slate-500">{t('common.noData')}</p>
            )}
          </QueryState>
        </div>
      </section>

      <section className="mt-4 card">
        <h2 className="mb-2 font-semibold">Top diagnoses (30 days)</h2>
        <QueryState
          isLoading={clinical.isLoading}
          error={clinical.error}
          isEmpty={diagnosisData.length === 0}
          emptyMessage={t('common.noData')}
        >
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={diagnosisData}
                layout="vertical"
                margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={120}
                  tick={{ fontSize: 11 }}
                  // Long ICD descriptions are truncated rather than allowed to
                  // squeeze the plot area down to nothing.
                  tickFormatter={(v: string) => (v.length > 18 ? `${v.slice(0, 17)}…` : v)}
                />
                <Tooltip />
                <Bar dataKey="count" name="Cases" fill={DIAGNOSIS_FILL} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </QueryState>
      </section>

      <section className="mt-4 card">
        <h2 className="mb-2 font-semibold">{t('clinical.criticalValue')}</h2>
        <QueryState
          isLoading={alerts.isLoading}
          error={alerts.error}
          isEmpty={alertRows.length === 0}
          emptyMessage="Nothing outstanding."
        >
          <ul className="space-y-2">
            {alertRows.map((alert) => (
              <li
                key={alert.id}
                className={`flex flex-wrap items-start gap-2 rounded-lg border px-3 py-2 ${
                  SEVERITY_TONE[alert.severity] ?? SEVERITY_TONE.info
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{alert.title}</p>
                  <p className="text-xs">{alert.body}</p>
                  <p className="mt-1 text-[10px] opacity-75">
                    {alert.category} · {date(alert.created_at, true)}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-secondary py-1 text-xs"
                  onClick={() => acknowledge.mutate(alert.id)}
                  disabled={acknowledge.isPending}
                >
                  {t('common.confirm')}
                </button>
              </li>
            ))}
          </ul>
        </QueryState>

        {acknowledge.isError && (
          <p className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
            {acknowledge.error.message}
          </p>
        )}
      </section>
    </>
  );
}
