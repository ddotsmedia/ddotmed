'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { ApiError } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { Field } from '@/components/ui';
import type { DispenseQueueEntry } from '@/lib/queries';

export interface DispenseBody {
  quantity: number;
  scanned_patient_barcode?: string;
  scanned_medication_barcode?: string;
  barcode_override_reason?: string;
  batch_no?: string;
  witness_id?: string | null;
  partial_dispense: boolean;
  override_reason?: string;
}

interface SafetyWarning {
  substance?: string;
  criticality?: string;
  reaction?: string[];
  drug_a?: string;
  drug_b?: string;
  severity?: string;
  explanation?: string;
}

/**
 * The confirmation sheet, shown as a bottom sheet on a phone and a dialog on a
 * desk. Nothing is dispensed from the queue card itself: the pharmacist confirms
 * the quantity, the batch and the safety warnings on one screen first.
 */
export function DispenseSheet({
  entry,
  pending,
  error,
  result,
  onSubmit,
  onClose,
}: {
  entry: DispenseQueueEntry;
  pending: boolean;
  error: ApiError | null;
  result: Record<string, unknown> | null;
  onSubmit: (body: DispenseBody) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();

  const [quantity, setQuantity] = useState(String(entry.quantity));
  const [patientBarcode, setPatientBarcode] = useState('');
  const [medicationBarcode, setMedicationBarcode] = useState('');
  const [scanMode, setScanMode] = useState(true);
  const [overrideReason, setOverrideReason] = useState('');
  const [barcodeOverride, setBarcodeOverride] = useState('');
  const [batchNo, setBatchNo] = useState('');
  const [witnessId, setWitnessId] = useState('');
  const [partial, setPartial] = useState(false);

  useEffect(() => {
    setQuantity(String(entry.quantity));
  }, [entry.id, entry.quantity]);

  const body = error?.body as
    | {
        code?: string;
        available_quantity?: number;
        allergy_warnings?: SafetyWarning[];
        interaction_warnings?: SafetyWarning[];
        allergies?: SafetyWarning[];
        findings?: SafetyWarning[];
        override_allowed?: boolean;
      }
    | null
    | undefined;

  // 422 is absolute; 409 with override_allowed can be passed with a reason.
  const hardBlock = error?.status === 422;
  const needsOverride = error?.status === 409 && body?.override_allowed === true;
  const shortStock = body?.code === 'INSUFFICIENT_STOCK';
  const needsWitness = entry.is_controlled;

  const allergyWarnings = body?.allergy_warnings ?? body?.allergies ?? [];
  const interactionWarnings = body?.interaction_warnings ?? body?.findings ?? [];

  const ready =
    Number(quantity) > 0 &&
    (!needsWitness || witnessId.trim().length > 0) &&
    (scanMode
      ? patientBarcode.trim().length > 0 && medicationBarcode.trim().length > 0
      : barcodeOverride.trim().length >= 10) &&
    (!needsOverride || overrideReason.trim().length >= 10) &&
    !hardBlock;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={t('clinical.confirmDispense')}
    >
      <div className="max-h-[90dvh] w-full overflow-y-auto rounded-t-xl bg-white p-4 shadow-xl sm:max-w-lg sm:rounded-xl dark:bg-slate-900">
        <div className="mb-3 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">{t('clinical.confirmDispense')}</h2>
            <p className="truncate text-sm">
              {entry.patient.given_names.join(' ')} {entry.patient.family_name} ·{' '}
              <span className="font-mono text-xs">{entry.patient.mrn}</span>
            </p>
            <p className="text-sm">{entry.code_display}</p>
          </div>
          <button type="button" className="text-sm underline" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>

        {result ? (
          <div className="rounded border border-emerald-400 bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            <p className="font-semibold">
              {t('clinical.dispensed')} — {String(result.dispensed_quantity ?? '')}{' '}
              {result.partial ? `/ ${String(result.requested_quantity ?? '')}` : ''}
            </p>
            <ul className="mt-1 space-y-0.5 text-xs">
              {((result.picked ?? []) as Array<Record<string, unknown>>).map((line, i) => (
                <li key={`${String(line.batch_number)}-${i}`}>
                  {t('clinical.batch')} {String(line.batch_number)} · {String(line.quantity)} ·{' '}
                  {t('clinical.expiry')} {String(line.expiry_date).slice(0, 10)}
                </li>
              ))}
            </ul>
            <button type="button" className="btn-primary mt-3 w-full" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit({
                quantity: Number(quantity),
                ...(scanMode
                  ? {
                      scanned_patient_barcode: patientBarcode.trim(),
                      scanned_medication_barcode: medicationBarcode.trim(),
                    }
                  : { barcode_override_reason: barcodeOverride.trim() }),
                batch_no: batchNo.trim() || undefined,
                witness_id: witnessId.trim() || null,
                partial_dispense: partial,
                override_reason: overrideReason.trim() || undefined,
              });
            }}
          >
            {/* Safety warnings are re-shown here, at the last point the drug can be stopped. */}
            {allergyWarnings.length > 0 && (
              <div
                className={clsx(
                  'rounded border px-3 py-2 text-sm',
                  hardBlock
                    ? 'border-2 border-red-600 bg-red-50 text-red-900'
                    : 'border-amber-500 bg-amber-50 text-amber-900',
                )}
                role="alert"
              >
                <p className="font-bold">
                  {hardBlock ? '⛔' : '⚠'} {t('clinical.allergies')}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {allergyWarnings.map((w, i) => (
                    <li key={`${w.substance}-${i}`}>
                      <span className="font-semibold">{w.substance}</span>
                      {w.reaction?.length ? <> — {w.reaction.join(', ')}</> : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {interactionWarnings.length > 0 && (
              <div
                className={clsx(
                  'rounded border px-3 py-2 text-sm',
                  hardBlock
                    ? 'border-2 border-red-600 bg-red-50 text-red-900'
                    : 'border-amber-500 bg-amber-50 text-amber-900',
                )}
                role="alert"
              >
                <p className="font-bold">
                  {hardBlock ? '⛔' : '⚠'} {t('clinical.interactionsFound')}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {interactionWarnings.map((w, i) => (
                    <li key={`${w.drug_a}-${w.drug_b}-${i}`}>
                      <span className="font-semibold">
                        {w.drug_a} + {w.drug_b} — {w.severity}
                      </span>
                      {w.explanation && <span className="block text-xs">{w.explanation}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {shortStock && (
              <div className="rounded border border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
                <p className="font-semibold">{t('clinical.insufficientStock')}</p>
                <p className="text-xs">
                  {t('clinical.onHand')}: {body?.available_quantity ?? 0}
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label={t('clinical.quantity')} required>
                <input
                  type="number"
                  min="1"
                  className="input"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </Field>
              <Field label={t('clinical.batch')}>
                <input
                  className="input"
                  value={batchNo}
                  placeholder="FEFO if blank"
                  onChange={(e) => setBatchNo(e.target.value)}
                />
              </Field>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={scanMode}
                onChange={(e) => setScanMode(e.target.checked)}
              />
              {t('clinical.barcodeVerified')}
            </label>

            {scanMode ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('clinical.patient')} required>
                  <input
                    className="input font-mono"
                    value={patientBarcode}
                    autoComplete="off"
                    onChange={(e) => setPatientBarcode(e.target.value)}
                  />
                </Field>
                <Field label={t('clinical.medications')} required>
                  <input
                    className="input font-mono"
                    value={medicationBarcode}
                    autoComplete="off"
                    onChange={(e) => setMedicationBarcode(e.target.value)}
                  />
                </Field>
              </div>
            ) : (
              <Field label={t('clinical.barcodeOverride')} required>
                <textarea
                  className="input min-h-16"
                  value={barcodeOverride}
                  onChange={(e) => setBarcodeOverride(e.target.value)}
                />
              </Field>
            )}

            {/* The witness field exists only for a scheduled drug, and only then. */}
            {needsWitness && (
              <Field label={`${t('clinical.witness')} — ${entry.controlled_schedule}`} required>
                <input
                  className="input"
                  value={witnessId}
                  placeholder="Witness user id"
                  onChange={(e) => setWitnessId(e.target.value)}
                />
              </Field>
            )}

            {needsOverride && (
              <Field label={t('clinical.overrideReason')} required>
                <textarea
                  className="input min-h-16"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                />
              </Field>
            )}

            {shortStock && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={partial}
                  onChange={(e) => setPartial(e.target.checked)}
                />
                {t('clinical.partialDispense')}
              </label>
            )}

            {error && !allergyWarnings.length && !interactionWarnings.length && !shortStock && (
              <p
                className={clsx(
                  'rounded px-3 py-2 text-sm',
                  hardBlock
                    ? 'border-2 border-red-600 bg-red-50 text-red-900'
                    : 'border border-amber-500 bg-amber-50 text-amber-900',
                )}
                role="alert"
              >
                {error.message}
              </p>
            )}

            <div className="flex gap-2">
              <button type="submit" className="btn-primary flex-1" disabled={!ready || pending}>
                {t('clinical.confirmDispense')}
              </button>
              <button type="button" className="btn-secondary" onClick={onClose}>
                {t('common.cancel')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
