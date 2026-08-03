import { describe, it, expect } from 'vitest';
import {
  comparePlanToActual,
  onPlanTolerance,
  pickDefaultView,
  summarizeMonthProgress,
} from './forecast-vs-actual';
import type { MonthlyProjection, ProjectionLineItem } from '@/types';

function li(
  name: string,
  amount: number,
  category?: string,
  extra: Partial<ProjectionLineItem> = {}
): ProjectionLineItem {
  return { itemId: name, name, amount, category, source: 'recurring', ...extra };
}

function month(expenseBreakdown: ProjectionLineItem[], isActualized = true): MonthlyProjection {
  return {
    yearMonth: '2026-08',
    year: 2026,
    month: 8,
    startingBalance: 0,
    totalIncome: 0,
    totalExpenses: 0,
    netChange: 0,
    endingBalance: 0,
    incomeBreakdown: [],
    expenseBreakdown,
    isActualized,
  };
}

describe('onPlanTolerance', () => {
  it('floors at 5 euros for small plans', () => {
    expect(onPlanTolerance(0)).toBe(5);
    expect(onPlanTolerance(100)).toBe(5);
    // 3% overtakes the floor above ~166.67
    expect(onPlanTolerance(166)).toBe(5);
  });

  it('uses 3% of the planned amount above the floor', () => {
    expect(onPlanTolerance(200)).toBeCloseTo(6);
    expect(onPlanTolerance(1000)).toBeCloseTo(30);
  });
});

describe('comparePlanToActual', () => {
  it('joins by category and keeps the item lists on both sides', () => {
    const planned = [li('Rent', 800, 'Housing'), li('Food budget', 400, 'Food & Groceries')];
    const actual = [
      li('Landlord', 800, 'Housing'),
      li('Supermarket', 300, 'Food & Groceries'),
      li('Corner shop', 220, 'Food & Groceries'),
    ];
    const out = comparePlanToActual(planned, actual);

    const food = out.find((c) => c.category === 'Food & Groceries')!;
    expect(food).toMatchObject({ planned: 400, actual: 520, delta: 120, status: 'over' });
    expect(food.plannedItems.map((i) => i.name)).toEqual(['Food budget']);
    expect(food.actualItems.map((i) => i.name)).toEqual(['Supermarket', 'Corner shop']);

    const housing = out.find((c) => c.category === 'Housing')!;
    expect(housing).toMatchObject({ delta: 0, status: 'on' });
    expect(housing.plannedItems).toHaveLength(1);
    expect(housing.actualItems).toHaveLength(1);
  });

  it('counts one-sided categories against zero', () => {
    const out = comparePlanToActual([li('Gym', 40, 'Entertainment')], [li('Pharmacy', 25, 'Healthcare')]);
    expect(out).toHaveLength(2);
    const gym = out.find((c) => c.category === 'Entertainment')!;
    expect(gym).toMatchObject({ planned: 40, actual: 0, delta: -40, status: 'under' });
    expect(gym.actualItems).toEqual([]);
    const pharmacy = out.find((c) => c.category === 'Healthcare')!;
    expect(pharmacy).toMatchObject({ planned: 0, actual: 25, delta: 25, status: 'over' });
    expect(pharmacy.plannedItems).toEqual([]);
  });

  it('buckets uncategorized items together', () => {
    const out = comparePlanToActual([li('Misc', 10)], [li('Stuff', 30)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category: 'Uncategorized', planned: 10, actual: 30, delta: 20 });
  });

  it('marks a category on plan when the drift is inside the tolerance', () => {
    // 800 planned → tolerance 24; a 15 euro overshoot is still "as planned".
    const out = comparePlanToActual([li('Rent', 800, 'Housing')], [li('Landlord', 815, 'Housing')]);
    expect(out[0]).toMatchObject({ delta: 15, status: 'on' });
  });

  it('flags a small category once it moves past the 5 euro floor', () => {
    const out = comparePlanToActual([li('Bus', 60, 'Transportation')], [li('HSL', 66, 'Transportation')]);
    expect(out[0].status).toBe('over');
  });

  it('sorts off-plan rows by |delta| first, then on-plan rows by planned desc', () => {
    const planned = [
      li('Rent', 1000, 'Housing'), // on plan, biggest planned
      li('Insurance', 500, 'Insurance'), // on plan
      li('Food', 400, 'Food & Groceries'), // over by 120
      li('Bus', 100, 'Transportation'), // under by 60
    ];
    const actual = [
      li('Landlord', 1000, 'Housing'),
      li('Insurer', 500, 'Insurance'),
      li('Groceries', 520, 'Food & Groceries'),
      li('HSL', 40, 'Transportation'),
    ];
    const out = comparePlanToActual(planned, actual);
    expect(out.map((c) => c.category)).toEqual([
      'Food & Groceries',
      'Transportation',
      'Housing',
      'Insurance',
    ]);
    expect(out.map((c) => c.status)).toEqual(['over', 'under', 'on', 'on']);
  });
});

