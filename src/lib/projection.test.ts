import { describe, it, expect } from 'vitest';
import { calculateProjection, calculateYearlyRollups, resolveAnchor, generateMonthList } from './projection';
import type { MortgageTransfer, BudgetTransfer, CardBillTransfer, CurrentMonthActuals, GoalTransfer, TripTransfer } from './projection';
import type { ActualTxLike } from '@/lib/current-month-actuals';
import { createMockAccount, createMockRecurringItem, createMockPlannedItem, createMockTaxedIncome, createMockSnapshot } from '@/test/mocks';

describe('calculateProjection', () => {
  const account = createMockAccount({
    startingBalance: 5000,
    startingDate: '2026-01',
    planningHorizonMonths: 6,
  });

  describe('recurring items', () => {
    it('applies monthly income and expense correctly', () => {
      const income = createMockRecurringItem({
        accountId: account.id,
        type: 'income',
        amount: 3000,
        frequency: 'monthly',
        startDate: '2026-01',
      });
      const expense = createMockRecurringItem({
        accountId: account.id,
        type: 'expense',
        amount: 2000,
        frequency: 'monthly',
        startDate: '2026-01',
      });

      const result = calculateProjection(account, [income, expense], []);

      expect(result).toHaveLength(6);
      // Month 1: 5000 + 3000 - 2000 = 6000
      expect(result[0].startingBalance).toBe(5000);
      expect(result[0].totalIncome).toBe(3000);
      expect(result[0].totalExpenses).toBe(2000);
      expect(result[0].endingBalance).toBe(6000);
      // Month 2: 6000 + 3000 - 2000 = 7000
      expect(result[1].startingBalance).toBe(6000);
      expect(result[1].endingBalance).toBe(7000);
      // Month 6: 5000 + 6 * 1000 = 11000
      expect(result[5].endingBalance).toBe(11000);
    });

    it('quarterly items appear in correct months only', () => {
      const quarterly = createMockRecurringItem({
        accountId: account.id,
        type: 'income',
        amount: 1000,
        frequency: 'quarterly',
        startDate: '2026-01',
      });

      const result = calculateProjection(account, [quarterly], []);

      // Quarterly starting from Jan: appears in Jan (month 0), Apr (month 3)
      expect(result[0].totalIncome).toBe(1000); // Jan
      expect(result[1].totalIncome).toBe(0);    // Feb
      expect(result[2].totalIncome).toBe(0);    // Mar
      expect(result[3].totalIncome).toBe(1000); // Apr
      expect(result[4].totalIncome).toBe(0);    // May
      expect(result[5].totalIncome).toBe(0);    // Jun
    });

    it('yearly items appear in correct months only', () => {
      const yearly = createMockRecurringItem({
        accountId: account.id,
        type: 'expense',
        amount: 5000,
        frequency: 'yearly',
        startDate: '2026-01',
      });

      const result = calculateProjection(account, [yearly], []);

      expect(result[0].totalExpenses).toBe(5000); // Jan
      for (let i = 1; i < 6; i++) {
        expect(result[i].totalExpenses).toBe(0); // Feb-Jun
      }
    });

    it('inactive items are excluded', () => {
      const inactive = createMockRecurringItem({
        accountId: account.id,
        type: 'income',
        amount: 3000,
        isActive: false,
      });

      const result = calculateProjection(account, [inactive], []);
      expect(result[0].totalIncome).toBe(0);
    });

    it('items with start/end dates only active within range', () => {
      const item = createMockRecurringItem({
        accountId: account.id,
        type: 'income',
        amount: 1000,
        startDate: '2026-03',
        endDate: '2026-04',
      });

      const result = calculateProjection(account, [item], []);

      expect(result[0].totalIncome).toBe(0);    // Jan
      expect(result[1].totalIncome).toBe(0);    // Feb
      expect(result[2].totalIncome).toBe(1000); // Mar
      expect(result[3].totalIncome).toBe(1000); // Apr
      expect(result[4].totalIncome).toBe(0);    // May
    });
  });

  describe('planned items', () => {
    it('one-off items appear in scheduled month only', () => {
      const oneOff = createMockPlannedItem({
        accountId: account.id,
        type: 'expense',
        kind: 'one-off',
        amount: 500,
        scheduledDate: '2026-03',
      });

      const result = calculateProjection(account, [], [oneOff]);

      expect(result[0].totalExpenses).toBe(0);   // Jan
      expect(result[1].totalExpenses).toBe(0);   // Feb
      expect(result[2].totalExpenses).toBe(500); // Mar
      expect(result[3].totalExpenses).toBe(0);   // Apr
    });

    it('repeating items appear at correct frequency', () => {
      const repeating = createMockPlannedItem({
        accountId: account.id,
        type: 'expense',
        kind: 'repeating',
        amount: 100,
        frequency: 'monthly',
        firstOccurrence: '2026-01',
      });

      const result = calculateProjection(account, [], [repeating]);
      for (const month of result) {
        expect(month.totalExpenses).toBe(100);
      }
    });
  });

  describe('occurrence overrides', () => {
    it('amount override is applied correctly', () => {
      const recurring = createMockRecurringItem({
        accountId: account.id,
        type: 'expense',
        amount: 1000,
        startDate: '2026-01',
      });

      const override = createMockPlannedItem({
        accountId: account.id,
        type: 'expense',
        kind: 'one-off',
        name: 'Override',
        amount: 1500,
        scheduledDate: '2026-02',
        isRecurringOverride: true,
        linkedRecurringItemId: recurring.id,
      });

      const result = calculateProjection(account, [recurring], [override]);

      expect(result[0].totalExpenses).toBe(1000); // Jan: original
      expect(result[1].totalExpenses).toBe(1500); // Feb: overridden
      expect(result[2].totalExpenses).toBe(1000); // Mar: original
    });

    it('skip occurrence excludes the item', () => {
      const recurring = createMockRecurringItem({
        accountId: account.id,
        type: 'expense',
        amount: 1000,
        startDate: '2026-01',
      });

      const skip = createMockPlannedItem({
        accountId: account.id,
        type: 'expense',
        kind: 'one-off',
        amount: 0,
        scheduledDate: '2026-03',
        isRecurringOverride: true,
        linkedRecurringItemId: recurring.id,
        skipOccurrence: true,
      });

      const result = calculateProjection(account, [recurring], [skip]);

      expect(result[0].totalExpenses).toBe(1000); // Jan
      expect(result[1].totalExpenses).toBe(1000); // Feb
      expect(result[2].totalExpenses).toBe(0);    // Mar: skipped
      expect(result[3].totalExpenses).toBe(1000); // Apr
    });
  });

  describe('expired override filtering', () => {
    it('override with old date is excluded from projection', () => {
      // Account starts in 2026-06, so 2 months before is 2026-04
      const laterAccount = createMockAccount({
        startingBalance: 5000,
        startingDate: '2026-06',
        planningHorizonMonths: 3,
      });
      const recurring = createMockRecurringItem({
        accountId: laterAccount.id,
        type: 'expense',
        amount: 1000,
        startDate: '2026-01',
      });
      const expiredOverride = createMockPlannedItem({
        accountId: laterAccount.id,
        type: 'expense',
        kind: 'one-off',
        amount: 2000,
        scheduledDate: '2026-01', // Way before projection start
        isRecurringOverride: true,
        linkedRecurringItemId: recurring.id,
      });

      const result = calculateProjection(laterAccount, [recurring], [expiredOverride]);
      // The expired override for 2026-01 should be ignored
      // All months should see the original amount
      expect(result[0].totalExpenses).toBe(1000); // Jun
      expect(result[1].totalExpenses).toBe(1000); // Jul
    });

    it('recent override is included', () => {
      const recurring = createMockRecurringItem({
        accountId: account.id,
        type: 'expense',
        amount: 1000,
        startDate: '2026-01',
      });
      const recentOverride = createMockPlannedItem({
        accountId: account.id,
        type: 'expense',
        kind: 'one-off',
        amount: 2000,
        scheduledDate: '2026-02', // Within range
        isRecurringOverride: true,
        linkedRecurringItemId: recurring.id,
      });

      const result = calculateProjection(account, [recurring], [recentOverride]);
      expect(result[1].totalExpenses).toBe(2000); // Feb: overridden
    });

    it('non-override planned items are never filtered', () => {
      const laterAccount = createMockAccount({
        startingBalance: 5000,
        startingDate: '2026-06',
        planningHorizonMonths: 3,
      });
      const oldOneOff = createMockPlannedItem({
        accountId: laterAccount.id,
        type: 'expense',
        kind: 'one-off',
        amount: 500,
        scheduledDate: '2026-01', // Old but NOT an override
        isRecurringOverride: false,
      });

      const result = calculateProjection(laterAccount, [], [oldOneOff]);
      // Non-override planned items shouldn't be filtered by the cutoff
      // But this one-off is scheduled for 2026-01 which is outside the projection range (2026-06 to 2026-08)
      // So it won't appear anyway
      expect(result[0].totalExpenses).toBe(0);
    });
  });

  describe('taxed income items', () => {
    it('one-off taxed income appears in correct month using netAmount', () => {
      const taxedIncome = createMockTaxedIncome({
        accountId: account.id,
        kind: 'one-off',
        name: 'Bonus',
        netAmount: 3100,
        grossAmount: 5000,
        scheduledDate: '2026-03',
      });

      const result = calculateProjection(account, [], [], [taxedIncome]);

      expect(result[0].totalIncome).toBe(0);    // Jan
      expect(result[1].totalIncome).toBe(0);    // Feb
      expect(result[2].totalIncome).toBe(3100); // Mar: netAmount
      expect(result[3].totalIncome).toBe(0);    // Apr
    });

    it('recurring taxed income at correct frequency', () => {
      const taxedIncome = createMockTaxedIncome({
        accountId: account.id,
        kind: 'recurring',
        name: 'Monthly Bonus',
        netAmount: 500,
        frequency: 'monthly',
        startDate: '2026-01',
        scheduledDate: undefined,
      });

      const result = calculateProjection(account, [], [], [taxedIncome]);
      for (const month of result) {
        expect(month.totalIncome).toBe(500);
      }
    });

    it('quarterly taxed income appears in correct months', () => {
      const taxedIncome = createMockTaxedIncome({
        accountId: account.id,
        kind: 'recurring',
        name: 'Quarterly Bonus',
        netAmount: 2000,
        frequency: 'quarterly',
        startDate: '2026-01',
        scheduledDate: undefined,
      });

      const result = calculateProjection(account, [], [], [taxedIncome]);

      expect(result[0].totalIncome).toBe(2000); // Jan
      expect(result[1].totalIncome).toBe(0);    // Feb
      expect(result[2].totalIncome).toBe(0);    // Mar
      expect(result[3].totalIncome).toBe(2000); // Apr
    });

    it('uses netAmount not grossAmount', () => {
      const taxedIncome = createMockTaxedIncome({
        accountId: account.id,
        kind: 'one-off',
        grossAmount: 10000,
        netAmount: 6200,
        scheduledDate: '2026-02',
      });

      const result = calculateProjection(account, [], [], [taxedIncome]);
      expect(result[1].totalIncome).toBe(6200); // Net, not gross
    });

    it('inactive taxed income is excluded', () => {
      const taxedIncome = createMockTaxedIncome({
        accountId: account.id,
        kind: 'one-off',
        netAmount: 5000,
        scheduledDate: '2026-02',
        isActive: false,
      });

      const result = calculateProjection(account, [], [], [taxedIncome]);
      expect(result[1].totalIncome).toBe(0);
    });

    it('taxed income with end date respects range', () => {
      const taxedIncome = createMockTaxedIncome({
        accountId: account.id,
        kind: 'recurring',
        netAmount: 500,
        frequency: 'monthly',
        startDate: '2026-02',
        endDate: '2026-04',
        scheduledDate: undefined,
      });

      const result = calculateProjection(account, [], [], [taxedIncome]);

      expect(result[0].totalIncome).toBe(0);   // Jan: before start
      expect(result[1].totalIncome).toBe(500); // Feb
      expect(result[2].totalIncome).toBe(500); // Mar
      expect(result[3].totalIncome).toBe(500); // Apr
      expect(result[4].totalIncome).toBe(0);   // May: after end
    });

    it('recurring taxed income skips a listed occurrence, leaving neighbours intact', () => {
      const taxedIncome = createMockTaxedIncome({
        accountId: account.id,
        kind: 'recurring',
        netAmount: 500,
        frequency: 'monthly',
        startDate: '2026-01',
        scheduledDate: undefined,
        skippedOccurrences: ['2026-03'],
      });

      const result = calculateProjection(account, [], [], [taxedIncome]);

      expect(result[0].totalIncome).toBe(500); // Jan
      expect(result[1].totalIncome).toBe(500); // Feb
      expect(result[2].totalIncome).toBe(0);   // Mar: skipped
      expect(result[3].totalIncome).toBe(500); // Apr
    });

    it('a skip entry on a non-occurrence month is a no-op', () => {
      const taxedIncome = createMockTaxedIncome({
        accountId: account.id,
        kind: 'recurring',
        netAmount: 2000,
        frequency: 'quarterly',
        startDate: '2026-01',
        scheduledDate: undefined,
        // Feb is not a quarterly occurrence (Jan, Apr, ...) — skipping it changes nothing.
        skippedOccurrences: ['2026-02'],
      });

      const result = calculateProjection(account, [], [], [taxedIncome]);

      expect(result[0].totalIncome).toBe(2000); // Jan
      expect(result[1].totalIncome).toBe(0);    // Feb (never an occurrence anyway)
      expect(result[3].totalIncome).toBe(2000); // Apr
    });

    it('a one-off is not affected by a matching skip entry (recurring-only)', () => {
      const taxedIncome = createMockTaxedIncome({
        accountId: account.id,
        kind: 'one-off',
        netAmount: 3100,
        scheduledDate: '2026-03',
        skippedOccurrences: ['2026-03'],
      });

      const result = calculateProjection(account, [], [], [taxedIncome]);
      expect(result[2].totalIncome).toBe(3100); // Mar: still fires
    });
  });

  describe('shared expenses', () => {
    it('shared recurring item with 0.5 ratio uses half amount', () => {
      const shared = createMockRecurringItem({
        accountId: account.id,
        type: 'expense',
        amount: 1000,
        isShared: true,
        shareRatio: 0.5,
        startDate: '2026-01',
      });

      const result = calculateProjection(account, [shared], []);
      expect(result[0].totalExpenses).toBe(500); // Half of 1000
    });

    it('shared recurring item with custom ratio', () => {
      const shared = createMockRecurringItem({
        accountId: account.id,
        type: 'expense',
        amount: 1000,
        isShared: true,
        shareRatio: 0.3,
        startDate: '2026-01',
      });

      const result = calculateProjection(account, [shared], []);
      expect(result[0].totalExpenses).toBe(300);
    });

    it('non-shared items unaffected', () => {
      const normal = createMockRecurringItem({
        accountId: account.id,
        type: 'expense',
        amount: 1000,
        isShared: false,
        startDate: '2026-01',
      });

      const result = calculateProjection(account, [normal], []);
      expect(result[0].totalExpenses).toBe(1000);
    });

    it('shared planned one-off item uses half amount', () => {
      const shared = createMockPlannedItem({
        accountId: account.id,
        type: 'expense',
        kind: 'one-off',
        amount: 2000,
        isShared: true,
        shareRatio: 0.5,
        scheduledDate: '2026-02',
      });

      const result = calculateProjection(account, [], [shared]);
      expect(result[1].totalExpenses).toBe(1000);
    });
  });

  describe('reimbursable expenses', () => {
    it('pending reimbursable: expense in month X, income in month Y', () => {
      const reimbursable = createMockPlannedItem({
        accountId: account.id,
        type: 'expense',
        kind: 'one-off',
        amount: 500,
        scheduledDate: '2026-02',
        isReimbursable: true,
        reimbursementStatus: 'pending',
        expectedReimbursementMonth: '2026-04',
      });

      const result = calculateProjection(account, [], [reimbursable]);
      expect(result[1].totalExpenses).toBe(500); // Feb: expense
      expect(result[3].totalIncome).toBe(500);   // Apr: reimbursement income
    });

    it('received reimbursable: expense only, no projected income', () => {
      const received = createMockPlannedItem({
        accountId: account.id,
        type: 'expense',
        kind: 'one-off',
        amount: 500,
        scheduledDate: '2026-02',
        isReimbursable: true,
        reimbursementStatus: 'received',
        expectedReimbursementMonth: '2026-04',
      });

      const result = calculateProjection(account, [], [received]);
      expect(result[1].totalExpenses).toBe(500); // Feb: expense
      expect(result[3].totalIncome).toBe(0);     // Apr: no income (already received)
    });
  });

  describe('empty inputs', () => {
    it('returns unchanged starting balance with no items', () => {
      const result = calculateProjection(account, [], []);

      expect(result).toHaveLength(6);
      for (const month of result) {
        expect(month.totalIncome).toBe(0);
        expect(month.totalExpenses).toBe(0);
        expect(month.endingBalance).toBe(5000);
      }
    });
  });

  describe('filters', () => {
    it('category filter excludes non-matching items', () => {
      const salary = createMockRecurringItem({
        accountId: account.id,
        type: 'income',
        amount: 3000,
        category: 'Salary',
      });
      const freelance = createMockRecurringItem({
        accountId: account.id,
        type: 'income',
        amount: 1000,
        category: 'Freelance',
      });

      const result = calculateProjection(account, [salary, freelance], [], [], {
        categories: ['Salary'],
      });

      expect(result[0].totalIncome).toBe(3000); // Only salary
    });
  });

  describe('snapshot anchoring', () => {
    it('re-anchors on a later snapshot (month + reconciled balance)', () => {
      const income = createMockRecurringItem({ accountId: account.id, type: 'income', amount: 3000, frequency: 'monthly', startDate: '2026-01' });
      const expense = createMockRecurringItem({ accountId: account.id, type: 'expense', amount: 2000, frequency: 'monthly', startDate: '2026-01' });
      const snapshot = createMockSnapshot({ yearMonth: '2026-04', actualBalance: 9000 });

      const result = calculateProjection(account, [income, expense], [], [], undefined, snapshot);

      // Projection now starts at the snapshot month with the reconciled balance,
      // not at the genesis month with the genesis balance.
      expect(result[0].yearMonth).toBe('2026-04');
      expect(result[0].startingBalance).toBe(9000);
      expect(result[0].endingBalance).toBe(10000);
      // Rolling horizon of 6 months from the anchor: Apr..Sep
      expect(result).toHaveLength(6);
      expect(result[result.length - 1].yearMonth).toBe('2026-09');
    });

    it('ignores a snapshot earlier than the genesis month', () => {
      const income = createMockRecurringItem({ accountId: account.id, type: 'income', amount: 1000, frequency: 'monthly', startDate: '2026-01' });
      const snapshot = createMockSnapshot({ yearMonth: '2025-10', actualBalance: 99999 });

      const withSnap = calculateProjection(account, [income], [], [], undefined, snapshot);
      const without = calculateProjection(account, [income], []);

      expect(withSnap).toEqual(without);
      expect(withSnap[0].yearMonth).toBe('2026-01');
      expect(withSnap[0].startingBalance).toBe(5000);
    });

    it('anchors when the snapshot month equals the genesis month', () => {
      const snapshot = createMockSnapshot({ yearMonth: '2026-01', actualBalance: 7777 });
      const result = calculateProjection(account, [], [], [], undefined, snapshot);
      expect(result[0].yearMonth).toBe('2026-01');
      expect(result[0].startingBalance).toBe(7777);
    });

    it('falls back to genesis when the snapshot is null (backward compatible)', () => {
      const withNull = calculateProjection(account, [], [], [], undefined, null);
      const without = calculateProjection(account, [], []);
      expect(withNull).toEqual(without);
    });

    it('drops a pre-anchor recurring override once the projection re-anchors forward', () => {
      const recurring = createMockRecurringItem({ accountId: account.id, type: 'expense', amount: 1000, startDate: '2026-01' });
      const override = createMockPlannedItem({
        accountId: account.id, type: 'expense', kind: 'one-off', amount: 5000,
        scheduledDate: '2026-01', isRecurringOverride: true, linkedRecurringItemId: recurring.id,
      });
      const snapshot = createMockSnapshot({ yearMonth: '2026-04', actualBalance: 9000 });

      const result = calculateProjection(account, [recurring], [override], [], undefined, snapshot);

      // First projected month is the anchor (Apr); the Jan override is gone, so the original amount applies.
      expect(result[0].yearMonth).toBe('2026-04');
      expect(result[0].totalExpenses).toBe(1000);
    });
  });
});

