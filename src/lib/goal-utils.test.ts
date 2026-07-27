import { describe, it, expect } from 'vitest';
import { calculateGoalProgress, compareGoalsForPlan, computeGoalPlan, goalInjectsIntoCashflow } from './goal-utils';
import { addMonths, getCurrentYearMonth } from '@/lib/projection';
import type { Goal, MonthlyProjection, WealthProjectionMonth } from '@/types';

const now = new Date().toISOString();

function createGoal(overrides?: Partial<Goal>): Goal {
  return {
    id: 'goal-1',
    userId: 'test-user',
    name: 'Test Goal',
    targetAmount: 10000,
    currency: 'EUR',
    trackingMethod: 'manual',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createMonthlyProjection(overrides?: Partial<MonthlyProjection>): MonthlyProjection {
  return {
    yearMonth: '2026-01',
    year: 2026,
    month: 1,
    startingBalance: 5000,
    totalIncome: 3000,
    totalExpenses: 2000,
    netChange: 1000,
    endingBalance: 6000,
    incomeBreakdown: [],
    expenseBreakdown: [],
    ...overrides,
  };
}

function createWealthMonth(overrides?: Partial<WealthProjectionMonth>): WealthProjectionMonth {
  return {
    yearMonth: '2026-01',
    year: 2026,
    month: 1,
    cashAccountsTotal: 5000,
    cashAccountsBreakdown: [],
    investmentsTotal: 10000,
    investmentsBreakdown: [],
    receivablesTotal: 0,
    receivablesBreakdown: [],
    debtsTotal: 0,
    debtsBreakdown: [],
    netWorth: 15000,
    ...overrides,
  };
}

describe('calculateGoalProgress', () => {
  describe('manual tracking', () => {
    it('uses currentManualAmount and calculates correct percentage', () => {
      const goal = createGoal({
        trackingMethod: 'manual',
        targetAmount: 10000,
        currentManualAmount: 2500,
      });

      const result = calculateGoalProgress(goal);

      expect(result.currentAmount).toBe(2500);
      expect(result.targetAmount).toBe(10000);
      expect(result.percentComplete).toBe(25);
      expect(result.projectedAmountAtTarget).toBeNull();
      expect(result.onTrack).toBe(false);
      expect(result.projectedDate).toBeNull();
    });

    it('treats missing currentManualAmount as 0', () => {
      const goal = createGoal({
        trackingMethod: 'manual',
        targetAmount: 5000,
      });

      const result = calculateGoalProgress(goal);

      expect(result.currentAmount).toBe(0);
      expect(result.percentComplete).toBe(0);
    });

    it('caps percentComplete at 100', () => {
      const goal = createGoal({
        trackingMethod: 'manual',
        targetAmount: 1000,
        currentManualAmount: 1500,
      });

      const result = calculateGoalProgress(goal);

      expect(result.percentComplete).toBe(100);
      expect(result.onTrack).toBe(true);
    });
  });

  describe('account-balance tracking', () => {
    it('finds correct projected amount at target date', () => {
      const goal = createGoal({
        trackingMethod: 'account-balance',
        linkedAccountId: 'acct-1',
        targetAmount: 8000,
        targetDate: '2026-03',
      });

      const projections = new Map<string, MonthlyProjection[]>();
      projections.set('acct-1', [
        createMonthlyProjection({ yearMonth: '2026-01', startingBalance: 5000, endingBalance: 6000 }),
        createMonthlyProjection({ yearMonth: '2026-02', startingBalance: 6000, endingBalance: 7000 }),
        createMonthlyProjection({ yearMonth: '2026-03', startingBalance: 7000, endingBalance: 8000 }),
        createMonthlyProjection({ yearMonth: '2026-04', startingBalance: 8000, endingBalance: 9000 }),
      ]);

      const result = calculateGoalProgress(goal, projections);

      expect(result.currentAmount).toBe(5000);
      expect(result.projectedAmountAtTarget).toBe(8000);
      expect(result.onTrack).toBe(true);
      expect(result.projectedDate).toBe('2026-03');
    });

    it('returns null projectedAmountAtTarget when target date is not in projections', () => {
      const goal = createGoal({
        trackingMethod: 'account-balance',
        linkedAccountId: 'acct-1',
        targetAmount: 50000,
        targetDate: '2030-12',
      });

      const projections = new Map<string, MonthlyProjection[]>();
      projections.set('acct-1', [
        createMonthlyProjection({ yearMonth: '2026-01', startingBalance: 5000, endingBalance: 6000 }),
      ]);

      const result = calculateGoalProgress(goal, projections);

      expect(result.currentAmount).toBe(5000);
      expect(result.projectedAmountAtTarget).toBeNull();
      expect(result.onTrack).toBe(false);
    });

    it('handles no projections gracefully', () => {
      const goal = createGoal({
        trackingMethod: 'account-balance',
        linkedAccountId: 'acct-1',
        targetAmount: 10000,
      });

      const result = calculateGoalProgress(goal);

      expect(result.currentAmount).toBe(0);
      expect(result.projectedAmountAtTarget).toBeNull();
      expect(result.projectedDate).toBeNull();
    });
  });

  describe('net-worth tracking', () => {
    it('finds correct net worth at target date', () => {
      const goal = createGoal({
        trackingMethod: 'net-worth',
        targetAmount: 20000,
        targetDate: '2026-02',
      });

      const wealthProjections: WealthProjectionMonth[] = [
        createWealthMonth({ yearMonth: '2026-01', netWorth: 15000 }),
        createWealthMonth({ yearMonth: '2026-02', netWorth: 20000 }),
        createWealthMonth({ yearMonth: '2026-03', netWorth: 25000 }),
      ];

      const result = calculateGoalProgress(goal, undefined, wealthProjections);

      expect(result.currentAmount).toBe(15000);
      expect(result.projectedAmountAtTarget).toBe(20000);
      expect(result.onTrack).toBe(true);
      expect(result.projectedDate).toBe('2026-02');
    });

    it('handles no wealth projections gracefully', () => {
      const goal = createGoal({
        trackingMethod: 'net-worth',
        targetAmount: 100000,
      });

      const result = calculateGoalProgress(goal, undefined, undefined);

      expect(result.currentAmount).toBe(0);
      expect(result.projectedAmountAtTarget).toBeNull();
      expect(result.projectedDate).toBeNull();
    });
  });

  describe('100% complete goal', () => {
    it('reports 100% and onTrack for a fully achieved manual goal', () => {
      const goal = createGoal({
        trackingMethod: 'manual',
        targetAmount: 5000,
        currentManualAmount: 5000,
      });

      const result = calculateGoalProgress(goal);

      expect(result.percentComplete).toBe(100);
      expect(result.onTrack).toBe(true);
    });
  });

  describe('on track vs not on track', () => {
    it('reports not on track when projected amount is below target', () => {
      const goal = createGoal({
        trackingMethod: 'account-balance',
        linkedAccountId: 'acct-1',
        targetAmount: 20000,
        targetDate: '2026-03',
      });

      const projections = new Map<string, MonthlyProjection[]>();
      projections.set('acct-1', [
        createMonthlyProjection({ yearMonth: '2026-01', startingBalance: 5000, endingBalance: 6000 }),
        createMonthlyProjection({ yearMonth: '2026-02', startingBalance: 6000, endingBalance: 7000 }),
        createMonthlyProjection({ yearMonth: '2026-03', startingBalance: 7000, endingBalance: 8000 }),
      ]);

      const result = calculateGoalProgress(goal, projections);

      expect(result.onTrack).toBe(false);
      expect(result.projectedAmountAtTarget).toBe(8000);
      expect(result.projectedDate).toBeNull(); // never reaches 20000
    });

    it('reports on track when projected amount exceeds target', () => {
      const goal = createGoal({
        trackingMethod: 'account-balance',
        linkedAccountId: 'acct-1',
        targetAmount: 7000,
        targetDate: '2026-03',
      });

      const projections = new Map<string, MonthlyProjection[]>();
      projections.set('acct-1', [
        createMonthlyProjection({ yearMonth: '2026-01', startingBalance: 5000, endingBalance: 6000 }),
        createMonthlyProjection({ yearMonth: '2026-02', startingBalance: 6000, endingBalance: 7000 }),
        createMonthlyProjection({ yearMonth: '2026-03', startingBalance: 7000, endingBalance: 8000 }),
      ]);

      const result = calculateGoalProgress(goal, projections);

      expect(result.onTrack).toBe(true);
      expect(result.projectedAmountAtTarget).toBe(8000);
      expect(result.projectedDate).toBe('2026-02'); // first month reaching 7000
    });
  });
});

describe('goalInjectsIntoCashflow', () => {
  function injectingGoal(overrides?: Partial<Goal>): Goal {
    return createGoal({
      trackingMethod: 'account-balance',
      linkedAccountId: 'acct-1',
      goalType: 'spend',
      injectIntoCashflow: true,
      targetDate: '2026-06',
      ...overrides,
    });
  }

  it('is true when every condition is satisfied', () => {
    expect(goalInjectsIntoCashflow(injectingGoal())).toBe(true);
  });

  it('is false when goalType is reserve (or missing)', () => {
    expect(goalInjectsIntoCashflow(injectingGoal({ goalType: 'reserve' }))).toBe(false);
    expect(goalInjectsIntoCashflow(injectingGoal({ goalType: undefined }))).toBe(false);
  });

  it('is false when injectIntoCashflow is not set', () => {
    expect(goalInjectsIntoCashflow(injectingGoal({ injectIntoCashflow: false }))).toBe(false);
    expect(goalInjectsIntoCashflow(injectingGoal({ injectIntoCashflow: undefined }))).toBe(false);
  });

  it('is false when targetDate is missing', () => {
    expect(goalInjectsIntoCashflow(injectingGoal({ targetDate: undefined }))).toBe(false);
  });

  it('is false when trackingMethod is not account-balance', () => {
    expect(goalInjectsIntoCashflow(injectingGoal({ trackingMethod: 'net-worth' }))).toBe(false);
    expect(goalInjectsIntoCashflow(injectingGoal({ trackingMethod: 'manual' }))).toBe(false);
  });

  it('is false when linkedAccountId is missing', () => {
    expect(goalInjectsIntoCashflow(injectingGoal({ linkedAccountId: undefined }))).toBe(false);
  });

  it('is false when the goal is archived', () => {
    expect(goalInjectsIntoCashflow(injectingGoal({ isArchived: true }))).toBe(false);
  });
});

describe('compareGoalsForPlan', () => {
  it('orders lower priority first, ahead of target date', () => {
    const a = createGoal({ id: 'a', priority: 2, targetDate: '2026-01' });
    const b = createGoal({ id: 'b', priority: 1, targetDate: '2030-01' });
    expect(compareGoalsForPlan(a, b)).toBeGreaterThan(0); // b (priority 1) sorts first
    expect([a, b].sort(compareGoalsForPlan).map((g) => g.id)).toEqual(['b', 'a']);
  });

  it('sorts undated goals after dated ones when priority ties', () => {
    const dated = createGoal({ id: 'dated', targetDate: '2026-05' });
    const undated = createGoal({ id: 'undated' });
    expect([undated, dated].sort(compareGoalsForPlan).map((g) => g.id)).toEqual(['dated', 'undated']);
  });

  it('breaks remaining ties by name', () => {
    const zed = createGoal({ id: 'z', name: 'Zed fund' });
    const alpha = createGoal({ id: 'a', name: 'Alpha fund' });
    expect([zed, alpha].sort(compareGoalsForPlan).map((g) => g.id)).toEqual(['a', 'z']);
  });
});

describe('computeGoalPlan', () => {
  // A steady +1000/month account: month0 starts at 5000, each month's ending
  // balance is 1000 higher than the last.
  const acct1Monthly: MonthlyProjection[] = [
    createMonthlyProjection({ yearMonth: '2026-01', startingBalance: 5000, endingBalance: 6000 }),
    createMonthlyProjection({ yearMonth: '2026-02', startingBalance: 6000, endingBalance: 7000 }),
    createMonthlyProjection({ yearMonth: '2026-03', startingBalance: 7000, endingBalance: 8000 }),
    createMonthlyProjection({ yearMonth: '2026-04', startingBalance: 8000, endingBalance: 9000 }),
  ];

  it('two reserve goals on one account: the second sees the remainder and a later (or no) projected date', () => {
    const goalA = createGoal({
      id: 'goalA', trackingMethod: 'account-balance', linkedAccountId: 'acct-1',
      targetAmount: 5000, priority: 1,
    });
    const goalB = createGoal({
      id: 'goalB', trackingMethod: 'account-balance', linkedAccountId: 'acct-1',
      targetAmount: 5000, priority: 2,
    });

    const cashProjections = new Map([['acct-1', acct1Monthly]]);
    const { entries } = computeGoalPlan([goalA, goalB], cashProjections, []);

    const entryA = entries.find((e) => e.goal.id === 'goalA')!;
    const entryB = entries.find((e) => e.goal.id === 'goalB')!;

    expect(entryA.progress.currentAmount).toBe(5000);
    expect(entryA.progress.projectedDate).toBe('2026-01'); // 6000 already >= 5000
    expect(entryA.claimedAheadNow).toBe(0);

    // goalB sees goalA's 5000 claim subtracted everywhere.
    expect(entryB.claimedAheadNow).toBe(5000);
    expect(entryB.progress.currentAmount).toBe(0); // 5000 - 5000
    expect(entryB.progress.projectedDate).toBeNull(); // never reaches 5000 within the horizon (max adjusted 4000)
    expect(entryB.competingGoalIds).toEqual(['goalA']);
  });

  it('an injecting spend goal releases its claim from the target month, and adds its own injection back for itself', () => {
    // Simulates a projection where goalC's own 2000 expense already landed at
    // 2026-03 (end = start - 1000 that month instead of the usual +1000).
    const monthly: MonthlyProjection[] = [
      createMonthlyProjection({ yearMonth: '2026-01', startingBalance: 5000, endingBalance: 6000 }),
      createMonthlyProjection({ yearMonth: '2026-02', startingBalance: 6000, endingBalance: 7000 }),
      createMonthlyProjection({ yearMonth: '2026-03', startingBalance: 7000, endingBalance: 6000 }),
      createMonthlyProjection({ yearMonth: '2026-04', startingBalance: 6000, endingBalance: 7000 }),
    ];

    const goalC = createGoal({
      id: 'goalC', trackingMethod: 'account-balance', linkedAccountId: 'acct-1',
      goalType: 'spend', injectIntoCashflow: true, targetDate: '2026-03', targetAmount: 2000, priority: 1,
    });
    const goalD = createGoal({
      id: 'goalD', trackingMethod: 'account-balance', linkedAccountId: 'acct-1',
      targetAmount: 1000, targetDate: '2026-04', priority: 2,
    });

    const cashProjections = new Map([['acct-1', monthly]]);
    const { entries } = computeGoalPlan([goalC, goalD], cashProjections, []);

    const entryC = entries.find((e) => e.goal.id === 'goalC')!;
    const entryD = entries.find((e) => e.goal.id === 'goalD')!;

    expect(entryC.injects).toBe(true);
    // "Now" (2026-01) precedes the target date, so no add-back applies yet.
    expect(entryC.progress.currentAmount).toBe(5000);
    // At the target month, the raw balance already reflects the spend (6000);
    // the goal's own evaluation adds its target amount back (double-claim guard).
    expect(entryC.progress.projectedAmountAtTarget).toBe(6000 + 2000);

    // goalD (later in plan) sees goalC's claim before the target month...
    expect(entryD.claimedAheadNow).toBe(2000); // "now" (2026-01) < goalC's target date
    expect(entryD.progress.currentAmount).toBe(5000 - 2000);
    // ...but the claim is released from the target month onward: at goalD's own
    // target date (2026-04, after goalC's 2026-03), the full raw balance is
    // available — it is NOT reduced by goalC's already-spent target amount.
    expect(entryD.progress.projectedAmountAtTarget).toBe(7000);
    expect(entryD.competingGoalIds).toEqual(['goalC']);
  });

  it('an account-balance goal claim reduces a net-worth goal availability', () => {
    const goalE = createGoal({
      id: 'goalE', trackingMethod: 'account-balance', linkedAccountId: 'acct-1',
      targetAmount: 1000, priority: 1,
    });
    const goalF = createGoal({
      id: 'goalF', trackingMethod: 'net-worth', targetAmount: 10000, priority: 2,
    });

    const cashProjections = new Map([['acct-1', acct1Monthly]]);
    const wealthProjections: WealthProjectionMonth[] = [
      createWealthMonth({ yearMonth: '2026-01', netWorth: 20000 }),
      createWealthMonth({ yearMonth: '2026-02', netWorth: 21000 }),
    ];

    const { entries } = computeGoalPlan([goalE, goalF], cashProjections, wealthProjections);
    const entryF = entries.find((e) => e.goal.id === 'goalF')!;

    expect(entryF.claimedAheadNow).toBe(1000);
    expect(entryF.progress.currentAmount).toBe(20000 - 1000);
  });

  it('manual goals are standalone: no claims, no competition, and contribute nothing to other goals\' ledgers', () => {
    const manualGoal = createGoal({
      id: 'manual1', trackingMethod: 'manual', currentManualAmount: 2500, targetAmount: 10000, priority: 1,
    });
    const goalG = createGoal({
      id: 'goalG', trackingMethod: 'account-balance', linkedAccountId: 'acct-1', targetAmount: 500, priority: 2,
    });

    const cashProjections = new Map([['acct-1', acct1Monthly]]);
    const { entries } = computeGoalPlan([manualGoal, goalG], cashProjections, []);

    const entryManual = entries.find((e) => e.goal.id === 'manual1')!;
    const entryG = entries.find((e) => e.goal.id === 'goalG')!;

    expect(entryManual.competingGoalIds).toEqual([]);
    expect(entryManual.claimedAheadNow).toBe(0);
    expect(entryManual.injects).toBe(false);
    expect(entryManual.progress).toEqual(calculateGoalProgress(manualGoal));

    // The manual goal ahead of it in plan order contributes nothing.
    expect(entryG.claimedAheadNow).toBe(0);
    expect(entryG.progress.currentAmount).toBe(5000);
  });

  describe('requiredMonthlySaving', () => {
    const nowMonth = getCurrentYearMonth();

    it('computes the normal case', () => {
      const goal = createGoal({
        trackingMethod: 'manual', currentManualAmount: 1000, targetAmount: 6000,
        targetDate: addMonths(nowMonth, 5),
      });
      const { entries } = computeGoalPlan([goal], new Map(), []);
      expect(entries[0].requiredMonthlySaving).toBeCloseTo(1000, 5);
      expect(entries[0].targetDatePassed).toBe(false);
    });

    it('returns null and flags targetDatePassed for a past target date', () => {
      const goal = createGoal({
        trackingMethod: 'manual', currentManualAmount: 1000, targetAmount: 6000,
        targetDate: addMonths(nowMonth, -3),
      });
      const { entries } = computeGoalPlan([goal], new Map(), []);
      expect(entries[0].requiredMonthlySaving).toBeNull();
      expect(entries[0].targetDatePassed).toBe(true);
    });

    it('returns null (not 0) once the target is already reached', () => {
      const goal = createGoal({
        trackingMethod: 'manual', currentManualAmount: 1000, targetAmount: 1000,
        targetDate: addMonths(nowMonth, 2),
      });
      const { entries } = computeGoalPlan([goal], new Map(), []);
      expect(entries[0].requiredMonthlySaving).toBeNull();
      expect(entries[0].targetDatePassed).toBe(false);
    });

    it('returns null when there is no target date', () => {
      const goal = createGoal({ trackingMethod: 'manual', currentManualAmount: 1000, targetAmount: 6000 });
      const { entries } = computeGoalPlan([goal], new Map(), []);
      expect(entries[0].requiredMonthlySaving).toBeNull();
      expect(entries[0].targetDatePassed).toBe(false);
    });
  });

  it('clamps percentComplete to 0 when an earlier claim pushes the adjusted current amount negative', () => {
    // goalH alone claims more than the account currently holds ("now" = 5000).
    const goalH = createGoal({
      id: 'goalH', trackingMethod: 'account-balance', linkedAccountId: 'acct-1', targetAmount: 8000, priority: 1,
    });
    const goalI = createGoal({
      id: 'goalI', trackingMethod: 'account-balance', linkedAccountId: 'acct-1', targetAmount: 2000, priority: 2,
    });

    const cashProjections = new Map([['acct-1', acct1Monthly]]); // "now" balance is 5000
    const { entries } = computeGoalPlan([goalH, goalI], cashProjections, []);
    const entryI = entries.find((e) => e.goal.id === 'goalI')!;

    expect(entryI.progress.currentAmount).toBe(5000 - 8000); // = -3000, not clamped
    expect(entryI.progress.currentAmount).toBeLessThan(0);
    expect(entryI.progress.percentComplete).toBe(0);
  });
});
