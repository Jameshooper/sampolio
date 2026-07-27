/**
 * Current-month bank-actual reconciliation for the cashflow projection (pure,
 * unit-tested).
 *
 * For a bank-linked account, the anchor balance for the current month is the
 * LIVE synced balance — it already reflects everything paid so far this
 * month. Re-applying the full forecast on top of that anchor double-counts
 * those payments. This module reconciles forecast line items against the
 * month's booked bank transactions so only the still-outstanding part of the
 * month is added on top of the anchor:
 *
 *  - Phase 1 (exact match): a forecast line whose amount/sign is close to an
 *    unclaimed booked transaction is matched one-to-one (greedy, name
 *    affinity first) — that line contributes 0 to the remaining forecast, it
 *    is already inside the anchor balance.
 *  - Phase 2 (category-gap blend): unmatched variable-expense lines (e.g.
 *    "Groceries 400") are blended against the category's unmatched spend so
 *    far — the remaining forecast for the category shrinks by what's already
 *    been spent, floored at 0, and split proportionally across the category's
 *    unmatched lines.
 *
 * Mirrors the credit-card billing engine's "actual so far + pro-rated
 * remaining forecast" idea (`src/lib/bank/card-billing.ts`) and reuses the
 * greedy one-to-one matching pattern from `src/lib/bank-split-match.ts`.
 */

import type { ProjectionLineItem } from '@/types';
import { guessItemCategory } from '@/lib/category-utils';

export const ACTUAL_AMOUNT_TOLERANCE_ABS = 1; // currency units
export const ACTUAL_AMOUNT_TOLERANCE_PCT = 0.05;

/** Minimal booked-transaction shape. Caller pre-filters to status==='booked' and bookingDate within the anchor month. */
export interface ActualTxLike {
  id: string;
  amount: number; // signed: credit +, debit −
  bookingDate: string; // 'YYYY-MM-DD' or ISO datetime
  counterpartyName?: string;
  remittanceInfo?: string;
  bankTransactionCode?: string;
}

/**
 * How a forecast line may be reconciled against actuals:
 *  - 'full' — exact match, and eligible for the category-gap blend if unmatched.
 *  - 'exact-only' — exact match only, never gap-reduced (e.g. fixed/injected lines).
 *  - 'none' — never touched (remains at its planned amount).
 */
export type ActualMatchPolicy = 'full' | 'exact-only' | 'none';

export interface ActualizableLine {
  line: ProjectionLineItem;
  type: 'income' | 'expense';
  policy: ActualMatchPolicy;
}

export interface ActualizedLine {
  line: ProjectionLineItem; // same object as input — NOT mutated
  remainingAmount: number; // 0 (paid), partial (gap-reduced), or line.amount
  isPaid: boolean;
  matchedTxId?: string;
}

export interface CurrentMonthActualsResult {
  lines: ActualizedLine[]; // same order as input
  actualToDateNet: number; // Σ signed amounts of ALL supplied txs
  unmatchedSpendByCategory: Map<string, number>; // abs spend of unmatched debits per guessed category
}

// A leading injected-line prefix ("Mortgage: ", "Card: ", "Budget: ") never
// appears in a bank counterparty label, so strip it before name matching.
const INJECTED_PREFIX_RE = /^(Mortgage|Card|Budget):\s*/i;

