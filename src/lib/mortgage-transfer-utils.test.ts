import { describe, it, expect } from 'vitest';
import {
  buildOfferProjectionInput,
  computeTransferComparison,
  offerOneOffCosts,
  type TransferOfferParams,
} from './mortgage-transfer-utils';
import { calculateMortgageProjection, getPayoffMonth } from './mortgage-projection';
import { getMonthsBetween } from './projection';
import type { MortgageProjectionInputsResult } from '@/lib/actions/shared-mortgages';
import {
  createMockSharedMortgage,
  createMockMortgageLoan,
  createMockMortgageRate,
  createMockMortgageCost,
} from '@/test/mocks';

const REFI_START = '2025-08';
const CURRENT_MONTH = '2025-07'; // the month before refiStart
// Nominal remaining term of the 300-month loans (started 2023-02) at refiStart.
// Using the nominal term (not the drag-extended active-month count) keeps the
// offer's payoff aligned with the current loan when all else is equal.
const EQUAL_TERM = 300 - getMonthsBetween('2023-02', REFI_START); // 270

// A current mortgage whose effective rate (Euribor 4.0 + 0.4 margin = 4.4%) is
// ABOVE the 3.8% ASP threshold, so the ASP subsidy actually bites.
function buildCurrent(loansOverride?: Parameters<typeof createMockSharedMortgage>[0]): {
  currentInputs: MortgageProjectionInputsResult;
  realMonths: ReturnType<typeof calculateMortgageProjection>;
  currentRow: ReturnType<typeof calculateMortgageProjection>[number];
} {
  const mortgage = createMockSharedMortgage(
    loansOverride ?? {
      loans: [
        createMockMortgageLoan({
          id: 'loan-asp',
          label: 'ASP loan',
          kind: 'asp',
          initialPrincipal: 100000,
          startDate: '2023-02',
          originalTermMonths: 300,
          margin: 0.4,
          aspSubsidy: { enabled: true, thresholdRate: 3.8, subsidyShare: 0.7, eligibilityYears: 10 },
        }),
        createMockMortgageLoan({
          id: 'loan-regular',
          label: 'Regular loan',
          kind: 'regular',
          initialPrincipal: 120000,
          startDate: '2023-02',
          originalTermMonths: 300,
          margin: 0.4,
        }),
      ],
    }
  );
  const currentInputs: MortgageProjectionInputsResult = {
    mortgage,
    rates: [createMockMortgageRate({ effectiveDate: '2023-02', euriborRate: 4.0 })],
    costs: [
      createMockMortgageCost({ type: 'invoicing-fee', effectiveDate: '2023-02', amount: 5.4 }),
      createMockMortgageCost({ type: 'service-fee', effectiveDate: '2023-02', amount: 2.5 }),
      createMockMortgageCost({ type: 'loan-insurance', loanId: 'loan-asp', effectiveDate: '2023-02', amount: 36.65 }),
      createMockMortgageCost({ type: 'loan-insurance', loanId: 'loan-regular', effectiveDate: '2023-02', amount: 40.05 }),
    ],
    extraPayments: [],
    snapshots: [],
    actuals: [],
  };
  const realMonths = calculateMortgageProjection(
    { mortgage, rates: currentInputs.rates, costs: currentInputs.costs, extraPayments: [], snapshots: [], actuals: [] },
    '2055-12'
  );
  const currentRow = realMonths.find((m) => m.yearMonth === CURRENT_MONTH)!;
  return { currentInputs, realMonths, currentRow };
}

const baseOffer: TransferOfferParams = {
  margin: 0.4,
  euriborRate: 4.0,
  termMonths: 240,
  paymentMode: 'annuity-fixed-term',
  arrangementFee: 0,
  deedTransferFee: 0,
  otherOneOffCosts: 0,
  earlyRepaymentPenalty: 0,
  monthlyServiceFee: 0,
  monthlyInsurance: 0,
  retainAsp: true,
};

