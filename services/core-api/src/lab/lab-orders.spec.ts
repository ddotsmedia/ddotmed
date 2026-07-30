import {
  ORDER_STATUS_FLOW,
  PRIORITY_RANK,
  barcodeFor,
  canChangePriority,
  canTransition,
  formatOrderNumber,
  isTerminal,
  labelFor,
  sequenceFromOrderNumber,
  sortByUrgency,
} from './lab-orders';

describe('order status flow', () => {
  it('moves a live order to hold, completion or cancellation', () => {
    expect(canTransition('active', 'on_hold')).toBe(true);
    expect(canTransition('active', 'completed')).toBe(true);
    expect(canTransition('active', 'revoked')).toBe(true);
  });

  it('will not resurrect a cancelled or completed order', () => {
    expect(canTransition('revoked', 'active')).toBe(false);
    expect(canTransition('completed', 'active')).toBe(false);
    expect(canTransition('entered_in_error', 'active')).toBe(false);
  });

  it('lets a held order resume', () => {
    expect(canTransition('on_hold', 'active')).toBe(true);
  });

  it('will not skip straight from draft to completed', () => {
    expect(canTransition('draft', 'completed')).toBe(false);
  });

  it('marks the finished states terminal', () => {
    expect(isTerminal('revoked')).toBe(true);
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('entered_in_error')).toBe(true);
    expect(isTerminal('active')).toBe(false);
  });

  it('covers every status in the flow table', () => {
    expect(Object.keys(ORDER_STATUS_FLOW).sort()).toEqual(
      ['active', 'completed', 'draft', 'entered_in_error', 'on_hold', 'revoked'].sort(),
    );
  });
});

describe('canChangePriority', () => {
  it('allows an order to be escalated', () => {
    expect(canChangePriority('active', 'routine', 'stat')).toBe(true);
    expect(canChangePriority('active', 'urgent', 'asap')).toBe(true);
  });

  it('refuses to quietly downgrade urgency', () => {
    expect(canChangePriority('active', 'stat', 'routine')).toBe(false);
    expect(canChangePriority('active', 'urgent', 'routine')).toBe(false);
  });

  it('allows setting the same priority again', () => {
    expect(canChangePriority('active', 'urgent', 'urgent')).toBe(true);
  });

  it('refuses any change once the order is finished', () => {
    expect(canChangePriority('completed', 'routine', 'stat')).toBe(false);
    expect(canChangePriority('revoked', 'routine', 'stat')).toBe(false);
  });
});

describe('sortByUrgency', () => {
  const order = (priority: string, minutes: number) => ({
    priority,
    created_at: new Date(2026, 6, 30, 9, minutes),
    id: `${priority}-${minutes}`,
  });

  it('puts STAT first and routine last', () => {
    const sorted = sortByUrgency([
      order('routine', 0),
      order('stat', 30),
      order('urgent', 10),
      order('asap', 20),
    ]);
    expect(sorted.map((o) => o.priority)).toEqual(['stat', 'asap', 'urgent', 'routine']);
  });

  it('breaks ties by age, oldest first', () => {
    const sorted = sortByUrgency([order('routine', 30), order('routine', 5), order('routine', 15)]);
    expect(sorted.map((o) => o.id)).toEqual(['routine-5', 'routine-15', 'routine-30']);
  });

  it('does not mutate the input', () => {
    const input = [order('routine', 0), order('stat', 1)];
    sortByUrgency(input);
    expect(input[0]!.priority).toBe('routine');
  });

  it('sinks an unrecognised priority below the known ones', () => {
    const sorted = sortByUrgency([order('whenever', 0), order('routine', 30)]);
    expect(sorted[0]!.priority).toBe('routine');
  });

  it('ranks the four priorities in clinical order', () => {
    expect(PRIORITY_RANK.stat).toBeLessThan(PRIORITY_RANK.asap);
    expect(PRIORITY_RANK.asap).toBeLessThan(PRIORITY_RANK.urgent);
    expect(PRIORITY_RANK.urgent).toBeLessThan(PRIORITY_RANK.routine);
  });
});

describe('order numbers and barcodes', () => {
  it('pads the sequence to six digits inside the year', () => {
    expect(formatOrderNumber(2026, 1)).toBe('LAB-2026-000001');
    expect(formatOrderNumber(2026, 123456)).toBe('LAB-2026-123456');
  });

  it('strips separators for the Code 128 payload', () => {
    expect(barcodeFor('LAB-2026-000001')).toBe('LAB2026000001');
  });

  it('reads the sequence back off an order number', () => {
    expect(sequenceFromOrderNumber('LAB-2026-000042')).toBe(42);
  });

  it('reads a missing or malformed order number as zero', () => {
    expect(sequenceFromOrderNumber(null)).toBe(0);
    expect(sequenceFromOrderNumber('LAB-2026-XXXX')).toBe(0);
  });
});

describe('labelFor', () => {
  const patient = { mrn: 'MRN26000001', given_names: ['Aisha', 'Noor'], family_name: 'Rahman' };
  const printedAt = new Date('2026-07-30T08:15:00.000Z');

  it('carries everything needed to identify the tube', () => {
    const label = labelFor(
      {
        order_number: 'LAB-2026-000007',
        barcode: 'LAB2026000007',
        code_display: 'Haemoglobin',
        priority: 'stat',
        fasting_required: true,
      },
      patient,
      printedAt,
    );

    expect(label).toEqual({
      order_number: 'LAB-2026-000007',
      barcode: 'LAB2026000007',
      patient_name: 'Aisha Noor Rahman',
      mrn: 'MRN26000001',
      test_name: 'Haemoglobin',
      priority: 'stat',
      fasting_required: true,
      printed_at: '2026-07-30T08:15:00.000Z',
    });
  });

  it('derives the barcode when the order has none stored', () => {
    const label = labelFor(
      {
        order_number: 'LAB-2026-000008',
        barcode: null,
        code_display: 'Glucose',
        priority: 'routine',
        fasting_required: false,
      },
      patient,
      printedAt,
    );
    expect(label.barcode).toBe('LAB2026000008');
  });
});
