import { describe, it, expect } from 'vitest';
import { recurringItemSchema } from './recurring-item.schema';
import { plannedItemSchema } from './planned-item.schema';
import { salaryConfigSchema } from './salary-config.schema';

describe('recurringItemSchema', () => {
  const validData = {
    type: 'income' as const,
    name: 'Salary',
    amount: 3000,
    category: 'Salary',
    frequency: 'monthly' as const,
    startDate: '2026-01',
  };

  it('accepts valid recurring item', () => {
    expect(recurringItemSchema.safeParse(validData).success).toBe(true);
  });

  it('rejects empty name', () => {
    expect(recurringItemSchema.safeParse({ ...validData, name: '' }).success).toBe(false);
  });

  it('rejects zero amount', () => {
    expect(recurringItemSchema.safeParse({ ...validData, amount: 0 }).success).toBe(false);
  });

  it('rejects negative amount', () => {
    expect(recurringItemSchema.safeParse({ ...validData, amount: -100 }).success).toBe(false);
  });

  it('requires custom interval when frequency is custom', () => {
    const result = recurringItemSchema.safeParse({
      ...validData,
      frequency: 'custom',
    });
    expect(result.success).toBe(false);
  });

  it('accepts custom frequency with interval', () => {
    const result = recurringItemSchema.safeParse({
      ...validData,
      frequency: 'custom',
      customIntervalMonths: 2,
    });
    expect(result.success).toBe(true);
  });
});

describe('plannedItemSchema', () => {
  it('accepts valid one-off item', () => {
    const result = plannedItemSchema.safeParse({
      type: 'expense',
      kind: 'one-off',
      name: 'Vacation',
      amount: 2000,
      scheduledDate: '2026-06',
    });
    expect(result.success).toBe(true);
  });

  it('rejects one-off without scheduled date', () => {
    const result = plannedItemSchema.safeParse({
      type: 'expense',
      kind: 'one-off',
      name: 'Vacation',
      amount: 2000,
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid repeating item', () => {
    const result = plannedItemSchema.safeParse({
      type: 'expense',
      kind: 'repeating',
      name: 'Subscription',
      amount: 15,
      frequency: 'monthly',
      firstOccurrence: '2026-01',
    });
    expect(result.success).toBe(true);
  });

  it('rejects repeating without frequency', () => {
    const result = plannedItemSchema.safeParse({
      type: 'expense',
      kind: 'repeating',
      name: 'Subscription',
      amount: 15,
      firstOccurrence: '2026-01',
    });
    expect(result.success).toBe(false);
  });

  describe('reimbursement fields', () => {
    const oneOffExpense = {
      type: 'expense' as const,
      kind: 'one-off' as const,
      name: 'Work trip hotel',
      amount: 450,
      scheduledDate: '2026-08',
    };

    it('rejects isReimbursable without expected month', () => {
      const result = plannedItemSchema.safeParse({
        ...oneOffExpense,
        isReimbursable: true,
      });
      expect(result.success).toBe(false);
    });

    it('accepts isReimbursable with expected month', () => {
      const result = plannedItemSchema.safeParse({
        ...oneOffExpense,
        isReimbursable: true,
        expectedReimbursementMonth: '2026-09',
      });
      expect(result.success).toBe(true);
    });

    it('enforces YYYY-MM format on the expected month', () => {
      const result = plannedItemSchema.safeParse({
        ...oneOffExpense,
        isReimbursable: true,
        expectedReimbursementMonth: '09/2026',
      });
      expect(result.success).toBe(false);
    });

    it('rejects isReimbursable on income items', () => {
      const result = plannedItemSchema.safeParse({
        ...oneOffExpense,
        type: 'income',
        isReimbursable: true,
        expectedReimbursementMonth: '2026-09',
      });
      expect(result.success).toBe(false);
    });

    it('rejects isReimbursable on repeating items', () => {
      const result = plannedItemSchema.safeParse({
        type: 'expense',
        kind: 'repeating',
        name: 'Subscription',
        amount: 15,
        frequency: 'monthly',
        firstOccurrence: '2026-01',
        isReimbursable: true,
        expectedReimbursementMonth: '2026-09',
      });
      expect(result.success).toBe(false);
    });

    it('accepts a plain one-off expense with isReimbursable false', () => {
      const result = plannedItemSchema.safeParse({
        ...oneOffExpense,
        isReimbursable: false,
      });
      expect(result.success).toBe(true);
    });
  });
});

describe('salaryConfigSchema', () => {
  const validSalary = {
    name: 'Main Job',
    grossSalary: 5000,
    taxRate: 25,
    contributionsRate: 8,
    startDate: '2026-01',
  };

  it('accepts valid salary config', () => {
    expect(salaryConfigSchema.safeParse(validSalary).success).toBe(true);
  });

  it('rejects zero gross salary', () => {
    expect(salaryConfigSchema.safeParse({ ...validSalary, grossSalary: 0 }).success).toBe(false);
  });

  it('rejects tax rate over 100', () => {
    expect(salaryConfigSchema.safeParse({ ...validSalary, taxRate: 101 }).success).toBe(false);
  });

  it('accepts salary with benefits', () => {
    const result = salaryConfigSchema.safeParse({
      ...validSalary,
      benefits: [{ id: '1', name: 'Lunch', amount: 150, isTaxable: true }],
    });
    expect(result.success).toBe(true);
  });
});
