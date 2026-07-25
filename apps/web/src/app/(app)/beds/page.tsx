'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { keys, useApiMutation, useBedBoard } from '@/lib/queries';
import { PageHeader, QueryState, StatTile, Field } from '@/components/ui';

const STATUS_CLASS: Record<string, string> = {
  available: 'bed-available',
  occupied: 'bed-occupied',
  reserved: 'bed-reserved',
  cleaning: 'bed-cleaning',
  blocked: 'bed-blocked',
  maintenance: 'bed-maintenance',
};

export default function BedBoardPage() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [ward, setWard] = useState<string>('');
  const board = useBedBoard(ward || undefined);

  const [transfer, setTransfer] = useState<{ admissionId: string; toBedId: string } | null>(null);
  const [reason, setReason] = useState('');

  const doTransfer = useApiMutation<{ admission_id: string; to_bed_id: string; reason: string }, unknown>(
    '/beds/transfer',
    [keys.bedBoard(ward || undefined)],
  );

  const doDischarge = useApiMutation<{ admissionId: string; disposition: string }, unknown>(
    (body) => `/beds/discharge/${body.admissionId}`,
    [keys.bedBoard(ward || undefined)],
  );

  return (
    <>
      <PageHeader
        title={t('clinical.bed')}
        actions={
          <select className="input w-auto" value={ward} onChange={(e) => setWard(e.target.value)}>
            <option value="">{t('common.all')}</option>
            {board.data?.wards.map((w) => (
              <option key={w.ward} value={w.ward}>
                {w.ward}
              </option>
            ))}
          </select>
        }
      />

      <QueryState isLoading={board.isLoading} error={board.error}>
        <div className="mb-4 grid grid-cols-3 gap-3">
          <StatTile label={t('clinical.bed')} value={board.data?.totals.total ?? 0} />
          <StatTile
            label={t('clinical.patients')}
            value={board.data?.totals.occupied ?? 0}
            tone="warning"
          />
          <StatTile label={t('common.success')} value={board.data?.totals.available ?? 0} tone="ok" />
        </div>

        <div className="space-y-6">
          {board.data?.wards.map((w) => (
            <section key={w.ward}>
              <h2 className="mb-2 flex items-center gap-2 font-semibold">
                {w.ward}
                <span
                  className={clsx(
                    'rounded px-2 py-0.5 text-xs font-bold',
                    w.occupancy_pct >= 95
                      ? 'bg-red-100 text-red-800'
                      : w.occupancy_pct >= 85
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-emerald-100 text-emerald-800',
                  )}
                >
                  {w.occupancy_pct}%
                </span>
              </h2>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                {w.beds.map((b) => {
                  const bed = b as Record<string, unknown>;
                  const admissions = (bed.admissions ?? []) as Array<{
                    id: string;
                    patient?: { mrn?: string; family_name?: string; given_names?: string[] };
                  }>;
                  const admission = admissions[0];
                  const status = String(bed.status);
                  return (
                    <article
                      key={String(bed.id)}
                      className={clsx('rounded-lg border-2 p-2 text-xs', STATUS_CLASS[status])}
                    >
                      <p className="font-bold">
                        {String(bed.room)}/{String(bed.bed_number)}
                      </p>
                      {/* Status is written out, never conveyed by colour alone. */}
                      <p className="font-medium uppercase">{status}</p>
                      <p className="opacity-75">{String(bed.bed_type)}</p>

                      {admission?.patient && (
                        <>
                          <p className="mt-1 truncate font-medium">
                            {admission.patient.given_names?.[0]} {admission.patient.family_name}
                          </p>
                          <p className="font-mono opacity-75">{admission.patient.mrn}</p>

                          {can('adt:manage') && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              <button
                                type="button"
                                className="rounded bg-white/80 px-1.5 py-0.5 text-[10px] font-semibold"
                                onClick={() =>
                                  setTransfer({ admissionId: admission.id, toBedId: '' })
                                }
                              >
                                {t('clinical.transfer')}
                              </button>
                              <button
                                type="button"
                                className="rounded bg-white/80 px-1.5 py-0.5 text-[10px] font-semibold"
                                onClick={() =>
                                  doDischarge.mutate({
                                    admissionId: admission.id,
                                    disposition: 'home',
                                  })
                                }
                              >
                                {t('clinical.discharge')}
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </QueryState>

      {transfer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <form
            className="w-full max-w-sm rounded-lg bg-white p-4 dark:bg-slate-800"
            onSubmit={(e) => {
              e.preventDefault();
              doTransfer.mutate(
                { admission_id: transfer.admissionId, to_bed_id: transfer.toBedId, reason },
                { onSuccess: () => setTransfer(null) },
              );
            }}
          >
            <h3 className="mb-3 font-semibold">{t('clinical.transfer')}</h3>

            <Field label={t('clinical.bed')} required>
              <select
                className="input"
                value={transfer.toBedId}
                onChange={(e) => setTransfer({ ...transfer, toBedId: e.target.value })}
                required
              >
                <option value="">—</option>
                {board.data?.wards.flatMap((w) =>
                  w.beds
                    .filter((b) => (b as Record<string, unknown>).status === 'available')
                    .map((b) => {
                      const bed = b as Record<string, unknown>;
                      return (
                        <option key={String(bed.id)} value={String(bed.id)}>
                          {w.ward} / {String(bed.room)} / {String(bed.bed_number)}
                        </option>
                      );
                    }),
                )}
              </select>
            </Field>

            <Field label={t('common.notes')} required>
              <input
                className="input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={3}
                required
              />
            </Field>

            {doTransfer.error && (
              <p className="mt-2 text-sm text-red-700" role="alert">
                {doTransfer.error.message}
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setTransfer(null)}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="btn-primary" disabled={doTransfer.isPending}>
                {t('common.confirm')}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
