import { ICD10_CATALOGUE, scoreIcd10, searchIcd10 } from './icd10-catalogue';

describe('ICD10_CATALOGUE', () => {
  it('has no duplicate codes', () => {
    const codes = ICD10_CATALOGUE.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('gives every entry a display and a chapter', () => {
    for (const entry of ICD10_CATALOGUE) {
      expect(entry.display.length).toBeGreaterThan(3);
      expect(entry.chapter.length).toBeGreaterThan(0);
    }
  });
});

describe('scoreIcd10', () => {
  const hypertension = { code: 'I10', display: 'Essential (primary) hypertension', chapter: 'Circulatory' };

  it('scores an exact code above a code prefix', () => {
    expect(scoreIcd10(hypertension, 'I10')).toBe(1);
    expect(scoreIcd10(hypertension, 'I1')).toBeLessThan(1);
    expect(scoreIcd10(hypertension, 'I1')).toBeGreaterThan(0);
  });

  it('ignores the dot so E119 and E11.9 both match', () => {
    const dm = { code: 'E11.9', display: 'Type 2 diabetes mellitus', chapter: 'Endocrine' };
    expect(scoreIcd10(dm, 'E119')).toBe(1);
    expect(scoreIcd10(dm, 'e11.9')).toBe(1);
  });

  it('ranks a word start above a mid-word substring', () => {
    const word = scoreIcd10(hypertension, 'hyperten');
    const inner = scoreIcd10(hypertension, 'ension');
    expect(word).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(0);
  });

  it('requires every term to match, so a second word narrows rather than widens', () => {
    const kneePain = { code: 'M25.561', display: 'Pain in right knee', chapter: 'Musculoskeletal' };
    const backPain = { code: 'M54.5', display: 'Low back pain', chapter: 'Musculoskeletal' };
    expect(scoreIcd10(kneePain, 'knee pain')).toBeGreaterThan(0);
    expect(scoreIcd10(backPain, 'knee pain')).toBe(0);
  });

  it('scores an empty query as no match', () => {
    expect(scoreIcd10(hypertension, '   ')).toBe(0);
  });
});

describe('searchIcd10', () => {
  it('needs at least two characters before it will guess', () => {
    expect(searchIcd10('a')).toEqual([]);
    expect(searchIcd10('')).toEqual([]);
  });

  it('puts the exact code first', () => {
    expect(searchIcd10('I10')[0]?.code).toBe('I10');
    expect(searchIcd10('J06.9')[0]?.code).toBe('J06.9');
  });

  it('finds by description', () => {
    const codes = searchIcd10('asthma').map((r) => r.code);
    expect(codes).toContain('J45.909');
  });

  it('honours the limit', () => {
    expect(searchIcd10('pain', { limit: 3 })).toHaveLength(3);
  });

  it('returns results sorted by descending score', () => {
    const scores = searchIcd10('diabetes').map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('surfaces a tenant code ahead of the bundled catalogue entry for the same code', () => {
    const results = searchIcd10('I10', {
      extra: [{ code: 'I10', display: 'HTN — clinic shorthand', chapter: 'Recently used' }],
    });
    expect(results[0]?.display).toBe('HTN — clinic shorthand');
    expect(results.filter((r) => r.code === 'I10')).toHaveLength(1);
  });

  it('finds a tenant-only code that is not in the bundled catalogue', () => {
    const results = searchIcd10('Q21.0', {
      extra: [{ code: 'Q21.0', display: 'Ventricular septal defect', chapter: 'Recently used' }],
    });
    expect(results[0]?.code).toBe('Q21.0');
  });

  it('returns nothing rather than noise for a query that matches no code', () => {
    expect(searchIcd10('zzzzzzz')).toEqual([]);
  });
});
