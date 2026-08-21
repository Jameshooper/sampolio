import type {
  YearMonth,
  FinancialAccount,
  RecurringItem,
  PlannedItem,
  TaxedIncome,
  MonthlyProjection,
  YearlyRollup,
  ProjectionLineItem,
  ProjectionFilters,
  Frequency,
  BalanceSnapshot
} from '@/types';
import type { ActualTxLike, ActualizableLine, ActualMatchPolicy } from '@/lib/current-month-actuals';
import { applyCurrentMonthActuals } from '@/lib/current-month-actuals';

/** A mortgage's monthly transfer for one month, injected into a cash account's
 * cashflow as a read-only expense line (see calculateProjection). */
export interface MortgageTransfer {
  yearMonth: YearMonth;
  mortgageId: string;
  mortgageName: string;
  amount: number;
}

/** A confirmed budget's aggregated flow for one month (planned costs out,
 * usable funding in), injected into its linked cash account's cashflow as
 * read-only lines (see calculateProjection). Amounts are already converted
 * to the account's currency via the budget's manual exchange rate. */
export interface BudgetTransfer {
  yearMonth: YearMonth;
  budgetId: string;
  budgetName: string;
  amount: number;
  direction: 'income' | 'expense';
}

/** A linked credit card's statement bill for one month, injected into the
 * paying cash account's cashflow as a read-only expense line (see
 * calculateProjection). The itemId is the bank-account link id so the UI can
 * deep-link to the card; an estimate (open cycle) is labeled as such. */
export interface CardBillTransfer {
  yearMonth: YearMonth;
  linkId: string;
  cardName: string;
  amount: number;
  isEstimate: boolean;
  /** 'statement' = closed statement (firm), 'open-cycle' = actuals-so-far +
   * pro-rata forecast, 'forecast' = flat estimate for a data-less future cycle.
   * Optional for safety; missing falls back to isEstimate-driven labeling. */
  basis?: 'statement' | 'open-cycle' | 'forecast';
}

/** A spend-goal's target amount for its target month, injected into the
 * linked account's cashflow as a read-only expense line (see
 * calculateProjection). Only goals passing `goalInjectsIntoCashflow`
 * (`src/lib/goal-utils.ts`) produce one of these. */
export interface GoalTransfer {
  yearMonth: YearMonth;
  goalId: string;
  goalName: string;
  amount: number;
}

/** A trip's expected tax-free per-diem reimbursement for its reimbursement
 * month, injected into the linked account's cashflow as a read-only income
 * line (see calculateProjection). Populated by `getTripTransfersForAccount`
 * (`src/lib/projection-inputs.ts`) from `calculatePerDiem` (`per-diem-utils.ts`). */
export interface TripTransfer {
  yearMonth: YearMonth;
  tripId: string;
  tripName: string;
  amount: number;
}

/**
 * Booked bank activity for the anchor (current) month of a bank-linked
 * account, used to reconcile forecast lines against what's already happened
 * (see calculateProjection's `currentMonthActuals` param and
 * `src/lib/current-month-actuals.ts`).
 */
export interface CurrentMonthActuals {
  /** Booked transactions dated within the anchor month, from the account's linked (non-excluded) cash/savings bank accounts. */
  transactions: ActualTxLike[];
}

// Year-Month utility functions
export function parseYearMonth(yearMonth: YearMonth): { year: number; month: number } {
  const [yearStr, monthStr] = yearMonth.split('-');
  return { year: parseInt(yearStr, 10), month: parseInt(monthStr, 10) };
}

export function formatYearMonth(year: number, month: number): YearMonth {
  return `${year}-${month.toString().padStart(2, '0')}`;
}

export function addMonths(yearMonth: YearMonth, months: number): YearMonth {
  const { year, month } = parseYearMonth(yearMonth);
  const totalMonths = year * 12 + (month - 1) + months;
  const newYear = Math.floor(totalMonths / 12);
  const newMonth = (totalMonths % 12) + 1;
  return formatYearMonth(newYear, newMonth);
}

export function compareYearMonths(a: YearMonth, b: YearMonth): number {
  return a.localeCompare(b);
}

export function isYearMonthInRange(
  yearMonth: YearMonth,
  startDate: YearMonth,
  endDate?: YearMonth
): boolean {
  if (compareYearMonths(yearMonth, startDate) < 0) {
    return false;
  }
  if (endDate && compareYearMonths(yearMonth, endDate) > 0) {
    return false;
  }
  return true;
}

