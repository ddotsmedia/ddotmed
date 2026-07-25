'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { PageHeader, QueryState, StatTile } from '@/components/ui';

type Tab = 'appointments' | 'results' | 'invoices';

interface PortalSummary {
  appointments: Array<{
    id: string;
    start: string;
    service_type: string;
    status: string;
    is_telehealth: boolean;
    telehealth_url: string | null;
  }>;
  results: Array<{
    id: string;
    display: string;
    value_quantity: number | null;
    unit: string | null;
    interpretation: string | null;
    performed_at: string;
    status: string;
  }>;
  invoices: Array<{
    id: string;
    invoice_number: string;
    currency: string;
    total_minor: number;
    balance_minor: number;
    due_at: string | null;
  }>;
}

export default function PatientPortalPage() {
  const { t, date, money } = useI18n();
  const { user } = useSession();
  const [tab, setTab] = useState<Tab>('appointments');

  const summary = useQuery<PortalSummary>({
    queryKey: ['portal', 'summary'],
    queryFn: () => api.get<PortalSummary>('/portal/summary'),
    enabled: Boolean(user),
  });

  const upcoming = summary.data?.appointments.filter((a) => new Date(a.start) > new Date()) ?? [];
  const outstanding = summary.data?.invoices.filter((i) => i.balance_minor > 0) ?? [];

  return (
    <main className="mx-auto max-w-3xl p-4">
      <PageHeader title={t('common.appName')} subtitle={user?.email} />

      <div className="mb-4 grid grid-cols-3 gap-3">
        <StatTile label={t('clinical.appointment')} value={upcoming.length} />
        <StatTile label={t('clinical.labResults')} value={summary.data?.results.length ?? 0} />
        <StatTile
          label={t('billing.balance')}
          value={outstanding.length}
          tone={outstanding.length > 0 ? 'warning' : 'ok'}
        />
      </div>

      <div className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-700">
        {(['appointments', 'results', 'invoices'] as Tab[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={
              tab === key
                ? 'border-b-2 border-sky-600 px-3 py-2 text-sm font-semibold text-sky-700'
                : 'px-3 py-2 text-sm text-slate-600'
            }
          >
            {t(
              key === 'appointments'
                ? 'clinical.appointment'
                : key === 'results'
                  ? 'clinical.labResults'
                  : 'billing.invoices',
            )}
          </button>
        ))}
      </div>

      <QueryState isLoading={summary.isLoading} error={summary.error}>
        {tab === 'appointments' && (
          <ul className="space-y-2">
            {summary.data?.appointments.map((a) => (
              <li key={a.id} className="card flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{a.service_type}</p>
                  <p className="text-xs text-slate-500">{date(a.start, true)}</p>
                </div>
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs dark:bg-slate-800">
                  {a.status}
                </span>
                {a.is_telehealth && a.telehealth_url && (
                  <a href={a.telehealth_url} className="btn-primary py-1 text-xs">
                    {t('common.next')}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}

        {tab === 'results' && (
          <ul className="space-y-2">
            {summary.data?.results.map((r) => (
              <li
                key={r.id}
                className={
                  r.interpretation === 'HH' || r.interpretation === 'LL'
                    ? 'card border-red-300 bg-red-50'
                    : 'card'
                }
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{r.display}</span>
                  <span className="tabular-nums">
                    {r.value_quantity ?? '—'} {r.unit ?? ''}
                  </span>
                </div>
                <p className="text-xs text-slate-500">{date(r.performed_at, true)}</p>
                {/* Results are shown, never interpreted for the patient in the portal. */}
                {(r.interpretation === 'HH' || r.interpretation === 'LL') && (
                  <p className="mt-1 text-xs font-medium text-red-800">
                    {t('clinical.criticalValue')} — {t('auth.breakGlassWarning')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {tab === 'invoices' && (
          <ul className="space-y-2">
            {summary.data?.invoices.map((i) => (
              <li key={i.id} className="card flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm">{i.invoice_number}</p>
                  {i.due_at && <p className="text-xs text-slate-500">{date(i.due_at)}</p>}
                </div>
                <span className="tabular-nums font-semibold">
                  {money(i.balance_minor, i.currency)}
                </span>
                {i.balance_minor > 0 && (
                  <a href={`/invoices/${i.id}`} className="btn-primary py-1 text-xs">
                    {t('billing.payment')}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </main>
  );
}
