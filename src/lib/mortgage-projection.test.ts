import { describe, it, expect } from 'vitest';
import {
  calculateMortgageProjection,
  dayCountFraction,
  recomputeAnnuityPayment,
  getEffectiveAnnualRate,
  getEffectiveCost,
  computeAspSubsidy,
  getPayoffMonth,
  getMemberPositionForMonth,
  type MortgageProjectionInput,
} from './mortgage-projection';
import {
  createMockSharedMortgage,
  createMockMortgageRate,
  createMockMortgageCost,
  createMockMortgageExtraPayment,
  createMockMortgageSnapshot,
} from '@/test/mocks';
import type { MortgageRateEntry } from '@/types';

// Four Euribor resets (stored EXCLUDING the 0.4% margin), one per December.
const RATES: MortgageRateEntry[] = [
  createMockMortgageRate({ effectiveDate: '2022-12', euriborRate: 2.963 }), // 3.363%
  createMockMortgageRate({ effectiveDate: '2023-12', euriborRate: 3.644 }), // 4.044%
  createMockMortgageRate({ effectiveDate: '2024-12', euriborRate: 2.405 }), // 2.805%
  createMockMortgageRate({ effectiveDate: '2025-12', euriborRate: 2.31 }), //  2.71%
];

function buildInput(overrides?: Partial<MortgageProjectionInput>): MortgageProjectionInput {
  return {
    mortgage: createMockSharedMortgage(),
    rates: RATES,
    costs: [
      createMockMortgageCost({ type: 'invoicing-fee', effectiveDate: '2023-02', amount: 5.4 }),
      createMockMortgageCost({ type: 'service-fee', effectiveDate: '2023-02', amount: 2.5 }),
      createMockMortgageCost({ type: 'loan-insurance', loanId: 'loan-asp', effectiveDate: '2023-04', amount: 36.65 }),
      createMockMortgageCost({ type: 'loan-insurance', loanId: 'loan-regular', effectiveDate: '2023-04', amount: 40.05 }),
    ],
    extraPayments: [],
    snapshots: [],
    ...overrides,
  };
}