export function getMonthsBetween(start: YearMonth, end: YearMonth): number {
  const startParsed = parseYearMonth(start);
  const endParsed = parseYearMonth(end);
  return (endParsed.year - startParsed.year) * 12 + (endParsed.month - startParsed.month);
}

// Get the interval in months for a given frequency
export function getIntervalMonths(frequency: Frequency, customIntervalMonths?: number): number {
  switch (frequency) {
    case 'monthly':
      return 1;
    case 'quarterly':
      return 3;
    case 'yearly':
      return 12;
    case 'custom':
      return customIntervalMonths || 1;
    default:
      return 1;
  }
}

// Check if a recurring item is active in a specific month
export function isRecurringItemActiveInMonth(
  item: RecurringItem,
  yearMonth: YearMonth
): boolean {
  if (!item.isActive) {
    return false;
  }

  if (!isYearMonthInRange(yearMonth, item.startDate, item.endDate)) {
    return false;
  }

  // For non-monthly frequencies, check if this is an occurrence month
  const intervalMonths = getIntervalMonths(item.frequency, item.customIntervalMonths);
  if (intervalMonths > 1) {
    const monthsSinceStart = getMonthsBetween(item.startDate, yearMonth);
    if (monthsSinceStart % intervalMonths !== 0) {
      return false;
    }
  }

  return true;
}

// Get all occurrences of a planned repeating item within a date range
export function getPlannedRepeatingOccurrences(
  item: PlannedItem,
  startDate: YearMonth,
  endDate: YearMonth
): YearMonth[] {
  if (item.kind !== 'repeating' || !item.firstOccurrence || !item.frequency) {
    return [];
  }

  const occurrences: YearMonth[] = [];
  const intervalMonths = getIntervalMonths(item.frequency, item.customIntervalMonths);
  let currentDate = item.firstOccurrence;

  // Move to first occurrence that's >= startDate
  while (compareYearMonths(currentDate, startDate) < 0) {
    currentDate = addMonths(currentDate, intervalMonths);
  }

  // Collect all occurrences until endDate or item's endDate
  while (compareYearMonths(currentDate, endDate) <= 0) {
    if (item.endDate && compareYearMonths(currentDate, item.endDate) > 0) {
      break;
    }
    occurrences.push(currentDate);
    currentDate = addMonths(currentDate, intervalMonths);
  }

  return occurrences;
}

/**
 * The effective starting point of a projection: either the entity's genesis
 * (e.g. an account's startingDate/startingBalance) or, when the entity has been
 * reconciled, its latest reconciliation snapshot (that month + actual balance).
 */
export interface ProjectionAnchor {
  startMonth: YearMonth;
  startBalance: number;
}

/**
 * Resolve the effective projection anchor. When a reconciliation snapshot exists
 * at or after the genesis month, the projection re-bases on the reconciled
 * balance for that month; otherwise it falls back to the genesis values.
 *
 * This is what keeps forecasts correct after a monthly check-in without the user
 * having to edit the account's start month — the latest confirmed balance becomes
 * the new starting point automatically.
 *
 * @param negate Debts store snapshot balances as negative values; pass true to
 *               convert back to the positive principal the engines expect.
 */
export function resolveAnchor(
  genesisMonth: YearMonth,
  genesisBalance: number,
  latestSnapshot?: BalanceSnapshot | null,
  negate = false
): ProjectionAnchor {
  if (latestSnapshot && compareYearMonths(latestSnapshot.yearMonth, genesisMonth) >= 0) {
    const balance = negate ? Math.abs(latestSnapshot.actualBalance) : latestSnapshot.actualBalance;
    return { startMonth: latestSnapshot.yearMonth, startBalance: balance };
  }
  return { startMonth: genesisMonth, startBalance: genesisBalance };
}

// Generate the list of months for projection
export function generateMonthList(
  account: FinancialAccount,
  anchor?: ProjectionAnchor
): YearMonth[] {
  const months: YearMonth[] = [];
  const startMonth = anchor?.startMonth ?? account.startingDate;
  let endDate: YearMonth;

  if (account.customEndDate) {
    endDate = account.customEndDate;
  } else {
    // Measure the horizon from the anchor so the forward window stays constant
    // after each check-in (a rolling horizon), rather than shrinking over time.
    endDate = addMonths(startMonth, account.planningHorizonMonths - 1);
  }

  let currentDate = startMonth;
  while (compareYearMonths(currentDate, endDate) <= 0) {
    months.push(currentDate);
    currentDate = addMonths(currentDate, 1);
  }

  return months;
}