describe('summarizeMonthProgress', () => {
  it('treats a line with no payment info as unpaid', () => {
    const out = summarizeMonthProgress([li('Rent', 800, 'Housing')]);
    expect(out).toEqual([
      {
        category: 'Housing',
        planned: 800,
        paidSoFar: 0,
        remaining: 800,
        items: [li('Rent', 800, 'Housing')],
      },
    ]);
  });

  it('counts a paid line in full', () => {
    const out = summarizeMonthProgress([li('Rent', 800, 'Housing', { isPaid: true, remainingAmount: 0 })]);
    expect(out[0]).toMatchObject({ planned: 800, paidSoFar: 800, remaining: 0 });
  });

  it('counts the paid part of a partially remaining line', () => {
    const out = summarizeMonthProgress([li('Food', 400, 'Food & Groceries', { remainingAmount: 150 })]);
    expect(out[0]).toMatchObject({ planned: 400, paidSoFar: 250, remaining: 150 });
  });

  it('clamps a remaining amount above the planned amount to zero paid', () => {
    const out = summarizeMonthProgress([li('Food', 400, 'Food & Groceries', { remainingAmount: 500 })]);
    expect(out[0]).toMatchObject({ planned: 400, paidSoFar: 0, remaining: 400 });
  });

  it('groups lines per category and sorts by planned descending', () => {
    const out = summarizeMonthProgress([
      li('Bus', 60, 'Transportation'),
      li('Supermarket', 300, 'Food & Groceries', { remainingAmount: 100 }),
      li('Corner shop', 100, 'Food & Groceries', { isPaid: true }),
      li('Rent', 800, 'Housing', { isPaid: true }),
      li('Misc', 20),
    ]);
    expect(out.map((c) => c.category)).toEqual([
      'Housing',
      'Food & Groceries',
      'Transportation',
      'Uncategorized',
    ]);
    const food = out.find((c) => c.category === 'Food & Groceries')!;
    expect(food).toMatchObject({ planned: 400, paidSoFar: 300, remaining: 100 });
    expect(food.items).toHaveLength(2);
  });
});

describe('pickDefaultView', () => {
  const unpaid = month([li('Rent', 800, 'Housing'), li('Food', 200, 'Food & Groceries')]);
  const mostlyPaid = month([
    li('Rent', 800, 'Housing', { isPaid: true }),
    li('Food', 200, 'Food & Groceries'),
  ]);

  it('prefers the closed month early in the month when nothing is paid yet', () => {
    expect(pickDefaultView(new Date(2026, 7, 3), unpaid, true)).toBe('last');
  });

  it('prefers the current month past the first week', () => {
    expect(pickDefaultView(new Date(2026, 7, 20), unpaid, true)).toBe('month');
  });

  it('prefers the current month early on when a meaningful share is already paid', () => {
    // 800 of 1000 planned = 80% paid on the 3rd.
    expect(pickDefaultView(new Date(2026, 7, 3), mostlyPaid, true)).toBe('month');
  });

  it('falls back to the closed month when the current month is not actualized', () => {
    expect(pickDefaultView(new Date(2026, 7, 20), month([li('Rent', 800, 'Housing')], false), true)).toBe('last');
    expect(pickDefaultView(new Date(2026, 7, 20), undefined, true)).toBe('last');
  });

  it('falls back to the current month when there is no closed month', () => {
    expect(pickDefaultView(new Date(2026, 7, 3), unpaid, false)).toBe('month');
    expect(pickDefaultView(new Date(2026, 7, 3), undefined, false)).toBe('month');
  });

  it('treats a zero-planned month as nothing paid', () => {
    expect(pickDefaultView(new Date(2026, 7, 3), month([]), true)).toBe('last');
  });
});
