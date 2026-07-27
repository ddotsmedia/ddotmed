import {
  callOrder,
  estimateWaitMinutes,
  issueToken,
  queueSnapshot,
  tokenPrefix,
  type QueueEntry,
} from './queue-token';

const entry = (over: Partial<QueueEntry> & { id: string; sequence: number }): QueueEntry => ({
  token: `G${String(over.sequence).padStart(3, '0')}`,
  priority: 0,
  status: 'waiting',
  called_at: null,
  ...over,
});

describe('tokenPrefix', () => {
  it('uses the first letter of the queue name', () => {
    expect(tokenPrefix('general')).toBe('G');
    expect(tokenPrefix('ENT')).toBe('E');
    expect(tokenPrefix(' paediatrics')).toBe('P');
  });

  it('falls back to Q when the name does not start with a letter', () => {
    // A digit or symbol read aloud in a waiting room is ambiguous.
    expect(tokenPrefix('1st-floor')).toBe('Q');
    expect(tokenPrefix('')).toBe('Q');
    expect(tokenPrefix('  ')).toBe('Q');
  });
});

describe('issueToken', () => {
  it('starts at 1 for an empty queue', () => {
    const issued = issueToken({ queueName: 'general', lastSequence: 0 });
    expect(issued).toMatchObject({ token: 'G001', sequence: 1, priority: 0 });
  });

  it('increments from the last issued sequence', () => {
    expect(issueToken({ queueName: 'general', lastSequence: 41 }).token).toBe('G042');
  });

  it('pads to three digits and keeps growing past 999', () => {
    expect(issueToken({ queueName: 'general', lastSequence: 8 }).token).toBe('G009');
    expect(issueToken({ queueName: 'general', lastSequence: 999 }).token).toBe('G1000');
  });

  it('carries the triage priority through', () => {
    expect(issueToken({ queueName: 'general', lastSequence: 0, priority: 3 }).priority).toBe(3);
  });

  it('never issues a zero or negative sequence from bad input', () => {
    expect(issueToken({ queueName: 'g', lastSequence: -5 }).sequence).toBe(1);
    expect(issueToken({ queueName: 'g', lastSequence: 2.7 }).sequence).toBe(3);
  });

  it('produces a distinct token per successive call', () => {
    let last = 0;
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const issued = issueToken({ queueName: 'general', lastSequence: last });
      tokens.add(issued.token);
      last = issued.sequence;
    }
    expect(tokens.size).toBe(50);
  });
});

describe('callOrder', () => {
  it('calls in arrival order when priorities are equal', () => {
    const ordered = callOrder([
      entry({ id: 'c', sequence: 3 }),
      entry({ id: 'a', sequence: 1 }),
      entry({ id: 'b', sequence: 2 }),
    ]);
    expect(ordered.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('calls higher priority first regardless of arrival', () => {
    const ordered = callOrder([
      entry({ id: 'first', sequence: 1 }),
      entry({ id: 'urgent', sequence: 9, priority: 3 }),
    ]);
    expect(ordered.map((e) => e.id)).toEqual(['urgent', 'first']);
  });

  it('excludes anyone not still waiting', () => {
    const ordered = callOrder([
      entry({ id: 'waiting', sequence: 2 }),
      entry({ id: 'called', sequence: 1, status: 'called' }),
      entry({ id: 'served', sequence: 3, status: 'served' }),
    ]);
    expect(ordered.map((e) => e.id)).toEqual(['waiting']);
  });

  it('does not mutate its input', () => {
    const input = [entry({ id: 'b', sequence: 2 }), entry({ id: 'a', sequence: 1 })];
    callOrder(input);
    expect(input.map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('estimateWaitMinutes', () => {
  it('is zero at the front of the queue', () => {
    expect(estimateWaitMinutes(0, 15, 1)).toBe(0);
    expect(estimateWaitMinutes(-2, 15, 1)).toBe(0);
  });

  it('scales with queue position', () => {
    expect(estimateWaitMinutes(2, 15, 1)).toBe(30);
    expect(estimateWaitMinutes(4, 15, 1)).toBe(60);
  });

  it('divides across active counters', () => {
    expect(estimateWaitMinutes(4, 15, 2)).toBe(30);
  });

  it('treats zero counters as one rather than dividing by zero', () => {
    expect(Number.isFinite(estimateWaitMinutes(4, 15, 0))).toBe(true);
    expect(estimateWaitMinutes(4, 15, 0)).toBe(60);
  });

  it('rounds to five minutes so the estimate does not look falsely precise', () => {
    expect(estimateWaitMinutes(1, 13, 1) % 5).toBe(0);
    expect(estimateWaitMinutes(3, 7, 2) % 5).toBe(0);
  });
});

describe('queueSnapshot', () => {
  it('separates now-serving from waiting and counts the queue', () => {
    const snapshot = queueSnapshot([
      entry({ id: 'w1', sequence: 3 }),
      entry({ id: 'w2', sequence: 4 }),
      entry({
        id: 'serving',
        sequence: 2,
        status: 'called',
        called_at: new Date('2026-07-27T09:00:00Z'),
      }),
    ]);
    expect(snapshot.nowServing.map((e) => e.id)).toEqual(['serving']);
    expect(snapshot.waiting.map((e) => e.id)).toEqual(['w1', 'w2']);
    expect(snapshot.waitingCount).toBe(2);
  });

  it('shows the most recently called first', () => {
    const snapshot = queueSnapshot([
      entry({ id: 'older', sequence: 1, status: 'called', called_at: new Date('2026-07-27T09:00:00Z') }),
      entry({ id: 'newer', sequence: 2, status: 'called', called_at: new Date('2026-07-27T09:10:00Z') }),
    ]);
    expect(snapshot.nowServing.map((e) => e.id)).toEqual(['newer', 'older']);
  });

  it('handles an empty queue', () => {
    expect(queueSnapshot([])).toEqual({ nowServing: [], waiting: [], waitingCount: 0 });
  });
});
