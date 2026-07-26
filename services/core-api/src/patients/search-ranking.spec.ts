import { parseQuery, rankPatients, scorePatient, type RankableePatient } from './search-ranking';

const patient = (over: Partial<RankableePatient> = {}): RankableePatient => ({
  id: 'p1',
  mrn: 'MRN26000001',
  given_names: ['Ahmed'],
  family_name: 'Al Mansouri',
  name_search: 'ahmed almansouri',
  birth_date: new Date('1985-03-14T00:00:00Z'),
  identifiers: [{ type: 'emirates-id', value_normalized: '784199012345671' }],
  contacts: [{ value: '+971501234567' }],
  coverages: [{ member_id: 'DAM-99887', policy_number: 'POL-1234' }],
  updated_at: new Date('2026-07-01T00:00:00Z'),
  ...over,
});

describe('parseQuery', () => {
  it('classifies an empty query', () => {
    expect(parseQuery('   ').kind).toBe('empty');
  });

  it('recognises ISO and D/M/Y dates', () => {
    expect(parseQuery('1985-03-14').isoDate).toBe('1985-03-14');
    expect(parseQuery('14/03/1985').isoDate).toBe('1985-03-14');
    expect(parseQuery('14-3-1985').isoDate).toBe('1985-03-14');
    expect(parseQuery('1985-03-14').kind).toBe('date');
  });

  it('does not treat an impossible date as a date', () => {
    expect(parseQuery('2026-13-45').isoDate).toBeNull();
  });

  it('classifies pure numbers and phone-shaped input as numeric', () => {
    expect(parseQuery('26000001').kind).toBe('numeric');
    expect(parseQuery('+971 50 123 4567').kind).toBe('numeric');
  });

  it('classifies mixed alphanumeric separately from a plain name', () => {
    expect(parseQuery('MRN26000001').kind).toBe('alphanumeric');
    expect(parseQuery('Mansouri').kind).toBe('name');
  });

  it('normalises identifiers by stripping spaces and dashes', () => {
    expect(parseQuery('784-1990-1234567-1').identifier).toBe('784199012345671');
    expect(parseQuery('784-1990-1234567-1').digits).toBe('784199012345671');
  });
});

describe('scorePatient ranking weights', () => {
  const score = (q: string, p = patient()) => scorePatient(parseQuery(q), p);

  it('returns null when nothing matches', () => {
    expect(score('zzzznomatch')).toBeNull();
  });

  it('scores an exact MRN highest of all', () => {
    const result = score('MRN26000001');
    expect(result?.score).toBe(1);
    expect(result?.matchedOn).toBe('mrn');
  });

  it('ranks an exact national ID above insurance, and insurance above phone', () => {
    const nationalId = score('784-1990-1234567-1')!;
    const insurance = score('DAM-99887')!;
    const phone = score('+971501234567')!;

    expect(nationalId.score).toBeGreaterThan(insurance.score);
    expect(insurance.score).toBeGreaterThan(phone.score);
    expect(nationalId.matchedOn).toBe('emirates-id');
    expect(insurance.matchedOn).toBe('insurance');
    expect(phone.matchedOn).toBe('phone');
  });

  it('matches a phone regardless of national or international formatting', () => {
    expect(score('0501234567')?.matchedOn).toBe('phone');
    expect(score('971501234567')?.matchedOn).toBe('phone');
    expect(score('+971 50 123 4567')?.matchedOn).toBe('phone');
  });

  it('matches an MRN by its numeric tail, which is how staff quote it', () => {
    const result = score('26000001');
    expect(result).not.toBeNull();
    expect(result?.matchedOn).toBe('mrn');
  });

  it('ranks an exact name above a prefix, and a prefix above a substring', () => {
    const exact = score('almansouri')!;
    const prefix = score('mansou', patient({ name_search: 'ahmed mansouri' }))!;
    const contains = score('nsour')!;

    expect(exact.score).toBeGreaterThan(prefix.score);
    expect(prefix.score).toBeGreaterThan(contains.score);
  });

  it('matches a name irrespective of case, spacing and punctuation', () => {
    expect(score('AL-MANSOURI')?.matchedOn).toBe('name');
    expect(score('  al mansouri ')?.matchedOn).toBe('name');
  });

  it('never runs a name match for a purely numeric query', () => {
    // "1985" appears in no name field; a numeric query must not fuzzy-match names.
    const result = score('1985', patient({ name_search: 'patient 1985' }));
    expect(result?.matchedOn).not.toBe('name');
  });

  it('scores an exact date of birth', () => {
    expect(score('1985-03-14')?.matchedOn).toBe('birth_date');
    expect(score('1990-01-01')).toBeNull();
  });

  it('keeps every score within 0..1', () => {
    for (const q of ['MRN26000001', '784199012345671', 'DAM-99887', 'almansouri', '1985-03-14']) {
      const result = score(q)!;
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });
});

describe('rankPatients ordering', () => {
  it('returns nothing for an empty query', () => {
    expect(rankPatients('  ', [patient()])).toEqual([]);
  });

  it('puts the exact MRN match ahead of a name match', () => {
    const exactMrn = patient({ id: 'exact', mrn: 'MRN26000001' });
    const nameOnly = patient({
      id: 'name',
      mrn: 'MRN26000999',
      name_search: 'mrn26000001 lookalike',
    });

    const ranked = rankPatients('MRN26000001', [nameOnly, exactMrn]);
    expect(ranked[0]!.patient.id).toBe('exact');
  });

  it('drops non-matching candidates entirely', () => {
    const ranked = rankPatients('almansouri', [
      patient({ id: 'match' }),
      patient({ id: 'other', name_search: 'chidi okonkwo', mrn: 'MRN26000777', identifiers: [], contacts: [], coverages: [] }),
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.patient.id).toBe('match');
  });

  it('breaks score ties on most recently updated', () => {
    const older = patient({ id: 'older', updated_at: new Date('2026-01-01T00:00:00Z') });
    const newer = patient({ id: 'newer', updated_at: new Date('2026-07-01T00:00:00Z') });

    const ranked = rankPatients('almansouri', [older, newer]);
    expect(ranked.map((r) => r.patient.id)).toEqual(['newer', 'older']);
  });

  it('is deterministic when score and timestamp both tie', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const b = patient({ id: 'bbb', updated_at: at });
    const a = patient({ id: 'aaa', updated_at: at });

    expect(rankPatients('almansouri', [b, a]).map((r) => r.patient.id)).toEqual(['aaa', 'bbb']);
    expect(rankPatients('almansouri', [a, b]).map((r) => r.patient.id)).toEqual(['aaa', 'bbb']);
  });

  it('orders a realistic mixed result set by identifying power', () => {
    const byName = patient({ id: 'byName', mrn: 'MRN26000500', identifiers: [], coverages: [], contacts: [] });
    const byInsurance = patient({
      id: 'byInsurance',
      mrn: 'MRN26000600',
      name_search: 'unrelated person',
      identifiers: [],
      contacts: [],
      coverages: [{ member_id: 'ALMANSOURI', policy_number: 'P-1' }],
    });

    const ranked = rankPatients('almansouri', [byName, byInsurance]);
    // An exact insurance-member hit identifies one person; a name substring does not.
    expect(ranked[0]!.patient.id).toBe('byInsurance');
  });
});
