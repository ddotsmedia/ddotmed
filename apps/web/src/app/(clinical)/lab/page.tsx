'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import clsx from 'clsx';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import {
  keys,
  useApiMutation,
  useCriticalResults,
  useLabWorklist,
  useNotifications,
  type AppNotification,
} from '@/lib/queries';
import { PageHeader, QueryState } from '@/components/ui';
import { LabOrdersTab } from '@/components/lab/LabOrdersTab';
import { LabResultsTab } from '@/components/lab/LabResultsTab';

type Tab = 'orders' | 'results';

function LabPageInner() {
  const { t, date } = useI18n();
  const { can } = usePermissions();
  const search = useSearchParams();

  const [tab, setTab] = useState<Tab>(search.get('tab') === 'results' ? 'results' : 'orders');
  const [patientId, setPatientId] = useState(search.get('patientId') ?? '');
  const encounterId = search.get('encounterId') ?? '';

  const worklist = useLabWorklist();
  const critical = useCriticalResults();
  const alerts = useNotifications({ category: 'lab-critical', unacknowledged: 'true' });

  const acknowledgeResult = useApiMutation<{ resultId: string }, unknown>(
    (body) => `/lab/results/${body.resultId}/acknowledge`,
    [keys.labCritical()],
  );
  const acknowledgeAlert = useApiMutation<{ id: string }, unknown>(
    (body) => `/notifications/${body.id}/acknowledge`,
    [keys.notifications({ category: 'lab-critical', unacknowledged: 'true' })],
    'patch',
  );

  const outstanding = (alerts.data ?? []) as AppNotification[];

  return (
    <>
      <PageHeader
        title={t('clinical.labOrders')}
        subtitle={worklist.data ? `${worklist.data.length} ${t('clinical.pendingOrders')}` : undefined}
      />

      {/* Unacknowledged critical values sit above the tabs: they are the one thing
          on this screen that has to be dealt with before anything else. */}
      {outstanding.length > 0 && (
        <section
          className="card mb-4 border-2 border-red-600 bg-red-50 dark:bg-red-950/40"
          role="alert"
        >
          <h2 className="mb-2 font-bold text-red-900 dark:text-red-100">
            ⛔ {t('clinical.criticalUnacknowledged')}
          </h2>
          <ul className="space-y-2">
            {outstanding.map((alert) => (
              <li
                key={alert.id}
                className="flex flex-wrap items-center gap-2 rounded border border-red-300 bg-white p-2 text-sm dark:border-red-800 dark:bg-slate-900"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{alert.title}</span>
                  <span className="block text-xs">{alert.body}</span>
                  <span className="block text-xs text-slate-500">{date(alert.created_at, true)}</span>
                </span>
                <button
                  type="button"
                  className="btn-danger py-1 text-xs"
                  onClick={() => acknowledgeAlert.mutate({ id: alert.id })}
                  disabled={acknowledgeAlert.isPending}
                >
                  {t('clinical.acknowledge')}
                </button>
              </li>
            ))}
          </ul>
          {acknowledgeAlert.error && (
            <p className="mt-2 text-sm text-red-800">{acknowledgeAlert.error.message}</p>
          )}
        </section>
      )}

      {/* Tabs scroll rather than wrap, so they stay one row on a phone. */}
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-700">
        {(['orders', 'results'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setTab(option)}
            className={clsx(
              'whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium',
              tab === option
                ? 'border-sky-600 text-sky-700 dark:text-sky-300'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200',
            )}
            aria-current={tab === option ? 'page' : undefined}
          >
            {option === 'orders' ? t('clinical.orders') : t('clinical.results')}
          </button>
        ))}
      </div>

      <label className="mb-4 block">
        <span className="label">{t('clinical.patient')}</span>
        <input
          className="input"
          value={patientId}
          placeholder="Patient id"
          onChange={(e) => setPatientId(e.target.value.trim())}
        />
      </label>

      {tab === 'orders' ? (
        <LabOrdersTab patientId={patientId} encounterId={encounterId} />
      ) : (
        <LabResultsTab patientId={patientId} />
      )}

      {/* The lab's own bench worklist stays visible under both tabs. */}
      <section className="card mt-4">
        <h2 className="mb-2 font-semibold">{t('clinical.pendingOrders')}</h2>
        <QueryState
          isLoading={worklist.isLoading}
          error={worklist.error}
          isEmpty={worklist.data?.length === 0}
        >
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.date')}</th>
                  <th>{t('clinical.patient')}</th>
                  <th>{t('clinical.labResults')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {worklist.data?.map((o) => {
                  const order = o as Record<string, unknown>;
                  const patient = order.patient as { mrn?: string; family_name?: string } | undefined;
                  const specimens = (order.specimens ?? []) as Array<{
                    barcode?: string;
                    status?: string;
                  }>;
                  return (
                    <tr key={String(order.id)}>
                      <td className="text-xs">{date(String(order.created_at), true)}</td>
                      <td>
                        {patient?.family_name}{' '}
                        <span className="font-mono text-xs">{patient?.mrn}</span>
                      </td>
                      <td>
                        {String(order.code_display)}
                        <span className="ms-2 font-mono text-xs text-slate-500">
                          {specimens[0]?.barcode}
                        </span>
                      </td>
                      <td>
                        <span
                          className={
                            order.priority === 'stat'
                              ? 'rounded bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800'
                              : 'text-xs'
                          }
                        >
                          {String(order.priority)}
                        </span>{' '}
                        {specimens[0]?.status}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </QueryState>
      </section>

      <section className="card mt-4 border-red-300">
        <h2 className="mb-2 font-semibold text-red-800">{t('clinical.criticalValue')}</h2>
        <QueryState
          isLoading={critical.isLoading}
          error={critical.error}
          isEmpty={critical.data?.length === 0}
          emptyMessage={t('common.noData')}
        >
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('clinical.patient')}</th>
                  <th>{t('clinical.labResults')}</th>
                  <th>{t('common.time')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {critical.data?.map((r) => {
                  const row = r as Record<string, unknown>;
                  const patient = row.patient as { mrn?: string; family_name?: string } | undefined;
                  return (
                    <tr key={String(row.id)} className="bg-red-50">
                      <td>
                        {patient?.family_name}{' '}
                        <span className="font-mono text-xs">{patient?.mrn}</span>
                      </td>
                      <td className="font-semibold text-red-800">
                        {String(row.display)}: {String(row.value_quantity ?? row.value_string ?? '')}{' '}
                        {String(row.unit ?? '')}
                        <span className="ms-2 rounded bg-red-600 px-1 text-xs text-white">
                          {String(row.interpretation ?? '')}
                        </span>
                      </td>
                      <td className="text-xs">{date(String(row.performed_at), true)}</td>
                      <td>
                        {can('lab:result') && (
                          <button
                            type="button"
                            className="btn-secondary py-1 text-xs"
                            onClick={() => acknowledgeResult.mutate({ resultId: String(row.id) })}
                            disabled={acknowledgeResult.isPending}
                          >
                            {t('clinical.acknowledge')}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </QueryState>
      </section>
    </>
  );
}

export default function LabPage() {
  // useSearchParams needs a suspense boundary to keep the route statically shell-able.
  return (
    <Suspense fallback={null}>
      <LabPageInner />
    </Suspense>
  );
}
