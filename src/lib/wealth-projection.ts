/**
 * Wealth Projection Engine
 * 
 * Computes unified projections for all asset and liability types:
 * - Cash accounts (from existing projection engine)
 * - Investment accounts (with growth and contributions)
 * - Receivables (with repayments)
 * - Debts (with amortization)
 */

import type {
  YearMonth,
  FinancialAccount,
  InvestmentAccount,
  InvestmentContribution,
  Receivable,
  ReceivableRepayment,
  Debt,
  DebtReferenceRate,
  DebtExtraPayment,
  WealthProjectionMonth,
  DebtAmortizationRow,
  InvestmentProjectionRow,
  ReceivableProjectionRow,
  MonthlyProjection,
  Frequency,
  BalanceSnapshot,
  MortgageProjectionMonth,
} from '@/types';
import {
  parseYearMonth,
  formatYearMonth,
  addMonths,
  compareYearMonths,
  getIntervalMonths,
  isYearMonthInRange,
  resolveAnchor,
} from './projection';

// ============================================================
// INVESTMENT PROJECTION
// ============================================================

/**
 * Calculate monthly growth rate from annual rate
 * Formula: (1 + annualRate/100)^(1/12) - 1
 */
function getMonthlyGrowthRate(annualRate: number): number {
  return Math.pow(1 + annualRate / 100, 1 / 12) - 1;
}

/**
 * Check if a contribution applies to a specific month
 */
function isContributionActiveInMonth(
  contribution: InvestmentContribution,
  yearMonth: YearMonth
): boolean {
  if (!contribution.isActive) return false;

  if (contribution.kind === 'one-off') {
    return contribution.scheduledDate === yearMonth;
  }

  // Recurring contribution
  if (!contribution.startDate || !contribution.frequency) return false;

  if (!isYearMonthInRange(yearMonth, contribution.startDate, contribution.endDate)) {
    return false;
  }

  const intervalMonths = getIntervalMonths(
    contribution.frequency as Frequency,
    contribution.customIntervalMonths
  );
  if (intervalMonths > 1) {
    const startParsed = parseYearMonth(contribution.startDate);
    const currentParsed = parseYearMonth(yearMonth);
    const monthsSinceStart =
      (currentParsed.year - startParsed.year) * 12 +
      (currentParsed.month - startParsed.month);
    if (monthsSinceStart % intervalMonths !== 0) {
      return false;
    }
  }

  return true;
}

/**
 * Calculate investment projection for a single account
 */
function calculateInvestmentProjection(
  investment: InvestmentAccount,
  contributions: InvestmentContribution[],
  startDate: YearMonth,
  endDate: YearMonth,
  latestSnapshot?: BalanceSnapshot | null
): InvestmentProjectionRow[] {
  const rows: InvestmentProjectionRow[] = [];
  const monthlyRate = getMonthlyGrowthRate(investment.annualGrowthRate);

  // Anchor on the latest reconciliation snapshot when available, else genesis.
  const anchor = resolveAnchor(investment.valuationDate, investment.startingValuation, latestSnapshot);
  let currentDate = anchor.startMonth;
  let currentValuation = anchor.startBalance;

  // If startDate is before the anchor, start from the anchor
  if (compareYearMonths(startDate, anchor.startMonth) < 0) {
    currentDate = anchor.startMonth;
  } else {
    // Project forward to startDate first
    while (compareYearMonths(currentDate, startDate) < 0) {
      const growth = currentValuation * monthlyRate;
      let monthContributions = 0;
      let monthWithdrawals = 0;

      for (const contrib of contributions) {
        if (isContributionActiveInMonth(contrib, currentDate)) {
          if (contrib.type === 'contribution') {
            monthContributions += contrib.amount;
          } else {
            monthWithdrawals += contrib.amount;
          }
        }
      }

      currentValuation = currentValuation + growth + monthContributions - monthWithdrawals;
      currentDate = addMonths(currentDate, 1);
    }
  }

  // Now generate projections from startDate to endDate
  while (compareYearMonths(currentDate, endDate) <= 0) {
    const startingValuation = currentValuation;
    const growth = currentValuation * monthlyRate;
    let monthContributions = 0;
    let monthWithdrawals = 0;

    for (const contrib of contributions) {
      if (isContributionActiveInMonth(contrib, currentDate)) {
        if (contrib.type === 'contribution') {
          monthContributions += contrib.amount;
        } else {
          monthWithdrawals += contrib.amount;
        }
      }
    }

    const endingValuation = startingValuation + growth + monthContributions - monthWithdrawals;

    rows.push({
      yearMonth: currentDate,
      startingValuation,
      growth,
      contributions: monthContributions,
      withdrawals: monthWithdrawals,
      endingValuation,
    });

    currentValuation = endingValuation;
    currentDate = addMonths(currentDate, 1);
  }

  return rows;
}

