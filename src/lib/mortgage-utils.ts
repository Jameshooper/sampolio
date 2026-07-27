/**
 * Pure, client-safe mortgage helpers (no server / DB imports).
 * The ownership-share derivation and the yearly Euribor-due detection live here
 * so the setup wizard, panels, and charts share one source of truth.
 */

import type { SharedMortgage, MortgageRateEntry, MortgageProjectionMonth, YearMonth } from '@/types';
import { compareYearMonths } from './projection';

/**
 * Derive each member's ongoing loan share from their down payments and target.
 *
 * The member who paid LESS up front still owes MORE of their target stake, so
 * they carry a larger share of the monthly loan — which is exactly what pulls
 * both members toward their target ownership over time.
 *
 *   remainingToTarget_m = targetPercent_m * housePrice − initialPayment_m
 *   share_m             = remainingToTarget_m / Σ remainingToTarget
 *
 * With a €328k home, equal 50% targets, and €31k / €4k down payments this yields
 * the spreadsheet's 45.4% / 54.6% split.
 *
 * @param targetPercents per-member target ownership fraction (should sum to 1).
 */
export function deriveLoanShares(
  housePrice: number,
  initialPayments: number[],
  targetPercents: number[]
): number[] {
  const remaining = initialPayments.map((p, i) => Math.max(0, (targetPercents[i] ?? 1 / initialPayments.length) * housePrice - p));
  const sum = remaining.reduce((s, r) => s + r, 0);
  if (sum <= 0) {
    // Everyone already at/over target — split evenly.
    return initialPayments.map(() => 1 / initialPayments.length);
  }
  return remaining.map((r) => r / sum);
}

export interface MortgageSankeySnapshot {
  /** Each member's total paid in up to the selected month: down payment + monthly transfers. */
  members: Array<{ userId: string; name: string; paidSoFar: number }>;
  /** Future payments (all members) from the selected month to payoff. */
  stillToPay: number;
  /** Middle node: down payments + every monthly transfer over the loan's life. */
  wholeMortgage: number;
  interestPaid: number;
  amortizationPaid: number;
  interestLeft: number;
  amortizationLeft: number;
  downPayments: number;
  /** Lifetime insurance + invoicing + service fees (residual of the transfers). */
  feesAndInsurance: number;
}

/**
 * Figures behind the ownership Sankey at one scrubber position. Balanced by
 * construction: Σ members.paidSoFar + stillToPay = wholeMortgage = the sum of
 * the six right-hand buckets, so every Sankey flow conserves.
 */
export function buildMortgageSankeySnapshot(
  months: MortgageProjectionMonth[],
  mortgage: SharedMortgage,
  idx: number
): MortgageSankeySnapshot | null {
  if (months.length === 0) return null;
  const i = Math.min(Math.max(idx, 0), months.length - 1);
  const row = months[i];
  const last = months[months.length - 1];
  const clamp = (v: number) => (v > 0 ? v : 0);

  // Lifetime totals come from the final month (post-payoff months add zero).
  const lifetimeInterest = last.cumInterestPaid;
  const lifetimeAmortization = last.cumPrincipalPaid;

  const paidToIdx = new Map<string, number>();
  let lifetimeDeposits = 0;
  months.forEach((m, k) => {
    for (const p of m.members) {
      lifetimeDeposits += p.monthlyDeposit;
      if (k <= i) paidToIdx.set(p.userId, (paidToIdx.get(p.userId) ?? 0) + p.monthlyDeposit);
    }
  });

  const downPayments = mortgage.members.reduce((s, m) => s + m.initialPayment, 0);
  const wholeMortgage = downPayments + lifetimeDeposits;
  const members = mortgage.members.map((m) => ({
    userId: m.userId,
    name: m.name,
    paidSoFar: m.initialPayment + (paidToIdx.get(m.userId) ?? 0),
  }));

  return {
    members,
    stillToPay: clamp(wholeMortgage - members.reduce((s, m) => s + m.paidSoFar, 0)),
    wholeMortgage,
    interestPaid: clamp(row.cumInterestPaid),
    amortizationPaid: clamp(row.cumPrincipalPaid),
    interestLeft: clamp(lifetimeInterest - row.cumInterestPaid),
    amortizationLeft: clamp(lifetimeAmortization - row.cumPrincipalPaid),
    downPayments,
    feesAndInsurance: clamp(lifetimeDeposits - lifetimeInterest - lifetimeAmortization),
  };
}

export interface EuriborDueInfo {
  due: boolean;
  /** The most recent reset anchor date on or before today. */
  lastResetDate: Date;
  /** The next reset date in the future. */
  nextResetDate: Date;
  /** Whole days until the next reset (negative if it just passed). */
  daysUntilNext: number;
  /** The YYYY-MM the current reset cycle belongs to (what a new rate entry should target). */
  resetYearMonth: YearMonth;
}

function resetDateInYear(year: number, month: number, day: number): Date {
  const clampedDay = Math.min(day, new Date(year, month, 0).getDate());
  return new Date(year, month - 1, clampedDay);
}

function toYearMonth(d: Date): YearMonth {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Whether it's time to enter this year's Euribor rate. "Due" means we're inside a
 * window around the reset date (a week before, up to ~60 days after) AND no rate
 * entry has been recorded for the current reset cycle yet — so the banner appears
 * once a year and disappears the moment the user enters the new rate.
 */
export function isEuriborUpdateDue(
  mortgage: Pick<SharedMortgage, 'rateResetMonth' | 'rateResetDay'>,
  rates: MortgageRateEntry[],
  now: Date = new Date()
): EuriborDueInfo {
  const { rateResetMonth, rateResetDay } = mortgage;
  const thisYearReset = resetDateInYear(now.getFullYear(), rateResetMonth, rateResetDay);

  const lastResetDate =
    now >= thisYearReset
      ? thisYearReset
      : resetDateInYear(now.getFullYear() - 1, rateResetMonth, rateResetDay);
  const nextResetDate =
    now >= thisYearReset
      ? resetDateInYear(now.getFullYear() + 1, rateResetMonth, rateResetDay)
      : thisYearReset;

  const resetYearMonth = toYearMonth(lastResetDate);
  const MS_PER_DAY = 86_400_000;
  const daysUntilNext = Math.ceil((nextResetDate.getTime() - now.getTime()) / MS_PER_DAY);
  const daysSinceLast = Math.floor((now.getTime() - lastResetDate.getTime()) / MS_PER_DAY);

  // Has the current cycle's rate already been entered?
  const hasCurrentCycleRate = rates.some(
    (r) => compareYearMonths(r.effectiveDate, resetYearMonth) >= 0
  );

  const withinWindow = (daysUntilNext <= 7 || (daysSinceLast >= 0 && daysSinceLast <= 60));
  const due = withinWindow && !hasCurrentCycleRate;

  return { due, lastResetDate, nextResetDate, daysUntilNext, resetYearMonth };
}
