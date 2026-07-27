/**
 * Shared Mortgage amortization engine.
 *
 * Auto-amortizes a Finnish-style mortgage made of one or more sub-loans
 * (e.g. an interest-subsidized ASP loan + a regular loan) from its genesis,
 * driven only by a yearly Euribor rate schedule. Interest accrues actual/360,
 * payments are level annuities recomputed at each rate reset to keep maturity
 * fixed (tasaerä). Time-effective fee/insurance schedules and one-off extra
 * payments are supported, and an observed balance ("drift snapshot") re-bases
 * the schedule from that month forward.
 *
 * Pure functions, no I/O. Modeled on src/lib/wealth-projection.ts.
 */

import type {
  YearMonth,
  SharedMortgage,
  MortgageLoan,
  MortgageRateEntry,
  MortgageCostEntry,
  MortgageExtraPayment,
  MortgageBalanceSnapshot,
  MortgageActualEntry,
  MortgageCostType,
  MortgageLoanProjectionMonth,
  MortgageProjectionMonth,
  MortgageMemberPosition,
} from '@/types';
import {
  parseYearMonth,
  addMonths,
  compareYearMonths,
  getMonthsBetween,
  getCurrentYearMonth,
} from './projection';

// ============================================================
// DAY COUNT
// ============================================================

function daysInMonth(yearMonth: YearMonth): number {
  const { year, month } = parseYearMonth(yearMonth);
  return new Date(year, month, 0).getDate();
}

/** Calendar days between two debit dates (paymentDayOfMonth clamped to month length). */
function daysBetweenDebits(prevMonth: YearMonth, periodMonth: YearMonth, day: number): number {
  const { year: py, month: pm } = parseYearMonth(prevMonth);
  const { year: cy, month: cm } = parseYearMonth(periodMonth);
  const pd = Math.min(day, new Date(py, pm, 0).getDate());
  const cd = Math.min(day, new Date(cy, cm, 0).getDate());
  const prev = new Date(py, pm - 1, pd);
  const cur = new Date(cy, cm - 1, cd);
  return Math.round((cur.getTime() - prev.getTime()) / 86_400_000);
}

/**
 * Fraction of a year an interest period covers.
 * - 30E/360 → exactly 1/12.
 * - actual/360 → days/360 (exact day-span when paymentDayOfMonth is set,
 *   otherwise a calendar-month approximation that still captures 31-day-heavier
 *   and February-lighter months).
 */
export function dayCountFraction(
  loan: Pick<MortgageLoan, 'dayCount' | 'paymentDayOfMonth'>,
  prevMonth: YearMonth,
  periodMonth: YearMonth
): number {
  if (loan.dayCount === '30E/360') return 1 / 12;
  const days = loan.paymentDayOfMonth
    ? daysBetweenDebits(prevMonth, periodMonth, loan.paymentDayOfMonth)
    : daysInMonth(periodMonth);
  return days / 360;
}

// ============================================================
// RATE & COST LOOKUPS (time-effective schedules)
// ============================================================

/**
 * Effective annual rate (%) for a loan in a given month: the most recent
 * Euribor entry with effectiveDate <= the month, plus the loan's margin.
 * Falls back to the earliest known rate for months before the first entry.
 */
export function getEffectiveAnnualRate(
  loan: Pick<MortgageLoan, 'margin'>,
  rates: MortgageRateEntry[],
  yearMonth: YearMonth
): number {
  if (rates.length === 0) return loan.margin;
  const sorted = [...rates].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  const applicable =
    sorted.find((r) => compareYearMonths(r.effectiveDate, yearMonth) <= 0) ??
    sorted[sorted.length - 1]; // earliest, for months before the first reset
  return applicable.euriborRate + loan.margin;
}

/**
 * Effective monthly cost for a fee/insurance type in a given month: the most
 * recent matching entry with effectiveDate <= the month (else 0). Lets fees
 * change from a chosen month while keeping earlier history intact.
 */
