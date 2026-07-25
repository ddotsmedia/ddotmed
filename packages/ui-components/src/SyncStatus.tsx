import clsx from 'clsx';

export type SyncState = 'online' | 'offline' | 'syncing' | 'synced' | 'failed';

export interface SyncStatusProps {
  state: SyncState;
  pendingCount?: number;
  lastSyncedAt?: string;
  t: (key: string) => string;
  onRetry?: () => void;
  className?: string;
}

const TONE: Record<SyncState, string> = {
  online: 'bg-emerald-100 text-emerald-800',
  synced: 'bg-emerald-100 text-emerald-800',
  syncing: 'bg-sky-100 text-sky-800',
  offline: 'bg-slate-200 text-slate-800',
  failed: 'bg-red-100 text-red-800',
};

const LABEL: Record<SyncState, string> = {
  online: 'common.online',
  synced: 'common.synced',
  syncing: 'common.syncing',
  offline: 'common.offline',
  failed: 'common.syncFailed',
};

export function SyncStatus({
  state,
  pendingCount = 0,
  lastSyncedAt,
  t,
  onRetry,
  className,
}: SyncStatusProps) {
  return (
    <div
      className={clsx(
        'inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium',
        TONE[state],
        className,
      )}
      role="status"
      aria-live="polite"
      data-testid="sync-status"
      data-state={state}
    >
      <span
        aria-hidden
        className={clsx(
          'size-2 rounded-full',
          state === 'syncing' && 'animate-pulse bg-sky-600',
          (state === 'online' || state === 'synced') && 'bg-emerald-600',
          state === 'offline' && 'bg-slate-500',
          state === 'failed' && 'bg-red-600',
        )}
      />
      <span>{t(LABEL[state])}</span>
      {pendingCount > 0 && <span className="font-mono">({pendingCount})</span>}
      {lastSyncedAt && state !== 'syncing' && <time className="opacity-70">{lastSyncedAt}</time>}
      {state === 'failed' && onRetry && (
        <button type="button" onClick={onRetry} className="underline">
          {t('common.refresh')}
        </button>
      )}
    </div>
  );
}
