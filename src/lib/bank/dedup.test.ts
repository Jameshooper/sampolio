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

describe('mergeTransactions — stored identity continuity', () => {
  const now = '2026-07-30T12:00:00.000Z';

  it('preserves the stored id on a same-key refresh (SplitExpenseBankLink.txId)', () => {
    const stored = tx({ id: 'stored-1', dedupKey: 'ref-a', entryReference: 'ref-a' });
    // Every fetch mints a fresh uuid for the mapped row — it must not win.
    const refetched = tx({ id: 'fresh-uuid', dedupKey: 'ref-a', entryReference: 'ref-a' });
    const res = mergeTransactions([stored], [refetched], now);
    expect(res.merged[0].id).toBe('stored-1');
  });

  it('coalesces transactionDate/valueDate instead of wiping them with undefined', () => {
    const stored = tx({
      dedupKey: 'ref-a',
      entryReference: 'ref-a',
      transactionDate: '2026-07-25',
      valueDate: '2026-07-26',
    });
    const withoutDates = tx({ dedupKey: 'ref-a', entryReference: 'ref-a', transactionDate: undefined, valueDate: undefined });
    const kept = mergeTransactions([stored], [withoutDates], now).merged[0];
    expect(kept.transactionDate).toBe('2026-07-25');
    expect(kept.valueDate).toBe('2026-07-26');

    const withDates = tx({ dedupKey: 'ref-a', entryReference: 'ref-a', transactionDate: '2026-07-28', valueDate: '2026-07-29' });
    const replaced = mergeTransactions([stored], [withDates], now).merged[0];
    expect(replaced.transactionDate).toBe('2026-07-28');
    expect(replaced.valueDate).toBe('2026-07-29');
  });

  it('books a pending in place when the bank keeps the same entry_reference (stable-ref path)', () => {
    const pending = tx({
      id: 'p-1',
      dedupKey: '67299f98ab',
      entryReference: '67299f98ab',
      status: 'pending',
      amount: -42.9,
      counterpartyName: 'Kauppa',
      bookingDate: '2026-07-28', // PDNG rows fall back to transaction_date
      transactionDate: '2026-07-28',
      firstSeenAt: '2026-07-28T06:00:00.000Z',
    });
    const booked = tx({
      id: 'fresh-uuid',
      dedupKey: '67299f98ab',
      entryReference: '67299f98ab',
      status: 'booked',
      amount: -42.9,
      counterpartyName: 'Kauppa',
      bookingDate: '2026-07-30',
      transactionDate: undefined,
    });
    const res = mergeTransactions([pending], [booked], now);
    expect(res.merged).toHaveLength(1);
    expect(res.updated).toBe(1);
    expect(res.added).toBe(0);
    expect(res.merged[0]).toMatchObject({
      id: 'p-1',
      status: 'booked',
      bookingDate: '2026-07-30',
      transactionDate: '2026-07-28', // purchase date carried from the pending row
      firstSeenAt: '2026-07-28T06:00:00.000Z',
    });
  });

  it('never downgrades booked → pending when one run reports both', () => {
    // Booked pages come first in `incoming`; the appended PDNG set can still
    // carry the same reference while the booking is in flight.
    const booked = tx({ dedupKey: 'ref-x', entryReference: 'ref-x', status: 'booked', bookingDate: '2026-07-30' });
    const pendingTwin = tx({ dedupKey: 'ref-x', entryReference: 'ref-x', status: 'pending', bookingDate: '2026-07-28' });
    const res = mergeTransactions([], [booked, pendingTwin], now);
    expect(res.merged).toHaveLength(1);
    expect(res.added).toBe(1);
    expect(res.updated).toBe(1);
    expect(res.merged[0]).toMatchObject({ status: 'booked', bookingDate: '2026-07-30' });
  });

  it('exact-synthetic promotion preserves the pending id and resolves transactionDate', () => {
    const content = { amount: -25, currency: 'EUR' as const, counterpartyName: 'Cafe', remittanceInfo: undefined, valueDate: undefined };
    const pendingBase = {
      id: 'p-1',
      dedupKey: syntheticDedupKey(content),
      entryReference: undefined,
      status: 'pending' as const,
      amount: -25,
      counterpartyName: 'Cafe',
      bookingDate: '2026-07-27',
      firstSeenAt: '2026-07-27T00:00:00.000Z',
    };
    const bookedBase = {
      id: 'fresh-uuid',
      dedupKey: 'real-ref-1',
      entryReference: 'real-ref-1',
      status: 'booked' as const,
      amount: -25,
      counterpartyName: 'Cafe',
      bookingDate: '2026-07-29',
    };

    const withIncDate = mergeTransactions([tx(pendingBase)], [tx({ ...bookedBase, transactionDate: '2026-07-26' })], now);
    expect(withIncDate.updated).toBe(1);
    expect(withIncDate.merged[0]).toMatchObject({ id: 'p-1', transactionDate: '2026-07-26' });

    const fromPendingTxDate = mergeTransactions(
      [tx({ ...pendingBase, transactionDate: '2026-07-25' })],
      [tx({ ...bookedBase, transactionDate: undefined })],
      now
    );
    expect(fromPendingTxDate.merged[0]).toMatchObject({ id: 'p-1', transactionDate: '2026-07-25' });

    const fromPendingBookingDate = mergeTransactions(
      [tx(pendingBase)],
      [tx({ ...bookedBase, transactionDate: undefined })],
      now
    );
    expect(fromPendingBookingDate.merged[0]).toMatchObject({ id: 'p-1', transactionDate: '2026-07-27' });
  });
});

