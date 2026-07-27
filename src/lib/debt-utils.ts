import type { Debt, DebtAmortizationRow } from '@/types';

export interface DebtPayoffInfo {
  percentPaid: number; // 0-100
  amountPaid: number;
  remaining: number;
  estimatedPayoffDate: string | null; // YYYY-MM or null
  monthlyPayment: number;
}

export function getDebtPayoffInfo(
  debt: Debt,
  amortizationRows: DebtAmortizationRow[]
): DebtPayoffInfo {
  // Remaining principal: last row's endingPrincipal, or initialPrincipal if no rows
  const remaining =
    amortizationRows.length > 0
      ? amortizationRows[amortizationRows.length - 1].endingPrincipal
      : debt.initialPrincipal;

  const amountPaid = debt.initialPrincipal - remaining;

  // Clamp percentPaid to 0-100
  const rawPercent =
    debt.initialPrincipal > 0
      ? (amountPaid / debt.initialPrincipal) * 100
      : 0;
  const percentPaid = Math.min(100, Math.max(0, rawPercent));

  // Estimated payoff date: yearMonth of first row where endingPrincipal <= 0
  const payoffRow = amortizationRows.find((row) => row.endingPrincipal <= 0);
  const estimatedPayoffDate = payoffRow ? payoffRow.yearMonth : null;

  // Monthly payment depends on debt type
  let monthlyPayment: number;
  if (debt.debtType === 'amortized') {
    monthlyPayment = debt.monthlyPayment ?? 0;
  } else if (debt.debtType === 'fixed-installment') {
    monthlyPayment = debt.installmentAmount ?? 0;
  } else {
    monthlyPayment = 0;
  }

  return {
    percentPaid,
    amountPaid,
    remaining,
    estimatedPayoffDate,
    monthlyPayment,
  };
}
