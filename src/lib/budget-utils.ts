// Pure calculation engine for trip/project budgets: expanding lines and
// funding into per-month series, allocating category-restricted grants,
// computing the feasibility verdict, budget-vs-actual rollups, and the
// per-month transfers injected into a cash account's projection.
// No I/O — usable from both server actions and client components.

import type { Budget, BudgetFundingSource, SplitExpense, Trip, YearMonth } from '@/types';
import { addMonths, compareYearMonths, getMonthsBetween, type BudgetTransfer } from '@/lib/projection';
import { calculatePerDiem } from './per-diem-utils';

export interface ExpandedBudgetLine {
  lineId: string;
  name: string;
  category: string;
  amount: number;
}

export interface FundingReceipt {
  sourceId: string;
  amount: number; // usable amount only (restricted surplus never arrives as cash the user can keep)
}

export interface FundingSourceAllocation {
  sourceId: string;
  name: string;
  type: BudgetFundingSource['type'];
  restricted: boolean;
  total: number;
  usable: number; // = total for unrestricted sources
  unusableSurplus: number; // restricted only — money the grant can't legally pay out
  allocatedByCategory: Record<string, number>;
}

export interface CategoryCoverage {
  category: string;
  plannedCost: number;
  covered: number; // total allocated from all funding sources
  ownMoney: number; // plannedCost − covered
}

export interface FundingAllocation {
  perSource: FundingSourceAllocation[];
  perCategoryCoverage: CategoryCoverage[];
  restrictedAllocatedTotal: number;
  unrestrictedTotal: number;
}

export interface BudgetMonthRow {
  yearMonth: YearMonth;
  plannedCosts: number;
  costsByCategory: Record<string, number>;
  fundingReceived: number;
  net: number;
  cumulativeNet: number;
}

export interface BudgetFeasibility {
  totalCosts: number;
  totalFunding: number; // face value of all sources
  usableFunding: number; // restricted-allocated + unrestricted total
  unusableSurplus: number;
  outOfPocket: number; // max(0, totalCosts − usableFunding)
  freeSurplus: number; // max(0, usableFunding − totalCosts) — unrestricted spare only
  allocation: FundingAllocation;
  perMonth: BudgetMonthRow[];
}

export interface CategoryActuals {
  category: string;
  planned: number;
  actual: number;
  delta: number; // actual − planned (positive = over budget)
}

export interface FundingSourceActuals {
  sourceId: string;
  name: string;
  usable: number;
  claimed: number; // sum of expense entries tagged to this source
  overClaimed: number; // max(0, claimed − usable)
}

export interface BudgetActualsRollup {
  perCategory: CategoryActuals[];
  perSource: FundingSourceActuals[];
  totalPlanned: number;
  totalActual: number;
}

function isRestricted(source: BudgetFundingSource): boolean {
  return !!source.restrictedToCategories && source.restrictedToCategories.length > 0;
}

function clampMonth(month: YearMonth, start: YearMonth, end: YearMonth): YearMonth {
  if (compareYearMonths(month, start) < 0) return start;
  if (compareYearMonths(month, end) > 0) return end;
  return month;
}

/** All months of the budget period, inclusive (empty if the period is inverted). */
export function getBudgetMonths(budget: Budget): YearMonth[] {
  const months: YearMonth[] = [];
  let current = budget.startMonth;
  while (compareYearMonths(current, budget.endMonth) <= 0) {
    months.push(current);
    current = addMonths(current, 1);
  }
  return months;
}

export function calcPerDiemTotal(rate: number, days: number): number {
  return rate * days;
}

/** Expand budget lines into per-month cost items, clamped to the budget period. */
export function expandBudgetLines(budget: Budget): Map<YearMonth, ExpandedBudgetLine[]> {
  const byMonth = new Map<YearMonth, ExpandedBudgetLine[]>();
  const months = getBudgetMonths(budget);
  if (months.length === 0) return byMonth;

  const push = (month: YearMonth, line: ExpandedBudgetLine) => {
    const existing = byMonth.get(month);
    if (existing) existing.push(line);
    else byMonth.set(month, [line]);
  };

  for (const line of budget.lines) {
    const expanded = { lineId: line.id, name: line.name, category: line.category, amount: line.amount };
    if (line.kind === 'one-off') {
      push(clampMonth(line.month ?? budget.startMonth, budget.startMonth, budget.endMonth), expanded);
    } else {
      const start = clampMonth(line.startMonth ?? budget.startMonth, budget.startMonth, budget.endMonth);
      const end = clampMonth(line.endMonth ?? budget.endMonth, budget.startMonth, budget.endMonth);
      let current = start;
      while (compareYearMonths(current, end) <= 0) {
        push(current, expanded);
        current = addMonths(current, 1);
      }
    }
  }

  return byMonth;
}

