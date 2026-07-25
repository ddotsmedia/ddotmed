'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { useChannel } from '@/lib/realtime';
import { keys, useApiMutation, useAppointments, useQueueState } from '@/lib/queries';
import { PageHeader, QueryState, Field } from '@/components/ui';

const today = () => new Date().toISOString().slice(0, 10);

export default function AppointmentsPage() {
  const { t, date } = useI18n();
  const { can } = usePermissions();
  const [day, setDay] = useState(today());
  const [queueName] = useState('general');

  useChannel(`queue:${queueName}`);

  const appointments = useAppointments({
    from: `${day}T00:00:00.000Z`,
    to: `${day}T23:59:59.999Z`,
  });
  const queue = useQueueState(queueName);

  const checkIn = useApiMutation<{ appointmentId: string }, unknown>(
    (body) => `/appointments/${body.appointmentId}/check-in`,
    [keys.appointments({ from: `${day}T00:00:00.000Z`, to: `${day}T23:59:59.999Z` }), keys.queue(queueName)],
  );

  const callNext = useApiMutation<{ counter: string }, unknown>(
    `/appointments/queue/${queueName}/call-next`,
    [keys.queue(queueName)],
  );

  return (
    <>
      <PageHeader
        title={t('clinical.appointment')}
        actions={
          <input
            type="date"
            className="input w-auto"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <QueryState
            isLoading={appointments.isLoading}
            error={appointments.error}
            isEmpty={appointments.data?.length === 0}
          >
            <div className="card overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('common.time')}</th>
                    <th>{t('clinical.patient')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('billing.denialRisk')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {appointments.data?.map((a) => {
                    const appt = a as Record<string, unknown>;
                    const patient = appt.patient as
                      | { mrn?: string; family_name?: string; given_names?: string[] }
                      | undefined;
                    const risk = Number(appt.noshow_risk ?? 0);
                    return (
                      <tr key={String(appt.id)}>
                        <td className="tabular-nums text-xs">{date(String(appt.start), true)}</td>
                        <td>
                          {patient?.given_names?.[0]} {patient?.family_name}
                          <span className="ms-2 font-mono text-xs text-slate-500">{patient?.mrn}</span>
                        </td>
                        <td>
                          <span className="text-xs">{String(appt.status)}</span>
                          {Boolean(appt.queue_token) && (
                            <span className="ms-2 rounded bg-sky-100 px-1.5 font-mono text-xs text-sky-800">
                              {String(appt.queue_token)}
                            </span>
                          )}
                        </td>
                        <td>
                          {risk > 0 && (
                            <span
                              className={
                                risk >= 0.6
                                  ? 'rounded bg-red-100 px-1.5 text-xs text-red-800'
                                  : risk >= 0.3
                                    ? 'rounded bg-amber-100 px-1.5 text-xs text-amber-800'
                                    : 'text-xs text-slate-500'
                              }
                            >
                              {(risk * 100).toFixed(0)}%
                            </span>
                          )}
                        </td>
                        <td>
                          {can('patient:write') && appt.status === 'booked' && (
                            <button
                              type="button"
                              className="btn-secondary py-1 text-xs"
                              onClick={() => checkIn.mutate({ appointmentId: String(appt.id) })}
                              disabled={checkIn.isPending}
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
          <h2 className="mb-2 font-semibold">{t('clinical.queueToken')}</h2>

          {can('patient:write') && (
            <button
              type="button"
              className="btn-primary mb-3 w-full"
              onClick={() => callNext.mutate({ counter: '1' })}
              disabled={callNext.isPending}
            >
              {t('common.next')}
            </button>
          )}

          <QueryState isLoading={queue.isLoading} error={queue.error} isEmpty={queue.data?.length === 0}>
            <ul className="space-y-1">
              {queue.data?.map((q) => {
                const entry = q as Record<string, unknown>;
                const status = String(entry.status);
                return (
                  <li
                    key={String(entry.id)}
                    className={
                      status === 'called'
                        ? 'flex items-center justify-between rounded bg-sky-100 px-2 py-1 text-sm font-semibold text-sky-900'
                        : 'flex items-center justify-between rounded px-2 py-1 text-sm'
                    }
                  >
                    <span className="font-mono">{String(entry.token)}</span>
                    <span className="text-xs">{status}</span>
                    {entry.estimated_wait_minutes != null && status === 'waiting' && (
                      <span className="text-xs text-slate-500">
                        ~{String(entry.estimated_wait_minutes)}m
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </QueryState>
        </section>
      </div>
    </>
  );
}
