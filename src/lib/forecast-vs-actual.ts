/**
 * Forecast-vs-actual per category (pure, unit-tested).
 *
 * Joins one month's FORECAST expense breakdown (the projection) with its
 * ACTUAL breakdown (the bank retrospective) by category, and surfaces the
 * biggest deviations — turning the retrospective from a history view into a
 * feedback loop on the plan's accuracy.
 */

import type { ProjectionLineItem } from '@/types';

export interface CategoryDeviation {
  category: string;
  forecast: number;
  actual: number;
  /** actual − forecast; positive = spent more than planned. */
  delta: number;
}

function totalsByCategory(items: ProjectionLineItem[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    const cat = item.category || 'Uncategorized';
    map.set(cat, (map.get(cat) ?? 0) + item.amount);
  }
  return map;
}

/**
 * Compare a month's forecast expenses against its actuals, per category,
 * sorted by |delta| descending. Categories present on only one side count
 * against a 0 on the other. Deviations under `minDelta` (default 1) are
 * dropped — noise, not signal.
 */
export function compareForecastToActual(
  forecastExpenses: ProjectionLineItem[],
  actualExpenses: ProjectionLineItem[],
  minDelta = 1
): CategoryDeviation[] {
  const forecast = totalsByCategory(forecastExpenses);
  const actual = totalsByCategory(actualExpenses);
  const categories = new Set([...forecast.keys(), ...actual.keys()]);

  const out: CategoryDeviation[] = [];
  for (const category of categories) {
    const f = forecast.get(category) ?? 0;
    const a = actual.get(category) ?? 0;
    const delta = a - f;
    if (Math.abs(delta) < minDelta) continue;
    out.push({ category, forecast: f, actual: a, delta });
  }
  return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}
