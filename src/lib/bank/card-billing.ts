/**
 * Enable Banking — credit-card billing engine (pure, no I/O, fully testable).
 *
 * AIS rarely exposes statement-close / due dates, so they're configured per card.
 * Given those days + the card's transactions (and/or a known statement balance),
 * this derives:
 *   - the firm bill for the most recent CLOSED statement (due on the next
 *     payment-due date) — injected into the paying account's cashflow, PLUS the
 *     previous closed statement's bill for as long as its due month is still
 *     current-or-future (the statement-day rollover would otherwise drop an
 *     already-due bill from the projection mid-month; it ages out once its due
 *     month passes),
 *   - a blended bill for the current OPEN cycle: actual booked+pending spend so
 *     far, plus the caller-supplied cycle forecast pro-rated over the days of
 *     the cycle still ahead — but only up to the forecast (once actuals reach
 *     the expected total, no extra estimate is piled on top),
 *   - the current outstanding + the month it's due (for the net-worth liability),
 *   - the "best day to shop" = the day after the statement closes (max float).
 *
 * Cycle spend counts PURCHASES net of merchant refunds, but NEVER card
 * payments/settlements (the credit that pays a prior statement). A payment
 * booked inside the current cycle would otherwise cancel that cycle's purchases
 * — it reduces the outstanding balance, it is not negative spend. See
 * `isCardPayment`.
 */

import type { YearMonth } from '@/types';

export interface CardTxn {
  bookingDate: string; // 'YYYY-MM-DD'
  amount: number; // signed: spend negative, payment/refund positive
  // Optional signals used only to tell a card PAYMENT (bill settlement) apart
  // from a merchant REFUND — both are credits (positive amount). See isCardPayment.
  bankTransactionCode?: string; // bank's human label, e.g. "Suoritus" / "Korttiosto"
  counterpartyName?: string;
  merchantCategoryCode?: string;
}

// Free-text codes that mark a credit as a balance settlement (paying the card
// bill), never a purchase. Only ever tested against CREDITS (positive amounts),
// so a POS purchase labelled "…payment" — always a debit — is never matched.
const CARD_PAYMENT_CODE_RE = /suoritus|payment|autopay|autogiro|direct\s*debit|repay|settle/i;

/**
 * Is this transaction a card PAYMENT (money paid INTO the card to settle a
 * balance) rather than spend or a merchant refund? Payments must be excluded
 * from cycle spend: a payment booked inside a cycle would otherwise cancel that
 * cycle's purchases (the reported "cycle shows almost nothing" bug).
 *
 * Only credits (positive amount) can be payments. Among credits, a payment is:
 *  - flagged by a settlement transaction code, OR
 *  - flagged by a settlement-pattern COUNTERPARTY name AND carrying no MCC (OP
 *    reports settlements as a credit named "Suoritus" with no code and no MCC;
 *    the MCC guard keeps a genuine merchant refund from a processor whose name
 *    contains e.g. "Payments" — which still carries an MCC — in the net), OR
 *  - a "bare" credit with no merchant identity (no counterparty, no MCC) — a
 *    bank-to-card transfer.
 * A credit that names a merchant (or carries an MCC) is otherwise treated as a
 * refund and kept in the net (so refunds still reduce the bill). Erring toward
 * "payment" for ambiguous credits only over-estimates the bill slightly — the
 * safe direction — whereas mistaking a payment for a refund wipes out the cycle.
 */
export function isCardPayment(t: CardTxn): boolean {
  if (t.amount <= 0) return false;
  if (CARD_PAYMENT_CODE_RE.test(t.bankTransactionCode ?? '')) return true;
  if (!t.merchantCategoryCode && CARD_PAYMENT_CODE_RE.test(t.counterpartyName ?? '')) return true;
  return !t.counterpartyName && !t.merchantCategoryCode;
}

/** Project any stored bank transaction onto the billing engine's CardTxn shape. */
export function toCardTxn(t: {
  bookingDate: string;
  amount: number;
  bankTransactionCode?: string;
  counterpartyName?: string;
  merchantCategoryCode?: string;
}): CardTxn {
  return {
    bookingDate: t.bookingDate,
    amount: t.amount,
    bankTransactionCode: t.bankTransactionCode,
    counterpartyName: t.counterpartyName,
    merchantCategoryCode: t.merchantCategoryCode,
  };
}

/**
 * What a bill amount is derived from:
 *  - 'statement'  — a closed statement (firm),
 *  - 'open-cycle' — the current open cycle: actuals so far + pro-rata forecast,
 *  - 'forecast'   — a future cycle with no transaction data (flat estimate).
 * The engine emits the first two; the projection-input forecast loop uses the third.
 */
export type CardBillBasis = 'statement' | 'open-cycle' | 'forecast';