describe('current-month actualization', () => {
  // Anchor month comes from latestSnapshot.yearMonth — the engine compares
  // yearMonth === anchor.startMonth and never reads the real clock, so any
  // month string works as "the anchor" for these tests.
  function txn(overrides: Partial<ActualTxLike> & { id: string; amount: number }): ActualTxLike {
    return { bookingDate: '2026-03-15', ...overrides };
  }

  const account = createMockAccount({
    startingBalance: 5000,
    startingDate: '2026-01',
    planningHorizonMonths: 6,
  });

  it('reduces a matched recurring expense to 0, chains the corrected ending balance, and stamps the row', () => {
    const groceries = createMockRecurringItem({
      accountId: account.id, type: 'expense', name: 'Groceries', amount: 400,
      category: 'Food & Groceries', frequency: 'monthly', startDate: '2026-01',
    });
    const salary = createMockRecurringItem({
      accountId: account.id, type: 'income', name: 'Salary', amount: 3000,
      category: 'Salary', frequency: 'monthly', startDate: '2026-01',
    });
    const snapshot = createMockSnapshot({ yearMonth: '2026-03', actualBalance: 9000 });
    const currentMonthActuals: CurrentMonthActuals = {
      transactions: [txn({ id: 't1', amount: -400, counterpartyName: 'Groceries' })],
    };

    const result = calculateProjection(
      account, [groceries, salary], [], [], undefined, snapshot, [], [], [], currentMonthActuals,
    );

    const anchorMonth = result[0];
    expect(anchorMonth.yearMonth).toBe('2026-03');
    expect(anchorMonth.isActualized).toBe(true);
    expect(anchorMonth.plannedTotalIncome).toBe(3000);
    expect(anchorMonth.plannedTotalExpenses).toBe(400);
    // Groceries is fully matched -> excluded from totals; salary is unmatched -> stays in full.
    expect(anchorMonth.totalExpenses).toBe(0);
    expect(anchorMonth.totalIncome).toBe(3000);
    expect(anchorMonth.netChange).toBe(3000);
    expect(anchorMonth.startingBalance).toBe(9000);
    expect(anchorMonth.endingBalance).toBe(12000);

    const groceriesLine = anchorMonth.expenseBreakdown.find((l) => l.name === 'Groceries')!;
    expect(groceriesLine.isPaid).toBe(true);
    expect(groceriesLine.remainingAmount).toBe(0);
    expect(groceriesLine.matchedTxId).toBe('t1');

    const salaryLine = anchorMonth.incomeBreakdown.find((l) => l.name === 'Salary')!;
    expect(salaryLine.isPaid).toBe(false);
    expect(salaryLine.remainingAmount).toBe(3000);

    // The NEXT month's starting balance chains from the corrected ending balance.
    expect(result[1].yearMonth).toBe('2026-04');
    expect(result[1].startingBalance).toBe(12000);
  });

  it('omitted / null / empty-transactions param produces output identical to the run without it (regression guard)', () => {
    const groceries = createMockRecurringItem({
      accountId: account.id, type: 'expense', name: 'Groceries', amount: 400,
      category: 'Food & Groceries', frequency: 'monthly', startDate: '2026-01',
    });
    const snapshot = createMockSnapshot({ yearMonth: '2026-03', actualBalance: 9000 });

    const baseline = calculateProjection(account, [groceries], [], [], undefined, snapshot);
    const withoutParam = calculateProjection(account, [groceries], [], [], undefined, snapshot, [], [], []);
    const withUndefined = calculateProjection(account, [groceries], [], [], undefined, snapshot, [], [], [], undefined);
    const withNull = calculateProjection(account, [groceries], [], [], undefined, snapshot, [], [], [], null);
    const withEmptyTx = calculateProjection(account, [groceries], [], [], undefined, snapshot, [], [], [], { transactions: [] });

    expect(withoutParam).toEqual(baseline);
    expect(withUndefined).toEqual(baseline);
    expect(withNull).toEqual(baseline);
    expect(withEmptyTx).toEqual(baseline);
    expect(baseline[0].isActualized).toBeUndefined();
  });

  it('only actualizes the anchor month; later months carry no isActualized flag', () => {
    const groceries = createMockRecurringItem({
      accountId: account.id, type: 'expense', name: 'Groceries', amount: 400,
      category: 'Food & Groceries', frequency: 'monthly', startDate: '2026-01',
    });
    const snapshot = createMockSnapshot({ yearMonth: '2026-03', actualBalance: 9000 });
    const currentMonthActuals: CurrentMonthActuals = {
      transactions: [txn({ id: 't1', amount: -400, counterpartyName: 'Groceries' })],
    };

    const result = calculateProjection(account, [groceries], [], [], undefined, snapshot, [], [], [], currentMonthActuals);

    expect(result[0].isActualized).toBe(true);
    for (const month of result.slice(1)) {
      expect(month.isActualized).toBeUndefined();
      expect(month.plannedTotalIncome).toBeUndefined();
      expect(month.plannedTotalExpenses).toBeUndefined();
    }
  });

  it('an occurrence override changes the effective amount, and matching applies to the override amount', () => {
    const recurring = createMockRecurringItem({
      accountId: account.id, type: 'expense', name: 'Internet', amount: 1000, startDate: '2026-01',
    });
    const override = createMockPlannedItem({
      accountId: account.id, type: 'expense', kind: 'one-off', name: 'Internet override',
      amount: 1200, scheduledDate: '2026-03', isRecurringOverride: true, linkedRecurringItemId: recurring.id,
    });
    const snapshot = createMockSnapshot({ yearMonth: '2026-03', actualBalance: 9000 });
    const currentMonthActuals: CurrentMonthActuals = {
      // Matches the OVERRIDDEN amount (1200), not the original recurring amount (1000).
      transactions: [txn({ id: 't1', amount: -1200 })],
    };

    const result = calculateProjection(account, [recurring], [override], [], undefined, snapshot, [], [], [], currentMonthActuals);

    const line = result[0].expenseBreakdown.find((l) => l.itemId === recurring.id)!;
    expect(line.amount).toBe(1200);
    expect(line.isPaid).toBe(true);
    expect(line.remainingAmount).toBe(0);
    expect(result[0].totalExpenses).toBe(0);
    expect(result[0].plannedTotalExpenses).toBe(1200);
  });

  it('taxed income matches at netAmount (income credit within tolerance of netAmount)', () => {
    const taxedIncome = createMockTaxedIncome({
      accountId: account.id, kind: 'one-off', name: 'Bonus', netAmount: 3100, grossAmount: 5000, scheduledDate: '2026-03',
    });
    const snapshot = createMockSnapshot({ yearMonth: '2026-03', actualBalance: 9000 });
    const currentMonthActuals: CurrentMonthActuals = {
      transactions: [txn({ id: 't1', amount: 3100, counterpartyName: 'Bonus' })],
    };

    const result = calculateProjection(account, [], [], [taxedIncome], undefined, snapshot, [], [], [], currentMonthActuals);

    const line = result[0].incomeBreakdown.find((l) => l.source === 'taxed-income')!;
    expect(line.isPaid).toBe(true);
    expect(line.remainingAmount).toBe(0);
    expect(result[0].totalIncome).toBe(0);
  });

  it('an unmatched income line stays fully in totals (e.g. salary not yet arrived)', () => {
    const salary = createMockRecurringItem({
      accountId: account.id, type: 'income', name: 'Salary', amount: 3000, startDate: '2026-01',
    });
    const snapshot = createMockSnapshot({ yearMonth: '2026-03', actualBalance: 9000 });
    const currentMonthActuals: CurrentMonthActuals = {
      // No transaction matches the salary; unrelated debit present.
      transactions: [txn({ id: 't1', amount: -20, counterpartyName: 'Coffee shop' })],
    };

    const result = calculateProjection(account, [salary], [], [], undefined, snapshot, [], [], [], currentMonthActuals);

    const line = result[0].incomeBreakdown.find((l) => l.name === 'Salary')!;
    expect(line.isPaid).toBe(false);
    expect(line.remainingAmount).toBe(3000);
    expect(result[0].totalIncome).toBe(3000);
  });

  it('a statement-basis credit-card bill is exact-matched; an open-cycle bill is left untouched even with a matching debit', () => {
    const snapshot = createMockSnapshot({ yearMonth: '2026-03', actualBalance: 9000 });
    const cardBillTransfers: CardBillTransfer[] = [
      { yearMonth: '2026-03', linkId: 'card-a', cardName: 'Visa', amount: 250, isEstimate: false, basis: 'statement' },
      { yearMonth: '2026-03', linkId: 'card-b', cardName: 'Amex', amount: 250, isEstimate: false, basis: 'open-cycle' },
    ];
    const currentMonthActuals: CurrentMonthActuals = {
      transactions: [
        txn({ id: 'pay-a', amount: -250, counterpartyName: 'Visa' }),
        txn({ id: 'pay-b', amount: -250, counterpartyName: 'Amex' }),
      ],
    };

    const result = calculateProjection(account, [], [], [], undefined, snapshot, [], [], cardBillTransfers, currentMonthActuals);

    const statementLine = result[0].expenseBreakdown.find((l) => l.itemId === 'card-a')!;
    const openCycleLine = result[0].expenseBreakdown.find((l) => l.itemId === 'card-b')!;
    expect(statementLine.isPaid).toBe(true);
    expect(statementLine.remainingAmount).toBe(0);
    // 'none' policy: never touched, even though a same-amount debit exists.
    expect(openCycleLine.isPaid).toBe(false);
    expect(openCycleLine.remainingAmount).toBe(250);
    expect(result[0].totalExpenses).toBe(250); // only the untouched open-cycle bill remains
  });

  it('a mortgage-payment transfer is exact-matched by amount; unmatched same-category spend does not reduce it', () => {
    const snapshot = createMockSnapshot({ yearMonth: '2026-03', actualBalance: 9000 });
    const mortgageTransfers: MortgageTransfer[] = [
      { yearMonth: '2026-03', mortgageId: 'm1', mortgageName: 'Home', amount: 800 },
    ];
    const currentMonthActuals: CurrentMonthActuals = {
      transactions: [
        txn({ id: 'mortgage-pay', amount: -800, counterpartyName: 'Home' }),
        // Unrelated Housing-category spend that must NOT gap-reduce the exact-only mortgage line.
        txn({ id: 'housing-extra', amount: -150, counterpartyName: 'Vuokra deposit' }),
      ],
    };

    const result = calculateProjection(account, [], [], [], undefined, snapshot, mortgageTransfers, [], [], currentMonthActuals);

    const line = result[0].expenseBreakdown.find((l) => l.source === 'mortgage-payment')!;
    expect(line.isPaid).toBe(true);
    expect(line.remainingAmount).toBe(0);
  });

  it('does not gap-reduce a budget-injected expense line (policy "none")', () => {
    const snapshot = createMockSnapshot({ yearMonth: '2026-03', actualBalance: 9000 });
    const budgetTransfers: BudgetTransfer[] = [
      { yearMonth: '2026-03', budgetId: 'b1', budgetName: 'Trip', amount: 600, direction: 'expense' },
    ];
    const currentMonthActuals: CurrentMonthActuals = {
      transactions: [txn({ id: 't1', amount: -600, counterpartyName: 'Trip' })],
    };

    const result = calculateProjection(account, [], [], [], undefined, snapshot, [], budgetTransfers, [], currentMonthActuals);

    const line = result[0].expenseBreakdown.find((l) => l.source === 'budget')!;
    expect(line.isPaid).toBe(false);
    expect(line.remainingAmount).toBe(600);
    expect(result[0].totalExpenses).toBe(600);
  });

  it('category gap: a Groceries recurring expense is partially reduced by unmatched grocery-store debits', () => {
    // guessItemCategory maps "Prisma"/"K-Market" to 'Food & Groceries' (src/lib/category-utils.ts).
    const groceries = createMockRecurringItem({
      accountId: account.id, type: 'expense', name: 'Groceries', amount: 400,
      category: 'Food & Groceries', frequency: 'monthly', startDate: '2026-01',
    });
    const snapshot = createMockSnapshot({ yearMonth: '2026-03', actualBalance: 9000 });
    const currentMonthActuals: CurrentMonthActuals = {
      // Neither debit exactly matches the 400 line, so phase 1 skips them; they fall
      // into unmatchedSpendByCategory('Food & Groceries') = 150, gap-reducing the line.
      transactions: [
        txn({ id: 't1', amount: -90, counterpartyName: 'Prisma' }),
        txn({ id: 't2', amount: -60, counterpartyName: 'K-Market' }),
      ],
    };

    const result = calculateProjection(account, [groceries], [], [], undefined, snapshot, [], [], [], currentMonthActuals);

    const line = result[0].expenseBreakdown.find((l) => l.name === 'Groceries')!;
    expect(line.isPaid).toBe(false);
    expect(line.remainingAmount).toBeCloseTo(250, 5);
    expect(result[0].totalExpenses).toBeCloseTo(250, 5);
  });
});