/** Total planned cost per category over the whole period. */
export function getPlannedCostByCategory(budget: Budget): Record<string, number> {
  const byCategory: Record<string, number> = {};
  for (const lines of expandBudgetLines(budget).values()) {
    for (const line of lines) {
      byCategory[line.category] = (byCategory[line.category] || 0) + line.amount;
    }
  }
  return byCategory;
}

/**
 * Allocate funding sources to planned costs. Deterministic greedy:
 * restricted sources first (most constrained first, ties by list order), each
 * walking its allowed categories by descending uncovered cost; what remains of
 * a restricted source is unusable surplus — it can never pay other categories
 * and is never netted against out-of-pocket. Unrestricted sources then fill
 * the remaining uncovered costs the same way; their surplus stays usable.
 *
 * Not provably optimal for pathological overlapping restrictions (that would
 * be a max-flow problem), but deterministic, explainable in one sentence, and
 * correct for realistic grant setups.
 */
export function allocateFunding(budget: Budget): FundingAllocation {
  const plannedByCategory = getPlannedCostByCategory(budget);
  const remaining: Record<string, number> = { ...plannedByCategory };

  const allocateGreedy = (
    amount: number,
    allowedCategories: string[] | null // null = any category
  ): { allocatedByCategory: Record<string, number>; leftover: number } => {
    const allocatedByCategory: Record<string, number> = {};
    let left = amount;
    const candidates = (allowedCategories ?? Object.keys(remaining))
      .filter(c => (remaining[c] || 0) > 0)
      .sort((a, b) => (remaining[b] - remaining[a]) || a.localeCompare(b));
    for (const category of candidates) {
      if (left <= 0) break;
      const take = Math.min(left, remaining[category]);
      if (take <= 0) continue;
      allocatedByCategory[category] = take;
      remaining[category] -= take;
      left -= take;
    }
    return { allocatedByCategory, leftover: left };
  };

  const restrictedSources = budget.fundingSources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => isRestricted(source))
    .sort((a, b) => (a.source.restrictedToCategories!.length - b.source.restrictedToCategories!.length) || (a.index - b.index));
  const unrestrictedSources = budget.fundingSources.filter(s => !isRestricted(s));

  const perSource: FundingSourceAllocation[] = [];

  for (const { source } of restrictedSources) {
    const { allocatedByCategory, leftover } = allocateGreedy(source.amount, source.restrictedToCategories!);
    perSource.push({
      sourceId: source.id,
      name: source.name,
      type: source.type,
      restricted: true,
      total: source.amount,
      usable: source.amount - leftover,
      unusableSurplus: leftover,
      allocatedByCategory,
    });
  }

  for (const source of unrestrictedSources) {
    const { allocatedByCategory } = allocateGreedy(source.amount, null);
    perSource.push({
      sourceId: source.id,
      name: source.name,
      type: source.type,
      restricted: false,
      total: source.amount,
      usable: source.amount, // unrestricted money is hers even when not consumed by a cost
      unusableSurplus: 0,
      allocatedByCategory,
    });
  }

  // Restore the original source order for display
  const orderById = new Map(budget.fundingSources.map((s, i) => [s.id, i]));
  perSource.sort((a, b) => (orderById.get(a.sourceId) ?? 0) - (orderById.get(b.sourceId) ?? 0));

  const perCategoryCoverage: CategoryCoverage[] = Object.keys(plannedByCategory)
    .sort((a, b) => plannedByCategory[b] - plannedByCategory[a] || a.localeCompare(b))
    .map(category => {
      const plannedCost = plannedByCategory[category];
      const ownMoney = remaining[category] || 0;
      return { category, plannedCost, covered: plannedCost - ownMoney, ownMoney };
    });

  return {
    perSource,
    perCategoryCoverage,
    restrictedAllocatedTotal: perSource.filter(s => s.restricted).reduce((sum, s) => sum + s.usable, 0),
    unrestrictedTotal: perSource.filter(s => !s.restricted).reduce((sum, s) => sum + s.total, 0),
  };
}

