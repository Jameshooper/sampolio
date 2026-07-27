import type { Goal, MonthlyProjection, WealthProjectionMonth, YearMonth } from '@/types';
import { compareYearMonths, getCurrentYearMonth, getMonthsBetween } from '@/lib/projection';

export interface GoalProgress {
  currentAmount: number;
  targetAmount: number;
  percentComplete: number;
  projectedAmountAtTarget: number | null;
  onTrack: boolean;
  projectedDate: string | null;
}

/** A single point in a "pool" of money a goal can draw against — an account
 * balance or the total net worth — at a given month. */
interface PoolPoint {
  yearMonth: YearMonth;
  value: number;
}

/** A pool's series: `nowValue`/`nowMonth` is the current reading (before this
 * month's activity), `monthly` is one point per projected month (the value
 * AFTER that month's activity) — mirrors the shape `calculateGoalProgress`
 * has always used (account: startingBalance "now" + endingBalance per month;
 * net worth: netWorth per month, reused as "now" too). */
interface PoolSeries {
  nowMonth: YearMonth | null;
  nowValue: number;
  monthly: PoolPoint[];
}

function buildAccountPoolSeries(monthly: MonthlyProjection[]): PoolSeries {
  if (monthly.length === 0) return { nowMonth: null, nowValue: 0, monthly: [] };
  return {
    nowMonth: monthly[0].yearMonth,
    nowValue: monthly[0].startingBalance,
    monthly: monthly.map((p) => ({ yearMonth: p.yearMonth, value: p.endingBalance })),
  };
}

function buildNetWorthPoolSeries(months: WealthProjectionMonth[]): PoolSeries {
  if (months.length === 0) return { nowMonth: null, nowValue: 0, monthly: [] };
  return {
    nowMonth: months[0].yearMonth,
    nowValue: months[0].netWorth,
    monthly: months.map((p) => ({ yearMonth: p.yearMonth, value: p.netWorth })),
  };
}

/** Shared evaluation: current amount, projected amount at target date, first
 * month the series crosses the target, percent complete (clamped [0,100]),
 * and on-track. Used both by plain `calculateGoalProgress` (no adjustment)
 * and `computeGoalPlan` (claims-adjusted series). */
function progressFromSeries(targetAmount: number, targetDate: string | undefined, series: PoolSeries): GoalProgress {
  const currentAmount = series.nowValue;
  let projectedAmountAtTarget: number | null = null;
  if (targetDate) {
    const targetPoint = series.monthly.find((p) => p.yearMonth === targetDate);
    if (targetPoint) projectedAmountAtTarget = targetPoint.value;
  }

  const hitPoint = series.monthly.find((p) => p.value >= targetAmount);
  const projectedDate = hitPoint ? hitPoint.yearMonth : null;

  const percentComplete = Math.min(100, Math.max(0, (currentAmount / targetAmount) * 100));
  const onTrack = projectedAmountAtTarget !== null
    ? projectedAmountAtTarget >= targetAmount
    : percentComplete >= 100;

  return { currentAmount, targetAmount, percentComplete, projectedAmountAtTarget, onTrack, projectedDate };
}

/**
 * Calculate progress toward a financial goal.
 *
 * @param goal - The goal to evaluate
 * @param cashProjections - Map of accountId -> monthly projections (for account-balance goals)
 * @param wealthProjections - Wealth projection months (for net-worth goals)
 */
export function calculateGoalProgress(
  goal: Goal,
  cashProjections?: Map<string, MonthlyProjection[]>,
  wealthProjections?: WealthProjectionMonth[]
): GoalProgress {
  if (goal.trackingMethod === 'manual') {
    const currentAmount = goal.currentManualAmount ?? 0;
    const percentComplete = Math.min(100, Math.max(0, (currentAmount / goal.targetAmount) * 100));
    return {
      currentAmount,
      targetAmount: goal.targetAmount,
      percentComplete,
      projectedAmountAtTarget: null,
      onTrack: percentComplete >= 100,
      projectedDate: null,
    };
  }

  if (goal.trackingMethod === 'account-balance') {
    const monthly = (goal.linkedAccountId && cashProjections?.get(goal.linkedAccountId)) || [];
    return progressFromSeries(goal.targetAmount, goal.targetDate, buildAccountPoolSeries(monthly));
  }

  // net-worth
  return progressFromSeries(goal.targetAmount, goal.targetDate, buildNetWorthPoolSeries(wealthProjections ?? []));
}

