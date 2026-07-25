'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { usePatients } from '@/lib/queries';
import { usePermissions } from '@/lib/session';
import { PageHeader, QueryState } from '@/components/ui';

export default function PatientsPage() {
  const { t, date } = useI18n();
  const { can } = usePermissions();
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [page, setPage] = useState(1);

  const patients = usePatients({ q: submitted || undefined, page, limit: 25 });

  return (
    <>
      <PageHeader
        title={t('clinical.patients')}
        actions={
          can('patient:write') && (
            <Link href="/patients/register" className="btn-primary">
              {t('common.submit')}
            </Link>
          )
        }
      />

      <form
        className="card mb-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setSubmitted(q.trim());
        }}
      >
        <input
          className="input flex-1 min-w-48"
          placeholder={`${t('common.search')} — ${t('clinical.mrn')}, ${t('clinical.patient')}`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" className="btn-primary">
          {t('common.search')}
        </button>
      </form>

      <QueryState
        isLoading={patients.isLoading}
        error={patients.error}
        isEmpty={patients.data?.data.length === 0}
      >
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>{t('clinical.mrn')}</th>
                <th>{t('clinical.patient')}</th>
                <th>{t('clinical.gender')}</th>
                <th>{t('clinical.dob')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {patients.data?.data.map((p) => (
                <tr key={p.id}>
                  <td className="font-mono text-xs">{p.mrn}</td>
                  <td className="font-medium">
                    {p.given_names.join(' ')} {p.family_name}
                    {p.is_vip && (
                      <span className="ms-2 rounded bg-amber-100 px-1 text-xs text-amber-800">VIP</span>
                    )}
                  </td>
                  <td>{t(`clinical.${p.gender}`)}</td>
                  <td>{date(p.birth_date)}</td>
                  <td>
                    <Link href={`/patients/${p.id}`} className="text-sky-700 underline dark:text-sky-400">
                      {t('common.next')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="text-slate-600">
            {patients.data?.total ?? 0} — {patients.data?.page}/{patients.data?.pages}
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
              disabled={page >= (patients.data?.pages ?? 1)}
              onClick={() => setPage((p) => p + 1)}
            >
              {t('common.next')}
            </button>
          </div>
        </div>
      </QueryState>
    </>
  );
}
