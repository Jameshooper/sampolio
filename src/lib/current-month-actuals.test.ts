import { describe, it, expect } from 'vitest';
import { applyCurrentMonthActuals, type ActualizableLine, type ActualTxLike } from './current-month-actuals';
import type { ProjectionLineItem } from '@/types';

let nextId = 0;

function line(overrides: Partial<ProjectionLineItem> & { name: string; amount: number }): ProjectionLineItem {
  nextId += 1;
  return { itemId: `item-${nextId}`, source: 'recurring', ...overrides };
}

function full(overrides: Partial<ProjectionLineItem> & { name: string; amount: number }, type: 'income' | 'expense' = 'expense'): ActualizableLine {
  return { line: line(overrides), type, policy: 'full' };
}

function exactOnly(overrides: Partial<ProjectionLineItem> & { name: string; amount: number }, type: 'income' | 'expense' = 'expense'): ActualizableLine {
  return { line: line(overrides), type, policy: 'exact-only' };
}

function none(overrides: Partial<ProjectionLineItem> & { name: string; amount: number }, type: 'income' | 'expense' = 'expense'): ActualizableLine {
  return { line: line(overrides), type, policy: 'none' };
}

function tx(overrides: Partial<ActualTxLike> & { id: string; amount: number }): ActualTxLike {
  return { bookingDate: '2026-07-05', ...overrides };
}

