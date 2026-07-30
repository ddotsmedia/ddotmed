'use client';

import Link from 'next/link';
import clsx from 'clsx';
import { useI18n } from '@/lib/i18n';
import { useLabResultsFor, useServiceRequests, type LabOrder } from '@/lib/queries';
import { QueryState } from '@/components/ui';
import { ResultFlag, Sparkline } from '@/components/lab/Sparkline';

const OPEN_STATUSES = new Set(['draft', 'active', 'on_hold']);

/**
 * Lab at a glance inside the consultation.
 *
 * Two questions get asked in a consultation — what am I still waiting for, and
 * what has come back — so those are the two things shown, and everything else is
 * a link to the lab screen.
 */
export function EncounterLabs({
  patientId,
  encounterId,
}: {
  patientId: string;
  encounterId: string;
}) {
  const { t, date } = useI18n();

  const orders = useServiceRequests({ encounterId, category: 'laboratory' });
  const results = useLabResultsFor(patientId);

  const pending = ((orders.data ?? []) as LabOrder[]).filter((o) => OPEN_STATUSES.has(o.status));
  const trends = (results.data?.trends ?? []).slice(0, 5);
  const anyCritical = trends.some((trend) => trend.has_critical);

  return (
    <section className={clsx('card', anyCritical && 'border-2 border-red-500')}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{t('clinical.labResults')}</h3>
        <Link
          href={`/lab?patientId=${patientId}&encounterId=${encounterId}`}
          className="btn-secondary ms-auto py-1 text-xs"
        >
          + {t('clinical.newLabOrder')}
        </Link>
      </div>

      <QueryState isLoading={orders.isLoading} error={orders.error}>
        {pending.length > 0 ? (
          <>
            <p className="label mb-1">{t('clinical.pendingOrders')}</p>
            <ul className="mb-3 space-y-1">
              {pending.map((order) => (
                <li key={order.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{order.code_display}</span>
                  {order.priority !== 'routine' && (
                    <span
                      className={clsx(
                        'rounded px-1.5 py-0.5 text-xs font-semibold',
                        order.priority === 'stat' ? 'bg-red-600 text-white' : 'bg-amber-200 text-amber-900',
                      )}
                    >
                      {order.priority}
                    </span>
                  )}
                  {order.fasting_required && (
                    <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-900">
                      {t('clinical.fastingRequired')}
                    </span>
                  )}
                  <span className="ms-auto font-mono text-xs text-slate-500">{order.barcode}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mb-3 text-sm text-slate-500">{t('common.noData')}</p>
        )}
      </QueryState>

      <QueryState isLoading={results.isLoading} error={results.error}>
        {trends.length > 0 && (
          <>
            <p className="label mb-1">{t('clinical.recentResults')}</p>
            <ul className="space-y-1">
              {trends.map((trend) => (
                <li
                  key={trend.loinc_code}
                  className={clsx(
                    'flex flex-wrap items-center gap-2 rounded px-1 text-sm',
                    trend.has_critical && 'bg-red-50 dark:bg-red-950/30',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{trend.display}</span>
                  <Sparkline
                    points={trend.points}
                    referenceLow={trend.reference_low}
                    referenceHigh={trend.reference_high}
                  />
                  <span className="tabular-nums font-semibold">
                    {trend.latest.value ?? trend.latest.value_string ?? '—'}
                  </span>
                  <ResultFlag interpretation={trend.latest.interpretation} />
                  <span className="w-full text-xs text-slate-500 sm:w-auto">
                    {date(trend.latest.performed_at, true)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </QueryState>
    </section>
  );
}
