import type {
  BankTransaction,
  MonthlyProjection,
  ProjectionLineItem,
  YearMonth,
} from '@/types';
import {
  addMonths,
  compareYearMonths,
  parseYearMonth,
  type ProjectionAnchor,
} from '@/lib/projection';
import {
  matchCardPaymentsWithFingerprints,
  type CardPaymentMatch,
  type CardPaymentSource,
  type CashDebitInput,
} from '@/lib/bank/card-payment-match';

/**
 * How many months of real bank history to reconstruct before the anchor. Bounded
 * by available synced data: the engine only emits the contiguous run of months
 * immediately before the anchor that actually have booked transactions, so this
 * is an upper cap, not a guarantee. Matches the ~24-month bank backfill window
 * (BACKFILL_DAYS) so the deepest available history can surface on the cashflow page.
 */
export const RETROSPECTIVE_MONTHS_BACK = 24;

export interface RetrospectiveInput {
  /** The cash FinancialAccount id these transactions anchor (for stable line ids). */
  accountId: string;
  /** All synced transactions for the cash/savings bank accounts that anchor this account. */
  transactions: BankTransaction[];
  /** The projection anchor — its startMonth/startBalance is where the forecast begins. */
  anchor: ProjectionAnchor;
  /** Maximum number of past months to reconstruct. */
  monthsBack?: number;
  /**
   * Credit-card settlement credits for cards paid from this account. When
   * provided, a cash debit that matches a card settlement (same cents, ±4 days)
   * is collapsed out of its counterparty group into a single aggregated
   * `source: 'credit-card'` "Card: X" line (itemId = the card link id) so the
   * cashflow charts can drill it down into the card's purchases. Omitting it
   * yields the plain counterparty grouping (backward compatible).
   */
  cardPayments?: CardPaymentSource[];
}

/** Pick a stable, human-readable group key for a transaction. Exported for
 * the recurring-transaction detection engine (src/lib/recurring-detection.ts). */
export function groupKeyFor(tx: BankTransaction): string {
  const counterparty = tx.counterpartyName?.trim();
  if (counterparty) return counterparty;
  const remittance = tx.remittanceInfo?.split('\n')[0]?.trim();
  if (remittance) return remittance;
  const code = tx.bankTransactionCode?.trim();
  if (code) return code;
  return 'Other';
}

/** The booking month ('YYYY-MM') of a transaction. */
function bookingMonth(tx: BankTransaction): YearMonth {
  return tx.bookingDate.slice(0, 7);
}

/**
 * Aggregate one month's booked transactions into income/expense line items,
 * grouped by counterparty/merchant. Credits (amount > 0) become income groups,
 * debits (amount < 0) become expense groups; both store positive magnitudes.
 *
 * `matches` is the GLOBAL cash-debit → card map computed once by
 * {@link calculateRetrospective} across every bucketed month (see there). Any
 * debit present in it is pulled out of its counterparty group and folded into a
 * single aggregated `source: 'credit-card'` line per card (itemId = the card
 * link id, name "Card: X"). Month totals are unchanged — the matched debits'
 * magnitudes still sum in, just as one card line instead of scattered
 * counterparty lines. An empty map yields the plain counterparty grouping.
 */
function buildBreakdown(
  accountId: string,
  yearMonth: YearMonth,
  txs: BankTransaction[],
  matches: Map<string, CardPaymentMatch>
): { income: ProjectionLineItem[]; expenses: ProjectionLineItem[] } {
  const incomeGroups = new Map<string, { amount: number; category?: string }>();
  const expenseGroups = new Map<string, { amount: number; category?: string }>();
  // linkId → aggregated card-bill line (matched card-payment debits).
  const cardGroups = new Map<string, { cardName: string; amount: number }>();

  for (const tx of txs) {
    if (tx.amount === 0) continue;
    if (tx.amount < 0) {
      const match = matches.get(tx.id);
      if (match) {
        const existing = cardGroups.get(match.linkId);
        if (existing) existing.amount += Math.abs(tx.amount);
        else cardGroups.set(match.linkId, { cardName: match.cardName, amount: Math.abs(tx.amount) });
        continue; // excluded from the normal counterparty grouping
      }
    }
    const target = tx.amount > 0 ? incomeGroups : expenseGroups;
    const key = groupKeyFor(tx);
    const existing = target.get(key);
    if (existing) {
      existing.amount += Math.abs(tx.amount);
      // Keep the first non-empty bank code we see as the group's category hint.
      if (!existing.category && tx.bankTransactionCode) existing.category = tx.bankTransactionCode;
    } else {
      target.set(key, { amount: Math.abs(tx.amount), category: tx.bankTransactionCode });
    }
  }

  const toItems = (
    groups: Map<string, { amount: number; category?: string }>,
    kind: 'income' | 'expense'
  ): ProjectionLineItem[] =>
    Array.from(groups.entries()).map(([name, { amount, category }]) => ({
      itemId: `bank-actual:${accountId}:${yearMonth}:${kind}:${name}`,
      name,
      amount,
      category,
      source: 'bank-actual' as const,
    }));

  // Aggregated credit-card bill lines: itemId is the bank link id so the
  // cashflow page's per-month `cardBreakdowns` map (also keyed by link id) can
  // drill the line into the card's purchases in the Sankey/treemap.
  const cardItems: ProjectionLineItem[] = Array.from(cardGroups.entries()).map(([linkId, { cardName, amount }]) => ({
    itemId: linkId,
    name: `Card: ${cardName}`,
    amount,
    category: 'Credit cards',
    source: 'credit-card' as const,
  }));

  return {
    income: toItems(incomeGroups, 'income'),
    expenses: [...toItems(expenseGroups, 'expense'), ...cardItems],
  };
}