export function getEffectiveCost(
  costs: MortgageCostEntry[],
  type: MortgageCostType,
  loanId: string | undefined,
  yearMonth: YearMonth
): number {
  const matching = costs
    .filter((c) => c.type === type && (type !== 'loan-insurance' || c.loanId === loanId))
    .filter((c) => compareYearMonths(c.effectiveDate, yearMonth) <= 0)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  return matching[0]?.amount ?? 0;
}

// ============================================================
// ANNUITY & SUBSIDY
// ============================================================

/**
 * Standard level annuity payment (principal + interest) that amortizes
 * `balance` over `remainingMonths` at the given annual rate.
 */
export function recomputeAnnuityPayment(
  balance: number,
  annualRatePct: number,
  remainingMonths: number
): number {
  const n = Math.max(1, Math.round(remainingMonths));
  const i = annualRatePct / 100 / 12;
  if (i <= 0) return balance / n;
  return (balance * i) / (1 - Math.pow(1 + i, -n));
}

/**
 * Government ASP interest subsidy for a month. Zero unless the loan is an
 * enabled ASP loan, still within its eligibility window, and the effective
 * rate exceeds the threshold — then the state pays `subsidyShare` of the
 * interest attributable to the rate above the threshold.
 */
export function computeAspSubsidy(
  loan: MortgageLoan,
  effectiveAnnualRate: number,
  interestAccrued: number,
  monthsSinceStart: number
): number {
  const cfg = loan.aspSubsidy;
  if (loan.kind !== 'asp' || !cfg?.enabled) return 0;
  if (monthsSinceStart >= cfg.eligibilityYears * 12) return 0;
  if (effectiveAnnualRate <= cfg.thresholdRate || effectiveAnnualRate <= 0) return 0;
  const excessFraction = (effectiveAnnualRate - cfg.thresholdRate) / effectiveAnnualRate;
  return interestAccrued * excessFraction * cfg.subsidyShare;
}

// ============================================================
// SINGLE-LOAN PROJECTION
// ============================================================

interface LoanProjectionInput {
  loan: MortgageLoan;
  rates: MortgageRateEntry[];
  costs: MortgageCostEntry[];
  extraPayments: MortgageExtraPayment[];
  snapshots: MortgageBalanceSnapshot[];
  actuals: MortgageActualEntry[];
  loanCount: number; // to split the mortgage-level invoicing fee
}

interface LoanRowWithMonth {
  yearMonth: YearMonth;
  row: MortgageLoanProjectionMonth;
}

/**
 * Project one sub-loan month-by-month from its genesis to `endDate` (or payoff).
 * Drift snapshots are applied inline (the loan's balance is reset to the observed
 * value at the start of the snapshot's month), so history stays continuous and
 * forward months re-base on the latest real number.
 */
