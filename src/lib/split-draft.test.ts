import { describe, it, expect } from 'vitest';
import { emptyDraft, draftFromExpense, draftFromSpec, resolveDraftSpec, type SplitDraft } from './split-draft';
import { resolveSplit } from './split-utils';
import type { SplitExpenseItem, SplitGroupMember } from '@/types';

const ME = 'me';
const OTHER = 'other';
const members: SplitGroupMember[] = [
  { userId: ME, email: 'me@x', name: 'Me', role: 'owner' },
  { userId: OTHER, email: 'o@x', name: 'Sam', role: 'member' },
];
const three: SplitGroupMember[] = [
  ...members,
  { userId: 'c', email: 'c@x', name: 'Carol', role: 'member' },
];

const custom = (over: Partial<SplitDraft>): SplitDraft => ({ ...emptyDraft(ME), preset: 'custom', ...over });

describe('resolveDraftSpec — presets', () => {
  it('maps the four presets to payer + mode', () => {
    expect(resolveDraftSpec({ ...emptyDraft(ME), preset: 'me-equal' }, members, 10000, ME).spec).toEqual({ paidByUserId: ME, splitMode: 'equal' });
    expect(resolveDraftSpec({ ...emptyDraft(ME), preset: 'me-full' }, members, 10000, ME).spec).toEqual({ paidByUserId: ME, splitMode: 'full' });
    expect(resolveDraftSpec({ ...emptyDraft(ME), preset: 'other-equal' }, members, 10000, ME).spec).toEqual({ paidByUserId: OTHER, splitMode: 'equal' });
    expect(resolveDraftSpec({ ...emptyDraft(ME), preset: 'other-full' }, members, 10000, ME).spec).toEqual({ paidByUserId: OTHER, splitMode: 'full' });
  });
});

describe('resolveDraftSpec — custom amounts (the auto-fill requirement)', () => {
  it('fills the other person to reach the total when one amount is set', () => {
    // €100 total, I set my share to €30 → the other auto-fills to €70.
    const draft = custom({ customMode: 'exact', amounts: { [ME]: 30 } });
    const { spec } = resolveDraftSpec(draft, members, 10000, ME);
    expect(spec).toEqual({ paidByUserId: ME, splitMode: 'exact', splitConfig: { [ME]: 3000, [OTHER]: 7000 } });
    // and the engine turns that into the right net (I paid nothing here → payer is me by default)
    const { netByUserId } = resolveSplit([ME, OTHER], 10000, spec!);
    // I paid 100, owe 30 → net +70; other owes 70 → net -70
    expect(netByUserId[ME]).toBe(7000);
    expect(netByUserId[OTHER]).toBe(-7000);
  });

  it('distributes the remainder equally among all untouched members (n>2)', () => {
    // €90, Carol set to €30 → Me + Sam split the remaining €60 → €30 each.
    const draft = custom({ customMode: 'exact', amounts: { c: 30 } });
    const { spec } = resolveDraftSpec(draft, three, 9000, ME);
    expect(spec!.splitConfig).toEqual({ [ME]: 3000, [OTHER]: 3000, c: 3000 });
  });

  it('errors when every amount is set but they do not add up to the total', () => {
    const draft = custom({ customMode: 'exact', amounts: { [ME]: 30, [OTHER]: 30 } });
    const res = resolveDraftSpec(draft, members, 10000, ME);
    expect(res.spec).toBeNull();
    expect(res.error).toMatch(/add up/i);
  });

  it('errors when assigned amounts exceed the total', () => {
    // I alone am assigned €120 on a €100 bill → nothing left for the other → over the total.
    const draft = custom({ customMode: 'exact', amounts: { [ME]: 120 } });
    const res = resolveDraftSpec(draft, members, 10000, ME);
    expect(res.spec).toBeNull();
    expect(res.error).toMatch(/exceed/i);
  });
});

describe('resolveDraftSpec — custom percentages', () => {
  it('fills the other person to reach 100% and the engine allocates cents', () => {
    const draft = custom({ customMode: 'percent', percents: { [ME]: 30 } });
    const { spec } = resolveDraftSpec(draft, members, 10000, ME);
    expect(spec).toEqual({ paidByUserId: ME, splitMode: 'percent', splitConfig: { [ME]: 30, [OTHER]: 70 } });
    const { netByUserId } = resolveSplit([ME, OTHER], 10000, spec!);
    expect(netByUserId[ME]).toBe(7000); // paid 100, owes 30%
    expect(netByUserId[OTHER]).toBe(-7000);
  });

  it('errors when percentages are all set but do not total 100', () => {
    const draft = custom({ customMode: 'percent', percents: { [ME]: 30, [OTHER]: 30 } });
    const res = resolveDraftSpec(draft, members, 10000, ME);
    expect(res.spec).toBeNull();
    expect(res.error).toMatch(/100%/);
  });

  it('custom equal keeps it simple regardless of amount', () => {
    const draft = custom({ customMode: 'equal', payerId: OTHER });
    expect(resolveDraftSpec(draft, members, 10000, ME).spec).toEqual({ paidByUserId: OTHER, splitMode: 'equal' });
  });
});

describe('draftFromExpense / draftFromSpec round-trips', () => {
  const baseRow = {
    id: 'r1', groupId: 'g', date: '2026-07-01', currency: 'EUR' as const,
    netByUserId: {}, source: 'manual' as const, createdByUserId: ME,
    createdAt: '', updatedAt: '', kind: 'expense' as const, title: 't', category: 'General', amountCents: 10000,
  };

  it('two-member equal / full map back to presets', () => {
    const equal: SplitExpenseItem = { ...baseRow, splitMode: 'equal', paidBy: [{ userId: ME, amountCents: 10000 }], owed: [] };
    expect(draftFromExpense(equal, ME, members).preset).toBe('me-equal');
    const full: SplitExpenseItem = { ...baseRow, splitMode: 'full', paidBy: [{ userId: OTHER, amountCents: 10000 }], owed: [] };
    expect(draftFromExpense(full, ME, members).preset).toBe('other-full');
  });

  it('exact expense maps back to a custom amounts draft that re-resolves identically', () => {
    const exact: SplitExpenseItem = {
      ...baseRow, splitMode: 'exact', paidBy: [{ userId: ME, amountCents: 10000 }],
      owed: [{ userId: ME, amountCents: 3000 }, { userId: OTHER, amountCents: 7000 }],
    };
    const d = draftFromExpense(exact, ME, members);
    expect(d.preset).toBe('custom');
    expect(d.customMode).toBe('exact');
    const { spec } = resolveDraftSpec(d, members, 10000, ME);
    expect(spec!.splitConfig).toEqual({ [ME]: 3000, [OTHER]: 7000 });
  });

  it('draftFromSpec restores a percent rule', () => {
    const d = draftFromSpec({ paidByUserId: ME, splitMode: 'percent', splitConfig: { [ME]: 40, [OTHER]: 60 } }, ME, members);
    expect(d.customMode).toBe('percent');
    expect(resolveDraftSpec(d, members, 10000, ME).spec!.splitConfig).toEqual({ [ME]: 40, [OTHER]: 60 });
  });
});
