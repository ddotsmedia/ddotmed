'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import clsx from 'clsx';
import { ApiError } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { keys, useApiMutation, useDispenseQueue, type DispenseQueueEntry } from '@/lib/queries';
import { PageHeader, QueryState, Field } from '@/components/ui';
import { DispenseSheet } from '@/components/pharmacy/DispenseSheet';

const PRIORITY_TONE: Record<string, string> = {
  urgent: 'bg-red-600 text-white',
  high: 'bg-amber-200 text-amber-900',
  routine: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
};

function DispenseQueueInner() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const search = useSearchParams();

  const [locationId, setLocationId] = useState(search.get('locationId') ?? '');
  const [selected, setSelected] = useState<DispenseQueueEntry | null>(null);

  const queue = useDispenseQueue(locationId || undefined);

  const dispense = useApiMutation<Record<string, unknown>, Record<string, unknown>>(
    '/pharmacy/dispense',
    [keys.dispenseQueue(locationId || undefined), keys.pharmacyQueue()],
  );

  const error = dispense.error instanceof ApiError ? dispense.error : null;

  return (
    <>
      <PageHeader
        title={t('clinical.dispenseQueue')}
        subtitle={queue.data ? `${queue.data.length}` : undefined}
      />

      <Field label={t('clinical.ward')}>
        <input
          className="input mb-4"
          value={locationId}
          placeholder="Location id (all locations if blank)"
          onChange={(e) => setLocationId(e.target.value.trim())}
        />
      </Field>

      <QueryState
        isLoading={queue.isLoading}
        error={queue.error}
        isEmpty={queue.data?.length === 0}
        emptyMessage={t('common.noData')}
      >
        {/* Cards, not a table: this screen is read on a phone at the counter. */}
        <ul className="space-y-2">
          {queue.data?.map((entry) => (
            <li
              key={entry.id}
              className={clsx(
                'card',
                entry.queue_priority === 'urgent' && 'border-2 border-red-500',
                entry.is_controlled && 'border-amber-400',
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={clsx(
                    'rounded px-1.5 py-0.5 text-xs font-bold uppercase',
                    PRIORITY_TONE[entry.queue_priority] ?? PRIORITY_TONE.routine,
                  )}
                >
                  {entry.queue_priority}
                </span>
                {entry.is_controlled && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900">
                    {t('clinical.controlledDrug')} {entry.controlled_schedule}
                  </span>
                )}
                <span className="ms-auto text-xs text-slate-500">
                  {t('clinical.waiting')} {entry.waiting_minutes}m
                </span>
              </div>

              <p className="mt-1 font-semibold">
                {entry.patient.given_names.join(' ')} {entry.patient.family_name}{' '}
                <span className="font-mono text-xs font-normal text-slate-500">
                  {entry.patient.mrn}
                </span>
              </p>
              <p className="text-sm">{entry.code_display}</p>
              <p className="text-xs text-slate-600 dark:text-slate-300">
                {String(entry.dose_quantity)} {entry.dose_unit} · {entry.route} · {entry.frequency} ·{' '}
                {entry.quantity} {t('clinical.quantity').toLowerCase()}
              </p>
              <p className="text-xs text-slate-500">{entry.queue_reason}</p>

              {can('medication:dispense') && (
                <button
                  type="button"
                  className="btn-primary mt-2 w-full sm:w-auto"
                  onClick={() => {
                    dispense.reset();
                    setSelected(entry);
                  }}
                >
                  {t('clinical.dispense')}
                </button>
              )}
            </li>
          ))}
        </ul>
      </QueryState>

      {selected && (
        <DispenseSheet
          entry={selected}
          pending={dispense.isPending}
          error={error}
          result={dispense.data ?? null}
          onClose={() => {
            setSelected(null);
            dispense.reset();
          }}
          onSubmit={(body) => dispense.mutate({ medication_id: selected.id, ...body })}
        />
      )}
    </>
  );
}

export default function DispenseQueuePage() {
  return (
    <Suspense fallback={null}>
      <DispenseQueueInner />
    </Suspense>
  );
}
