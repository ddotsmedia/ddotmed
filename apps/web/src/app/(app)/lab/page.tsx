'use client';

import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { keys, useApiMutation, useCriticalResults, useLabWorklist } from '@/lib/queries';
import { PageHeader, QueryState } from '@/components/ui';

export default function LabPage() {
  const { t, date } = useI18n();
  const { can } = usePermissions();

  const worklist = useLabWorklist();
  const critical = useCriticalResults();

  const acknowledge = useApiMutation<{ resultId: string }, unknown>(
    (body) => `/lab/results/${body.resultId}/acknowledge`,
    [keys.labCritical()],
  );

  return (
    <>
      <PageHeader title={t('clinical.labResults')} />

      <section className="card mb-4 border-red-300">
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
                            onClick={() => acknowledge.mutate({ resultId: String(row.id) })}
                            disabled={acknowledge.isPending}
                          >
                            {t('common.confirm')}
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

      <section className="card">
        <h2 className="mb-2 font-semibold">{t('common.actions')}</h2>
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
                  const specimens = (order.specimens ?? []) as Array<{ barcode?: string; status?: string }>;
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
    </>
  );
}