function projectLoan(
  input: LoanProjectionInput,
  endDate: YearMonth
): LoanRowWithMonth[] {
  const { loan, rates, costs, extraPayments, snapshots, actuals, loanCount } = input;
  const rows: LoanRowWithMonth[] = [];

  const extrasByMonth = new Map<YearMonth, MortgageExtraPayment[]>();
  for (const ep of extraPayments) {
    const list = extrasByMonth.get(ep.date) ?? [];
    list.push(ep);
    extrasByMonth.set(ep.date, list);
  }
  const snapByMonth = new Map<YearMonth, number>();
  for (const s of snapshots) snapByMonth.set(s.yearMonth, s.actualBalance);
  const actualByMonth = new Map<YearMonth, MortgageActualEntry>();
  for (const ac of actuals) actualByMonth.set(ac.yearMonth, ac);

  let currentDate = loan.startDate;
  let balance = loan.initialPrincipal;
  let prevDate = addMonths(loan.startDate, -1);
  let prevRate = NaN;
  let levelPayment =
    loan.currentMonthlyPayment ??
    recomputeAnnuityPayment(
      balance,
      getEffectiveAnnualRate(loan, rates, currentDate),
      loan.originalTermMonths
    );

  // Safety cap: never loop past 2x the original term.
  let guard = loan.originalTermMonths * 2 + 24;

  while (compareYearMonths(currentDate, endDate) <= 0 && balance > 0.005 && guard-- > 0) {
    // Apply a drift correction at the start of its month.
    const snap = snapByMonth.get(currentDate);
    if (snap != null) balance = snap;

    const startingPrincipal = balance;
    const rate = getEffectiveAnnualRate(loan, rates, currentDate);
    const frac = dayCountFraction(loan, prevDate, currentDate);
    const periodDays = Math.round(frac * 360);
    const monthsSinceStart = getMonthsBetween(loan.startDate, currentDate);
    const actual = actualByMonth.get(currentDate);
    const invShare = loanCount > 0 ? getEffectiveCost(costs, 'invoicing-fee', undefined, currentDate) / loanCount : 0;

    // Recompute the level annuity at each rate reset (keeps maturity fixed). The
    // bank only changes the installment at a reset — between resets it's fixed.
    if (
      loan.paymentMode !== 'fixed-payment' &&
      !Number.isNaN(prevRate) &&
      rate !== prevRate
    ) {
      const remaining = loan.originalTermMonths - monthsSinceStart;
      levelPayment = recomputeAnnuityPayment(balance, rate, remaining);
    }

    let interestPaid: number;
    let subsidy: number;
    let insurance: number;
    let principalPaid: number;
    let scheduledPayment: number; // principal + interest installment (excl. insurance/fees)
    let extraPayment = 0;
    let endingPrincipal: number;
    let monthlyCharge: number; // full bank charge: P+I + invoicing share + insurance + extra
    let recomputeAfter = false;

    if (actual) {
      // Recorded actual: use the bank's real figures verbatim.
      interestPaid = actual.interest;
      subsidy = actual.subsidy ?? 0;
      insurance = actual.insurance;
      endingPrincipal = Math.max(0, actual.remaining);
      principalPaid = Math.max(0, startingPrincipal - endingPrincipal);
      monthlyCharge = actual.repayment; // full bank charge incl insurance + invoicing share
      scheduledPayment = Math.max(0, monthlyCharge - insurance - invShare); // P+I installment
      // Carry the bank's installment forward — forecasts hold it until the next reset.
      levelPayment = scheduledPayment;
    } else {
      const interestAccrued = balance * (rate / 100) * frac;
      subsidy = computeAspSubsidy(loan, rate, interestAccrued, monthsSinceStart);
      interestPaid = interestAccrued - subsidy;
      scheduledPayment =
        loan.paymentMode === 'fixed-payment'
          ? loan.currentMonthlyPayment ?? levelPayment
          : levelPayment;
      principalPaid = Math.min(balance, Math.max(0, scheduledPayment - interestPaid));

      const extras = extrasByMonth.get(currentDate);
      if (extras) {
        for (const e of extras) {
          const applied = Math.max(0, Math.min(balance - principalPaid, e.amount));
          extraPayment += applied;
          principalPaid += applied;
          if (e.mode === 'lower-payment') recomputeAfter = true;
        }
      }
      endingPrincipal = Math.max(0, startingPrincipal - principalPaid);
      insurance = getEffectiveCost(costs, 'loan-insurance', loan.id, currentDate);
      monthlyCharge = scheduledPayment + invShare + insurance + extraPayment;
    }

    rows.push({
      yearMonth: currentDate,
      row: {
        loanId: loan.id,
        startingPrincipal,
        effectiveAnnualRate: rate,
        periodDays,
        scheduledPayment,
        interestAccrued: interestPaid + subsidy,
        subsidy,
        interestPaid,
        principalPaid,
        extraPayment,
        insurance,
        invoicingFeeShare: invShare,
        monthlyCharge,
        endingPrincipal,
        isActual: !!actual,
      },
    });

    // A 'lower-payment' extra keeps the maturity but shrinks future installments.
    if (recomputeAfter && loan.paymentMode !== 'fixed-payment') {
      const remaining = loan.originalTermMonths - monthsSinceStart - 1;
      levelPayment = recomputeAnnuityPayment(endingPrincipal, rate, remaining);
    }

    balance = endingPrincipal;
    prevRate = rate;
    prevDate = currentDate;
    currentDate = addMonths(currentDate, 1);
  }

  return rows;
}