// ============================================================
// RECEIVABLE PROJECTION
// ============================================================

/**
 * Calculate receivable projection
 */
function calculateReceivableProjection(
  receivable: Receivable,
  repayments: ReceivableRepayment[],
  startDate: YearMonth,
  endDate: YearMonth,
  latestSnapshot?: BalanceSnapshot | null
): ReceivableProjectionRow[] {
  const rows: ReceivableProjectionRow[] = [];

  // Build repayment map
  const repaymentsByMonth = new Map<YearMonth, number>();
  for (const repayment of repayments) {
    const existing = repaymentsByMonth.get(repayment.date) || 0;
    repaymentsByMonth.set(repayment.date, existing + repayment.amount);
  }

  // Anchor on the latest reconciliation snapshot when available, else genesis.
  const anchor = resolveAnchor(receivable.startDate, receivable.initialPrincipal, latestSnapshot);
  let currentDate = anchor.startMonth;
  let currentBalance = anchor.startBalance;
  const monthlyInterestRate = receivable.hasInterest
    ? (receivable.annualInterestRate ?? 0) / 100 / 12
    : 0;

  // Project from receivable start to endDate
  while (compareYearMonths(currentDate, endDate) <= 0) {
    const startingBalance = currentBalance;
    const interestAccrued = currentBalance * monthlyInterestRate;
    const repaymentAmount = repaymentsByMonth.get(currentDate) || 0;

    // If no actual repayment, use expected monthly repayment for projection
    const projectedRepayment =
      repaymentAmount > 0
        ? repaymentAmount
        : compareYearMonths(currentDate, startDate) >= 0
          ? receivable.expectedMonthlyRepayment || 0
          : 0;

    const endingBalance = Math.max(
      0,
      startingBalance + interestAccrued - projectedRepayment
    );

    if (compareYearMonths(currentDate, startDate) >= 0) {
      rows.push({
        yearMonth: currentDate,
        startingBalance,
        repayments: projectedRepayment,
        interestAccrued,
        endingBalance,
      });
    }

    currentBalance = endingBalance;
    currentDate = addMonths(currentDate, 1);

    // Stop if fully repaid
    if (currentBalance <= 0) break;
  }

  return rows;
}

// ============================================================
// DEBT AMORTIZATION PROJECTION
// ============================================================

/**
 * Get the effective interest rate for a month
 */
function getEffectiveRate(
  debt: Debt,
  referenceRates: DebtReferenceRate[],
  yearMonth: YearMonth
): number {
  if (debt.interestModelType === 'none') return 0;
  if (debt.interestModelType === 'fixed') return debt.fixedInterestRate ?? 0;

  // Variable rate: find the applicable reference rate
  const sortedRates = [...referenceRates].sort((a, b) =>
    b.yearMonth.localeCompare(a.yearMonth)
  );

  // Find the most recent rate that's <= yearMonth
  const applicableRate = sortedRates.find(
    (r) => compareYearMonths(r.yearMonth, yearMonth) <= 0
  );

  const referenceRate = applicableRate?.rate ?? 0;
  return referenceRate + (debt.referenceRateMargin ?? 0);
}

