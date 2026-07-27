import type { SalaryBenefit } from '@/types';

/**
 * Calculate net salary from gross salary and deductions.
 *
 * Taxable benefits increase the tax/contributions base but are NOT received as cash.
 * Non-taxable benefits do NOT affect the calculation at all.
 */
export function calculateNetSalary(
  grossSalary: number,
  taxRate: number,
  contributionsRate: number,
  otherDeductions: number = 0,
  benefits: SalaryBenefit[] = []
): number {
  const taxableBenefitsTotal = benefits
    .filter(b => b.isTaxable)
    .reduce((sum, b) => sum + b.amount, 0);
  const taxableBase = grossSalary + taxableBenefitsTotal;
  const taxAmount = taxableBase * (taxRate / 100);
  const contributionsAmount = taxableBase * (contributionsRate / 100);
  // Net = gross minus all deductions (benefits are NOT added back since they are not received as cash)
  return grossSalary - taxAmount - contributionsAmount - otherDeductions;
}
