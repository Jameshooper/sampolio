/**
 * Mortgage transfer / refinancing comparison (pure, no I/O).
 *
 * In Finland, "transferring" a mortgage to another bank is really a refinance:
 * the new bank grants a brand-new loan for the remaining balance and repays the
 * old one. This module turns a competing bank's offer (new margin, term, fees,
 * and whether the ASP state interest subsidy is retained) into a synthetic
 * `MortgageProjectionInput`, runs the existing amortization engine on it, and
 * compares its forward cost against the user's current mortgage — both anchored
 * at the same refinance month and holding Euribor flat, so the delta is driven
 * purely by margin / fees / ASP.
 *
 * Ephemeral: nothing here is persisted (mirrors the "What If?" playground).
 */

import type {
  YearMonth,
  MortgageLoan,
  MortgageRateEntry,
  MortgageCostEntry,
  MortgageProjectionMonth,
  SharedMortgage,
} from '@/types';
import type { MortgageProjectionInputsResult } from '@/lib/actions/shared-mortgages';
import type { MortgageOfferFormData } from '@/lib/schemas/mortgage.schema';
import { calculateMortgageProjection, type MortgageProjectionInput } from './mortgage-projection';
import { addMonths, compareYearMonths, getMonthsBetween } from './projection';

/** A competing bank's transfer offer (same shape as the form). */
export type TransferOfferParams = MortgageOfferFormData;

/** Cost summary for one scenario (current or offer), from `refiStart` to payoff. */
export interface ScenarioTotals {
  startBalance: number; // balance being amortized from refiStart
  allInRate: number; // effective annual rate now (Euribor + margin), balance-weighted
  firstMonthlyCharge: number; // first month's full household payment (P+I + fees + insurance)
  payoffMonth: YearMonth | null;
  remainingMonths: number; // payment months from refiStart to payoff
  totalInterest: number; // out-of-pocket interest (already net of ASP subsidy)
  totalSubsidy: number; // ASP subsidy received over the period (informational)
  totalFees: number; // service + invoicing fees over the period
  totalInsurance: number; // loan insurance over the period
  oneOffCosts: number; // one-off transfer costs (0 for current)
  lifetimeCost: number; // totalInterest + totalFees + totalInsurance + oneOffCosts
}

export interface TransferComparison {
  current: ScenarioTotals;
  offer: ScenarioTotals;
  netLifetimeSaving: number; // current.lifetimeCost − offer.lifetimeCost (positive = offer cheaper)
  breakEvenMonths: number | null; // months until cumulative saving covers one-off costs, else null
  series: { label: YearMonth; current: number; offer: number }[]; // cumulative cost-of-borrowing
}

/** Sum the one-off costs of switching banks. */
export function offerOneOffCosts(offer: TransferOfferParams): number {
  return (
    offer.arrangementFee + offer.deedTransferFee + offer.otherOneOffCosts + offer.earlyRepaymentPenalty
  );
}

/**
 * Build the synthetic projection input for a competing offer: each current
 * sub-loan refinanced at its end-of-current-month balance under the offer's
 * margin/term, starting at `refiStart`, holding Euribor flat at the offer rate.
 */
export function buildOfferProjectionInput(
  currentInputs: MortgageProjectionInputsResult,
  currentRow: MortgageProjectionMonth,
  refiStart: YearMonth,
  offer: TransferOfferParams
): MortgageProjectionInput {
  const { mortgage } = currentInputs;

  const loans: MortgageLoan[] = mortgage.loans
    .map((loan) => ({
      loan,
      balance: currentRow.loans.find((l) => l.loanId === loan.id)?.endingPrincipal ?? 0,
    }))
    .filter(({ balance }) => balance > 0.005)
    .map(({ loan, balance }) => {
      // Retain the ASP subsidy only if asked and the loan is an enabled ASP loan.
      // The 10-year window runs from the ORIGINAL draw, so the synthetic loan
      // (which "starts" at refiStart) gets the REMAINING window, not a fresh one.
      const keepAsp = offer.retainAsp && loan.kind === 'asp' && loan.aspSubsidy?.enabled === true;
      let aspSubsidy = loan.aspSubsidy;
      if (keepAsp && loan.aspSubsidy) {
        const elapsed = getMonthsBetween(loan.startDate, refiStart);
        const remainingMonths = Math.max(0, loan.aspSubsidy.eligibilityYears * 12 - elapsed);
        aspSubsidy = { ...loan.aspSubsidy, eligibilityYears: remainingMonths / 12 };
      } else {
        aspSubsidy = undefined;
      }
      return {
        ...loan,
        initialPrincipal: balance,
        startDate: refiStart,
        originalTermMonths: offer.termMonths,
        paymentMode: offer.paymentMode,
        margin: offer.margin,
        currentMonthlyPayment: undefined,
        aspSubsidy,
      };
    });

  const offerMortgage: SharedMortgage = { ...mortgage, loans, members: [] };

  const rates: MortgageRateEntry[] = [
    {
      id: 'offer-rate',
      mortgageId: mortgage.id,
      effectiveDate: refiStart,
      euriborRate: offer.euriborRate,
      createdAt: `${refiStart}-01T00:00:00.000Z`,
    },
  ];

  const costs: MortgageCostEntry[] = [
    {
      id: 'offer-service-fee',
      mortgageId: mortgage.id,
      type: 'service-fee',
      effectiveDate: refiStart,
      amount: offer.monthlyServiceFee,
      createdAt: `${refiStart}-01T00:00:00.000Z`,
    },
  ];
  if (offer.monthlyInsurance > 0 && loans.length > 0) {
    costs.push({
      id: 'offer-insurance',
      mortgageId: mortgage.id,
      type: 'loan-insurance',
      loanId: loans[0].id,
      effectiveDate: refiStart,
      amount: offer.monthlyInsurance,
      createdAt: `${refiStart}-01T00:00:00.000Z`,
    });
  }

  return { mortgage: offerMortgage, rates, costs, extraPayments: [], snapshots: [], actuals: [] };
}

