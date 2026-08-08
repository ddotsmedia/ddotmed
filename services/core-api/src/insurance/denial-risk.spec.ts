import {
  HIGH_RISK_BP,
  MEDIUM_RISK_BP,
  SUGGESTION_CONFIDENCE_FLOOR,
  assessDenialRisk,
  reviewSuggestions,
  type ClaimUnderReview,
} from './denial-risk';

const claim = (over: Partial<ClaimUnderReview> = {}): ClaimUnderReview => ({
  diagnosis_codes: ['J18.9'],
  procedure_codes: ['99213'],
  claimed_minor: 50_000,
  currency: 'AED',
  requires_pre_auth: false,
  has_pre_auth: false,
  days_since_service: 3,
  documentation_complete: true,
  ...over,
});

describe('assessDenialRisk', () => {
  it('scores a complete, prompt claim as low risk with nothing to fix', () => {
    const result = assessDenialRisk(claim());
    expect(result.risk_bp).toBe(0);
    expect(result.level).toBe('low');
    expect(result.factors).toEqual([]);
    expect(result.recommended_actions).toEqual([]);
  });

  it('names the missing diagnosis rather than only scoring it', () => {
    const result = assessDenialRisk(claim({ diagnosis_codes: [] }));
    const factor = result.factors.find((f) => f.code === 'NO_DIAGNOSIS')!;
    expect(factor).toBeDefined();
    expect(factor.remedy).toMatch(/Add the diagnosis/);
    expect(result.level).toBe('medium');
  });

  it('flags a missing pre-authorisation as high risk', () => {
    const result = assessDenialRisk(claim({ requires_pre_auth: true, has_pre_auth: false }));
    expect(result.factors.map((f) => f.code)).toContain('MISSING_PRE_AUTH');
    expect(result.risk_bp).toBeGreaterThanOrEqual(MEDIUM_RISK_BP);
  });

  it('says nothing about pre-authorisation once one is attached', () => {
    const result = assessDenialRisk(claim({ requires_pre_auth: true, has_pre_auth: true }));
    expect(result.factors).toEqual([]);
  });

  it('catches an excluded service and names it', () => {
    const result = assessDenialRisk(
      claim({ procedure_codes: ['99213', 'D0120'], excluded_codes: ['d0120'] }),
    );
    const factor = result.factors.find((f) => f.code === 'EXCLUDED_SERVICE')!;
    expect(factor.detail).toContain('D0120');
  });

  it('treats a claim past the filing limit as high risk', () => {
    const result = assessDenialRisk(claim({ days_since_service: 200, filing_limit_days: 90 }));
    expect(result.factors.map((f) => f.code)).toContain('PAST_FILING_LIMIT');
    expect(result.level).toBe('high');
  });

  it('warns about a late submission that is still inside the limit', () => {
    const result = assessDenialRisk(claim({ days_since_service: 75, filing_limit_days: 180 }));
    expect(result.factors.map((f) => f.code)).toContain('LATE_SUBMISSION');
    expect(result.factors.map((f) => f.code)).not.toContain('PAST_FILING_LIMIT');
  });

  it('does not double-count lateness against the limit', () => {
    const result = assessDenialRisk(claim({ days_since_service: 200, filing_limit_days: 90 }));
    const codes = result.factors.map((f) => f.code);
    expect(codes.filter((c) => c === 'LATE_SUBMISSION')).toHaveLength(0);
  });

  it('weights a payer with a bad history without swamping fixable problems', () => {
    const result = assessDenialRisk(claim({ payer_denial_rate_bp: 3_000 }));
    const factor = result.factors.find((f) => f.code === 'PAYER_HISTORY')!;
    expect(factor.weight_bp).toBe(1_000);
    expect(factor.detail).toContain('30.0%');
  });

  it('ignores a payer whose denial rate is unremarkable', () => {
    expect(assessDenialRisk(claim({ payer_denial_rate_bp: 900 })).factors).toEqual([]);
  });

  it('caps at certainty however many things are wrong', () => {
    const result = assessDenialRisk(
      claim({
        diagnosis_codes: [],
        procedure_codes: [],
        requires_pre_auth: true,
        days_since_service: 400,
        filing_limit_days: 90,
        documentation_complete: false,
        payer_denial_rate_bp: 9_000,
      }),
    );
    expect(result.risk_bp).toBe(10_000);
    expect(result.level).toBe('high');
  });

  it('orders the remedies by how much each would remove', () => {
    const result = assessDenialRisk(
      claim({ diagnosis_codes: [], documentation_complete: false }),
    );
    expect(result.recommended_actions[0]).toMatch(/Add the diagnosis/);
  });

  it('bands at the documented thresholds', () => {
    expect(HIGH_RISK_BP).toBeGreaterThan(MEDIUM_RISK_BP);
    expect(assessDenialRisk(claim({ documentation_complete: false })).level).toBe('low');
    expect(assessDenialRisk(claim({ diagnosis_codes: [] })).level).toBe('medium');
  });
});

describe('reviewSuggestions', () => {
  const suggestion = (over: Record<string, unknown> = {}) => ({
    system: 'ICD-10',
    code: 'J18.9',
    display: 'Pneumonia',
    confidence: 0.9,
    ...over,
  });

  it('marks a suggestion the coder already has, so it is not re-approved', () => {
    const reviewed = reviewSuggestions([suggestion()], {
      diagnosis_codes: ['j18.9'],
      procedure_codes: [],
    });
    expect(reviewed[0]!.already_on_claim).toBe(true);
  });

  it('puts new suggestions first, then by confidence', () => {
    const reviewed = reviewSuggestions(
      [
        suggestion({ code: 'J18.9', confidence: 0.95 }),
        suggestion({ code: 'R05.9', confidence: 0.6 }),
        suggestion({ code: 'J44.9', confidence: 0.85 }),
      ],
      { diagnosis_codes: ['J18.9'], procedure_codes: [] },
    );
    expect(reviewed.map((r) => r.code)).toEqual(['J44.9', 'R05.9', 'J18.9']);
  });

  it('flags anything below the governance confidence floor', () => {
    const reviewed = reviewSuggestions(
      [suggestion({ confidence: SUGGESTION_CONFIDENCE_FLOOR - 0.01 })],
      { diagnosis_codes: [], procedure_codes: [] },
    );
    expect(reviewed[0]!.low_confidence).toBe(true);
  });

  it('does not flag a confident suggestion', () => {
    const reviewed = reviewSuggestions([suggestion({ confidence: 0.95 })], {
      diagnosis_codes: [],
      procedure_codes: [],
    });
    expect(reviewed[0]!.low_confidence).toBe(false);
  });

  it('clamps an out-of-range confidence instead of passing it through', () => {
    const reviewed = reviewSuggestions([suggestion({ confidence: 1.7 })], {
      diagnosis_codes: [],
      procedure_codes: [],
    });
    expect(reviewed[0]!.confidence).toBe(1);
  });

  it('drops a suggestion with no code at all', () => {
    expect(
      reviewSuggestions([suggestion({ code: '  ' })], { diagnosis_codes: [], procedure_codes: [] }),
    ).toEqual([]);
  });

  it('matches a procedure code already on the claim too', () => {
    const reviewed = reviewSuggestions([suggestion({ system: 'CPT', code: '99213' })], {
      diagnosis_codes: [],
      procedure_codes: ['99213'],
    });
    expect(reviewed[0]!.already_on_claim).toBe(true);
  });
});
