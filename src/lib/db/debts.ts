import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  Debt,
  DebtReferenceRate,
  DebtExtraPayment,
  CreateDebtRequest,
  UpdateDebtRequest,
} from '@/types';
import {
  getUserDir,
  ensureDir,
  readEncryptedFile,
  writeEncryptedFile,
  listFiles,
  deleteFile,
} from './encryption';

function getDebtsDir(userId: string): string {
  return path.join(getUserDir(userId), 'debts');
}

function getDebtFile(userId: string, debtId: string): string {
  return path.join(getDebtsDir(userId), `${debtId}.enc`);
}

function getReferenceRatesDir(userId: string, debtId: string): string {
  return path.join(getDebtsDir(userId), debtId, 'reference-rates');
}

function getReferenceRateFile(userId: string, debtId: string, rateId: string): string {
  return path.join(getReferenceRatesDir(userId, debtId), `${rateId}.enc`);
}

function getExtraPaymentsDir(userId: string, debtId: string): string {
  return path.join(getDebtsDir(userId), debtId, 'extra-payments');
}

function getExtraPaymentFile(userId: string, debtId: string, paymentId: string): string {
  return path.join(getExtraPaymentsDir(userId, debtId), `${paymentId}.enc`);
}

// ============================================================
// DEBTS CRUD
// ============================================================

export async function getDebts(userId: string): Promise<Debt[]> {
  const debtsDir = getDebtsDir(userId);
  await ensureDir(debtsDir);

  const files = await listFiles(debtsDir);
  const encFiles = files.filter(file => file.endsWith('.enc'));
  const results = await Promise.all(
    encFiles.map(file => readEncryptedFile<Debt>(path.join(debtsDir, file)))
  );
  const debts = results.filter((d): d is Debt => d !== null);

  return debts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function getDebtById(userId: string, debtId: string): Promise<Debt | null> {
  const debtFile = getDebtFile(userId, debtId);
  return readEncryptedFile<Debt>(debtFile);
}

export async function createDebt(userId: string, data: CreateDebtRequest): Promise<Debt> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const debt: Debt = {
    id,
    userId,
    name: data.name,
    description: data.description,
    currency: data.currency,
    debtType: data.debtType,
    initialPrincipal: data.initialPrincipal,
    startDate: data.startDate,
    // Amortized loan fields
    interestModelType: data.interestModelType ?? 'none',
    fixedInterestRate: data.fixedInterestRate,
    referenceRateMargin: data.referenceRateMargin,
    rateResetFrequency: data.rateResetFrequency,
    monthlyPayment: data.monthlyPayment,
    // Fixed-installment fields
    installmentAmount: data.installmentAmount,
    totalInstallments: data.totalInstallments,
    remainingInstallments: data.totalInstallments,
    // Link to cash account
    linkedAccountId: data.linkedAccountId,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  };

  const debtsDir = getDebtsDir(userId);
  await ensureDir(debtsDir);

  const debtFile = getDebtFile(userId, id);
  await writeEncryptedFile(debtFile, debt);

  return debt;
}