/** Forward months from refiStart, trimmed of the all-paid-off tail. */
function forwardActiveMonths(
  months: MortgageProjectionMonth[],
  refiStart: YearMonth
): MortgageProjectionMonth[] {
  const fwd = months.filter((m) => compareYearMonths(m.yearMonth, refiStart) >= 0);
  let last = fwd.length - 1;
  while (last >= 0 && fwd[last].totalCharge <= 0.005) last--;
  return fwd.slice(0, last + 1);
}

/** Per-month cumulative cost-of-borrowing (interest + fees + insurance) + totals. */
function summarize(
  active: MortgageProjectionMonth[],
  oneOffCosts: number
): { totals: Omit<ScenarioTotals, 'startBalance' | 'allInRate' | 'firstMonthlyCharge'>; cum: number[] } {
  let totalInterest = 0;
  let totalSubsidy = 0;
  let totalFees = 0;
  let totalInsurance = 0;
  let running = 0;
  const cum: number[] = [];
  for (const m of active) {
    const fees = m.invoicingFee + m.serviceFee;
    totalInterest += m.totalInterest;
    totalSubsidy += m.totalSubsidy;
    totalFees += fees;
    totalInsurance += m.totalInsurance;
    running += m.totalInterest + fees + m.totalInsurance;
    cum.push(running);
  }
  return {
    totals: {
      payoffMonth: active[active.length - 1]?.yearMonth ?? null,
      remainingMonths: active.length,
      totalInterest,
      totalSubsidy,
      totalFees,
      totalInsurance,
      oneOffCosts,
      lifetimeCost: totalInterest + totalFees + totalInsurance + oneOffCosts,
    },
    cum,
  };
}

/** Balance-weighted effective annual rate across a month's active loans. */
function weightedRate(row: MortgageProjectionMonth): number {
  const totalBal = row.loans.reduce((s, l) => s + l.startingPrincipal, 0);
  if (totalBal <= 0) return 0;
  return row.loans.reduce((s, l) => s + l.effectiveAnnualRate * l.startingPrincipal, 0) / totalBal;
}

/**
 * Compare the current mortgage against a competing offer, both anchored at
 * `refiStart` (= the month after the current month). Returns side-by-side
 * totals, the net lifetime saving, the break-even point, and a cumulative-cost
 * series for charting.
 */
export function computeTransferComparison(
  realMonths: MortgageProjectionMonth[],
  currentInputs: MortgageProjectionInputsResult,
  currentRow: MortgageProjectionMonth,
  refiStart: YearMonth,
  offer: TransferOfferParams
): TransferComparison {
  const oneOff = offerOneOffCosts(offer);
  const startBalance = currentRow.totalRemaining;

  // Current: forward slice of the already-computed real projection.
  const currentActive = forwardActiveMonths(realMonths, refiStart);
  const cur = summarize(currentActive, 0);
  const currentFirst = currentActive[0];

  // Offer: run the engine on the synthetic input.
  const offerInput = buildOfferProjectionInput(currentInputs, currentRow, refiStart, offer);
  const offerEnd = addMonths(refiStart, offer.termMonths + 24);
  const offerMonths = calculateMortgageProjection(offerInput, offerEnd);
  const offerActive = forwardActiveMonths(offerMonths, refiStart);
  const off = summarize(offerActive, oneOff);
  const offerFirst = offerActive[0];

  const current: ScenarioTotals = {
    startBalance,
    allInRate: currentFirst ? weightedRate(currentFirst) : weightedRate(currentRow),
    firstMonthlyCharge: currentFirst ? currentFirst.totalCharge + currentFirst.serviceFee : 0,
    ...cur.totals,
  };
  const offerTotals: ScenarioTotals = {
    startBalance,
    allInRate: offer.euriborRate + offer.margin,
    firstMonthlyCharge: offerFirst ? offerFirst.totalCharge + offerFirst.serviceFee : 0,
    ...off.totals,
  };

  // Break-even & chart series: cumulative cost-of-borrowing, offer offset by
  // its one-off costs. Break-even = first month the current cumulative cost
  // catches up to the offer's (i.e. switching has paid for itself).
  const horizon = Math.max(cur.cum.length, off.cum.length);
  const series: TransferComparison['series'] = [];
  let breakEvenMonths: number | null = null;
  for (let i = 0; i < horizon; i++) {
    const c = cur.cum[Math.min(i, cur.cum.length - 1)] ?? 0;
    const o = (off.cum[Math.min(i, off.cum.length - 1)] ?? 0) + oneOff;
    if (breakEvenMonths === null && c >= o) breakEvenMonths = i;
    series.push({ label: addMonths(refiStart, i), current: c, offer: o });
  }
  // No saving at all → never breaks even.
  if (offerTotals.lifetimeCost >= current.lifetimeCost) breakEvenMonths = null;

  return {
    current,
    offer: offerTotals,
    netLifetimeSaving: current.lifetimeCost - offerTotals.lifetimeCost,
    breakEvenMonths,
    series,
  };
}
