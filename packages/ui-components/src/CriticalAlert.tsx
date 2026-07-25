import clsx from 'clsx';
import type { AlertSeverity } from '@medicore/shared-types';

export interface CriticalAlertProps {
  severity: AlertSeverity;
  title: string;
  detail?: string;
  value?: string;
  referenceRange?: string;
  occurredAt?: string;
  /** Full-screen blocking presentation, used for wrong-patient and life-threatening alerts. */
  fullScreen?: boolean;
  acknowledgeLabel?: string;
  onAcknowledge?: () => void;
  className?: string;
}

const TONE: Record<AlertSeverity, string> = {
  info: 'border-sky-400 bg-sky-50 text-sky-900',
  warning: 'border-amber-400 bg-amber-50 text-amber-900',
  critical: 'border-red-500 bg-red-50 text-red-900',
  'life-threatening': 'border-red-800 bg-red-700 text-white',
};

const ICON: Record<AlertSeverity, string> = {
  info: 'ℹ',
  warning: '⚠',
  critical: '⚠',
  'life-threatening': '⛔',
};

export function CriticalAlert({
  severity,
  title,
  detail,
  value,
  referenceRange,
  occurredAt,
  fullScreen = false,
  acknowledgeLabel = 'Acknowledge',
  onAcknowledge,
  className,
}: CriticalAlertProps) {
  const body = (
    <div
      // assertive so screen readers interrupt; critical values must not wait for a pause.
      role="alert"
      aria-live={severity === 'info' ? 'polite' : 'assertive'}
      className={clsx(
        'rounded-lg border-2 p-4 shadow-md',
        TONE[severity],
        fullScreen && 'w-full max-w-lg',
        className,
      )}
      data-testid="critical-alert"
      data-severity={severity}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="text-2xl leading-none">
          {ICON[severity]}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold uppercase tracking-wide">{title}</p>
          {detail && <p className="mt-1 text-sm">{detail}</p>}
          {value && (
            <p className="mt-2 font-mono text-lg font-bold">
              {value}
              {referenceRange && (
                <span className="ms-2 text-xs font-normal opacity-80">({referenceRange})</span>
              )}
            </p>
          )}
          {occurredAt && <p className="mt-1 text-xs opacity-75">{occurredAt}</p>}
        </div>
      </div>
      {onAcknowledge && (
        <button
          type="button"
          onClick={onAcknowledge}
          className="mt-3 w-full rounded bg-white/90 px-3 py-2 text-sm font-semibold text-slate-900 hover:bg-white"
        >
          {acknowledgeLabel}
        </button>
      )}
    </div>
  );

  if (!fullScreen) return body;
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
    >
      {body}
    </div>
  );
}
