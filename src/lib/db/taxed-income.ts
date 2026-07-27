import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  TaxedIncome,
  CreateTaxedIncomeRequest,
  UpdateTaxedIncomeRequest,
  SalaryConfig,
} from '@/types';
import {
  getUserDir,
  ensureDir,
  readEncryptedFile,
  writeEncryptedFile,
  listFiles,
  deleteFile,
} from './encryption';
import { getSalaryConfigs } from './salary-configs';
import { calculateTaxedIncomeNet } from '@/lib/taxed-income-utils';

function getTaxedIncomeDir(userId: string, accountId: string): string {
  return path.join(getUserDir(userId), 'accounts', accountId, 'taxed-income');
}

function getTaxedIncomeFile(userId: string, accountId: string, incomeId: string): string {
  return path.join(getTaxedIncomeDir(userId, accountId), `${incomeId}.enc`);
}

// Get default tax settings from salary configs
async function getDefaultTaxSettings(
  userId: string,
  accountId: string
): Promise<{ taxRate: number; contributionsRate: number; otherDeductions: number } | null> {
  const salaryConfigs = await getSalaryConfigs(userId, accountId);
  const activeConfig = salaryConfigs.find((c: SalaryConfig) => c.isActive);

  if (activeConfig) {
    return {
      taxRate: activeConfig.taxRate,
      contributionsRate: activeConfig.contributionsRate,
      otherDeductions: activeConfig.otherDeductions,
    };
  }
  return null;
}

// ============================================================
// TAXED INCOME CRUD
// ============================================================