describe('applyCurrentMonthActuals', () => {
  it('matches an expense line to a debit, and an income line to a credit', () => {
    const lines = [full({ name: 'Electricity', amount: 80 }), full({ name: 'Salary', amount: 3000 }, 'income')];
    const txs = [tx({ id: 't1', amount: -80, counterpartyName: 'Electricity' }), tx({ id: 't2', amount: 3000, counterpartyName: 'Salary' })];
    const out = applyCurrentMonthActuals(lines, txs);
    expect(out.lines[0]).toMatchObject({ isPaid: true, remainingAmount: 0, matchedTxId: 't1' });
    expect(out.lines[1]).toMatchObject({ isPaid: true, remainingAmount: 0, matchedTxId: 't2' });
  });

  it('never matches an expense line to a credit', () => {
    const out = applyCurrentMonthActuals([full({ name: 'Electricity', amount: 80 })], [tx({ id: 't1', amount: 80, counterpartyName: 'Electricity' })]);
    expect(out.lines[0]).toMatchObject({ isPaid: false, remainingAmount: 80 });
  });

  it('never matches an income line to a debit', () => {
    const out = applyCurrentMonthActuals([full({ name: 'Salary', amount: 80 }, 'income')], [tx({ id: 't1', amount: -80, counterpartyName: 'Salary' })]);
    expect(out.lines[0]).toMatchObject({ isPaid: false, remainingAmount: 80 });
  });

  it('matches within the abs floor tolerance on a small amount, not just beyond it', () => {
    // amount=10 -> tolerance = max(1, 0.05*10=0.5) = 1
    const within = applyCurrentMonthActuals([full({ name: 'Coffee', amount: 10 })], [tx({ id: 't1', amount: -11 })]);
    expect(within.lines[0]).toMatchObject({ isPaid: true, remainingAmount: 0 });

    const outside = applyCurrentMonthActuals([full({ name: 'Coffee', amount: 10 })], [tx({ id: 't1', amount: -11.5 })]);
    expect(outside.lines[0]).toMatchObject({ isPaid: false, remainingAmount: 10 });
  });

  it('matches within the 5% tolerance on a large amount, not just beyond it', () => {
    // amount=200 -> tolerance = max(1, 0.05*200=10) = 10
    const within = applyCurrentMonthActuals([full({ name: 'Rent', amount: 200 })], [tx({ id: 't1', amount: -210 })]);
    expect(within.lines[0]).toMatchObject({ isPaid: true, remainingAmount: 0 });

    const outside = applyCurrentMonthActuals([full({ name: 'Rent', amount: 200 })], [tx({ id: 't1', amount: -211 })]);
    expect(outside.lines[0]).toMatchObject({ isPaid: false, remainingAmount: 200 });
  });

  it('one-to-one: two identical-amount lines competing for one tx leaves exactly one paid', () => {
    const lines = [full({ name: 'Sub A', amount: 15 }), full({ name: 'Sub B', amount: 15 })];
    const txs = [tx({ id: 't1', amount: -15 })];
    const out = applyCurrentMonthActuals(lines, txs);
    const paidCount = out.lines.filter((l) => l.isPaid).length;
    expect(paidCount).toBe(1);
  });

  it('one-to-one: two txs competing for one line consumes exactly one tx', () => {
    const lines = [full({ name: 'Sub A', amount: 15 })];
    const txs = [tx({ id: 't1', amount: -15 }), tx({ id: 't2', amount: -15 })];
    const out = applyCurrentMonthActuals(lines, txs);
    expect(out.lines[0]).toMatchObject({ isPaid: true });
    // only one of the two txs is consumed; the other remains "unmatched" for gap purposes.
    const matchedId = out.lines[0].matchedTxId;
    expect(['t1', 't2']).toContain(matchedId);
  });

  it('name affinity beats a closer amount delta', () => {
    // Line "Internet" amount 50. tx A: amount -50.5 (closer delta) but no name match.
    // tx B: amount -48 (further delta, but within tolerance) with matching counterparty name.
    const lines = [full({ name: 'Internet', amount: 50 })];
    const txs = [
      tx({ id: 'no-name-match', amount: -50.5, counterpartyName: 'Random Shop' }),
      tx({ id: 'name-match', amount: -48, counterpartyName: 'Internet Oy' }),
    ];
    const out = applyCurrentMonthActuals(lines, txs);
    expect(out.lines[0].matchedTxId).toBe('name-match');
  });

  it('strips a leading "Mortgage: " injected prefix so the remainder name-matches the counterparty', () => {
    // "Mortgage: Foo" -> stripped to "Foo", matches tx counterparty "Foo Bank".
    // A second, amount-closer tx with no name relation should lose to the name match.
    const lines = [full({ name: 'Mortgage: Foo', amount: 500 }, 'expense')];
    const txs = [
      tx({ id: 'closer-no-name', amount: -500.5, counterpartyName: 'Unrelated Corp' }),
      tx({ id: 'foo-bank', amount: -480, counterpartyName: 'Foo Bank' }),
    ];
    const out = applyCurrentMonthActuals(lines, txs);
    expect(out.lines[0].matchedTxId).toBe('foo-bank');
  });

  it('a matched tx amount different from planned (but within tolerance) yields remainingAmount exactly 0', () => {
    const out = applyCurrentMonthActuals([full({ name: 'Water', amount: 40 })], [tx({ id: 't1', amount: -41.5 })]);
    expect(out.lines[0].remainingAmount).toBe(0);
  });

  it("policy 'none' lines are never matched, even against a perfect tx", () => {
    const lines = [none({ name: 'Ghost', amount: 100 })];
    const txs = [tx({ id: 't1', amount: -100, counterpartyName: 'Ghost' })];
    const out = applyCurrentMonthActuals(lines, txs);
    expect(out.lines[0]).toMatchObject({ isPaid: false, remainingAmount: 100 });
    expect(out.lines[0].matchedTxId).toBeUndefined();
  });

  it("policy 'exact-only' lines match exactly but are never gap-reduced by same-category spend", () => {
    // exact-only Groceries line stays unmatched; unmatched grocery spend elsewhere must NOT reduce it.
    const lines = [exactOnly({ name: 'Groceries budget', amount: 400, category: 'Food & Groceries' })];
    const txs = [tx({ id: 't1', amount: -150, counterpartyName: 'Prisma' })];
    const out = applyCurrentMonthActuals(lines, txs);
    expect(out.lines[0]).toMatchObject({ isPaid: false, remainingAmount: 400 });
  });

  it('category gap: reduces a Groceries line by unmatched grocery-store spend', () => {
    const lines = [full({ name: 'Groceries', amount: 400, category: 'Food & Groceries' })];
    const txs = [tx({ id: 't1', amount: -90, counterpartyName: 'Prisma' }), tx({ id: 't2', amount: -60, counterpartyName: 'K-Market' })];
    const out = applyCurrentMonthActuals(lines, txs);
    expect(out.lines[0].isPaid).toBe(false);
    expect(out.lines[0].remainingAmount).toBeCloseTo(250, 5);
  });

  it('category gap floors at 0 when spend exceeds the planned amount', () => {
    const lines = [full({ name: 'Groceries', amount: 100, category: 'Food & Groceries' })];
    const txs = [tx({ id: 't1', amount: -90, counterpartyName: 'Prisma' }), tx({ id: 't2', amount: -60, counterpartyName: 'K-Market' })];
    const out = applyCurrentMonthActuals(lines, txs);
    expect(out.lines[0].remainingAmount).toBe(0);
    expect(out.lines[0].isPaid).toBe(false); // gap-reduced, not exact-matched
  });

  it('splits the remaining category gap proportionally across two lines sharing a category', () => {
    // Groceries A=300, B=100 (planned total 400). Unmatched grocery spend=150 -> remainingInC=250.
    // A gets 300 * 250/400 = 187.5, B gets 100 * 250/400 = 62.5.
    const lines = [
      full({ name: 'Groceries A', amount: 300, category: 'Food & Groceries' }),
      full({ name: 'Groceries B', amount: 100, category: 'Food & Groceries' }),
    ];
    const txs = [tx({ id: 't1', amount: -90, counterpartyName: 'Prisma' }), tx({ id: 't2', amount: -60, counterpartyName: 'K-Market' })];
    const out = applyCurrentMonthActuals(lines, txs);
    expect(out.lines[0].remainingAmount).toBeCloseTo(187.5, 5);
    expect(out.lines[1].remainingAmount).toBeCloseTo(62.5, 5);
  });

  it('a debit that guessItemCategory cannot categorize reduces nothing', () => {
    const lines = [full({ name: 'Groceries', amount: 400, category: 'Food & Groceries' })];
    // 'Xyzzy Corp' matches no keyword in guessItemCategory -> category null -> contributes nothing.
    const txs = [tx({ id: 't1', amount: -150, counterpartyName: 'Xyzzy Corp' })];
    const out = applyCurrentMonthActuals(lines, txs);
    expect(out.lines[0].remainingAmount).toBe(400);
  });

  it('income lines are never gap-reduced by stray credits', () => {
    const lines = [full({ name: 'Freelance income', amount: 500, category: 'Freelance' }, 'income')];
    const txs = [tx({ id: 't1', amount: 200, counterpartyName: 'Some Client' })];
    const out = applyCurrentMonthActuals(lines, txs);
    expect(out.lines[0]).toMatchObject({ isPaid: false, remainingAmount: 500 });
  });

  it('aggregates actualToDateNet over ALL supplied transactions and excludes matched txs from unmatchedSpendByCategory', () => {
    const lines = [full({ name: 'Electricity', amount: 80 })];
    const txs = [
      tx({ id: 'matched', amount: -80, counterpartyName: 'Electricity' }),
      tx({ id: 'unmatched-grocery', amount: -50, counterpartyName: 'Prisma' }),
      tx({ id: 'credit', amount: 1000, counterpartyName: 'Salary' }),
    ];
    const out = applyCurrentMonthActuals(lines, txs);
    expect(out.actualToDateNet).toBe(-80 - 50 + 1000);
    expect(out.unmatchedSpendByCategory.get('Food & Groceries')).toBe(50);
    // The matched tx's own amount must not leak into any category bucket.
    for (const v of out.unmatchedSpendByCategory.values()) {
      expect(v).not.toBe(80);
    }
  });

  it('preserves input line order and never mutates the input line objects', () => {
    const l1 = full({ name: 'B', amount: 10 });
    const l2 = full({ name: 'A', amount: 20 });
    const originalL1 = { ...l1.line };
    const originalL2 = { ...l2.line };
    const out = applyCurrentMonthActuals([l1, l2], [tx({ id: 't1', amount: -10, counterpartyName: 'B' })]);
    expect(out.lines[0].line).toBe(l1.line);
    expect(out.lines[1].line).toBe(l2.line);
    expect(l1.line).toEqual(originalL1);
    expect(l2.line).toEqual(originalL2);
  });
});
