'use client';

import { useMemo } from 'react';
import clsx from 'clsx';
import { useI18n } from '@/lib/i18n';
import { useLabResultsFor, type LabResultRow, type ResultTrend } from '@/lib/queries';
import { QueryState } from '@/components/ui';
import { ResultFlag, Sparkline } from '@/components/lab/Sparkline';

const DELTA_ARROW: Record<string, string> = { up: '▲', down: '▼', flat: '▬' };

/**
 * Results grouped by the visit they belong to, newest visit first.
 *
 * A panel drawn at one blood draw is read together — a sodium means something
 * different alongside a rising creatinine than it does on its own — so the
 * grouping follows the encounter rather than the test.
 */
function groupByVisit(results: readonly LabResultRow[]): Array<{
  key: string;
  encounterId: string | null;
  at: string;
  rows: LabResultRow[];
}> {
  const groups = new Map<string, { encounterId: string | null; at: string; rows: LabResultRow[] }>();

  for (const row of results) {
    // Results with no encounter are bucketed by the day they were performed,
    // which is how a walk-in phlebotomy draw reaches the chart.
    const key = row.encounter_id ?? `day:${row.performed_at.slice(0, 10)}`;
    const group = groups.get(key);
    if (group) {
      group.rows.push(row);
      if (row.performed_at > group.at) group.at = row.performed_at;
    } else {
      groups.set(key, { encounterId: row.encounter_id, at: row.performed_at, rows: [row] });
    }
  }

  return [...groups.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export function LabResultsTab({ patientId }: { patientId: string }) {
  const { t, date } = useI18n();
  const query = useLabResultsFor(patientId);

  const visits = useMemo(() => groupByVisit(query.data?.results ?? []), [query.data]);
  const trends = (query.data?.trends ?? []) as ResultTrend[];
  const trendByCode = useMemo(
    () => new Map(trends.map((trend) => [trend.loinc_code, trend])),
    [trends],
  );

  if (!patientId) {
    return <p className="card text-sm text-slate-500">{t('common.noData')}</p>;
  }

  return (
    <div className="space-y-4">
      {/* Trends first: the shape of the last five values is what changes a decision. */}
      <section className="card">
        <h2 className="mb-2 font-semibold">{t('clinical.trend')}</h2>
        <QueryState
          isLoading={query.isLoading}
          error={query.error}
          isEmpty={trends.length === 0}
          emptyMessage={t('common.noData')}
        >
          <ul className="space-y-2">
            {trends.map((trend) => (
              <li
                key={trend.loinc_code}
                className={clsx(
                  'flex flex-wrap items-center gap-3 rounded border p-2',
                  trend.has_critical
                    ? 'border-red-400 bg-red-50 dark:bg-red-950/30'
                    : 'border-slate-200 dark:border-slate-700',
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{trend.display}</p>
                  <p className="text-xs text-slate-500">
                    {trend.reference_low ?? '—'}–{trend.reference_high ?? '—'} {trend.unit ?? ''}
                  </p>
                </div>

                <Sparkline
                  points={trend.points}
                  referenceLow={trend.reference_low}
                  referenceHigh={trend.reference_high}
                />

                <div className="text-end">
                  <p className="text-sm font-bold tabular-nums">
                    {trend.latest.value ?? trend.latest.value_string ?? '—'}{' '}
                    <span className="text-xs font-normal opacity-70">{trend.unit}</span>{' '}
                    <ResultFlag interpretation={trend.latest.interpretation} />
                  </p>
                  {trend.delta !== null && trend.direction && (
                    <p
                      className={clsx(
                        'text-xs tabular-nums',
                        trend.direction === 'flat' ? 'text-slate-500' : 'text-slate-700 dark:text-slate-300',
                      )}
                    >
                      {DELTA_ARROW[trend.direction]} {trend.delta > 0 ? '+' : ''}
                      {trend.delta}
                    </p>
                  )}
                  <p className="text-xs text-slate-500">{date(trend.latest.performed_at, true)}</p>
                </div>
              </li>
            ))}
          </ul>
        </QueryState>
      </section>

      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={visits.length === 0}
        emptyMessage={t('common.noData')}
      >
        <div className="space-y-4">
          {visits.map((visit) => {
            const hasCritical = visit.rows.some((row) => row.is_critical);
            return (
              <section
                key={visit.key}
                className={clsx('card', hasCritical && 'border-2 border-red-500')}
              >
                {hasCritical && (
                  <p
                    className="-m-4 mb-3 rounded-t bg-red-600 px-3 py-1.5 text-sm font-bold text-white"
                    role="alert"
                  >
                    ⛔ {t('clinical.criticalValue')}
                  </p>
                )}

                <h3 className="mb-2 text-sm font-semibold">
                  {date(visit.at, true)}
                  {visit.encounterId && (
                    <span className="ms-2 font-normal text-slate-500">{t('clinical.encounter')}</span>
                  )}
                </h3>

                <div className="overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('clinical.labResults')}</th>
                        <th className="text-end">{t('common.unit')}</th>
                        <th>{t('clinical.referenceRange')}</th>
                        <th>{t('clinical.trend')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visit.rows.map((row) => {
                        const trend = trendByCode.get(row.loinc_code);
                        return (
                          <tr key={row.id} className={clsx(row.is_critical && 'bg-red-50')}>
                            <td>
                              <span className={clsx(row.is_critical && 'font-bold text-red-800')}>
                                {row.display}
                              </span>
                            </td>
                            <td className="text-end tabular-nums">
                              <span
                                className={clsx(
                                  'font-semibold',
                                  row.interpretation === 'H' || row.interpretation === 'HH'
                                    ? 'text-red-700'
                                    : row.interpretation === 'L' || row.interpretation === 'LL'
                                      ? 'text-sky-700'
                                      : '',
                                )}
                              >
                                {row.value_quantity ?? row.value_string ?? '—'}
                              </span>{' '}
                              <span className="text-xs opacity-70">{row.unit}</span>{' '}
                              <ResultFlag interpretation={row.interpretation} />
                            </td>
                            <td className="text-xs text-slate-500">
                              {row.reference_low ?? '—'}–{row.reference_high ?? '—'}
                            </td>
                            <td>{trend && <Sparkline points={trend.points} />}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
        </div>
      </QueryState>
    </div>
  );
}