/**
 * Calculate debt amortization schedule. Exported for the debt progress
 * framing (getDebtPayoffInfo + DebtProgressCard) in the entity drawer.
 */
export function calculateDebtAmortization(
  debt: Debt,
  referenceRates: DebtReferenceRate[],
  extraPayments: DebtExtraPayment[],
  startDate: YearMonth,
  endDate: YearMonth,
  latestSnapshot?: BalanceSnapshot | null
): DebtAmortizationRow[] {
  const rows: DebtAmortizationRow[] = [];

  // Build extra payments map
  const extraPaymentsByMonth = new Map<YearMonth, number>();
  for (const payment of extraPayments) {
    const existing = extraPaymentsByMonth.get(payment.date) || 0;
    extraPaymentsByMonth.set(payment.date, existing + payment.amount);
  }

  // Anchor on the latest reconciliation snapshot when available, else genesis.
  // Debt snapshots are stored negative, so negate back to a positive principal.
  const anchored = !!latestSnapshot && compareYearMonths(latestSnapshot.yearMonth, debt.startDate) >= 0;
  const anchor = resolveAnchor(debt.startDate, debt.initialPrincipal, latestSnapshot, true);
  let currentDate = anchor.startMonth;
  let remainingPrincipal = anchor.startBalance;

  // For fixed-installment debts: prefer the reconciled remaining count when anchored.
  let installmentsRemaining = anchored && debt.remainingInstallments != null
    ? debt.remainingInstallments
    : (debt.totalInstallments ?? 0);

  while (compareYearMonths(currentDate, endDate) <= 0 && remainingPrincipal > 0) {
    const startingPrincipal = remainingPrincipal;
    const annualRate = getEffectiveRate(debt, referenceRates, currentDate);
    const monthlyRate = annualRate / 100 / 12;

    let interestPaid = 0;
    let principalPaid = 0;
    let totalPayment = 0;

    if (debt.debtType === 'amortized') {
      // Amortized loan with interest
      interestPaid = remainingPrincipal * monthlyRate;
      const regularPayment = debt.monthlyPayment ?? 0;
      principalPaid = Math.min(remainingPrincipal, regularPayment - interestPaid);
      totalPayment = regularPayment;
    } else {
      // Fixed installment, no interest
      if (installmentsRemaining > 0) {
        const installment = debt.installmentAmount ?? 0;
        principalPaid = Math.min(remainingPrincipal, installment);
        totalPayment = principalPaid;
        installmentsRemaining--;
      }
    }

    // Add extra payments
    const extraPayment = extraPaymentsByMonth.get(currentDate) || 0;
    principalPaid += Math.min(remainingPrincipal - principalPaid, extraPayment);
    totalPayment += extraPayment;

    const endingPrincipal = Math.max(0, startingPrincipal - principalPaid);

    if (compareYearMonths(currentDate, startDate) >= 0) {
      rows.push({
        yearMonth: currentDate,
        startingPrincipal,
        interestPaid,
        principalPaid,
        totalPayment,
        endingPrincipal,
        interestRate: annualRate,
      });
    }

    remainingPrincipal = endingPrincipal;
    currentDate = addMonths(currentDate, 1);
  }

  return rows;
}

// ============================================================
// UNIFIED WEALTH PROJECTION
// ============================================================

