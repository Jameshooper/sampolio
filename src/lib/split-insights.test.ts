import { describe, it, expect } from 'vitest';
import { aggregatePairwiseNets, monthsWindow, computeSplitInsights } from './split-insights';
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
    title: opts.id,
    category: 'General',
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
});