/** Lowercase, collapse non-alphanumerics (keeping äöå) to single spaces, trim. Mirrors recurring-detection's normalizeName. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9äöå]+/g, ' ')
    .trim();
}

function lineLabel(name: string): string {
  return normalizeName(name.replace(INJECTED_PREFIX_RE, ''));
}

/** counterpartyName, else first non-empty line of remittanceInfo, else bankTransactionCode, else ''. */
function txLabel(tx: ActualTxLike): string {
  if (tx.counterpartyName) return tx.counterpartyName;
  const remittanceLine = (tx.remittanceInfo ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (remittanceLine) return remittanceLine;
  return tx.bankTransactionCode ?? '';
}

function nameAffinity(a: string, b: string): number {
  if (!a || !b) return 0;
  return a.includes(b) || b.includes(a) ? 1 : 0;
}

function withinTolerance(planned: number, actual: number): boolean {
  return Math.abs(planned - actual) <= Math.max(ACTUAL_AMOUNT_TOLERANCE_ABS, ACTUAL_AMOUNT_TOLERANCE_PCT * planned);
}

export function applyCurrentMonthActuals(
  lines: ActualizableLine[],
  transactions: ActualTxLike[],
): CurrentMonthActualsResult {
  const actualToDateNet = transactions.reduce((sum, t) => sum + t.amount, 0);

  // ---- Phase 1: exact one-to-one matching ----
  interface Pair {
    lineIndex: number;
    tx: ActualTxLike;
    affinity: number;
    delta: number;
  }
  const pairs: Pair[] = [];
  for (let i = 0; i < lines.length; i++) {
    const { line, type, policy } = lines[i];
    if (policy === 'none') continue;
    if (line.amount <= 0) continue;
    const normalizedLineName = lineLabel(line.name);
    for (const tx of transactions) {
      if (type === 'expense' ? tx.amount >= 0 : tx.amount <= 0) continue;
      const actualAbs = Math.abs(tx.amount);
      if (!withinTolerance(line.amount, actualAbs)) continue;
      pairs.push({
        lineIndex: i,
        tx,
        affinity: nameAffinity(normalizedLineName, normalizeName(txLabel(tx))),
        delta: Math.abs(line.amount - actualAbs),
      });
    }
  }

  pairs.sort(
    (a, b) =>
      b.affinity - a.affinity ||
      a.delta - b.delta ||
      a.tx.bookingDate.localeCompare(b.tx.bookingDate) ||
      a.lineIndex - b.lineIndex,
  );

  const matchedLineIndices = new Set<number>();
  const matchedTxIds = new Set<string>();
  const matchResult = new Map<number, string>(); // lineIndex -> txId
  for (const { lineIndex, tx } of pairs) {
    if (matchedLineIndices.has(lineIndex) || matchedTxIds.has(tx.id)) continue;
    matchedLineIndices.add(lineIndex);
    matchedTxIds.add(tx.id);
    matchResult.set(lineIndex, tx.id);
  }

  // ---- unmatched spend per category (from all unclaimed debits) ----
  const unmatchedSpendByCategory = new Map<string, number>();
  for (const tx of transactions) {
    if (matchedTxIds.has(tx.id)) continue;
    if (tx.amount >= 0) continue;
    const category = guessItemCategory(txLabel(tx));
    if (!category) continue;
    unmatchedSpendByCategory.set(category, (unmatchedSpendByCategory.get(category) ?? 0) + Math.abs(tx.amount));
  }

  // ---- Phase 2: category-gap blend (unmatched 'full' expense lines with a category) ----
  const plannedByCategory = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const { line, type, policy } = lines[i];
    if (policy !== 'full' || type !== 'expense') continue;
    if (matchedLineIndices.has(i)) continue;
    if (!line.category) continue;
    plannedByCategory.set(line.category, (plannedByCategory.get(line.category) ?? 0) + line.amount);
  }

  const remainingAmountByLineIndex = new Map<number, number>();
  for (let i = 0; i < lines.length; i++) {
    const { line, type, policy } = lines[i];
    if (matchedLineIndices.has(i)) continue; // handled below as paid
    if (policy !== 'full' || type !== 'expense' || !line.category) continue;
    const plannedInC = plannedByCategory.get(line.category);
    if (!plannedInC || plannedInC <= 0) continue;
    const spend = unmatchedSpendByCategory.get(line.category) ?? 0;
    const remainingInC = Math.max(0, plannedInC - spend);
    remainingAmountByLineIndex.set(i, (line.amount * remainingInC) / plannedInC);
  }

  const result: ActualizedLine[] = lines.map(({ line }, i) => {
    const matchedTxId = matchResult.get(i);
    if (matchedTxId) {
      return { line, remainingAmount: 0, isPaid: true, matchedTxId };
    }
    const gapReduced = remainingAmountByLineIndex.get(i);
    if (gapReduced != null) {
      return { line, remainingAmount: gapReduced, isPaid: false };
    }
    return { line, remainingAmount: line.amount, isPaid: false };
  });

  return { lines: result, actualToDateNet, unmatchedSpendByCategory };
}