// ============================================================
// AGGREGATE MORTGAGE PROJECTION
// ============================================================

export interface MortgageProjectionInput {
  mortgage: SharedMortgage;
  rates: MortgageRateEntry[];
  costs: MortgageCostEntry[];
  extraPayments: MortgageExtraPayment[];
  snapshots: MortgageBalanceSnapshot[];
  actuals?: MortgageActualEntry[];
}

/** Earliest start month across all sub-loans (the mortgage's genesis). */
export function getMortgageStartDate(mortgage: SharedMortgage): YearMonth {
  return mortgage.loans.reduce<YearMonth>(
    (earliest, loan) =>
      !earliest || compareYearMonths(loan.startDate, earliest) < 0 ? loan.startDate : earliest,
    mortgage.loans[0]?.startDate ?? getCurrentYearMonth()
  );
}

function zeroLoanRow(loanId: string): MortgageLoanProjectionMonth {
  return {
    loanId,
    startingPrincipal: 0,
    effectiveAnnualRate: 0,
    periodDays: 0,
    scheduledPayment: 0,
    interestAccrued: 0,
    subsidy: 0,
    interestPaid: 0,
    principalPaid: 0,
    extraPayment: 0,
    insurance: 0,
    invoicingFeeShare: 0,
    monthlyCharge: 0,
    endingPrincipal: 0,
    isActual: false,
  };
}

/**
 * Build the full month-by-month schedule from genesis to `endDate`, with
 * per-loan detail, summary totals (sums of the per-loan values), running
 * cumulative totals, mortgage-level fees, and each member's ownership/equity.
 */