/**
 * When each source's usable money arrives, clamped to the budget period.
 * upfront → everything in the first month; monthly → an even split across the
 * period; specific-month → that month (clamped into the period).
 */
export function expandFundingReceipts(
  budget: Budget,
  allocation: FundingAllocation = allocateFunding(budget)
): Map<YearMonth, FundingReceipt[]> {
  const byMonth = new Map<YearMonth, FundingReceipt[]>();
  const months = getBudgetMonths(budget);
  if (months.length === 0) return byMonth;

  const usableById = new Map(allocation.perSource.map(s => [s.sourceId, s.usable]));

  const push = (month: YearMonth, receipt: FundingReceipt) => {
    if (receipt.amount <= 0) return;
    const existing = byMonth.get(month);
    if (existing) existing.push(receipt);
    else byMonth.set(month, [receipt]);
  };

  for (const source of budget.fundingSources) {
    const usable = usableById.get(source.id) ?? source.amount;
    if (source.timing === 'monthly') {
      const perMonth = usable / months.length;
      for (const month of months) {
        push(month, { sourceId: source.id, amount: perMonth });
      }
    } else if (source.timing === 'specific-month') {
      const month = clampMonth(source.receivedMonth ?? budget.startMonth, budget.startMonth, budget.endMonth);
      push(month, { sourceId: source.id, amount: usable });
    } else {
      push(budget.startMonth, { sourceId: source.id, amount: usable });
    }
  }

  return byMonth;
}

/** The headline numbers and per-month flow behind the budget's verdict. */
export function computeFeasibility(budget: Budget): BudgetFeasibility {
  const allocation = allocateFunding(budget);
  const linesByMonth = expandBudgetLines(budget);
  const receiptsByMonth = expandFundingReceipts(budget, allocation);

  let cumulativeNet = 0;
  const perMonth: BudgetMonthRow[] = getBudgetMonths(budget).map(yearMonth => {
    const lines = linesByMonth.get(yearMonth) || [];
    const costsByCategory: Record<string, number> = {};
    for (const line of lines) {
      costsByCategory[line.category] = (costsByCategory[line.category] || 0) + line.amount;
    }
    const plannedCosts = lines.reduce((sum, l) => sum + l.amount, 0);
    const fundingReceived = (receiptsByMonth.get(yearMonth) || []).reduce((sum, r) => sum + r.amount, 0);
    const net = fundingReceived - plannedCosts;
    cumulativeNet += net;
    return { yearMonth, plannedCosts, costsByCategory, fundingReceived, net, cumulativeNet };
  });

  const totalCosts = perMonth.reduce((sum, m) => sum + m.plannedCosts, 0);
  const totalFunding = budget.fundingSources.reduce((sum, s) => sum + s.amount, 0);
  const usableFunding = allocation.restrictedAllocatedTotal + allocation.unrestrictedTotal;
  const unusableSurplus = totalFunding - usableFunding;

  return {
    totalCosts,
    totalFunding,
    usableFunding,
    unusableSurplus,
    outOfPocket: Math.max(0, totalCosts - usableFunding),
    freeSurplus: Math.max(0, usableFunding - totalCosts),
    allocation,
    perMonth,
  };
}

/** Budget-vs-actual per category and per funding source, from the expense log.
 * Entries dated outside the period still count — real trips bleed at the edges. */
export function computeActualsRollup(budget: Budget): BudgetActualsRollup {
  const plannedByCategory = getPlannedCostByCategory(budget);
  const allocation = allocateFunding(budget);

  const actualByCategory: Record<string, number> = {};
  const claimedBySource: Record<string, number> = {};
  for (const entry of budget.expenseEntries) {
    actualByCategory[entry.category] = (actualByCategory[entry.category] || 0) + entry.amount;
    if (entry.fundingSourceId) {
      claimedBySource[entry.fundingSourceId] = (claimedBySource[entry.fundingSourceId] || 0) + entry.amount;
    }
  }

  const categories = Array.from(new Set([...Object.keys(plannedByCategory), ...Object.keys(actualByCategory)]));
  const perCategory: CategoryActuals[] = categories
    .map(category => {
      const planned = plannedByCategory[category] || 0;
      const actual = actualByCategory[category] || 0;
      return { category, planned, actual, delta: actual - planned };
    })
    .sort((a, b) => Math.max(b.planned, b.actual) - Math.max(a.planned, a.actual) || a.category.localeCompare(b.category));

  const perSource: FundingSourceActuals[] = allocation.perSource.map(s => {
    const claimed = claimedBySource[s.sourceId] || 0;
    return { sourceId: s.sourceId, name: s.name, usable: s.usable, claimed, overClaimed: Math.max(0, claimed - s.usable) };
  });

  return {
    perCategory,
    perSource,
    totalPlanned: Object.values(plannedByCategory).reduce((sum, v) => sum + v, 0),
    totalActual: budget.expenseEntries.reduce((sum, e) => sum + e.amount, 0),
  };
}

