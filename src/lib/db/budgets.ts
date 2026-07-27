import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  Budget,
  BudgetStatus,
  BudgetLine,
  BudgetFundingSource,
  BudgetExpenseEntry,
  CreateBudgetRequest,
  UpdateBudgetRequest,
  CreateBudgetLineRequest,
  UpdateBudgetLineRequest,
  CreateBudgetFundingSourceRequest,
  UpdateBudgetFundingSourceRequest,
  CreateBudgetExpenseEntryRequest,
  UpdateBudgetExpenseEntryRequest,
} from '@/types';
import {
  getUserDir,
  ensureDir,
  readEncryptedFile,
  writeEncryptedFile,
  listFiles,
  deleteFile,
} from './encryption';

// A budget is stored as a single encrypted document with its lines, funding
// sources and expense entries embedded — it is single-user, edited from one
// page, and small even with a busy trip log.

function getBudgetsDir(userId: string): string {
  return path.join(getUserDir(userId), 'budgets');
}

function getBudgetFile(userId: string, budgetId: string): string {
  return path.join(getBudgetsDir(userId), `${budgetId}.enc`);
}

async function writeBudget(userId: string, budget: Budget): Promise<Budget> {
  const updated: Budget = { ...budget, updatedAt: new Date().toISOString() };
  await writeEncryptedFile(getBudgetFile(userId, budget.id), updated);
  return updated;
}

// ============================================================
// BUDGETS CRUD
// ============================================================

export async function getBudgets(userId: string): Promise<Budget[]> {
  const budgetsDir = getBudgetsDir(userId);
  await ensureDir(budgetsDir);

  const files = await listFiles(budgetsDir);
  const encFiles = files.filter(file => file.endsWith('.enc'));
  const results = await Promise.all(
    encFiles.map(file => readEncryptedFile<Budget>(path.join(budgetsDir, file)))
  );
  const budgets = results.filter((b): b is Budget => b !== null);

  // Newest period first
  return budgets.sort((a, b) => b.startMonth.localeCompare(a.startMonth) || a.name.localeCompare(b.name));
}

export async function getBudgetById(userId: string, budgetId: string): Promise<Budget | null> {
  return readEncryptedFile<Budget>(getBudgetFile(userId, budgetId));
}

export async function createBudget(userId: string, data: CreateBudgetRequest): Promise<Budget> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const budget: Budget = {
    id,
    userId,
    name: data.name,
    destination: data.destination,
    description: data.description,
    currency: data.currency,
    startMonth: data.startMonth,
    endMonth: data.endMonth,
    status: 'draft',
    isArchived: false,
    linkedAccountId: data.linkedAccountId,
    exchangeRate: data.exchangeRate,
    includeRegularIncome: data.includeRegularIncome ?? true,
    lines: [],
    fundingSources: [],
    expenseEntries: [],
    createdAt: now,
    updatedAt: now,
  };

  await ensureDir(getBudgetsDir(userId));
  await writeEncryptedFile(getBudgetFile(userId, id), budget);

  return budget;
}

export async function updateBudget(
  userId: string,
  budgetId: string,
  updates: UpdateBudgetRequest
): Promise<Budget | null> {
  const budget = await getBudgetById(userId, budgetId);
  if (!budget) return null;
  return writeBudget(userId, { ...budget, ...updates });
}

export async function deleteBudget(userId: string, budgetId: string): Promise<boolean> {
  await deleteFile(getBudgetFile(userId, budgetId));
  return true;
}

/** Status changes only flow through here (confirm/unconfirm actions). */
export async function setBudgetStatus(
  userId: string,
  budgetId: string,
  status: BudgetStatus,
  opts?: { linkedAccountId?: string; exchangeRate?: number }
): Promise<Budget | null> {
  const budget = await getBudgetById(userId, budgetId);
  if (!budget) return null;
  return writeBudget(userId, {
    ...budget,
    status,
    linkedAccountId: opts?.linkedAccountId ?? budget.linkedAccountId,
    exchangeRate: opts?.exchangeRate ?? budget.exchangeRate,
  });
}