export function calculateMortgageProjection(
  input: MortgageProjectionInput,
  endDate: YearMonth
): MortgageProjectionMonth[] {
  const { mortgage, rates, costs, extraPayments, snapshots, actuals = [] } = input;
  const loans = mortgage.loans;
  const initialLoanTotal = loans.reduce((sum, l) => sum + l.initialPrincipal, 0);
  const currentMonth = getCurrentYearMonth();

  // Project each loan and index its rows by month.
  const loanRows = new Map<string, Map<YearMonth, MortgageLoanProjectionMonth>>();
  for (const loan of loans) {
    const rows = projectLoan(
      {
        loan,
        rates,
        costs,
        extraPayments: extraPayments.filter((e) => e.loanId === loan.id),
        snapshots: snapshots.filter((s) => s.loanId === loan.id),
        actuals: actuals.filter((a) => a.loanId === loan.id),
        loanCount: loans.length,
      },
      endDate
    );
    const byMonth = new Map<YearMonth, MortgageLoanProjectionMonth>();
    for (const { yearMonth, row } of rows) byMonth.set(yearMonth, row);
    loanRows.set(loan.id, byMonth);
  }

  const genesis = getMortgageStartDate(mortgage);
  const months: MortgageProjectionMonth[] = [];
  let cumPrincipalPaid = 0;
  let cumInterestPaid = 0;
  let cumInsurancePaid = 0;
  let cumFeesPaid = 0;

  let currentDate = genesis;
  while (compareYearMonths(currentDate, endDate) <= 0) {
    const { year, month } = parseYearMonth(currentDate);

    const invoicingFee = getEffectiveCost(costs, 'invoicing-fee', undefined, currentDate);
    const serviceFee = getEffectiveCost(costs, 'service-fee', undefined, currentDate);

    // Per-loan rows for this month (active loans only).
    const activeLoanIds: string[] = [];
    const perLoan: MortgageLoanProjectionMonth[] = loans.map((loan) => {
      const row = loanRows.get(loan.id)?.get(currentDate);
      if (row) {
        activeLoanIds.push(loan.id);
        return { ...row };
      }
      // Before this loan started → not yet borrowed; after payoff → 0.
      return zeroLoanRow(loan.id);
    });

    // projectLoan already set each row's invoicingFeeShare and monthlyCharge.
    const isAllActual = activeLoanIds.length > 0 && perLoan.every((r) => !activeLoanIds.includes(r.loanId) || r.isActual);
    const totalRemaining = perLoan.reduce((s, r) => s + r.endingPrincipal, 0);
    const totalRepayment = perLoan.reduce((s, r) => s + r.scheduledPayment + r.extraPayment, 0);
    const totalCharge = perLoan.reduce((s, r) => s + r.monthlyCharge, 0);
    const totalInterest = perLoan.reduce((s, r) => s + r.interestPaid, 0);
    const totalSubsidy = perLoan.reduce((s, r) => s + r.subsidy, 0);
    const totalInsurance = perLoan.reduce((s, r) => s + r.insurance, 0);
    const monthPrincipalPaid = perLoan.reduce((s, r) => s + r.principalPaid, 0);
    const principalPaidTotal = initialLoanTotal - totalRemaining;

    cumPrincipalPaid += monthPrincipalPaid;
    cumInterestPaid += totalInterest;
    cumInsurancePaid += totalInsurance;
    cumFeesPaid += invoicingFee + serviceFee;

    const members: MortgageMemberPosition[] = mortgage.members.map((m) => {
      const stake = m.initialPayment + m.loanSharePercent * initialLoanTotal;
      const liability = m.loanSharePercent * totalRemaining;
      const equity = stake - liability;
      return {
        userId: m.userId,
        stake,
        liability,
        equity,
        ownershipPercent: mortgage.housePrice > 0 ? equity / mortgage.housePrice : 0,
        leftToOwnTarget: m.ownershipTargetPercent * mortgage.housePrice - equity,
        // Amount this member transfers to the loan account: their share of the
        // full monthly bank charge (P+I + insurance + invoicing) plus the
        // per-person service fee — matches the spreadsheet's "deposits" columns.
        monthlyDeposit: m.loanSharePercent * totalCharge + serviceFee,
      };
    });

    months.push({
      yearMonth: currentDate,
      year,
      month,
      periodDays: perLoan.find((r) => activeLoanIds.includes(r.loanId))?.periodDays ?? 0,
      isHistorical: compareYearMonths(currentDate, currentMonth) <= 0,
      isAllActual,
      loans: perLoan,
      totalRemaining,
      totalRepayment,
      totalCharge,
      totalInterest,
      totalSubsidy,
      totalInsurance,
      invoicingFee,
      serviceFee,
      principalPaidTotal,
      cumPrincipalPaid,
      cumInterestPaid,
      cumInsurancePaid,
      cumFeesPaid,
      members,
    });

    currentDate = addMonths(currentDate, 1);
  }

  return months;
}

/** Find a member's position in a given month (or null). */
export function getMemberPositionForMonth(
  months: MortgageProjectionMonth[],
  userId: string,
  yearMonth: YearMonth
): MortgageMemberPosition | null {
  const m = months.find((x) => x.yearMonth === yearMonth);
  return m?.members.find((p) => p.userId === userId) ?? null;
}

/** First month the mortgage is fully paid off, if any. */
export function getPayoffMonth(months: MortgageProjectionMonth[]): YearMonth | null {
  const row = months.find((m) => m.totalRemaining <= 0.005);
  return row?.yearMonth ?? null;
}
