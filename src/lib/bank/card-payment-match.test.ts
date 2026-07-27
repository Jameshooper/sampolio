import { describe, it, expect } from 'vitest';
import {
  matchCardPayments,
  matchCardPaymentsWithFingerprints,
  type CardPaymentSource,
  type CashDebitInput,
} from './card-payment-match';

function card(linkId: string, credits: { date: string; amount: number }[], cardName = `${linkId} card`): CardPaymentSource {
  return { linkId, cardName, credits };
}

describe('matchCardPayments', () => {
  it('returns an empty map for empty inputs', () => {
    expect(matchCardPayments([], [])).toEqual(new Map());
    expect(matchCardPayments([{ id: 'd1', bookingDate: '2026-06-30', amount: -100 }], [])).toEqual(new Map());
    expect(matchCardPayments([], [card('c1', [{ date: '2026-07-01', amount: 100 }])])).toEqual(new Map());
  });

  it('matches an exact-amount debit to a credit dated a couple days later', () => {
    const debits = [{ id: 'd1', bookingDate: '2026-06-30', amount: -1450.00 }];
    const cards = [card('card-A', [{ date: '2026-07-02', amount: 1450.00 }], 'OP Card')];
    const result = matchCardPayments(debits, cards);
    expect(result.get('d1')).toEqual({ linkId: 'card-A', cardName: 'OP Card' });
    expect(result.size).toBe(1);
  });

  it('honours the ±4 day tolerance boundary', () => {
    const cards = [card('card-A', [{ date: '2026-06-30', amount: 500 }])];
    // Exactly 4 days apart → match.
    expect(matchCardPayments([{ id: 'in', bookingDate: '2026-07-04', amount: -500 }], cards).has('in')).toBe(true);
    // 5 days apart → no match.
    expect(matchCardPayments([{ id: 'out', bookingDate: '2026-07-05', amount: -500 }], cards).has('out')).toBe(false);
  });

  it('does not match when the amounts differ', () => {
    const cards = [card('card-A', [{ date: '2026-07-01', amount: 100.0 }])];
    // One cent off → no match (exact-cents required).
    const result = matchCardPayments([{ id: 'd1', bookingDate: '2026-07-01', amount: -100.01 }], cards);
    expect(result.size).toBe(0);
  });

  it('never matches a credit (positive amount) on the cash side', () => {
    const cards = [card('card-A', [{ date: '2026-07-01', amount: 100 }])];
    const result = matchCardPayments([{ id: 'refund', bookingDate: '2026-07-01', amount: 100 }], cards);
    expect(result.size).toBe(0);
  });

  it('is one-to-one: two identical debits, one credit → only one matched', () => {
    const debits = [
      { id: 'd1', bookingDate: '2026-06-29', amount: -300 },
      { id: 'd2', bookingDate: '2026-06-30', amount: -300 },
    ];
    const cards = [card('card-A', [{ date: '2026-06-30', amount: 300 }])];
    const result = matchCardPayments(debits, cards);
    expect(result.size).toBe(1);
    // The closest-date debit (d2, distance 0) wins over d1 (distance 1).
    expect(result.has('d2')).toBe(true);
    expect(result.has('d1')).toBe(false);
  });

  it('is one-to-one: two credits, two identical debits → both matched to distinct credits', () => {
    const debits = [
      { id: 'd1', bookingDate: '2026-06-15', amount: -300 },
      { id: 'd2', bookingDate: '2026-06-30', amount: -300 },
    ];
    const cards = [
      card('card-A', [
        { date: '2026-06-16', amount: 300 },
        { date: '2026-06-30', amount: 300 },
      ]),
    ];
    const result = matchCardPayments(debits, cards);
    expect(result.size).toBe(2);
    expect(result.get('d1')?.linkId).toBe('card-A');
    expect(result.get('d2')?.linkId).toBe('card-A');
  });

  it('matches debits to the correct card across multiple cards', () => {
    const debits = [
      { id: 'op', bookingDate: '2026-06-30', amount: -1450.00 },
      { id: 'bank-a', bookingDate: '2026-06-28', amount: -540.5 },
    ];
    const cards = [
      card('op-link', [{ date: '2026-07-01', amount: 1450.00 }], 'OP'),
      card('bank-link', [{ date: '2026-06-29', amount: 540.5 }], 'Example Bank'),
    ];
    const result = matchCardPayments(debits, cards);
    expect(result.get('op')).toEqual({ linkId: 'op-link', cardName: 'OP' });
    expect(result.get('bank-a')).toEqual({ linkId: 'bank-link', cardName: 'Example Bank' });
  });

  it('ignores non-positive or unrelated credits without matching', () => {
    const cards = [card('card-A', [{ date: '2026-07-01', amount: 0 }, { date: '2026-07-01', amount: -50 }])];
    const result = matchCardPayments([{ id: 'd1', bookingDate: '2026-07-01', amount: -50 }], cards);
    expect(result.size).toBe(0);
  });
});

