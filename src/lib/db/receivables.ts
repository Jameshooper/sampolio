import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  Receivable,
  ReceivableRepayment,
  CreateReceivableRequest,
  UpdateReceivableRequest,
  CreateRepaymentRequest,
} from '@/types';
import {
  getUserDir,
  ensureDir,
  readEncryptedFile,
  writeEncryptedFile,
  listFiles,
  deleteFile,
} from './encryption';

function getReceivablesDir(userId: string): string {
  return path.join(getUserDir(userId), 'receivables');
}

function getReceivableFile(userId: string, receivableId: string): string {
  return path.join(getReceivablesDir(userId), `${receivableId}.enc`);
}

function getRepaymentsDir(userId: string, receivableId: string): string {
  return path.join(getReceivablesDir(userId), receivableId, 'repayments');
}

function getRepaymentFile(userId: string, receivableId: string, repaymentId: string): string {
  return path.join(getRepaymentsDir(userId, receivableId), `${repaymentId}.enc`);
}

// ============================================================
// RECEIVABLES CRUD
// ============================================================

export async function getReceivables(userId: string): Promise<Receivable[]> {
  const receivablesDir = getReceivablesDir(userId);
  await ensureDir(receivablesDir);

  const files = await listFiles(receivablesDir);
  const encFiles = files.filter(file => file.endsWith('.enc'));
  const rawResults = await Promise.all(
    encFiles.map(file => readEncryptedFile<Receivable>(path.join(receivablesDir, file)))
  );
  const validReceivables = rawResults.filter((r): r is Receivable => r !== null);

  // Recalculate balances in parallel
  const receivables = await Promise.all(
    validReceivables.map(async (receivable) => {
      const repayments = await getRepayments(userId, receivable.id);
      const totalRepaid = repayments.reduce((sum, r) => sum + r.amount, 0);
      return { ...receivable, currentBalance: receivable.initialPrincipal - totalRepaid };
    })
  );

  return receivables.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function getReceivableById(userId: string, receivableId: string): Promise<Receivable | null> {
  const receivableFile = getReceivableFile(userId, receivableId);
  const receivable = await readEncryptedFile<Receivable>(receivableFile);

  if (receivable) {
    const repayments = await getRepayments(userId, receivableId);
    const totalRepaid = repayments.reduce((sum, r) => sum + r.amount, 0);
    return { ...receivable, currentBalance: receivable.initialPrincipal - totalRepaid };
  }

  return receivable;
}

export async function createReceivable(userId: string, data: CreateReceivableRequest): Promise<Receivable> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const receivable: Receivable = {
    id,
    userId,
    name: data.name,
    description: data.description,
    currency: data.currency,
    initialPrincipal: data.initialPrincipal,
    currentBalance: data.initialPrincipal, // No repayments yet
    note: data.note,
    hasInterest: data.hasInterest ?? false,
    annualInterestRate: data.annualInterestRate,
    expectedMonthlyRepayment: data.expectedMonthlyRepayment,
    startDate: data.startDate,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  };

  const receivablesDir = getReceivablesDir(userId);
  await ensureDir(receivablesDir);

  const receivableFile = getReceivableFile(userId, id);
  await writeEncryptedFile(receivableFile, receivable);

  return receivable;
}

export async function updateReceivable(
  userId: string,
  receivableId: string,
  updates: UpdateReceivableRequest
): Promise<Receivable | null> {
  const receivable = await getReceivableById(userId, receivableId);
  if (!receivable) {
    return null;
  }

  const updatedReceivable: Receivable = {
    ...receivable,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  // Recalculate current balance if initial principal changed
  // but only if currentBalance wasn't explicitly provided
  if (updates.initialPrincipal !== undefined && !('currentBalance' in updates)) {
    const repayments = await getRepayments(userId, receivableId);
    const totalRepaid = repayments.reduce((sum, r) => sum + r.amount, 0);
    updatedReceivable.currentBalance = updates.initialPrincipal - totalRepaid;
  }

  const receivableFile = getReceivableFile(userId, receivableId);
  await writeEncryptedFile(receivableFile, updatedReceivable);

  return updatedReceivable;
}

export async function deleteReceivable(userId: string, receivableId: string): Promise<boolean> {
  // Delete all repayments first
  const repaymentsDir = getRepaymentsDir(userId, receivableId);
  try {
    const repaymentFiles = await listFiles(repaymentsDir);
    for (const file of repaymentFiles) {
      await deleteFile(path.join(repaymentsDir, file));
    }
  } catch {
    // Directory might not exist
  }

  const receivableFile = getReceivableFile(userId, receivableId);
  await deleteFile(receivableFile);
  return true;
}

// ============================================================
// REPAYMENTS CRUD
// ============================================================

export async function getRepayments(userId: string, receivableId: string): Promise<ReceivableRepayment[]> {
  const repaymentsDir = getRepaymentsDir(userId, receivableId);
  try {
    await ensureDir(repaymentsDir);
  } catch {
    return [];
  }

  const files = await listFiles(repaymentsDir);
  const encFiles = files.filter(file => file.endsWith('.enc'));
  const results = await Promise.all(
    encFiles.map(file => readEncryptedFile<ReceivableRepayment>(path.join(repaymentsDir, file)))
  );
  const repayments = results.filter((r): r is ReceivableRepayment => r !== null);

  return repayments.sort((a, b) => a.date.localeCompare(b.date));
}

export async function createRepayment(
  userId: string,
  receivableId: string,
  data: CreateRepaymentRequest
): Promise<ReceivableRepayment> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const repayment: ReceivableRepayment = {
    id,
    receivableId,
    date: data.date,
    amount: data.amount,
    note: data.note,
    linkedAccountId: data.linkedAccountId,
    createdAt: now,
  };

  const repaymentsDir = getRepaymentsDir(userId, receivableId);
  await ensureDir(repaymentsDir);

  const repaymentFile = getRepaymentFile(userId, receivableId, id);
  await writeEncryptedFile(repaymentFile, repayment);

  return repayment;
}

export async function deleteRepayment(
  userId: string,
  receivableId: string,
  repaymentId: string
): Promise<boolean> {
  const repaymentFile = getRepaymentFile(userId, receivableId, repaymentId);
  await deleteFile(repaymentFile);
  return true;
}
