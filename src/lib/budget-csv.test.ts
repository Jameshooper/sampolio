import { describe, it, expect } from 'vitest';
import { buildExpenseLogCsv, buildBudgetSummaryCsv } from './budget-csv';
import { createMockBudget, createMockBudgetLine, createMockFundingSource, createMockBudgetExpenseEntry } from '@/test/mocks';

describe('buildExpenseLogCsv', () => {
  it('lists entries sorted by date with resolved source names and a total row', () => {
    const grant = createMockFundingSource({ name: 'Foundation grant', restrictedToCategories: undefined });
    const budget = createMockBudget({
      fundingSources: [grant],
      expenseEntries: [
        createMockBudgetExpenseEntry({ date: '2026-03-20', description: 'Train; intercity', amount: 240, category: 'Local transport', fundingSourceId: grant.id }),
        createMockBudgetExpenseEntry({ date: '2026-03-02', description: 'Groceries', amount: 99.9, category: 'Food' }),
      ],
    });
    const csv = buildExpenseLogCsv(budget);
    const lines = csv.replace('﻿', '').trimEnd().split('\r\n');
    expect(lines[0]).toBe('Date;Description;Category;Amount;Currency;Paid by;Note');
    expect(lines[1]).toBe('2026-03-02;Groceries;Food;99,90;SEK;;');
    // Description containing the delimiter is quoted.
    expect(lines[2]).toBe('2026-03-20;"Train; intercity";Local transport;240,00;SEK;Foundation grant;');
    expect(lines[3]).toBe('Total;;;339,90;SEK;;');
  });
});

describe('buildBudgetSummaryCsv', () => {
  it('includes per-category planned/spent/covered and a funding section', () => {
    const grant = createMockFundingSource({ name: 'Foundation grant', amount: 1000, restrictedToCategories: ['Accommodation'] });
    const budget = createMockBudget({
      lines: [createMockBudgetLine({ kind: 'one-off', month: '2026-03', category: 'Accommodation', amount: 800 })],
      fundingSources: [grant],
      expenseEntries: [createMockBudgetExpenseEntry({ category: 'Accommodation', amount: 750 })],
    });
    const csv = buildBudgetSummaryCsv(budget);
    expect(csv).toContain('Accommodation;800,00;750,00;-50,00;800,00');
    expect(csv).toContain('Funding source;Total;Usable;Claimed;Unusable surplus');
    expect(csv).toContain('Foundation grant;1000,00;800,00;0,00;200,00');
    expect(csv).toContain(`Period: 2026-03 – 2026-04`);
  });
});