/**
 * Whether a goal's target amount should be injected as a read-only expense
 * line in its linked account's cashflow projection at the target month (see
 * `getGoalTransfersForAccount` in `src/lib/projection-inputs.ts`). This is
 * THE single predicate for that decision — shared by the projection input
 * gatherer and the goal-plan engine below.
 */
export function goalInjectsIntoCashflow(goal: Goal): boolean {
  return (
    (goal.goalType ?? 'reserve') === 'spend' &&
    !!goal.injectIntoCashflow &&
    !!goal.targetDate &&
    goal.trackingMethod === 'account-balance' &&
    !!goal.linkedAccountId &&
    !goal.isArchived
  );
}

/**
 * Ordering for the joint goal-funding plan: lower `priority` funds first,
 * then earlier `targetDate` (undated goals sort last), then name.
 */
export function compareGoalsForPlan(a: Goal, b: Goal): number {
  const ap = a.priority ?? Infinity;
  const bp = b.priority ?? Infinity;
  if (ap !== bp) return ap - bp;
  const ad = a.targetDate ?? '9999-99';
  const bd = b.targetDate ?? '9999-99';
  if (ad !== bd) return ad < bd ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export interface GoalPlanEntry {
  goal: Goal;
  progress: GoalProgress;
  planIndex: number;
  /** Ids of earlier goals (in plan order) sharing at least one pool with this goal. */
  competingGoalIds: string[];
  /** Sum of earlier goals' claims against this goal's pool, at "now". */
  claimedAheadNow: number;
  requiredMonthlySaving: number | null;
  targetDatePassed: boolean;
  injects: boolean;
}

/** The constant monthly amount a goal claims (reserves) from its pool at a
 * given month: its full target amount, except an injecting goal releases its
 * claim from its target month onward (the expense line has already removed
 * the money from the projection by then — the "double-claim guard"). */
function claimAmountAt(goal: Goal, injects: boolean, month: YearMonth): number {
  if (!injects) return goal.targetAmount;
  return compareYearMonths(month, goal.targetDate!) < 0 ? goal.targetAmount : 0;
}

function monthsOf(series: PoolSeries): YearMonth[] {
  const months = new Set<YearMonth>();
  if (series.nowMonth) months.add(series.nowMonth);
  for (const p of series.monthly) months.add(p.yearMonth);
  return Array.from(months);
}

/** Subtract a claims ledger from a raw pool series, month by month, and
 * (for an injecting goal evaluating itself) add its own injection back so
 * feasibility is measured against the pre-spend balance. */
function adjustSeries(
  series: PoolSeries,
  ledger: Map<YearMonth, number>,
  selfAddBack: { targetDate: string; targetAmount: number } | null
): PoolSeries {
  if (series.nowMonth === null) return series;
  const ledgerAt = (m: YearMonth) => ledger.get(m) ?? 0;
  const addBackAt = (m: YearMonth) =>
    selfAddBack && compareYearMonths(m, selfAddBack.targetDate) >= 0 ? selfAddBack.targetAmount : 0;
  return {
    nowMonth: series.nowMonth,
    nowValue: series.nowValue - ledgerAt(series.nowMonth) + addBackAt(series.nowMonth),
    monthly: series.monthly.map((p) => ({
      yearMonth: p.yearMonth,
      value: p.value - ledgerAt(p.yearMonth) + addBackAt(p.yearMonth),
    })),
  };
}

/** `max(0, targetAmount - currentAmount) / monthsUntil(targetDate)`, using
 * "now" as today's real calendar month (not the pool's anchor month, so it's
 * meaningful even for manual goals or goals with no pool data). Null when
 * there's no target date; null (not 0) once the target is already reached;
 * null + `targetDatePassed: true` when the target date is in the past. */
function computeRequiredMonthlySaving(
  goal: Goal,
  currentAmount: number
): { requiredMonthlySaving: number | null; targetDatePassed: boolean } {
  if (!goal.targetDate) return { requiredMonthlySaving: null, targetDatePassed: false };
  const nowMonth = getCurrentYearMonth();
  if (compareYearMonths(goal.targetDate, nowMonth) < 0) {
    return { requiredMonthlySaving: null, targetDatePassed: true };
  }
  if (currentAmount >= goal.targetAmount) {
    return { requiredMonthlySaving: null, targetDatePassed: false };
  }
  const months = Math.max(1, getMonthsBetween(nowMonth, goal.targetDate));
  return { requiredMonthlySaving: (goal.targetAmount - currentAmount) / months, targetDatePassed: false };
}

/**
 * Compute a joint funding plan across ACTIVE goals that share money pools
 * (an account's balance, or total net worth). Goals are evaluated in
 * `compareGoalsForPlan` order; each goal's progress is measured against its
 * pool with earlier goals' claims already subtracted, so goals "queue up"
 * for the same money rather than every goal pretending it has the full
 * balance to itself. Manual goals are standalone (no pool, no claims).
 *
 * Pools:
 *  - An account-balance goal draws on (evaluates against) its linked
 *    account's pool.
 *  - A net-worth goal draws on the total net-worth pool.
 *  - EVERY non-manual goal's claim ALSO reduces the net-worth pool (account
 *    reservations are spoken-for wealth at the whole-net-worth level), so
 *    later net-worth goals see less headroom even though they don't touch
 *    any one account directly.
 *
 * @param goals ACTIVE goals only — the caller filters out archived goals.
 */
export function computeGoalPlan(
  goals: Goal[],
  cashProjections: Map<string, MonthlyProjection[]>,
  wealthProjections: WealthProjectionMonth[]
): { entries: GoalPlanEntry[] } {
  const sorted = [...goals].sort(compareGoalsForPlan);

  const netWorthSeries = buildNetWorthPoolSeries(wealthProjections);
  const accountSeriesCache = new Map<string, PoolSeries>();
  const getAccountSeries = (accountId: string): PoolSeries => {
    let s = accountSeriesCache.get(accountId);
    if (!s) {
      s = buildAccountPoolSeries(cashProjections.get(accountId) ?? []);
      accountSeriesCache.set(accountId, s);
    }
    return s;
  };

  const accountLedgers = new Map<string, Map<YearMonth, number>>();
  const netWorthLedger = new Map<YearMonth, number>();

  const entries: GoalPlanEntry[] = [];

  for (const goal of sorted) {
    const planIndex = entries.length;

    if (goal.trackingMethod === 'manual') {
      const progress = calculateGoalProgress(goal);
      const { requiredMonthlySaving, targetDatePassed } = computeRequiredMonthlySaving(goal, progress.currentAmount);
      entries.push({
        goal,
        progress,
        planIndex,
        competingGoalIds: [],
        claimedAheadNow: 0,
        requiredMonthlySaving,
        targetDatePassed,
        injects: false,
      });
      continue;
    }

    const injects = goalInjectsIntoCashflow(goal);
    const isAccountGoal = goal.trackingMethod === 'account-balance';

    const rawSeries = isAccountGoal
      ? (goal.linkedAccountId ? getAccountSeries(goal.linkedAccountId) : { nowMonth: null, nowValue: 0, monthly: [] })
      : netWorthSeries;

    let ledger: Map<YearMonth, number>;
    let competingGoalIds: string[];
    if (isAccountGoal) {
      const ledgerKey = goal.linkedAccountId ?? `__missing-account:${goal.id}`;
      ledger = accountLedgers.get(ledgerKey) ?? new Map();
      accountLedgers.set(ledgerKey, ledger);
      competingGoalIds = entries
        .filter((e) => e.goal.trackingMethod === 'account-balance' && e.goal.linkedAccountId === goal.linkedAccountId)
        .map((e) => e.goal.id);
    } else {
      ledger = netWorthLedger;
      competingGoalIds = entries.filter((e) => e.goal.trackingMethod !== 'manual').map((e) => e.goal.id);
    }

    const claimedAheadNow = rawSeries.nowMonth ? (ledger.get(rawSeries.nowMonth) ?? 0) : 0;

    const selfAddBack = injects && goal.targetDate
      ? { targetDate: goal.targetDate, targetAmount: goal.targetAmount }
      : null;
    const adjusted = adjustSeries(rawSeries, ledger, selfAddBack);
    const progress = progressFromSeries(goal.targetAmount, goal.targetDate, adjusted);
    const { requiredMonthlySaving, targetDatePassed } = computeRequiredMonthlySaving(goal, progress.currentAmount);

    entries.push({ goal, progress, planIndex, competingGoalIds, claimedAheadNow, requiredMonthlySaving, targetDatePassed, injects });

    // Register this goal's own claim so LATER goals see reduced availability.
    for (const m of monthsOf(rawSeries)) {
      ledger.set(m, (ledger.get(m) ?? 0) + claimAmountAt(goal, injects, m));
    }
    if (isAccountGoal) {
      const nwMonths = monthsOf(netWorthSeries.nowMonth !== null ? netWorthSeries : rawSeries);
      for (const m of nwMonths) {
        netWorthLedger.set(m, (netWorthLedger.get(m) ?? 0) + claimAmountAt(goal, injects, m));
      }
    }
  }

  return { entries };
}
