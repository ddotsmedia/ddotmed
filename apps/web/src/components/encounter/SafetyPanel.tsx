'use client';

import clsx from 'clsx';
import { useI18n } from '@/lib/i18n';

export interface AllergyWarning {
  allergy_id: string;
  substance: string;
  criticality: string;
  reaction: string[];
  action: 'block' | 'warn';
}

export interface InteractionWarning {
  drug_a: string;
  drug_b: string;
  severity: 'contraindicated' | 'major' | 'moderate' | 'minor';
  clinical_effect: string;
  management: string | null;
  explanation: string;
  action: 'block' | 'override' | 'warn';
  source: 'tenant' | 'bundled';
}

export interface Preflight {
  allergy: { blocked: boolean; warnings: AllergyWarning[] };
  interaction: { blocked: boolean; requires_override: boolean; findings: InteractionWarning[] };
  can_prescribe: boolean;
  requires_override: boolean;
}

const SEVERITY_STYLE: Record<string, string> = {
  contraindicated: 'border-red-500 bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200',
  major: 'border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
  moderate: 'border-sky-400 bg-sky-50 text-sky-900 dark:bg-sky-950/40 dark:text-sky-200',
  minor: 'border-slate-300 bg-slate-50 text-slate-700 dark:bg-slate-900 dark:text-slate-300',
};

/**
 * The safety readout above the prescribing form.
 *
 * A blocking finding is rendered red and solid; an overridable one amber with the
 * reason field attached to it, so the clinician cannot type a justification
 * without the warning it justifies being on screen next to it.
 */
export function SafetyPanel({
  preflight,
  checking,
  drugName,
  overrideReason,
  onOverrideReasonChange,
}: {
  preflight: Preflight | null;
  checking: boolean;
  drugName: string;
  overrideReason: string;
  onOverrideReasonChange: (next: string) => void;
}) {
  const { t } = useI18n();

  if (checking) {
    return (
      <p className="rounded border border-slate-200 px-3 py-2 text-sm text-slate-500 dark:border-slate-700">
        {t('clinical.safetyChecksRunning')}…
      </p>
    );
  }

  if (!preflight) return null;

  const blockingAllergies = preflight.allergy.warnings.filter((w) => w.action === 'block');
  const warnAllergies = preflight.allergy.warnings.filter((w) => w.action === 'warn');
  const findings = preflight.interaction.findings;
  const needsReason = preflight.requires_override;

  return (
    <div className="space-y-2">
      {blockingAllergies.length > 0 && (
        <div
          className="rounded border-2 border-red-600 bg-red-50 px-3 py-2 text-sm text-red-900 dark:bg-red-950/50 dark:text-red-100"
          role="alert"
        >
          <p className="font-bold uppercase tracking-wide">
            ⛔ {t('clinical.allergyHigh')}
          </p>
          <ul className="mt-1 space-y-0.5">
            {blockingAllergies.map((a) => (
              <li key={a.allergy_id}>
                <span className="font-semibold">{a.substance}</span>
                {a.reaction.length > 0 && <> — {a.reaction.join(', ')}</>}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs">{drugName}</p>
        </div>
      )}

      {warnAllergies.length > 0 && (
        <div
          className="rounded border border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
          role="alert"
        >
          <p className="font-semibold">⚠ {t('clinical.allergyLow')}</p>
          <ul className="mt-1 space-y-0.5">
            {warnAllergies.map((a) => (
              <li key={a.allergy_id}>
                <span className="font-semibold">{a.substance}</span>
                {a.reaction.length > 0 && <> — {a.reaction.join(', ')}</>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {findings.length > 0 && (
        <div className="space-y-2">
          <p className="label mb-0">{t('clinical.interactionsFound')}</p>
          {findings.map((f) => (
            <div
              key={`${f.drug_a}-${f.drug_b}-${f.severity}`}
              className={clsx('rounded border px-3 py-2 text-sm', SEVERITY_STYLE[f.severity])}
              role={f.action === 'block' ? 'alert' : undefined}
            >
              <p className="font-semibold">
                {f.action === 'block' ? '⛔' : f.action === 'override' ? '⚠' : 'ℹ'}{' '}
                {f.drug_a} + {f.drug_b} — {f.severity}
              </p>
              <p className="mt-0.5">{f.explanation}</p>
              {f.management && <p className="mt-0.5 text-xs opacity-80">{f.management}</p>}
              {f.source === 'bundled' && (
                <p className="mt-0.5 text-xs opacity-60">Bundled reference</p>
              )}
            </div>
          ))}
        </div>
      )}

      {findings.length === 0 && preflight.allergy.warnings.length === 0 && (
        <p className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
          ✓ {t('clinical.noInteractions')}
        </p>
      )}

      {needsReason && preflight.can_prescribe && (
        <label className="block">
          <span className="label">
            {t('clinical.overrideReason')}
            <span className="ms-1 text-red-600">*</span>
          </span>
          <textarea
            className="input min-h-16"
            value={overrideReason}
            minLength={10}
            onChange={(e) => onOverrideReasonChange(e.target.value)}
            placeholder="Why is this the right prescription for this patient?"
          />
        </label>
      )}
    </div>
  );
}