export interface CardBill {
  billYearMonth: YearMonth; // month the bill is due (drives the cashflow line)
  amount: number; // positive amount owed
  isEstimate: boolean; // true for the not-yet-closed current cycle
  basis: CardBillBasis;
  actualToDate?: number; // open-cycle only: booked+pending spend so far
  statementCloseDate: string; // 'YYYY-MM-DD'
  dueDate: string; // 'YYYY-MM-DD'
}

export interface CardBillingResult {
  bills: CardBill[];
  outstanding: number; // current total owed (positive)
  currentBillYearMonth?: YearMonth; // when the current outstanding is due
  bestShopDay?: number; // day-of-month that maximizes interest-free float
  nextStatementCloseDate?: string;
}

export interface CardBillingInput {
  statementDay?: number;
  paymentDueDay?: number;
  outstanding?: number; // current balance from sync (preferred source)
  lastStatementBalance?: number; // explicit statement balance, if known
  transactions: CardTxn[];
  /**
   * Expected TOTAL spend for the open cycle (tagged card items for the cycle's
   * spend month + the card's expectedMonthlySpend buffer). Only its pro-rata
   * share for the not-yet-elapsed part of the cycle is added on top of actuals.
   */
  openCycleForecast?: number;
  now?: Date;
}

/**
 * Suggest a statement-close day from the payment-due day, shifting back by a
 * typical grace period. The real grace is issuer-specific, so this is only a
 * starting suggestion the user can override. Wraps within a ~30-day month and
 * returns a day in 1–28 so it's valid in every month.
 *
 * Example: dueDay 1, grace 18 → 13 (statement closes ~13th, due ~1st next month).
 */
export function suggestStatementDay(dueDay: number, graceDays: number): number {
  if (!dueDay || dueDay < 1 || dueDay > 31) return dueDay;
  let d = dueDay - graceDays;
  while (d <= 0) d += 30;
  return Math.min(d, 28);
}

function clampDay(year: number, month1to12: number, day: number): number {
  const daysInMonth = new Date(year, month1to12, 0).getDate();
  return Math.min(Math.max(day, 1), daysInMonth);
}