describe('goal and trip transfers', () => {
  const account = createMockAccount({
    startingBalance: 5000,
    startingDate: '2026-01',
    planningHorizonMonths: 4,
  });

  it('emits a goal transfer as a "goal"-source expense line, category "Goals", in the right month only', () => {
    const goalTransfers: GoalTransfer[] = [
      { yearMonth: '2026-02', goalId: 'goal-1', goalName: 'New sofa', amount: 1200 },
    ];

    const result = calculateProjection(account, [], [], [], undefined, undefined, [], [], [], undefined, goalTransfers, []);

    expect(result[0].expenseBreakdown.find((l) => l.source === 'goal')).toBeUndefined();
    const line = result[1].expenseBreakdown.find((l) => l.source === 'goal')!;
    expect(line).toBeDefined();
    expect(line.itemId).toBe('goal-1');
    expect(line.name).toBe('Goal: New sofa');
    expect(line.amount).toBe(1200);
    expect(line.category).toBe('Goals');
    expect(result[1].totalExpenses).toBe(1200);
    expect(result[2].expenseBreakdown.find((l) => l.source === 'goal')).toBeUndefined();
  });

  it('emits a trip transfer as a "trip"-source income line in the right month only', () => {
    const tripTransfers: TripTransfer[] = [
      { yearMonth: '2026-03', tripId: 'trip-1', tripName: 'Stockholm conference', amount: 300 },
    ];

    const result = calculateProjection(account, [], [], [], undefined, undefined, [], [], [], undefined, [], tripTransfers);

    expect(result[1].incomeBreakdown.find((l) => l.source === 'trip')).toBeUndefined();
    const line = result[2].incomeBreakdown.find((l) => l.source === 'trip')!;
    expect(line).toBeDefined();
    expect(line.itemId).toBe('trip-1');
    expect(line.name).toBe('Per diem: Stockholm conference');
    expect(line.amount).toBe(300);
    expect(result[2].totalIncome).toBe(300);
  });

  it('skips zero and near-zero goal/trip transfer amounts', () => {
    const goalTransfers: GoalTransfer[] = [
      { yearMonth: '2026-01', goalId: 'goal-zero', goalName: 'Zero', amount: 0 },
      { yearMonth: '2026-01', goalId: 'goal-tiny', goalName: 'Tiny', amount: 0.004 },
    ];
    const tripTransfers: TripTransfer[] = [
      { yearMonth: '2026-01', tripId: 'trip-zero', tripName: 'Zero', amount: 0 },
    ];

    const result = calculateProjection(account, [], [], [], undefined, undefined, [], [], [], undefined, goalTransfers, tripTransfers);

    expect(result[0].expenseBreakdown).toHaveLength(0);
    expect(result[0].incomeBreakdown).toHaveLength(0);
  });

  it('defaults goalTransfers/tripTransfers to [] — existing positional callers are unaffected', () => {
    const income = createMockRecurringItem({ accountId: account.id, type: 'income', amount: 1000, startDate: '2026-01' });
    const baseline = calculateProjection(account, [income], []);
    const withExplicitEmpty = calculateProjection(account, [income], [], [], undefined, undefined, [], [], [], undefined, [], []);
    expect(withExplicitEmpty).toEqual(baseline);
  });
});

