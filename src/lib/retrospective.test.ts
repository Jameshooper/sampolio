import { describe, it, expect } from 'vitest';
import { calculateRetrospective } from './retrospective';
import type { BankTransaction } from '@/types';
import type { ProjectionAnchor } from './projection';

// Anchor = the forecast's first month (normally the current month, re-based on the
// latest bank-sync snapshot). The retrospective sits to the left of it.
const anchor: ProjectionAnchor = { startMonth: '2026-06', startBalance: 1000 };

let idCounter = 0;
function tx(partial: Partial<BankTransaction> & { bookingDate: string; amount: number }): BankTransaction {
  idCounter += 1;
  return {
    id: `tx-${idCounter}`,
    linkedAccountId: 'link-1',
    dedupKey: `dk-${idCounter}`,
    currency: 'EUR',
    status: 'booked',
    firstSeenAt: '2026-06-01T00:00:00Z',
    lastSeenAt: '2026-06-01T00:00:00Z',
    ...partial,
  };
}

describe('calculateRetrospective', () => {
  it('returns [] when there are no transactions', () => {
    expect(
      calculateRetrospective({ accountId: 'acc-1', transactions: [], anchor })
    ).toEqual([]);
  });

  it('splits credits into income and debits into expenses, grouped by counterparty', () => {
    const transactions = [
      tx({ bookingDate: '2026-05-03', amount: 2500, counterpartyName: 'Employer' }),
      tx({ bookingDate: '2026-05-10', amount: -50, counterpartyName: 'S-Market' }),
      tx({ bookingDate: '2026-05-20', amount: -30, counterpartyName: 'S-Market' }), // same merchant → grouped
      tx({ bookingDate: '2026-05-25', amount: -800, counterpartyName: 'Landlord' }),
    ];
    const [month] = calculateRetrospective({ accountId: 'acc-1', transactions, anchor });
    expect(month.yearMonth).toBe('2026-05');
    expect(month.isActual).toBe(true);
    expect(month.totalIncome).toBe(2500);
    expect(month.totalExpenses).toBe(880);
    expect(month.netChange).toBe(1620);

    expect(month.incomeBreakdown).toHaveLength(1);
    expect(month.incomeBreakdown[0]).toMatchObject({ name: 'Employer', amount: 2500, source: 'bank-actual' });

    const sMarket = month.expenseBreakdown.find((i) => i.name === 'S-Market');
    expect(sMarket?.amount).toBe(80); // 50 + 30 grouped
    expect(month.expenseBreakdown.find((i) => i.name === 'Landlord')?.amount).toBe(800);
  });

  it('excludes pending transactions (booked-only)', () => {
    const transactions = [
      tx({ bookingDate: '2026-05-10', amount: -100, counterpartyName: 'Shop', status: 'booked' }),
      tx({ bookingDate: '2026-05-11', amount: -999, counterpartyName: 'Shop', status: 'pending' }),
    ];
    const [month] = calculateRetrospective({ accountId: 'acc-1', transactions, anchor });
    expect(month.totalExpenses).toBe(100);
  });

  it('ignores transactions at or after the anchor month', () => {
    const transactions = [
      tx({ bookingDate: '2026-06-05', amount: -500, counterpartyName: 'June (forecast territory)' }),
      tx({ bookingDate: '2026-05-05', amount: -120, counterpartyName: 'May' }),
    ];
    const months = calculateRetrospective({ accountId: 'acc-1', transactions, anchor });
    expect(months).toHaveLength(1);
    expect(months[0].yearMonth).toBe('2026-05');
  });

  it('chains balances backward so the newest past month meets the anchor exactly', () => {
    const transactions = [
      // May: +1000 income, -400 expense → net +600
      tx({ bookingDate: '2026-05-03', amount: 1000, counterpartyName: 'In' }),
      tx({ bookingDate: '2026-05-15', amount: -400, counterpartyName: 'Out' }),
      // April: -200 net
      tx({ bookingDate: '2026-04-15', amount: -200, counterpartyName: 'Out' }),
    ];
    const months = calculateRetrospective({ accountId: 'acc-1', transactions, anchor });
    expect(months.map((m) => m.yearMonth)).toEqual(['2026-04', '2026-05']); // chronological
    const may = months[1];
    const april = months[0];
    // Newest past month's ending balance == anchor start balance (continuity).
    expect(may.endingBalance).toBe(anchor.startBalance); // 1000
    expect(may.startingBalance).toBe(1000 - 600); // 400
    // April flows into May.
    expect(april.endingBalance).toBe(may.startingBalance); // 400
    expect(april.startingBalance).toBe(400 - -200); // 600
  });

  it('stops at the first gap month (contiguous run only)', () => {
    const transactions = [
      tx({ bookingDate: '2026-05-10', amount: -100, counterpartyName: 'May' }),
      // April has NO transactions (gap)
      tx({ bookingDate: '2026-03-10', amount: -100, counterpartyName: 'March' }),
    ];
    const months = calculateRetrospective({ accountId: 'acc-1', transactions, anchor });
    expect(months.map((m) => m.yearMonth)).toEqual(['2026-05']); // March is unreachable past the April gap
  });

  it('caps at monthsBack months', () => {
    const transactions = [
      tx({ bookingDate: '2026-05-10', amount: -10, counterpartyName: 'm' }),
      tx({ bookingDate: '2026-04-10', amount: -10, counterpartyName: 'm' }),
      tx({ bookingDate: '2026-03-10', amount: -10, counterpartyName: 'm' }),
      tx({ bookingDate: '2026-02-10', amount: -10, counterpartyName: 'm' }),
    ];
    const months = calculateRetrospective({
      accountId: 'acc-1',
      transactions,
      anchor,
      monthsBack: 3,
    });
    expect(months.map((m) => m.yearMonth)).toEqual(['2026-03', '2026-04', '2026-05']);
  });

  it('walks back through many contiguous months regardless of any Sampolio genesis', () => {
    // 12 contiguous months of data before the anchor (2025-06 .. 2026-05).
    const transactions: BankTransaction[] = [];
    const months = ['2025-06','2025-07','2025-08','2025-09','2025-10','2025-11','2025-12','2026-01','2026-02','2026-03','2026-04','2026-05'];
    for (const m of months) transactions.push(tx({ bookingDate: `${m}-10`, amount: -10, counterpartyName: 'm' }));
    const result = calculateRetrospective({ accountId: 'acc-1', transactions, anchor }); // default monthsBack 24
    // All 12 months surface (no genesis cap); chronological order.
    expect(result.map((r) => r.yearMonth)).toEqual(months);
  });

  it('falls back through remittance/code/Other for the group name', () => {
    const transactions = [
      tx({ bookingDate: '2026-05-01', amount: -10, remittanceInfo: 'Line one\nLine two' }),
      tx({ bookingDate: '2026-05-02', amount: -20, bankTransactionCode: 'e-lasku' }),
      tx({ bookingDate: '2026-05-03', amount: -30 }),
    ];
    const [month] = calculateRetrospective({ accountId: 'acc-1', transactions, anchor });
    const names = month.expenseBreakdown.map((i) => i.name).sort();
    expect(names).toEqual(['Line one', 'Other', 'e-lasku']);
  });

  it('collapses a matched card-bill payment into one credit-card line (totals unchanged)', () => {
    const transactions = [
      tx({ bookingDate: '2026-05-03', amount: 2500, counterpartyName: 'Employer' }),
      tx({ bookingDate: '2026-05-10', amount: -50, counterpartyName: 'S-Market' }),
      // The opaque monthly card-bill payment on the cash ledger.
      tx({ bookingDate: '2026-05-30', amount: -1450.00, counterpartyName: 'Example Bank Retail Oyj' }),
    ];
    // The matching settlement credit on the CARD ledger, a couple days later.
    const cardPayments = [
      { linkId: 'card-op', cardName: 'OP Card', credits: [{ date: '2026-06-01', amount: 1450.00 }] },
    ];
    const [month] = calculateRetrospective({ accountId: 'acc-1', transactions, anchor, cardPayments });

    // The card payment is no longer an opaque counterparty expense line.
    expect(month.expenseBreakdown.find((i) => i.name === 'Example Bank Retail Oyj')).toBeUndefined();
    // It becomes a single aggregated credit-card line keyed by the link id.
    const cardLine = month.expenseBreakdown.find((i) => i.source === 'credit-card');
    expect(cardLine).toMatchObject({
      itemId: 'card-op',
      name: 'Card: OP Card',
      amount: 1450.00,
      category: 'Credit cards',
    });
    // The unmatched debit stays as its own counterparty line.
    expect(month.expenseBreakdown.find((i) => i.name === 'S-Market')?.amount).toBe(50);
    // Totals conserved: 50 + 1450.00 out, 2500 in.
    expect(month.totalExpenses).toBeCloseTo(1500, 6);
    expect(month.totalIncome).toBe(2500);
  });

  it('aggregates multiple payments to the same card into one line', () => {
    const transactions = [
      tx({ bookingDate: '2026-05-05', amount: -300, counterpartyName: 'Example Bank Retail Oyj' }),
      tx({ bookingDate: '2026-05-25', amount: -700, counterpartyName: 'Example Bank Retail Oyj' }),
    ];
    const cardPayments = [
      {
        linkId: 'card-op',
        cardName: 'OP Card',
        credits: [
          { date: '2026-05-06', amount: 300 },
          { date: '2026-05-26', amount: 700 },
        ],
      },
    ];
    const [month] = calculateRetrospective({ accountId: 'acc-1', transactions, anchor, cardPayments });
    const cardLines = month.expenseBreakdown.filter((i) => i.source === 'credit-card');
    expect(cardLines).toHaveLength(1);
    expect(cardLines[0]).toMatchObject({ itemId: 'card-op', amount: 1000 });
    expect(month.totalExpenses).toBe(1000);
  });

  it('leaves debits untouched when no card settlement matches', () => {
    const transactions = [
      tx({ bookingDate: '2026-05-30', amount: -1450.00, counterpartyName: 'Example Bank Retail Oyj' }),
    ];
    const cardPayments = [
      // Wrong amount → no match.
      { linkId: 'card-op', cardName: 'OP Card', credits: [{ date: '2026-06-01', amount: 100 }] },
    ];
    const [month] = calculateRetrospective({ accountId: 'acc-1', transactions, anchor, cardPayments });
    expect(month.expenseBreakdown.find((i) => i.source === 'credit-card')).toBeUndefined();
    expect(month.expenseBreakdown.find((i) => i.name === 'Example Bank Retail Oyj')?.amount).toBe(1450.00);
  });

  it('collapses an old-month card bill via a fingerprint learned from a newer seed-matched month', () => {
    const transactions = [
      // May: the monthly card bill HAS a settlement credit on the card ledger,
      // so it seed-matches (and teaches the cash-side fingerprint).
      tx({
        bookingDate: '2026-05-30',
        amount: -840.00,
        counterpartyName: 'Example Bank Plc',
        remittanceInfo: '1000000001\ninvoice 99812',
      }),
      tx({ bookingDate: '2026-05-05', amount: 2500, counterpartyName: 'Employer' }),
      // April: SAME bill fingerprint (constant first remittance line), different
      // amount, and NO April settlement credit exists — only the learned
      // fingerprint links it to the card.
      tx({
        bookingDate: '2026-04-28',
        amount: -1050.4,
        counterpartyName: 'Example Bank Plc',
        remittanceInfo: '1000000001\ninvoice 77641',
      }),
      tx({ bookingDate: '2026-04-05', amount: 2500, counterpartyName: 'Employer' }),
    ];
    // Only ONE settlement credit is served by the card ledger (July-side, a
    // couple days after the May cash debit).
    const cardPayments = [
      { linkId: 'card-one', cardName: 'Card One', credits: [{ date: '2026-06-01', amount: 840.00 }] },
    ];
    const months = calculateRetrospective({ accountId: 'acc-1', transactions, anchor, cardPayments });
    const april = months.find((m) => m.yearMonth === '2026-04')!;
    const may = months.find((m) => m.yearMonth === '2026-05')!;

    // BOTH months collapse the bill into one credit-card line — the opaque
    // counterparty expense is gone even in April, which had no credit of its own.
    for (const m of [april, may]) {
      expect(m.expenseBreakdown.find((i) => i.name === 'Example Bank Plc')).toBeUndefined();
      const cardLine = m.expenseBreakdown.find((i) => i.source === 'credit-card');
      expect(cardLine?.itemId).toBe('card-one');
      expect(cardLine?.name).toBe('Card: Card One');
    }
    expect(may.expenseBreakdown.find((i) => i.source === 'credit-card')?.amount).toBeCloseTo(840.00, 6);
    expect(april.expenseBreakdown.find((i) => i.source === 'credit-card')?.amount).toBeCloseTo(1050.4, 6);
    // Totals conserved (income untouched).
    expect(may.totalIncome).toBe(2500);
    expect(april.totalIncome).toBe(2500);
  });

  it('learns a fingerprint from an ANCHOR-month seed the retrospective never emits', () => {
    const transactions = [
      // June = the anchor month: excluded from retro output, but its bill debit
      // is the ONLY one with a settlement credit in range (the Nordea case —
      // the card ledger serves ~1 month of history).
      tx({
        bookingDate: '2026-06-01',
        amount: -840.00,
        counterpartyName: 'Example Bank Plc',
        remittanceInfo: '1000000001\ninvoice 99812',
      }),
      // May (a retro month): same bill fingerprint, no credit of its own.
      tx({
        bookingDate: '2026-05-02',
        amount: -589.23,
        counterpartyName: 'Example Bank Plc',
        remittanceInfo: '1000000001\ninvoice 88123',
      }),
      tx({ bookingDate: '2026-05-05', amount: 2500, counterpartyName: 'Employer' }),
    ];
    const cardPayments = [
      { linkId: 'card-one', cardName: 'Card One', credits: [{ date: '2026-06-02', amount: 840.00 }] },
    ];
    const months = calculateRetrospective({ accountId: 'acc-1', transactions, anchor, cardPayments });
    expect(months).toHaveLength(1); // June itself is never emitted
    const may = months[0];
    expect(may.yearMonth).toBe('2026-05');
    expect(may.expenseBreakdown.find((i) => i.name === 'Example Bank Plc')).toBeUndefined();
    const cardLine = may.expenseBreakdown.find((i) => i.source === 'credit-card');
    expect(cardLine?.itemId).toBe('card-one');
    expect(cardLine?.amount).toBeCloseTo(589.23, 6);
  });

  it('produces identical output whether cardPayments is omitted or empty (backward compatible)', () => {
    const transactions = [
      tx({ bookingDate: '2026-05-03', amount: 1000, counterpartyName: 'In' }),
      tx({ bookingDate: '2026-05-30', amount: -1450.00, counterpartyName: 'Example Bank Retail Oyj' }),
    ];
    const without = calculateRetrospective({ accountId: 'acc-1', transactions, anchor });
    const withEmpty = calculateRetrospective({ accountId: 'acc-1', transactions, anchor, cardPayments: [] });
    expect(withEmpty).toEqual(without);
    // No card line appears without a matching source.
    expect(without[0].expenseBreakdown.every((i) => i.source === 'bank-actual')).toBe(true);
  });
});