export interface WealthProjectionData {
  cashAccounts: FinancialAccount[];
  cashProjections: Map<string, MonthlyProjection[]>;
  investments: InvestmentAccount[];
  investmentContributions: Map<string, InvestmentContribution[]>;
  receivables: Receivable[];
  receivableRepayments: Map<string, ReceivableRepayment[]>;
  debts: Debt[];
  debtReferenceRates: Map<string, DebtReferenceRate[]>;
  debtExtraPayments: Map<string, DebtExtraPayment[]>;
  // Latest reconciliation snapshot per entity, used to re-anchor projections
  // on the most recently confirmed balance. Optional/back-compatible.
  investmentSnapshots?: Map<string, BalanceSnapshot | null>;
  receivableSnapshots?: Map<string, BalanceSnapshot | null>;
  debtSnapshots?: Map<string, BalanceSnapshot | null>;
  // Shared mortgages the logged-in member belongs to: one pre-computed
  // projection series per mortgage. Folded into net worth as the member's
  // home equity (stake − loan-share liability). Optional / back-compatible.
  mortgageProjections?: MortgageProjectionMonth[][];
  mortgageNames?: string[]; // parallel to mortgageProjections
  currentUserId?: string;
  // Linked credit-card outstandings (from the bank sync). Each reduces net worth
  // until its bill is paid via the cashflow line. Optional / back-compatible.
  cardLiabilities?: { linkId: string; name: string; outstanding: number; billYearMonth?: YearMonth }[];
  // Logged-in user's net split balance (Splitwise replacement), in the display
  // currency: positive = owed to them (a receivable), negative = they owe (a
  // debt). Folded flat into net worth. Optional / back-compatible.
  splitNetTotal?: number;
}

/**
 * Calculate unified wealth projection across all asset types
 */