export async function updateDebt(
  userId: string,
  debtId: string,
  updates: UpdateDebtRequest
): Promise<Debt | null> {
  const debt = await getDebtById(userId, debtId);
  if (!debt) {
    return null;
  }

  const updatedDebt: Debt = {
    ...debt,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  const debtFile = getDebtFile(userId, debtId);
  await writeEncryptedFile(debtFile, updatedDebt);

  return updatedDebt;
}

export async function deleteDebt(userId: string, debtId: string): Promise<boolean> {
  // Delete reference rates
  const ratesDir = getReferenceRatesDir(userId, debtId);
  try {
    const rateFiles = await listFiles(ratesDir);
    for (const file of rateFiles) {
      await deleteFile(path.join(ratesDir, file));
    }
  } catch {
    // Directory might not exist
  }

  // Delete extra payments
  const paymentsDir = getExtraPaymentsDir(userId, debtId);
  try {
    const paymentFiles = await listFiles(paymentsDir);
    for (const file of paymentFiles) {
      await deleteFile(path.join(paymentsDir, file));
    }
  } catch {
    // Directory might not exist
  }

  const debtFile = getDebtFile(userId, debtId);
  await deleteFile(debtFile);
  return true;
}

// ============================================================
// REFERENCE RATES CRUD
// ============================================================

export async function getReferenceRates(userId: string, debtId: string): Promise<DebtReferenceRate[]> {
  const ratesDir = getReferenceRatesDir(userId, debtId);
  try {
    await ensureDir(ratesDir);
  } catch {
    return [];
  }

  const files = await listFiles(ratesDir);
  const encFiles = files.filter(file => file.endsWith('.enc'));
  const results = await Promise.all(
    encFiles.map(file => readEncryptedFile<DebtReferenceRate>(path.join(ratesDir, file)))
  );
  const rates = results.filter((r): r is DebtReferenceRate => r !== null);

  return rates.sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
}

export async function setReferenceRate(
  userId: string,
  debtId: string,
  yearMonth: string,
  rate: number
): Promise<DebtReferenceRate> {
  const ratesDir = getReferenceRatesDir(userId, debtId);
  await ensureDir(ratesDir);

  // Check if rate already exists for this month
  const existingRates = await getReferenceRates(userId, debtId);
  const existing = existingRates.find((r) => r.yearMonth === yearMonth);

  if (existing) {
    // Update existing
    const updatedRate: DebtReferenceRate = { ...existing, rate };
    const rateFile = getReferenceRateFile(userId, debtId, existing.id);
    await writeEncryptedFile(rateFile, updatedRate);
    return updatedRate;
  }

  // Create new
  const id = uuidv4();
  const now = new Date().toISOString();

  const referenceRate: DebtReferenceRate = {
    id,
    debtId,
    yearMonth,
    rate,
    createdAt: now,
  };

  const rateFile = getReferenceRateFile(userId, debtId, id);
  await writeEncryptedFile(rateFile, referenceRate);

  return referenceRate;
}

export async function deleteReferenceRate(
  userId: string,
  debtId: string,
  rateId: string
): Promise<boolean> {
  const rateFile = getReferenceRateFile(userId, debtId, rateId);
  await deleteFile(rateFile);
  return true;
}

// ============================================================
// EXTRA PAYMENTS CRUD
// ============================================================

export async function getExtraPayments(userId: string, debtId: string): Promise<DebtExtraPayment[]> {
  const paymentsDir = getExtraPaymentsDir(userId, debtId);
  try {
    await ensureDir(paymentsDir);
  } catch {
    return [];
  }

  const files = await listFiles(paymentsDir);
  const encFiles = files.filter(file => file.endsWith('.enc'));
  const results = await Promise.all(
    encFiles.map(file => readEncryptedFile<DebtExtraPayment>(path.join(paymentsDir, file)))
  );
  const payments = results.filter((p): p is DebtExtraPayment => p !== null);

  return payments.sort((a, b) => a.date.localeCompare(b.date));
}

export async function createExtraPayment(
  userId: string,
  debtId: string,
  date: string,
  amount: number,
  note?: string
): Promise<DebtExtraPayment> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const payment: DebtExtraPayment = {
    id,
    debtId,
    date,
    amount,
    note,
    createdAt: now,
  };

  const paymentsDir = getExtraPaymentsDir(userId, debtId);
  await ensureDir(paymentsDir);

  const paymentFile = getExtraPaymentFile(userId, debtId, id);
  await writeEncryptedFile(paymentFile, payment);

  return payment;
}

export async function deleteExtraPayment(
  userId: string,
  debtId: string,
  paymentId: string
): Promise<boolean> {
  const paymentFile = getExtraPaymentFile(userId, debtId, paymentId);
  await deleteFile(paymentFile);
  return true;
}
