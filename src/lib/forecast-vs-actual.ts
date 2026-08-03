/**
 * Plan-vs-reality per category (pure, unit-tested).
 *
 * Two complementary views of the same question — "is my plan holding?":
 *
 *  1. `comparePlanToActual` joins a PLAN expense breakdown with an ACTUAL one
 *     (the bank retrospective) by category and labels each category over /
 *     under / on plan. Honest-baseline caveat: past forecasts are never
 *     persisted (projections are ephemeral), so a closed month is compared
 *     against the CURRENT month's plan — a fair stand-in, since it is dominated
 *     by the same recurring items. The UI says so.
 *  2. `summarizeMonthProgress` reads the current (actualized) month's own
 *     breakdown and reports how much of each category's plan the bank has
 *     already recorded as paid — progress, not judgment.
 *
 * `pickDefaultView` decides which of the two to open on: early in a month
 * there is nothing paid yet to look at, so the closed month is more useful.
 */

import type { MonthlyProjection, ProjectionLineItem } from '@/types';

export type PlanStatus = 'over' | 'under' | 'on';

export interface CategoryComparison {
  category: string;
  planned: number;
  actual: number;
  /** actual − planned; positive = spent more than planned. */
  delta: number;
  status: PlanStatus;
  plannedItems: ProjectionLineItem[];
  actualItems: ProjectionLineItem[];
}

/**
 * How far a category may drift before it counts as off plan: 3% of the planned
 * amount, never less than €5 (so small categories aren't flagged over noise).
 */
export function onPlanTolerance(planned: number): number {
  return Math.max(5, 0.03 * planned);
}

interface Bucket {
  total: number;
  items: ProjectionLineItem[];
}

function bucketByCategory(items: ProjectionLineItem[]): Map<string, Bucket> {
  const map = new Map<string, Bucket>();
  for (const item of items) {
    const cat = item.category || 'Uncategorized';
    const bucket = map.get(cat) ?? { total: 0, items: [] };
    bucket.total += item.amount;
    bucket.items.push(item);
    map.set(cat, bucket);
  }
  return map;
}

/**
 * Compare a month's planned expenses against its actuals, per category.
 * Categories present on only one side count against a 0 on the other. Ordering
 * puts what needs attention first: off-plan categories by |delta| descending,
 * then on-plan categories by planned amount descending.
 */
export function comparePlanToActual(
  planned: ProjectionLineItem[],
  actual: ProjectionLineItem[]
): CategoryComparison[] {
  const plannedBuckets = bucketByCategory(planned);
  const actualBuckets = bucketByCategory(actual);
  const categories = new Set([...plannedBuckets.keys(), ...actualBuckets.keys()]);

  const out: CategoryComparison[] = [];
  for (const category of categories) {
    const p = plannedBuckets.get(category);
    const a = actualBuckets.get(category);
    const plannedTotal = p?.total ?? 0;
    const actualTotal = a?.total ?? 0;
    const delta = actualTotal - plannedTotal;
    const status: PlanStatus =
      Math.abs(delta) < onPlanTolerance(plannedTotal) ? 'on' : delta > 0 ? 'over' : 'under';
    out.push({
      category,
      planned: plannedTotal,
      actual: actualTotal,
      delta,
      status,
      plannedItems: p?.items ?? [],
      actualItems: a?.items ?? [],
    });
  }

  return out.sort((x, y) => {
    const xOn = x.status === 'on';
    const yOn = y.status === 'on';
    if (xOn !== yOn) return xOn ? 1 : -1;
    if (xOn) return y.planned - x.planned;
    return Math.abs(y.delta) - Math.abs(x.delta);
  });
}

export interface CategoryProgress {
  category: string;
  planned: number;
  /** How much of the plan the bank has already recorded as paid. */
  paidSoFar: number;
  remaining: number;
  items: ProjectionLineItem[];
}

/** How much of a single planned line has already been paid. */
function paidOf(item: ProjectionLineItem): number {
  if (item.isPaid) return item.amount;
  const remaining = item.remainingAmount ?? item.amount;
  return Math.max(0, item.amount - remaining);
}

/**
 * Group a month's expense lines by category with planned / paid-so-far /
 * remaining totals, sorted by planned amount descending.
 */
export function summarizeMonthProgress(expenseLines: ProjectionLineItem[]): CategoryProgress[] {
  const map = new Map<string, CategoryProgress>();
  for (const item of expenseLines) {
    const category = item.category || 'Uncategorized';
    const entry = map.get(category) ?? { category, planned: 0, paidSoFar: 0, remaining: 0, items: [] };
    entry.planned += item.amount;
    entry.paidSoFar += paidOf(item);
    entry.items.push(item);
    map.set(category, entry);
  }
  const out = [...map.values()];
  for (const entry of out) entry.remaining = entry.planned - entry.paidSoFar;
  return out.sort((x, y) => y.planned - x.planned);
}

export type PlanCheckView = 'month' | 'last';

/**
 * Which view to open on. The current month is only interesting once something
 * has actually happened in it — past the first week, or once a meaningful share
 * of the plan is already paid. Otherwise the last closed month is the better
 * story (when there is one).
 */
export function pickDefaultView(
  today: Date,
  current: MonthlyProjection | undefined,
  hasLastMonth: boolean
): PlanCheckView {
  if (current?.isActualized) {
    const progress = summarizeMonthProgress(current.expenseBreakdown);
    const plannedTotal = progress.reduce((s, p) => s + p.planned, 0);
    const paidTotal = progress.reduce((s, p) => s + p.paidSoFar, 0);
    const paidShare = plannedTotal > 0 ? paidTotal / plannedTotal : 0;
    if (today.getDate() >= 8 || paidShare >= 0.15) return 'month';
  }
  return hasLastMonth ? 'last' : 'month';
}