describe('resolveAnchor', () => {
  it('returns genesis when no snapshot is given', () => {
    expect(resolveAnchor('2026-01', 5000, null)).toEqual({ startMonth: '2026-01', startBalance: 5000 });
    expect(resolveAnchor('2026-01', 5000, undefined)).toEqual({ startMonth: '2026-01', startBalance: 5000 });
  });

  it('uses the snapshot when its month is after genesis', () => {
    const snap = createMockSnapshot({ yearMonth: '2026-05', actualBalance: 8000 });
    expect(resolveAnchor('2026-01', 5000, snap)).toEqual({ startMonth: '2026-05', startBalance: 8000 });
  });

  it('uses the snapshot at the genesis-month boundary', () => {
    const snap = createMockSnapshot({ yearMonth: '2026-01', actualBalance: 8000 });
    expect(resolveAnchor('2026-01', 5000, snap)).toEqual({ startMonth: '2026-01', startBalance: 8000 });
  });

  it('falls back to genesis when the snapshot predates it', () => {
    const snap = createMockSnapshot({ yearMonth: '2025-12', actualBalance: 8000 });
    expect(resolveAnchor('2026-01', 5000, snap)).toEqual({ startMonth: '2026-01', startBalance: 5000 });
  });

  it('negates a debt snapshot balance back to positive principal', () => {
    const snap = createMockSnapshot({ entityType: 'debt', yearMonth: '2026-03', actualBalance: -42000 });
    expect(resolveAnchor('2025-01', 50000, snap, true)).toEqual({ startMonth: '2026-03', startBalance: 42000 });
  });
});

