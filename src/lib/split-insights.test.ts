import { describe, it, expect } from 'vitest';
import {
  aggregatePairwiseNets,
  monthsWindow,
  computeSplitInsights,
  bucketSpendByCategory,
  computeGroupPeriodInsights,
} from './split-insights';
import type { SplitExpense, SplitGroupMember, SplitMemberBalance, SplitShare } from '@/types';

const A = 'user-a';
const B = 'user-b';

const shortName = (id: string) => id.slice(5).toUpperCase(); // 'user-a' → 'A'
const members = (...ids: string[]): SplitGroupMember[] =>
  ids.map((id) => ({ userId: id, email: `${id}@x`, name: shortName(id), role: 'member' as const }));

const bal = (id: string, netCents: number): SplitMemberBalance => ({ userId: id, name: shortName(id), netCents });

function expense(opts: {
  id: string;
  date: string;
  amountCents: number;
  netByUserId: Record<string, number>;
  paidBy?: SplitShare[];
  source?: 'manual' | 'import' | 'recurring';
  category?: string;
  title?: string;
}): SplitExpense {
  return {
    kind: 'expense',
    id: opts.id,
    groupId: 'g',
    date: opts.date,
    currency: 'EUR',
    netByUserId: opts.netByUserId,
    source: opts.source ?? 'manual',
    createdByUserId: A,
    createdAt: `${opts.date}T00:00:00.000Z`,
    updatedAt: `${opts.date}T00:00:00.000Z`,
    title: opts.title ?? opts.id,
    category: opts.category ?? 'General',
    amountCents: opts.amountCents,
    paidBy: opts.paidBy,
  };
}

function payment(opts: { id: string; date: string; amountCents: number; netByUserId: Record<string, number> }): SplitExpense {
  return {
    kind: 'payment',
    id: opts.id,
    groupId: 'g',
    date: opts.date,
    currency: 'EUR',
    netByUserId: opts.netByUserId,
    source: 'manual',
    createdByUserId: A,
    createdAt: `${opts.date}T00:00:00.000Z`,
    updatedAt: `${opts.date}T00:00:00.000Z`,
    fromUserId: A,
    toUserId: B,
    amountCents: opts.amountCents,
  };
}

describe('aggregatePairwiseNets', () => {
  it('matches a single group settle-up (they owe the viewer)', () => {
    const { people, totalByCurrency } = aggregatePairwiseNets(A, [
      { group: { members: members(A, B), currency: 'EUR' }, balances: [bal(A, 5000), bal(B, -5000)] },
    ]);
    expect(people).toEqual([{ userId: B, name: 'B', currency: 'EUR', netCents: 5000 }]);
    expect(totalByCurrency).toEqual({ EUR: 5000 });
  });

  it('sums the viewer position across groups and drops what cancels to zero', () => {
    const { people, totalByCurrency } = aggregatePairwiseNets(A, [
      { group: { members: members(A, B), currency: 'EUR' }, balances: [bal(A, 3000), bal(B, -3000)] },
      { group: { members: members(A, B), currency: 'EUR' }, balances: [bal(A, -3000), bal(B, 3000)] },
    ]);
    expect(people).toEqual([]);
    expect(totalByCurrency).toEqual({});
  });

  it('keeps currencies separate', () => {
    const { totalByCurrency } = aggregatePairwiseNets(A, [
      { group: { members: members(A, B), currency: 'EUR' }, balances: [bal(A, 4000), bal(B, -4000)] },
      { group: { members: members(A, B), currency: 'USD' }, balances: [bal(A, -1000), bal(B, 1000)] },
    ]);
    expect(totalByCurrency).toEqual({ EUR: 4000, USD: -1000 });
  });
});

describe('monthsWindow', () => {
  it('returns monthsBack YYYY-MM strings, oldest → newest, ending this month', () => {
    expect(monthsWindow(3, new Date('2026-07-15T12:00:00Z'))).toEqual(['2026-05', '2026-06', '2026-07']);
  });

  it('crosses a year boundary', () => {
    expect(monthsWindow(3, new Date('2026-01-10T12:00:00Z'))).toEqual(['2025-11', '2025-12', '2026-01']);
  });
});

