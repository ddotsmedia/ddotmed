import { normalizeName } from './duplicate-detection';

/**
 * What a free-text query looks like it is. The front desk types one box, so the
 * shape of the input decides which columns are worth searching at all.
 */
export type QueryKind = 'empty' | 'date' | 'numeric' | 'alphanumeric' | 'name';

export interface ParsedQuery {
  raw: string;
  kind: QueryKind;
  /** Lowercased, punctuation-stripped form used for name comparison. */
  normalized: string;
  /** Digits only, for MRN / phone / national-ID style lookups. */
  digits: string;
  /** Uppercased with separators removed, matching how identifiers are stored. */
  identifier: string;
  /** ISO date when the query is unambiguously a date. */
  isoDate: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DMY_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

export function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  const identifier = trimmed.replace(/[\s-]/g, '').toUpperCase();
  const normalized = normalizeName(trimmed);

  let isoDate: string | null = null;
  if (ISO_DATE.test(trimmed) && !Number.isNaN(Date.parse(trimmed))) {
    isoDate = trimmed;
  } else {
    const dmy = DMY_DATE.exec(trimmed);
    if (dmy) {
      const [, d, m, y] = dmy;
      const candidate = `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
      if (!Number.isNaN(Date.parse(candidate))) isoDate = candidate;
    }
  }

  let kind: QueryKind;
  if (trimmed === '') kind = 'empty';
  else if (isoDate) kind = 'date';
  else if (/^\d+$/.test(digits) && digits.length === trimmed.replace(/[\s\-+()]/g, '').length)
    kind = 'numeric';
  else if (/\d/.test(trimmed) && /[a-z]/i.test(trimmed)) kind = 'alphanumeric';
  else kind = 'name';

  return { raw: trimmed, kind, normalized, digits, identifier, isoDate };
}

/** A candidate row flattened from the search query, ready to score. */
export interface RankableePatient {
  id: string;
  mrn: string;
  given_names: string[];
  family_name: string;
  name_search: string;
  birth_date: Date;
  identifiers?: Array<{ type: string; value_normalized: string }>;
  contacts?: Array<{ value: string }>;
  coverages?: Array<{ member_id: string; policy_number: string }>;
  updated_at?: Date;
}

export interface RankedPatient<T extends RankableePatient> {
  patient: T;
  score: number;
  /** Which field produced the strongest match, shown as context in the results list. */
  matchedOn: string;
}

/**
 * Weights are ordered by how uniquely a field identifies one person. An exact MRN
 * is definitive; a partial name is a hint. Ranking by this rather than by
 * alphabetical order is what makes the first result usually the right one.
 */
const WEIGHT = {
  mrnExact: 1.0,
  identifierExact: 0.96,
  insuranceExact: 0.92,
  phoneExact: 0.88,
  mrnPrefix: 0.8,
  identifierPartial: 0.72,
  phonePartial: 0.68,
  nameExact: 0.78,
  nameWordPrefix: 0.6,
  nameContains: 0.4,
  dobExact: 0.5,
} as const;

const digitsOf = (v: string): string => v.replace(/\D/g, '');

/**
 * Scores one patient against a parsed query. Pure and synchronous so ranking is
 * testable without a database.
 */
export function scorePatient<T extends RankableePatient>(
  query: ParsedQuery,
  patient: T,
): RankedPatient<T> | null {
  if (query.kind === 'empty') return null;

  let best = 0;
  let matchedOn = '';

  const consider = (score: number, field: string) => {
    if (score > best) {
      best = score;
      matchedOn = field;
    }
  };

  const mrn = patient.mrn.toUpperCase();
  if (mrn === query.identifier) consider(WEIGHT.mrnExact, 'mrn');
  else if (query.identifier.length >= 3 && mrn.startsWith(query.identifier))
    consider(WEIGHT.mrnPrefix, 'mrn');
  // Trailing-digit match: staff routinely quote only the numeric tail of an MRN.
  else if (query.digits.length >= 4 && digitsOf(mrn).endsWith(query.digits))
    consider(WEIGHT.mrnPrefix, 'mrn');

  for (const identifier of patient.identifiers ?? []) {
    const value = identifier.value_normalized.toUpperCase();
    if (!value) continue;
    if (value === query.identifier) consider(WEIGHT.identifierExact, identifier.type);
    else if (query.identifier.length >= 4 && value.includes(query.identifier))
      consider(WEIGHT.identifierPartial, identifier.type);
  }

  for (const coverage of patient.coverages ?? []) {
    const member = coverage.member_id.replace(/[\s-]/g, '').toUpperCase();
    const policy = coverage.policy_number.replace(/[\s-]/g, '').toUpperCase();
    if (member === query.identifier || policy === query.identifier)
      consider(WEIGHT.insuranceExact, 'insurance');
  }

  if (query.digits.length >= 6) {
    for (const contact of patient.contacts ?? []) {
      const value = digitsOf(contact.value);
      if (!value) continue;
      // Compare on the last 9 digits so +971 50 123 4567 and 050 123 4567 match.
      const tail = value.slice(-9);
      const queryTail = query.digits.slice(-9);
      if (tail === queryTail) consider(WEIGHT.phoneExact, 'phone');
      else if (value.includes(query.digits)) consider(WEIGHT.phonePartial, 'phone');
    }
  }

  if (query.isoDate) {
    const dob = patient.birth_date.toISOString().slice(0, 10);
    if (dob === query.isoDate) consider(WEIGHT.dobExact, 'birth_date');
  }

  if (query.normalized.length > 0 && query.kind !== 'numeric') {
    const haystack = patient.name_search || normalizeName(
      `${patient.given_names.join(' ')} ${patient.family_name}`,
    );
    const words = haystack.split(' ').filter(Boolean);

    if (haystack.replace(/\s/g, '') === query.normalized) consider(WEIGHT.nameExact, 'name');
    else if (words.some((w) => w === query.normalized)) consider(WEIGHT.nameExact, 'name');
    else if (words.some((w) => w.startsWith(query.normalized)))
      consider(WEIGHT.nameWordPrefix, 'name');
    else if (haystack.replace(/\s/g, '').includes(query.normalized))
      consider(WEIGHT.nameContains, 'name');
  }

  if (best === 0) return null;
  return { patient, score: Number(best.toFixed(4)), matchedOn };
}

/**
 * Ranks a candidate set. Ties break on most-recently-updated so the chart someone
 * has actually been working in surfaces first, then on id for a stable order.
 */
export function rankPatients<T extends RankableePatient>(
  rawQuery: string,
  candidates: T[],
): RankedPatient<T>[] {
  const query = parseQuery(rawQuery);
  if (query.kind === 'empty') return [];

  return candidates
    .map((candidate) => scorePatient(query, candidate))
    .filter((r): r is RankedPatient<T> => r !== null)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aTime = a.patient.updated_at?.getTime() ?? 0;
      const bTime = b.patient.updated_at?.getTime() ?? 0;
      if (bTime !== aTime) return bTime - aTime;
      return a.patient.id.localeCompare(b.patient.id);
    });
}
