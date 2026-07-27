import { describe, it, expect } from 'vitest';
import { calculateNetSalary } from './salary-utils';
import { createMockSalaryBenefit } from '@/test/mocks';

describe('calculateNetSalary', () => {
  it('calculates net from gross with no benefits', () => {
    // Gross 5000, 25% tax, 8% contributions, 50 other
    // Tax: 5000 * 0.25 = 1250, Contributions: 5000 * 0.08 = 400
    // Net: 5000 - 1250 - 400 - 50 = 3300
    expect(calculateNetSalary(5000, 25, 8, 50)).toBe(3300);
  });

  it('taxable benefits increase tax base but are NOT added to net', () => {
    const taxableBenefit = createMockSalaryBenefit({ amount: 200, isTaxable: true });
    // Taxable base = 5000 + 200 = 5200
    // Tax: 5200 * 0.25 = 1300, Contributions: 5200 * 0.08 = 416
    // Net: 5000 - 1300 - 416 - 0 = 3284
    expect(calculateNetSalary(5000, 25, 8, 0, [taxableBenefit])).toBe(3284);
  });

  it('non-taxable benefits do NOT affect calculation', () => {
    const nonTaxableBenefit = createMockSalaryBenefit({ amount: 300, isTaxable: false });
    // Taxable base stays at 5000 (non-taxable not added)
    // Tax: 5000 * 0.25 = 1250, Contributions: 5000 * 0.08 = 400
    // Net: 5000 - 1250 - 400 - 0 = 3350
    expect(calculateNetSalary(5000, 25, 8, 0, [nonTaxableBenefit])).toBe(3350);
  });

  it('handles mixed taxable and non-taxable benefits', () => {
    const benefits = [
      createMockSalaryBenefit({ amount: 200, isTaxable: true }),
      createMockSalaryBenefit({ amount: 300, isTaxable: false }),
    ];
    // Taxable base = 5000 + 200 = 5200
    // Tax: 5200 * 0.25 = 1300, Contributions: 5200 * 0.08 = 416
    // Net: 5000 - 1300 - 416 - 0 = 3284
    expect(calculateNetSalary(5000, 25, 8, 0, benefits)).toBe(3284);
  });

  it('handles 0 gross salary', () => {
    expect(calculateNetSalary(0, 25, 8, 0)).toBe(0);
  });

  it('handles 0 tax rate', () => {
    // Only contributions deducted
    // Net: 5000 - 0 - (5000 * 0.08) - 0 = 5000 - 400 = 4600
    expect(calculateNetSalary(5000, 0, 8, 0)).toBe(4600);
  });

  it('handles 100% tax rate', () => {
    // Tax: 5000 * 1.0 = 5000, Contributions: 5000 * 0.08 = 400
    // Net: 5000 - 5000 - 400 = -400
    expect(calculateNetSalary(5000, 100, 8, 0)).toBe(-400);
  });

  it('defaults otherDeductions and benefits', () => {
    // With no optional params
    expect(calculateNetSalary(5000, 25, 8)).toBe(3350);
  });
});
