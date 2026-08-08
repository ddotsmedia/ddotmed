/**
 * Denial risk, scored from rules rather than from a model.
 *
 * Deliberately deterministic: a coder who is told a claim is risky needs to know
 * which fact made it risky so they can fix it before submitting. A probability
 * with no attributable cause gets ignored after the second time it is wrong.
 *
 * The score is basis points of risk, and every point of it is traceable to a
 * named factor.
 */

export interface RiskFactor {
  code: string;
  weight_bp: number;
  detail: string;
  /** What the coder should do about it. */
  remedy: string;
}

export interface ClaimUnderReview {
  diagnosis_codes: readonly string[];
  procedure_codes: readonly string[];
  claimed_minor: number;
  currency: string;
  /** Whether the payer required pre-authorisation and whether one is attached. */
  requires_pre_auth: boolean;
  has_pre_auth: boolean;
  /** Days between the service and this submission. */
  days_since_service: number;
  /** The payer's filing deadline in days, when it is known. */
  filing_limit_days?: number | null;
  /** Service codes this payer excludes from cover. */
  excluded_codes?: readonly string[];
  /** How many of this payer's claims were denied recently, in basis points. */
  payer_denial_rate_bp?: number;
  documentation_complete?: boolean;
}

export type RiskLevel = 'low' | 'medium' | 'high';

export interface DenialRiskAssessment {
  /** 0–10 000. Capped, because a claim cannot be more than certain to be denied. */
  risk_bp: number;
  level: RiskLevel;
  factors: RiskFactor[];
  /** Ordered, most valuable first — what to fix before submitting. */
  recommended_actions: string[];
}

/** Above this a claim is worth holding back for review rather than submitting. */
export const HIGH_RISK_BP = 6_000;
export const MEDIUM_RISK_BP = 3_000;

const upper = (value: string): string => value.trim().toUpperCase();

/**
 * Scores a claim. Each rule contributes independently and the total is capped,
 * so adding a rule can never quietly rescale the others.
 */
export function assessDenialRisk(claim: ClaimUnderReview): DenialRiskAssessment {
  const factors: RiskFactor[] = [];

  if (claim.diagnosis_codes.length === 0) {
    factors.push({
      code: 'NO_DIAGNOSIS',
      weight_bp: 4_500,
      detail: 'The claim carries no diagnosis code',
      remedy: 'Add the diagnosis that justifies each billed service',
    });
  }

  if (claim.procedure_codes.length === 0) {
    factors.push({
      code: 'NO_PROCEDURE',
      weight_bp: 3_000,
      detail: 'The claim carries no procedure or service code',
      remedy: 'Add the CPT or service codes for what was actually done',
    });
  }

  if (claim.requires_pre_auth && !claim.has_pre_auth) {
    factors.push({
      code: 'MISSING_PRE_AUTH',
      weight_bp: 5_000,
      detail: 'This payer requires pre-authorisation at this value and none is attached',
      remedy: 'Obtain pre-authorisation before submitting, or attach the existing reference',
    });
  }

  const excluded = new Set((claim.excluded_codes ?? []).map(upper));
  const hits = claim.procedure_codes.filter((code) => excluded.has(upper(code)));
  if (hits.length > 0) {
    factors.push({
      code: 'EXCLUDED_SERVICE',
      weight_bp: 4_000,
      detail: `The payer excludes ${hits.join(', ')} from cover`,
      remedy: 'Remove the excluded lines or bill them to the patient',
    });
  }

  if (claim.filing_limit_days != null && claim.days_since_service > claim.filing_limit_days) {
    factors.push({
      code: 'PAST_FILING_LIMIT',
      weight_bp: 6_000,
      detail: `Submitted ${claim.days_since_service} days after service, past the ${claim.filing_limit_days}-day limit`,
      remedy: 'Submit with a late-filing justification, or write the claim off',
    });
  } else if (claim.days_since_service > 60) {
    factors.push({
      code: 'LATE_SUBMISSION',
      weight_bp: 1_500,
      detail: `Submitted ${claim.days_since_service} days after the service date`,
      remedy: 'Submit promptly; most payers tighten scrutiny past 60 days',
    });
  }

  if (claim.documentation_complete === false) {
    factors.push({
      code: 'INCOMPLETE_DOCUMENTATION',
      weight_bp: 2_500,
      detail: 'The supporting documentation is marked incomplete',
      remedy: 'Attach the clinical notes and results that evidence the billed services',
    });
  }

  // A payer that denies a lot denies this one too. Weighted at a third so a bad
  // payer raises the score without swamping a fixable problem on the claim.
  const payerRate = claim.payer_denial_rate_bp ?? 0;
  if (payerRate > 1_500) {
    factors.push({
      code: 'PAYER_HISTORY',
      weight_bp: Math.round(payerRate / 3),
      detail: `This payer has denied ${(payerRate / 100).toFixed(1)}% of recent claims`,
      remedy: 'Double-check coding and attachments against this payer’s rules',
    });
  }

  const raw = factors.reduce((sum, f) => sum + f.weight_bp, 0);
  const risk = Math.min(10_000, raw);

  return {
    risk_bp: risk,
    level: risk >= HIGH_RISK_BP ? 'high' : risk >= MEDIUM_RISK_BP ? 'medium' : 'low',
    factors,
    recommended_actions: [...factors]
      .sort((a, b) => b.weight_bp - a.weight_bp)
      .map((f) => f.remedy),
  };
}

/**
 * Merges model-suggested codes into what the coder already has.
 *
 * Suggestions are never applied: they are returned alongside the claim, flagged
 * for approval, with anything already on the claim marked so a coder is not asked
 * to re-approve their own work.
 */
export interface SuggestedCode {
  system: string;
  code: string;
  display: string;
  confidence: number;
  rationale?: string | null;
}

export interface ReviewedSuggestion extends SuggestedCode {
  already_on_claim: boolean;
  /** Below the governance threshold the suggestion is advisory only. */
  low_confidence: boolean;
}

/** Confidence below this is surfaced but flagged, matching the AI governance rule. */
export const SUGGESTION_CONFIDENCE_FLOOR = 0.7;

export function reviewSuggestions(
  suggestions: readonly SuggestedCode[],
  onClaim: { diagnosis_codes: readonly string[]; procedure_codes: readonly string[] },
): ReviewedSuggestion[] {
  const existing = new Set([...onClaim.diagnosis_codes, ...onClaim.procedure_codes].map(upper));

  return suggestions
    .filter((s) => s.code.trim().length > 0)
    .map((s) => ({
      ...s,
      confidence: Math.min(1, Math.max(0, s.confidence)),
      already_on_claim: existing.has(upper(s.code)),
      low_confidence: s.confidence < SUGGESTION_CONFIDENCE_FLOOR,
    }))
    .sort((a, b) => Number(a.already_on_claim) - Number(b.already_on_claim) || b.confidence - a.confidence);
}
