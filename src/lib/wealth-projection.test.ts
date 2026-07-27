import { describe, it, expect } from 'vitest';
import { calculateWealthProjection } from './wealth-projection';
import type { WealthProjectionData } from './wealth-projection';
import {
  createMockAccount,
  createMockDebt,
  createMockInvestment,
  createMockContribution,
  createMockReceivable,
  createMockReferenceRate,
  createMockExtraPayment,
  createMockSnapshot,
  createMockSharedMortgage,
  createMockMortgageRate,
} from '@/test/mocks';
import { calculateMortgageProjection } from './mortgage-projection';

function buildWealthData(overrides?: Partial<WealthProjectionData>): WealthProjectionData {
  return {
    cashAccounts: [],
    cashProjections: new Map(),
    investments: [],
    investmentContributions: new Map(),
    receivables: [],
    receivableRepayments: new Map(),
    debts: [],
    debtReferenceRates: new Map(),
    debtExtraPayments: new Map(),
    ...overrides,
  };
}

describe('calculateWealthProjection', () => {
  describe('investment projection', () => {
    it('applies compound growth correctly', () => {
      const inv = createMockInvestment({
        startingValuation: 10000,
        annualGrowthRate: 12, // ~0.949% monthly
        valuationDate: '2026-01',
      });

      const data = buildWealthData({
        investments: [inv],
        investmentContributions: new Map([[inv.id, []]]),
      });

      const result = calculateWealthProjection(data, '2026-01', '2026-12');

      expect(result).toHaveLength(12);
      // After 12 months at 12% annual, should be ~11268
      expect(result[11].investmentsTotal).toBeGreaterThan(11200);
      expect(result[11].investmentsTotal).toBeLessThan(11300);
    });

    it('includes contributions in growth', () => {
      const inv = createMockInvestment({
        startingValuation: 10000,
        annualGrowthRate: 0, // no growth, just contributions
        valuationDate: '2026-01',
      });

      const contrib = createMockContribution({
        investmentAccountId: inv.id,
        type: 'contribution',
        kind: 'recurring',
        amount: 500,
        frequency: 'monthly',
        startDate: '2026-01',
      });

      const data = buildWealthData({
        investments: [inv],
        investmentContributions: new Map([[inv.id, [contrib]]]),
      });

      const result = calculateWealthProjection(data, '2026-01', '2026-06');

      // After 6 months: 10000 + 6*500 = 13000
      expect(result[5].investmentsTotal).toBe(13000);
    });
  });

  describe('debt amortization', () => {
    it('fixed rate amortized debt reduces principal', () => {
      const debt = createMockDebt({
        debtType: 'amortized',
        initialPrincipal: 100000,
        interestModelType: 'fixed',
        fixedInterestRate: 3.6, // 0.3% monthly
        monthlyPayment: 1000,
        startDate: '2026-01',
      });

      const data = buildWealthData({
        debts: [debt],
        debtReferenceRates: new Map([[debt.id, []]]),
        debtExtraPayments: new Map([[debt.id, []]]),
      });

      const result = calculateWealthProjection(data, '2026-01', '2026-06');

      // Month 1: interest = 100000 * 0.003 = 300, principal paid = 700
      // Remaining = 99300
      expect(result[0].debtsTotal).toBeCloseTo(99300, 0);
      // Debt total should decrease each month
      expect(result[5].debtsTotal).toBeLessThan(result[0].debtsTotal);
    });

    it('extra payments reduce principal faster', () => {
      const debt = createMockDebt({
        debtType: 'amortized',
        initialPrincipal: 100000,
        interestModelType: 'fixed',
        fixedInterestRate: 3.6,
        monthlyPayment: 1000,
        startDate: '2026-01',
      });

      const extra = createMockExtraPayment({
        debtId: debt.id,
        date: '2026-03',
        amount: 5000,
      });

      const dataNoExtra = buildWealthData({
        debts: [debt],
        debtReferenceRates: new Map([[debt.id, []]]),
        debtExtraPayments: new Map([[debt.id, []]]),
      });

      const dataWithExtra = buildWealthData({
        debts: [debt],
        debtReferenceRates: new Map([[debt.id, []]]),
        debtExtraPayments: new Map([[debt.id, [extra]]]),
      });

      const resultNoExtra = calculateWealthProjection(dataNoExtra, '2026-01', '2026-06');
      const resultWithExtra = calculateWealthProjection(dataWithExtra, '2026-01', '2026-06');

      // With extra payment, debt should be lower
      expect(resultWithExtra[5].debtsTotal).toBeLessThan(resultNoExtra[5].debtsTotal);
    });

    it('fixed-installment debt reduces without interest', () => {
      const debt = createMockDebt({
        debtType: 'fixed-installment',
        initialPrincipal: 6000,
        interestModelType: 'none',
        installmentAmount: 1000,
        totalInstallments: 6,
        startDate: '2026-01',
      });

      const data = buildWealthData({
        debts: [debt],
        debtReferenceRates: new Map([[debt.id, []]]),
        debtExtraPayments: new Map([[debt.id, []]]),
      });

      const result = calculateWealthProjection(data, '2026-01', '2026-06');

      expect(result[0].debtsTotal).toBe(5000);  // 6000 - 1000
      expect(result[5].debtsTotal).toBe(0);      // Fully paid
    });

    it('variable rate debt uses reference rates', () => {
      const debt = createMockDebt({
        debtType: 'amortized',
        initialPrincipal: 100000,
        interestModelType: 'variable',
        referenceRateMargin: 1.0,
        monthlyPayment: 1000,
        startDate: '2026-01',
      });

      const rate = createMockReferenceRate({
        debtId: debt.id,
        yearMonth: '2026-01',
        rate: 2.5, // reference rate
      });

      const data = buildWealthData({
        debts: [debt],
        debtReferenceRates: new Map([[debt.id, [rate]]]),
        debtExtraPayments: new Map([[debt.id, []]]),
      });

      const result = calculateWealthProjection(data, '2026-01', '2026-06');

      // Effective rate = 2.5 + 1.0 = 3.5% annual
      // Monthly rate = 3.5/100/12 = 0.002917
      // Month 1 interest: 100000 * 0.002917 ≈ 291.67
      // Principal paid: 1000 - 291.67 ≈ 708.33
      expect(result[0].debtsTotal).toBeGreaterThan(99200);
      expect(result[0].debtsTotal).toBeLessThan(99400);
    });
  });

  describe('receivable projection', () => {
    it('repayments reduce balance', () => {
      const rec = createMockReceivable({
        initialPrincipal: 5000,
        currentBalance: 5000,
        hasInterest: false,
        expectedMonthlyRepayment: 500,
        startDate: '2026-01',
      });

      const data = buildWealthData({
        receivables: [rec],
        receivableRepayments: new Map([[rec.id, []]]),
      });

      const result = calculateWealthProjection(data, '2026-01', '2026-06');

      // Expected: 5000, 4500, 4000, 3500, 3000, 2500
      expect(result[0].receivablesTotal).toBe(4500);
      expect(result[5].receivablesTotal).toBe(2000);
    });

    it('interest accrues on receivable', () => {
      const rec = createMockReceivable({
        initialPrincipal: 10000,
        currentBalance: 10000,
        hasInterest: true,
        annualInterestRate: 12, // 1% monthly
        expectedMonthlyRepayment: 0,
        startDate: '2026-01',
      });

      const data = buildWealthData({
        receivables: [rec],
        receivableRepayments: new Map([[rec.id, []]]),
      });

      const result = calculateWealthProjection(data, '2026-01', '2026-03');

      // Month 1: 10000 + 100 = 10100
      expect(result[0].receivablesTotal).toBeCloseTo(10100, 0);
    });
  });

  describe('coverage-tail fallbacks (regression)', () => {
    it('carries forward the last projected cash balance past projection coverage', () => {
      // Cash account with a genesis of 1000 but rows only for 3 months, ending
      // at 25000. Over a 6-month wealth window, months 4-6 fall past coverage.
      const account = createMockAccount({ startingBalance: 1000, startingDate: '2026-01', planningHorizonMonths: 3 });
      const data = buildWealthData({
        cashAccounts: [account],
        cashProjections: new Map([[account.id, [
          { yearMonth: '2026-01', year: 2026, month: 1, startingBalance: 1000, totalIncome: 0, totalExpenses: 0, netChange: 0, endingBalance: 9000, incomeBreakdown: [], expenseBreakdown: [] },
          { yearMonth: '2026-02', year: 2026, month: 2, startingBalance: 9000, totalIncome: 0, totalExpenses: 0, netChange: 0, endingBalance: 17000, incomeBreakdown: [], expenseBreakdown: [] },
          { yearMonth: '2026-03', year: 2026, month: 3, startingBalance: 17000, totalIncome: 0, totalExpenses: 0, netChange: 0, endingBalance: 25000, incomeBreakdown: [], expenseBreakdown: [] },
        ]]]),
      });

      const result = calculateWealthProjection(data, '2026-01', '2026-06');
      expect(result).toHaveLength(6);
      // Months 4-6 (indices 3-5): carry forward 25000, NOT collapse to 1000.
      expect(result[3].cashAccountsTotal).toBe(25000);
      expect(result[4].cashAccountsTotal).toBe(25000);
      expect(result[5].cashAccountsTotal).toBe(25000);
    });

    it('treats a fully-repaid receivable as 0 past its last projected row', () => {
      // 1000 receivable, 500/mo → repaid after month 2. Over a 6-month window,
      // months 3-6 must read 0, not resurrect at currentBalance.
      const rec = createMockReceivable({
        initialPrincipal: 1000, currentBalance: 1000, hasInterest: false,
        expectedMonthlyRepayment: 500, startDate: '2026-01',
      });
      const data = buildWealthData({
        receivables: [rec],
        receivableRepayments: new Map([[rec.id, []]]),
      });

      const result = calculateWealthProjection(data, '2026-01', '2026-06');
      expect(result).toHaveLength(6);
      expect(result[0].receivablesTotal).toBe(500); // 1000 - 500
      expect(result[1].receivablesTotal).toBe(0);   // fully repaid
      // Months 3-6: stays 0 (would be 1000 pre-fix).
      expect(result[2].receivablesTotal).toBe(0);
      expect(result[5].receivablesTotal).toBe(0);
    });

    it('uses startingBalance for cash months before projection coverage', () => {
      // Rows begin at month 3 of the window; months 1-2 precede coverage.
      const account = createMockAccount({ startingBalance: 4000, startingDate: '2026-03', planningHorizonMonths: 3 });
      const data = buildWealthData({
        cashAccounts: [account],
        cashProjections: new Map([[account.id, [
          { yearMonth: '2026-03', year: 2026, month: 3, startingBalance: 4000, totalIncome: 0, totalExpenses: 0, netChange: 0, endingBalance: 6000, incomeBreakdown: [], expenseBreakdown: [] },
          { yearMonth: '2026-04', year: 2026, month: 4, startingBalance: 6000, totalIncome: 0, totalExpenses: 0, netChange: 0, endingBalance: 8000, incomeBreakdown: [], expenseBreakdown: [] },
        ]]]),
      });

      const result = calculateWealthProjection(data, '2026-01', '2026-04');
      expect(result).toHaveLength(4);
      // Months 1-2 (Jan, Feb) precede the first row → startingBalance.
      expect(result[0].cashAccountsTotal).toBe(4000);
      expect(result[1].cashAccountsTotal).toBe(4000);
      // Month 3-4 use the projected rows.
      expect(result[2].cashAccountsTotal).toBe(6000);
      expect(result[3].cashAccountsTotal).toBe(8000);
    });
  });

  describe('net worth aggregation', () => {
    it('calculates net worth = assets - liabilities', () => {
      const account = createMockAccount({
        startingBalance: 10000,
        startingDate: '2026-01',
        planningHorizonMonths: 3,
      });
      const inv = createMockInvestment({
        startingValuation: 5000,
        annualGrowthRate: 0,
        valuationDate: '2026-01',
      });
      const debt = createMockDebt({
        debtType: 'fixed-installment',
        initialPrincipal: 3000,
        interestModelType: 'none',
        installmentAmount: 1000,
        totalInstallments: 3,
        startDate: '2026-01',
      });

      const data = buildWealthData({
        cashAccounts: [account],
        cashProjections: new Map([[account.id, [
          { yearMonth: '2026-01', year: 2026, month: 1, startingBalance: 10000, totalIncome: 0, totalExpenses: 0, netChange: 0, endingBalance: 10000, incomeBreakdown: [], expenseBreakdown: [] },
          { yearMonth: '2026-02', year: 2026, month: 2, startingBalance: 10000, totalIncome: 0, totalExpenses: 0, netChange: 0, endingBalance: 10000, incomeBreakdown: [], expenseBreakdown: [] },
          { yearMonth: '2026-03', year: 2026, month: 3, startingBalance: 10000, totalIncome: 0, totalExpenses: 0, netChange: 0, endingBalance: 10000, incomeBreakdown: [], expenseBreakdown: [] },
        ]]]),
        investments: [inv],
        investmentContributions: new Map([[inv.id, []]]),
        debts: [debt],
        debtReferenceRates: new Map([[debt.id, []]]),
        debtExtraPayments: new Map([[debt.id, []]]),
      });

      const result = calculateWealthProjection(data, '2026-01', '2026-03');

      // Month 1: cash 10000 + inv 5000 - debt 2000 = 13000
      expect(result[0].netWorth).toBe(13000);
      // Month 3: cash 10000 + inv 5000 - debt 0 = 15000
      expect(result[2].netWorth).toBe(15000);
    });
  });

  describe('snapshot anchoring', () => {
    it('anchors an investment on its latest snapshot (positive balance)', () => {
      const inv = createMockInvestment({ startingValuation: 10000, annualGrowthRate: 0, valuationDate: '2026-01' });
      const snapshot = createMockSnapshot({ entityType: 'investment', entityId: inv.id, yearMonth: '2026-03', actualBalance: 22000 });

      const data = buildWealthData({
        investments: [inv],
        investmentContributions: new Map([[inv.id, []]]),
        investmentSnapshots: new Map([[inv.id, snapshot]]),
      });

      const result = calculateWealthProjection(data, '2026-03', '2026-05');
      // No growth, no contributions → stays at the reconciled value, not the genesis 10000.
      expect(result[0].yearMonth).toBe('2026-03');
      expect(result[0].investmentsTotal).toBe(22000);
    });

    it('anchors a debt on its latest (negative) snapshot, abs back to principal', () => {
      const debt = createMockDebt({
        debtType: 'fixed-installment', initialPrincipal: 100000, interestModelType: 'none',
        installmentAmount: 1000, totalInstallments: 100, remainingInstallments: 10, startDate: '2025-01',
      });
      const snapshot = createMockSnapshot({ entityType: 'debt', entityId: debt.id, yearMonth: '2026-01', actualBalance: -8000 });

      const data = buildWealthData({
        debts: [debt],
        debtReferenceRates: new Map([[debt.id, []]]),
        debtExtraPayments: new Map([[debt.id, []]]),
        debtSnapshots: new Map([[debt.id, snapshot]]),
      });

      const result = calculateWealthProjection(data, '2026-01', '2026-03');
      // Anchored at 8000 principal (|−8000|); 1000/mo installment → 7000, 6000.
      expect(result[0].debtsTotal).toBe(7000);
      expect(result[1].debtsTotal).toBe(6000);
    });

    it('anchors a receivable on its latest snapshot', () => {
      const rec = createMockReceivable({
        initialPrincipal: 5000, currentBalance: 5000, hasInterest: false,
        expectedMonthlyRepayment: 500, startDate: '2025-06',
      });
      const snapshot = createMockSnapshot({ entityType: 'receivable', entityId: rec.id, yearMonth: '2026-01', actualBalance: 2000 });

      const data = buildWealthData({
        receivables: [rec],
        receivableRepayments: new Map([[rec.id, []]]),
        receivableSnapshots: new Map([[rec.id, snapshot]]),
      });

      const result = calculateWealthProjection(data, '2026-01', '2026-03');
      // Anchored at 2000, 500/mo repayment → 1500, 1000, 500.
      expect(result[0].receivablesTotal).toBe(1500);
      expect(result[2].receivablesTotal).toBe(500);
    });

    it('ignores a snapshot earlier than the entity genesis', () => {
      const inv = createMockInvestment({ startingValuation: 10000, annualGrowthRate: 0, valuationDate: '2026-06' });
      const snapshot = createMockSnapshot({ entityType: 'investment', entityId: inv.id, yearMonth: '2026-01', actualBalance: 99999 });

      const data = buildWealthData({
        investments: [inv],
        investmentContributions: new Map([[inv.id, []]]),
        investmentSnapshots: new Map([[inv.id, snapshot]]),
      });

      const result = calculateWealthProjection(data, '2026-06', '2026-07');
      expect(result[0].investmentsTotal).toBe(10000); // genesis, snapshot ignored
    });
  });

  describe('shared mortgage integration', () => {
    const rates = [
      createMockMortgageRate({ effectiveDate: '2022-12', euriborRate: 2.963 }),
      createMockMortgageRate({ effectiveDate: '2023-12', euriborRate: 3.644 }),
      createMockMortgageRate({ effectiveDate: '2024-12', euriborRate: 2.405 }),
      createMockMortgageRate({ effectiveDate: '2025-12', euriborRate: 2.31 }),
    ];
    const mortgageMonths = calculateMortgageProjection(
      { mortgage: createMockSharedMortgage(), rates, costs: [], extraPayments: [], snapshots: [] },
      '2050-12'
    );

    it('folds the member home equity into net worth (equity = stake − liability)', () => {
      const account = createMockAccount({ startingBalance: 10000, startingDate: '2026-06', planningHorizonMonths: 1 });
      const data = buildWealthData({
        cashAccounts: [account],
        cashProjections: new Map([[account.id, [{ yearMonth: '2026-06', year: 2026, month: 6, startingBalance: 10000, totalIncome: 0, totalExpenses: 0, netChange: 0, endingBalance: 10000, incomeBreakdown: [], expenseBreakdown: [] }]]]),
        mortgageProjections: [mortgageMonths],
        mortgageNames: ['Home'],
        currentUserId: 'alex',
      });
      const result = calculateWealthProjection(data, '2026-06', '2026-06');
      const m = result[0];
      expect(m.mortgageEquityTotal).toBeGreaterThan(0);
      expect(m.mortgageStakeTotal).toBeCloseTo(125000, -2);
      expect(m.mortgageEquityTotal!).toBeCloseTo(m.mortgageStakeTotal! - m.mortgageLiabilityTotal!, 4);
      expect(m.netWorth).toBeCloseTo(10000 + m.mortgageEquityTotal!, 4);
    });

    it('leaves net worth unchanged when no mortgage data is supplied (back-compat)', () => {
      const account = createMockAccount({ startingBalance: 10000, startingDate: '2026-06', planningHorizonMonths: 1 });
      const data = buildWealthData({
        cashAccounts: [account],
        cashProjections: new Map([[account.id, [{ yearMonth: '2026-06', year: 2026, month: 6, startingBalance: 10000, totalIncome: 0, totalExpenses: 0, netChange: 0, endingBalance: 10000, incomeBreakdown: [], expenseBreakdown: [] }]]]),
      });
      const result = calculateWealthProjection(data, '2026-06', '2026-06');
      expect(result[0].netWorth).toBe(10000);
      expect(result[0].mortgageEquityTotal).toBeUndefined();
    });
  });
});