describe('computeSplitInsights', () => {
  const months = ['2026-05', '2026-06', '2026-07'];

  it('buckets spend and paid attribution; excludes payments from spend', () => {
    const rows: SplitExpense[] = [
      // imported row (no paidBy) in May — B paid, use max(0, net) lower bound
      expense({ id: 'e1', date: '2026-05-20', amountCents: 6000, netByUserId: { [A]: -3000, [B]: 3000 }, source: 'import' }),
      // native row June — A paid 10000, equal split
      expense({ id: 'e2', date: '2026-06-10', amountCents: 10000, netByUserId: { [A]: 5000, [B]: -5000 }, paidBy: [{ userId: A, amountCents: 10000 }] }),
      // native row July — B paid 4000
      expense({ id: 'e3', date: '2026-07-05', amountCents: 4000, netByUserId: { [A]: -2000, [B]: 2000 }, paidBy: [{ userId: B, amountCents: 4000 }] }),
    ];
    const insights = computeSplitInsights(A, [{ group: { id: 'g', name: 'Flat', emoji: '🏠', currency: 'EUR', members: members(A, B) }, rows, totalNetByUserId: { [A]: 0, [B]: 0 } }], months);

    expect(insights.spendByGroup['2026-05'].g).toBe(6000);
    expect(insights.spendByGroup['2026-06'].g).toBe(10000);
    expect(insights.spendByGroup['2026-07'].g).toBe(4000);

    // paid attribution: May B via max(0,net); June A via paidBy; July B via paidBy
    expect(insights.paidByMember['2026-05'][B]).toBe(3000);
    expect(insights.paidByMember['2026-05'][A]).toBeUndefined();
    expect(insights.paidByMember['2026-06'][A]).toBe(10000);
    expect(insights.paidByMember['2026-07'][B]).toBe(4000);

    // baseline 0 (totalNet == window sum) → running net for A
    expect(insights.viewerNetByMonth).toEqual({ '2026-05': -3000, '2026-06': 2000, '2026-07': 0 });

    expect(insights.members).toEqual([{ userId: A, name: 'A' }, { userId: B, name: 'B' }]);
    expect(insights.currencies).toEqual(['EUR']);
    expect(insights.groups).toEqual([{ id: 'g', name: 'Flat', emoji: '🏠', currency: 'EUR' }]);
  });

  it('offsets running net by the pre-window baseline', () => {
    const rows: SplitExpense[] = [
      expense({ id: 'e2', date: '2026-06-10', amountCents: 10000, netByUserId: { [A]: 5000, [B]: -5000 }, paidBy: [{ userId: A, amountCents: 10000 }] }),
    ];
    // cumulative-to-date net (500) exceeds window sum (5000)?  Here window
    // viewer net = 5000; totalNet 5500 ⇒ baseline 500.
    const insights = computeSplitInsights(A, [{ group: { id: 'g', name: 'g', currency: 'EUR', members: members(A, B) }, rows, totalNetByUserId: { [A]: 5500 } }], months);
    expect(insights.viewerNetByMonth).toEqual({ '2026-05': 500, '2026-06': 5500, '2026-07': 5500 });
  });

  it('counts payments in running net but not in spend or paid', () => {
    const rows: SplitExpense[] = [payment({ id: 'p1', date: '2026-06-01', amountCents: 2000, netByUserId: { [A]: 2000, [B]: -2000 } })];
    const insights = computeSplitInsights(A, [{ group: { id: 'g', name: 'g', currency: 'EUR', members: members(A, B) }, rows, totalNetByUserId: { [A]: 2000 } }], months);
    expect(insights.spendByGroup['2026-06']).toEqual({});
    expect(insights.paidByMember['2026-06']).toEqual({});
    expect(insights.viewerNetByMonth).toEqual({ '2026-05': 0, '2026-06': 2000, '2026-07': 2000 });
  });

  it('puts the viewer first in the member union across groups', () => {
    const insights = computeSplitInsights(B, [{ group: { id: 'g', name: 'g', currency: 'EUR', members: members(A, B) }, rows: [], totalNetByUserId: {} }], months);
    expect(insights.members[0].userId).toBe(B);
  });

  it('buckets spend by category, folding blank categories into Other', () => {
    const rows: SplitExpense[] = [
      expense({ id: 'e1', date: '2026-05-02', amountCents: 3000, netByUserId: { [A]: 0 }, category: 'Groceries' }),
      expense({ id: 'e2', date: '2026-05-20', amountCents: 1000, netByUserId: { [A]: 0 }, category: 'Groceries' }),
      expense({ id: 'e3', date: '2026-06-01', amountCents: 500, netByUserId: { [A]: 0 }, category: '   ' }),
      expense({ id: 'e4', date: '2026-06-02', amountCents: 7000, netByUserId: { [A]: 0 }, category: 'Rent' }),
      // payments never enter the category buckets
      payment({ id: 'p1', date: '2026-06-03', amountCents: 900, netByUserId: { [A]: 900, [B]: -900 } }),
    ];
    const insights = computeSplitInsights(A, [{ group: { id: 'g', name: 'g', currency: 'EUR', members: members(A, B) }, rows, totalNetByUserId: {} }], months);

    expect(insights.spendByCategory['2026-05']).toEqual({ Groceries: 4000 });
    expect(insights.spendByCategory['2026-06']).toEqual({ Other: 500, Rent: 7000 });
    expect(insights.spendByCategory['2026-07']).toEqual({});
    // ranked desc by window total: Rent 7000, Groceries 4000, Other 500
    expect(insights.categories).toEqual(['Rent', 'Groceries', 'Other']);
  });

  it('exposes the pre-window baseline as viewerNetBaseline', () => {
    const rows: SplitExpense[] = [
      expense({ id: 'e1', date: '2026-06-10', amountCents: 10000, netByUserId: { [A]: 5000, [B]: -5000 }, paidBy: [{ userId: A, amountCents: 10000 }] }),
    ];
    const insights = computeSplitInsights(A, [{ group: { id: 'g', name: 'g', currency: 'EUR', members: members(A, B) }, rows, totalNetByUserId: { [A]: 5500 } }], months);
    // 5500 cumulative − 5000 inside the window = 500 before it
    expect(insights.viewerNetBaseline).toBe(500);
    expect(insights.viewerNetByMonth['2026-05']).toBe(500);
  });
});

