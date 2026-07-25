import { allocate, applyBp, calculateLine, divRound, splitCoverage, sumInvoice } from './money';

describe('divRound', () => {
  it('rounds half away from zero', () => {
    expect(divRound(5, 2)).toBe(3);
    expect(divRound(-5, 2)).toBe(-3);
    expect(divRound(4, 2)).toBe(2);
    expect(divRound(1, 3)).toBe(0);
    expect(divRound(2, 3)).toBe(1);
  });

  it('refuses division by zero', () => {
    expect(() => divRound(1, 0)).toThrow(/Division by zero/);
  });
});

describe('applyBp', () => {
  it('applies VAT rates exactly', () => {
    expect(applyBp(100_000, 500)).toBe(5_000); // 5% UAE VAT
    expect(applyBp(100_000, 1500)).toBe(15_000); // 15% Saudi VAT
    expect(applyBp(100_000, 1800)).toBe(18_000); // 18% India GST
    expect(applyBp(100_000, 0)).toBe(0);
  });

  it('rounds a fractional minor unit rather than truncating it', () => {
    // 5% of 333 fils = 16.65 → 17, not 16.
    expect(applyBp(333, 500)).toBe(17);
  });

  it('rejects a non-integer amount', () => {
    expect(() => applyBp(100.5, 500)).toThrow(/must be integers/);
  });
});

describe('calculateLine', () => {
  it('computes gross, discount, net, tax and total', () => {
    const line = calculateLine({
      quantity: 3,
      unit_price_minor: 15_000,
      discount_minor: 5_000,
      tax_rate_bp: 500,
    });
    expect(line.gross_minor).toBe(45_000);
    expect(line.discount_minor).toBe(5_000);
    expect(line.net_minor).toBe(40_000);
    expect(line.tax_minor).toBe(2_000);
    expect(line.total_minor).toBe(42_000);
  });

  it('taxes the discounted net, not the gross', () => {
    const withDiscount = calculateLine({ quantity: 1, unit_price_minor: 10_000, discount_minor: 2_000, tax_rate_bp: 500 });
    expect(withDiscount.tax_minor).toBe(400); // 5% of 8000, not of 10000
  });

  it('caps a discount at the gross so a line can never go negative', () => {
    const line = calculateLine({ quantity: 1, unit_price_minor: 10_000, discount_minor: 99_999 });
    expect(line.discount_minor).toBe(10_000);
    expect(line.net_minor).toBe(0);
    expect(line.total_minor).toBe(0);
  });

  it('rejects a non-integer price or a non-positive quantity', () => {
    expect(() => calculateLine({ quantity: 1, unit_price_minor: 10.5 })).toThrow(/integer/);
    expect(() => calculateLine({ quantity: 0, unit_price_minor: 100 })).toThrow(/positive integer/);
    expect(() => calculateLine({ quantity: 1.5, unit_price_minor: 100 })).toThrow(/positive integer/);
  });

  it('keeps every output an integer', () => {
    const line = calculateLine({ quantity: 7, unit_price_minor: 3_333, tax_rate_bp: 1500 });
    for (const v of Object.values(line)) expect(Number.isInteger(v)).toBe(true);
  });
});

describe('sumInvoice', () => {
  it('sums line totals without drift', () => {
    const lines = Array.from({ length: 100 }, () =>
      calculateLine({ quantity: 1, unit_price_minor: 333, tax_rate_bp: 500 }),
    );
    const totals = sumInvoice(lines);
    expect(totals.subtotal_minor).toBe(33_300);
    expect(totals.tax_minor).toBe(1_700); // 100 x 17
    expect(totals.total_minor).toBe(35_000);
    expect(Number.isInteger(totals.total_minor)).toBe(true);
  });

  it('returns zeros for an empty invoice', () => {
    expect(sumInvoice([])).toEqual({
      subtotal_minor: 0,
      discount_minor: 0,
      tax_minor: 0,
      total_minor: 0,
    });
  });
});

describe('splitCoverage', () => {
  it('gives everything to the payer with no deductible or copay', () => {
    const s = splitCoverage({
      total_minor: 100_000,
      copay_bp: 0,
      deductible_remaining_minor: 0,
      annual_limit_remaining_minor: null,
    });
    expect(s.payer_share_minor).toBe(100_000);
    expect(s.patient_share_minor).toBe(0);
  });

  it('applies the deductible before the copay', () => {
    const s = splitCoverage({
      total_minor: 100_000,
      copay_bp: 2000, // 20%
      deductible_remaining_minor: 20_000,
      annual_limit_remaining_minor: null,
    });
    expect(s.deductible_applied_minor).toBe(20_000);
    expect(s.copay_applied_minor).toBe(16_000); // 20% of the remaining 80,000
    expect(s.payer_share_minor).toBe(64_000);
    expect(s.patient_share_minor).toBe(36_000);
  });

  it('caps the payer share at the remaining annual limit', () => {
    const s = splitCoverage({
      total_minor: 100_000,
      copay_bp: 0,
      deductible_remaining_minor: 0,
      annual_limit_remaining_minor: 30_000,
    });
    expect(s.payer_share_minor).toBe(30_000);
    expect(s.patient_share_minor).toBe(70_000);
    expect(s.over_limit_minor).toBe(70_000);
  });

  it('gives the whole charge to the patient once the limit is exhausted', () => {
    const s = splitCoverage({
      total_minor: 100_000,
      copay_bp: 0,
      deductible_remaining_minor: 0,
      annual_limit_remaining_minor: 0,
    });
    expect(s.payer_share_minor).toBe(0);
    expect(s.patient_share_minor).toBe(100_000);
  });

  it('reconciles exactly on amounts that do not divide evenly', () => {
    for (const total of [1, 7, 333, 9_999, 100_001]) {
      const s = splitCoverage({
        total_minor: total,
        copay_bp: 3333,
        deductible_remaining_minor: 3,
        annual_limit_remaining_minor: null,
      });
      expect(s.payer_share_minor + s.patient_share_minor).toBe(total);
      expect(Number.isInteger(s.payer_share_minor)).toBe(true);
      expect(Number.isInteger(s.patient_share_minor)).toBe(true);
    }
  });

  it('handles a deductible larger than the charge', () => {
    const s = splitCoverage({
      total_minor: 5_000,
      copay_bp: 1000,
      deductible_remaining_minor: 50_000,
      annual_limit_remaining_minor: null,
    });
    expect(s.deductible_applied_minor).toBe(5_000);
    expect(s.payer_share_minor).toBe(0);
    expect(s.patient_share_minor).toBe(5_000);
  });
});

describe('allocate', () => {
  it('distributes without losing or inventing minor units', () => {
    expect(allocate(100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100);
    expect(allocate(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(allocate(0, [1, 2])).toEqual([0, 0]);
  });

  it('returns zeros when every weight is zero', () => {
    expect(allocate(100, [0, 0])).toEqual([0, 0]);
  });

  it('weights the split proportionally', () => {
    expect(allocate(1000, [3, 1])).toEqual([750, 250]);
  });
});
