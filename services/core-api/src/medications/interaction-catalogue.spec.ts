import {
  INTERACTION_CATALOGUE,
  actionFor,
  fallbackExplanation,
  findCatalogueInteraction,
  findCatalogueInteractions,
  pairKey,
} from './interaction-catalogue';

describe('INTERACTION_CATALOGUE', () => {
  it('holds no duplicate pairs in either direction', () => {
    const seen = new Set<string>();
    for (const entry of INTERACTION_CATALOGUE) {
      const key = pairKey(entry.rxnorm_a, entry.rxnorm_b);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('gives every entry a clinical effect and management advice', () => {
    for (const entry of INTERACTION_CATALOGUE) {
      expect(entry.clinical_effect.length).toBeGreaterThan(10);
      expect(entry.management.length).toBeGreaterThan(10);
      expect(entry.name_a).toBe(entry.name_a.toLowerCase());
      expect(entry.name_b).toBe(entry.name_b.toLowerCase());
    }
  });

  it('covers the contraindications a prescriber would expect to be caught', () => {
    const contraindicated = INTERACTION_CATALOGUE.filter((e) => e.severity === 'contraindicated');
    expect(contraindicated.length).toBeGreaterThanOrEqual(3);
  });
});

describe('pairKey', () => {
  it('is the same whichever way round the pair is given', () => {
    expect(pairKey('161', '11289')).toBe(pairKey('11289', '161'));
  });

  it('ignores case and surrounding whitespace', () => {
    expect(pairKey(' Warfarin ', 'ASPIRIN')).toBe(pairKey('aspirin', 'warfarin'));
  });
});

describe('actionFor', () => {
  it('blocks only a contraindication', () => {
    expect(actionFor('contraindicated')).toBe('block');
  });

  it('makes a major interaction the prescriber’s call, on the record', () => {
    expect(actionFor('major')).toBe('override');
  });

  it('treats moderate and minor as information', () => {
    expect(actionFor('moderate')).toBe('warn');
    expect(actionFor('minor')).toBe('warn');
  });
});

describe('findCatalogueInteraction', () => {
  it('matches on RxNorm code in either order', () => {
    const forward = findCatalogueInteraction(
      { rxnorm: '11289', name: 'Warfarin' },
      { rxnorm: '1191', name: 'Aspirin' },
    );
    const reverse = findCatalogueInteraction(
      { rxnorm: '1191', name: 'Aspirin' },
      { rxnorm: '11289', name: 'Warfarin' },
    );
    expect(forward?.severity).toBe('major');
    expect(reverse).toBe(forward);
  });

  it('falls back to the ingredient name when no code is carried', () => {
    const entry = findCatalogueInteraction(
      { name: 'Simvastatin 40mg tablet' },
      { name: 'Clarithromycin 500mg' },
    );
    expect(entry?.severity).toBe('contraindicated');
  });

  it('is case-insensitive on names', () => {
    expect(findCatalogueInteraction({ name: 'MORPHINE' }, { name: 'naltrexone' })).toBeDefined();
  });

  it('returns nothing for a pair it does not know', () => {
    expect(
      findCatalogueInteraction({ rxnorm: '161', name: 'Paracetamol' }, { rxnorm: '999999', name: 'Zzzz' }),
    ).toBeUndefined();
  });

  it('does not pair a drug with itself', () => {
    expect(
      findCatalogueInteraction({ rxnorm: '11289', name: 'Warfarin' }, { rxnorm: '11289', name: 'Warfarin' }),
    ).toBeUndefined();
  });
});

describe('findCatalogueInteractions', () => {
  it('finds every interacting drug on a list', () => {
    const found = findCatalogueInteractions({ rxnorm: '11289', name: 'Warfarin' }, [
      { rxnorm: '1191', name: 'Aspirin' },
      { rxnorm: '161', name: 'Paracetamol' },
      { rxnorm: '4450', name: 'Fluconazole' },
    ]);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.other.name).sort()).toEqual(['Aspirin', 'Fluconazole']);
  });

  it('returns an empty list rather than null when nothing interacts', () => {
    expect(findCatalogueInteractions({ rxnorm: '161', name: 'Paracetamol' }, [])).toEqual([]);
  });
});

describe('fallbackExplanation', () => {
  it('reads as a sentence and includes the management advice', () => {
    const text = fallbackExplanation({
      drug_a: 'Warfarin',
      drug_b: 'Aspirin',
      severity: 'major',
      clinical_effect: 'Increased bleeding risk',
      management: 'Monitor INR closely.',
    });
    expect(text).toBe(
      'Taking Warfarin with Aspirin can cause increased bleeding risk. Monitor INR closely.',
    );
  });

  it('is never blank when there is no management advice', () => {
    const text = fallbackExplanation({
      drug_a: 'A',
      drug_b: 'B',
      severity: 'minor',
      clinical_effect: 'Something',
      management: null,
    });
    expect(text.length).toBeGreaterThan(0);
    expect(text.endsWith('.')).toBe(true);
  });
});
