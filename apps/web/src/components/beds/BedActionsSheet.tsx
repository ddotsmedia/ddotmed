'use client';

import { useState } from 'react';
import clsx from 'clsx';
import type { ApiError } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import type { BedRow } from '@/lib/queries';
import { Field } from '@/components/ui';

export interface TransferBody {
  to_bed_id: string;
  reason: string;
}

export interface DischargeBody {
  discharge_disposition: string;
  discharge_notes?: string;
  follow_up_date?: string | null;
}

type Mode = 'summary' | 'transfer' | 'discharge';

const DISPOSITIONS = ['home', 'transfer to another facility', 'against medical advice', 'deceased'];

/**
 * What can be done with a bed that has someone in it — plus the cleaning controls
 * for one that does not. One sheet rather than three, because the question on a
 * ward round is "what about this bed", not "which form do I want".
 */
export function BedActionsSheet({
  bed,
  beds,
  pendingTransfer,
  pendingDischarge,
  pendingHousekeeping,
  error,
  onTransfer,
  onDischarge,
  onHousekeeping,
  onClose,
}: {
  bed: BedRow;
  beds: readonly BedRow[];
  pendingTransfer: boolean;
  pendingDischarge: boolean;
  pendingHousekeeping: boolean;
  error: ApiError | null;
  onTransfer: (body: TransferBody) => void;
  onDischarge: (body: DischargeBody) => void;
  onHousekeeping: (status: 'clean' | 'dirty' | 'in_progress') => void;
  onClose: () => void;
}) {
  const { t, date } = useI18n();
  const { can } = usePermissions();

  const [mode, setMode] = useState<Mode>('summary');
  const [targetBed, setTargetBed] = useState('');
  const [transferReason, setTransferReason] = useState('');
  const [disposition, setDisposition] = useState(DISPOSITIONS[0]!);
  const [notes, setNotes] = useState('');
  const [followUp, setFollowUp] = useState('');

  const admission = bed.admission;
  // Only beds that could actually receive the patient are offered.
  const targets = beds.filter((b) => b.id !== bed.id && b.admittable);

  // The cleaning cycle only ever offers the next legal step.
  const nextClean =
    bed.housekeeping_status === 'dirty'
      ? ('in_progress' as const)
      : bed.housekeeping_status === 'in_progress'
        ? ('clean' as const)
        : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={`${bed.ward} ${bed.bed_number}`}
    >
      <div className="max-h-[90dvh] w-full overflow-y-auto rounded-t-xl bg-white p-4 shadow-xl sm:max-w-lg sm:rounded-xl dark:bg-slate-900">
        <div className="mb-3 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">
              {bed.ward} · {bed.room} · {t('clinical.bed')} {bed.bed_number}
            </h2>
            <p className="text-sm">
              {bed.status} · {bed.housekeeping_status}
            </p>
            {bed.isolation_flag && (
              <p className="mt-1 rounded bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800">
                ⚠ {t('clinical.isolation')}
                {bed.isolation_reason ? ` — ${bed.isolation_reason}` : ''}
              </p>
            )}
          </div>
          <button type="button" className="text-sm underline" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>

        {admission && (
          <div className="mb-3 rounded border border-slate-200 p-2 text-sm dark:border-slate-700">
            <p className="font-medium">
              {admission.patient.given_names.join(' ')} {admission.patient.family_name}{' '}
              <span className="font-mono text-xs text-slate-500">{admission.patient.mrn}</span>
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              {admission.admission_number} · {t('clinical.lengthOfStay')}{' '}
              {admission.length_of_stay_days}d
            </p>
            {admission.expected_discharge_at && (
              <p
                className={clsx(
                  'text-xs',
                  admission.overdue ? 'font-bold text-red-700' : 'text-slate-600 dark:text-slate-300',
                )}
              >
                {t('clinical.edd')} {date(admission.expected_discharge_at)}
                {admission.overdue && ` · ${t('clinical.overdue')} ${admission.days_overdue}d`}
              </p>
            )}
          </div>
        )}

        {error && (
          <p
            className="mb-3 rounded border border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            role="alert"
          >
            {error.message}
          </p>
        )}

        {mode === 'summary' && (
          <div className="flex flex-wrap gap-2">
            {admission && can('adt:manage') && (
              <>
                <button type="button" className="btn-secondary" onClick={() => setMode('transfer')}>
                  {t('clinical.transferPatient')}
                </button>
                <button type="button" className="btn-danger" onClick={() => setMode('discharge')}>
                  {t('clinical.dischargePatient')}
                </button>
              </>
            )}
            {!admission && nextClean && can('bed:manage') && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => onHousekeeping(nextClean)}
                disabled={pendingHousekeeping}
              >
                {nextClean === 'in_progress' ? t('clinical.markInProgress') : t('clinical.markClean')}
              </button>
            )}
            {!admission && bed.housekeeping_status === 'clean' && can('bed:manage') && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => onHousekeeping('dirty')}
                disabled={pendingHousekeeping}
              >
                {t('clinical.markDirty')}
              </button>
            )}
          </div>
        )}

        {mode === 'transfer' && admission && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              onTransfer({ to_bed_id: targetBed, reason: transferReason.trim() });
            }}
          >
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

            <Field label={t('common.notes')} required>
              <textarea
                className="input min-h-16"
                value={transferReason}
                onChange={(e) => setTransferReason(e.target.value)}
              />
            </Field>

            <div className="flex gap-2">
              <button
                type="submit"
                className="btn-primary flex-1"
                disabled={!targetBed || transferReason.trim().length < 3 || pendingTransfer}
              >
                {t('clinical.transferPatient')}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setMode('summary')}>
                {t('common.back')}
              </button>
            </div>
          </form>
        )}

        {mode === 'discharge' && admission && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              onDischarge({
                discharge_disposition: disposition,
                discharge_notes: notes.trim() || undefined,
                follow_up_date: followUp || null,
              });
            }}
          >
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

            <Field label={t('clinical.dischargeNotes')}>
              <textarea
                className="input min-h-20"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>

            <p className="text-xs text-slate-500">
              {t('clinical.housekeeping')}: {t('clinical.markDirty')}
            </p>

            <div className="flex gap-2">
              <button type="submit" className="btn-danger flex-1" disabled={pendingDischarge}>
                {t('clinical.dischargePatient')}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setMode('summary')}>
                {t('common.back')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