export function calculateWealthProjection(
  data: WealthProjectionData,
  startDate: YearMonth,
  endDate: YearMonth
): WealthProjectionMonth[] {
  const months: WealthProjectionMonth[] = [];

  // Pre-calculate all individual projections
  const investmentProjections = new Map<string, InvestmentProjectionRow[]>();
  for (const inv of data.investments) {
    const contribs = data.investmentContributions.get(inv.id) || [];
    investmentProjections.set(
      inv.id,
      calculateInvestmentProjection(inv, contribs, startDate, endDate, data.investmentSnapshots?.get(inv.id))
    );
  }

  const receivableProjections = new Map<string, ReceivableProjectionRow[]>();
  for (const rec of data.receivables) {
    const repayments = data.receivableRepayments.get(rec.id) || [];
    receivableProjections.set(
      rec.id,
      calculateReceivableProjection(rec, repayments, startDate, endDate, data.receivableSnapshots?.get(rec.id))
    );
  }

  const debtProjections = new Map<string, DebtAmortizationRow[]>();
  for (const debt of data.debts) {
    const rates = data.debtReferenceRates.get(debt.id) || [];
    const extras = data.debtExtraPayments.get(debt.id) || [];
    debtProjections.set(
      debt.id,
      calculateDebtAmortization(debt, rates, extras, startDate, endDate, data.debtSnapshots?.get(debt.id))
    );
  }

  // Generate month-by-month wealth projection
  let currentDate = startDate;
  while (compareYearMonths(currentDate, endDate) <= 0) {
    const { year, month } = parseYearMonth(currentDate);

    // Cash accounts
    const cashAccountsBreakdown: WealthProjectionMonth['cashAccountsBreakdown'] = [];
    let cashAccountsTotal = 0;

    for (const account of data.cashAccounts) {
      const projections = data.cashProjections.get(account.id) || [];
      const monthProjection = projections.find((p) => p.yearMonth === currentDate);
      // Mirror the debt fallback (see below): when the wealth horizon runs past
      // a cash account's own projection coverage, carry forward the LAST
      // projected ending balance — not the genesis startingBalance, which would
      // collapse accumulated cash in the tail months. A month before coverage
      // still falls back to startingBalance.
      const balance = monthProjection
        ? monthProjection.endingBalance
        : projections.length > 0 &&
            compareYearMonths(currentDate, projections[projections.length - 1].yearMonth) > 0
          ? projections[projections.length - 1].endingBalance
          : account.startingBalance;
      cashAccountsBreakdown.push({
        accountId: account.id,
        name: account.name,
        balance,
      });
      cashAccountsTotal += balance;
    }

    // Investments
    const investmentsBreakdown: WealthProjectionMonth['investmentsBreakdown'] = [];
    let investmentsTotal = 0;

    for (const inv of data.investments) {
      const projections = investmentProjections.get(inv.id) || [];
      const monthProjection = projections.find((p) => p.yearMonth === currentDate);
      const valuation = monthProjection?.endingValuation ?? (inv.currentValuation ?? inv.startingValuation);
      investmentsBreakdown.push({
        accountId: inv.id,
        name: inv.name,
        valuation,
      });
      investmentsTotal += valuation;
    }

    // Receivables
    const receivablesBreakdown: WealthProjectionMonth['receivablesBreakdown'] = [];
    let receivablesTotal = 0;

    for (const rec of data.receivables) {
      const projections = receivableProjections.get(rec.id) || [];
      const monthProjection = projections.find((p) => p.yearMonth === currentDate);
      // Mirror the debt fallback (see below): receivable rows stop early once
      // the balance hits 0 (calculateReceivableProjection breaks at ≤ 0), so a
      // month past the last row means the receivable is fully repaid → 0. Only a
      // month before the projection starts falls back to currentBalance.
      const balance = monthProjection
        ? monthProjection.endingBalance
        : projections.length > 0 &&
            compareYearMonths(currentDate, projections[projections.length - 1].yearMonth) > 0
          ? 0
          : rec.currentBalance;
      receivablesBreakdown.push({
        receivableId: rec.id,
        name: rec.name,
        balance,
      });
      receivablesTotal += balance;
    }

    // Debts (negative values)
    const debtsBreakdown: WealthProjectionMonth['debtsBreakdown'] = [];
    let debtsTotal = 0;

    for (const debt of data.debts) {
      const projections = debtProjections.get(debt.id) || [];
      const monthProjection = projections.find((p) => p.yearMonth === currentDate);
      // If projection rows exist but none matches this month, the debt is paid off (principal = 0)
      // Only fall back to initialPrincipal if the month is before the projection starts
      const principal = monthProjection ? monthProjection.endingPrincipal
        : (projections.length > 0 && compareYearMonths(currentDate, projections[projections.length - 1].yearMonth) > 0)
          ? 0
          : debt.initialPrincipal;
      debtsBreakdown.push({
        debtId: debt.id,
        name: debt.name,
        principal,
        interestPaid: monthProjection?.interestPaid,
      });
      debtsTotal += principal;
    }

    // Shared mortgages — the logged-in member's slice. Home equity (stake −
    // loan-share liability) is folded into net worth; stake and liability are
    // exposed separately so the wealth chart can show the home asset and the
    // loan liability as distinct bands. Never double-counted as a Debt.
    let mortgageEquityTotal: number | undefined;
    let mortgageLiabilityTotal: number | undefined;
    let mortgageStakeTotal: number | undefined;
    let mortgagesBreakdown: WealthProjectionMonth['mortgagesBreakdown'];

    if (data.mortgageProjections && data.currentUserId) {
      mortgageEquityTotal = 0;
      mortgageLiabilityTotal = 0;
      mortgageStakeTotal = 0;
      mortgagesBreakdown = [];
      data.mortgageProjections.forEach((projection, idx) => {
        const monthRow = projection.find((p) => p.yearMonth === currentDate);
        const pos = monthRow?.members.find((m) => m.userId === data.currentUserId);
        if (!pos) return;
        mortgageEquityTotal! += pos.equity;
        mortgageLiabilityTotal! += pos.liability;
        mortgageStakeTotal! += pos.stake;
        mortgagesBreakdown!.push({
          mortgageId: `mortgage-${idx}`,
          name: data.mortgageNames?.[idx] ?? 'Mortgage',
          stake: pos.stake,
          liability: pos.liability,
          equity: pos.equity,
        });
      });
    }

    // Credit-card liabilities — the outstanding owed but not yet paid as of this
    // month. Once the bill's payment month arrives, the cashflow line has already
    // reduced cash, so the liability drops to 0 here (no double count) and net
    // worth stays continuous across the boundary.
    let cardLiabilitiesTotal: number | undefined;
    let cardLiabilitiesBreakdown: WealthProjectionMonth['cardLiabilitiesBreakdown'];
    if (data.cardLiabilities && data.cardLiabilities.length > 0) {
      cardLiabilitiesTotal = 0;
      cardLiabilitiesBreakdown = [];
      for (const card of data.cardLiabilities) {
        const stillOwed =
          !card.billYearMonth || compareYearMonths(currentDate, card.billYearMonth) < 0
            ? card.outstanding
            : 0;
        if (stillOwed > 0) {
          cardLiabilitiesTotal += stillOwed;
          cardLiabilitiesBreakdown.push({ linkId: card.linkId, name: card.name, outstanding: stillOwed });
        }
      }
    }

    // Net worth = assets - liabilities (+ member's home equity, if any)
    const netWorth =
      cashAccountsTotal +
      investmentsTotal +
      receivablesTotal -
      debtsTotal +
      (mortgageEquityTotal ?? 0) -
      (cardLiabilitiesTotal ?? 0) +
      (data.splitNetTotal ?? 0);

    months.push({
      yearMonth: currentDate,
      year,
      month,
      cashAccountsTotal,
      cashAccountsBreakdown,
      investmentsTotal,
      investmentsBreakdown,
      receivablesTotal,
      receivablesBreakdown,
      debtsTotal,
      debtsBreakdown,
      mortgageEquityTotal,
      mortgageLiabilityTotal,
      mortgageStakeTotal,
      mortgagesBreakdown,
      cardLiabilitiesTotal,
      cardLiabilitiesBreakdown,
      netWorth,
    });

    currentDate = addMonths(currentDate, 1);
  }

  return months;
}

