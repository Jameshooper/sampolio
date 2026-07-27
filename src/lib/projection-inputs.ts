/**
 * Projection input gathering (server-only, plain module — NOT 'use server').
 *
 * Shared by the cashflow projection action (`src/lib/actions/projection.ts`)
 * and the "What If?" scenario action (`src/lib/actions/scenario.ts`) so both
 * feed `calculateProjection` identical inputs: the account's items, the latest
 * reconciliation anchor, and the injected read-only transfer lines (mortgage
 * payments, confirmed budgets, credit-card bills).
 *
 * Deliberately NOT a server-action file: these helpers take a `userId`
 * parameter and must never become client-invokable endpoints (same pattern as
 * the server-only `src/lib/bank/*` modules).
 */

import {
  cachedGetAccountById,
  cachedGetAccountProjectionData,
  cachedGetLatestSnapshot,
  cachedGetMortgagesForUser,
  cachedGetMortgageProjectionData,
  cachedGetBudgets,
  cachedGetBankConnections,
  cachedGetBankTransactions,
  cachedGetGoals,
  cachedGetTrips,
} from '@/lib/db/cached';
import {
  addMonths,
  compareYearMonths,
  getCurrentYearMonth,
  isRecurringItemActiveInMonth,
  getPlannedRepeatingOccurrences,
  resolveAnchor,
  type MortgageTransfer,
  type BudgetTransfer,
  type CardBillTransfer,
  type CurrentMonthActuals,
  type GoalTransfer,
  type TripTransfer,
} from '@/lib/projection';
import { calculateMortgageProjection, getMortgageStartDate } from '@/lib/mortgage-projection';
import { computeBudgetTransfers, hydrateBudgetFundingFromTrips, tripIdsFundedByActiveBudgets } from '@/lib/budget-utils';
import { goalInjectsIntoCashflow } from '@/lib/goal-utils';
import { calculatePerDiem } from '@/lib/per-diem-utils';
import { computeCardBilling, getOpenCycleMonths, toCardTxn, isCardPayment } from '@/lib/bank/card-billing';
import type { CardPaymentSource } from '@/lib/bank/card-payment-match';
import type {
  FinancialAccount,
  RecurringItem,
  PlannedItem,
  TaxedIncome,
  SalaryConfig,
  BalanceSnapshot,
  BankTransaction,
  YearMonth,
} from '@/types';

export interface ProjectionInputs {
  account: FinancialAccount;
  recurringItems: RecurringItem[];
  plannedItems: PlannedItem[];
  salaryConfigs: SalaryConfig[];
  taxedIncomes: TaxedIncome[];
  latestSnapshot: BalanceSnapshot | null;
  mortgageTransfers: MortgageTransfer[];
  budgetTransfers: BudgetTransfer[];
  goalTransfers: GoalTransfer[];
  tripTransfers: TripTransfer[];
  /**
   * Booked bank transactions for the anchor month, when that month is the
   * current calendar month — feed this straight into `calculateProjection`'s
   * `currentMonthActuals` param. Null when the account has no linked bank
   * data, the anchor isn't the current month, or nothing booked yet.
   */
  currentMonthActuals: CurrentMonthActuals | null;
  /**
   * The item lists with expenses tagged "paid by card" excluded — those don't
   * hit cash directly, they roll into the card's injected bill line instead.
   * Feed THESE to `calculateProjection` (never the unfiltered lists) whenever
   * card-bill transfers are also injected, to avoid double-counting.
   */
  directRecurring: RecurringItem[];
  directPlanned: PlannedItem[];
}

/**
 * Gather everything `calculateProjection` needs for one account: the account,
 * its items + taxed incomes, the latest reconciliation snapshot (anchor), and
 * the injected mortgage/budget transfer lines (fetched in parallel).
 *
 * Card-bill transfers are deliberately NOT gathered here — they depend on the
 * item lists (tagged card spend feeds the forecast cycles), and the scenario
 * action needs to recompute them per modified list. Call
 * `computeCardBillTransfersForAccount` separately.
 *
 * Returns null when the account doesn't exist (or isn't this user's).
 */