describe('bucketSpendByCategory', () => {
  it('passes data through when the window has at most limit + 1 categories', () => {
    const input = {
      months: ['2026-06', '2026-07'],
      spendByCategory: {
        '2026-06': { Rent: 5000, Groceries: 1000 },
        '2026-07': { Rent: 5000, Other: 200 },
      },
    };
    const out = bucketSpendByCategory(input, 8);
    expect(out.months).toEqual(['2026-06', '2026-07']);
    // 'Other' stays a category of its own when nothing needs bucketing
    expect(out.categories).toEqual(['Rent', 'Groceries', 'Other']);
    expect(out.spend['2026-07']).toEqual({ Rent: 5000, Other: 200 });
  });

  it('keeps the top N and merges the tail (plus any existing Other) into Other', () => {
    const spendByCategory = {
      '2026-07': { Rent: 900, Groceries: 800, Taxi: 700, Other: 600, Games: 500, Hotel: 400 } as Record<string, number>,
    };
    const out = bucketSpendByCategory({ months: ['2026-07'], spendByCategory }, 2);
    // 6 distinct > limit(2) + 1 ⇒ bucket
    expect(out.categories).toEqual(['Rent', 'Groceries', 'Other']);
    // Other = 700 (Taxi) + 600 (existing Other) + 500 (Games) + 400 (Hotel)
    expect(out.spend['2026-07']).toEqual({ Rent: 900, Groceries: 800, Other: 2200 });
  });

  it('never mutates the source map', () => {
    const spendByCategory = { '2026-07': { Rent: 100 } };
    const out = bucketSpendByCategory({ months: ['2026-07'], spendByCategory });
    out.spend['2026-07'].Rent = 999;
    expect(spendByCategory['2026-07'].Rent).toBe(100);
  });
});

