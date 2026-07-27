import { describe, it, expect } from 'vitest';
import { mergeTransactions, syntheticDedupKey } from './dedup';
import type { BankTransaction } from '@/types';

function tx(overrides: Partial<BankTransaction> = {}): BankTransaction {
  return {
    id: overrides.id ?? 'id-' + (overrides.dedupKey ?? 'x'),
    linkedAccountId: 'acct-1',
    dedupKey: 'ref-1',
    entryReference: 'ref-1',
    bookingDate: '2026-06-01',
    amount: -10,
    currency: 'EUR',
    status: 'booked',
    firstSeenAt: '2026-06-01T00:00:00.000Z',
    lastSeenAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('syntheticDedupKey', () => {
  it('is deterministic and ignores booking date', () => {
    const a = syntheticDedupKey({ amount: -12.5, currency: 'EUR', counterpartyName: 'Shop', remittanceInfo: 'x', valueDate: '2026-06-02' });
    const b = syntheticDedupKey({ amount: -12.5, currency: 'EUR', counterpartyName: 'Shop', remittanceInfo: 'x', valueDate: '2026-06-02' });
    expect(a).toBe(b);
    expect(a.startsWith('syn:')).toBe(true);
  });

  it('differs when amount differs', () => {
    const a = syntheticDedupKey({ amount: -12.5, currency: 'EUR', valueDate: '2026-06-02' });
    const b = syntheticDedupKey({ amount: -13.5, currency: 'EUR', valueDate: '2026-06-02' });
    expect(a).not.toBe(b);
  });
});

describe('mergeTransactions', () => {
  const now = '2026-06-10T12:00:00.000Z';

  it('adds new transactions', () => {
    const res = mergeTransactions([], [tx({ dedupKey: 'a', entryReference: 'a' }), tx({ dedupKey: 'b', entryReference: 'b' })], now);
    expect(res.added).toBe(2);
    expect(res.updated).toBe(0);
    expect(res.merged).toHaveLength(2);
  });

  it('is idempotent on overlapping re-fetch (no dupes)', () => {
    const existing = [tx({ dedupKey: 'a', entryReference: 'a', firstSeenAt: '2026-06-01T00:00:00.000Z' })];
    const res = mergeTransactions(existing, [tx({ dedupKey: 'a', entryReference: 'a' })], now);
    expect(res.added).toBe(0);
    expect(res.updated).toBe(1);
    expect(res.merged).toHaveLength(1);
    // firstSeenAt preserved, lastSeenAt refreshed
    expect(res.merged[0].firstSeenAt).toBe('2026-06-01T00:00:00.000Z');
    expect(res.merged[0].lastSeenAt).toBe(now);
  });

  it('promotes a pending row to its booked counterpart', () => {
    const pendingKey = syntheticDedupKey({ amount: -25, currency: 'EUR', counterpartyName: 'Cafe', remittanceInfo: 'coffee', valueDate: '2026-06-05' });
    const pending = tx({
      id: 'pending-1',
      dedupKey: pendingKey,
      entryReference: undefined,
      status: 'pending',
      amount: -25,
      counterpartyName: 'Cafe',
      remittanceInfo: 'coffee',
      valueDate: '2026-06-05',
      bookingDate: '2026-06-05',
      firstSeenAt: '2026-06-05T00:00:00.000Z',
    });
    const booked = tx({
      id: 'booked-1',
      dedupKey: 'real-ref-99',
      entryReference: 'real-ref-99',
      status: 'booked',
      amount: -25,
      counterpartyName: 'Cafe',
      remittanceInfo: 'coffee',
      valueDate: '2026-06-05',
      bookingDate: '2026-06-06',
    });

    const res = mergeTransactions([pending], [booked], now);
    expect(res.merged).toHaveLength(1);
    expect(res.updated).toBe(1);
    expect(res.added).toBe(0);
    const only = res.merged[0];
    expect(only.dedupKey).toBe('real-ref-99');
    expect(only.status).toBe('booked');
    // identity continuity: firstSeenAt carried from the pending row
    expect(only.firstSeenAt).toBe('2026-06-05T00:00:00.000Z');
  });

  it('keeps distinct booked transactions separate', () => {
    const res = mergeTransactions(
      [tx({ dedupKey: 'a', entryReference: 'a' })],
      [tx({ dedupKey: 'b', entryReference: 'b', bookingDate: '2026-06-09' })],
      now
    );
    expect(res.merged).toHaveLength(2);
    // sorted newest-first
    expect(res.merged[0].bookingDate >= res.merged[1].bookingDate).toBe(true);
  });

  it('reports removed: 0 and prunes nothing without a window', () => {
    const stalePending = tx({ dedupKey: 'syn:stale', entryReference: undefined, status: 'pending', bookingDate: '2026-06-05' });
    const res = mergeTransactions([stalePending], [], now);
    expect(res.removed).toBe(0);
    expect(res.merged).toHaveLength(1); // no window → never prunes
  });
});

describe('mergeTransactions — stale pending pruning (window given)', () => {
  const now = '2026-07-03T12:00:00.000Z';
  const window = { fromDate: '2026-06-28', toDate: '2026-07-03' };

  it('prunes an in-window pending the fetch no longer reports', () => {
    const stale = tx({ dedupKey: 'syn:stale', entryReference: undefined, status: 'pending', bookingDate: '2026-07-01' });
    const res = mergeTransactions([stale], [], now, window);
    expect(res.removed).toBe(1);
    expect(res.merged).toHaveLength(0);
  });

  it('keeps a still-reported pending (confirmed by the fetch)', () => {
    const pendingKey = syntheticDedupKey({ amount: -25, currency: 'EUR', counterpartyName: 'Cafe', valueDate: '2026-07-01' });
    const stored = tx({ dedupKey: pendingKey, entryReference: undefined, status: 'pending', amount: -25, counterpartyName: 'Cafe', valueDate: '2026-07-01', bookingDate: '2026-07-01' });
    const incoming = tx({ dedupKey: pendingKey, entryReference: undefined, status: 'pending', amount: -25, counterpartyName: 'Cafe', valueDate: '2026-07-01', bookingDate: '2026-07-01' });
    const res = mergeTransactions([stored], [incoming], now, window);
    expect(res.removed).toBe(0);
    expect(res.merged).toHaveLength(1);
    expect(res.merged[0].status).toBe('pending');
  });

  it('never prunes booked rows, even when absent from the fetch', () => {
    const booked = tx({ dedupKey: 'ref-book', entryReference: 'ref-book', status: 'booked', bookingDate: '2026-07-01' });
    const res = mergeTransactions([booked], [], now, window);
    expect(res.removed).toBe(0);
    expect(res.merged).toHaveLength(1);
  });

  it('never prunes a pending outside the fetched window', () => {
    const oldPending = tx({ dedupKey: 'syn:old', entryReference: undefined, status: 'pending', bookingDate: '2026-06-01' });
    const res = mergeTransactions([oldPending], [], now, window);
    expect(res.removed).toBe(0);
    expect(res.merged).toHaveLength(1);
  });

  it('real case: counterparty rewritten on booking → prune the stranded pending, no double count', () => {
    // Stored: a pending "MERCHANT X" the promotion can't match because the booked
    // twin arrives with a rewritten counterparty ("UNKNOWN*MERCHANT X").
    const strandedPending = tx({
      dedupKey: syntheticDedupKey({ amount: -95.40, currency: 'EUR', counterpartyName: 'MERCHANT X', valueDate: '2026-07-01' }),
      entryReference: undefined,
      status: 'pending',
      amount: -95.40,
      counterpartyName: 'MERCHANT X',
      valueDate: '2026-07-01',
      bookingDate: '2026-07-01',
    });
    const bookedTwin = tx({
      dedupKey: 'entryref-booked-188',
      entryReference: 'entryref-booked-188',
      status: 'booked',
      amount: -95.40,
      counterpartyName: 'UNKNOWN*MERCHANT X', // rewritten → synthetic key differs
      bookingDate: '2026-07-01',
    });
    const res = mergeTransactions([strandedPending], [bookedTwin], now, window);
    expect(res.added).toBe(1);
    expect(res.removed).toBe(1);
    expect(res.merged).toHaveLength(1); // only the booked row survives — no phantom
    expect(res.merged[0].status).toBe('booked');
    expect(res.merged[0].dedupKey).toBe('entryref-booked-188');
  });

  it('prunes only stale pendings while keeping booked + confirmed + out-of-window', () => {
    const confirmedKey = syntheticDedupKey({ amount: -5, currency: 'EUR', counterpartyName: 'Kiosk', valueDate: '2026-07-02' });
    const existing = [
      tx({ dedupKey: 'ref-booked', entryReference: 'ref-booked', status: 'booked', bookingDate: '2026-07-01' }),
      tx({ dedupKey: confirmedKey, entryReference: undefined, status: 'pending', amount: -5, counterpartyName: 'Kiosk', valueDate: '2026-07-02', bookingDate: '2026-07-02' }),
      tx({ dedupKey: 'syn:stale1', entryReference: undefined, status: 'pending', bookingDate: '2026-07-01' }),
      tx({ dedupKey: 'syn:stale2', entryReference: undefined, status: 'pending', bookingDate: '2026-06-30' }),
      tx({ dedupKey: 'syn:oldpending', entryReference: undefined, status: 'pending', bookingDate: '2026-05-01' }), // out of window
    ];
    const incoming = [
      tx({ dedupKey: confirmedKey, entryReference: undefined, status: 'pending', amount: -5, counterpartyName: 'Kiosk', valueDate: '2026-07-02', bookingDate: '2026-07-02' }),
    ];
    const res = mergeTransactions(existing, incoming, now, window);
    expect(res.removed).toBe(2); // stale1 + stale2
    const keys = res.merged.map((t) => t.dedupKey).sort();
    expect(keys).toEqual(['ref-booked', 'syn:oldpending', confirmedKey].sort());
  });
});
