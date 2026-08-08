/**
 * Money display. Values cross the wire as integer minor units and are only ever
 * turned into a decimal at the last moment, for a human to read.
 */

/** Currencies whose minor unit is not 1/100 of the major one. */
const MINOR_UNIT_DIGITS: Record<string, number> = {
  BHD: 3,
  JOD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
  JPY: 0,
  KRW: 0,
};

export function minorUnitDigits(currency: string): number {
  return MINOR_UNIT_DIGITS[currency.toUpperCase()] ?? 2;
}

/** Formats integer minor units for display. Never used to compute anything. */
export function formatMoney(amountMinor: number, currency: string, locale = 'en'): string {
  const digits = minorUnitDigits(currency);
  const major = amountMinor / 10 ** digits;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    // An unrecognised currency code still has to render something legible.
    return `${currency} ${major.toFixed(digits)}`;
  }
}

/**
 * Parses what a user typed into integer minor units.
 *
 * Rounds rather than truncates, and returns null on anything unparseable so a
 * caller cannot mistake a typo for zero.
 */
export function parseMoney(input: string, currency: string): number | null {
  const cleaned = input.replace(/[^0-9.-]/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 10 ** minorUnitDigits(currency));
}

/** Basis points as a percentage string. 8 500 bp → "85.0%". */
export function formatBp(bp: number, digits = 1): string {
  return `${(bp / 100).toFixed(digits)}%`;
}
