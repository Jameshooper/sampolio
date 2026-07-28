/**
 * Bank transaction ↔ split-expense matching (pure, unit-tested).
 *
 * Flags a bank ledger row as "already split" so the user isn't tempted to
 * "Split this" the same purchase twice. Two ways a match is established:
 *
 *  - Explicit: the split expense was created via "Split this" on this exact
 *    transaction (`SplitExpenseItem.bankLink`) — always wins, regardless of
 *    amount/date drift (the bank may later re-categorize or adjust a pending
 *    row's amount).
 *  - Heuristic: no explicit link exists, but an unlinked split expense has the
 *    same amount and a nearby date — covers expenses added manually in Split
 *    before "Split this" existed, or without going through the bank page. The
 *    date compared is the purchase date (`transactionDate ?? bookingDate`),
 *    since split expenses are recorded on the day the purchase happened, not
 *    the day the bank booked it (which can trail by a few days).
 *
 * Matching is greedy one-to-one so a recurring near-identical expense (e.g. a
 * €12.99 subscription split every month) doesn't flag every bank row that
 * happens to share its amount.
 */

import { differenceInCalendarDays } from 'date-fns';
import type { SplitLinkCandidate } from '@/types';

export interface BankTxForMatch {
  id: string;
  amount: number; // signed, account currency
  currency: string;
  bookingDate: string; // 'YYYY-MM-DD' or a full ISO datetime
  transactionDate?: string; // real purchase date, when the bank provides one
}

export interface BankSplitMatch {
  kind: 'linked' | 'heuristic';
  expenseId: string;
  groupId: string;
  groupName: string;
  title: string;
}

const HEURISTIC_DAY_TOLERANCE = 3;

/** Bare 'YYYY-MM-DD' (or datetime, truncated to the date) → local midnight Date. */
function toDate(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00`);
}

function toMatch(kind: BankSplitMatch['kind'], candidate: SplitLinkCandidate): BankSplitMatch {
  return { kind, expenseId: candidate.expenseId, groupId: candidate.groupId, groupName: candidate.groupName, title: candidate.title };
}

/** Match bank transactions to split-group expense candidates. Returns a map
 * keyed by transaction id — only transactions with a match appear. */
export function matchTransactionsToSplits(
  txs: BankTxForMatch[],
  candidates: SplitLinkCandidate[],
): Map<string, BankSplitMatch> {
  const result = new Map<string, BankSplitMatch>();
  if (txs.length === 0 || candidates.length === 0) return result;

  // Explicit links, indexed by txId — always win over any heuristic.
  const byTxId = new Map<string, SplitLinkCandidate>();
  for (const c of candidates) {
    if (c.bankLink) byTxId.set(c.bankLink.txId, c);
  }

  const matchedTxIds = new Set<string>();
  const matchedExpenseIds = new Set<string>();
  for (const tx of txs) {
    const candidate = byTxId.get(tx.id);
    if (!candidate) continue;
    result.set(tx.id, toMatch('linked', candidate));
    matchedTxIds.add(tx.id);
    matchedExpenseIds.add(candidate.expenseId);
  }

  // Heuristic pool: only candidates with NO bankLink at all — one explicitly
  // linked to a different transaction never heuristically matches another.
  // Indexed by `currency:amountCents` so lookup is O(1) per transaction.
  const byAmountKey = new Map<string, SplitLinkCandidate[]>();
  for (const c of candidates) {
    if (c.bankLink) continue;
    const key = `${c.currency}:${c.amountCents}`;
    const bucket = byAmountKey.get(key);
    if (bucket) bucket.push(c);
    else byAmountKey.set(key, [c]);
  }

  interface Pair {
    txId: string;
    candidate: SplitLinkCandidate;
    distance: number;
  }
  const pairs: Pair[] = [];
  for (const tx of txs) {
    if (matchedTxIds.has(tx.id) || tx.amount >= 0) continue; // only spend, and not already explicit
    const amountCents = Math.round(Math.abs(tx.amount) * 100);
    const bucket = byAmountKey.get(`${tx.currency}:${amountCents}`);
    if (!bucket) continue;
    const txDate = toDate(tx.transactionDate ?? tx.bookingDate);
    for (const candidate of bucket) {
      const distance = Math.abs(differenceInCalendarDays(txDate, toDate(candidate.date)));
      if (distance <= HEURISTIC_DAY_TOLERANCE) pairs.push({ txId: tx.id, candidate, distance });
    }
  }

  // Greedy one-to-one: closest date distance first; ties go to the newer
  // candidate date. Each pass consumes both the tx and the candidate.
  pairs.sort((a, b) => a.distance - b.distance || b.candidate.date.localeCompare(a.candidate.date));
  for (const { txId, candidate } of pairs) {
    if (matchedTxIds.has(txId) || matchedExpenseIds.has(candidate.expenseId)) continue;
    result.set(txId, toMatch('heuristic', candidate));
    matchedTxIds.add(txId);
    matchedExpenseIds.add(candidate.expenseId);
  }

  return result;
}
