import { levenshtein, normalizeName, scoreDuplicates, similarity } from './duplicate-detection';

const candidate = (over: Partial<Parameters<typeof scoreDuplicates>[1][number]> = {}) => ({
  id: 'p1',
  mrn: 'MRN26000001',
  given_names: ['Ahmed'],
  family_name: 'Al Mansouri',
  birth_date: new Date('1985-03-14T00:00:00Z'),
  gender: 'male',
  ...over,
});

describe('levenshtein', () => {
  it('returns 0 for identical strings and the length for an empty comparison', () => {
    expect(levenshtein('smith', 'smith')).toBe(0);
    expect(levenshtein('', 'smith')).toBe(5);
    expect(levenshtein('smith', '')).toBe(5);
  });

  it('counts single-character edits', () => {
    expect(levenshtein('smith', 'smyth')).toBe(1);
    expect(levenshtein('smith', 'smiths')).toBe(1);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('short-circuits once the bound is exceeded', () => {
    expect(levenshtein('abcdefgh', 'zzzzzzzz', 2)).toBeGreaterThan(2);
  });
});

describe('normalizeName', () => {
  it('strips case, accents, spaces and punctuation', () => {
    expect(normalizeName('Al-Mansouri')).toBe('almansouri');
    expect(normalizeName('José  Álvarez')).toBe('josealvarez');
  });

  it('preserves Arabic and Devanagari characters', () => {
    expect(normalizeName('محمد')).toBe('محمد');
    expect(normalizeName('राज')).toBe('राज');
  });
});

describe('similarity', () => {
  it('scores exact and near matches highly', () => {
    expect(similarity('Mansouri', 'Mansouri')).toBe(1);
    expect(similarity('Mansouri', 'Mansuri')).toBeGreaterThan(0.85);
  });

  it('scores unrelated names low', () => {
    expect(similarity('Mansouri', 'Okonkwo')).toBeLessThan(0.4);
  });
});

describe('scoreDuplicates', () => {
  const input = {
    given_names: ['Ahmed'],
    family_name: 'Al Mansouri',
    birth_date: '1985-03-14',
    gender: 'male',
  };

  it('flags an exact match', () => {
    const matches = scoreDuplicates(input, [candidate()]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.score).toBe(1);
    expect(matches[0]!.reasons).toContain('date of birth matches');
  });

  it('flags a misspelled surname on the same date of birth', () => {
    const matches = scoreDuplicates(input, [candidate({ family_name: 'Al Mansuri' })]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.score).toBeGreaterThan(0.9);
  });

  it('flags a transposed day/month date of birth', () => {
    const matches = scoreDuplicates({ ...input, birth_date: '1985-03-04' }, [
      candidate({ birth_date: new Date('1985-04-03T00:00:00Z') }),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.reasons).toContain('date of birth day/month transposed');
    // Scores below an exact-DOB match, so a true duplicate still ranks first.
    expect(matches[0]!.score).toBeLessThan(1);
  });

  it('does not flag a different person who shares a date of birth', () => {
    const matches = scoreDuplicates(input, [
      candidate({ given_names: ['Chidi'], family_name: 'Okonkwo' }),
    ]);
    expect(matches).toHaveLength(0);
  });

  it('does not flag the same name with an unrelated date of birth', () => {
    const matches = scoreDuplicates(input, [
      candidate({ birth_date: new Date('1972-11-02T00:00:00Z') }),
    ]);
    expect(matches).toHaveLength(0);
  });

  it('sorts the highest-scoring candidate first', () => {
    const matches = scoreDuplicates(input, [
      candidate({ id: 'p2', family_name: 'Al Mansuri' }),
      candidate({ id: 'p1' }),
    ]);
    expect(matches[0]!.patient.id).toBe('p1');
  });
});
