import {
  DRUG_CATALOGUE,
  defaultsFor,
  dosesPerDay,
  scoreDrug,
  searchDrugCatalogue,
  suggestedQuantity,
} from './drug-catalogue';

describe('DRUG_CATALOGUE', () => {
  it('carries an RxNorm code on every entry — an uncoded drug cannot be checked', () => {
    for (const drug of DRUG_CATALOGUE) {
      expect(drug.rxnorm.length).toBeGreaterThan(0);
      expect(drug.atc.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate RxNorm codes', () => {
    const codes = DRUG_CATALOGUE.map((d) => d.rxnorm);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('gives every controlled drug a schedule', () => {
    for (const drug of DRUG_CATALOGUE.filter((d) => d.is_controlled)) {
      expect(drug.controlled_schedule).toBeTruthy();
    }
  });
});

describe('scoreDrug', () => {
  const metformin = DRUG_CATALOGUE.find((d) => d.generic_name === 'Metformin')!;

  it('scores an exact RxNorm or ATC code highest', () => {
    expect(scoreDrug(metformin, '6809')).toBe(1);
    expect(scoreDrug(metformin, 'A10BA02')).toBe(1);
  });

  it('ranks a name prefix above a mid-name substring', () => {
    expect(scoreDrug(metformin, 'metf')).toBeGreaterThan(scoreDrug(metformin, 'formin'));
    expect(scoreDrug(metformin, 'formin')).toBeGreaterThan(0);
  });

  it('matches the brand name as well as the generic', () => {
    const paracetamol = DRUG_CATALOGUE.find((d) => d.generic_name === 'Paracetamol')!;
    expect(scoreDrug(paracetamol, 'panadol')).toBeGreaterThan(0);
  });

  it('scores an unrelated query as no match', () => {
    expect(scoreDrug(metformin, 'warfarin')).toBe(0);
  });
});

describe('searchDrugCatalogue', () => {
  it('needs at least two characters', () => {
    expect(searchDrugCatalogue('m')).toEqual([]);
  });

  it('offers every drug beginning "met" before one that merely contains it', () => {
    const names = searchDrugCatalogue('met').map((d) => d.generic_name);
    const prefixed = names.filter((n) => n.toLowerCase().startsWith('met'));
    expect(prefixed).toEqual(expect.arrayContaining(['Metformin', 'Metoprolol', 'Metoclopramide']));
    // Every prefix match sorts ahead of anything matched mid-name.
    expect(names.slice(0, prefixed.length)).toEqual(prefixed);
  });

  it('finds a drug by RxNorm code', () => {
    expect(searchDrugCatalogue('11289')[0]?.generic_name).toBe('Warfarin');
  });

  it('honours the limit', () => {
    expect(searchDrugCatalogue('a', { limit: 3 })).toHaveLength(0);
    expect(searchDrugCatalogue('ol', { limit: 3 }).length).toBeLessThanOrEqual(3);
  });

  it('puts a tenant formulary entry ahead of the bundled one for the same drug', () => {
    const results = searchDrugCatalogue('warfarin', {
      extra: [
        {
          formulary_id: 'f1',
          rxnorm: '11289',
          atc: 'B01AA03',
          generic_name: 'Warfarin',
          brand_name: 'Coumadin',
          strength: '3 mg',
          dose_form: 'tablet',
          drug_class: 'anticoagulant',
          score: 0,
          source: 'tenant',
        },
      ],
    });
    expect(results[0]?.source).toBe('tenant');
    expect(results.filter((r) => r.rxnorm === '11289')).toHaveLength(1);
  });
});

describe('defaultsFor', () => {
  it('derives the route from the dose form', () => {
    expect(defaultsFor({ drug_class: 'analgesic', dose_form: 'tablet' }).route).toBe('oral');
    expect(defaultsFor({ drug_class: 'bronchodilator', dose_form: 'inhaler' }).route).toBe('inhaled');
    expect(defaultsFor({ drug_class: 'benzodiazepine', dose_form: 'injection' }).route).toBe('intravenous');
  });

  it('gives an antibiotic a finite course and an anticoagulant none', () => {
    expect(defaultsFor({ drug_class: 'antibiotic', dose_form: 'capsule' }).duration_days).toBe(7);
    expect(defaultsFor({ drug_class: 'anticoagulant', dose_form: 'tablet' }).duration_days).toBeNull();
  });

  it('attaches a safety note to the classes that carry one', () => {
    expect(defaultsFor({ drug_class: 'opioid', dose_form: 'tablet' }).note).toMatch(/Shortest effective/);
    expect(defaultsFor({ drug_class: 'thyroid', dose_form: 'tablet' }).note).toMatch(/empty stomach/);
  });

  it('falls back to a safe generic default for an unknown class', () => {
    const d = defaultsFor({ drug_class: null, dose_form: null });
    expect(d.route).toBe('oral');
    expect(d.frequency).toBe('OD');
  });
});

describe('dosesPerDay', () => {
  it('reads the standard abbreviations', () => {
    expect(dosesPerDay('OD')).toBe(1);
    expect(dosesPerDay('BD')).toBe(2);
    expect(dosesPerDay('TDS')).toBe(3);
    expect(dosesPerDay('QDS')).toBe(4);
  });

  it('ignores a PRN suffix', () => {
    expect(dosesPerDay('QDS PRN')).toBe(4);
  });

  it('assumes once daily for anything it does not recognise', () => {
    expect(dosesPerDay('weekly')).toBe(1);
  });
});

describe('suggestedQuantity', () => {
  it('sizes a course from dose, frequency and duration', () => {
    expect(suggestedQuantity(1, 'TDS', 7)).toBe(21);
    expect(suggestedQuantity(2, 'BD', 5)).toBe(20);
  });

  it('rounds a fractional dose up to a whole unit', () => {
    expect(suggestedQuantity(0.5, 'OD', 7)).toBe(4);
  });

  it('assumes a month for an open-ended course', () => {
    expect(suggestedQuantity(1, 'OD', null)).toBe(28);
  });

  it('never suggests zero', () => {
    expect(suggestedQuantity(0.01, 'OD', 1)).toBe(1);
  });
});