export async function gatherProjectionInputs(
  userId: string,
  accountId: string
): Promise<ProjectionInputs | null> {
  const account = await cachedGetAccountById(userId, accountId);
  if (!account) return null;

  const [{ recurringItems, plannedItems, salaryConfigs, taxedIncomes }, latestSnapshot] = await Promise.all([
    cachedGetAccountProjectionData(userId, accountId),
    cachedGetLatestSnapshot(userId, 'cash-account', accountId),
  ]);

  // The anchor's month only depends on `latestSnapshot` (already available),
  // so the actuals fetch can run alongside the mortgage/budget transfers.
  const anchor = resolveAnchor(account.startingDate, account.startingBalance, latestSnapshot);
  const [mortgageTransfers, budgetTransfers, goalTransfers, tripTransfers, currentMonthActuals] = await Promise.all([
    getMortgageTransfersForAccount(userId, accountId),
    getBudgetTransfersForAccount(userId, accountId),
    getGoalTransfersForAccount(userId, accountId),
    getTripTransfersForAccount(userId, accountId),
    getCurrentMonthActualsForAccount(userId, accountId, anchor.startMonth),
  ]);

  // Expenses tagged "paid by card" don't hit cash directly — they roll into
  // the card's statement/forecast bill (injected separately), so exclude them
  // from the direct lists to avoid double-counting.
  const directRecurring = recurringItems.filter((i) => !i.paidByCardLinkId);
  const directPlanned = plannedItems.filter((i) => !i.paidByCardLinkId);

  return {
    account,
    recurringItems,
    plannedItems,
    salaryConfigs,
    taxedIncomes,
    latestSnapshot,
    mortgageTransfers,
    budgetTransfers,
    goalTransfers,
    tripTransfers,
    currentMonthActuals,
    directRecurring,
    directPlanned,
  };
}

/**
 * Booked bank transactions from this account's linked (non-excluded)
 * cash/savings bank accounts, flattened across links. Returns [] when no
 * such link exists.
 */
export async function getLinkedCashBankTransactions(
  userId: string,
  accountId: string
): Promise<BankTransaction[]> {
  const connections = await cachedGetBankConnections(userId);
  const cashLinks = connections.flatMap((conn) =>
    conn.linkedAccounts.filter(
      (link) =>
        (link.accountRole === 'cash' || link.accountRole === 'savings') &&
        link.linkedFinancialAccountId === accountId &&
        !link.isExcluded
    )
  );
  if (cashLinks.length === 0) return [];

  const txGroups = await Promise.all(cashLinks.map((link) => cachedGetBankTransactions(userId, link.id)));
  return txGroups.flat();
}

/**
 * Settlement-credit sources for every credit card PAID FROM this account: one
 * `CardPaymentSource` per non-excluded card link, listing its booked payment
 * credits (the money paid INTO the card, identified by `isCardPayment`). The
 * retrospective engine matches these against opaque cash-ledger bill-payment
 * debits so a past-month card bill collapses into one drillable "Card: X" line.
 * Returns [] when no card is linked (so non-card accounts are unaffected), and
 * a bank problem never breaks the core cashflow.
 */
export async function getCardPaymentSourcesForAccount(
  userId: string,
  accountId: string
): Promise<CardPaymentSource[]> {
  try {
    const connections = await cachedGetBankConnections(userId);
    const cardLinks = connections.flatMap((conn) =>
      conn.linkedAccounts
        .filter(
          (link) =>
            link.accountRole === 'credit-card' &&
            !link.isExcluded &&
            link.linkedFinancialAccountId === accountId
        )
        .map((link) => ({ link, aspspName: conn.aspspName }))
    );
    if (cardLinks.length === 0) return [];

    const sources = await Promise.all(
      cardLinks.map(async ({ link, aspspName }) => {
        const txs = await cachedGetBankTransactions(userId, link.id);
        const cardName = link.customName || link.name || `${aspspName} card`;
        const credits = txs
          .filter((t) => t.status === 'booked' && isCardPayment(toCardTxn(t)))
          .map((t) => ({ date: t.bookingDate.slice(0, 10), amount: Math.abs(t.amount) }));
        return { linkId: link.id, cardName, credits } as CardPaymentSource;
      })
    );
    return sources.filter((s) => s.credits.length > 0);
  } catch (error) {
    console.error('Card payment source gathering failed:', error);
    return [];
  }
}