/**
 * The per-month lines a confirmed budget injects into its linked account's
 * cashflow: one aggregated expense (planned costs) and one aggregated income
 * (usable funding received) per month, converted to the account's currency by
 * the budget's manual exchange rate when set.
 */
export function computeBudgetTransfers(budget: Budget): BudgetTransfer[] {
  const rate = budget.exchangeRate ?? 1;
  const allocation = allocateFunding(budget);
  const linesByMonth = expandBudgetLines(budget);
  const receiptsByMonth = expandFundingReceipts(budget, allocation);

  const transfers: BudgetTransfer[] = [];
  for (const yearMonth of getBudgetMonths(budget)) {
    const costs = (linesByMonth.get(yearMonth) || []).reduce((sum, l) => sum + l.amount, 0) * rate;
    const funding = (receiptsByMonth.get(yearMonth) || []).reduce((sum, r) => sum + r.amount, 0) * rate;
    if (costs > 0.005) {
      transfers.push({ yearMonth, budgetId: budget.id, budgetName: budget.name, amount: costs, direction: 'expense' });
    }
    if (funding > 0.005) {
      transfers.push({ yearMonth, budgetId: budget.id, budgetName: budget.name, amount: funding, direction: 'income' });
    }
  }
  return transfers;
}

/** True when the budget's period is entirely in the past relative to the given month. */
export function isBudgetPast(budget: Budget, currentYearMonth: YearMonth): boolean {
  return compareYearMonths(budget.endMonth, currentYearMonth) < 0;
}

// ============================================================
// TRIP-LINKED PER-DIEM FUNDING
// ============================================================

/**
 * Replace each trip-linked per-diem funding source's `amount` with the live
 * `calculatePerDiem(trip).total`. The stored amount is only a write-time
 * snapshot: when the linked trip is missing (deleted) it stands unchanged.
 * Fast path — a budget with no trip-linked source returns the SAME reference
 * (callers may rely on referential equality to skip work).
 */
export function hydrateBudgetFundingFromTrips(budget: Budget, trips: Trip[]): Budget {
  if (!budget.fundingSources.some(s => s.linkedTripId)) return budget;
  const tripById = new Map(trips.map(t => [t.id, t]));
  return {
    ...budget,
    fundingSources: budget.fundingSources.map(source => {
      if (!source.linkedTripId) return source;
      const trip = tripById.get(source.linkedTripId);
      if (!trip) return source; // deleted trip → keep the last stored snapshot
      return { ...source, amount: calculatePerDiem(trip).total };
    }),
  };
}

/**
 * Ids of trips whose per-diem already reaches cashflow through a budget:
 * confirmed, not archived, with a `linkedAccountId`, and a funding source
 * carrying a `linkedTripId`. Those trips must NOT also inject their own
 * `source: 'trip'` reimbursement income (double count) — the budget's
 * funding-income line already covers them. Deliberately account-independent:
 * once the money reaches cashflow via a budget anywhere, the trip stops
 * injecting regardless of which account each one points at.
 */
export function tripIdsFundedByActiveBudgets(budgets: Budget[]): Set<string> {
  const ids = new Set<string>();
  for (const budget of budgets) {
    if (budget.status !== 'confirmed' || budget.isArchived || !budget.linkedAccountId) continue;
    for (const source of budget.fundingSources) {
      if (source.linkedTripId) ids.add(source.linkedTripId);
    }
  }
  return ids;
}

// ============================================================
// LINKED SPLIT GROUP (read-time view — never copied into the budget doc)
// ============================================================

