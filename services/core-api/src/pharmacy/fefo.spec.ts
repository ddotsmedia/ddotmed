import { bucketByExpiry, pickFefo, verifyFiveRights, type StockBatch } from './fefo';

const NOW = new Date('2026-07-25T00:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const batch = (over: Partial<StockBatch> = {}): StockBatch => ({
  id: 'b1',
  batch_number: 'B001',
  expiry_date: days(365),
  quantity_on_hand: 100,
  quantity_reserved: 0,
  is_recalled: false,
  ...over,
});

describe('pickFefo', () => {
  it('picks the earliest-expiring batch first', () => {
    const result = pickFefo(
      [
        batch({ id: 'b1', batch_number: 'B001', expiry_date: days(365) }),
        batch({ id: 'b2', batch_number: 'B002', expiry_date: days(30) }),
        batch({ id: 'b3', batch_number: 'B003', expiry_date: days(90) }),
      ],
      50,
      NOW,
    );
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.batch_id).toBe('b2');
    expect(result.short_by).toBe(0);
  });

  it('splits across batches in expiry order when one is not enough', () => {
    const result = pickFefo(
      [
        batch({ id: 'b1', expiry_date: days(30), quantity_on_hand: 20 }),
        batch({ id: 'b2', batch_number: 'B002', expiry_date: days(60), quantity_on_hand: 50 }),
      ],
      45,
      NOW,
    );
    expect(result.lines).toEqual([
      expect.objectContaining({ batch_id: 'b1', quantity: 20 }),
      expect.objectContaining({ batch_id: 'b2', quantity: 25 }),
    ]);
    expect(result.short_by).toBe(0);
  });

  it('never picks an expired batch, even if it expires soonest', () => {
    const result = pickFefo(
      [
        batch({ id: 'expired', batch_number: 'OLD', expiry_date: days(-1) }),
        batch({ id: 'good', batch_number: 'NEW', expiry_date: days(60) }),
      ],
      10,
      NOW,
    );
    expect(result.lines[0]!.batch_id).toBe('good');
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ batch_id: 'expired', reason: 'expired' }),
    );
  });

  it('treats a batch expiring exactly now as expired', () => {
    const result = pickFefo([batch({ expiry_date: NOW })], 10, NOW);
    expect(result.lines).toHaveLength(0);
    expect(result.short_by).toBe(10);
  });

  it('never picks a recalled batch', () => {
    const result = pickFefo(
      [
        batch({ id: 'recalled', batch_number: 'R1', expiry_date: days(10), is_recalled: true }),
        batch({ id: 'good', batch_number: 'G1', expiry_date: days(60) }),
      ],
      10,
      NOW,
    );
    expect(result.lines[0]!.batch_id).toBe('good');
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ batch_id: 'recalled', reason: 'recalled' }),
    );
  });

  it('excludes reserved quantity from what is available', () => {
    const result = pickFefo(
      [batch({ quantity_on_hand: 100, quantity_reserved: 95 })],
      10,
      NOW,
    );
    expect(result.lines[0]!.quantity).toBe(5);
    expect(result.short_by).toBe(5);
  });

  it('reports a shortfall rather than over-picking', () => {
    const result = pickFefo([batch({ quantity_on_hand: 5 })], 20, NOW);
    expect(result.lines[0]!.quantity).toBe(5);
    expect(result.short_by).toBe(15);
  });

  it('breaks ties on the same expiry deterministically by batch number', () => {
    const batches = [
      batch({ id: 'b2', batch_number: 'B002', expiry_date: days(30) }),
      batch({ id: 'b1', batch_number: 'B001', expiry_date: days(30) }),
    ];
    expect(pickFefo(batches, 10, NOW).lines[0]!.batch_number).toBe('B001');
    expect(pickFefo([...batches].reverse(), 10, NOW).lines[0]!.batch_number).toBe('B001');
  });

  it('returns nothing for a zero or negative request', () => {
    expect(pickFefo([batch()], 0, NOW).lines).toHaveLength(0);
    expect(pickFefo([batch()], -5, NOW).lines).toHaveLength(0);
  });
});

describe('verifyFiveRights', () => {
  const base = {
    scanned_patient_barcode: 'MRN26000001',
    expected_patient_barcode: 'MRN26000001',
    scanned_medication_barcode: 'DRUG-161',
    expected_medication_barcode: 'DRUG-161',
    dose_given: 500,
    dose_ordered: 500,
    route_given: 'oral',
    route_ordered: 'oral',
    scheduled_at: new Date('2026-07-25T08:00:00Z'),
    administered_at: new Date('2026-07-25T08:15:00Z'),
  };

  it('passes all five rights on a correct administration', () => {
    const r = verifyFiveRights(base);
    expect(r.verified).toBe(true);
    expect(r.wrongPatient).toBe(false);
    expect(r.failures).toHaveLength(0);
  });

  it('flags a wrong patient distinctly from other failures', () => {
    const r = verifyFiveRights({ ...base, scanned_patient_barcode: 'MRN26000099' });
    expect(r.verified).toBe(false);
    expect(r.wrongPatient).toBe(true);
    expect(r.failures[0]!.detail).toMatch(/WRONG PATIENT/);
  });

  it('flags a medication, dose or route mismatch without a wrong-patient flag', () => {
    expect(verifyFiveRights({ ...base, scanned_medication_barcode: 'DRUG-999' })).toMatchObject({
      verified: false,
      wrongPatient: false,
    });
    expect(verifyFiveRights({ ...base, dose_given: 250 }).failures[0]!.right).toBe('dose');
    expect(verifyFiveRights({ ...base, route_given: 'IV' }).failures[0]!.right).toBe('route');
  });

  it('ignores barcode case and surrounding whitespace', () => {
    expect(
      verifyFiveRights({ ...base, scanned_patient_barcode: '  mrn26000001 ' }).verified,
    ).toBe(true);
  });

  it('fails when administration falls outside the time window', () => {
    const late = verifyFiveRights({
      ...base,
      administered_at: new Date('2026-07-25T10:30:00Z'),
    });
    expect(late.verified).toBe(false);
    expect(late.failures[0]!.right).toBe('time');

    const early = verifyFiveRights({
      ...base,
      administered_at: new Date('2026-07-25T06:00:00Z'),
    });
    expect(early.failures[0]!.right).toBe('time');
  });

  it('skips the time check for an unscheduled PRN dose', () => {
    expect(verifyFiveRights({ ...base, scheduled_at: null }).verified).toBe(true);
  });

  it('honours a custom time window', () => {
    expect(
      verifyFiveRights({ ...base, time_window_minutes: 10 }).failures.map((f) => f.right),
    ).toEqual(['time']);
  });

  it('reports every failing right at once, not just the first', () => {
    const r = verifyFiveRights({
      ...base,
      scanned_patient_barcode: 'X',
      dose_given: 1,
      route_given: 'IV',
    });
    expect(r.failures.map((f) => f.right).sort()).toEqual(['dose', 'patient', 'route']);
  });
});

describe('bucketByExpiry', () => {
  it('buckets stock by expiry horizon', () => {
    const b = bucketByExpiry(
      [
        batch({ expiry_date: days(-5), quantity_on_hand: 10 }),
        batch({ expiry_date: days(15), quantity_on_hand: 20 }),
        batch({ expiry_date: days(60), quantity_on_hand: 30 }),
        batch({ expiry_date: days(200), quantity_on_hand: 40 }),
      ],
      NOW,
    );
    expect(b).toEqual({ expired: 10, within30Days: 20, within90Days: 30 });
  });
});
