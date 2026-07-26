'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { Paginated } from '@medicore/shared-types';
import { ageFrom } from '@medicore/ui-components';
import { api } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { useDebounced } from '@/lib/use-debounced';
import { PageHeader, QueryState } from '@/components/ui';

interface SearchRow {
  id: string;
  mrn: string;
  given_names: string[];
  family_name: string;
  gender: string;
  birth_date: string;
  is_vip: boolean;
  photo_url: string | null;
  match_score: number | null;
  matched_on: string | null;
  coverages?: Array<{ member_id: string; payer?: { name: string } | null }>;
}

type SearchResponse = Paginated<SearchRow> & { truncated?: boolean };

/** Which field produced the hit, so a match never looks arbitrary to the user. */
const MATCH_LABEL: Record<string, string> = {
  mrn: 'MRN',
  name: 'Name',
  phone: 'Phone',
  insurance: 'Insurance',
  birth_date: 'DOB',
};

function Avatar({ row }: { row: SearchRow }) {
  const initials = `${row.given_names[0]?.[0] ?? ''}${row.family_name[0] ?? ''}`.toUpperCase();
  if (row.photo_url) {
    return <img src={row.photo_url} alt="" className="size-10 shrink-0 rounded-full object-cover" />;
  }
  return (
    <span
      aria-hidden
      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-200"
    >
      {initials || '?'}
    </span>
  );
}

export default function PatientSearchPage() {
  const { t, date } = useI18n();
  const { can } = usePermissions();

  const [input, setInput] = useState('');
  const [page, setPage] = useState(1);
  const query = useDebounced(input.trim(), 300);

  const results = useQuery<SearchResponse>({
    queryKey: ['patients', 'search', query, page],
    queryFn: () => api.get<SearchResponse>('/patients', { q: query || undefined, page, limit: 25 }),
    // Keeps the previous page on screen while the next loads, so the list does
    // not flash empty between keystrokes.
    placeholderData: keepPreviousData,
  });

  const rows = results.data?.data ?? [];

  return (
    <>
      <PageHeader
        title={t('clinical.patients')}
        actions={
          can('patient:write') && (
            <Link href="/patients/register" className="btn-primary">
              + {t('clinical.patient')}
            </Link>
          )
        }
      />

      {/* Sticky: the query stays reachable while scrolling a long result list. */}
      <div className="sticky top-14 z-20 -mx-4 mb-3 bg-slate-50 px-4 py-2 dark:bg-slate-950">
        <label className="relative block">
          <span className="sr-only">{t('common.search')}</span>
          <input
            className="input pe-9 text-base"
            inputMode="search"
            autoFocus
            placeholder="Name, MRN, DOB, phone, national ID, insurance"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setPage(1);
            }}
          />
          {input && (
            <button
              type="button"
              onClick={() => setInput('')}
              aria-label={t('common.cancel')}
              className="absolute end-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              ✕
            </button>
          )}
        </label>

        <p className="mt-1 h-4 text-xs text-slate-500" aria-live="polite">
          {results.isFetching && query
            ? t('common.loading')
            : query
              ? `${results.data?.total ?? 0} ${t('clinical.patients').toLowerCase()}`
              : ''}
        </p>
      </div>

      {results.data?.truncated && (
        <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Showing the strongest matches only — narrow the search to see the rest.
        </p>
      )}

      <QueryState
        isLoading={results.isLoading}
        error={results.error}
        isEmpty={rows.length === 0}
        emptyMessage={query ? t('common.noData') : 'Start typing to search'}
      >
        {/* Mobile: stacked tap targets. Desktop: a dense table. */}
        <ul className="space-y-2 md:hidden">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/patients/${row.id}`}
                className="card flex items-center gap-3 active:bg-slate-50"
              >
                <Avatar row={row} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">
                    {row.given_names.join(' ')} {row.family_name}
                    {row.is_vip && (
                      <span className="ms-2 rounded bg-amber-100 px-1 text-[10px] text-amber-800">
                        VIP
                      </span>
                    )}
                  </p>
                  <p className="font-mono text-xs text-slate-500">{row.mrn}</p>
                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    {ageFrom(row.birth_date)}y · {t(`clinical.${row.gender}`)} · {date(row.birth_date)}
                  </p>
                </div>
                {row.matched_on && (
                  <span className="shrink-0 rounded bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-800">
                    {MATCH_LABEL[row.matched_on] ?? row.matched_on}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>

        <div className="hidden md:block">
          <div className="card overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th />
                  <th>{t('clinical.patient')}</th>
                  <th>{t('clinical.mrn')}</th>
                  <th>{t('clinical.dob')}</th>
                  <th>{t('clinical.gender')}</th>
                  <th>{t('billing.insurance')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50 dark:hover:bg-slate-800">
                    <td className="w-12">
                      <Avatar row={row} />
                    </td>
                    <td className="font-medium">
                      <Link href={`/patients/${row.id}`} className="hover:underline">
                        {row.given_names.join(' ')} {row.family_name}
                      </Link>
                      {row.is_vip && (
                        <span className="ms-2 rounded bg-amber-100 px-1 text-[10px] text-amber-800">
                          VIP
                        </span>
                      )}
                    </td>
                    <td className="font-mono text-xs">{row.mrn}</td>
                    <td className="text-xs">
                      {date(row.birth_date)}{' '}
                      <span className="text-slate-500">({ageFrom(row.birth_date)}y)</span>
                    </td>
                    <td className="text-xs">{t(`clinical.${row.gender}`)}</td>
                    <td className="text-xs">{row.coverages?.[0]?.payer?.name ?? '—'}</td>
                    <td>
                      {row.matched_on && (
                        <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-800">
                          {MATCH_LABEL[row.matched_on] ?? row.matched_on}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {(results.data?.pages ?? 1) > 1 && (
          <div className="mt-3 flex items-center justify-between text-sm">
            <span className="text-slate-600">
              {results.data?.page}/{results.data?.pages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                {t('common.back')}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={page >= (results.data?.pages ?? 1)}
                onClick={() => setPage((p) => p + 1)}
              >
                {t('common.next')}
              </button>
            </div>
          </div>
        )}
      </QueryState>
    </>
  );
}
