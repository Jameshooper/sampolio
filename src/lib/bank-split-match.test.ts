import { describe, it, expect } from 'vitest';
import { matchTransactionsToSplits, type BankTxForMatch } from './bank-split-match';
import type { SplitLinkCandidate } from '@/types';

function tx(overrides: Partial<BankTxForMatch> & { id: string }): BankTxForMatch {
  return { amount: -10, currency: 'EUR', bookingDate: '2026-07-01', ...overrides };
}

function candidate(overrides: Partial<SplitLinkCandidate> & { expenseId: string }): SplitLinkCandidate {
  return {
    groupId: 'g1',
    groupName: 'Roomies',
    title: 'Groceries',
    date: '2026-07-01',
    amountCents: 1000,
    currency: 'EUR',
    ...overrides,
  };
}

describe('matchTransactionsToSplits', () => {
  it('matches an explicit link by txId even with different amount/date', () => {
    const t = tx({ id: 'tx1', amount: -999, bookingDate: '2020-01-01' });
    const c = candidate({ expenseId: 'e1', amountCents: 1, date: '2099-12-31', bankLink: { txId: 'tx1', linkedAccountId: 'l1', ownerUserId: 'u1' } });
    const out = matchTransactionsToSplits([t], [c]);
    expect(out.get('tx1')).toMatchObject({ kind: 'linked', expenseId: 'e1' });
  });

  it('prefers the explicit link over a heuristic candidate that would also match', () => {
    const t = tx({ id: 'tx1', amount: -10, bookingDate: '2026-07-01' });
    const linked = candidate({ expenseId: 'e-linked', bankLink: { txId: 'tx1', linkedAccountId: 'l1', ownerUserId: 'u1' } });
    const heuristic = candidate({ expenseId: 'e-heuristic', amountCents: 1000, date: '2026-07-01' });
    const out = matchTransactionsToSplits([t], [linked, heuristic]);
    expect(out.get('tx1')).toMatchObject({ kind: 'linked', expenseId: 'e-linked' });
  });

  it('matches heuristically on exact-cents amount, including float safety', () => {
    const t = tx({ id: 'tx1', amount: -27.03, bookingDate: '2026-07-01' });
    const c = candidate({ expenseId: 'e1', amountCents: 2703, date: '2026-07-01' });
    const out = matchTransactionsToSplits([t], [c]);
    expect(out.get('tx1')).toMatchObject({ kind: 'heuristic', expenseId: 'e1' });
  });

  it('matches within ±3 days but not at ±4 days, in both directions', () => {
    const base = { amount: -10, currency: 'EUR' };
    const c = candidate({ expenseId: 'e1', amountCents: 1000, date: '2026-07-10' });

    const within = matchTransactionsToSplits(
      [tx({ id: 'earlier3', ...base, bookingDate: '2026-07-07' }), tx({ id: 'later3', ...base, bookingDate: '2026-07-13' })],
      [c],
    );
    // Only one of the two can claim the single candidate; both are within tolerance so one must match.
    expect(within.size).toBe(1);

    const outside = matchTransactionsToSplits(
      [tx({ id: 'earlier4', ...base, bookingDate: '2026-07-06' })],
      [candidate({ expenseId: 'e2', amountCents: 1000, date: '2026-07-10' })],
    );
    expect(outside.size).toBe(0);

    const outsideLater = matchTransactionsToSplits(
      [tx({ id: 'later4', ...base, bookingDate: '2026-07-14' })],
      [candidate({ expenseId: 'e3', amountCents: 1000, date: '2026-07-10' })],
    );
    expect(outsideLater.size).toBe(0);
  });

  it('never matches across a currency mismatch', () => {
    const t = tx({ id: 'tx1', amount: -10, currency: 'USD', bookingDate: '2026-07-01' });
    const c = candidate({ expenseId: 'e1', amountCents: 1000, currency: 'EUR', date: '2026-07-01' });
    expect(matchTransactionsToSplits([t], [c]).size).toBe(0);
  });

  it('never heuristically matches a positive (credit) transaction', () => {
    const t = tx({ id: 'tx1', amount: 10, bookingDate: '2026-07-01' });
    const c = candidate({ expenseId: 'e1', amountCents: 1000, date: '2026-07-01' });
    expect(matchTransactionsToSplits([t], [c]).size).toBe(0);
  });

  it('excludes a candidate explicitly linked to a different tx from heuristic matching', () => {
    const t = tx({ id: 'tx1', amount: -10, bookingDate: '2026-07-01' });
    const c = candidate({
      expenseId: 'e1',
      amountCents: 1000,
      date: '2026-07-01',
      bankLink: { txId: 'some-other-tx', linkedAccountId: 'l1', ownerUserId: 'u1' },
    });
    expect(matchTransactionsToSplits([t], [c]).size).toBe(0);
  });

  it('resolves two candidates competing for one tx by picking the closer date', () => {
    const t = tx({ id: 'tx1', amount: -10, bookingDate: '2026-07-10' });
    const near = candidate({ expenseId: 'near', amountCents: 1000, date: '2026-07-09' });
    const far = candidate({ expenseId: 'far', amountCents: 1000, date: '2026-07-12' });
    const out = matchTransactionsToSplits([t], [near, far]);
    expect(out.get('tx1')).toMatchObject({ expenseId: 'near' });
  });

  it('flags only one of two competing transactions for a single candidate', () => {
    const t1 = tx({ id: 'tx1', amount: -10, bookingDate: '2026-07-09' });
    const t2 = tx({ id: 'tx2', amount: -10, bookingDate: '2026-07-12' });
    const c = candidate({ expenseId: 'e1', amountCents: 1000, date: '2026-07-10' });
    const out = matchTransactionsToSplits([t1, t2], [c]);
    expect(out.size).toBe(1);
    expect(out.get('tx1')).toMatchObject({ expenseId: 'e1' });
    expect(out.has('tx2')).toBe(false);
  });

  it('matches a bookingDate with a time component against a plain-date candidate', () => {
    const t = tx({ id: 'tx1', amount: -10, bookingDate: '2026-07-01T09:30:00' });
    const c = candidate({ expenseId: 'e1', amountCents: 1000, date: '2026-07-01' });
    const out = matchTransactionsToSplits([t], [c]);
    expect(out.get('tx1')).toMatchObject({ kind: 'heuristic', expenseId: 'e1' });
  });

  it('returns an empty map for empty inputs', () => {
    expect(matchTransactionsToSplits([], []).size).toBe(0);
    expect(matchTransactionsToSplits([tx({ id: 'tx1' })], []).size).toBe(0);
    expect(matchTransactionsToSplits([], [candidate({ expenseId: 'e1' })]).size).toBe(0);
  });
});
