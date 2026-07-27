import { describe, it, expect } from 'vitest';
import { compareForecastToActual } from './forecast-vs-actual';
import type { ProjectionLineItem } from '@/types';

function li(name: string, amount: number, category?: string): ProjectionLineItem {
  return { itemId: name, name, amount, category, source: 'recurring' } as ProjectionLineItem;
}

describe('compareForecastToActual', () => {
  it('joins by category and sorts by absolute deviation', () => {
    const forecast = [li('Rent', 800, 'Housing'), li('Food', 400, 'Food & Groceries'), li('Bus', 60, 'Transportation')];
    const actual = [li('Rent', 800, 'Housing'), li('Groceries', 520, 'Food & Groceries'), li('HSL', 65, 'Transportation')];
    const out = compareForecastToActual(forecast, actual);
    expect(out[0]).toMatchObject({ category: 'Food & Groceries', forecast: 400, actual: 520, delta: 120 });
    expect(out[1]).toMatchObject({ category: 'Transportation', delta: 5 });
    // Housing matched exactly → dropped (|delta| < 1)
    expect(out.find((d) => d.category === 'Housing')).toBeUndefined();
  });

  it('counts one-sided categories against zero', () => {
    const out = compareForecastToActual([li('Gym', 40, 'Entertainment')], [li('Pharmacy', 25, 'Healthcare')]);
    expect(out).toEqual([
      { category: 'Entertainment', forecast: 40, actual: 0, delta: -40 },
      { category: 'Healthcare', forecast: 0, actual: 25, delta: 25 },
    ]);
  });

  it('buckets uncategorized items together', () => {
    const out = compareForecastToActual([li('Misc', 10)], [li('Stuff', 30)]);
    expect(out).toEqual([{ category: 'Uncategorized', forecast: 10, actual: 30, delta: 20 }]);
  });
});
