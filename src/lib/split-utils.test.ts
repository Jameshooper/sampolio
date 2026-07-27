import { describe, it, expect } from 'vitest';
import {
  toCents,
  fromCents,
  resolveSplit,
  paymentNet,
  computeMemberBalances,
  suggestSettleUp,
  generateOccurrenceDates,
  isAnyRecurrenceDue,
  planRecurrenceRuleUpdate,
  pruneOccurrencesAfter,
  computeSeenWatermark,
  guessCategory,
} from './split-utils';
import type { SplitExpense, SplitGroupMember } from '@/types';

const A = 'user-a';
const B = 'user-b';
const C = 'user-c';
const members = (...ids: string[]): SplitGroupMember[] =>
  ids.map((id) => ({ userId: id, email: `${id}@x`, name: id, role: 'member' as const }));

describe('cents helpers', () => {
  it('round-trips drift-free', () => {
    expect(toCents(98.9)).toBe(9890);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(fromCents(9890)).toBe(98.9);
  });
});

describe('resolveSplit', () => {
  it('equal 2-person: payer is owed half', () => {
    const r = resolveSplit([A, B], 10000, { paidByUserId: A, splitMode: 'equal' });
    expect(r.netByUserId).toEqual({ [A]: 5000, [B]: -5000 });
    expect(r.paidBy).toEqual([{ userId: A, amountCents: 10000 }]);
  });

  it('equal 3-person distributes the remainder cents deterministically', () => {
    const r = resolveSplit([A, B, C], 1000, { paidByUserId: A, splitMode: 'equal' });
    // 10.00 / 3 → 3.34 / 3.33 / 3.33
    const owedSorted = r.owed.map((o) => o.amountCents).sort((x, y) => y - x);
    expect(owedSorted).toEqual([334, 333, 333]);
    // net sums to zero
    expect(Object.values(r.netByUserId).reduce((a, b) => a + b, 0)).toBe(0);
    expect(r.netByUserId[A]).toBe(1000 - 334); // payer paid 1000, owes 334
  });

  it('full: payer owes nothing, the other owes the whole amount', () => {
    const r = resolveSplit([A, B], 5000, { paidByUserId: A, splitMode: 'full' });
    expect(r.netByUserId).toEqual({ [A]: 5000, [B]: -5000 });
    expect(r.owed).toEqual([{ userId: B, amountCents: 5000 }]);
  });

  it('percent split allocates exactly', () => {
    const r = resolveSplit([A, B], 10000, {
      paidByUserId: A,
      splitMode: 'percent',
      splitConfig: { [A]: 7000, [B]: 3000 }, // basis points
    });
    expect(r.netByUserId).toEqual({ [A]: 3000, [B]: -3000 });
  });

  it('exact split sums to total or throws', () => {
    const r = resolveSplit([A, B], 10000, {
      paidByUserId: A,
      splitMode: 'exact',
      splitConfig: { [A]: 6000, [B]: 4000 },
    });
    expect(r.netByUserId).toEqual({ [A]: 4000, [B]: -4000 });
    expect(() =>
      resolveSplit([A, B], 10000, { paidByUserId: A, splitMode: 'exact', splitConfig: { [A]: 6000, [B]: 3000 } }),
    ).toThrow();
  });

  it('rejects a non-member payer', () => {
    expect(() => resolveSplit([A, B], 100, { paidByUserId: 'ghost', splitMode: 'equal' })).toThrow();
  });
});

describe('paymentNet', () => {
  it('payer gains, payee loses (matches the Splitwise export sign)', () => {
    expect(paymentNet(A, B, 25389)).toEqual({ [A]: 25389, [B]: -25389 });
    expect(paymentNet(A, A, 100)).toEqual({});
  });
});

describe('computeMemberBalances', () => {
  it('sums net across rows', () => {
    const rows: SplitExpense[] = [
      { kind: 'expense', id: '1', groupId: 'g', date: '2026-01-01', currency: 'EUR', amountCents: 10000, title: 'x', category: 'General', netByUserId: { [A]: 5000, [B]: -5000 }, source: 'manual', createdByUserId: A, createdAt: '', updatedAt: '' },
      { kind: 'payment', id: '2', groupId: 'g', date: '2026-01-02', currency: 'EUR', amountCents: 2000, fromUserId: B, toUserId: A, netByUserId: { [B]: 2000, [A]: -2000 }, source: 'manual', createdByUserId: B, createdAt: '', updatedAt: '' },
    ];
    const bal = computeMemberBalances(members(A, B), rows);
    expect(bal.find((b) => b.userId === A)!.netCents).toBe(3000);
    expect(bal.find((b) => b.userId === B)!.netCents).toBe(-3000);
  });
});

describe('suggestSettleUp', () => {
  it('proposes the debtor pays the creditor', () => {
    const s = suggestSettleUp([
      { userId: A, name: 'A', netCents: 5000 },
      { userId: B, name: 'B', netCents: -5000 },
    ]);
    expect(s).toEqual([{ fromUserId: B, toUserId: A, amountCents: 5000 }]);
  });
});

