'use client';

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import clsx from 'clsx';
import { ApiError } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { keys, useApiMutation, useBedList, type BedRow } from '@/lib/queries';
import { PageHeader, QueryState, StatTile } from '@/components/ui';
import { AdmitSheet } from '@/components/beds/AdmitSheet';
import { BedActionsSheet } from '@/components/beds/BedActionsSheet';

const TONE_STYLE: Record<BedRow['tone'], string> = {
  available: 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30',
  occupied: 'border-sky-400 bg-sky-50 dark:bg-sky-950/30',
  dirty: 'border-amber-400 bg-amber-50 dark:bg-amber-950/30',
  isolation: 'border-red-500 bg-red-50 dark:bg-red-950/40',
  blocked: 'border-slate-400 bg-slate-100 dark:bg-slate-800',
};

const TONE_DOT: Record<BedRow['tone'], string> = {
  available: 'bg-emerald-500',
  occupied: 'bg-sky-500',
  dirty: 'bg-amber-500',
  isolation: 'bg-red-600',
  blocked: 'bg-slate-500',
};

function BedBoardInner() {
  const { t, date } = useI18n();
  const { can } = usePermissions();
  const search = useSearchParams();

  const [ward, setWard] = useState(search.get('ward') ?? '');
  const [selected, setSelected] = useState<BedRow | null>(null);
  const [admitting, setAdmitting] = useState<BedRow | null>(null);

  const params = { ward: ward || undefined };
  const beds = useBedList(params);

  const invalidate = [keys.bedList(params), keys.admissions({ status: 'active' })];

  const admit = useApiMutation<Record<string, unknown>, Record<string, unknown>>(
    '/admissions',
    invalidate,
  );
  const transfer = useApiMutation<Record<string, unknown>, unknown>(
    (body) => `/admissions/${body.admissionId as string}/transfer`,
    invalidate,
  );
  const discharge = useApiMutation<Record<string, unknown>, unknown>(
    (body) => `/admissions/${body.admissionId as string}/discharge`,
    invalidate,
  );
  const housekeeping = useApiMutation<{ bedId: string; housekeeping_status: string }, unknown>(
    (body) => `/beds/${body.bedId}/housekeeping`,
    invalidate,
    'patch',
  );

  const rows = beds.data ?? [];

  // Ward names come from the beds themselves; there is no separate ward registry.
  const wards = useMemo(
    () => [...new Set((beds.data ?? []).map((b) => b.ward))].sort(),
    [beds.data],
  );

  const totals = useMemo(() => {
    const counts = { total: rows.length, available: 0, occupied: 0, dirty: 0, isolation: 0, overdue: 0 };
    for (const bed of rows) {
      if (bed.admittable) counts.available += 1;
      if (bed.status === 'occupied') counts.occupied += 1;
      if (bed.tone === 'dirty') counts.dirty += 1;
      if (bed.isolation_flag) counts.isolation += 1;
      if (bed.admission?.overdue) counts.overdue += 1;
    }
    return counts;
  }, [rows]);

  return (
    <>
      <PageHeader
        title={t('clinical.bedBoard')}
        actions={
          <Link href="/admissions" className="btn-secondary">
            {t('clinical.admissions')}
          </Link>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <StatTile label={t('clinical.available')} value={totals.available} tone="ok" />
        <StatTile label={t('clinical.occupied')} value={totals.occupied} />
        <StatTile label={t('clinical.housekeeping')} value={totals.dirty} tone="warning" />
        <StatTile label={t('clinical.isolation')} value={totals.isolation} tone="critical" />
        <StatTile label={t('clinical.overdue')} value={totals.overdue} tone="warning" />
      </div>

      <label className="mb-4 block">
        <span className="label">{t('clinical.ward')}</span>
        <select className="input" value={ward} onChange={(e) => setWard(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {wards.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <QueryState
        isLoading={beds.isLoading}
        error={beds.error}
        isEmpty={rows.length === 0}
        emptyMessage={t('clinical.noBeds')}
      >
        {/* Two columns on a phone, up to six on a desk. */}
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {rows.map((bed) => (
            <li key={bed.id}>
              <button
                type="button"
                className={clsx(
                  'w-full rounded border-2 p-2 text-start text-sm',
                  TONE_STYLE[bed.tone],
                )}
                onClick={() => {
                  admit.reset();
                  transfer.reset();
                  discharge.reset();
                  if (bed.admission) setSelected(bed);
                  else if (bed.admittable && can('adt:manage')) setAdmitting(bed);
                  else setSelected(bed);
                }}
              >
                <span className="flex items-center gap-1">
                  <span className={clsx('size-2 rounded-full', TONE_DOT[bed.tone])} aria-hidden />
                  <span className="font-semibold">{bed.bed_number}</span>
                  <span className="text-xs opacity-70">{bed.room}</span>
                  {bed.isolation_flag && (
                    <span className="ms-auto text-xs font-bold text-red-700" title={bed.isolation_reason ?? ''}>
                      ⚠
                    </span>
                  )}
                </span>

                {bed.admission ? (
                  <>
                    <span className="mt-1 block truncate text-xs font-medium">
                      {bed.admission.patient.given_names[0]} {bed.admission.patient.family_name}
                    </span>
                    <span className="block text-xs opacity-70">
                      {t('clinical.lengthOfStay')} {bed.admission.length_of_stay_days}d
                    </span>
                    {bed.admission.expected_discharge_at && (
                      <span
                        className={clsx(
                          'block text-xs',
                          bed.admission.overdue ? 'font-bold text-red-700' : 'opacity-70',
                        )}
                      >
                        {t('clinical.edd')} {date(bed.admission.expected_discharge_at)}
                        {bed.admission.overdue && ` · +${bed.admission.days_overdue}d`}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="mt-1 block text-xs opacity-70">
                    {bed.blocker ?? t('clinical.available')}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </QueryState>

      {admitting && (
        <AdmitSheet
          bed={admitting}
          pending={admit.isPending}
          error={admit.error instanceof ApiError ? admit.error : null}
          onClose={() => {
            setAdmitting(null);
            admit.reset();
          }}
          onSubmit={(body) =>
            admit.mutate(
              { bed_id: admitting.id, ...body },
              { onSuccess: () => setAdmitting(null) },
            )
          }
        />
      )}

      {selected && (
        <BedActionsSheet
          bed={selected}
          beds={rows}
          pendingTransfer={transfer.isPending}
          pendingDischarge={discharge.isPending}
          pendingHousekeeping={housekeeping.isPending}
          error={
            (transfer.error ?? discharge.error ?? housekeeping.error) instanceof ApiError
              ? ((transfer.error ?? discharge.error ?? housekeeping.error) as ApiError)
              : null
          }
          onClose={() => setSelected(null)}
          onTransfer={(body) =>
            transfer.mutate(
              { admissionId: selected.admission!.id, ...body },
              { onSuccess: () => setSelected(null) },
            )
          }
          onDischarge={(body) =>
            discharge.mutate(
              { admissionId: selected.admission!.id, ...body },
              { onSuccess: () => setSelected(null) },
            )
          }
          onHousekeeping={(status) =>
            housekeeping.mutate(
              { bedId: selected.id, housekeeping_status: status },
              { onSuccess: () => setSelected(null) },
            )
          }
        />
      )}
    </>
  );
}

export default function BedBoardPage() {
  return (
    <Suspense fallback={null}>
      <BedBoardInner />
    </Suspense>
  );
}
