/**
 * Cash-ledger ↔ credit-card settlement matching (pure, unit-tested).
 *
 * On the retrospective (past bank-actual) cashflow, a monthly credit-card bill
 * appears on the CASH ledger as one opaque debit (e.g. counterparty "Example
 * Bank Retail Oyj" −1450.00). The matching settlement shows on the
 * CARD's own ledger as a payment CREDIT of the same magnitude, dated ~1–2 days
 * later. This matcher pairs a cash debit with a card settlement credit so the
 * retrospective can collapse that debit into a single "Card: X" line whose
 * purchases can then be drilled down — exactly like the forecast-month card
 * bill drill-down.
 *
 * IBANs are NOT used: card links frequently carry no IBAN, so the only reliable
 * signals are the exact amount (in integer cents) and the near-coincident date.
 * Matching is greedy one-to-one so two identical debits in a month don't both
 * latch onto a single settlement credit.
 */

import { differenceInCalendarDays } from 'date-fns';

/** A credit card's settlement credits (positive amounts) — the payments made
 * INTO the card that pay down its balance. `date` is the booking date. */
export interface CardPaymentSource {
  linkId: string;
  cardName: string;
  credits: { date: string; amount: number }[];
}

/** A cash-ledger debit candidate. `counterpartyName`/`remittanceInfo` are
 * optional so the exact-cents+date matcher works from `{ id, bookingDate,
 * amount }` alone; the fingerprint learner (below) uses them when present.
 * Callers already hold full `BankTransaction` rows, so this is intentionally a
 * structural subset. */
export interface CashDebitInput {
  id: string;
  bookingDate: string;
  amount: number;
  counterpartyName?: string;
  remittanceInfo?: string;
}

/** The card a cash debit was matched to (a bill payment). */
export interface CardPaymentMatch {
  linkId: string;
  cardName: string;
}

/** Cash debits and card settlement credits are considered the same payment when
 * their booking dates are within this many days of each other. */
const DAY_TOLERANCE = 4;

/** A learned fingerprint is only trusted when its seed debit was at least this
 * large (euros) — defends against a tiny coincidental exact-cents+date match
 * teaching a bogus cash-side signature. */
export const MIN_FINGERPRINT_SEED_AMOUNT = 50;

