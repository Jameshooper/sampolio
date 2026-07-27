import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { FinancialAccount, CreateAccountRequest, UpdateAccountRequest } from '@/types';
import {
  getUserDir,
  ensureDir,
  readEncryptedFile,
  writeEncryptedFile,
  listFiles,
  deleteFile,
} from './encryption';

function getAccountsDir(userId: string): string {
  return path.join(getUserDir(userId), 'accounts');
}

function getAccountFile(userId: string, accountId: string): string {
  return path.join(getAccountsDir(userId), `${accountId}.enc`);
}

export async function getAccounts(userId: string): Promise<FinancialAccount[]> {
  const accountsDir = getAccountsDir(userId);
  await ensureDir(accountsDir);

  const files = await listFiles(accountsDir);
  const encFiles = files.filter(file => file.endsWith('.enc'));
  const results = await Promise.all(
    encFiles.map(file => readEncryptedFile<FinancialAccount>(path.join(accountsDir, file)))
  );
  const accounts = results.filter((a): a is FinancialAccount => a !== null);

  // Sort by creation date, newest first
  return accounts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function getActiveAccounts(userId: string): Promise<FinancialAccount[]> {
  const accounts = await getAccounts(userId);
  return accounts.filter(a => !a.isArchived);
}

export async function getAccountById(userId: string, accountId: string): Promise<FinancialAccount | null> {
  const accountFile = getAccountFile(userId, accountId);
  return readEncryptedFile<FinancialAccount>(accountFile);
}

export async function createAccount(userId: string, data: CreateAccountRequest): Promise<FinancialAccount> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const account: FinancialAccount = {
    id,
    userId,
    name: data.name,
    currency: data.currency,
    startingBalance: data.startingBalance,
    startingDate: data.startingDate,
    planningHorizonMonths: data.planningHorizonMonths,
    customEndDate: data.customEndDate,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  };

  const accountsDir = getAccountsDir(userId);
  await ensureDir(accountsDir);

  const accountFile = getAccountFile(userId, id);
  await writeEncryptedFile(accountFile, account);

  return account;
}

export async function updateAccount(
  userId: string,
  accountId: string,
  updates: UpdateAccountRequest
): Promise<FinancialAccount | null> {
  const account = await getAccountById(userId, accountId);
  if (!account) {
    return null;
  }

  const updatedAccount: FinancialAccount = {
    ...account,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  const accountFile = getAccountFile(userId, accountId);
  await writeEncryptedFile(accountFile, updatedAccount);

  return updatedAccount;
}

export async function archiveAccount(userId: string, accountId: string): Promise<FinancialAccount | null> {
  return updateAccount(userId, accountId, { isArchived: true });
}

export async function unarchiveAccount(userId: string, accountId: string): Promise<FinancialAccount | null> {
  return updateAccount(userId, accountId, { isArchived: false });
}

export async function deleteAccount(userId: string, accountId: string): Promise<boolean> {
  const accountFile = getAccountFile(userId, accountId);
  await deleteFile(accountFile);
  return true;
}
