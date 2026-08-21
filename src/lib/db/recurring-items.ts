import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  RecurringItem,
  CreateRecurringItemRequest,
  UpdateRecurringItemRequest
} from '@/types';
import {
  getUserDir,
  ensureDir,
  readEncryptedFile,
  writeEncryptedFile,
  listFiles,
  deleteFile,
} from './encryption';

function getRecurringItemsDir(userId: string, accountId: string): string {
  return path.join(getUserDir(userId), 'accounts', accountId, 'recurring');
}

function getRecurringItemFile(userId: string, accountId: string, itemId: string): string {
  return path.join(getRecurringItemsDir(userId, accountId), `${itemId}.enc`);
}

export async function getRecurringItems(userId: string, accountId: string): Promise<RecurringItem[]> {
  const itemsDir = getRecurringItemsDir(userId, accountId);
  await ensureDir(itemsDir);

  const files = await listFiles(itemsDir);
  const encFiles = files.filter(file => file.endsWith('.enc'));
  const results = await Promise.all(
    encFiles.map(file => readEncryptedFile<RecurringItem>(path.join(itemsDir, file)))
  );
  const items = results.filter((item): item is RecurringItem => item !== null);

  // Sort by name
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getActiveRecurringItems(userId: string, accountId: string): Promise<RecurringItem[]> {
  const items = await getRecurringItems(userId, accountId);
  return items.filter(item => item.isActive);
}

export async function getRecurringItemsByType(
  userId: string,
  accountId: string,
  type: 'income' | 'expense'
): Promise<RecurringItem[]> {
  const items = await getRecurringItems(userId, accountId);
  return items.filter(item => item.type === type);
}

export async function getRecurringItemById(
  userId: string,
  accountId: string,
  itemId: string
): Promise<RecurringItem | null> {
  const itemFile = getRecurringItemFile(userId, accountId, itemId);
  return readEncryptedFile<RecurringItem>(itemFile);
}

export async function createRecurringItem(
  userId: string,
  data: CreateRecurringItemRequest
): Promise<RecurringItem> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const item: RecurringItem = {
    id,
    accountId: data.accountId,
    type: data.type,
    name: data.name,
    amount: data.amount,
    category: data.category,
    frequency: data.frequency,
    customIntervalMonths: data.customIntervalMonths,
    startDate: data.startDate,
    endDate: data.endDate,
    isShared: data.isShared,
    shareRatio: data.shareRatio,
    paidByCardLinkId: data.paidByCardLinkId,
    isFixedAmount: data.isFixedAmount,
    isActive: data.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  };

  const itemsDir = getRecurringItemsDir(userId, data.accountId);
  await ensureDir(itemsDir);

  const itemFile = getRecurringItemFile(userId, data.accountId, id);
  await writeEncryptedFile(itemFile, item);

  return item;
}

export async function updateRecurringItem(
  userId: string,
  accountId: string,
  itemId: string,
  updates: UpdateRecurringItemRequest
): Promise<RecurringItem | null> {
  const item = await getRecurringItemById(userId, accountId, itemId);
  if (!item) {
    return null;
  }

  const updatedItem: RecurringItem = {
    ...item,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  const itemFile = getRecurringItemFile(userId, accountId, itemId);
  await writeEncryptedFile(itemFile, updatedItem);

  return updatedItem;
}

export async function toggleRecurringItemActive(
  userId: string,
  accountId: string,
  itemId: string
): Promise<RecurringItem | null> {
  const item = await getRecurringItemById(userId, accountId, itemId);
  if (!item) {
    return null;
  }

  return updateRecurringItem(userId, accountId, itemId, { isActive: !item.isActive });
}

export async function deleteRecurringItem(
  userId: string,
  accountId: string,
  itemId: string
): Promise<boolean> {
  const itemFile = getRecurringItemFile(userId, accountId, itemId);
  await deleteFile(itemFile);
  return true;
}