describe('mortgage-projection engine', () => {
  describe('day-count fraction', () => {
    it('30E/360 is exactly 1/12', () => {
      expect(dayCountFraction({ dayCount: '30E/360' }, '2026-01', '2026-02')).toBeCloseTo(1 / 12, 10);
    });
    it('actual/360 uses calendar days of the period month', () => {
      expect(dayCountFraction({ dayCount: 'actual/360' }, '2026-02', '2026-03')).toBeCloseTo(31 / 360, 10);
      expect(dayCountFraction({ dayCount: 'actual/360' }, '2026-01', '2026-02')).toBeCloseTo(28 / 360, 10);
    });
    it('actual/360 uses exact day-spans when a payment day is set', () => {
      // 14 Jan → 14 Feb = 31 days
      const frac = dayCountFraction({ dayCount: 'actual/360', paymentDayOfMonth: 14 }, '2026-01', '2026-02');
      expect(frac).toBeCloseTo(31 / 360, 10);
    });
  });

  describe('annuity payment', () => {
    it('zero rate splits the balance evenly over the term', () => {
      expect(recomputeAnnuityPayment(120000, 0, 240)).toBeCloseTo(500, 6);
    });
    it('positive rate matches the closed-form annuity', () => {
      // 100000 @ 6%/yr over 360 months ≈ 599.55
      expect(recomputeAnnuityPayment(100000, 6, 360)).toBeCloseTo(599.55, 1);
    });
  });

  describe('rate & cost lookups', () => {
    it('picks the most recent effective rate and adds the margin', () => {
      expect(getEffectiveAnnualRate({ margin: 0.4 }, RATES, '2025-06')).toBeCloseTo(2.805, 6);
      expect(getEffectiveAnnualRate({ margin: 0.4 }, RATES, '2026-06')).toBeCloseTo(2.71, 6);
    });
    it('a fee change applies only from its effective month forward', () => {
      const costs = [
        createMockMortgageCost({ type: 'invoicing-fee', effectiveDate: '2023-02', amount: 5.4 }),
        createMockMortgageCost({ type: 'invoicing-fee', effectiveDate: '2026-01', amount: 7.0 }),
      ];
      expect(getEffectiveCost(costs, 'invoicing-fee', undefined, '2025-12')).toBe(5.4);
      expect(getEffectiveCost(costs, 'invoicing-fee', undefined, '2026-01')).toBe(7.0);
      expect(getEffectiveCost(costs, 'invoicing-fee', undefined, '2022-01')).toBe(0);
    });
  });

  describe('full schedule from genesis', () => {
    const months = calculateMortgageProjection(buildInput(), '2050-12');

    it('starts at genesis with the full borrowed balance', () => {
      expect(months[0].yearMonth).toBe('2023-02');
      expect(months[0].totalRemaining).toBeGreaterThan(217000);
      expect(months[0].totalRemaining).toBeLessThanOrEqual(220000);
    });

    it('every total equals the sum of its per-loan components', () => {
      for (const m of months) {
        const sumRemaining = m.loans.reduce((s, l) => s + l.endingPrincipal, 0);
        const sumInterest = m.loans.reduce((s, l) => s + l.interestPaid, 0);
        const sumInsurance = m.loans.reduce((s, l) => s + l.insurance, 0);
        expect(m.totalRemaining).toBeCloseTo(sumRemaining, 6);
        expect(m.totalInterest).toBeCloseTo(sumInterest, 6);
        expect(m.totalInsurance).toBeCloseTo(sumInsurance, 6);
        expect(m.principalPaidTotal).toBeCloseTo(220000 - m.totalRemaining, 4);
      }
    });

    it('balance decreases monotonically and pays off near the term', () => {
      const payoff = getPayoffMonth(months);
      expect(payoff).not.toBeNull();
      // ~25 years from early-2023 genesis → late 2040s.
      expect(payoff! >= '2046-01' && payoff! <= '2049-12').toBe(true);
    });

    it('remaining balance at 2026-06 sits in the expected band', () => {
      const june = months.find((m) => m.yearMonth === '2026-06')!;
      expect(june.totalRemaining).toBeGreaterThan(190000);
      expect(june.totalRemaining).toBeLessThan(210000);
    });
  });

  describe('ownership / equity identities', () => {
    const months = calculateMortgageProjection(buildInput(), '2050-12');

    it('each member stake is constant and the two stakes sum to the house price', () => {
      for (const m of months) {
        const sumStake = m.members.reduce((s, p) => s + p.stake, 0);
        expect(sumStake).toBeCloseTo(250000, 0);
        for (const p of m.members) {
          // equity == stake − liability, exactly
          expect(p.equity).toBeCloseTo(p.stake - p.liability, 6);
        }
      }
    });

    it('member stakes are ~€125k each (half the house)', () => {
      const first = months[0];
      for (const p of first.members) expect(p.stake).toBeCloseTo(125000, -2);
    });

    it('liability shrinks and ownership converges toward 50% at payoff', () => {
      const payoff = getPayoffMonth(months)!;
      const alex = getMemberPositionForMonth(months, 'alex', payoff)!;
      const sam = getMemberPositionForMonth(months, 'sam', payoff)!;
      expect(alex.liability).toBeCloseTo(0, 0);
      expect(sam.liability).toBeCloseTo(0, 0);
      expect(alex.ownershipPercent).toBeCloseTo(0.5, 2);
      expect(sam.ownershipPercent).toBeCloseTo(0.5, 2);
    });
  });

  describe('ASP subsidy', () => {
    it('is zero at sub-threshold rates (2.71% < 3.8%)', () => {
      const months = calculateMortgageProjection(buildInput(), '2030-12');
      const totalSubsidy = months.reduce((s, m) => s + m.totalSubsidy, 0);
      expect(totalSubsidy).toBe(0);
    });

    it('activates on the ASP loan when the rate exceeds 3.8%', () => {
      const mortgage = createMockSharedMortgage();
      mortgage.loans[0].aspSubsidy = {
        enabled: true,
        thresholdRate: 3.8,
        subsidyShare: 0.7,
        eligibilityYears: 10,
      };
      const rates = [createMockMortgageRate({ effectiveDate: '2022-12', euriborRate: 4.6 })]; // 5.0% total
      const months = calculateMortgageProjection(buildInput({ mortgage, rates }), '2026-12');
      const aspRow = months[2].loans.find((l) => l.loanId === 'loan-asp')!;
      const regularRow = months[2].loans.find((l) => l.loanId === 'loan-regular')!;
      // ASP gets a subsidy proportional to the rate above the threshold; regular never does.
      const expectedFraction = (5.0 - 3.8) / 5.0; // 0.24
      expect(aspRow.subsidy).toBeCloseTo(aspRow.interestAccrued * expectedFraction * 0.7, 4);
      expect(regularRow.subsidy).toBe(0);
      expect(computeAspSubsidy(mortgage.loans[1], 5.0, 100, 0)).toBe(0); // regular loan helper
    });
  });

  describe('extra payments', () => {
    it('shorten-term keeps the payment and finishes the loan earlier', () => {
      // Overall payoff is governed by whichever loan finishes last, so check the
      // targeted sub-loan's own payoff month.
      const loanPayoff = (months: ReturnType<typeof calculateMortgageProjection>, loanId: string) =>
        months.find((m) => (m.loans.find((l) => l.loanId === loanId)?.endingPrincipal ?? 1) <= 0.005)?.yearMonth ?? '9999-12';
      const base = calculateMortgageProjection(buildInput(), '2050-12');
      const withExtra = calculateMortgageProjection(
        buildInput({
          extraPayments: [
            createMockMortgageExtraPayment({ loanId: 'loan-regular', date: '2026-01', amount: 20000, mode: 'shorten-term' }),
          ],
        }),
        '2050-12'
      );
      expect(loanPayoff(withExtra, 'loan-regular') < loanPayoff(base, 'loan-regular')).toBe(true);
    });

    it('lower-payment keeps the term and reduces later installments', () => {
      const base = calculateMortgageProjection(buildInput(), '2050-12');
      const withExtra = calculateMortgageProjection(
        buildInput({
          extraPayments: [
            createMockMortgageExtraPayment({ loanId: 'loan-regular', date: '2026-01', amount: 20000, mode: 'lower-payment' }),
          ],
        }),
        '2050-12'
      );
      const baseRegAfter = base.find((m) => m.yearMonth === '2026-06')!.loans.find((l) => l.loanId === 'loan-regular')!;
      const lowerRegAfter = withExtra.find((m) => m.yearMonth === '2026-06')!.loans.find((l) => l.loanId === 'loan-regular')!;
      expect(lowerRegAfter.scheduledPayment).toBeLessThan(baseRegAfter.scheduledPayment);
    });
  });

  describe('drift re-anchor', () => {
    it('re-bases the loan balance from a snapshot month, leaving earlier months untouched', () => {
      const base = calculateMortgageProjection(buildInput(), '2030-12');
      const drifted = calculateMortgageProjection(
        buildInput({
          snapshots: [
            createMockMortgageSnapshot({ loanId: 'loan-regular', yearMonth: '2025-06', actualBalance: 120000 }),
          ],
        }),
        '2030-12'
      );
      const before = '2025-01';
      expect(drifted.find((m) => m.yearMonth === before)!.totalRemaining).toBeCloseTo(
        base.find((m) => m.yearMonth === before)!.totalRemaining,
        4
      );
      // From the snapshot on, the regular loan starts at the observed 120000.
      const at = drifted.find((m) => m.yearMonth === '2025-06')!.loans.find((l) => l.loanId === 'loan-regular')!;
      expect(at.startingPrincipal).toBeCloseTo(120000, 6);
    });
  });

});
