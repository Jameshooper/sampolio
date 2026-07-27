import { describe, it, expect } from 'vitest';
import type { BankTransaction } from '@/types';
import { repairDegenerateBookingDates } from './repair-booking-dates';

let seq = 0;
function tx(overrides: Partial<BankTransaction> = {}): BankTransaction {
  seq++;
  return {
    id: `tx-${seq}`,
    linkedAccountId: 'acct-1',
    dedupKey: `k-${seq}`,
    bookingDate: '2026-07-22',
    amount: -10,
    currency: 'EUR',
    status: 'booked',
    firstSeenAt: '2026-07-22T00:00:00.000Z',
    lastSeenAt: '2026-07-22T00:00:00.000Z',
    ...overrides,
  };
}

/** Five rows collapsed onto the sync day, real dates spread across old months. */
function collapsedFive(): BankTransaction[] {
  return [
    tx({ bookingDate: '2026-07-22', transactionDate: '2024-09-15' }),
    tx({ bookingDate: '2026-07-22', transactionDate: '2024-12-01' }),
    tx({ bookingDate: '2026-07-22', transactionDate: '2025-03-20' }),
    tx({ bookingDate: '2026-07-22', transactionDate: '2025-11-11' }),
    tx({ bookingDate: '2026-07-22', transactionDate: '2026-05-02' }),
  ];
}

describe('repairDegenerateBookingDates', () => {
  it('rewrites every row in a degenerate group, including recent ones', () => {
    const rows = [
      ...collapsedFive(),
      // A recent row (2 days before the sync day) in the SAME collapsed group —
      // also rewritten to its transactionDate even though it is not "far older".
      tx({ bookingDate: '2026-07-22', transactionDate: '2026-07-20' }),
    ];
    const { rows: out, changed } = repairDegenerateBookingDates(rows);
    expect(changed).toBe(6);
    expect(out.map((r) => r.bookingDate)).toEqual([
      '2024-09-15',
      '2024-12-01',
      '2025-03-20',
      '2025-11-11',
      '2026-05-02',
      '2026-07-20',
    ]);
  });

  it('leaves a non-degenerate group untouched (only 3 far-older rows) and returns the same reference', () => {
    const rows = [
      tx({ bookingDate: '2026-07-22', transactionDate: '2024-09-15' }),
      tx({ bookingDate: '2026-07-22', transactionDate: '2024-12-01' }),
      tx({ bookingDate: '2026-07-22', transactionDate: '2025-03-20' }),
    ];
    const result = repairDegenerateBookingDates(rows);
    expect(result.changed).toBe(0);
    expect(result.rows).toBe(rows);
  });

  it('never rewrites a row lacking a transactionDate, even inside a degenerate group', () => {
    const rows = [...collapsedFive(), tx({ bookingDate: '2026-07-22', transactionDate: undefined })];
    const { rows: out, changed } = repairDegenerateBookingDates(rows);
    expect(changed).toBe(5);
    expect(out[5].bookingDate).toBe('2026-07-22'); // the tx-date-less row is untouched
  });

  it('rewrites only the degenerate group, preserving other rows by object identity', () => {
    const legit = tx({ bookingDate: '2025-01-10', transactionDate: '2025-01-08' });
    const rows = [legit, ...collapsedFive()];
    const { rows: out, changed } = repairDegenerateBookingDates(rows);
    expect(changed).toBe(5);
    expect(out[0]).toBe(legit); // untouched legitimate row keeps its reference
    expect(out[1].bookingDate).toBe('2024-09-15');
  });

  it('is idempotent: a second pass finds no degenerate group and changes nothing', () => {
    const first = repairDegenerateBookingDates(collapsedFive());
    expect(first.changed).toBe(5);
    const second = repairDegenerateBookingDates(first.rows);
    expect(second.changed).toBe(0);
    expect(second.rows).toBe(first.rows); // same reference on the no-op pass
  });

  it('uses a strict "more than 7 days" threshold', () => {
    // Exactly 7 days older → NOT degenerate.
    const seven = Array.from({ length: 5 }, () =>
      tx({ bookingDate: '2026-07-22', transactionDate: '2026-07-15' })
    );
    expect(repairDegenerateBookingDates(seven).changed).toBe(0);
    // 8 days older → degenerate.
    const eight = seven.map((r) => ({ ...r, transactionDate: '2026-07-14' }));
    expect(repairDegenerateBookingDates(eight).changed).toBe(5);
  });

  it('returns the input untouched for an empty ledger', () => {
    const rows: BankTransaction[] = [];
    const result = repairDegenerateBookingDates(rows);
    expect(result.changed).toBe(0);
    expect(result.rows).toBe(rows);
  });

  it('tolerates a full ISO datetime bookingDate (compares by day)', () => {
    const rows = collapsedFive().map((r) => ({ ...r, bookingDate: '2026-07-22T09:30:00.000Z' }));
    const { rows: out, changed } = repairDegenerateBookingDates(rows);
    expect(changed).toBe(5);
    expect(out[0].bookingDate).toBe('2024-09-15');
  });
});