// ============================================================
// EMBEDDED COLLECTIONS (lines / funding sources / expense entries)
// ============================================================

export async function addBudgetLine(
  userId: string,
  budgetId: string,
  data: CreateBudgetLineRequest
): Promise<Budget | null> {
  const budget = await getBudgetById(userId, budgetId);
  if (!budget) return null;
  const line: BudgetLine = { id: uuidv4(), ...data };
  return writeBudget(userId, { ...budget, lines: [...budget.lines, line] });
}

export async function updateBudgetLine(
  userId: string,
  budgetId: string,
  lineId: string,
  updates: UpdateBudgetLineRequest
): Promise<Budget | null> {
  const budget = await getBudgetById(userId, budgetId);
  if (!budget || !budget.lines.some(l => l.id === lineId)) return null;
  return writeBudget(userId, {
    ...budget,
    lines: budget.lines.map(l => (l.id === lineId ? { ...l, ...updates } : l)),
  });
}

export async function deleteBudgetLine(
  userId: string,
  budgetId: string,
  lineId: string
): Promise<Budget | null> {
  const budget = await getBudgetById(userId, budgetId);
  if (!budget) return null;
  return writeBudget(userId, { ...budget, lines: budget.lines.filter(l => l.id !== lineId) });
}

export async function addBudgetFundingSource(
  userId: string,
  budgetId: string,
  data: CreateBudgetFundingSourceRequest
): Promise<Budget | null> {
  const budget = await getBudgetById(userId, budgetId);
  if (!budget) return null;
  const source: BudgetFundingSource = { id: uuidv4(), ...data };
  return writeBudget(userId, { ...budget, fundingSources: [...budget.fundingSources, source] });
}

export async function updateBudgetFundingSource(
  userId: string,
  budgetId: string,
  sourceId: string,
  updates: UpdateBudgetFundingSourceRequest
): Promise<Budget | null> {
  const budget = await getBudgetById(userId, budgetId);
  if (!budget || !budget.fundingSources.some(s => s.id === sourceId)) return null;
  return writeBudget(userId, {
    ...budget,
    fundingSources: budget.fundingSources.map(s => (s.id === sourceId ? { ...s, ...updates } : s)),
  });
}

export async function deleteBudgetFundingSource(
  userId: string,
  budgetId: string,
  sourceId: string
): Promise<Budget | null> {
  const budget = await getBudgetById(userId, budgetId);
  if (!budget) return null;
  return writeBudget(userId, {
    ...budget,
    fundingSources: budget.fundingSources.filter(s => s.id !== sourceId),
    // Entries claimed against the removed source become unclaimed, not orphaned.
    expenseEntries: budget.expenseEntries.map(e =>
      e.fundingSourceId === sourceId ? { ...e, fundingSourceId: undefined } : e
    ),
  });
}

export async function addBudgetExpenseEntry(
  userId: string,
  budgetId: string,
  data: CreateBudgetExpenseEntryRequest
): Promise<Budget | null> {
  const budget = await getBudgetById(userId, budgetId);
  if (!budget) return null;
  const entry: BudgetExpenseEntry = { id: uuidv4(), ...data, createdAt: new Date().toISOString() };
  return writeBudget(userId, { ...budget, expenseEntries: [...budget.expenseEntries, entry] });
}

export async function updateBudgetExpenseEntry(
  userId: string,
  budgetId: string,
  entryId: string,
  updates: UpdateBudgetExpenseEntryRequest
): Promise<Budget | null> {
  const budget = await getBudgetById(userId, budgetId);
  if (!budget || !budget.expenseEntries.some(e => e.id === entryId)) return null;
  return writeBudget(userId, {
    ...budget,
    expenseEntries: budget.expenseEntries.map(e => (e.id === entryId ? { ...e, ...updates } : e)),
  });
}

export async function deleteBudgetExpenseEntry(
  userId: string,
  budgetId: string,
  entryId: string
): Promise<Budget | null> {
  const budget = await getBudgetById(userId, budgetId);
  if (!budget) return null;
  return writeBudget(userId, {
    ...budget,
    expenseEntries: budget.expenseEntries.filter(e => e.id !== entryId),
  });
}