/**
 * Booked transactions dated within `anchorMonth`, for reconciling the
 * projection's anchor month against real bank activity. Returns null unless
 * `anchorMonth` is the current calendar month (the engine only actualizes the
 * anchor month, and only when it's "now" does live-synced data make sense to
 * apply) or when there's nothing booked yet. A bank problem must never break
 * the core cashflow projection.
 */
export async function getCurrentMonthActualsForAccount(
  userId: string,
  accountId: string,
  anchorMonth: YearMonth
): Promise<CurrentMonthActuals | null> {
  if (anchorMonth !== getCurrentYearMonth()) return null;
  try {
    const transactions = await getLinkedCashBankTransactions(userId, accountId);
    const booked = transactions
      .filter((t) => t.status === 'booked' && t.bookingDate.slice(0, 7) === anchorMonth)
      .map((t) => ({
        id: t.id,
        amount: t.amount,
        bookingDate: t.bookingDate,
        counterpartyName: t.counterpartyName,
        remittanceInfo: t.remittanceInfo,
        bankTransactionCode: t.bankTransactionCode,
      }));
    if (booked.length === 0) return null;
    return { transactions: booked };
  } catch (error) {
    console.error('Current-month actuals gathering failed:', error);
    return null;
  }
}

/**
 * Per-month mortgage transfers this user owes from a given cash account. For each
 * shared mortgage where the user's membership links to `accountId`, run the
 * amortization engine and emit the user's `monthlyDeposit` per month. Returns []
 * when no mortgage is linked, so accounts without a mortgage are unaffected.
 */
export async function getMortgageTransfersForAccount(userId: string, accountId: string): Promise<MortgageTransfer[]> {
  const transfers: MortgageTransfer[] = [];
  try {
    const mortgages = await cachedGetMortgagesForUser(userId);
    // Only mortgages this user pays from `accountId`; usually 0-1, but fetch
    // their projection inputs in parallel rather than awaiting in a loop.
    const relevant = mortgages.filter((m) => {
      if (m.isArchived) return false;
      const me = m.members.find((mem) => mem.userId === userId);
      return !!me && me.linkedAccountId === accountId;
    });

    const perMortgage = await Promise.all(
      relevant.map(async (m) => {
        const inputs = await cachedGetMortgageProjectionData(m.id);
        if (!inputs) return [] as MortgageTransfer[];
        const genesis = getMortgageStartDate(inputs.mortgage);
        const maxTerm = Math.max(...inputs.mortgage.loans.map((l) => l.originalTermMonths), 12);
        const end = addMonths(genesis, maxTerm + 24);
        const months = calculateMortgageProjection(inputs, end);
        return months.flatMap((mm) => {
          const pos = mm.members.find((p) => p.userId === userId);
          return pos && pos.monthlyDeposit > 0.005
            ? [{ yearMonth: mm.yearMonth, mortgageId: m.id, mortgageName: inputs.mortgage.name, amount: pos.monthlyDeposit }]
            : [];
        });
      }),
    );
    transfers.push(...perMortgage.flat());
  } catch (error) {
    // A mortgage problem must never break the core cashflow projection.
    console.error('Mortgage transfer injection failed:', error);
  }
  return transfers;
}