describe('mortgage-transfer-utils', () => {
  it('offerOneOffCosts sums the four one-off fields', () => {
    expect(
      offerOneOffCosts({ ...baseOffer, arrangementFee: 500, deedTransferFee: 44, otherOneOffCosts: 100, earlyRepaymentPenalty: 0 })
    ).toBe(644);
  });

  describe('buildOfferProjectionInput', () => {
    const { currentInputs, currentRow } = buildCurrent();

    it('refinances each sub-loan at its current balance, with the new margin/term and no members', () => {
      const input = buildOfferProjectionInput(currentInputs, currentRow, REFI_START, {
        ...baseOffer,
        margin: 0.25,
        termMonths: 200,
      });
      expect(input.mortgage.members).toEqual([]);
      expect(input.mortgage.loans).toHaveLength(2);
      for (const loan of input.mortgage.loans) {
        const bal = currentRow.loans.find((l) => l.loanId === loan.id)!.endingPrincipal;
        expect(loan.initialPrincipal).toBeCloseTo(bal, 6);
        expect(loan.startDate).toBe(REFI_START);
        expect(loan.originalTermMonths).toBe(200);
        expect(loan.margin).toBe(0.25);
        expect(loan.currentMonthlyPayment).toBeUndefined();
      }
      // One Euribor entry at the refi rate, and a service-fee cost entry.
      expect(input.rates).toHaveLength(1);
      expect(input.rates[0].euriborRate).toBe(4.0);
      expect(input.costs.some((c) => c.type === 'service-fee')).toBe(true);
    });

    it('drops the ASP subsidy config when retainAsp is false', () => {
      const kept = buildOfferProjectionInput(currentInputs, currentRow, REFI_START, { ...baseOffer, retainAsp: true });
      const dropped = buildOfferProjectionInput(currentInputs, currentRow, REFI_START, { ...baseOffer, retainAsp: false });
      const aspKept = kept.mortgage.loans.find((l) => l.id === 'loan-asp')!;
      const aspDropped = dropped.mortgage.loans.find((l) => l.id === 'loan-asp')!;
      expect(aspKept.aspSubsidy?.enabled).toBe(true);
      // Remaining eligibility window shrinks from the original 10 years (~2.5y elapsed).
      expect(aspKept.aspSubsidy!.eligibilityYears).toBeLessThan(10);
      expect(aspKept.aspSubsidy!.eligibilityYears).toBeGreaterThan(7);
      expect(aspDropped.aspSubsidy).toBeUndefined();
    });
  });

  describe('computeTransferComparison', () => {
    const { currentInputs, realMonths, currentRow } = buildCurrent();

    it('retaining ASP lowers out-of-pocket interest and yields subsidy vs dropping it', () => {
      const kept = computeTransferComparison(realMonths, currentInputs, currentRow, REFI_START, { ...baseOffer, retainAsp: true });
      const dropped = computeTransferComparison(realMonths, currentInputs, currentRow, REFI_START, { ...baseOffer, retainAsp: false });
      expect(kept.offer.totalSubsidy).toBeGreaterThan(0);
      expect(dropped.offer.totalSubsidy).toBe(0);
      expect(kept.offer.totalInterest).toBeLessThan(dropped.offer.totalInterest);
    });

    it('at an equal term, a lower margin produces a positive net lifetime saving', () => {
      const comp = computeTransferComparison(realMonths, currentInputs, currentRow, REFI_START, { ...baseOffer, termMonths: EQUAL_TERM, margin: 0.2 });
      expect(comp.netLifetimeSaving).toBeGreaterThan(0);
      expect(comp.breakEvenMonths).not.toBeNull();
    });

    it('at an equal term, a higher margin without ASP never breaks even (negative saving, null break-even)', () => {
      // retainAsp:false so the (rate-growing) ASP subsidy doesn't mask the hike.
      const comp = computeTransferComparison(realMonths, currentInputs, currentRow, REFI_START, { ...baseOffer, termMonths: EQUAL_TERM, margin: 1.2, retainAsp: false });
      expect(comp.netLifetimeSaving).toBeLessThan(0);
      expect(comp.breakEvenMonths).toBeNull();
    });

    it('one-off costs push out the break-even point', () => {
      const cheap = computeTransferComparison(realMonths, currentInputs, currentRow, REFI_START, { ...baseOffer, termMonths: EQUAL_TERM, margin: 0.2, arrangementFee: 0 });
      const pricey = computeTransferComparison(realMonths, currentInputs, currentRow, REFI_START, { ...baseOffer, termMonths: EQUAL_TERM, margin: 0.2, arrangementFee: 6000 });
      expect(cheap.breakEvenMonths).not.toBeNull();
      expect(pricey.breakEvenMonths).not.toBeNull();
      expect(pricey.breakEvenMonths!).toBeGreaterThan(cheap.breakEvenMonths!);
    });

    it('equal terms and matched costs keep payoff aligned with a negligible saving', () => {
      const matched = computeTransferComparison(realMonths, currentInputs, currentRow, REFI_START, {
        ...baseOffer,
        termMonths: EQUAL_TERM,
        monthlyServiceFee: 5.4 + 2.5, // current invoicing + service fee
        monthlyInsurance: 36.65 + 40.05, // current total insurance
      });
      // Same balance, rate, nominal term, fees → payoff aligns (±1mo) and cost is ~equal.
      const curPayoff = getPayoffMonth(realMonths)!;
      expect(Math.abs(getMonthsBetween(matched.offer.payoffMonth!, curPayoff))).toBeLessThanOrEqual(1);
      expect(Math.abs(matched.netLifetimeSaving)).toBeLessThan(0.02 * matched.current.lifetimeCost);
    });

    it('handles a mortgage with no ASP loan without crashing', () => {
      const { currentInputs: ci, realMonths: rm, currentRow: cr } = buildCurrent({
        loans: [
          createMockMortgageLoan({ id: 'loan-regular', kind: 'regular', initialPrincipal: 200000, startDate: '2023-02', originalTermMonths: 300, margin: 0.5 }),
        ],
      });
      const comp = computeTransferComparison(rm, ci, cr, REFI_START, { ...baseOffer, retainAsp: true, margin: 0.3 });
      expect(comp.offer.totalSubsidy).toBe(0);
      expect(comp.offer.startBalance).toBeGreaterThan(0);
      expect(comp.netLifetimeSaving).toBeGreaterThan(0); // lower margin
    });
  });
});
