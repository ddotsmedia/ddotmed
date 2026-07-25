import type { Invoice, InsuranceClaim } from '@medicore/shared-types';
import type { FieldRequirement, FormattedInvoice, IdValidationResult } from './types.js';

export const ok = (type: string, normalized: string): IdValidationResult => ({
  valid: true,
  type,
  normalized,
});
export const fail = (type: string, error: string): IdValidationResult => ({
  valid: false,
  type,
  error,
});

export const digitsOnly = (v: string): string => v.replace(/\D/g, '');

/** Luhn mod-10, used by several national ID schemes and by payment cards. */
export function luhn(value: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = value.length - 1; i >= 0; i--) {
    let n = Number(value[i]);
    if (Number.isNaN(n)) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Verhoeff checksum — the algorithm mandated for the Indian Aadhaar number. */
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeff(value: string): boolean {
  let c = 0;
  const rev = value.split('').reverse();
  for (let i = 0; i < rev.length; i++) {
    const digit = Number(rev[i]);
    if (Number.isNaN(digit)) return false;
    c = D[c]![P[i % 8]![digit]!]!;
  }
  return c === 0;
}

export function formatMinor(minor: number, currency: string, locale: string, units = 2): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: units,
    maximumFractionDigits: units,
  }).format(minor / 10 ** units);
}

const ONES = [
  '',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];

function chunkToWords(n: number): string {
  if (n === 0) return '';
  if (n < 20) return ONES[n]!;
  if (n < 100) return `${TENS[Math.floor(n / 10)]!}${n % 10 ? `-${ONES[n % 10]!}` : ''}`;
  return `${ONES[Math.floor(n / 100)]!} hundred${n % 100 ? ` and ${chunkToWords(n % 100)}` : ''}`;
}

/** Several regulators (UAE, India, Saudi) require the total spelled out on the invoice. */
export function amountInWords(minor: number, currency: string, units = 2): string {
  const major = Math.floor(minor / 10 ** units);
  const frac = minor % 10 ** units;
  const scales: Array<[number, string]> = [
    [1_000_000_000, 'billion'],
    [1_000_000, 'million'],
    [1_000, 'thousand'],
  ];
  let rest = major;
  const parts: string[] = [];
  for (const [value, name] of scales) {
    if (rest >= value) {
      parts.push(`${chunkToWords(Math.floor(rest / value))} ${name}`);
      rest %= value;
    }
  }
  let words: string;
  if (parts.length === 0) words = rest > 0 ? chunkToWords(rest) : 'zero';
  else if (rest === 0) words = parts.join(' ');
  // Invoice convention in EN/Gulf/India: "one thousand and fifty", not "one thousand fifty".
  else words = `${parts.join(' ')}${rest < 100 ? ' and ' : ' '}${chunkToWords(rest)}`;
  const head = `${currency} ${words}`;
  return frac > 0 ? `${head} and ${frac}/${10 ** units} only` : `${head} only`;
}

export interface InvoiceRenderOptions {
  documentTitle: string;
  locale: string;
  taxLabel: string;
  taxRateBp: number;
  units?: number;
  regulatoryFields: Record<string, string>;
  includeWords?: boolean;
}

export function renderInvoice(invoice: Invoice, o: InvoiceRenderOptions): FormattedInvoice {
  const units = o.units ?? 2;
  const c = invoice.currency;
  const m = (v: number) => formatMinor(v, c, o.locale, units);
  return {
    documentTitle: o.documentTitle,
    currency: c,
    locale: o.locale,
    taxLabel: o.taxLabel,
    taxRateBp: o.taxRateBp,
    regulatoryFields: o.regulatoryFields,
    lines: invoice.line_items.map((li) => ({
      description: li.description,
      qty: li.quantity,
      unit: m(li.unit_price_minor),
      tax: m(li.tax_minor),
      total: m(li.total_minor),
    })),
    subtotal: m(invoice.subtotal_minor),
    tax: m(invoice.tax_minor),
    discount: m(invoice.discount_minor),
    total: m(invoice.total_minor),
    ...(o.includeWords ? { amountInWords: amountInWords(invoice.total_minor, c, units) } : {}),
  };
}

/** Minimal FHIR R4 Claim resource shared by every FHIR-based national claim format. */
export function fhirClaim(
  claim: InsuranceClaim,
  ctx: { providerLicense?: string; payerLicense?: string; memberId?: string } = {},
): Record<string, unknown> {
  return {
    resourceType: 'Claim',
    id: claim.fhir_id ?? claim.id,
    identifier: [{ system: 'urn:medicore:claim', value: claim.claim_number }],
    status: 'active',
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'institutional' }] },
    use: 'claim',
    patient: { reference: `Patient/${claim.patient_id}` },
    created: claim.created_at,
    provider: {
      reference: `Organization/${claim.tenant_id}`,
      ...(ctx.providerLicense ? { identifier: { value: ctx.providerLicense } } : {}),
    },
    insurer: {
      reference: `Organization/${claim.payer_id}`,
      ...(ctx.payerLicense ? { identifier: { value: ctx.payerLicense } } : {}),
    },
    priority: { coding: [{ code: 'normal' }] },
    insurance: [
      {
        sequence: 1,
        focal: true,
        coverage: { reference: `Coverage/${claim.coverage_id}` },
        ...(ctx.memberId ? { identifier: { value: ctx.memberId } } : {}),
      },
    ],
    diagnosis: claim.diagnosis_codes.map((d, i) => ({
      sequence: i + 1,
      diagnosisCodeableConcept: { coding: [d] },
    })),
    procedure: claim.procedure_codes.map((p, i) => ({
      sequence: i + 1,
      procedureCodeableConcept: { coding: [p] },
    })),
    total: { value: claim.claimed_minor / 100, currency: claim.currency },
  };
}

export const baseRequiredFields: Record<string, FieldRequirement[]> = {
  patient: [
    { field: 'name.given', label: 'First name', required: true },
    { field: 'name.family', label: 'Last name', required: true },
    { field: 'birth_date', label: 'Date of birth', required: true, pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    { field: 'gender', label: 'Gender', required: true },
    { field: 'telecom', label: 'Contact number', required: true },
  ],
  invoice: [
    { field: 'invoice_number', label: 'Invoice number', required: true },
    { field: 'currency', label: 'Currency', required: true },
    { field: 'total_minor', label: 'Total', required: true },
  ],
  claim: [
    { field: 'coverage_id', label: 'Coverage', required: true },
    { field: 'payer_id', label: 'Payer', required: true },
    { field: 'diagnosis_codes', label: 'Diagnosis codes', required: true },
  ],
};