// Calculate projection for a single account
export function calculateProjection(
  account: FinancialAccount,
  recurringItems: RecurringItem[],
  plannedItems: PlannedItem[],
  taxedIncomes: TaxedIncome[] = [],
  filters?: ProjectionFilters,
  latestSnapshot?: BalanceSnapshot | null,
  mortgageTransfers: MortgageTransfer[] = [],
  budgetTransfers: BudgetTransfer[] = [],
  cardBillTransfers: CardBillTransfer[] = [],
  currentMonthActuals?: CurrentMonthActuals | null,
  goalTransfers: GoalTransfer[] = [],
  tripTransfers: TripTransfer[] = []
): MonthlyProjection[] {
  const anchor = resolveAnchor(account.startingDate, account.startingBalance, latestSnapshot);
  const months = generateMonthList(account, anchor);
  const projections: MonthlyProjection[] = [];

  // Per-month mortgage transfers (this user's share of the bank charge), injected
  // as read-only expense lines. Computed by the mortgage engine, so they track
  // rate resets / reconciled actuals automatically.
  const transfersByMonth = new Map<YearMonth, MortgageTransfer[]>();
  for (const t of mortgageTransfers) {
    const existing = transfersByMonth.get(t.yearMonth);
    if (existing) existing.push(t);
    else transfersByMonth.set(t.yearMonth, [t]);
  }

  // Per-month budget transfers (confirmed trip/project budgets linked to this
  // account), injected as read-only lines. Computed by the budget engine.
  const budgetTransfersByMonth = new Map<YearMonth, BudgetTransfer[]>();
  for (const t of budgetTransfers) {
    const existing = budgetTransfersByMonth.get(t.yearMonth);
    if (existing) existing.push(t);
    else budgetTransfersByMonth.set(t.yearMonth, [t]);
  }

  // Per-month credit-card statement bills (linked cards paid from this account),
  // injected as read-only expense lines. Computed by the card-billing engine.
  const cardBillsByMonth = new Map<YearMonth, CardBillTransfer[]>();
  for (const t of cardBillTransfers) {
    const existing = cardBillsByMonth.get(t.yearMonth);
    if (existing) existing.push(t);
    else cardBillsByMonth.set(t.yearMonth, [t]);
  }

  // Per-month goal transfers (a spend-goal's target amount, in its target
  // month), injected as a read-only expense line. Computed by the goal engine.
  const goalTransfersByMonth = new Map<YearMonth, GoalTransfer[]>();
  for (const t of goalTransfers) {
    const existing = goalTransfersByMonth.get(t.yearMonth);
    if (existing) existing.push(t);
    else goalTransfersByMonth.set(t.yearMonth, [t]);
  }

  // Per-month trip transfers (an expected tax-free per-diem reimbursement, in
  // its reimbursement month), injected as a read-only income line. Computed
  // by the trip engine.
  const tripTransfersByMonth = new Map<YearMonth, TripTransfer[]>();
  for (const t of tripTransfers) {
    const existing = tripTransfersByMonth.get(t.yearMonth);
    if (existing) existing.push(t);
    else tripTransfersByMonth.set(t.yearMonth, [t]);
  }

  let runningBalance = anchor.startBalance;

  // Separate recurring-override PlannedItems from regular ones
  // Skip overrides older than 2 months before the projection start to keep the override map clean
  const overrideCutoff = months.length > 0 ? addMonths(months[0], -2) : getCurrentYearMonth();
  const overrideMap = new Map<string, Map<YearMonth, PlannedItem>>();
  const regularPlannedItems = plannedItems.filter(p => {
    if (p.isRecurringOverride && p.linkedRecurringItemId && p.scheduledDate) {
      // Skip expired overrides
      if (compareYearMonths(p.scheduledDate, overrideCutoff) < 0) {
        return false;
      }
      let itemOverrides = overrideMap.get(p.linkedRecurringItemId);
      if (!itemOverrides) {
        itemOverrides = new Map();
        overrideMap.set(p.linkedRecurringItemId, itemOverrides);
      }
      itemOverrides.set(p.scheduledDate, p);
      return false; // exclude from regular planned-item processing
    }
    return true;
  });

  // Build a map of one-off items by month
  const oneOffByMonth = new Map<YearMonth, PlannedItem[]>();
  for (const item of regularPlannedItems.filter(p => p.kind === 'one-off' && p.scheduledDate)) {
    const month = item.scheduledDate!;
    const existing = oneOffByMonth.get(month);
    if (existing) {
      existing.push(item);
    } else {
      oneOffByMonth.set(month, [item]);
    }
  }

  // Build a map of repeating items occurrences
  const repeatingItems = regularPlannedItems.filter(p => p.kind === 'repeating');
  const repeatingOccurrences = new Map<YearMonth, PlannedItem[]>();

  if (months.length > 0) {
    const projectionStart = months[0];
    const projectionEnd = months[months.length - 1];

    for (const item of repeatingItems) {
      const occurrences = getPlannedRepeatingOccurrences(item, projectionStart, projectionEnd);
      for (const occurrence of occurrences) {
        const existing = repeatingOccurrences.get(occurrence);
        if (existing) {
          existing.push(item);
        } else {
          repeatingOccurrences.set(occurrence, [item]);
        }
      }
    }
  }

  // Build reimbursement map: month -> items expecting reimbursement in that month
  const reimbursementByMonth = new Map<YearMonth, { item: PlannedItem; effectiveAmount: number }[]>();
  for (const item of regularPlannedItems) {
    if (item.kind === 'one-off' && item.isReimbursable && item.reimbursementStatus === 'pending' && item.expectedReimbursementMonth) {
      const amount = item.isShared ? item.amount * (item.shareRatio ?? 0.5) : item.amount;
      const existing = reimbursementByMonth.get(item.expectedReimbursementMonth) || [];
      existing.push({ item, effectiveAmount: amount });
      reimbursementByMonth.set(item.expectedReimbursementMonth, existing);
    }
  }

  for (const yearMonth of months) {
    // Apply filters
    if (filters?.startDate && compareYearMonths(yearMonth, filters.startDate) < 0) {
      continue;
    }
    if (filters?.endDate && compareYearMonths(yearMonth, filters.endDate) > 0) {
      break;
    }

    const { year, month } = parseYearMonth(yearMonth);
    const incomeBreakdown: ProjectionLineItem[] = [];
    const expenseBreakdown: ProjectionLineItem[] = [];
    // Lines whose source item is flagged `isFixedAmount` — they downgrade from
    // the 'full' actualization policy to 'exact-only' (never gap-reduced by
    // other spend in their category). Keyed by object identity like
    // cardLinePolicy below, so this month's line objects are naturally distinct.
    const fixedAmountLines = new Set<ProjectionLineItem>();

    // Process recurring items
    for (const item of recurringItems) {
      if (!isRecurringItemActiveInMonth(item, yearMonth)) {
        continue;
      }

      // Check for an occurrence override
      const override = overrideMap.get(item.id)?.get(yearMonth);
      if (override?.skipOccurrence) {
        continue; // skip this occurrence entirely
      }

      // Apply category filter
      const effectiveCategory = override?.category ?? item.category;
      if (filters?.categories?.length && effectiveCategory && !filters.categories.includes(effectiveCategory)) {
        continue;
      }

      // Apply item type filter (override cannot change type)
      if (filters?.itemTypes?.length && !filters.itemTypes.includes(item.type)) {
        continue;
      }

      // Apply item kind filter
      if (filters?.itemKinds?.length && !filters.itemKinds.includes('recurring')) {
        continue;
      }

      const rawAmount = override?.amount ?? item.amount;
      const effectiveAmount = item.isShared ? rawAmount * (item.shareRatio ?? 0.5) : rawAmount;

      const lineItem: ProjectionLineItem = {
        itemId: item.id,
        name: override?.name ?? item.name,
        amount: effectiveAmount,
        category: effectiveCategory,
        source: 'recurring',
        isOverridden: !!override,
      };
      // The RECURRING item's flag governs even when an override supplies this
      // month's amount — an override inherits the parent item's fixedness.
      if (item.isFixedAmount) fixedAmountLines.add(lineItem);

      if (item.type === 'income') {
        incomeBreakdown.push(lineItem);
      } else {
        expenseBreakdown.push(lineItem);
      }
    }

    // Process one-off planned items for this month
    const oneOffsThisMonth = oneOffByMonth.get(yearMonth) || [];
    for (const item of oneOffsThisMonth) {
      // Apply category filter
      if (filters?.categories?.length && item.category && !filters.categories.includes(item.category)) {
        continue;
      }

      // Apply item type filter
      if (filters?.itemTypes?.length && !filters.itemTypes.includes(item.type)) {
        continue;
      }

      // Apply item kind filter
      if (filters?.itemKinds?.length && !filters.itemKinds.includes('one-off')) {
        continue;
      }

      const rawOneOffAmount = item.amount;
      const effectiveOneOffAmount = item.isShared ? rawOneOffAmount * (item.shareRatio ?? 0.5) : rawOneOffAmount;

      const lineItem: ProjectionLineItem = {
        itemId: item.id,
        name: item.name,
        amount: effectiveOneOffAmount,
        category: item.category,
        source: 'planned-one-off',
      };
      if (item.isFixedAmount) fixedAmountLines.add(lineItem);

      if (item.type === 'income') {
        incomeBreakdown.push(lineItem);
      } else {
        expenseBreakdown.push(lineItem);
      }

    }

    // Process repeating planned items for this month
    const repeatingThisMonth = repeatingOccurrences.get(yearMonth) || [];
    for (const item of repeatingThisMonth) {
      // Apply category filter
      if (filters?.categories?.length && item.category && !filters.categories.includes(item.category)) {
        continue;
      }

      // Apply item type filter
      if (filters?.itemTypes?.length && !filters.itemTypes.includes(item.type)) {
        continue;
      }

      // Apply item kind filter
      if (filters?.itemKinds?.length && !filters.itemKinds.includes('repeating')) {
        continue;
      }

      const rawRepeatingAmount = item.amount;
      const effectiveRepeatingAmount = item.isShared ? rawRepeatingAmount * (item.shareRatio ?? 0.5) : rawRepeatingAmount;

      const lineItem: ProjectionLineItem = {
        itemId: item.id,
        name: item.name,
        amount: effectiveRepeatingAmount,
        category: item.category,
        source: 'planned-repeating',
      };
      if (item.isFixedAmount) fixedAmountLines.add(lineItem);

      if (item.type === 'income') {
        incomeBreakdown.push(lineItem);
      } else {
        expenseBreakdown.push(lineItem);
      }
    }

    // Process reimbursement income for this month
    const reimbursementsThisMonth = reimbursementByMonth.get(yearMonth) || [];
    for (const { item, effectiveAmount } of reimbursementsThisMonth) {
      incomeBreakdown.push({
        itemId: item.id,
        name: `Reimbursement: ${item.name}`,
        amount: effectiveAmount,
        category: 'Reimbursement',
        source: 'planned-one-off',
      });
    }

    // Process taxed income items
    for (const taxedIncome of taxedIncomes) {
      if (!taxedIncome.isActive) continue;

      let applies = false;
      if (taxedIncome.kind === 'one-off') {
        applies = taxedIncome.scheduledDate === yearMonth;
      } else {
        // Recurring taxed income - check frequency alignment
        const startDate = taxedIncome.startDate || taxedIncome.scheduledDate;
        if (!startDate || !taxedIncome.frequency) continue;

        if (!isYearMonthInRange(yearMonth, startDate, taxedIncome.endDate)) continue;

        // A month the user explicitly skipped (e.g. a year the holiday bonus
        // isn't paid). Recurring-only — one-offs never carry skips.
        if (taxedIncome.skippedOccurrences?.includes(yearMonth)) continue;

        const intervalMonths = getIntervalMonths(taxedIncome.frequency, taxedIncome.customIntervalMonths);
        if (intervalMonths > 1) {
          const monthsSinceStart = getMonthsBetween(startDate, yearMonth);
          if (monthsSinceStart % intervalMonths !== 0) continue;
        }
        applies = true;
      }

      if (!applies) continue;

      const lineItem: ProjectionLineItem = {
        itemId: taxedIncome.id,
        name: taxedIncome.name,
        amount: taxedIncome.netAmount,
        source: 'taxed-income',
      };

      incomeBreakdown.push(lineItem);
    }

    // Mortgage transfers — this user's monthly payment into the loan account,
    // computed by the mortgage engine. Read-only (edited on the mortgage page).
    const transfers = transfersByMonth.get(yearMonth);
    if (transfers) {
      for (const t of transfers) {
        if (t.amount <= 0.005) continue;
        expenseBreakdown.push({
          itemId: t.mortgageId,
          name: `Mortgage: ${t.mortgageName}`,
          amount: t.amount,
          category: 'Housing',
          source: 'mortgage-payment',
        });
      }
    }

    // Budget transfers — confirmed budgets linked to this account, aggregated
    // per budget per month. Read-only (edited on the budget's own page; the
    // itemId is the budgetId so the UI can deep-link to /budgets/{id}).
    const monthBudgetTransfers = budgetTransfersByMonth.get(yearMonth);
    if (monthBudgetTransfers) {
      for (const t of monthBudgetTransfers) {
        if (t.amount <= 0.005) continue;
        const lineItem: ProjectionLineItem = {
          itemId: t.budgetId,
          name: t.direction === 'expense' ? `Budget: ${t.budgetName}` : `Budget: ${t.budgetName} (funding)`,
          amount: t.amount,
          source: 'budget',
        };
        if (t.direction === 'expense') expenseBreakdown.push(lineItem);
        else incomeBreakdown.push(lineItem);
      }
    }

    // Credit-card bills — a linked card's statement balance billed to this
    // (paying) account on its payment-due month. Read-only (the card cycle is
    // configured in settings; the itemId is the bank-link id for deep-linking).
    // Tracks each pushed line's actualization policy (keyed by object identity)
    // since it depends on the bill's basis, which isn't otherwise recoverable
    // from the emitted ProjectionLineItem.
    const cardLinePolicy = new Map<ProjectionLineItem, ActualMatchPolicy>();
    const cardBills = cardBillsByMonth.get(yearMonth);
    if (cardBills) {
      for (const b of cardBills) {
        if (b.amount <= 0.005) continue;
        const basis = b.basis ?? (b.isEstimate ? 'forecast' : 'statement');
        const lineItem: ProjectionLineItem = {
          itemId: b.linkId,
          name:
            basis === 'statement'
              ? `Card: ${b.cardName}`
              : basis === 'open-cycle'
                ? `Card: ${b.cardName} (cycle in progress)`
                : `Card: ${b.cardName} (estimate)`,
          amount: b.amount,
          category: 'Credit cards',
          source: 'credit-card',
        };
        expenseBreakdown.push(lineItem);
        // Only a closed statement is firm enough to exact-match against a
        // booked payment; an open/forecast cycle isn't done accruing yet.
        cardLinePolicy.set(lineItem, basis === 'statement' ? 'exact-only' : 'none');
      }
    }

    // Goal transfers — a spend-goal's target amount in its target month,
    // injected as a read-only expense line (edited on /goals).
    const monthGoalTransfers = goalTransfersByMonth.get(yearMonth);
    if (monthGoalTransfers) {
      for (const t of monthGoalTransfers) {
        if (t.amount <= 0.005) continue;
        expenseBreakdown.push({
          itemId: t.goalId,
          name: `Goal: ${t.goalName}`,
          amount: t.amount,
          category: 'Goals',
          source: 'goal',
        });
      }
    }

    // Trip transfers — a trip's expected tax-free per-diem reimbursement in
    // its reimbursement month, injected as a read-only income line (edited on
    // /trips).
    const monthTripTransfers = tripTransfersByMonth.get(yearMonth);
    if (monthTripTransfers) {
      for (const t of monthTripTransfers) {
        if (t.amount <= 0.005) continue;
        incomeBreakdown.push({
          itemId: t.tripId,
          name: `Per diem: ${t.tripName}`,
          amount: t.amount,
          source: 'trip',
        });
      }
    }

    // For the anchor month of a bank-linked account, the anchor balance is the
    // LIVE synced balance — it already reflects everything paid so far this
    // month. Reconcile forecast lines against booked activity so only the
    // still-outstanding remainder is added on top, instead of double-counting.
    if (currentMonthActuals && currentMonthActuals.transactions.length > 0 && yearMonth === anchor.startMonth) {
      const actualizableLines: ActualizableLine[] = [
        ...incomeBreakdown.map((line): ActualizableLine => ({ line, type: 'income', policy: 'exact-only' })),
        ...expenseBreakdown.map((line): ActualizableLine => {
          let policy: ActualMatchPolicy;
          if (line.source === 'recurring' || line.source === 'planned-one-off' || line.source === 'planned-repeating') {
            // A fixed-amount bill is never an estimate: it is either paid in
            // full (exact match) or still fully outstanding — the category-gap
            // blend must neither reduce it nor count it in its denominator.
            policy = fixedAmountLines.has(line) ? 'exact-only' : 'full';
          } else if (line.source === 'mortgage-payment') {
            policy = 'exact-only';
          } else if (line.source === 'credit-card') {
            policy = cardLinePolicy.get(line) ?? 'none';
          } else {
            // 'budget', 'goal' and any other injected source: display-only, never actualized.
            policy = 'none';
          }
          return { line, type: 'expense', policy };
        }),
      ];

      const { lines: actualizedLines } = applyCurrentMonthActuals(actualizableLines, currentMonthActuals.transactions);

      const plannedTotalIncome = incomeBreakdown.reduce((sum, item) => sum + item.amount, 0);
      const plannedTotalExpenses = expenseBreakdown.reduce((sum, item) => sum + item.amount, 0);
      let remainingIncome = 0;
      let remainingExpenses = 0;
      for (let i = 0; i < actualizedLines.length; i++) {
        const { line, remainingAmount, isPaid, matchedTxId } = actualizedLines[i];
        line.remainingAmount = remainingAmount;
        line.isPaid = isPaid;
        if (matchedTxId) line.matchedTxId = matchedTxId;
        if (i < incomeBreakdown.length) {
          remainingIncome += remainingAmount;
        } else {
          remainingExpenses += remainingAmount;
        }
      }

      const netChange = remainingIncome - remainingExpenses;
      const startingBalance = runningBalance;
      const endingBalance = startingBalance + netChange;

      projections.push({
        yearMonth,
        year,
        month,
        startingBalance,
        totalIncome: remainingIncome,
        totalExpenses: remainingExpenses,
        netChange,
        endingBalance,
        incomeBreakdown,
        expenseBreakdown,
        isActualized: true,
        plannedTotalIncome,
        plannedTotalExpenses,
      });

      runningBalance = endingBalance;
      continue;
    }

    // Calculate totals
    const totalIncome = incomeBreakdown.reduce((sum, item) => sum + item.amount, 0);
    const totalExpenses = expenseBreakdown.reduce((sum, item) => sum + item.amount, 0);
    const netChange = totalIncome - totalExpenses;
    const startingBalance = runningBalance;
    const endingBalance = startingBalance + netChange;

    projections.push({
      yearMonth,
      year,
      month,
      startingBalance,
      totalIncome,
      totalExpenses,
      netChange,
      endingBalance,
      incomeBreakdown,
      expenseBreakdown,
    });

    // Update running balance for next month
    runningBalance = endingBalance;
  }

  return projections;
}

