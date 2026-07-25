'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useBedBoard, useCriticalResults, useNurseRatios, usePharmacyQueue } from '@/lib/queries';
import { PageHeader, QueryState, StatTile } from '@/components/ui';

interface AiBriefing {
  headline: string;
  bullets: string[];
  generated_at: string;
  low_confidence: boolean;
}

export default function DashboardPage() {
  const { t, date } = useI18n();
  const { user } = useSession();

  const beds = useBedBoard();
  const critical = useCriticalResults();
  const pharmacy = usePharmacyQueue();
  const ratios = useNurseRatios();

  // The AI briefing is decorative relative to the clinical tiles — if it fails,
  // the dashboard still renders everything that matters.
  const briefing = useQuery<AiBriefing>({
    queryKey: ['ai', 'briefing'],
    queryFn: () => api.get<AiBriefing>('/analytics/daily-briefing'),
    retry: false,
    staleTime: 15 * 60_000,
  });

  const totals = beds.data?.totals;
  const occupancy = totals?.total ? Math.round((totals.occupied / totals.total) * 100) : 0;
  const breaching = (ratios.data?.breaching as unknown[] | undefined)?.length ?? 0;

  return (
    <>
      <PageHeader
        title={t('common.dashboard')}
        subtitle={user ? `${user.email} — ${user.roles.join(', ')}` : undefined}
      />

      <QueryState isLoading={beds.isLoading} error={beds.error}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile
            label={t('clinical.bed')}
            value={`${occupancy}%`}
            hint={`${totals?.occupied ?? 0}/${totals?.total ?? 0}`}
            tone={occupancy >= 95 ? 'critical' : occupancy >= 85 ? 'warning' : 'ok'}
          />
          <StatTile
            label={t('clinical.criticalValue')}
            value={critical.data?.length ?? 0}
            tone={(critical.data?.length ?? 0) > 0 ? 'critical' : 'ok'}
          />
          <StatTile label={t('clinical.dispense')} value={pharmacy.data?.length ?? 0} />
          <StatTile
            label={t('clinical.ward')}
            value={breaching}
            hint={t('clinical.patient')}
            tone={breaching > 0 ? 'warning' : 'ok'}
          />
          <StatTile label={t('clinical.patients')} value={totals?.occupied ?? 0} />
        </div>
      </QueryState>

      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="mb-2 font-semibold">{t('clinical.aiDraft')}</h2>
          {briefing.isLoading && <p className="text-sm text-slate-500">{t('common.loading')}</p>}
          {briefing.isError && <p className="text-sm text-slate-500">{t('common.noData')}</p>}
          {briefing.data && (
            <>
              {briefing.data.low_confidence && (
                <p className="mb-2 rounded bg-amber-100 px-2 py-1 text-xs text-amber-900">
                  {t('clinical.lowConfidence')}
                </p>
              )}
              <p className="text-sm font-medium">{briefing.data.headline}</p>
              <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-slate-700 dark:text-slate-300">
                {briefing.data.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-slate-500">{date(briefing.data.generated_at, true)}</p>
            </>
          )}
        </div>

        <div className="card">
          <h2 className="mb-2 font-semibold">{t('clinical.ward')}</h2>
          <QueryState
            isLoading={beds.isLoading}
            error={beds.error}
            isEmpty={(beds.data?.wards.length ?? 0) === 0}
          >
            <table className="table">
              <thead>
                <tr>
                  <th>{t('clinical.ward')}</th>
                  <th>{t('clinical.bed')}</th>
                  <th>%</th>
                </tr>
              </thead>
              <tbody>
                {beds.data?.wards.map((w) => (
                  <tr key={w.ward}>
                    <td>{w.ward}</td>
                    <td className="tabular-nums">
                      {w.occupied}/{w.total}
                    </td>
                    <td className="tabular-nums font-semibold">{w.occupancy_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </QueryState>
        </div>
      </section>

      <section className="mt-4 card">
        <h2 className="mb-2 font-semibold">{t('clinical.criticalValue')}</h2>
        <QueryState
          isLoading={critical.isLoading}
          error={critical.error}
          isEmpty={(critical.data?.length ?? 0) === 0}
          emptyMessage={t('common.noData')}
        >
          <table className="table">
            <thead>
              <tr>
                <th>{t('clinical.patient')}</th>
                <th>{t('clinical.labResults')}</th>
                <th>{t('common.date')}</th>
              </tr>
            </thead>
            <tbody>
              {critical.data?.map((r) => {
                const row = r as Record<string, unknown>;
                const patient = row.patient as { mrn?: string; family_name?: string } | undefined;
                return (
                  <tr key={String(row.id)} className="bg-red-50">
                    <td>
                      {patient?.family_name} <span className="font-mono text-xs">{patient?.mrn}</span>
                    </td>
                    <td className="font-semibold">
                      {String(row.display)}: {String(row.value_quantity ?? row.value_string ?? '')}{' '}
                      {String(row.unit ?? '')}
                    </td>
                    <td className="text-xs">{date(String(row.performed_at), true)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </QueryState>
      </section>
    </>
  );
}