describe('mergeTransactions — fuzzy pending → booked promotion', () => {
  const now = '2026-07-30T12:00:00.000Z';

  /** A ref-keyed pending row (Nordea PDNG) whose reference did NOT survive booking. */
  function refPending(overrides: Partial<BankTransaction> = {}): BankTransaction {
    return tx({
      id: 'p-1',
      dedupKey: 'pdng-ref-1',
      entryReference: 'pdng-ref-1',
      status: 'pending',
      amount: -95.4,
      counterpartyName: 'MERCHANT X',
      bookingDate: '2026-07-27',
      transactionDate: '2026-07-27',
      firstSeenAt: '2026-07-27T06:00:00.000Z',
      ...overrides,
    });
  }

  it('promotes a booked twin under a new reference with rewritten counterparty', () => {
    const booked = tx({
      id: 'fresh-uuid',
      dedupKey: 'book-ref-2',
      entryReference: 'book-ref-2',
      status: 'booked',
      amount: -95.4,
      counterpartyName: 'UNKNOWN*MERCHANT X',
      bookingDate: '2026-07-30', // +3 days
      transactionDate: undefined,
    });
    const res = mergeTransactions([refPending()], [booked], now);
    expect(res.merged).toHaveLength(1);
    expect(res.updated).toBe(1);
    expect(res.added).toBe(0);
    expect(res.removed).toBe(0);
    expect(res.merged[0]).toMatchObject({
      id: 'p-1',
      dedupKey: 'book-ref-2',
      status: 'booked',
      transactionDate: '2026-07-27',
      firstSeenAt: '2026-07-27T06:00:00.000Z',
    });
  });

  it('does not match outside the date bounds or on a different amount/currency', () => {
    const booked = (overrides: Partial<BankTransaction> = {}) =>
      tx({ dedupKey: 'book-ref-2', entryReference: 'book-ref-2', status: 'booked', amount: -95.4, counterpartyName: 'MERCHANT X', bookingDate: '2026-07-30', ...overrides });

    // Booked 8 days after the pending — one day past the max lag.
    const tooOld = mergeTransactions([refPending({ bookingDate: '2026-07-22' })], [booked()], now);
    expect(tooOld.added).toBe(1);
    expect(tooOld.merged).toHaveLength(2);

    // Pending dated 2 days AFTER the booked row — past the max lead.
    const tooNew = mergeTransactions([refPending({ bookingDate: '2026-08-01' })], [booked()], now);
    expect(tooNew.added).toBe(1);
    expect(tooNew.merged).toHaveLength(2);

    const amountMismatch = mergeTransactions([refPending()], [booked({ amount: -95.5 })], now);
    expect(amountMismatch.added).toBe(1);
    expect(amountMismatch.merged).toHaveLength(2);

    const currencyMismatch = mergeTransactions([refPending({ currency: 'SEK' })], [booked()], now);
    expect(currencyMismatch.added).toBe(1);
    expect(currencyMismatch.merged).toHaveLength(2);
  });

  it('matches one-to-one: name affinity first, then nearest date, then no match left', () => {
    const pendings = [
      refPending({ id: 'p1', dedupKey: 'pdng-a', entryReference: 'pdng-a', amount: -50, counterpartyName: 'CAFE ROMA', bookingDate: '2026-07-27' }),
      refPending({ id: 'p2', dedupKey: 'pdng-b', entryReference: 'pdng-b', amount: -50, counterpartyName: 'SOMETHING ELSE', bookingDate: '2026-07-29' }),
    ];
    const booked = (key: string, counterpartyName: string) =>
      tx({ dedupKey: key, entryReference: key, status: 'booked', amount: -50, counterpartyName, bookingDate: '2026-07-30' });

    const res = mergeTransactions(
      pendings,
      // 'CAFE ROMA OY' has affinity with p1 even though p2 is the nearer date.
      [booked('book-1', 'CAFE ROMA OY'), booked('book-2', 'ZZZ MERCHANT'), booked('book-3', 'QQQ')],
      now
    );
    expect(res.updated).toBe(2);
    expect(res.added).toBe(1);
    expect(res.removed).toBe(0);
    expect(res.merged).toHaveLength(3);
    const byKey = new Map(res.merged.map((t) => [t.dedupKey, t]));
    expect(byKey.get('book-1')?.id).toBe('p1');
    expect(byKey.get('book-2')?.id).toBe('p2');
    expect(byKey.get('book-3')?.status).toBe('booked');
    expect(res.merged.every((t) => t.status === 'booked')).toBe(true);
  });

  it('never consumes a pending this same fetch still reports', () => {
    const stored = refPending();
    // The PDNG set still carries the pending (same key) → it is live, not booked.
    const stillPending = refPending({ id: 'fresh-uuid' });
    const separateBooked = tx({
      dedupKey: 'book-ref-9',
      entryReference: 'book-ref-9',
      status: 'booked',
      amount: -95.4,
      counterpartyName: 'MERCHANT X',
      bookingDate: '2026-07-30',
    });
    const res = mergeTransactions([stored], [separateBooked, stillPending], now, {
      fromDate: '2026-07-20',
      toDate: '2026-07-30',
    });
    expect(res.added).toBe(1);
    expect(res.updated).toBe(1);
    expect(res.removed).toBe(0);
    expect(res.merged).toHaveLength(2);
    expect(res.merged.find((t) => t.dedupKey === 'pdng-ref-1')).toMatchObject({ id: 'p-1', status: 'pending' });
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

  it('real case: counterparty rewritten on booking → fuzzy-promote the pending, no double count', () => {
    // Stored: a pending "MERCHANT X" neither key-based promotion can match — the
    // booked twin arrives with a rewritten counterparty ("UNKNOWN*MERCHANT X"),
    // so its synthetic key differs. Same amount within the date bounds ⇒ the
    // fuzzy path claims it, which beats prune-then-re-add (the id survives).
    const strandedPending = tx({
      id: 'pending-188',
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
    expect(res.updated).toBe(1);
    expect(res.added).toBe(0);
    expect(res.removed).toBe(0);
    expect(res.merged).toHaveLength(1); // only the booked row survives — no phantom
    expect(res.merged[0].status).toBe('booked');
    expect(res.merged[0].dedupKey).toBe('entryref-booked-188');
    expect(res.merged[0].id).toBe('pending-188');
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