/**
 * Split category → budget category. Anything unmapped falls back to 'Other'.
 * Keys are the SPLIT_CATEGORIES strings; values come from BUDGET_CATEGORIES.
 */
const SPLIT_TO_BUDGET_CATEGORY: Record<string, string> = {
  Groceries: 'Food',
  'Dining out': 'Food',
  Liquor: 'Food',
  Rent: 'Accommodation',
  Mortgage: 'Accommodation',
  Hotel: 'Accommodation',
  Transport: 'Local transport',
  'Bus/train': 'Local transport',
  Taxi: 'Local transport',
  Car: 'Local transport',
  Fuel: 'Local transport',
  Parking: 'Local transport',
  Plane: 'Travel',
  Travel: 'Travel',
  Insurance: 'Insurance',
  'Household supplies': 'Equipment',
  Furniture: 'Equipment',
  Electronics: 'Equipment',
};

export function mapSplitCategoryToBudgetCategory(splitCategory: string): string {
  return SPLIT_TO_BUDGET_CATEGORY[splitCategory] ?? 'Other';
}

/**
 * The viewer's COST SHARE of a split row, in integer cents (their consumed
 * amount, regardless of who fronted the money).
 *
 * Rule (net convention: net > 0 ⇒ owed, net < 0 ⇒ owes):
 * - Settle-up payments are money transfers, not consumption ⇒ 0.
 * - Native expense rows carry full-fidelity `paidBy` shares, so the exact
 *   share is: consumed = paid − net (e.g. paid 100, net +50 ⇒ consumed 50).
 * - Imported rows only know per-member net, so we fall back to
 *   max(0, −net): correct whenever the viewer didn't pay; if the viewer
 *   partly paid an imported row their share is under-reported (best effort —
 *   the import format simply doesn't carry the information).
 */
export function computeViewerShareCents(row: SplitExpense, userId: string): number {
  if (row.kind === 'payment') return 0;
  const net = row.netByUserId[userId] ?? 0;
  if (row.paidBy) {
    const paid = row.paidBy.filter(s => s.userId === userId).reduce((sum, s) => sum + s.amountCents, 0);
    return Math.max(0, paid - net);
  }
  return Math.max(0, -net);
}

/** One display row of the read-only "From split group" section. */
export interface SplitBudgetEntry {
  id: string;
  date: string; // YYYY-MM-DD
  description: string;
  splitCategory: string;
  category: string; // mapped BUDGET_CATEGORIES value
  amount: number; // the viewer's share, in the budget's currency (not cents)
}

/**
 * Project the viewer's share of a linked split group's expenses into the
 * budget period. Computed at read time only — never persisted on the budget,
 * never fed into feasibility or cashflow injection. Rows outside the period,
 * with a mismatched currency, or where the viewer consumed nothing are skipped.
 */
export function buildSplitBudgetEntries(
  rows: SplitExpense[],
  userId: string,
  budget: Pick<Budget, 'startMonth' | 'endMonth' | 'currency'>
): { entries: SplitBudgetEntry[]; total: number } {
  const entries: SplitBudgetEntry[] = [];
  for (const row of rows) {
    if (row.kind !== 'expense') continue;
    if (row.currency !== budget.currency) continue; // defensive — the picker already guards this
    const month = row.date.slice(0, 7);
    if (month < budget.startMonth || month > budget.endMonth) continue;
    const shareCents = computeViewerShareCents(row, userId);
    if (shareCents <= 0) continue;
    entries.push({
      id: row.id,
      date: row.date,
      description: row.title,
      splitCategory: row.category,
      category: mapSplitCategoryToBudgetCategory(row.category),
      amount: shareCents / 100,
    });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return { entries, total: entries.reduce((sum, e) => sum + e.amount, 0) };
}

/** Number of calendar days in the budget period (for prefilling per-diem days). */
export function getBudgetPeriodDays(budget: Budget): number {
  const months = getMonthsBetween(budget.startMonth, budget.endMonth) + 1;
  if (months <= 0) return 0;
  // Approximate: count actual days of each calendar month in the period.
  let days = 0;
  let current = budget.startMonth;
  for (let i = 0; i < months; i++) {
    const [year, month] = current.split('-').map(n => parseInt(n, 10));
    days += new Date(year, month, 0).getDate();
    current = addMonths(current, 1);
  }
  return days;
}
