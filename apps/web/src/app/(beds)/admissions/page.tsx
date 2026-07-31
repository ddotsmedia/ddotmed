'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { ApiError } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import {
  keys,
  useAdmissions,
  useApiMutation,
  useBedList,
  type AdmissionRow,
  type BedRow,
} from '@/lib/queries';
import { PageHeader, QueryState, StatTile, Field } from '@/components/ui';

const DISPOSITIONS = ['home', 'transfer to another facility', 'against medical advice', 'deceased'];

type Action = { admission: AdmissionRow; kind: 'transfer' | 'discharge' } | null;

export default function AdmissionsPage() {
  const { t, date } = useI18n();
  const { can } = usePermissions();

  const [ward, setWard] = useState('');
  const [action, setAction] = useState<Action>(null);
  const [targetBed, setTargetBed] = useState('');
  const [reason, setReason] = useState('');
  const [disposition, setDisposition] = useState(DISPOSITIONS[0]!);
  const [followUp, setFollowUp] = useState('');

  const params = { status: 'active', ward: ward || undefined };
  const admissions = useAdmissions(params);
  const beds = useBedList({});

  const invalidate = [keys.admissions(params), keys.bedList({})];

  const transfer = useApiMutation<Record<string, unknown>, unknown>(
    (body) => `/admissions/${body.admissionId as string}/transfer`,
    invalidate,
  );
  const discharge = useApiMutation<Record<string, unknown>, unknown>(
    (body) => `/admissions/${body.admissionId as string}/discharge`,
    invalidate,
  );

  const rows = admissions.data ?? [];
  const wards = useMemo(
    () => [...new Set(rows.map((r) => r.bed?.ward).filter(Boolean) as string[])].sort(),
    [rows],
  );
  const overdue = rows.filter((r) => r.overdue).length;
  const targets = (beds.data ?? []).filter((b: BedRow) => b.admittable);

  const error =
    (transfer.error ?? discharge.error) instanceof ApiError
      ? ((transfer.error ?? discharge.error) as ApiError)
      : null;

  const close = () => {
    setAction(null);
    setTargetBed('');
    setReason('');
    setFollowUp('');
    transfer.reset();
    discharge.reset();
  };

  return (
    <>
      <PageHeader
        title={t('clinical.admissions')}
        actions={
          <Link href="/beds" className="btn-secondary">
            {t('clinical.bedBoard')}
          </Link>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-2">
        <StatTile label={t('clinical.admissions')} value={rows.length} />
        <StatTile
          label={t('clinical.overdue')}
          value={overdue}
          tone={overdue > 0 ? 'warning' : 'neutral'}
        />
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
        isLoading={admissions.isLoading}
        error={admissions.error}
        isEmpty={rows.length === 0}
        emptyMessage={t('common.noData')}
      >
        {/* Cards on a phone, a table from tablet up. */}
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className={clsx('card', row.overdue && 'border-amber-400 bg-amber-50 dark:bg-amber-950/20')}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">
                  {row.patient.given_names.join(' ')} {row.patient.family_name}
                </span>
                <span className="font-mono text-xs text-slate-500">{row.patient.mrn}</span>
                {row.bed?.isolation_flag && (
                  <span className="rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white">
                    {t('clinical.isolation')}
                  </span>
                )}
                <span className="ms-auto rounded bg-slate-100 px-1.5 py-0.5 text-xs font-semibold dark:bg-slate-800">
                  {t('clinical.lengthOfStay')} {row.length_of_stay_days}d
                </span>
              </div>

              <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
                {row.bed ? `${row.bed.ward} · ${row.bed.room} · ${row.bed.bed_number}` : '—'} ·{' '}
                {row.admission_type} · {row.admission_number}
              </p>

              <p
                className={clsx(
                  'text-xs',
                  row.overdue ? 'font-bold text-red-700' : 'text-slate-500',
                )}
              >
                {row.expected_discharge_at
                  ? `${t('clinical.edd')} ${date(row.expected_discharge_at)}`
                  : `${t('clinical.edd')} —`}
                {row.overdue && ` · ${t('clinical.overdue')} ${row.days_overdue}d`}
              </p>

              {can('adt:manage') && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-secondary py-1 text-xs"
                    onClick={() => {
                      close();
                      setAction({ admission: row, kind: 'transfer' });
                    }}
                  >
                    {t('clinical.transferPatient')}
                  </button>
                  <button
                    type="button"
                    className="btn-danger py-1 text-xs"
                    onClick={() => {
                      close();
                      setAction({ admission: row, kind: 'discharge' });
                    }}
                  >
                    {t('clinical.dischargePatient')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </QueryState>

      {action && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-label={action.kind === 'transfer' ? t('clinical.transferPatient') : t('clinical.dischargePatient')}
        >
          <form
            className="max-h-[90dvh] w-full overflow-y-auto rounded-t-xl bg-white p-4 shadow-xl sm:max-w-md sm:rounded-xl dark:bg-slate-900"
            onSubmit={(e) => {
              e.preventDefault();
              if (action.kind === 'transfer') {
                transfer.mutate(
                  { admissionId: action.admission.id, to_bed_id: targetBed, reason: reason.trim() },
                  { onSuccess: close },
                );
              } else {
                discharge.mutate(
                  {
                    admissionId: action.admission.id,
                    discharge_disposition: disposition,
                    discharge_notes: reason.trim() || undefined,
                    follow_up_date: followUp || null,
                  },
                  { onSuccess: close },
                );
              }
            }}
          >
            <h2 className="mb-1 font-semibold">
              {action.kind === 'transfer'
                ? t('clinical.transferPatient')
                : t('clinical.dischargePatient')}
            </h2>
            <p className="mb-3 text-sm">
              {action.admission.patient.given_names.join(' ')} {action.admission.patient.family_name}
            </p>

            {action.kind === 'transfer' ? (
              <>
                <Field label={t('clinical.selectBed')} required>
                  <select
                    className="input"
                    value={targetBed}
                    onChange={(e) => setTargetBed(e.target.value)}
                  >
                    <option value="">—</option>
                    {targets.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.ward} · {b.room} · {b.bed_number}
                      </option>
                    ))}
                  </select>
                </Field>
                {targets.length === 0 && (
                  <p className="text-sm text-amber-700">{t('clinical.noBeds')}</p>
                )}
              </>
            ) : (
              <>
                <Field label={t('clinical.disposition')} required>
                  <select
                    className="input"
                    value={disposition}
                    onChange={(e) => setDisposition(e.target.value)}
                  >
                    {DISPOSITIONS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('clinical.followUpDate')}>
                  <input
                    type="date"
                    className="input"
                    value={followUp}
                    onChange={(e) => setFollowUp(e.target.value)}
                  />
                </Field>
              </>
            )}

            <Field
              label={action.kind === 'transfer' ? t('common.notes') : t('clinical.dischargeNotes')}
              required={action.kind === 'transfer'}
            >
              <textarea
                className="input min-h-16"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>

            {error && (
              <p
                className="mt-2 rounded border border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                role="alert"
              >
                {error.message}
              </p>
            )}

            <div className="mt-3 flex gap-2">
              <button
                type="submit"
                className={clsx('flex-1', action.kind === 'transfer' ? 'btn-primary' : 'btn-danger')}
                disabled={
                  transfer.isPending ||
                  discharge.isPending ||
                  (action.kind === 'transfer' && (!targetBed || reason.trim().length < 3))
                }
              >
                {action.kind === 'transfer'
                  ? t('clinical.transferPatient')
                  : t('clinical.dischargePatient')}
              </button>
              <button type="button" className="btn-secondary" onClick={close}>
                {t('common.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
