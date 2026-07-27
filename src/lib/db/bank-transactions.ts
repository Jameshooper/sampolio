/**
 * Enable Banking — transaction store (file I/O).
 *
 * One encrypted file per linked bank account, holding the full deduped
 * transaction list. The sync engine reads the existing list, merges incoming
 * rows with the pure dedup helper, and writes the merged result back. This
 * module only does read/replace — the merge/dedup logic is pure (bank/dedup.ts).
 *
 * Layout: data/users/{userId}/bank/accounts/{linkedAccountId}/transactions.enc
 */

import * as path from 'path';
import type { BankTransaction } from '@/types';
import {
  getUserDir,
  ensureDir,
  readEncryptedFile,
  writeEncryptedFile,
  deleteFile,
} from './encryption';

function getAccountsDir(userId: string): string {
  return path.join(getUserDir(userId), 'bank', 'accounts');
}

function getTransactionsFile(userId: string, linkedAccountId: string): string {
  return path.join(getAccountsDir(userId), linkedAccountId, 'transactions.enc');
}

interface TransactionsData {
  transactions: BankTransaction[];
}

export async function getBankTransactions(
  userId: string,
  linkedAccountId: string
): Promise<BankTransaction[]> {
  const data = await readEncryptedFile<TransactionsData>(
    getTransactionsFile(userId, linkedAccountId)
  );
  return data?.transactions ?? [];
}

/** Replace the full transaction list for a linked account (post-merge). */
export async function writeBankTransactions(
  userId: string,
  linkedAccountId: string,
  transactions: BankTransaction[]
): Promise<void> {
  const file = getTransactionsFile(userId, linkedAccountId);
  await ensureDir(path.dirname(file));
  await writeEncryptedFile<TransactionsData>(file, { transactions });
}

export async function deleteBankTransactionsForAccount(
  userId: string,
  linkedAccountId: string
): Promise<void> {
  await deleteFile(getTransactionsFile(userId, linkedAccountId));
}
