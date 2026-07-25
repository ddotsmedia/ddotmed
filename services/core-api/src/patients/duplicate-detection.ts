/** Levenshtein distance, bounded by an early exit once the row minimum exceeds `max`. */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** 0..1 similarity derived from edit distance over the longer string. */
export function similarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x && !y) return 1;
  const longest = Math.max(x.length, y.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(x, y) / longest;
}

/**
 * Folds a name to a comparable key: lowercase, decomposed, diacritics stripped,
 * punctuation and spacing removed. Arabic, Devanagari and CJK are preserved —
 * stripping them would collapse every non-Latin name to the empty string and make
 * unrelated patients look identical.
 */
export function normalizeName(v: string): string {
  return v
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    // The Devanagari and Arabic ranges include combining marks by design: this is a
    // negated class that *keeps* those scripts intact, so it never splits a grapheme.
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[^a-z0-9\u0600-\u06ff\u0900-\u097f\u4e00-\u9fff]/gu, '');
}

export interface DuplicateCandidate {
  id: string;
  mrn: string;
  given_names: string[];
  family_name: string;
  birth_date: Date;
  gender: string;
}

export interface DuplicateMatch<T extends DuplicateCandidate> {
  patient: T;
  score: number;
  reasons: string[];
}

export interface DuplicateInput {
  given_names: string[];
  family_name: string;
  birth_date: string;
  gender: string;
}

const WEIGHTS = { family: 0.35, given: 0.25, dob: 0.3, gender: 0.1 };

/**
 * Scores existing patients against a registration attempt. An exact DOB plus close
 * name match is the signal that matters — DOB alone is far too common to flag on.
 */
export function scoreDuplicates<T extends DuplicateCandidate>(
  input: DuplicateInput,
  candidates: T[],
  threshold = 0.82,
): DuplicateMatch<T>[] {
  const inputDob = input.birth_date.slice(0, 10);

  return candidates
    .map((c) => {
      const reasons: string[] = [];
      const familyScore = similarity(input.family_name, c.family_name);
      if (familyScore >= 0.85) reasons.push('family name matches');

      const givenScore = Math.max(
        ...input.given_names.map((g) => Math.max(...c.given_names.map((cg) => similarity(g, cg)), 0)),
        0,
      );
      if (givenScore >= 0.85) reasons.push('given name matches');

      const candidateDob = c.birth_date.toISOString().slice(0, 10);
      const dobExact = candidateDob === inputDob;
      // Transposed day/month is the most common registration typo.
      const dobTransposed =
        !dobExact &&
        candidateDob.slice(0, 4) === inputDob.slice(0, 4) &&
        candidateDob.slice(5, 7) === inputDob.slice(8, 10) &&
        candidateDob.slice(8, 10) === inputDob.slice(5, 7);
      const dobScore = dobExact ? 1 : dobTransposed ? 0.8 : 0;
      if (dobExact) reasons.push('date of birth matches');
      else if (dobTransposed) reasons.push('date of birth day/month transposed');

      const genderScore = c.gender === input.gender ? 1 : 0;
      if (genderScore) reasons.push('gender matches');

      const score =
        familyScore * WEIGHTS.family +
        givenScore * WEIGHTS.given +
        dobScore * WEIGHTS.dob +
        genderScore * WEIGHTS.gender;

      return { patient: c, score: Number(score.toFixed(4)), reasons };
    })
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score);
}