describe('computeGroupPeriodInsights', () => {
  const mem = [
    { userId: A, name: 'A' },
    { userId: B, name: 'B' },
  ];

  it('filters to the window inclusively at both ends', () => {
    const rows: SplitExpense[] = [
      expense({ id: 'before', date: '2026-06-30', amountCents: 100, netByUserId: { [A]: 0 }, paidBy: [{ userId: A, amountCents: 100 }] }),
      expense({ id: 'from', date: '2026-07-01', amountCents: 200, netByUserId: { [A]: 0 }, paidBy: [{ userId: A, amountCents: 200 }] }),
      expense({ id: 'to', date: '2026-07-31', amountCents: 300, netByUserId: { [A]: 0 }, paidBy: [{ userId: A, amountCents: 300 }] }),
      expense({ id: 'after', date: '2026-08-01', amountCents: 400, netByUserId: { [A]: 0 }, paidBy: [{ userId: A, amountCents: 400 }] }),
    ];
    const out = computeGroupPeriodInsights(mem, rows, '2026-07-01', '2026-07-31');
    expect(out.expenseCount).toBe(2);
    expect(out.totalSpendCents).toBe(500);
  });

  it('counts payments only as settled, never as spend', () => {
    const rows: SplitExpense[] = [payment({ id: 'p1', date: '2026-07-10', amountCents: 2500, netByUserId: { [A]: 2500, [B]: -2500 } })];
    const out = computeGroupPeriodInsights(mem, rows, '2026-07-01', '2026-07-31');
    expect(out).toMatchObject({ totalSpendCents: 0, expenseCount: 0, settledCents: 2500 });
    expect(out.paidByMember).toEqual([]);
    expect(out.topCategories).toEqual([]);
  });

  it('splits paid attribution by share and reports fractional pct, desc', () => {
    const rows: SplitExpense[] = [
      expense({ id: 'e1', date: '2026-07-02', amountCents: 6000, netByUserId: { [A]: 3000, [B]: -3000 }, paidBy: [{ userId: A, amountCents: 6000 }] }),
      expense({ id: 'e2', date: '2026-07-03', amountCents: 2000, netByUserId: { [A]: -1000, [B]: 1000 }, paidBy: [{ userId: B, amountCents: 2000 }] }),
    ];
    const out = computeGroupPeriodInsights(mem, rows, '2026-07-01', '2026-07-31');
    expect(out.paidByMember).toEqual([
      { userId: A, name: 'A', cents: 6000, pct: 0.75 },
      { userId: B, name: 'B', cents: 2000, pct: 0.25 },
    ]);
    expect(out.hasImportedRows).toBe(false);
  });

  it('falls back to max(0, net) for imported rows and flags the lower bound', () => {
    const rows: SplitExpense[] = [
      expense({ id: 'i1', date: '2026-07-05', amountCents: 6000, netByUserId: { [A]: -3000, [B]: 3000 }, source: 'import' }),
    ];
    const out = computeGroupPeriodInsights(mem, rows, '2026-07-01', '2026-07-31');
    expect(out.hasImportedRows).toBe(true);
    // only B's positive net is credited — 3000, not the 6000 actually fronted
    expect(out.paidByMember).toEqual([{ userId: B, name: 'B', cents: 3000, pct: 1 }]);
  });

  it('ranks categories desc with counts and blank → Other', () => {
    const rows: SplitExpense[] = [
      expense({ id: 'e1', date: '2026-07-02', amountCents: 1000, netByUserId: { [A]: 0 }, category: 'Groceries' }),
      expense({ id: 'e2', date: '2026-07-03', amountCents: 1500, netByUserId: { [A]: 0 }, category: 'Groceries' }),
      expense({ id: 'e3', date: '2026-07-04', amountCents: 900, netByUserId: { [A]: 0 }, category: '' }),
    ];
    const out = computeGroupPeriodInsights(mem, rows, '2026-07-01', '2026-07-31');
    expect(out.topCategories).toEqual([
      { category: 'Groceries', cents: 2500, count: 2 },
      { category: 'Other', cents: 900, count: 1 },
    ]);
  });

  it('caps topExpenses at the three largest', () => {
    const rows: SplitExpense[] = [1, 2, 3, 4, 5].map((n) =>
      expense({ id: `e${n}`, title: `Item ${n}`, date: `2026-07-0${n}`, amountCents: n * 1000, netByUserId: { [A]: 0 } }),
    );
    const out = computeGroupPeriodInsights(mem, rows, '2026-07-01', '2026-07-31');
    expect(out.topExpenses.map((e) => e.title)).toEqual(['Item 5', 'Item 4', 'Item 3']);
    expect(out.topExpenses[0]).toMatchObject({ id: 'e5', cents: 5000, category: 'General', date: '2026-07-05' });
  });

  it('returns an empty summary for an empty window', () => {
    const out = computeGroupPeriodInsights(mem, [], '2026-07-01', '2026-07-31');
    expect(out).toEqual({
      totalSpendCents: 0,
      expenseCount: 0,
      settledCents: 0,
      paidByMember: [],
      topCategories: [],
      topExpenses: [],
      hasImportedRows: false,
    });
  });
});
