import { describe, it, expect } from 'vitest';
import { calculateTaxedIncomeNet, getUpcomingTaxedIncomeOccurrences } from './taxed-income-utils';

describe('calculateTaxedIncomeNet', () => {
  it('applies percentage tax + contributions to the raw gross', () => {
    const { netAmount, taxAmount, contributionsAmount } = calculateTaxedIncomeNet(5000, 30, 8, 0);
    expect(taxAmount).toBe(1500);
    expect(contributionsAmount).toBe(400);
    expect(netAmount).toBe(3100);
  });

  it('subtracts flat other deductions after the percentage cuts', () => {
    const { netAmount, taxAmount, contributionsAmount } = calculateTaxedIncomeNet(1000, 20, 5, 50);
    expect(taxAmount).toBe(200);
    expect(contributionsAmount).toBe(50);
    expect(netAmount).toBe(700); // 1000 - 200 - 50 - 50
  });

  it('returns the full gross when all rates and deductions are zero', () => {
    const { netAmount, taxAmount, contributionsAmount } = calculateTaxedIncomeNet(2500, 0, 0, 0);
    expect(taxAmount).toBe(0);
    expect(contributionsAmount).toBe(0);
    expect(netAmount).toBe(2500);
  });
});

describe('getUpcomingTaxedIncomeOccurrences', () => {
  it('returns an empty list for a one-off income', () => {
    expect(
      getUpcomingTaxedIncomeOccurrences(
        { kind: 'one-off', scheduledDate: '2026-06', frequency: undefined, startDate: undefined, customIntervalMonths: undefined, endDate: undefined },
        '2026-01',
        3,
      )
    ).toEqual([]);
  });

  it('returns an empty list when the schedule is incomplete', () => {
    expect(
      getUpcomingTaxedIncomeOccurrences(
        { kind: 'recurring', frequency: undefined, startDate: undefined, scheduledDate: undefined, customIntervalMonths: undefined, endDate: undefined },
        '2026-01',
        3,
      )
    ).toEqual([]);
  });

  it('lists yearly occurrences from an August start, skipping past ones', () => {
    const result = getUpcomingTaxedIncomeOccurrences(
      { kind: 'recurring', frequency: 'yearly', startDate: '2025-08', scheduledDate: undefined, customIntervalMonths: undefined, endDate: undefined },
      '2026-01',
      3,
    );
    expect(result).toEqual(['2026-08', '2027-08', '2028-08']);
  });

  it('lists quarterly occurrences aligned to the start month', () => {
    const result = getUpcomingTaxedIncomeOccurrences(
      { kind: 'recurring', frequency: 'quarterly', startDate: '2026-01', scheduledDate: undefined, customIntervalMonths: undefined, endDate: undefined },
      '2026-01',
      4,
    );
    expect(result).toEqual(['2026-01', '2026-04', '2026-07', '2026-10']);
  });

  it('stops at the end date', () => {
    const result = getUpcomingTaxedIncomeOccurrences(
      { kind: 'recurring', frequency: 'yearly', startDate: '2026-03', scheduledDate: undefined, customIntervalMonths: undefined, endDate: '2028-01' },
      '2026-01',
      5,
    );
    expect(result).toEqual(['2026-03', '2027-03']);
  });
});