/** Bare 'YYYY-MM-DD' (or datetime, truncated to the date) → local midnight Date. */
function toDate(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00`);
}

/**
 * Match cash-ledger debits to credit-card settlement credits. Returns a map
 * keyed by cash transaction id — only debits that matched a card payment appear.
 *
 * A match requires the debit magnitude to equal a credit amount EXACTLY in
 * integer cents and their booking dates to be within ±4 days. Matching is
 * greedy and one-to-one: each cash debit and each card credit is consumed at
 * most once, closest-date pairs first (deterministic tie-breaks).
 */
export function matchCardPayments(
  cashDebits: CashDebitInput[],
  cards: CardPaymentSource[]
): Map<string, CardPaymentMatch> {
  const result = new Map<string, CardPaymentMatch>();
  if (cashDebits.length === 0 || cards.length === 0) return result;

  // Flatten every card's settlement credits, indexed by cents for O(1) lookup.
  // Each credit gets a stable key so it can be consumed at most once.
  interface CreditRef {
    key: string;
    linkId: string;
    cardName: string;
    date: string;
  }
  const creditsByCents = new Map<number, CreditRef[]>();
  for (const card of cards) {
    card.credits.forEach((c, idx) => {
      const cents = Math.round(c.amount * 100);
      if (cents <= 0) return; // settlements are positive; ignore degenerate rows
      const ref: CreditRef = { key: `${card.linkId}:${idx}`, linkId: card.linkId, cardName: card.cardName, date: c.date };
      const bucket = creditsByCents.get(cents);
      if (bucket) bucket.push(ref);
      else creditsByCents.set(cents, [ref]);
    });
  }
  if (creditsByCents.size === 0) return result;

  interface Pair {
    txId: string;
    credit: CreditRef;
    distance: number;
  }
  const pairs: Pair[] = [];
  for (const debit of cashDebits) {
    if (debit.amount >= 0) continue; // only debits (outflows) pay a card bill
    const cents = Math.round(Math.abs(debit.amount) * 100);
    const bucket = creditsByCents.get(cents);
    if (!bucket) continue;
    const debitDate = toDate(debit.bookingDate);
    for (const credit of bucket) {
      const distance = Math.abs(differenceInCalendarDays(debitDate, toDate(credit.date)));
      if (distance <= DAY_TOLERANCE) pairs.push({ txId: debit.id, credit, distance });
    }
  }

  // Greedy one-to-one: nearest date first; deterministic tie-breaks so the same
  // inputs always yield the same pairing.
  pairs.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.credit.date.localeCompare(b.credit.date) ||
      a.txId.localeCompare(b.txId) ||
      a.credit.key.localeCompare(b.credit.key)
  );
  const usedTx = new Set<string>();
  const usedCredit = new Set<string>();
  for (const { txId, credit } of pairs) {
    if (usedTx.has(txId) || usedCredit.has(credit.key)) continue;
    result.set(txId, { linkId: credit.linkId, cardName: credit.cardName });
    usedTx.add(txId);
    usedCredit.add(credit.key);
  }

  return result;
}

/** trim + collapse whitespace + lowercase (same normalization as
 * `syntheticDedupKey`). */
function normalizePart(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** First non-empty line of a (possibly multi-line) remittance string. Card-bill
 * debits carry a constant invoice reference on the FIRST line and a per-invoice
 * varying detail on later lines, so only the first line is fingerprint-stable. */
function firstNonEmptyLine(s: string | undefined): string {
  if (!s) return '';
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.trim();
    if (line) return line;
  }
  return '';
}

/** '␟' = a control char that never appears in bank text, so it can't be
 * forged by a counterparty name that happens to contain the reference. */
const FINGERPRINT_SEP = '␟';

/** A cash debit's fingerprint: normalized counterparty + first remittance line.
 * `null` unless BOTH parts are non-empty (no counterparty-only or
 * reference-only fingerprints — either alone is too weak to trust). */
function fingerprintOf(debit: CashDebitInput): string | null {
  const counterparty = normalizePart(debit.counterpartyName);
  const reference = normalizePart(firstNonEmptyLine(debit.remittanceInfo));
  if (!counterparty || !reference) return null;
  return `${counterparty}${FINGERPRINT_SEP}${reference}`;
}

/**
 * Fingerprint-aware card-payment matching. Some banks (e.g. Nordea) serve only a
 * month or two of card history, so an older monthly bill debit has no settlement
 * credit to match against and stays an opaque counterparty line. This adds a
 * learning pass on top of {@link matchCardPayments}:
 *
 *  1. **Seeds** — the exact-cents+date matcher pairs debits with settlement
 *     credits (unchanged behavior).
 *  2. **Learn** — every seed whose debit magnitude is ≥ {@link MIN_FINGERPRINT_SEED_AMOUNT}
 *     and that carries a full fingerprint (counterparty + first remittance line)
 *     teaches that fingerprint → its card. A fingerprint learned for two
 *     DIFFERENT cards is dropped entirely (ambiguous).
 *  3. **Tag** — any still-unmatched debit whose fingerprint matches a single
 *     learned card is tagged to it. Seed matches are never overwritten.
 *
 * Seeds are computed across the FULL debit list, so callers must pass all months'
 * debits at once for the propagation to reach earlier months. Returns the same
 * `Map<cashTxId, CardPaymentMatch>` shape as {@link matchCardPayments}.
 */
export function matchCardPaymentsWithFingerprints(
  cashDebits: CashDebitInput[],
  cards: CardPaymentSource[]
): Map<string, CardPaymentMatch> {
  const seeds = matchCardPayments(cashDebits, cards);
  if (seeds.size === 0) return seeds; // no seeds → nothing to learn from

  const debitById = new Map<string, CashDebitInput>();
  for (const d of cashDebits) debitById.set(d.id, d);

  // Learn fingerprints from qualifying seeds. `null` marks an ambiguous
  // (multi-card) fingerprint that must never tag anything.
  const learned = new Map<string, CardPaymentMatch | null>();
  for (const [txId, match] of seeds) {
    const debit = debitById.get(txId);
    if (!debit) continue;
    if (Math.abs(debit.amount) < MIN_FINGERPRINT_SEED_AMOUNT) continue;
    const fp = fingerprintOf(debit);
    if (!fp) continue;
    if (!learned.has(fp)) {
      learned.set(fp, { linkId: match.linkId, cardName: match.cardName });
    } else {
      const existing = learned.get(fp);
      if (existing && existing.linkId !== match.linkId) learned.set(fp, null); // ambiguous → drop
    }
  }
  if (learned.size === 0) return seeds;

  // Tag unmatched debits whose fingerprint resolves to a single card. Copy first
  // so seed matches always keep their seed card.
  const result = new Map(seeds);
  for (const debit of cashDebits) {
    if (result.has(debit.id)) continue;
    if (debit.amount >= 0) continue; // only debits (outflows) pay a bill
    const fp = fingerprintOf(debit);
    if (!fp) continue;
    const match = learned.get(fp);
    if (match) result.set(debit.id, { linkId: match.linkId, cardName: match.cardName });
  }
  return result;
}
