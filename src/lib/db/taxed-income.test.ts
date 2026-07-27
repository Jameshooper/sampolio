import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  createTaxedIncome,
  getTaxedIncomeById,
  recomputeSalaryLinkedTaxedIncomes,
} from './taxed-income';
import { createSalaryConfig, updateSalaryConfig } from './salary-configs';

/** Real disk round-trips (encrypted write → decrypt read) of taxed incomes. */
describe('taxed-income db layer', () => {
  let dataDir: string;
  const userId = 'test-user';

  beforeAll(() => {
    dataDir = path.join(os.tmpdir(), `sampolio-taxed-income-test-${process.pid}`);
    process.env.DATA_DIR = dataDir;
  });

  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('freezes net/tax/contributions on create with custom rates', async () => {
    const income = await createTaxedIncome(userId, 'acc-custom', {
      accountId: 'acc-custom',
      name: 'Bonus',
      grossAmount: 5000,
      useSalaryTaxSettings: false,
      customTaxRate: 30,
      customContributionsRate: 8,
      customOtherDeductions: 100,
      kind: 'one-off',
      scheduledDate: '2026-06',
    });

    expect(income.taxAmount).toBe(1500);
    expect(income.contributionsAmount).toBe(400);
    expect(income.netAmount).toBe(3000); // 5000 - 1500 - 400 - 100
  });

  it('resolves the active salary config rates when useSalaryTaxSettings is true', async () => {
    const accountId = 'acc-salary';
    await createSalaryConfig(userId, {
      accountId,
      name: 'Main job',
      grossSalary: 4000,
      taxRate: 25,
      contributionsRate: 10,
      otherDeductions: 0,
      startDate: '2026-01',
      isActive: true,
      isLinkedToRecurring: false,
    });

    const income = await createTaxedIncome(userId, accountId, {
      accountId,
      name: 'Holiday bonus',
      grossAmount: 1000,
      useSalaryTaxSettings: true,
      kind: 'one-off',
      scheduledDate: '2026-07',
    });

    expect(income.taxAmount).toBe(250);
    expect(income.contributionsAmount).toBe(100);
    expect(income.netAmount).toBe(650);
  });

  it('recompute updates only salary-linked incomes and returns the changed count', async () => {
    const accountId = 'acc-recompute';
    const config = await createSalaryConfig(userId, {
      accountId,
      name: 'Job',
      grossSalary: 4000,
      taxRate: 25,
      contributionsRate: 10,
      otherDeductions: 0,
      startDate: '2026-01',
      isActive: true,
      isLinkedToRecurring: false,
    });

    const linked = await createTaxedIncome(userId, accountId, {
      accountId,
      name: 'Linked bonus',
      grossAmount: 1000,
      useSalaryTaxSettings: true,
      kind: 'one-off',
      scheduledDate: '2026-07',
    });
    const custom = await createTaxedIncome(userId, accountId, {
      accountId,
      name: 'Custom bonus',
      grossAmount: 1000,
      useSalaryTaxSettings: false,
      customTaxRate: 50,
      customContributionsRate: 0,
      kind: 'one-off',
      scheduledDate: '2026-08',
    });

    // Bump the salary tax rate directly in the DB (no cascade at this layer).
    await updateSalaryConfig(userId, accountId, config.id, { taxRate: 30 });

    const changed = await recomputeSalaryLinkedTaxedIncomes(userId, accountId);
    expect(changed).toBe(1);

    const linkedAfter = await getTaxedIncomeById(userId, accountId, linked.id);
    expect(linkedAfter!.taxAmount).toBe(300); // recomputed at 30%
    expect(linkedAfter!.netAmount).toBe(600);

    const customAfter = await getTaxedIncomeById(userId, accountId, custom.id);
    expect(customAfter!.taxAmount).toBe(500); // untouched (custom rate)
    expect(customAfter!.netAmount).toBe(500);
  });

  it('recompute is a no-op with no active salary config', async () => {
    const accountId = 'acc-no-salary';
    const income = await createTaxedIncome(userId, accountId, {
      accountId,
      name: 'Bonus',
      grossAmount: 2000,
      useSalaryTaxSettings: true, // but there is no active salary config on this account
      kind: 'one-off',
      scheduledDate: '2026-06',
    });

    const changed = await recomputeSalaryLinkedTaxedIncomes(userId, accountId);
    expect(changed).toBe(0);

    const after = await getTaxedIncomeById(userId, accountId, income.id);
    // Unchanged (created with zero derived rates because there was no config).
    expect(after!.netAmount).toBe(income.netAmount);
  });

  it('round-trips skippedOccurrences', async () => {
    const accountId = 'acc-skips';
    const income = await createTaxedIncome(userId, accountId, {
      accountId,
      name: 'Recurring bonus',
      grossAmount: 3000,
      useSalaryTaxSettings: false,
      customTaxRate: 20,
      customContributionsRate: 5,
      kind: 'recurring',
      frequency: 'yearly',
      startDate: '2026-08',
      skippedOccurrences: ['2027-08', '2029-08'],
    });

    const readBack = await getTaxedIncomeById(userId, accountId, income.id);
    expect(readBack!.skippedOccurrences).toEqual(['2027-08', '2029-08']);
  });
});
