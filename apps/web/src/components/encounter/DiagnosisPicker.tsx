'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { useI18n } from '@/lib/i18n';
import { useDebounced } from '@/lib/use-debounced';
import { useDiagnosisSearch, type DiagnosisMatch } from '@/lib/queries';

export interface RecordedCondition {
  id: string;
  code: string;
  code_display: string | null;
  is_primary: boolean;
  clinical_status: string;
}

/**
 * ICD-10 autocomplete for the encounter diagnosis list.
 *
 * The clinician picks a code, never types one: a free-typed code that does not
 * exist reaches the claim before anyone notices it is wrong.
 */
export function DiagnosisPicker({
  recorded,
  onAdd,
  saving,
  disabled,
  error,
}: {
  recorded: RecordedCondition[];
  onAdd: (match: DiagnosisMatch, isPrimary: boolean) => void;
  saving: boolean;
  disabled?: boolean;
  error?: string | null;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query);
  const results = useDiagnosisSearch(debounced);

  const hasPrimary = recorded.some((c) => c.is_primary);
  const alreadyRecorded = new Set(recorded.map((c) => c.code.toUpperCase()));

  return (
    <div className="card space-y-3">
      <h3 className="font-semibold">{t('clinical.diagnosis')}</h3>

      {recorded.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {recorded.map((condition) => (
            <li
              key={condition.id}
              className={clsx(
                'rounded border px-2 py-1 text-xs',
                condition.is_primary
                  ? 'border-sky-400 bg-sky-50 text-sky-900 dark:bg-sky-950/30 dark:text-sky-200'
                  : 'border-slate-300 dark:border-slate-600',
              )}
            >
              <span className="font-mono font-semibold">{condition.code}</span>{' '}
              {condition.code_display}
              {condition.is_primary && <span className="ms-1 font-semibold">★</span>}
            </li>
          ))}
        </ul>
      )}

      <label className="block">
        <span className="label">{t('clinical.searchDiagnosis')}</span>
        <input
          type="search"
          className="input"
          value={query}
          disabled={disabled}
          placeholder="E11.9 / asthma"
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
      </label>

      {debounced.trim().length >= 2 && (
        <div className="max-h-64 overflow-y-auto rounded border border-slate-200 dark:border-slate-700">
          {results.isLoading && <p className="p-2 text-sm text-slate-500">{t('common.loading')}</p>}
          {!results.isLoading && (results.data?.length ?? 0) === 0 && (
            <p className="p-2 text-sm text-slate-500">{t('common.noData')}</p>
          )}
          <ul>
            {results.data?.map((match) => {
              const recordedAlready = alreadyRecorded.has(match.code.toUpperCase());
              return (
                <li
                  key={match.code}
                  className="flex items-center gap-2 border-b border-slate-100 p-2 last:border-b-0 dark:border-slate-800"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      <span className="font-mono font-semibold">{match.code}</span> {match.display}
                    </p>
                    <p className="text-xs text-slate-500">{match.chapter}</p>
                  </div>
                  <button
                    type="button"
                    className="btn-secondary py-1 text-xs"
                    disabled={saving || disabled || recordedAlready}
                    onClick={() => {
                      onAdd(match, !hasPrimary);
                      setQuery('');
                    }}
                  >
                    {recordedAlready ? '✓' : t('clinical.addDiagnosis')}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {error && (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