/** Sum of expenses tagged "paid by this card" that occur in a given month. */
function taggedSpendForMonth(
  recurring: RecurringItem[],
  planned: PlannedItem[],
  month: YearMonth,
  cardLinkId: string
): number {
  const eff = (amount: number, isShared?: boolean, ratio?: number) =>
    isShared ? amount * (ratio ?? 0.5) : amount;
  let total = 0;
  for (const item of recurring) {
    if (item.paidByCardLinkId !== cardLinkId || item.type !== 'expense') continue;
    if (isRecurringItemActiveInMonth(item, month)) total += eff(item.amount, item.isShared, item.shareRatio);
  }
  for (const item of planned) {
    if (item.paidByCardLinkId !== cardLinkId || item.type !== 'expense') continue;
    if (item.kind === 'one-off') {
      if (item.scheduledDate === month) total += eff(item.amount, item.isShared, item.shareRatio);
    } else if (getPlannedRepeatingOccurrences(item, month, month).length > 0) {
      total += eff(item.amount, item.isShared, item.shareRatio);
    }
  }
  return total;
}

/**
 * Per-month credit-card bills for cards PAID FROM this account:
 *  - REAL bills for closed statements (computeCardBilling, basis 'statement').
 *  - The OPEN cycle's bill = actual booked+pending spend so far + the cycle
 *    forecast (tagged items + expectedMonthlySpend) pro-rated over the days
 *    still ahead (basis 'open-cycle') — real transactions drive the number.
 *  - FORECAST bills for cycles beyond that = the expenses tagged "paid by this
 *    card" due that cycle + the expectedMonthlySpend buffer (basis 'forecast'),
 *    so long-term projections keep assuming ongoing card costs.
 * Pass the FULL (unfiltered) item lists — tagged card spend feeds the forecast.
 * Returns [] when no card is linked. A card problem must never break cashflow.
 */
export async function computeCardBillTransfersForAccount(
  userId: string,
  accountId: string,
  account: FinancialAccount,
  recurring: RecurringItem[],
  planned: PlannedItem[]
): Promise<CardBillTransfer[]> {
  const transfers: CardBillTransfer[] = [];
  try {
    const connections = await cachedGetBankConnections(userId);
    const currentYM = getCurrentYearMonth();
    const horizonEnd = addMonths(currentYM, Math.max(account.planningHorizonMonths ?? 120, 1));

    for (const conn of connections) {
      for (const link of conn.linkedAccounts) {
        if (link.accountRole !== 'credit-card' || link.isExcluded) continue;
        if (link.linkedFinancialAccountId !== accountId) continue;

        const txs = await cachedGetBankTransactions(userId, link.id);
        const cardName = link.customName || link.name || `${conn.aspspName} card`;
        const buffer = link.expectedMonthlySpend ?? 0;

        // Expected total for the open cycle: tagged items for the cycle's
        // spend month + the buffer. The engine adds only its pro-rata share
        // for the not-yet-elapsed part of the cycle on top of actuals.
        let openCycleForecast = 0;
        if (link.statementDay && link.paymentDueDay) {
          const { spendYearMonth } = getOpenCycleMonths(link.statementDay, link.paymentDueDay);
          openCycleForecast = taggedSpendForMonth(recurring, planned, spendYearMonth, link.id) + buffer;
        }

        const result = computeCardBilling({
          statementDay: link.statementDay,
          paymentDueDay: link.paymentDueDay,
          outstanding: link.outstanding,
          lastStatementBalance: link.lastStatementBalance,
          transactions: txs.map(toCardTxn),
          openCycleForecast,
        });

        // Real bills from the bank statement + the blended open cycle.
        let lastCoveredDue = currentYM;
        for (const bill of result.bills) {
          transfers.push({
            yearMonth: bill.billYearMonth,
            linkId: link.id,
            cardName,
            amount: bill.amount,
            isEstimate: bill.isEstimate,
            basis: bill.basis,
          });
          if (compareYearMonths(bill.billYearMonth, lastCoveredDue) > 0) lastCoveredDue = bill.billYearMonth;
        }

        // Forecast future cycles beyond the open one (needs cycle config).
        if (link.statementDay && link.paymentDueDay) {
          let due = addMonths(lastCoveredDue, 1);
          while (compareYearMonths(due, horizonEnd) <= 0) {
            // The cycle paid by a bill due in `due` closes the prior month when
            // the due day is on/before the statement day, else the same month.
            const spendMonth = link.paymentDueDay <= link.statementDay ? addMonths(due, -1) : due;
            const amount = taggedSpendForMonth(recurring, planned, spendMonth, link.id) + buffer;
            if (amount > 0.005) {
              transfers.push({ yearMonth: due, linkId: link.id, cardName, amount, isEstimate: true, basis: 'forecast' });
            }
            due = addMonths(due, 1);
          }
        }
      }
    }
  } catch (error) {
    console.error('Card bill injection failed:', error);
  }
  return transfers;
}