// Group monthly projections into yearly rollups
export function calculateYearlyRollups(
  monthlyProjections: MonthlyProjection[]
): YearlyRollup[] {
  const yearlyMap = new Map<number, MonthlyProjection[]>();

  for (const projection of monthlyProjections) {
    const existing = yearlyMap.get(projection.year);
    if (existing) {
      existing.push(projection);
    } else {
      yearlyMap.set(projection.year, [projection]);
    }
  }

  const rollups: YearlyRollup[] = [];

  for (const [year, months] of yearlyMap) {
    const sortedMonths = months.sort((a, b) => a.month - b.month);
    const totalIncome = sortedMonths.reduce((sum, m) => sum + m.totalIncome, 0);
    const totalExpenses = sortedMonths.reduce((sum, m) => sum + m.totalExpenses, 0);
    const netChange = totalIncome - totalExpenses;
    const startingBalance = sortedMonths[0].startingBalance;
    const endingBalance = sortedMonths[sortedMonths.length - 1].endingBalance;

    rollups.push({
      year,
      totalIncome,
      totalExpenses,
      netChange,
      startingBalance,
      endingBalance,
      months: sortedMonths,
    });
  }

  return rollups.sort((a, b) => a.year - b.year);
}

// Get current year-month
export function getCurrentYearMonth(): YearMonth {
  const now = new Date();
  return formatYearMonth(now.getFullYear(), now.getMonth() + 1);
}

// Get unique categories from items
export function getUniqueCategories(
  recurringItems: RecurringItem[],
  plannedItems: PlannedItem[]
): string[] {
  const categories = new Set<string>();

  for (const item of recurringItems) {
    if (item.category) {
      categories.add(item.category);
    }
  }

  for (const item of plannedItems) {
    if (item.category) {
      categories.add(item.category);
    }
  }

  return Array.from(categories).sort();
}
