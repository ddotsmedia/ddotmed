'use client';

import clsx from 'clsx';
import { LoadingSpinner } from '@medicore/ui-components';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
      <div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-50">{title}</h1>
        {subtitle && <p className="text-sm text-slate-600 dark:text-slate-300">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Single place that renders query state. Server-sent clinical blocks are surfaced
 * with their full detail rather than collapsed into a generic error.
 */
export function QueryState({
  isLoading,
  error,
  isEmpty,
  emptyMessage,
  children,
}: {
  isLoading: boolean;
  error: Error | null;
  isEmpty?: boolean;
  emptyMessage?: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();

  if (isLoading) return <LoadingSpinner fullScreen label={t('common.loading')} />;

  if (error) {
    const apiError = error instanceof ApiError ? error : null;
    return (
      <div className="card border-red-300 bg-red-50 text-red-900" role="alert">
        <p className="font-semibold">{apiError?.isClinicalBlock ? t('common.error') : t('errors.generic')}</p>
        <p className="mt-1 text-sm">{error.message}</p>
        {apiError?.code && <p className="mt-1 font-mono text-xs opacity-75">{apiError.code}</p>}
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="card text-center text-sm text-slate-500">{emptyMessage ?? t('common.noData')}</div>
    );
  }

  return <>{children}</>;
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'neutral' | 'ok' | 'warning' | 'critical';
}) {
  return (
    <div
      className={clsx(
        'card',
        tone === 'ok' && 'border-emerald-300',
        tone === 'warning' && 'border-amber-300',
        tone === 'critical' && 'border-red-400',
      )}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p
        className={clsx(
          'mt-1 text-2xl font-bold tabular-nums',
          tone === 'critical' && 'text-red-700',
          tone === 'warning' && 'text-amber-700',
          tone === 'ok' && 'text-emerald-700',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function Field({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">
        {label}
        {required && <span className="ms-1 text-red-600">*</span>}
      </span>
      {children}
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

const EWS_TONE: Record<string, string> = {
  low: 'bg-emerald-100 text-emerald-900',
  medium: 'bg-amber-100 text-amber-900',
  high: 'bg-red-600 text-white',
};

export function EwsBadge({ score, risk }: { score: number | null; risk: string | null }) {
  const { t } = useI18n();
  if (score === null || risk === null) return <span className="text-xs text-slate-400">—</span>;
  return (
    <span
      className={clsx('inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-bold', EWS_TONE[risk])}
      title={t('clinical.ews')}
    >
      {risk === 'high' && <span aria-hidden>⚠</span>}
      {t('clinical.ews')} {score}
    </span>
  );
}