/**
 * Get earliest start date across all entities
 */
export function getEarliestStartDate(data: WealthProjectionData): YearMonth {
  let earliest: YearMonth | null = null;

  for (const account of data.cashAccounts) {
    if (!earliest || compareYearMonths(account.startingDate, earliest) < 0) {
      earliest = account.startingDate;
    }
  }

  for (const inv of data.investments) {
    if (!earliest || compareYearMonths(inv.valuationDate, earliest) < 0) {
      earliest = inv.valuationDate;
    }
  }

  for (const rec of data.receivables) {
    if (!earliest || compareYearMonths(rec.startDate, earliest) < 0) {
      earliest = rec.startDate;
    }
  }

  for (const debt of data.debts) {
    if (!earliest || compareYearMonths(debt.startDate, earliest) < 0) {
      earliest = debt.startDate;
    }
  }

  return earliest ?? formatYearMonth(new Date().getFullYear(), new Date().getMonth() + 1);
}

/**
 * Get latest end date across all entities
 */
export function getLatestEndDate(
  data: WealthProjectionData,
  defaultHorizonMonths: number = 120
): YearMonth {
  let latest: YearMonth | null = null;

  for (const account of data.cashAccounts) {
    const endDate = account.customEndDate
      ? account.customEndDate
      : addMonths(account.startingDate, account.planningHorizonMonths - 1);
    if (!latest || compareYearMonths(endDate, latest) > 0) {
      latest = endDate;
    }
  }

  // For other entities, use default horizon if no explicit end
  const defaultEnd = addMonths(
    formatYearMonth(new Date().getFullYear(), new Date().getMonth() + 1),
    defaultHorizonMonths
  );

  return latest && compareYearMonths(latest, defaultEnd) > 0 ? latest : defaultEnd;
}
