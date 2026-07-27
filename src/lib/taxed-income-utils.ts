import type { TaxedIncome, YearMonth } from '@/types';
import { addMonths, getIntervalMonths, isYearMonthInRange } from '@/lib/projection';

/**
 * Net a gross taxed-income amount: a percentage tax + a percentage
 * contributions cut, then a flat other-deductions subtraction. Mirrors
 * `calculateNetSalary`'s intent but taxes the *raw gross* (no taxable-benefit
 * base), which is the correct model for bonuses / holiday pay. Shared by the
 * DB layer (frozen at write time) and the modal's live preview.
 */
export function calculateTaxedIncomeNet(
  grossAmount: number,
  taxRate: number,
  contributionsRate: number,
  otherDeductions: number
): { netAmount: number; taxAmount: number; contributionsAmount: number } {
  const taxAmount = grossAmount * (taxRate / 100);
  const contributionsAmount = grossAmount * (contributionsRate / 100);
  const netAmount = grossAmount - taxAmount - contributionsAmount - otherDeductions;
  return { netAmount, taxAmount, contributionsAmount };
}

/**
 * The next `count` occurrence months (≥ `fromMonth`) for a recurring taxed
 * income, aligned to its interval from `startDate`. Empty for one-off incomes
 * or an incomplete schedule (no start / no frequency). Bounded by `endDate`.
 * Used by the modal to offer "skip this occurrence" chips.
 */
export function getUpcomingTaxedIncomeOccurrences(
  income: Pick<
    TaxedIncome,
    'kind' | 'frequency' | 'customIntervalMonths' | 'startDate' | 'scheduledDate' | 'endDate'
  >,
  fromMonth: YearMonth,
  count: number
): YearMonth[] {
  if (income.kind !== 'recurring') return [];
  const startDate = income.startDate || income.scheduledDate;
  if (!startDate || !income.frequency) return [];

  const interval = getIntervalMonths(income.frequency, income.customIntervalMonths);
  const result: YearMonth[] = [];
  // Step from the first occurrence by the interval; every visited month is a
  // real occurrence, so we only bound it (endDate) and skip past ones.
  let ym = startDate;
  const MAX_ITER = 1200; // 100 years of months — guards against a bad interval
  for (let iter = 0; result.length < count && iter < MAX_ITER; iter++) {
    if (!isYearMonthInRange(ym, startDate, income.endDate)) break; // past endDate
    if (ym >= fromMonth) result.push(ym);
    ym = addMonths(ym, interval);
  }
  return result;
}