export async function getTaxedIncomes(userId: string, accountId: string): Promise<TaxedIncome[]> {
  const incomeDir = getTaxedIncomeDir(userId, accountId);
  try {
    await ensureDir(incomeDir);
  } catch {
    return [];
  }

  const files = await listFiles(incomeDir);
  const encFiles = files.filter(file => file.endsWith('.enc'));
  const results = await Promise.all(
    encFiles.map(file => readEncryptedFile<TaxedIncome>(path.join(incomeDir, file)))
  );
  const incomes = results.filter((i): i is TaxedIncome => i !== null);

  return incomes.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function getTaxedIncomeById(
  userId: string,
  accountId: string,
  incomeId: string
): Promise<TaxedIncome | null> {
  const incomeFile = getTaxedIncomeFile(userId, accountId, incomeId);
  return readEncryptedFile<TaxedIncome>(incomeFile);
}

export async function createTaxedIncome(
  userId: string,
  accountId: string,
  data: CreateTaxedIncomeRequest
): Promise<TaxedIncome> {
  const id = uuidv4();
  const now = new Date().toISOString();

  // Determine tax settings
  let taxRate = data.customTaxRate ?? 0;
  let contributionsRate = data.customContributionsRate ?? 0;
  let otherDeductions = data.customOtherDeductions ?? 0;

  if (data.useSalaryTaxSettings) {
    const defaultSettings = await getDefaultTaxSettings(userId, accountId);
    if (defaultSettings) {
      taxRate = defaultSettings.taxRate;
      contributionsRate = defaultSettings.contributionsRate;
      otherDeductions = defaultSettings.otherDeductions;
    }
  }

  const { netAmount, taxAmount, contributionsAmount } = calculateTaxedIncomeNet(
    data.grossAmount,
    taxRate,
    contributionsRate,
    otherDeductions
  );

  const income: TaxedIncome = {
    id,
    accountId,
    name: data.name,
    grossAmount: data.grossAmount,
    useSalaryTaxSettings: data.useSalaryTaxSettings ?? false,
    customTaxRate: data.customTaxRate,
    customContributionsRate: data.customContributionsRate,
    customOtherDeductions: data.customOtherDeductions,
    netAmount,
    taxAmount,
    contributionsAmount,
    kind: data.kind,
    scheduledDate: data.scheduledDate,
    frequency: data.frequency,
    customIntervalMonths: data.customIntervalMonths,
    startDate: data.startDate,
    endDate: data.endDate,
    skippedOccurrences: data.skippedOccurrences,
    isActive: data.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  };

  const incomeDir = getTaxedIncomeDir(userId, accountId);
  await ensureDir(incomeDir);

  const incomeFile = getTaxedIncomeFile(userId, accountId, id);
  await writeEncryptedFile(incomeFile, income);

  return income;
}

export async function updateTaxedIncome(
  userId: string,
  accountId: string,
  incomeId: string,
  updates: UpdateTaxedIncomeRequest
): Promise<TaxedIncome | null> {
  const income = await getTaxedIncomeById(userId, accountId, incomeId);
  if (!income) {
    return null;
  }

  // Recalculate net amount if gross or tax settings changed
  let taxRate = updates.customTaxRate ?? income.customTaxRate ?? 0;
  let contributionsRate = updates.customContributionsRate ?? income.customContributionsRate ?? 0;
  let otherDeductions = updates.customOtherDeductions ?? income.customOtherDeductions ?? 0;
  const grossAmount = updates.grossAmount ?? income.grossAmount;
  const useSalaryTaxSettings = updates.useSalaryTaxSettings ?? income.useSalaryTaxSettings;

  if (useSalaryTaxSettings) {
    const defaultSettings = await getDefaultTaxSettings(userId, accountId);
    if (defaultSettings) {
      taxRate = defaultSettings.taxRate;
      contributionsRate = defaultSettings.contributionsRate;
      otherDeductions = defaultSettings.otherDeductions;
    }
  }

  const { netAmount, taxAmount, contributionsAmount } = calculateTaxedIncomeNet(
    grossAmount,
    taxRate,
    contributionsRate,
    otherDeductions
  );

  const updatedIncome: TaxedIncome = {
    ...income,
    ...updates,
    netAmount,
    taxAmount,
    contributionsAmount,
    updatedAt: new Date().toISOString(),
  };

  const incomeFile = getTaxedIncomeFile(userId, accountId, incomeId);
  await writeEncryptedFile(incomeFile, updatedIncome);

  return updatedIncome;
}

export async function deleteTaxedIncome(
  userId: string,
  accountId: string,
  incomeId: string
): Promise<boolean> {
  const incomeFile = getTaxedIncomeFile(userId, accountId, incomeId);
  await deleteFile(incomeFile);
  return true;
}

/**
 * Recompute the frozen net/tax/contributions of every taxed income on the
 * account that follows the salary's tax settings (`useSalaryTaxSettings`), so a
 * change to the account's active salary config cascades. No active salary
 * config → nothing to derive from, returns 0 (never rewrites). Persists only
 * the rows whose numbers actually changed; returns the changed count.
 */
export async function recomputeSalaryLinkedTaxedIncomes(
  userId: string,
  accountId: string
): Promise<number> {
  const defaultSettings = await getDefaultTaxSettings(userId, accountId);
  if (!defaultSettings) return 0;

  const incomes = await getTaxedIncomes(userId, accountId);
  let changed = 0;
  for (const income of incomes) {
    if (!income.useSalaryTaxSettings) continue;

    const { netAmount, taxAmount, contributionsAmount } = calculateTaxedIncomeNet(
      income.grossAmount,
      defaultSettings.taxRate,
      defaultSettings.contributionsRate,
      defaultSettings.otherDeductions
    );

    if (
      netAmount === income.netAmount &&
      taxAmount === income.taxAmount &&
      contributionsAmount === income.contributionsAmount
    ) {
      continue;
    }

    const updated: TaxedIncome = {
      ...income,
      netAmount,
      taxAmount,
      contributionsAmount,
      updatedAt: new Date().toISOString(),
    };
    await writeEncryptedFile(getTaxedIncomeFile(userId, accountId, income.id), updated);
    changed++;
  }
  return changed;
}