describe('generateOccurrenceDates', () => {
  it('walks monthly occurrences from the anchor to today', () => {
    expect(generateOccurrenceDates({ interval: 'monthly', anchorDate: '2020-04-01' }, '2020-07-15')).toEqual([
      '2020-04-01',
      '2020-05-01',
      '2020-06-01',
      '2020-07-01',
    ]);
  });

  it('resumes after lastGeneratedThrough (idempotent)', () => {
    expect(
      generateOccurrenceDates({ interval: 'monthly', anchorDate: '2020-04-01', lastGeneratedThrough: '2020-05-01' }, '2020-07-15'),
    ).toEqual(['2020-06-01', '2020-07-01']);
  });

  it('stops at endDate', () => {
    expect(
      generateOccurrenceDates({ interval: 'monthly', anchorDate: '2020-04-01', endDate: '2020-06-01' }, '2020-12-01'),
    ).toEqual(['2020-04-01', '2020-05-01', '2020-06-01']);
  });

  it('returns [] when nothing is due', () => {
    expect(generateOccurrenceDates({ interval: 'monthly', anchorDate: '2030-01-01' }, '2026-01-01')).toEqual([]);
  });

  it('handles weekly / biweekly / daily / yearly cadences', () => {
    expect(generateOccurrenceDates({ interval: 'weekly', anchorDate: '2026-01-01' }, '2026-01-22')).toEqual([
      '2026-01-01',
      '2026-01-08',
      '2026-01-15',
      '2026-01-22',
    ]);
    expect(generateOccurrenceDates({ interval: 'biweekly', anchorDate: '2026-01-01' }, '2026-01-29')).toEqual([
      '2026-01-01',
      '2026-01-15',
      '2026-01-29',
    ]);
    expect(generateOccurrenceDates({ interval: 'daily', anchorDate: '2026-01-01' }, '2026-01-03')).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
    ]);
    expect(generateOccurrenceDates({ interval: 'yearly', anchorDate: '2024-02-29' }, '2026-03-01')).toEqual([
      '2024-02-29',
      '2025-02-28', // clamped
      '2026-02-28',
    ]);
  });
});

describe('isAnyRecurrenceDue', () => {
  it('only counts active rules with a due occurrence', () => {
    expect(
      isAnyRecurrenceDue(
        [
          { interval: 'monthly', anchorDate: '2020-01-01', isActive: true, lastGeneratedThrough: '2099-01-01' },
          { interval: 'monthly', anchorDate: '2020-01-01', isActive: false },
        ],
        '2026-01-01',
      ),
    ).toBe(false);
    expect(isAnyRecurrenceDue([{ interval: 'monthly', anchorDate: '2025-01-01', isActive: true }], '2026-01-01')).toBe(true);
  });
});

describe('guessCategory', () => {
  it('maps common merchants', () => {
    expect(guessCategory('S market')).toBe('Groceries');
    expect(guessCategory('Lunch Puisto')).toBe('Dining out');
    expect(guessCategory('Ikea sofa')).toBe('Furniture');
    expect(guessCategory('Something obscure')).toBe('General');
  });
});

// A minimal SplitExpense row for the occurrence/watermark tests.
const makeRow = (over: Partial<SplitExpense> & { id: string; createdAt: string }): SplitExpense =>
  ({
    kind: 'expense',
    groupId: 'g',
    date: '2026-01-01',
    currency: 'EUR',
    netByUserId: {},
    source: 'manual',
    createdByUserId: A,
    updatedAt: over.createdAt,
    title: 'x',
    category: 'General',
    amountCents: 100,
    ...over,
  }) as SplitExpense;

describe('generateOccurrenceDates end-date edges', () => {
  it('returns [] when the end date precedes the anchor', () => {
    expect(
      generateOccurrenceDates({ interval: 'monthly', anchorDate: '2026-06-01', endDate: '2026-03-01' }, '2026-12-01'),
    ).toEqual([]);
  });

  it('returns [] when already generated through the end date', () => {
    expect(
      generateOccurrenceDates(
        { interval: 'monthly', anchorDate: '2026-01-01', endDate: '2026-06-01', lastGeneratedThrough: '2026-06-01' },
        '2026-12-01',
      ),
    ).toEqual([]);
  });

  it('includes an occurrence falling exactly on the end date', () => {
    const dates = generateOccurrenceDates(
      { interval: 'monthly', anchorDate: '2026-04-01', endDate: '2026-06-01' },
      '2026-12-01',
    );
    expect(dates).toEqual(['2026-04-01', '2026-05-01', '2026-06-01']);
    expect(dates).toContain('2026-06-01');
  });
});

