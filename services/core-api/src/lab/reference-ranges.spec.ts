import { interpretResult, parseHl7Oru, rangeFor } from './reference-ranges';

describe('rangeFor', () => {
  it('selects the sex-specific adult haemoglobin range', () => {
    expect(rangeFor('718-7', { gender: 'male', ageYears: 40 })!.low).toBe(13.5);
    expect(rangeFor('718-7', { gender: 'female', ageYears: 40 })!.low).toBe(12.0);
  });

  it('selects the paediatric range by age', () => {
    expect(rangeFor('718-7', { gender: 'male', ageYears: 10 })!.low).toBe(11.0);
  });

  it('falls back to a general range when no demographic variant matches', () => {
    const r = rangeFor('2823-3', { gender: 'other', ageYears: 30 });
    expect(r!.low).toBe(3.5);
    expect(r!.high).toBe(5.1);
  });

  it('returns null for an unknown LOINC code', () => {
    expect(rangeFor('00000-0', { gender: 'male', ageYears: 40 })).toBeNull();
  });
});

describe('interpretResult', () => {
  const potassium = rangeFor('2823-3', { gender: 'male', ageYears: 40 })!;

  it('marks an in-range value normal', () => {
    expect(interpretResult(4.2, potassium)).toEqual({ code: 'N', isCritical: false, reason: null });
  });

  it('flags mildly low and high values without escalating', () => {
    expect(interpretResult(3.2, potassium).code).toBe('L');
    expect(interpretResult(3.2, potassium).isCritical).toBe(false);
    expect(interpretResult(5.5, potassium).code).toBe('H');
    expect(interpretResult(5.5, potassium).isCritical).toBe(false);
  });

  it('escalates values at or beyond the critical thresholds', () => {
    expect(interpretResult(2.4, potassium)).toMatchObject({ code: 'LL', isCritical: true });
    expect(interpretResult(2.5, potassium).isCritical).toBe(true);
    expect(interpretResult(6.5, potassium)).toMatchObject({ code: 'HH', isCritical: true });
    expect(interpretResult(7.9, potassium).isCritical).toBe(true);
  });

  it('escalates a troponin above the critical high', () => {
    const troponin = rangeFor('10839-9', { gender: 'female', ageYears: 62 })!;
    expect(interpretResult(2.5, troponin)).toMatchObject({ code: 'HH', isCritical: true });
    expect(interpretResult(0.02, troponin).code).toBe('N');
  });

  it('returns no interpretation for a missing value or unknown analyte', () => {
    expect(interpretResult(null, potassium).code).toBeNull();
    expect(interpretResult(5, null).code).toBeNull();
    expect(interpretResult(5, null).isCritical).toBe(false);
  });
});

describe('parseHl7Oru', () => {
  const message = [
    'MSH|^~\\&|ANALYSER|LAB|MEDICORE|HOSP|20260725120000||ORU^R01|MSG00001|P|2.5',
    'PID|1||MRN26000001^^^HOSP^MR||Mansouri^Ahmed||19850314|M',
    'OBR|1|ORD123|LAB-2026-000042|24323-8^Comprehensive metabolic panel^LN',
    'OBX|1|NM|2823-3^Potassium^LN||6.8|mmol/L|3.5-5.1|HH|||F',
    'OBX|2|NM|2951-2^Sodium^LN||140|mmol/L|136-145|N|||F',
    'OBX|3|ST|11111-1^Comment^LN||Haemolysed sample||||||P',
  ].join('\r');

  it('extracts the message type, control id and accession number', () => {
    const parsed = parseHl7Oru(message);
    expect(parsed.messageType).toBe('ORU^R01');
    expect(parsed.messageControlId).toBe('MSG00001');
    expect(parsed.accessionNumber).toBe('LAB-2026-000042');
    expect(parsed.patientIdentifier).toBe('MRN26000001');
  });

  it('parses every OBX segment with its numeric value and unit', () => {
    const parsed = parseHl7Oru(message);
    expect(parsed.observations).toHaveLength(3);
    expect(parsed.observations[0]).toMatchObject({
      loinc: '2823-3',
      display: 'Potassium',
      numericValue: 6.8,
      unit: 'mmol/L',
      abnormalFlag: 'HH',
      status: 'final',
    });
  });

  it('leaves a non-numeric result value as a string', () => {
    const parsed = parseHl7Oru(message);
    expect(parsed.observations[2]!.numericValue).toBeNull();
    expect(parsed.observations[2]!.rawValue).toBe('Haemolysed sample');
    expect(parsed.observations[2]!.status).toBe('preliminary');
  });

  it('handles LF and CRLF line endings alike', () => {
    expect(parseHl7Oru(message.replace(/\r/g, '\n')).observations).toHaveLength(3);
    expect(parseHl7Oru(message.replace(/\r/g, '\r\n')).observations).toHaveLength(3);
  });

  it('returns an empty result set for a message with no OBX segments', () => {
    const parsed = parseHl7Oru('MSH|^~\\&|A|B|C|D|20260725||ORU^R01|X|P|2.5');
    expect(parsed.observations).toHaveLength(0);
    expect(parsed.accessionNumber).toBeNull();
  });
});