describe('matchCardPaymentsWithFingerprints', () => {
  it('returns the plain seed matches when no fingerprint can be learned', () => {
    // A seed match with no counterparty/remittance ⇒ no fingerprint, so the
    // result equals matchCardPayments exactly.
    const debits: CashDebitInput[] = [{ id: 'd1', bookingDate: '2026-07-01', amount: -840.00 }];
    const cards = [card('bank-a', [{ date: '2026-07-01', amount: 840.00 }], 'Card One')];
    expect(matchCardPaymentsWithFingerprints(debits, cards)).toEqual(matchCardPayments(debits, cards));
  });

  it('propagates a learned fingerprint to an earlier month with no settlement credit', () => {
    const debits: CashDebitInput[] = [
      // July bill: seed-matched (a settlement credit exists this month).
      {
        id: 'jul',
        bookingDate: '2026-07-01',
        amount: -840.00,
        counterpartyName: 'Example Bank Plc',
        remittanceInfo: '1000000001\ninvoice 99812',
      },
      // June bill: SAME fingerprint (first remittance line), different amount,
      // and the card ledger has no June settlement credit to seed-match it.
      {
        id: 'jun',
        bookingDate: '2026-06-01',
        amount: -1050.4,
        counterpartyName: 'Example Bank Plc',
        remittanceInfo: '1000000001\ninvoice 77641',
      },
    ];
    const cards = [card('card-one', [{ date: '2026-07-01', amount: 840.00 }], 'Card One')];
    const result = matchCardPaymentsWithFingerprints(debits, cards);
    expect(result.get('jul')).toEqual({ linkId: 'card-one', cardName: 'Card One' });
    // The earlier month, with no credit of its own, is tagged via the fingerprint.
    expect(result.get('jun')).toEqual({ linkId: 'card-one', cardName: 'Card One' });
  });

  it('does not learn a fingerprint from a seed below the €50 floor', () => {
    const debits: CashDebitInput[] = [
      { id: 'seed', bookingDate: '2026-07-01', amount: -40, counterpartyName: 'Example Bank Plc', remittanceInfo: '1000000001' },
      { id: 'other', bookingDate: '2026-06-01', amount: -35, counterpartyName: 'Example Bank Plc', remittanceInfo: '1000000001' },
    ];
    const cards = [card('bank-a', [{ date: '2026-07-01', amount: 40 }], 'Example Bank')];
    const result = matchCardPaymentsWithFingerprints(debits, cards);
    expect(result.get('seed')).toBeDefined(); // the seed itself still matches
    expect(result.has('other')).toBe(false); // but nothing was learned from it
  });

  it('drops an ambiguous fingerprint learned for two different cards', () => {
    const debits: CashDebitInput[] = [
      // Seed for card A.
      { id: 'a', bookingDate: '2026-07-01', amount: -100, counterpartyName: 'Shared Oy', remittanceInfo: 'REF-1' },
      // Seed for card B — SAME fingerprint as A.
      { id: 'b', bookingDate: '2026-07-01', amount: -200, counterpartyName: 'Shared Oy', remittanceInfo: 'REF-1' },
      // Unmatched, same fingerprint — must NOT be tagged (ambiguous).
      { id: 'c', bookingDate: '2026-06-01', amount: -150, counterpartyName: 'Shared Oy', remittanceInfo: 'REF-1' },
    ];
    const cards = [
      card('card-A', [{ date: '2026-07-01', amount: 100 }], 'A'),
      card('card-B', [{ date: '2026-07-01', amount: 200 }], 'B'),
    ];
    const result = matchCardPaymentsWithFingerprints(debits, cards);
    // Seeds keep their own card.
    expect(result.get('a')?.linkId).toBe('card-A');
    expect(result.get('b')?.linkId).toBe('card-B');
    // The ambiguous fingerprint never tags the unmatched debit.
    expect(result.has('c')).toBe(false);
  });

  it('learns no fingerprint when either part is missing', () => {
    // Counterparty present, remittance absent ⇒ no fingerprint.
    const noRemit: CashDebitInput[] = [
      { id: 'seed', bookingDate: '2026-07-01', amount: -100, counterpartyName: 'Example Bank Plc' },
      { id: 'sib', bookingDate: '2026-06-01', amount: -90, counterpartyName: 'Example Bank Plc' },
    ];
    const cards = [card('bank-a', [{ date: '2026-07-01', amount: 100 }], 'Example Bank')];
    expect(matchCardPaymentsWithFingerprints(noRemit, cards).has('sib')).toBe(false);

    // Remittance present, counterparty absent ⇒ no fingerprint.
    const noCp: CashDebitInput[] = [
      { id: 'seed', bookingDate: '2026-07-01', amount: -100, remittanceInfo: '1000000001' },
      { id: 'sib', bookingDate: '2026-06-01', amount: -90, remittanceInfo: '1000000001' },
    ];
    expect(matchCardPaymentsWithFingerprints(noCp, cards).has('sib')).toBe(false);
  });

  it('never re-tags a seed-matched debit to a different card', () => {
    const debits: CashDebitInput[] = [
      // Teaches fingerprint(X,R) → card A (magnitude ≥ €50).
      { id: 's', bookingDate: '2026-07-01', amount: -100, counterpartyName: 'X', remittanceInfo: 'R' },
      // Seed-matches card B, but is below the floor so it teaches nothing.
      // Its fingerprint is (X,R) too — it must STAY on B, not flip to A.
      { id: 't', bookingDate: '2026-07-01', amount: -40, counterpartyName: 'X', remittanceInfo: 'R' },
      // Unmatched (X,R) debit — tagged to A via the learned fingerprint.
      { id: 'u', bookingDate: '2026-06-01', amount: -75, counterpartyName: 'X', remittanceInfo: 'R' },
    ];
    const cards = [
      card('card-A', [{ date: '2026-07-01', amount: 100 }], 'A'),
      card('card-B', [{ date: '2026-07-01', amount: 40 }], 'B'),
    ];
    const result = matchCardPaymentsWithFingerprints(debits, cards);
    expect(result.get('s')?.linkId).toBe('card-A');
    expect(result.get('t')?.linkId).toBe('card-B'); // kept, not re-tagged
    expect(result.get('u')?.linkId).toBe('card-A');
  });

  it('separates two cards with distinct fingerprints (Example Bank Plc vs Example Finance Ltd)', () => {
    const debits: CashDebitInput[] = [
      // Platinum seed + an older Platinum bill (no credit).
      { id: 'plat-jul', bookingDate: '2026-07-01', amount: -840.00, counterpartyName: 'Example Bank Plc', remittanceInfo: '1000000001\nx' },
      { id: 'plat-jun', bookingDate: '2026-06-01', amount: -980.0, counterpartyName: 'Example Bank Plc', remittanceInfo: '1000000001\ny' },
      // Tuohi seed + an older Tuohi bill (no credit).
      { id: 'tuohi-jul', bookingDate: '2026-07-01', amount: -265.50, counterpartyName: 'Example Finance Ltd', remittanceInfo: '1000000002\na' },
      { id: 'tuohi-jun', bookingDate: '2026-06-01', amount: -310.0, counterpartyName: 'Example Finance Ltd', remittanceInfo: '1000000002\nb' },
    ];
    const cards = [
      card('platinum', [{ date: '2026-07-01', amount: 840.00 }], 'Card One'),
      card('tuohi', [{ date: '2026-07-01', amount: 265.50 }], 'Card Two'),
    ];
    const result = matchCardPaymentsWithFingerprints(debits, cards);
    expect(result.get('plat-jul')?.linkId).toBe('platinum');
    expect(result.get('plat-jun')?.linkId).toBe('platinum');
    expect(result.get('tuohi-jul')?.linkId).toBe('tuohi');
    expect(result.get('tuohi-jun')?.linkId).toBe('tuohi');
  });

  it('normalizes case and whitespace when comparing fingerprints', () => {
    const debits: CashDebitInput[] = [
      { id: 'seed', bookingDate: '2026-07-01', amount: -840.00, counterpartyName: 'EXAMPLE  Bank   Plc', remittanceInfo: '  1000000001 \nfoo' },
      { id: 'sib', bookingDate: '2026-06-01', amount: -900, counterpartyName: 'example bank plc', remittanceInfo: '1000000001\nbar' },
    ];
    const cards = [card('bank-a', [{ date: '2026-07-01', amount: 840.00 }], 'Example Bank')];
    const result = matchCardPaymentsWithFingerprints(debits, cards);
    expect(result.get('sib')?.linkId).toBe('bank-a'); // matched despite case/spacing differences
  });

  it('returns an empty map when there are no seeds', () => {
    const debits: CashDebitInput[] = [
      { id: 'd1', bookingDate: '2026-06-01', amount: -100, counterpartyName: 'Example Bank Plc', remittanceInfo: '1000000001' },
    ];
    // No matching credit ⇒ no seed ⇒ no fingerprint learned ⇒ empty.
    const cards = [card('bank-a', [{ date: '2026-07-01', amount: 55 }], 'Example Bank')];
    expect(matchCardPaymentsWithFingerprints(debits, cards).size).toBe(0);
  });
});
