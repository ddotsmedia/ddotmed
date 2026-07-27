'use client';

import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { WS_EVENTS } from '@medicore/shared-types';
import { api } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { useChannel, useRealtime } from '@/lib/realtime';
import { QueryState } from '@/components/ui';

interface QueueEntry {
  id: string;
  token: string;
  sequence: number;
  priority: number;
  status: string;
  counter: string | null;
}

interface QueueDisplay {
  queue_name: string;
  now_serving: QueueEntry[];
  waiting: QueueEntry[];
  waiting_count: number;
  generated_at: string;
}

export default function QueueDisplayPage() {
  return (
    <Suspense fallback={null}>
      <QueueBoard />
    </Suspense>
  );
}

function QueueBoard() {
  const params = useSearchParams();
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const queueName = params.get('queue') ?? 'general';
  const locationId = params.get('locationId') ?? undefined;

  useChannel(`queue:${queueName}`);
  const { on, connected } = useRealtime();

  const display = useQuery<QueueDisplay>({
    queryKey: ['queue', 'display', queueName, locationId],
    queryFn: () =>
      api.get<QueueDisplay>(`/appointments/queue/${queueName}/display`, {
        location_id: locationId,
      }),
    // WebSocket drives updates; the interval is a safety net for a dropped socket
    // on a display that nobody is watching to notice it went stale.
    refetchInterval: connected ? 60_000 : 10_000,
  });

  // Any queue event invalidates the board rather than patching it locally, so the
  // screen can never drift from the server's view of who is next.
  useEffect(() => {
    const off = on(WS_EVENTS.QUEUE_UPDATED, () => {
      void queryClient.invalidateQueries({ queryKey: ['queue', 'display'] });
    });
    return off;
  }, [on, queryClient]);

  const serving = display.data?.now_serving ?? [];
  const waiting = display.data?.waiting ?? [];

  return (
    <div className="min-h-[80dvh]">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold capitalize">{queueName} queue</h1>
        <span
          className={
            connected
              ? 'flex items-center gap-1.5 text-xs text-emerald-700'
              : 'flex items-center gap-1.5 text-xs text-slate-500'
          }
        >
          <span
            aria-hidden
            className={`size-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-slate-400'}`}
          />
          {connected ? t('common.online') : t('common.offline')}
        </span>
      </header>

      <QueryState isLoading={display.isLoading} error={display.error}>
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Now serving
          </h2>
          {serving.length === 0 ? (
            <p className="card text-center text-slate-500">—</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-3">
              {serving.map((entry, index) => (
                <li
                  key={entry.id}
                  className={
                    index === 0
                      ? 'rounded-xl border-4 border-sky-600 bg-sky-50 p-6 text-center dark:bg-sky-950/40'
                      : 'rounded-xl border border-slate-300 p-4 text-center dark:border-slate-600'
                  }
                >
                  <p
                    className={
                      index === 0
                        ? 'font-mono text-6xl font-black tracking-wider text-sky-800 dark:text-sky-300'
                        : 'font-mono text-3xl font-bold text-slate-700 dark:text-slate-200'
                    }
                  >
                    {entry.token}
                  </p>
                  {entry.counter && (
                    <p className="mt-1 text-sm font-medium text-slate-600 dark:text-slate-300">
                      Counter {entry.counter}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Waiting ({display.data?.waiting_count ?? 0})
          </h2>
          {waiting.length === 0 ? (
            <p className="card text-center text-slate-500">{t('common.noData')}</p>
          ) : (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {waiting.map((entry) => (
                <li
                  key={entry.id}
                  className={
                    entry.priority > 0
                      ? 'rounded-lg border-2 border-amber-400 bg-amber-50 py-3 text-center dark:bg-amber-950/30'
                      : 'rounded-lg border border-slate-300 py-3 text-center dark:border-slate-600'
                  }
                >
                  <span className="font-mono text-xl font-semibold">{entry.token}</span>
                  {/* Priority is stated, not just coloured. */}
                  {entry.priority > 0 && (
                    <span className="block text-[10px] font-bold uppercase text-amber-800">
                      priority
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </QueryState>
    </div>
  );
}