describe('generateMonthList', () => {
  it('starts at startingDate with no anchor and spans the horizon', () => {
    const a = createMockAccount({ startingDate: '2026-01', planningHorizonMonths: 6 });
    const months = generateMonthList(a);
    expect(months).toHaveLength(6);
    expect(months[0]).toBe('2026-01');
    expect(months[5]).toBe('2026-06');
  });

  it('starts at the anchor month with a rolling horizon', () => {
    const a = createMockAccount({ startingDate: '2026-01', planningHorizonMonths: 6 });
    const months = generateMonthList(a, { startMonth: '2026-04', startBalance: 0 });
    expect(months).toHaveLength(6);
    expect(months[0]).toBe('2026-04');
    expect(months[5]).toBe('2026-09');
  });

  it('respects customEndDate when the anchor is before it', () => {
    const a = createMockAccount({ startingDate: '2026-01', planningHorizonMonths: -1, customEndDate: '2026-06' });
    const months = generateMonthList(a, { startMonth: '2026-03', startBalance: 0 });
    expect(months[0]).toBe('2026-03');
    expect(months[months.length - 1]).toBe('2026-06');
  });

  it('returns an empty list when the anchor is past customEndDate', () => {
    const a = createMockAccount({ startingDate: '2026-01', planningHorizonMonths: -1, customEndDate: '2026-06' });
    const months = generateMonthList(a, { startMonth: '2026-09', startBalance: 0 });
    expect(months).toHaveLength(0);
  });
});

describe('calculateYearlyRollups', () => {
  it('groups months by year with correct totals', () => {
    const account = createMockAccount({
      startingBalance: 0,
      startingDate: '2026-01',
      planningHorizonMonths: 24,
    });
    const income = createMockRecurringItem({
      accountId: account.id,
      type: 'income',
      amount: 1000,
      startDate: '2026-01',
    });

    const monthly = calculateProjection(account, [income], []);
    const yearly = calculateYearlyRollups(monthly);

    expect(yearly).toHaveLength(2);
    expect(yearly[0].year).toBe(2026);
    expect(yearly[0].totalIncome).toBe(12000); // 12 months * 1000
    expect(yearly[1].year).toBe(2027);
    expect(yearly[1].totalIncome).toBe(12000);
  });
});