/**
 * Per-month flows of the user's confirmed budgets linked to this account
 * (planned costs out, usable funding in), computed by the budget engine.
 * Returns [] when no budget is linked, so other accounts are unaffected.
 */
export async function getBudgetTransfersForAccount(userId: string, accountId: string): Promise<BudgetTransfer[]> {
  try {
    const [budgets, trips] = await Promise.all([cachedGetBudgets(userId), cachedGetTrips(userId)]);
    return budgets
      .filter(b => b.status === 'confirmed' && !b.isArchived && b.linkedAccountId === accountId)
      // A trip-linked per-diem source's amount is hydrated live from the trip
      // (stored amount is only a snapshot); do this before the funding-income
      // line is computed so the injected income matches the trip.
      .map(b => hydrateBudgetFundingFromTrips(b, trips))
      .flatMap(b => computeBudgetTransfers(b));
  } catch (error) {
    // A budget problem must never break the core cashflow projection.
    console.error('Budget transfer injection failed:', error);
    return [];
  }
}

/**
 * Per-goal target-amount transfer for goals that qualify for cashflow
 * injection (`goalInjectsIntoCashflow`, `src/lib/goal-utils.ts`) and are
 * linked to this account. One transfer per goal, at its target month.
 * Returns [] when no such goal is linked, so other accounts are unaffected.
 */
export async function getGoalTransfersForAccount(userId: string, accountId: string): Promise<GoalTransfer[]> {
  try {
    const goals = await cachedGetGoals(userId);
    return goals
      .filter((g) => goalInjectsIntoCashflow(g) && g.linkedAccountId === accountId)
      .map((g) => ({ yearMonth: g.targetDate!, goalId: g.id, goalName: g.name, amount: g.targetAmount }));
  } catch (error) {
    // A goal problem must never break the core cashflow projection.
    console.error('Goal transfer injection failed:', error);
    return [];
  }
}

/**
 * Per-trip expected per-diem reimbursement transfer for trips linked to this
 * account. Only non-reimbursed trips (status 'planned'/'completed') inject —
 * marking a trip 'reimbursed' stops the cashflow injection, same as a settled
 * budget/goal. The amount is `calculatePerDiem`'s total against the trip's
 * snapshotted rates, so a later per-diem rate change never retroactively
 * alters an already-planned trip.
 */
export async function getTripTransfersForAccount(userId: string, accountId: string): Promise<TripTransfer[]> {
  try {
    const [trips, budgets] = await Promise.all([cachedGetTrips(userId), cachedGetBudgets(userId)]);
    // Double-count guard: a trip whose per-diem already reaches cashflow via a
    // confirmed, account-linked budget (tripIdsFundedByActiveBudgets) must not
    // also inject its own reimbursement income.
    const funded = tripIdsFundedByActiveBudgets(budgets);
    return trips
      .filter((t) => t.status !== 'reimbursed' && t.linkedAccountId === accountId && !funded.has(t.id))
      .map((t) => ({
        yearMonth: t.expectedReimbursementMonth,
        tripId: t.id,
        tripName: t.name,
        amount: calculatePerDiem(t).total,
      }));
  } catch (error) {
    // A trip problem must never break the core cashflow projection.
    console.error('Trip transfer injection failed:', error);
    return [];
  }
}
