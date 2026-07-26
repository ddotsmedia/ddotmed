'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import type { DuplicateCandidate } from './registration-schema';

/**
 * Shown when the server refuses a registration because it found likely matches.
 *
 * Registering a duplicate is far more damaging than an extra click here: it splits
 * a patient's allergies, medications and results across two charts. So the default
 * action is to open the existing record, and creating anyway is the secondary path
 * and requires an explicit confirmation.
 */
export function DuplicatePrompt({
  candidates,
  onCreateAnyway,
  onCancel,
  isSubmitting,
}: {
  candidates: DuplicateCandidate[];
  onCreateAnyway: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
}) {
  const { t, date } = useI18n();

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="duplicate-title"
    >
      <div className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-xl bg-white p-4 shadow-xl sm:rounded-xl dark:bg-slate-800">
        <h2 id="duplicate-title" className="text-lg font-bold text-amber-900 dark:text-amber-300">
          Possible existing record
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {candidates.length === 1
            ? 'A patient with very similar details already exists.'
            : `${candidates.length} patients with very similar details already exist.`}{' '}
          Open the existing record if this is the same person — registering again splits their
          medical history across two charts.
        </p>

        <ul className="mt-4 space-y-2">
          {candidates.map((candidate) => (
            <li
              key={candidate.id}
              className="rounded-lg border border-slate-300 p-3 dark:border-slate-600"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">{candidate.name}</span>
                <span
                  className={
                    candidate.score >= 0.95
                      ? 'rounded bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800'
                      : 'rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800'
                  }
                >
                  {(candidate.score * 100).toFixed(0)}% match
                </span>
              </div>
              <dl className="mt-1 flex flex-wrap gap-x-4 text-xs text-slate-600 dark:text-slate-300">
                <div className="flex gap-1">
                  <dt>{t('clinical.mrn')}:</dt>
                  <dd className="font-mono">{candidate.mrn}</dd>
                </div>
                <div className="flex gap-1">
                  <dt>{t('clinical.dob')}:</dt>
                  <dd>{date(candidate.birth_date)}</dd>
                </div>
              </dl>
              <p className="mt-1 text-xs text-slate-500">{candidate.reasons.join(' · ')}</p>
              <Link
                href={`/patients/${candidate.id}`}
                className="btn-primary mt-2 w-full py-1.5 text-xs sm:w-auto"
              >
                Open this record
              </Link>
            </li>
          ))}
        </ul>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {t('common.back')}
          </button>
          <button
            type="button"
            className="btn-danger"
            onClick={onCreateAnyway}
            disabled={isSubmitting}
          >
            {isSubmitting ? t('common.loading') : 'Not the same person — register new'}
          </button>
        </div>
      </div>
    </div>
  );
}
