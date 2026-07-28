'use client';

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';

interface TimelineEntry {
  id: string;
  type: string;
  at: string;
  title: string;
  detail: string | null;
  severity: 'normal' | 'warning' | 'critical';
  encounter_id: string | null;
}

const TYPE_ICON: Record<string, string> = {
  encounter: '🏥',
  condition: '🩺',
  medication: '💊',
  lab: '🧪',
  imaging: '📷',
  note: '📝',
  vitals: '📈',
  admission: '🛏',
};

const SEVERITY_STYLE: Record<TimelineEntry['severity'], string> = {
  critical: 'border-s-red-500',
  warning: 'border-s-amber-500',
  normal: 'border-s-slate-300 dark:border-s-slate-600',
};

/**
 * Chart history beside the note being written.
 *
 * Defaults to this encounter and expands to the whole record on request — the
 * question during a consultation is almost always "what happened today", and
 * showing years of history first buries it.
 */
export function ClinicalTimeline({
  patientId,
  encounterId,
}: {
  patientId: string;
  encounterId: string;
}) {
  const { t, date } = useI18n();
  const [scope, setScope] = useState<'encounter' | 'all'>('encounter');

  const timeline = useQuery<TimelineEntry[]>({
    queryKey: ['patient', patientId, 'timeline', 'encounter-sidebar'],
    queryFn: () => api.get<TimelineEntry[]>(`/patients/${patientId}/timeline`, { limit: 200 }),
    enabled: Boolean(patientId),
  });

  const entries = useMemo(() => {
    const all = timeline.data ?? [];
    return scope === 'all' ? all : all.filter((entry) => entry.encounter_id === encounterId);
  }, [timeline.data, scope, encounterId]);

  return (
    <section className="card" aria-label={t('clinical.clinicalTimeline')}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{t('clinical.clinicalTimeline')}</h3>
        <div className="ms-auto flex gap-1 text-xs">
          {(['encounter', 'all'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setScope(option)}
              className={clsx(
                'rounded px-2 py-0.5 font-medium',
                scope === option
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
              )}
            >
              {option === 'encounter' ? t('clinical.encounter') : t('common.all')}
            </button>
          ))}
        </div>
      </div>

      {timeline.isLoading && <p className="text-sm text-slate-500">{t('common.loading')}</p>}
      {!timeline.isLoading && entries.length === 0 && (
        <p className="text-sm text-slate-500">{t('common.noData')}</p>
      )}

      <ol className="max-h-[32rem] space-y-2 overflow-y-auto">
        {entries.map((entry) => (
          <li
            key={`${entry.type}-${entry.id}`}
            className={clsx('border-s-2 ps-2', SEVERITY_STYLE[entry.severity])}
          >
            <p className="flex items-baseline gap-1 text-sm">
              <span aria-hidden>{TYPE_ICON[entry.type] ?? '•'}</span>
              <span className="font-medium">{entry.title}</span>
            </p>
            {entry.detail && <p className="text-xs text-slate-600 dark:text-slate-300">{entry.detail}</p>}
            <p className="text-xs text-slate-500">{date(entry.at, true)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
