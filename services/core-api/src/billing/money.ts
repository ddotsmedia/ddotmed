/**
 * Integer-minor-unit money maths. Every value is a whole number of fils/halala/
 * paise/cents. Floats are never used — a half-cent of drift becomes a reconciliation
 * failure at month end.
 */

export interface LineInput {
  quantity: number;
  unit_price_minor: number;
  discount_minor?: number;
  tax_rate_bp?: number;
}

export interface LineTotals {
  gross_minor: number;
  discount_minor: number;
  net_minor: number;
  tax_minor: number;
  total_minor: number;
}

/** Banker-free half-up rounding on an integer numerator/denominator pair. */
export function divRound(numerator: number, denominator: number): number {
  if (denominator === 0) throw new Error('Division by zero in money calculation');
  const sign = Math.sign(numerator) * Math.sign(denominator);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  return sign * Math.floor((n * 2 + d) / (d * 2));
}

/** Applies basis points (1 bp = 0.01%) to an integer minor amount. */
export function applyBp(amountMinor: number, bp: number): number {
  if (!Number.isInteger(amountMinor)) throw new Error('Money amounts must be integers');
  return divRound(amountMinor * bp, 10_000);
}

export function calculateLine(line: LineInput): LineTotals {
  if (!Number.isInteger(line.unit_price_minor)) {
    throw new Error('unit_price_minor must be an integer number of minor units');
  }
  if (!Number.isInteger(line.quantity) || line.quantity < 1) {
    throw new Error('quantity must be a positive integer');
  }

  const gross = line.unit_price_minor * line.quantity;
  const discount = Math.min(line.discount_minor ?? 0, gross);
  const net = gross - discount;
  // Tax is computed on the discounted net, which is the rule in every supported jurisdiction.
  const tax = applyBp(net, line.tax_rate_bp ?? 0);

  return {
    gross_minor: gross,
    discount_minor: discount,
    net_minor: net,
    tax_minor: tax,
    total_minor: net + tax,
  };
}

export interface InvoiceTotals {
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
}

export function sumInvoice(lines: LineTotals[]): InvoiceTotals {
  return lines.reduce<InvoiceTotals>(
    (acc, l) => ({
      subtotal_minor: acc.subtotal_minor + l.net_minor,
      discount_minor: acc.discount_minor + l.discount_minor,
      tax_minor: acc.tax_minor + l.tax_minor,
      total_minor: acc.total_minor + l.total_minor,
    }),
    { subtotal_minor: 0, discount_minor: 0, tax_minor: 0, total_minor: 0 },
  );
}

export interface CoverageSplitInput {
  total_minor: number;
  copay_bp: number;
  deductible_remaining_minor: number;
  annual_limit_remaining_minor: number | null;
}

export interface CoverageSplit {
  payer_share_minor: number;
  patient_share_minor: number;
  deductible_applied_minor: number;
  copay_applied_minor: number;
  over_limit_minor: number;
}

/**
 * Splits a charge between payer and patient.
 * Order matters and matches payer adjudication: deductible first, then copay on the
 * remainder, then the annual limit caps whatever the payer would otherwise pay.
 */
export function splitCoverage(input: CoverageSplitInput): CoverageSplit {
  const total = input.total_minor;
  if (!Number.isInteger(total)) throw new Error('total_minor must be an integer');

  const deductible = Math.min(input.deductible_remaining_minor, total);
  const afterDeductible = total - deductible;
  const copay = applyBp(afterDeductible, input.copay_bp);
  let payer = afterDeductible - copay;

  let overLimit = 0;
  if (input.annual_limit_remaining_minor !== null && payer > input.annual_limit_remaining_minor) {
    overLimit = payer - Math.max(0, input.annual_limit_remaining_minor);
    payer = Math.max(0, input.annual_limit_remaining_minor);
  }

  const patient = total - payer;

  // The split must be exact — any residual would silently vanish from the ledger.
  if (payer + patient !== total) {
    throw new Error(`Coverage split does not reconcile: ${payer} + ${patient} !== ${total}`);
  }

  return {
    payer_share_minor: payer,
    patient_share_minor: patient,
    deductible_applied_minor: deductible,
    copay_applied_minor: copay,
    over_limit_minor: overLimit,
  };
}

/** Distributes an amount across n shares with the rounding remainder spread deterministically. */
export function allocate(amountMinor: number, weights: number[]): number[] {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) return weights.map(() => 0);

  const shares = weights.map((w) => Math.floor((amountMinor * w) / totalWeight));
  let remainder = amountMinor - shares.reduce((a, b) => a + b, 0);
  // Hand the leftover minor units to the largest weights first.
  const order = weights.map((w, i) => ({ w, i })).sort((a, b) => b.w - a.w);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length) {
    shares[order[k]!.i]! += 1;
    remainder -= 1;
  }
  return shares;
}