describe('planRecurrenceRuleUpdate', () => {
  it('leaves the end date untouched when the patch has no endDate key (e.g. a pause)', () => {
    const { updates, pruneAfter } = planRecurrenceRuleUpdate(
      { endDate: undefined, lastGeneratedThrough: '2026-06-01' },
      { isActive: false },
    );
    expect('endDate' in updates).toBe(false);
    expect(updates.isActive).toBe(false);
    expect(pruneAfter).toBeNull();
  });

  it('clears the end date on an explicit null (key present, value undefined) and does not prune without a cursor past it', () => {
    const { updates, pruneAfter } = planRecurrenceRuleUpdate(
      { endDate: '2026-06-01', lastGeneratedThrough: undefined },
      { endDate: null },
    );
    expect('endDate' in updates).toBe(true);
    expect(updates.endDate).toBeUndefined();
    expect(pruneAfter).toBeNull();
  });

  it('prunes + clamps the cursor when the end date is shortened below lastGeneratedThrough', () => {
    const { updates, pruneAfter } = planRecurrenceRuleUpdate(
      { endDate: '2026-12-01', lastGeneratedThrough: '2026-10-01' },
      { endDate: '2026-06-01' },
    );
    expect(updates.endDate).toBe('2026-06-01');
    expect(pruneAfter).toBe('2026-06-01');
    expect(updates.lastGeneratedThrough).toBe('2026-06-01');
  });

  it('does not prune when the end date is extended past the cursor', () => {
    const { updates, pruneAfter } = planRecurrenceRuleUpdate(
      { endDate: '2026-06-01', lastGeneratedThrough: '2026-05-01' },
      { endDate: '2027-01-01' },
    );
    expect(updates.endDate).toBe('2027-01-01');
    expect(pruneAfter).toBeNull();
    expect('lastGeneratedThrough' in updates).toBe(false);
  });

  it('does not prune when there is no lastGeneratedThrough yet', () => {
    const { pruneAfter } = planRecurrenceRuleUpdate(
      { endDate: undefined, lastGeneratedThrough: undefined },
      { endDate: '2026-06-01' },
    );
    expect(pruneAfter).toBeNull();
  });
});

describe('pruneOccurrencesAfter', () => {
  const rows: SplitExpense[] = [
    makeRow({ id: 'on-end', createdAt: '2026-06-01T00:00:00Z', date: '2026-06-01', generatedFromRuleId: 'r1', source: 'recurring' }),
    makeRow({ id: 'after', createdAt: '2026-07-01T00:00:00Z', date: '2026-07-01', generatedFromRuleId: 'r1', source: 'recurring' }),
    makeRow({ id: 'other-rule', createdAt: '2026-07-01T00:00:00Z', date: '2026-07-05', generatedFromRuleId: 'r2', source: 'recurring' }),
    makeRow({ id: 'manual', createdAt: '2026-07-01T00:00:00Z', date: '2026-07-09' }),
  ];

  it('drops only the target rule occurrences after the end date', () => {
    const kept = pruneOccurrencesAfter(rows, 'r1', '2026-06-01');
    const ids = kept.map((r) => r.id);
    expect(ids).not.toContain('after'); // removed
    expect(ids).toContain('on-end'); // kept — exactly on the end date
    expect(ids).toContain('other-rule'); // kept — a different rule
    expect(ids).toContain('manual'); // kept — not generated by any rule
  });
});

describe('computeSeenWatermark', () => {
  const rows: SplitExpense[] = [
    makeRow({ id: 'mine-1', createdAt: '2026-01-02T00:00:00Z', createdByUserId: A }),
    makeRow({ id: 'theirs-1', createdAt: '2026-01-03T00:00:00Z', createdByUserId: B }),
    makeRow({ id: 'theirs-2', createdAt: '2026-01-04T00:00:00Z', createdByUserId: B }),
  ];

  it('returns null when there are no candidates', () => {
    expect(computeSeenWatermark([], null, A, new Set())).toBeNull();
  });

  it('advances to the max createdAt when every candidate is viewed', () => {
    const viewed = new Set(['mine-1', 'theirs-1', 'theirs-2']);
    expect(computeSeenWatermark(rows, null, A, viewed)).toBe('2026-01-04T00:00:00Z');
  });

  it('stops at the first unviewed other-member row (the gap case)', () => {
    // mine-1 auto-passes; theirs-1 is unviewed → frontier stops there.
    expect(computeSeenWatermark(rows, null, A, new Set())).toBe('2026-01-02T00:00:00Z');
  });

  it("lets the viewer's own rows pass without being explicitly viewed", () => {
    const mixed: SplitExpense[] = [
      makeRow({ id: 'mine-1', createdAt: '2026-01-02T00:00:00Z', createdByUserId: A }),
      makeRow({ id: 'mine-2', createdAt: '2026-01-03T00:00:00Z', createdByUserId: A }),
    ];
    expect(computeSeenWatermark(mixed, null, A, new Set())).toBe('2026-01-03T00:00:00Z');
  });

  it('ignores rows at or before the snapshot', () => {
    // Snapshot excludes mine-1 (createdAt equals it) and earlier; theirs-1 is the
    // first candidate and is unviewed → frontier never advances.
    expect(computeSeenWatermark(rows, '2026-01-02T00:00:00Z', A, new Set())).toBeNull();
  });
});