function dateAt(year: number, month1to12: number, day: number): Date {
  return new Date(year, month1to12 - 1, clampDay(year, month1to12, day));
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function yearMonthOf(d: Date): YearMonth {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** The statement close on-or-before `asOf`, and the prior close (cycle start). */
function recentCloses(asOf: Date, statementDay: number): { close: Date; prevClose: Date; nextClose: Date } {
  const y = asOf.getFullYear();
  const m = asOf.getMonth() + 1;
  const thisMonthClose = dateAt(y, m, statementDay);
  const close = asOf >= thisMonthClose ? thisMonthClose : dateAt(y, m - 1, statementDay);
  const prevClose = dateAt(close.getFullYear(), close.getMonth(), statementDay); // month before `close`
  const nextClose = dateAt(close.getFullYear(), close.getMonth() + 2, statementDay); // month after `close`
  return { close, prevClose, nextClose };
}

/** First date strictly after `after` whose day-of-month is `day`. */
function nextDueAfter(after: Date, day: number): Date {
  let candidate = dateAt(after.getFullYear(), after.getMonth() + 1, day);
  if (candidate <= after) candidate = dateAt(after.getFullYear(), after.getMonth() + 2, day);
  return candidate;
}

/**
 * Net PURCHASE spend in (start, end]: purchases are negative and merchant
 * refunds positive, so negate the sum and floor at 0. Card payments (bill
 * settlements) are skipped — they reduce the outstanding balance, not spend, and
 * would otherwise cancel the cycle's purchases when booked inside the window.
 */
function cycleSpend(transactions: CardTxn[], start: Date, end: Date): number {
  let sum = 0;
  for (const t of transactions) {
    if (isCardPayment(t)) continue;
    const d = new Date(`${t.bookingDate}T00:00:00`);
    if (d > start && d <= end) sum += t.amount;
  }
  return Math.max(0, -sum);
}

/**
 * The transactions that make up a statement that closed on `closeYmd`: those
 * booked in the cycle window (closeYmd − 1 month, closeYmd]. Used to drill a
 * card bill down to its individual purchases. Generic over any row carrying a
 * `bookingDate`.
 */
export function transactionsForCycle<T extends { bookingDate: string }>(
  transactions: T[],
  closeYmd: string
): T[] {
  const close = new Date(`${closeYmd}T23:59:59`);
  if (Number.isNaN(close.getTime())) return [];
  const prev = new Date(close);
  prev.setMonth(prev.getMonth() - 1);
  return transactions.filter((t) => {
    const d = new Date(`${t.bookingDate.slice(0, 10)}T12:00:00`);
    return !Number.isNaN(d.getTime()) && d > prev && d <= close;
  });
}

/**
 * The due month of the current OPEN cycle's bill and the month whose tagged
 * items feed that cycle (mirrors the forecast-loop rule: a bill due in month D
 * covers spend from D−1 when the due day is on/before the statement day, else
 * from D itself). Lets callers compute `openCycleForecast` without duplicating
 * cycle math.
 */
export function getOpenCycleMonths(
  statementDay: number,
  paymentDueDay: number,
  now: Date = new Date()
): { dueYearMonth: YearMonth; spendYearMonth: YearMonth } {
  const { nextClose } = recentCloses(now, statementDay);
  const openDue = nextDueAfter(nextClose, paymentDueDay);
  const dueYearMonth = yearMonthOf(openDue);
  const spendDate =
    paymentDueDay <= statementDay
      ? new Date(openDue.getFullYear(), openDue.getMonth() - 1, 1)
      : openDue;
  return { dueYearMonth, spendYearMonth: yearMonthOf(spendDate) };
}

export function computeCardBilling(input: CardBillingInput): CardBillingResult {
  const now = input.now ?? new Date();
  const { statementDay, paymentDueDay } = input;

  // Without a cycle configured we can still report the outstanding, but no bills.
  if (!statementDay || !paymentDueDay) {
    return {
      bills: [],
      outstanding: Math.max(0, input.outstanding ?? input.lastStatementBalance ?? 0),
    };
  }

  const { close, prevClose, nextClose } = recentCloses(now, statementDay);

  const bills: CardBill[] = [];

  // The statement BEFORE the "most recent closed" one, i.e. (prevPrevClose,
  // prevClose]. `close` flips forward to this month's statement day the
  // instant `asOf` reaches it, which would otherwise silently drop the
  // still-due bill for the cycle that just rolled out of "most recent": e.g.
  // statementDay 13 / paymentDueDay 1 — on Jul 13 `close` jumps from Jun 13 to
  // Jul 13, and the Jun13→Jul13 bill (due Aug 1) becomes "most recent", but the
  // May13→Jun13 bill (due Jul 1) is STILL due in the current month and must
  // keep appearing in the cashflow projection until its due month is past —
  // even though the user may already have paid it (paid state is handled
  // downstream by current-month actualization, which needs the line to
  // exist). It ages out naturally once `prevDue`'s month is in the past.
  const prevPrevClose = dateAt(prevClose.getFullYear(), prevClose.getMonth(), statementDay); // month before prevClose
  const prevBalance = cycleSpend(input.transactions, prevPrevClose, prevClose);
  const prevDue = nextDueAfter(prevClose, paymentDueDay);
  if (prevBalance > 0.005 && yearMonthOf(prevDue) >= yearMonthOf(now)) {
    bills.push({
      billYearMonth: yearMonthOf(prevDue),
      amount: prevBalance,
      isEstimate: false,
      basis: 'statement',
      statementCloseDate: ymd(prevClose),
      dueDate: ymd(prevDue),
    });
  }

  // Most recent CLOSED statement → firm bill. `lastStatementBalance` (if
  // supplied) describes only THIS latest statement, never the older one above.
  const closedBalance =
    input.lastStatementBalance != null
      ? Math.max(0, input.lastStatementBalance)
      : cycleSpend(input.transactions, prevClose, close);
  const closedDue = nextDueAfter(close, paymentDueDay);

  if (closedBalance > 0.005) {
    bills.push({
      billYearMonth: yearMonthOf(closedDue),
      amount: closedBalance,
      isEstimate: false,
      basis: 'statement',
      statementCloseDate: ymd(close),
      dueDate: ymd(closedDue),
    });
  }

  // Current open cycle (close, nextClose], due after nextClose: actual
  // booked+pending spend so far, blended toward the cycle forecast (the expected
  // TOTAL for the cycle). We add only the still-unspent part of that forecast,
  // pro-rated over the days still ahead — so once actuals reach (or exceed) the
  // expected total, nothing extra is piled on top. This also subsumes the
  // tagged-item dedup: a tagged item already booked has raised `actualToDate`,
  // shrinking the gap it would otherwise be double-counted into.
  const actualToDate = cycleSpend(input.transactions, close, now);
  const cycleMs = nextClose.getTime() - close.getTime();
  const remainingFraction =
    cycleMs > 0 ? Math.min(1, Math.max(0, (nextClose.getTime() - now.getTime()) / cycleMs)) : 0;
  const forecastGap = Math.max(0, (input.openCycleForecast ?? 0) - actualToDate);
  const openAmount = actualToDate + remainingFraction * forecastGap;
  if (openAmount > 0.005) {
    const openDue = nextDueAfter(nextClose, paymentDueDay);
    bills.push({
      billYearMonth: yearMonthOf(openDue),
      amount: openAmount,
      isEstimate: true,
      basis: 'open-cycle',
      actualToDate,
      statementCloseDate: ymd(nextClose),
      dueDate: ymd(openDue),
    });
  }

  const outstanding = Math.max(
    0,
    input.outstanding ?? closedBalance + cycleSpend(input.transactions, close, now)
  );

  return {
    bills,
    outstanding,
    currentBillYearMonth: yearMonthOf(closedDue),
    bestShopDay: clampDay(now.getFullYear(), now.getMonth() + 1, statementDay + 1),
    nextStatementCloseDate: ymd(nextClose),
  };
}
