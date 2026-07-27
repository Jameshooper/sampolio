import { describe, it, expect } from 'vitest';
import { detectRecurringCandidates } from './recurring-detection';
import type { BankTransaction } from '@/types';

let seq = 0;
function tx(bookingDate: string, amount: number, counterpartyName: string, status: BankTransaction['status'] = 'booked'): BankTransaction {
  return {
    id: `tx-${seq++}`,
    dedupKey: `dk-${seq}`,
    bookingDate,
    amount,
    status,
    counterpartyName,
    firstSeenAt: '2026-01-01T00:00:00Z',
  } as BankTransaction;
}

describe('detectRecurringCandidates', () => {
  it('detects a monthly subscription with stable amount and day', () => {
    const txs = [
      tx('2026-04-15', -15.99, 'NETFLIX'),
      tx('2026-05-16', -15.99, 'NETFLIX'),
      tx('2026-06-14', -15.99, 'NETFLIX'),
    ];
    const out = detectRecurringCandidates(txs, []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'NETFLIX', type: 'expense', amount: 15.99, category: 'Entertainment' });
    expect(out[0].monthsSeen).toEqual(['2026-04', '2026-05', '2026-06']);
  });

  it('skips patterns already covered by a tracked item (name match)', () => {
    const txs = [
      tx('2026-04-15', -15.99, 'NETFLIX'),
      tx('2026-05-16', -15.99, 'NETFLIX'),
      tx('2026-06-14', -15.99, 'NETFLIX'),
    ];
    const out = detectRecurringCandidates(txs, [{ name: 'Netflix', amount: 12, type: 'expense' }]);
    expect(out).toEqual([]);
  });

  it('skips patterns already covered by a tracked item (amount match)', () => {
    const txs = [
      tx('2026-04-01', -800, 'LANDLORD OY'),
      tx('2026-05-01', -800, 'LANDLORD OY'),
      tx('2026-06-01', -800, 'LANDLORD OY'),
    ];
    const out = detectRecurringCandidates(txs, [{ name: 'Rent', amount: 800, type: 'expense' }]);
    expect(out).toEqual([]);
  });

  it('requires consecutive months', () => {
    const txs = [
      tx('2026-01-15', -9.99, 'SPOTIFY'),
      tx('2026-03-15', -9.99, 'SPOTIFY'),
      tx('2026-06-15', -9.99, 'SPOTIFY'),
    ];
    expect(detectRecurringCandidates(txs, [])).toEqual([]);
  });

  it('rejects unstable amounts and multi-charge ad-hoc merchants', () => {
    const unstable = [
      tx('2026-04-10', -20, 'GYM'),
      tx('2026-05-10', -90, 'GYM'),
      tx('2026-06-10', -20, 'GYM'),
    ];
    expect(detectRecurringCandidates(unstable, [])).toEqual([]);

    const groceries = [
      tx('2026-04-02', -40, 'PRISMA'), tx('2026-04-12', -55, 'PRISMA'), tx('2026-04-22', -35, 'PRISMA'),
      tx('2026-05-03', -42, 'PRISMA'), tx('2026-05-13', -50, 'PRISMA'),
      tx('2026-06-05', -45, 'PRISMA'), tx('2026-06-15', -38, 'PRISMA'),
    ];
    expect(detectRecurringCandidates(groceries, [])).toEqual([]);
  });

  it('ignores pending transactions and detects income too', () => {
    const txs = [
      tx('2026-04-25', 3200, 'EMPLOYER OY'),
      tx('2026-05-25', 3200, 'EMPLOYER OY'),
      tx('2026-06-25', 3200, 'EMPLOYER OY'),
      tx('2026-07-25', 3200, 'EMPLOYER OY', 'pending'),
    ];
    const out = detectRecurringCandidates(txs, []);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('income');
    expect(out[0].monthsSeen).toHaveLength(3);
  });

  it('tolerates day drift across month boundaries (28th vs 1st)', () => {
    const txs = [
      tx('2026-04-30', -12, 'VAKUUTUS AB'),
      tx('2026-05-28', -12, 'VAKUUTUS AB'),
      tx('2026-06-29', -12, 'VAKUUTUS AB'),
    ];
    expect(detectRecurringCandidates(txs, [])).toHaveLength(1);
  });

  it('drops patterns that stopped recurring (latest occurrence too old)', () => {
    const txs = [
      tx('2026-01-15', -15.99, 'NETFLIX'),
      tx('2026-02-16', -15.99, 'NETFLIX'),
      tx('2026-03-14', -15.99, 'NETFLIX'),
    ];
    // Cancelled in March; by July it is not "still recurring".
    expect(detectRecurringCandidates(txs, [], '2026-07')).toEqual([]);
  });

  it('keeps patterns whose latest occurrence is the current or previous month', () => {
    const txs = [
      tx('2026-04-15', -15.99, 'NETFLIX'),
      tx('2026-05-16', -15.99, 'NETFLIX'),
      tx('2026-06-14', -15.99, 'NETFLIX'),
    ];
    // Last seen in June: still current in June and July, stale by August.
    expect(detectRecurringCandidates(txs, [], '2026-06')).toHaveLength(1);
    expect(detectRecurringCandidates(txs, [], '2026-07')).toHaveLength(1);
    expect(detectRecurringCandidates(txs, [], '2026-08')).toEqual([]);
  });
});