/**
 * Reconstruct up to `monthsBack` past months purely from real booked bank
 * transactions, sitting continuously to the LEFT of the forecast.
 *
 * Only booked transactions are used (pending may still change). We walk backward
 * from the month just before the anchor, including only the contiguous run of
 * months that actually have transactions (a gap stops the walk), up to `monthsBack`.
 * It deliberately does NOT stop at the account's Sampolio genesis (`startingDate`):
 * real bank history is valid regardless of when the account was created here, so the
 * only bounds are available data + `monthsBack`. Balances are chained backward from
 * the anchor so the newest past month's endingBalance equals the anchor's startBalance
 * — i.e. it meets the forecast's first month exactly.
 *
 * Returns [] when there is no usable history, so non-bank accounts are unaffected.
 */
export function calculateRetrospective(input: RetrospectiveInput): MonthlyProjection[] {
  const { accountId, transactions, anchor } = input;
  const monthsBack = input.monthsBack ?? RETROSPECTIVE_MONTHS_BACK;
  if (monthsBack <= 0) return [];

  // Bucket booked transactions by booking month.
  const byMonth = new Map<YearMonth, BankTransaction[]>();
  for (const tx of transactions) {
    if (tx.status !== 'booked') continue;
    const month = bookingMonth(tx);
    // Ignore anything at/after the anchor — that's the forecast's territory.
    if (compareYearMonths(month, anchor.startMonth) >= 0) continue;
    const bucket = byMonth.get(month);
    if (bucket) bucket.push(tx);
    else byMonth.set(month, [tx]);
  }
  if (byMonth.size === 0) return [];

  // Build ONE global cash-debit → card map up front, across ALL booked debits —
  // including anchor-month ones the retrospective never emits. Doing it globally
  // (not per month) lets fingerprint learning propagate a card's cash-side
  // signature to older months whose card ledger no longer serves the settlement
  // credit (e.g. Nordea's short history window) — and the only amount+date SEED
  // may well live in the current (anchor) month, so seed candidates must not be
  // restricted to the bucketed retro months. buildBreakdown only ever looks up
  // its own month's tx ids, so extra entries are inert. An empty `cardPayments`
  // yields an empty map ⇒ plain counterparty grouping.
  let matches = new Map<string, CardPaymentMatch>();
  if (input.cardPayments && input.cardPayments.length > 0) {
    const allDebits: CashDebitInput[] = [];
    for (const t of transactions) {
      if (t.status !== 'booked' || t.amount >= 0) continue;
      allDebits.push({
        id: t.id,
        bookingDate: t.bookingDate,
        amount: t.amount,
        counterpartyName: t.counterpartyName,
        remittanceInfo: t.remittanceInfo,
      });
    }
    matches = matchCardPaymentsWithFingerprints(allDebits, input.cardPayments);
  }

  // Walk backward from the month before the anchor, newest first, taking only the
  // contiguous run of months with data (up to monthsBack).
  const built: MonthlyProjection[] = [];
  let nextStartingBalance = anchor.startBalance; // the month-after's startingBalance
  let cursor = addMonths(anchor.startMonth, -1);

  for (let i = 0; i < monthsBack; i++) {
    const txs = byMonth.get(cursor);
    if (!txs || txs.length === 0) break; // gap → stop (keeps the chain continuous)

    const { income, expenses } = buildBreakdown(accountId, cursor, txs, matches);
    const totalIncome = income.reduce((s, it) => s + it.amount, 0);
    const totalExpenses = expenses.reduce((s, it) => s + it.amount, 0);
    const netChange = totalIncome - totalExpenses;
    const endingBalance = nextStartingBalance;
    const startingBalance = endingBalance - netChange;
    const { year, month } = parseYearMonth(cursor);

    built.push({
      yearMonth: cursor,
      year,
      month,
      startingBalance,
      totalIncome,
      totalExpenses,
      netChange,
      endingBalance,
      incomeBreakdown: income,
      expenseBreakdown: expenses,
      isActual: true,
    });

    nextStartingBalance = startingBalance;
    cursor = addMonths(cursor, -1);
  }

  // built is newest→oldest; return chronological (oldest→newest).
  return built.reverse();
}
