import { describe, it, expect } from 'vitest';
import {
  getBudgetMonths,
  getBudgetPeriodDays,
  calcPerDiemTotal,
  expandBudgetLines,
  expandFundingReceipts,
  allocateFunding,
  computeFeasibility,
  computeActualsRollup,
  computeBudgetTransfers,
  isBudgetPast,
  mapSplitCategoryToBudgetCategory,
  computeViewerShareCents,
  buildSplitBudgetEntries,
  hydrateBudgetFundingFromTrips,
  tripIdsFundedByActiveBudgets,
} from './budget-utils';
import type { SplitExpenseItem, SplitPayment, Trip } from '@/types';
import { calculateProjection } from './projection';
import {
  createMockAccount,
  createMockBudget,
  createMockBudgetLine,
  createMockFundingSource,
  createMockBudgetExpenseEntry,
} from '@/test/mocks';

describe('getBudgetMonths', () => {
  it('returns all months of the period inclusive', () => {
    const budget = createMockBudget({ startMonth: '2026-03', endMonth: '2026-04' });
    expect(getBudgetMonths(budget)).toEqual(['2026-03', '2026-04']);
  });

  it('crosses a year boundary', () => {
    const budget = createMockBudget({ startMonth: '2026-11', endMonth: '2027-02' });
    expect(getBudgetMonths(budget)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });

  it('returns empty for an inverted period', () => {
    const budget = createMockBudget({ startMonth: '2026-05', endMonth: '2026-03' });
    expect(getBudgetMonths(budget)).toEqual([]);
  });
});

describe('per-diem helpers', () => {
  it('multiplies rate by days', () => {
    expect(calcPerDiemTotal(75, 61)).toBe(4575);
  });

  it('counts actual calendar days of the period (Mar + Apr = 61)', () => {
    const budget = createMockBudget({ startMonth: '2026-03', endMonth: '2026-04' });
    expect(getBudgetPeriodDays(budget)).toBe(61);
  });
});

describe('expandBudgetLines', () => {
  it('places a one-off line in its month only', () => {
    const budget = createMockBudget({
      lines: [createMockBudgetLine({ kind: 'one-off', month: '2026-04', name: 'Flights', amount: 300 })],
    });
    const byMonth = expandBudgetLines(budget);
    expect(byMonth.get('2026-03')).toBeUndefined();
    expect(byMonth.get('2026-04')).toHaveLength(1);
    expect(byMonth.get('2026-04')![0].amount).toBe(300);
  });

  it('clamps a one-off month outside the period into it', () => {
    const budget = createMockBudget({
      lines: [createMockBudgetLine({ kind: 'one-off', month: '2026-09', amount: 100 })],
    });
    expect(expandBudgetLines(budget).get('2026-04')![0].amount).toBe(100);
  });

  it('expands a monthly line across the full period by default', () => {
    const budget = createMockBudget({
      lines: [createMockBudgetLine({ kind: 'monthly', amount: 800 })],
    });
    const byMonth = expandBudgetLines(budget);
    expect(byMonth.get('2026-03')![0].amount).toBe(800);
    expect(byMonth.get('2026-04')![0].amount).toBe(800);
  });

  it('clamps a monthly sub-range to the period', () => {
    const budget = createMockBudget({
      startMonth: '2026-03',
      endMonth: '2026-06',
      lines: [createMockBudgetLine({ kind: 'monthly', startMonth: '2026-01', endMonth: '2026-04', amount: 500 })],
    });
    const byMonth = expandBudgetLines(budget);
    expect(byMonth.get('2026-03')).toBeDefined();
    expect(byMonth.get('2026-04')).toBeDefined();
    expect(byMonth.get('2026-05')).toBeUndefined();
  });
});

describe('expandFundingReceipts', () => {
  it('puts an upfront source entirely in the first month', () => {
    const budget = createMockBudget({
      lines: [createMockBudgetLine({ kind: 'monthly', category: 'Accommodation', amount: 1000 })],
      fundingSources: [createMockFundingSource({ amount: 2000, timing: 'upfront', restrictedToCategories: undefined })],
    });
    const receipts = expandFundingReceipts(budget);
    expect(receipts.get('2026-03')![0].amount).toBe(2000);
    expect(receipts.get('2026-04')).toBeUndefined();
  });

  it('splits a monthly source evenly and sums back to the total', () => {
    const budget = createMockBudget({
      startMonth: '2026-03',
      endMonth: '2026-05',
      fundingSources: [createMockFundingSource({ amount: 3000, timing: 'monthly', restrictedToCategories: undefined })],
    });
    const receipts = expandFundingReceipts(budget);
    const amounts = ['2026-03', '2026-04', '2026-05'].map(m => receipts.get(m)![0].amount);
    expect(amounts.every(a => Math.abs(a - 1000) < 1e-9)).toBe(true);
    expect(amounts.reduce((s, a) => s + a, 0)).toBeCloseTo(3000, 9);
  });

  it('clamps a specific-month receipt into the period', () => {
    const budget = createMockBudget({
      fundingSources: [
        createMockFundingSource({ amount: 500, timing: 'specific-month', receivedMonth: '2026-08', restrictedToCategories: undefined }),
      ],
    });
    expect(expandFundingReceipts(budget).get('2026-04')![0].amount).toBe(500);
  });

  it('only pays out the usable part of a restricted source', () => {
    // Grant of 2000 restricted to Accommodation, but only 1200 of accommodation cost exists.
    const budget = createMockBudget({
      lines: [createMockBudgetLine({ kind: 'one-off', month: '2026-03', category: 'Accommodation', amount: 1200 })],
      fundingSources: [createMockFundingSource({ amount: 2000, timing: 'upfront', restrictedToCategories: ['Accommodation'] })],
    });
    expect(expandFundingReceipts(budget).get('2026-03')![0].amount).toBe(1200);
  });
});

describe('allocateFunding', () => {
  it('consumes a restricted grant against its eligible categories only', () => {
    const budget = createMockBudget({
      lines: [
        createMockBudgetLine({ kind: 'one-off', month: '2026-03', category: 'Accommodation', amount: 1600 }),
        createMockBudgetLine({ kind: 'one-off', month: '2026-03', category: 'Food', amount: 900 }),
      ],
      fundingSources: [createMockFundingSource({ amount: 1000, restrictedToCategories: ['Accommodation'] })],
    });
    const allocation = allocateFunding(budget);
    expect(allocation.perSource[0].allocatedByCategory).toEqual({ Accommodation: 1000 });
    expect(allocation.perSource[0].unusableSurplus).toBe(0);
    const food = allocation.perCategoryCoverage.find(c => c.category === 'Food')!;
    expect(food.covered).toBe(0);
    expect(food.ownMoney).toBe(900);
  });

  it('reports restricted surplus as unusable, never paying other categories', () => {
    const budget = createMockBudget({
      lines: [
        createMockBudgetLine({ kind: 'one-off', month: '2026-03', category: 'Accommodation', amount: 500 }),
        createMockBudgetLine({ kind: 'one-off', month: '2026-03', category: 'Food', amount: 700 }),
      ],
      fundingSources: [createMockFundingSource({ amount: 2000, restrictedToCategories: ['Accommodation'] })],
    });
    const allocation = allocateFunding(budget);
    expect(allocation.perSource[0].usable).toBe(500);
    expect(allocation.perSource[0].unusableSurplus).toBe(1500);
    expect(allocation.perCategoryCoverage.find(c => c.category === 'Food')!.ownMoney).toBe(700);
  });

  it('marks a restricted grant with no eligible costs as fully unusable', () => {
    const budget = createMockBudget({
      lines: [createMockBudgetLine({ kind: 'one-off', month: '2026-03', category: 'Food', amount: 400 })],
      fundingSources: [createMockFundingSource({ amount: 1000, restrictedToCategories: ['Travel'] })],
    });
    const allocation = allocateFunding(budget);
    expect(allocation.perSource[0].usable).toBe(0);
    expect(allocation.perSource[0].unusableSurplus).toBe(1000);
  });

  it('allocates overlapping restricted grants most-constrained-first, deterministically', () => {
    // Grant A can pay Accommodation+Travel; grant B only Travel. Travel costs 800,
    // Accommodation 1000. B (more constrained) takes Travel first, leaving A free
    // to cover Accommodation — a naive in-order allocation would strand B.
    const grantA = createMockFundingSource({ name: 'A', amount: 1000, restrictedToCategories: ['Accommodation', 'Travel'] });
    const grantB = createMockFundingSource({ name: 'B', amount: 800, restrictedToCategories: ['Travel'] });
    const budget = createMockBudget({
      lines: [
        createMockBudgetLine({ kind: 'one-off', month: '2026-03', category: 'Accommodation', amount: 1000 }),
        createMockBudgetLine({ kind: 'one-off', month: '2026-03', category: 'Travel', amount: 800 }),
      ],
      fundingSources: [grantA, grantB],
    });
    const allocation = allocateFunding(budget);
    const a = allocation.perSource.find(s => s.name === 'A')!;
    const b = allocation.perSource.find(s => s.name === 'B')!;
    expect(b.allocatedByCategory).toEqual({ Travel: 800 });
    expect(a.allocatedByCategory).toEqual({ Accommodation: 1000 });
    expect(allocation.perCategoryCoverage.every(c => c.ownMoney === 0)).toBe(true);
  });

  it('keeps perSource in the original display order', () => {
    const budget = createMockBudget({
      lines: [createMockBudgetLine({ kind: 'one-off', month: '2026-03', category: 'Travel', amount: 100 })],
      fundingSources: [
        createMockFundingSource({ name: 'Unrestricted first', amount: 50, restrictedToCategories: undefined }),
        createMockFundingSource({ name: 'Restricted second', amount: 50, restrictedToCategories: ['Travel'] }),
      ],
    });
    expect(allocateFunding(budget).perSource.map(s => s.name)).toEqual(['Unrestricted first', 'Restricted second']);
  });
});

describe('computeFeasibility', () => {
  const mixedBudget = () =>
    createMockBudget({
      lines: [
        createMockBudgetLine({ kind: 'monthly', category: 'Accommodation', amount: 800 }), // 1600 over 2 months
        createMockBudgetLine({ kind: 'one-off', month: '2026-03', category: 'Travel', amount: 300 }),
        createMockBudgetLine({ kind: 'monthly', category: 'Food', amount: 450 }), // 900
      ],
      fundingSources: [
        createMockFundingSource({ name: 'Grant', amount: 2500, restrictedToCategories: ['Accommodation', 'Travel'], timing: 'upfront' }),
        createMockFundingSource({ name: 'Per diem', type: 'per-diem', amount: 600, restrictedToCategories: undefined, timing: 'monthly' }),
      ],
    });

  it('computes exact out-of-pocket with a restricted grant in the mix', () => {
    const f = computeFeasibility(mixedBudget());
    // Costs: 1600 + 300 + 900 = 2800. Grant covers Accommodation+Travel = 1900
    // (600 surplus unusable). Per diem 600 unrestricted. Usable = 2500.
    expect(f.totalCosts).toBe(2800);
    expect(f.totalFunding).toBe(3100);
    expect(f.usableFunding).toBe(2500);
    expect(f.unusableSurplus).toBe(600);
    expect(f.outOfPocket).toBe(300);
    expect(f.freeSurplus).toBe(0);
  });

  it('reports free surplus only when usable funding exceeds costs', () => {
    const budget = createMockBudget({
      lines: [createMockBudgetLine({ kind: 'one-off', month: '2026-03', category: 'Food', amount: 400 })],
      fundingSources: [createMockFundingSource({ amount: 1000, restrictedToCategories: undefined })],
    });
    const f = computeFeasibility(budget);
    expect(f.outOfPocket).toBe(0);
    expect(f.freeSurplus).toBe(600);
  });

  it('builds a cumulative per-month trajectory', () => {
    const f = computeFeasibility(mixedBudget());
    // March: costs 800+300+450 = 1550; funding = grant usable 1900 upfront + per diem 300 = 2200 → net +650
    // April: costs 800+450 = 1250; funding = per diem 300 → net −950 → cumulative −300
    expect(f.perMonth.map(m => m.yearMonth)).toEqual(['2026-03', '2026-04']);
    expect(f.perMonth[0].plannedCosts).toBe(1550);
    expect(f.perMonth[0].fundingReceived).toBeCloseTo(2200, 9);
    expect(f.perMonth[0].cumulativeNet).toBeCloseTo(650, 9);
    expect(f.perMonth[1].cumulativeNet).toBeCloseTo(-300, 9);
    // The final cumulative net reconciles with the headline figures.
    expect(f.perMonth[1].cumulativeNet).toBeCloseTo(f.usableFunding - f.totalCosts, 9);
  });

  it('tracks costs by category per month', () => {
    const f = computeFeasibility(mixedBudget());
    expect(f.perMonth[0].costsByCategory).toEqual({ Accommodation: 800, Travel: 300, Food: 450 });
  });
});

describe('computeBudgetTransfers', () => {
  it('emits expense and income transfers per month at face value without a rate', () => {
    const budget = createMockBudget({
      lines: [createMockBudgetLine({ kind: 'monthly', category: 'Accommodation', amount: 800 })],
      fundingSources: [createMockFundingSource({ amount: 1000, restrictedToCategories: undefined, timing: 'upfront' })],
    });
    const transfers = computeBudgetTransfers(budget);
    expect(transfers).toEqual([
      { yearMonth: '2026-03', budgetId: budget.id, budgetName: budget.name, amount: 800, direction: 'expense' },
      { yearMonth: '2026-03', budgetId: budget.id, budgetName: budget.name, amount: 1000, direction: 'income' },
      { yearMonth: '2026-04', budgetId: budget.id, budgetName: budget.name, amount: 800, direction: 'expense' },
    ]);
  });

  it('converts amounts with the manual exchange rate', () => {
    const budget = createMockBudget({
      exchangeRate: 0.088, // 1 SEK = 0.088 EUR
      lines: [createMockBudgetLine({ kind: 'one-off', month: '2026-03', amount: 1000 })],
    });
    const transfers = computeBudgetTransfers(budget);
    expect(transfers).toHaveLength(1);
    expect(transfers[0].amount).toBeCloseTo(88, 9);
  });

  it('excludes restricted unusable surplus from income transfers', () => {
    const budget = createMockBudget({
      lines: [createMockBudgetLine({ kind: 'one-off', month: '2026-03', category: 'Accommodation', amount: 500 })],
      fundingSources: [createMockFundingSource({ amount: 2000, restrictedToCategories: ['Accommodation'], timing: 'upfront' })],
    });
    const income = computeBudgetTransfers(budget).filter(t => t.direction === 'income');
    expect(income).toHaveLength(1);
    expect(income[0].amount).toBe(500);
  });

  it('skips negligible amounts', () => {
    const budget = createMockBudget({
      lines: [createMockBudgetLine({ kind: 'one-off', month: '2026-03', amount: 0.004 })],
    });
    expect(computeBudgetTransfers(budget)).toEqual([]);
  });
});

describe('computeActualsRollup', () => {
  it('computes per-category planned vs actual deltas', () => {
    const budget = createMockBudget({
      lines: [createMockBudgetLine({ kind: 'monthly', category: 'Food', amount: 250 })], // planned 500
      expenseEntries: [
        createMockBudgetExpenseEntry({ category: 'Food', amount: 380 }),
        createMockBudgetExpenseEntry({ category: 'Local transport', amount: 60 }),
      ],
    });
    const rollup = computeActualsRollup(budget);
    const food = rollup.perCategory.find(c => c.category === 'Food')!;
    expect(food.planned).toBe(500);
    expect(food.actual).toBe(380);
    expect(food.delta).toBe(-120);
    // Spending in an unplanned category surfaces rather than erroring.
    const transport = rollup.perCategory.find(c => c.category === 'Local transport')!;
    expect(transport.planned).toBe(0);
    expect(transport.actual).toBe(60);
    expect(rollup.totalActual).toBe(440);
  });

  it('counts entries dated outside the budget period', () => {
    const budget = createMockBudget({
      expenseEntries: [createMockBudgetExpenseEntry({ date: '2026-02-27', amount: 120 })],
    });
    expect(computeActualsRollup(budget).totalActual).toBe(120);
  });

  it('flags over-claiming against a funding source', () => {
    const source = createMockFundingSource({ amount: 300, restrictedToCategories: undefined });
    const budget = createMockBudget({
      fundingSources: [source],
      expenseEntries: [createMockBudgetExpenseEntry({ amount: 450, fundingSourceId: source.id })],
    });
    const sourceActuals = computeActualsRollup(budget).perSource.find(s => s.sourceId === source.id)!;
    expect(sourceActuals.claimed).toBe(450);
    expect(sourceActuals.overClaimed).toBe(150);
  });
});

describe('isBudgetPast', () => {
  it('is past only when the whole period is behind the given month', () => {
    const budget = createMockBudget({ startMonth: '2026-03', endMonth: '2026-04' });
    expect(isBudgetPast(budget, '2026-04')).toBe(false);
    expect(isBudgetPast(budget, '2026-05')).toBe(true);
  });
});

// ── Trip-linked per-diem funding ─────────────────────────────────────────────

// A 1-day domestic trip: exactly 24h → one full slice at the domestic full
// rate (54), so calculatePerDiem(trip).total === 54.
function mockTrip(over: Partial<Trip> = {}): Trip {
  return {
    id: 'trip-1',
    userId: 'test-user',
    name: 'Helsinki day trip',
    destinationCountry: 'FI',
    startDateTime: '2026-03-02T08:00',
    endDateTime: '2026-03-03T08:00',
    days: [{ date: '2026-03-02', countryCode: 'FI', freeMeals: 0 }],
    rates: { domesticFull: 54, domesticPartial: 25, defaultForeign: 52, countryRates: {} },
    linkedAccountId: 'acc-1',
    expectedReimbursementMonth: '2026-04',
    status: 'planned',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('hydrateBudgetFundingFromTrips', () => {
  it('replaces a trip-linked source amount with the live per-diem total', () => {
    const budget = createMockBudget({
      currency: 'EUR',
      fundingSources: [
        createMockFundingSource({ type: 'per-diem', linkedTripId: 'trip-1', amount: 10, restrictedToCategories: undefined }),
      ],
    });
    const hydrated = hydrateBudgetFundingFromTrips(budget, [mockTrip()]);
    expect(hydrated.fundingSources[0].amount).toBe(54);
    // The original budget is not mutated (snapshot stays as stored).
    expect(budget.fundingSources[0].amount).toBe(10);
  });

  it('keeps the stored snapshot when the linked trip is gone', () => {
    const budget = createMockBudget({
      currency: 'EUR',
      fundingSources: [
        createMockFundingSource({ type: 'per-diem', linkedTripId: 'deleted', amount: 999, restrictedToCategories: undefined }),
      ],
    });
    expect(hydrateBudgetFundingFromTrips(budget, []).fundingSources[0].amount).toBe(999);
  });

  it('leaves unlinked and non-per-diem sources untouched', () => {
    const grant = createMockFundingSource({ type: 'grant', amount: 2000 });
    const manualPerDiem = createMockFundingSource({
      type: 'per-diem',
      amount: 300,
      perDiemRate: 50,
      perDiemDays: 6,
      restrictedToCategories: undefined,
    });
    const budget = createMockBudget({ fundingSources: [grant, manualPerDiem] });
    const hydrated = hydrateBudgetFundingFromTrips(budget, [mockTrip()]);
    expect(hydrated.fundingSources[0].amount).toBe(2000);
    expect(hydrated.fundingSources[1].amount).toBe(300);
  });

  it('returns the SAME reference when no source is trip-linked (fast path)', () => {
    const budget = createMockBudget({ fundingSources: [createMockFundingSource()] });
    expect(hydrateBudgetFundingFromTrips(budget, [mockTrip()])).toBe(budget);
  });
});

describe('tripIdsFundedByActiveBudgets', () => {
  const linkedSource = (tripId: string) =>
    createMockFundingSource({ type: 'per-diem', linkedTripId: tripId, amount: 54, restrictedToCategories: undefined });

  it('includes a confirmed, account-linked, non-archived budget', () => {
    const budget = createMockBudget({
      status: 'confirmed',
      isArchived: false,
      linkedAccountId: 'acc-1',
      fundingSources: [linkedSource('t1')],
    });
    expect(tripIdsFundedByActiveBudgets([budget])).toEqual(new Set(['t1']));
  });

  it('excludes draft, archived, and account-less budgets', () => {
    const draft = createMockBudget({ status: 'draft', linkedAccountId: 'acc-1', fundingSources: [linkedSource('t-draft')] });
    const archived = createMockBudget({
      status: 'confirmed',
      isArchived: true,
      linkedAccountId: 'acc-1',
      fundingSources: [linkedSource('t-arch')],
    });
    const noAccount = createMockBudget({
      status: 'confirmed',
      isArchived: false,
      linkedAccountId: undefined,
      fundingSources: [linkedSource('t-noacc')],
    });
    expect(tripIdsFundedByActiveBudgets([draft, archived, noAccount])).toEqual(new Set());
  });

  it('unions trip ids across multiple qualifying budgets', () => {
    const a = createMockBudget({
      status: 'confirmed',
      isArchived: false,
      linkedAccountId: 'acc-1',
      fundingSources: [linkedSource('t1')],
    });
    const b = createMockBudget({
      status: 'confirmed',
      isArchived: false,
      linkedAccountId: 'acc-2',
      fundingSources: [linkedSource('t2'), linkedSource('t3')],
    });
    expect(tripIdsFundedByActiveBudgets([a, b])).toEqual(new Set(['t1', 't2', 't3']));
  });
});

describe('computeFeasibility on a hydrated budget', () => {
  it('uses the trip-hydrated amount, not the stored snapshot', () => {
    const budget = createMockBudget({
      currency: 'EUR',
      startMonth: '2026-04',
      endMonth: '2026-04',
      lines: [createMockBudgetLine({ kind: 'one-off', month: '2026-04', category: 'Food', amount: 40 })],
      fundingSources: [
        createMockFundingSource({
          type: 'per-diem',
          timing: 'specific-month',
          receivedMonth: '2026-04',
          linkedTripId: 'trip-1',
          amount: 5, // stale snapshot, must be ignored after hydration
          restrictedToCategories: undefined,
        }),
      ],
    });
    const f = computeFeasibility(hydrateBudgetFundingFromTrips(budget, [mockTrip()]));
    expect(f.totalFunding).toBe(54); // hydrated, not the stored 5
    expect(f.usableFunding).toBe(54);
    expect(f.outOfPocket).toBe(0);
    expect(f.freeSurplus).toBe(14); // 54 usable − 40 costs
  });
});

describe('calculateProjection with budget transfers', () => {
  it('injects budget lines into the right breakdowns and moves the balance', () => {
    const account = createMockAccount({ startingBalance: 1000, startingDate: '2026-01', planningHorizonMonths: 6 });
    const budget = createMockBudget({
      lines: [createMockBudgetLine({ kind: 'one-off', month: '2026-03', amount: 400 })],
      fundingSources: [createMockFundingSource({ amount: 250, restrictedToCategories: undefined, timing: 'upfront' })],
    });
    const transfers = computeBudgetTransfers(budget);
    const monthly = calculateProjection(account, [], [], [], undefined, undefined, [], transfers);

    const march = monthly.find(m => m.yearMonth === '2026-03')!;
    expect(march.expenseBreakdown).toEqual([
      { itemId: budget.id, name: `Budget: ${budget.name}`, amount: 400, source: 'budget' },
    ]);
    expect(march.incomeBreakdown).toEqual([
      { itemId: budget.id, name: `Budget: ${budget.name} (funding)`, amount: 250, source: 'budget' },
    ]);
    expect(march.netChange).toBe(-150);
    expect(march.endingBalance).toBe(850);
    // No spill into other months.
    expect(monthly.find(m => m.yearMonth === '2026-04')!.expenseBreakdown).toEqual([]);
  });
});

// ── Linked split group (read-time view) ──────────────────────────────────────

function splitExpenseRow(over: Partial<SplitExpenseItem> = {}): SplitExpenseItem {
  return {
    id: 'row-1',
    groupId: 'g1',
    date: '2026-03-10',
    currency: 'EUR',
    netByUserId: {},
    source: 'manual',
    createdByUserId: 'u1',
    createdAt: '2026-03-10T00:00:00Z',
    updatedAt: '2026-03-10T00:00:00Z',
    kind: 'expense',
    title: 'Test expense',
    category: 'Groceries',
    amountCents: 10000,
    ...over,
  };
}

function splitPaymentRow(over: Partial<SplitPayment> = {}): SplitPayment {
  return {
    id: 'pay-1',
    groupId: 'g1',
    date: '2026-03-15',
    currency: 'EUR',
    netByUserId: { me: 5000, other: -5000 },
    source: 'manual',
    createdByUserId: 'other',
    createdAt: '2026-03-15T00:00:00Z',
    updatedAt: '2026-03-15T00:00:00Z',
    kind: 'payment',
    fromUserId: 'other',
    toUserId: 'me',
    amountCents: 5000,
    ...over,
  };
}

describe('mapSplitCategoryToBudgetCategory', () => {
  it('maps food-like split categories to Food', () => {
    expect(mapSplitCategoryToBudgetCategory('Groceries')).toBe('Food');
    expect(mapSplitCategoryToBudgetCategory('Dining out')).toBe('Food');
  });

  it('maps transport and travel', () => {
    expect(mapSplitCategoryToBudgetCategory('Taxi')).toBe('Local transport');
    expect(mapSplitCategoryToBudgetCategory('Bus/train')).toBe('Local transport');
    expect(mapSplitCategoryToBudgetCategory('Plane')).toBe('Travel');
    expect(mapSplitCategoryToBudgetCategory('Hotel')).toBe('Accommodation');
  });

  it('falls back to Other for unknown categories', () => {
    expect(mapSplitCategoryToBudgetCategory('Games')).toBe('Other');
    expect(mapSplitCategoryToBudgetCategory('Totally made up')).toBe('Other');
  });
});

describe('computeViewerShareCents', () => {
  it('uses paid − net for native rows (payer who also consumed)', () => {
    // I paid 100, split equally with one other: net = +50, consumed = 50.
    const row = splitExpenseRow({
      netByUserId: { me: 5000, other: -5000 },
      paidBy: [{ userId: 'me', amountCents: 10000 }],
      owed: [
        { userId: 'me', amountCents: 5000 },
        { userId: 'other', amountCents: 5000 },
      ],
    });
    expect(computeViewerShareCents(row, 'me')).toBe(5000);
  });

  it('uses paid − net for native rows (non-payer)', () => {
    const row = splitExpenseRow({
      netByUserId: { me: -5000, other: 5000 },
      paidBy: [{ userId: 'other', amountCents: 10000 }],
    });
    expect(computeViewerShareCents(row, 'me')).toBe(5000);
  });

  it('falls back to max(0, −net) for imported rows without paidBy', () => {
    expect(computeViewerShareCents(splitExpenseRow({ netByUserId: { me: -2500 } }), 'me')).toBe(2500);
    // Positive net without paidBy: the import format can't tell what was
    // consumed, so this reports 0 (documented best-effort).
    expect(computeViewerShareCents(splitExpenseRow({ netByUserId: { me: 2500 } }), 'me')).toBe(0);
  });

  it('returns 0 for settle-up payments and non-participants', () => {
    expect(computeViewerShareCents(splitPaymentRow(), 'me')).toBe(0);
    expect(computeViewerShareCents(splitExpenseRow({ netByUserId: { other: -100 } }), 'me')).toBe(0);
  });
});

describe('buildSplitBudgetEntries', () => {
  const budget = { startMonth: '2026-03', endMonth: '2026-04', currency: 'EUR' as const };

  it('keeps only in-period, same-currency expense rows where the viewer consumed', () => {
    const rows = [
      splitExpenseRow({ id: 'in', date: '2026-03-05', netByUserId: { me: -1000 } }),
      splitExpenseRow({ id: 'before', date: '2026-02-28', netByUserId: { me: -1000 } }),
      splitExpenseRow({ id: 'after', date: '2026-05-01', netByUserId: { me: -1000 } }),
      splitExpenseRow({ id: 'fx', date: '2026-03-06', currency: 'USD', netByUserId: { me: -1000 } }),
      splitExpenseRow({ id: 'zero', date: '2026-03-07', netByUserId: { other: -1000, me: 0 } }),
      splitPaymentRow({ id: 'pay', date: '2026-03-08' }),
    ];
    const { entries, total } = buildSplitBudgetEntries(rows, 'me', budget);
    expect(entries.map(e => e.id)).toEqual(['in']);
    expect(total).toBe(10);
  });

  it('maps the split category, keeps amounts in currency units, and sorts by date desc', () => {
    const rows = [
      splitExpenseRow({ id: 'a', date: '2026-03-01', category: 'Taxi', title: 'Airport', netByUserId: { me: -1250 } }),
      splitExpenseRow({ id: 'b', date: '2026-04-20', category: 'Groceries', title: 'Market', netByUserId: { me: -2050 } }),
    ];
    const { entries, total } = buildSplitBudgetEntries(rows, 'me', budget);
    expect(entries.map(e => e.id)).toEqual(['b', 'a']);
    expect(entries[0]).toMatchObject({ description: 'Market', category: 'Food', splitCategory: 'Groceries', amount: 20.5 });
    expect(entries[1]).toMatchObject({ category: 'Local transport', amount: 12.5 });
    expect(total).toBe(33);
  });
});
