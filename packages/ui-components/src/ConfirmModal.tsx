'use client';

import { useEffect, useId, useRef, useState } from 'react';
import clsx from 'clsx';

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: 'default' | 'danger';
  /** When set, the user must type this exact string before confirming (destructive PHI actions). */
  requireTypedConfirmation?: string;
  /** When set, a free-text reason is mandatory and returned to onConfirm (audit trail). */
  requireReason?: boolean;
  busy?: boolean;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  requireTypedConfirmation,
  requireReason = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const titleId = useId();
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      setTyped('');
      setReason('');
      return;
    }
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const typedOk = !requireTypedConfirmation || typed === requireTypedConfirmation;
  const reasonOk = !requireReason || reason.trim().length >= 5;
  const canConfirm = typedOk && reasonOk && !busy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl dark:bg-slate-800"
        data-testid="confirm-modal"
      >
        <h3 id={titleId} className="text-lg font-semibold text-slate-900 dark:text-slate-50">
          {title}
        </h3>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{message}</p>

        {requireTypedConfirmation && (
          <label className="mt-4 block text-sm">
            <span className="text-slate-700 dark:text-slate-200">
              Type <code className="font-mono font-bold">{requireTypedConfirmation}</code> to confirm
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 dark:border-slate-600 dark:bg-slate-900"
              autoComplete="off"
            />
          </label>
        )}

        {requireReason && (
          <label className="mt-4 block text-sm">
            <span className="text-slate-700 dark:text-slate-200">Reason (recorded in audit log)</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 dark:border-slate-600 dark:bg-slate-900"
            />
          </label>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium dark:border-slate-600"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={() => onConfirm(requireReason ? reason.trim() : undefined)}
            className={clsx(
              'rounded px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50',
              tone === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-sky-600 hover:bg-sky-700',
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
