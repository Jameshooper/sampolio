import { describe, it, expect } from 'vitest';
import { deriveLoanShares, isEuriborUpdateDue, buildMortgageSankeySnapshot } from './mortgage-utils';
import { calculateMortgageProjection } from './mortgage-projection';
import { createMockSharedMortgage, createMockMortgageRate, createMockMortgageCost } from '@/test/mocks';

describe('deriveLoanShares', () => {
  it('derives the loan split from unequal down payments', () => {
    const shares = deriveLoanShares(250000, [18000, 12000], [0.5, 0.5]);
    expect(shares[0]).toBeCloseTo(0.486, 3);
    expect(shares[1]).toBeCloseTo(0.514, 3);
    expect(shares[0] + shares[1]).toBeCloseTo(1, 10);
  });

  it('equal down payments give an equal split', () => {
    const shares = deriveLoanShares(300000, [50000, 50000], [0.5, 0.5]);
    expect(shares[0]).toBeCloseTo(0.5, 10);
    expect(shares[1]).toBeCloseTo(0.5, 10);
  });

  it('unequal targets shift the loan share accordingly', () => {
    // Equal down payments but a 60/40 target → person aiming for 60% carries more loan.
    const shares = deriveLoanShares(300000, [50000, 50000], [0.6, 0.4]);
    expect(shares[0]).toBeGreaterThan(shares[1]);
    expect(shares[0] + shares[1]).toBeCloseTo(1, 10);
  });

  it('falls back to an even split when everyone is already at target', () => {
    const shares = deriveLoanShares(300000, [150000, 150000], [0.5, 0.5]);
    expect(shares[0]).toBeCloseTo(0.5, 10);
  });
});

describe('buildMortgageSankeySnapshot', () => {
  const mortgage = createMockSharedMortgage();
  const input = {
    mortgage,
    rates: [createMockMortgageRate({ effectiveDate: '2022-12', euriborRate: 2.963 })],
    costs: [
      createMockMortgageCost({ type: 'invoicing-fee', effectiveDate: '2023-02', amount: 5.4 }),
      createMockMortgageCost({ type: 'service-fee', effectiveDate: '2023-02', amount: 2.5 }),
      createMockMortgageCost({ type: 'loan-insurance', loanId: 'loan-asp', effectiveDate: '2023-04', amount: 36.65 }),
    ],
    extraPayments: [],
    snapshots: [],
  };
  // Run past payoff so lifetime totals are final.
  const months = calculateMortgageProjection(input, '2050-02');

  it('returns null for an empty schedule', () => {
    expect(buildMortgageSankeySnapshot([], mortgage, 0)).toBeNull();
  });

  it('left, middle, and right flows balance at any scrubber position', () => {
    for (const idx of [0, 12, 100, months.length - 1]) {
      const s = buildMortgageSankeySnapshot(months, mortgage, idx)!;
      const left = s.members.reduce((sum, m) => sum + m.paidSoFar, 0) + s.stillToPay;
      const right =
        s.interestPaid + s.amortizationPaid + s.interestLeft + s.amortizationLeft + s.downPayments + s.feesAndInsurance;
      expect(left).toBeCloseTo(s.wholeMortgage, 6);
      expect(right).toBeCloseTo(s.wholeMortgage, 6);
    }
  });

  it('paid buckets grow and left buckets shrink as the scrubber advances', () => {
    const early = buildMortgageSankeySnapshot(months, mortgage, 12)!;
    const late = buildMortgageSankeySnapshot(months, mortgage, 120)!;
    expect(late.interestPaid).toBeGreaterThan(early.interestPaid);
    expect(late.amortizationPaid).toBeGreaterThan(early.amortizationPaid);
    expect(late.interestLeft).toBeLessThan(early.interestLeft);
    expect(late.amortizationLeft).toBeLessThan(early.amortizationLeft);
    expect(late.stillToPay).toBeLessThan(early.stillToPay);
  });

  it('at the end of the schedule nothing is left to pay', () => {
    const s = buildMortgageSankeySnapshot(months, mortgage, months.length - 1)!;
    expect(s.interestLeft).toBeCloseTo(0, 6);
    expect(s.amortizationLeft).toBeCloseTo(0, 6);
    expect(s.stillToPay).toBeCloseTo(0, 6);
    expect(s.amortizationPaid).toBeCloseTo(mortgage.loans.reduce((sum, l) => sum + l.initialPrincipal, 0), 2);
  });

  it('members include the down payment from month zero', () => {
    const s = buildMortgageSankeySnapshot(months, mortgage, 0)!;
    const alex = s.members.find((m) => m.name === 'Alex')!;
    expect(alex.paidSoFar).toBeGreaterThanOrEqual(18000);
  });
});

describe('isEuriborUpdateDue', () => {
  const mortgage = { rateResetMonth: 12, rateResetDay: 14 };

  it('is due in the window after a reset when no rate for the cycle exists', () => {
    const now = new Date(2026, 11, 20); // 20 Dec 2026, just after the reset
    const info = isEuriborUpdateDue(mortgage, [createMockMortgageRate({ effectiveDate: '2025-12' })], now);
    expect(info.due).toBe(true);
    expect(info.resetYearMonth).toBe('2026-12');
  });

  it('is not due once the current cycle rate is entered', () => {
    const now = new Date(2026, 11, 20);
    const info = isEuriborUpdateDue(mortgage, [createMockMortgageRate({ effectiveDate: '2026-12' })], now);
    expect(info.due).toBe(false);
  });

  it('is not due mid-year (far from the reset date)', () => {
    const now = new Date(2026, 5, 1); // June
    const info = isEuriborUpdateDue(mortgage, [createMockMortgageRate({ effectiveDate: '2025-12' })], now);
    expect(info.due).toBe(false);
    expect(info.nextResetDate.getFullYear()).toBe(2026);
    expect(info.nextResetDate.getMonth()).toBe(11);
  });
});
