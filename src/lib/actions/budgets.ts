'use server';

import { z } from 'zod';
import { CURRENCY_VALUES } from '@/lib/constants';
import { auth } from '@/lib/auth';
import {
  createBudget as dbCreateBudget,
  updateBudget as dbUpdateBudget,
  deleteBudget as dbDeleteBudget,
  setBudgetStatus as dbSetBudgetStatus,
  addBudgetLine as dbAddBudgetLine,
  updateBudgetLine as dbUpdateBudgetLine,
  deleteBudgetLine as dbDeleteBudgetLine,
  addBudgetFundingSource as dbAddBudgetFundingSource,
  updateBudgetFundingSource as dbUpdateBudgetFundingSource,
  deleteBudgetFundingSource as dbDeleteBudgetFundingSource,
  addBudgetExpenseEntry as dbAddBudgetExpenseEntry,
  updateBudgetExpenseEntry as dbUpdateBudgetExpenseEntry,
  deleteBudgetExpenseEntry as dbDeleteBudgetExpenseEntry,
} from '@/lib/db/budgets';
import {
  cachedGetBudgets,
  cachedGetBudgetById,
  cachedGetAccountById,
  cachedGetSplitGroupsForUser,
  cachedGetTrips,
  cachedGetTripById,
} from '@/lib/db/cached';
import { calcPerDiemTotal, hydrateBudgetFundingFromTrips } from '@/lib/budget-utils';
import { calculatePerDiem } from '@/lib/per-diem-utils';
import { updateTag } from 'next/cache';
import type { ApiResponse, Budget } from '@/types';

const yearMonth = z.string().regex(/^\d{4}-\d{2}$/, 'Use the YYYY-MM format');

const createBudgetSchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    destination: z.string().optional(),
    description: z.string().optional(),
    currency: z.enum(CURRENCY_VALUES),
    startMonth: yearMonth,
    endMonth: yearMonth,
    linkedAccountId: z.string().optional(),
    exchangeRate: z.number().positive().optional(),
    includeRegularIncome: z.boolean().optional(),
  })
  .refine(data => data.endMonth >= data.startMonth, {
    message: 'The end month must not be before the start month',
    path: ['endMonth'],
  });

const updateBudgetSchema = z.object({
  name: z.string().min(1).optional(),
  destination: z.string().optional(),
  description: z.string().optional(),
  currency: z.enum(CURRENCY_VALUES).optional(),
  startMonth: yearMonth.optional(),
  endMonth: yearMonth.optional(),
  linkedAccountId: z.string().optional(),
  exchangeRate: z.number().positive().optional(),
  includeRegularIncome: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  linkedSplitGroupId: z.string().optional(), // '' clears the link
});

const budgetLineSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  category: z.string().min(1, 'Category is required'),
  amount: z.number().min(0, 'Amount cannot be negative'),
  kind: z.enum(['one-off', 'monthly']),
  month: yearMonth.optional(),
  startMonth: yearMonth.optional(),
  endMonth: yearMonth.optional(),
});

const fundingSourceSchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    type: z.enum(['grant', 'per-diem', 'other']),
    amount: z.number().min(0).optional(),
    restrictedToCategories: z.array(z.string().min(1)).optional(),
    timing: z.enum(['upfront', 'monthly', 'specific-month']),
    receivedMonth: yearMonth.optional(),
    perDiemRate: z.number().min(0).optional(),
    perDiemDays: z.number().int().min(0).optional(),
    linkedTripId: z.string().optional(),
    note: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.linkedTripId && data.type !== 'per-diem') {
      ctx.addIssue({ code: 'custom', message: 'Only a daily allowance can be funded by a trip', path: ['linkedTripId'] });
    }
    if (data.type === 'per-diem') {
      // A per-diem source needs EITHER a linked trip (amount hydrated from the
      // trip) OR a manual rate + days.
      if (!data.linkedTripId && (data.perDiemRate === undefined || data.perDiemDays === undefined)) {
        ctx.addIssue({ code: 'custom', message: 'A daily allowance needs a rate and a number of days' });
      }
    } else if (data.amount === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Amount is required', path: ['amount'] });
    }
    if (data.timing === 'specific-month' && !data.receivedMonth) {
      ctx.addIssue({ code: 'custom', message: 'Pick the month the money arrives', path: ['receivedMonth'] });
    }
  });

const expenseEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format'),
  description: z.string(),
  amount: z.number().positive('Amount must be positive'),
  category: z.string().min(1, 'Category is required'),
  fundingSourceId: z.string().optional(),
  note: z.string().optional(),
});

type LoadResult =
  | { ok: true; userId: string; budget: Budget }
  | { ok: false; error: string };

async function loadOwnBudget(budgetId: string): Promise<LoadResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: 'Unauthorized' };
  }
  const budget = await cachedGetBudgetById(session.user.id, budgetId);
  if (!budget) {
    return { ok: false, error: 'Budget not found' };
  }
  return { ok: true, userId: session.user.id, budget };
}

/** Manual per-diem sources store amount = rate × days, recomputed on save. A
 * trip-linked source is left untouched here — its snapshot amount is set
 * explicitly by the action from the trip's live per-diem total. */
function withPerDiemAmount<T extends { type?: string; amount?: number; perDiemRate?: number; perDiemDays?: number; linkedTripId?: string }>(
  data: T,
  existing?: { type: string; perDiemRate?: number; perDiemDays?: number }
): T {
  const type = data.type ?? existing?.type;
  if (type !== 'per-diem' || data.linkedTripId) return data;
  const rate = data.perDiemRate ?? existing?.perDiemRate ?? 0;
  const days = data.perDiemDays ?? existing?.perDiemDays ?? 0;
  return { ...data, amount: calcPerDiemTotal(rate, days) };
}

/**
 * Validate a trip-linked per-diem funding source and return the write-time
 * snapshot amount from the trip's live per-diem total. Enforces trip ownership
 * (the user-scoped read IS the ownership check), the EUR-only budget rule, and
 * one-budget-per-trip uniqueness. `ignoreSourceId` skips the source currently
 * being edited during the uniqueness scan.
 */
async function resolveTripLinkedAmount(
  userId: string,
  budget: Budget,
  linkedTripId: string,
  ignoreSourceId?: string
): Promise<{ ok: true; amount: number } | { ok: false; error: string }> {
  const trip = await cachedGetTripById(userId, linkedTripId);
  if (!trip) return { ok: false, error: 'Trip not found' };
  if (budget.currency !== 'EUR') {
    return { ok: false, error: `Per-diem trips are in euros — this budget uses ${budget.currency}` };
  }
  const budgets = await cachedGetBudgets(userId);
  for (const other of budgets) {
    for (const source of other.fundingSources) {
      if (source.linkedTripId !== linkedTripId) continue;
      if (other.id === budget.id && source.id === ignoreSourceId) continue;
      return { ok: false, error: `That trip already funds “${other.name}” — unlink it there first` };
    }
  }
  return { ok: true, amount: calculatePerDiem(trip).total };
}

// ============================================================
// BUDGET ACTIONS
// ============================================================

export async function getBudgets(): Promise<ApiResponse<Budget[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }
    // Trip-linked per-diem funding sources hydrate their amount from the
    // trip's live per-diem total at read time (stored amount is a snapshot).
    const [budgets, trips] = await Promise.all([
      cachedGetBudgets(session.user.id),
      cachedGetTrips(session.user.id),
    ]);
    return { success: true, data: budgets.map(b => hydrateBudgetFundingFromTrips(b, trips)) };
  } catch (error) {
    console.error('Get budgets error:', error);
    return { success: false, error: 'Failed to fetch budgets' };
  }
}

export async function getBudgetById(budgetId: string): Promise<ApiResponse<Budget>> {
  const loaded = await loadOwnBudget(budgetId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  const trips = await cachedGetTrips(loaded.userId);
  return { success: true, data: hydrateBudgetFundingFromTrips(loaded.budget, trips) };
}

export async function createBudget(
  data: z.infer<typeof createBudgetSchema>
): Promise<ApiResponse<Budget>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const validated = createBudgetSchema.parse(data);
    const budget = await dbCreateBudget(session.user.id, validated);

    updateTag(`user:${session.user.id}:budgets`);
    return { success: true, data: budget };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Create budget error:', error);
    return { success: false, error: 'Failed to create budget' };
  }
}

export async function updateBudget(
  budgetId: string,
  data: z.infer<typeof updateBudgetSchema>
): Promise<ApiResponse<Budget>> {
  try {
    const loaded = await loadOwnBudget(budgetId);
    if (!loaded.ok) return { success: false, error: loaded.error };

    const validated = updateBudgetSchema.parse(data);

    // A confirmed budget keeps injecting into its linked account; don't let a
    // currency change leave the conversion rate undefined.
    if (loaded.budget.status === 'confirmed' && loaded.budget.linkedAccountId) {
      const account = await cachedGetAccountById(loaded.userId, loaded.budget.linkedAccountId);
      const currency = validated.currency ?? loaded.budget.currency;
      const exchangeRate = validated.exchangeRate ?? loaded.budget.exchangeRate;
      if (account && currency !== account.currency && !exchangeRate) {
        return { success: false, error: 'Set an exchange rate first — the budget and its linked account use different currencies' };
      }
    }

    // Linked split group: '' clears the link (key kept so the spread in the DB
    // layer overwrites it); a non-empty id must be one of the user's groups
    // and match the budget's currency.
    const updates: typeof validated = { ...validated };
    if (validated.linkedSplitGroupId !== undefined) {
      if (validated.linkedSplitGroupId === '') {
        updates.linkedSplitGroupId = undefined;
      } else {
        const groups = await cachedGetSplitGroupsForUser(loaded.userId);
        const group = groups.find(g => g.id === validated.linkedSplitGroupId);
        if (!group) return { success: false, error: 'Split group not found' };
        const currency = validated.currency ?? loaded.budget.currency;
        if (group.currency !== currency) {
          return { success: false, error: 'The split group must use the same currency as the budget' };
        }
      }
    }

    const budget = await dbUpdateBudget(loaded.userId, budgetId, updates);
    if (!budget) return { success: false, error: 'Budget not found' };

    updateTag(`user:${loaded.userId}:budgets`);
    return { success: true, data: budget };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update budget error:', error);
    return { success: false, error: 'Failed to update budget' };
  }
}

export async function deleteBudget(budgetId: string): Promise<ApiResponse<void>> {
  try {
    const loaded = await loadOwnBudget(budgetId);
    if (!loaded.ok) return { success: false, error: loaded.error };

    await dbDeleteBudget(loaded.userId, budgetId);
    updateTag(`user:${loaded.userId}:budgets`);
    return { success: true };
  } catch (error) {
    console.error('Delete budget error:', error);
    return { success: false, error: 'Failed to delete budget' };
  }
}

export async function confirmBudget(
  budgetId: string,
  opts: { linkedAccountId: string; exchangeRate?: number }
): Promise<ApiResponse<Budget>> {
  try {
    const loaded = await loadOwnBudget(budgetId);
    if (!loaded.ok) return { success: false, error: loaded.error };
    if (loaded.budget.isArchived) {
      return { success: false, error: 'Unarchive the budget first' };
    }

    const account = await cachedGetAccountById(loaded.userId, opts.linkedAccountId);
    if (!account) {
      return { success: false, error: 'Account not found' };
    }

    const exchangeRate = opts.exchangeRate ?? loaded.budget.exchangeRate;
    if (loaded.budget.currency !== account.currency && !(exchangeRate && exchangeRate > 0)) {
      return { success: false, error: 'Set an exchange rate — the budget and the account use different currencies' };
    }

    const budget = await dbSetBudgetStatus(loaded.userId, budgetId, 'confirmed', {
      linkedAccountId: opts.linkedAccountId,
      exchangeRate,
    });
    if (!budget) return { success: false, error: 'Budget not found' };

    updateTag(`user:${loaded.userId}:budgets`);
    return { success: true, data: budget };
  } catch (error) {
    console.error('Confirm budget error:', error);
    return { success: false, error: 'Failed to confirm budget' };
  }
}

export async function unconfirmBudget(budgetId: string): Promise<ApiResponse<Budget>> {
  try {
    const loaded = await loadOwnBudget(budgetId);
    if (!loaded.ok) return { success: false, error: loaded.error };

    // linkedAccountId/exchangeRate are kept so re-confirming is one click.
    const budget = await dbSetBudgetStatus(loaded.userId, budgetId, 'draft');
    if (!budget) return { success: false, error: 'Budget not found' };

    updateTag(`user:${loaded.userId}:budgets`);
    return { success: true, data: budget };
  } catch (error) {
    console.error('Unconfirm budget error:', error);
    return { success: false, error: 'Failed to update budget' };
  }
}

// ============================================================
// BUDGET LINES
// ============================================================

export async function addBudgetLine(
  budgetId: string,
  data: z.infer<typeof budgetLineSchema>
): Promise<ApiResponse<Budget>> {
  try {
    const loaded = await loadOwnBudget(budgetId);
    if (!loaded.ok) return { success: false, error: loaded.error };

    const validated = budgetLineSchema.parse(data);
    const budget = await dbAddBudgetLine(loaded.userId, budgetId, validated);
    if (!budget) return { success: false, error: 'Budget not found' };

    updateTag(`user:${loaded.userId}:budgets`);
    return { success: true, data: budget };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Add budget line error:', error);
    return { success: false, error: 'Failed to add cost' };
  }
}

export async function updateBudgetLine(
  budgetId: string,
  lineId: string,
  data: z.infer<typeof budgetLineSchema>
): Promise<ApiResponse<Budget>> {
  try {
    const loaded = await loadOwnBudget(budgetId);
    if (!loaded.ok) return { success: false, error: loaded.error };

    const validated = budgetLineSchema.partial().parse(data);
    const budget = await dbUpdateBudgetLine(loaded.userId, budgetId, lineId, validated);
    if (!budget) return { success: false, error: 'Cost not found' };

    updateTag(`user:${loaded.userId}:budgets`);
    return { success: true, data: budget };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update budget line error:', error);
    return { success: false, error: 'Failed to update cost' };
  }
}

export async function deleteBudgetLine(budgetId: string, lineId: string): Promise<ApiResponse<Budget>> {
  try {
    const loaded = await loadOwnBudget(budgetId);
    if (!loaded.ok) return { success: false, error: loaded.error };

    const budget = await dbDeleteBudgetLine(loaded.userId, budgetId, lineId);
    if (!budget) return { success: false, error: 'Budget not found' };

    updateTag(`user:${loaded.userId}:budgets`);
    return { success: true, data: budget };
  } catch (error) {
    console.error('Delete budget line error:', error);
    return { success: false, error: 'Failed to delete cost' };
  }
}

// ============================================================
// FUNDING SOURCES
// ============================================================

export async function addBudgetFundingSource(
  budgetId: string,
  data: z.infer<typeof fundingSourceSchema>
): Promise<ApiResponse<Budget>> {
  try {
    const loaded = await loadOwnBudget(budgetId);
    if (!loaded.ok) return { success: false, error: loaded.error };

    const parsed = fundingSourceSchema.parse(data);
    const validated = withPerDiemAmount(parsed);
    let amount = validated.amount ?? 0;
    if (parsed.linkedTripId) {
      const resolved = await resolveTripLinkedAmount(loaded.userId, loaded.budget, parsed.linkedTripId);
      if (!resolved.ok) return { success: false, error: resolved.error };
      amount = resolved.amount;
    }
    const budget = await dbAddBudgetFundingSource(loaded.userId, budgetId, {
      ...validated,
      amount,
    });
    if (!budget) return { success: false, error: 'Budget not found' };

    updateTag(`user:${loaded.userId}:budgets`);
    return { success: true, data: budget };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Add funding source error:', error);
    return { success: false, error: 'Failed to add funding' };
  }
}

export async function updateBudgetFundingSource(
  budgetId: string,
  sourceId: string,
  data: z.infer<typeof fundingSourceSchema>
): Promise<ApiResponse<Budget>> {
  try {
    const loaded = await loadOwnBudget(budgetId);
    if (!loaded.ok) return { success: false, error: loaded.error };

    const existing = loaded.budget.fundingSources.find(s => s.id === sourceId);
    if (!existing) return { success: false, error: 'Funding source not found' };

    const parsed = fundingSourceSchema.parse(data);
    const validated = withPerDiemAmount(parsed, existing);
    let amount = validated.amount;
    if (parsed.linkedTripId) {
      const resolved = await resolveTripLinkedAmount(loaded.userId, loaded.budget, parsed.linkedTripId, sourceId);
      if (!resolved.ok) return { success: false, error: resolved.error };
      amount = resolved.amount;
    }
    // linkedTripId is set explicitly so switching a source back to manual
    // (linkedTripId undefined) clears the stored link.
    const budget = await dbUpdateBudgetFundingSource(loaded.userId, budgetId, sourceId, {
      ...validated,
      amount,
      linkedTripId: parsed.linkedTripId,
    });
    if (!budget) return { success: false, error: 'Funding source not found' };

    updateTag(`user:${loaded.userId}:budgets`);
    return { success: true, data: budget };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update funding source error:', error);
    return { success: false, error: 'Failed to update funding' };
  }
}

export async function deleteBudgetFundingSource(
  budgetId: string,
  sourceId: string
): Promise<ApiResponse<Budget>> {
  try {
    const loaded = await loadOwnBudget(budgetId);
    if (!loaded.ok) return { success: false, error: loaded.error };

    const budget = await dbDeleteBudgetFundingSource(loaded.userId, budgetId, sourceId);
    if (!budget) return { success: false, error: 'Budget not found' };

    updateTag(`user:${loaded.userId}:budgets`);
    return { success: true, data: budget };
  } catch (error) {
    console.error('Delete funding source error:', error);
    return { success: false, error: 'Failed to delete funding' };
  }
}

// ============================================================
// EXPENSE LOG
// ============================================================

export async function addBudgetExpenseEntry(
  budgetId: string,
  data: z.infer<typeof expenseEntrySchema>
): Promise<ApiResponse<Budget>> {
  try {
    const loaded = await loadOwnBudget(budgetId);
    if (!loaded.ok) return { success: false, error: loaded.error };

    const validated = expenseEntrySchema.parse(data);
    if (validated.fundingSourceId && !loaded.budget.fundingSources.some(s => s.id === validated.fundingSourceId)) {
      return { success: false, error: 'Funding source not found' };
    }

    const budget = await dbAddBudgetExpenseEntry(loaded.userId, budgetId, validated);
    if (!budget) return { success: false, error: 'Budget not found' };

    updateTag(`user:${loaded.userId}:budgets`);
    return { success: true, data: budget };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Add expense entry error:', error);
    return { success: false, error: 'Failed to log expense' };
  }
}

export async function updateBudgetExpenseEntry(
  budgetId: string,
  entryId: string,
  data: z.infer<typeof expenseEntrySchema>
): Promise<ApiResponse<Budget>> {
  try {
    const loaded = await loadOwnBudget(budgetId);
    if (!loaded.ok) return { success: false, error: loaded.error };

    const validated = expenseEntrySchema.partial().parse(data);
    if (validated.fundingSourceId && !loaded.budget.fundingSources.some(s => s.id === validated.fundingSourceId)) {
      return { success: false, error: 'Funding source not found' };
    }

    const budget = await dbUpdateBudgetExpenseEntry(loaded.userId, budgetId, entryId, validated);
    if (!budget) return { success: false, error: 'Expense not found' };

    updateTag(`user:${loaded.userId}:budgets`);
    return { success: true, data: budget };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update expense entry error:', error);
    return { success: false, error: 'Failed to update expense' };
  }
}

export async function deleteBudgetExpenseEntry(
  budgetId: string,
  entryId: string
): Promise<ApiResponse<Budget>> {
  try {
    const loaded = await loadOwnBudget(budgetId);
    if (!loaded.ok) return { success: false, error: loaded.error };

    const budget = await dbDeleteBudgetExpenseEntry(loaded.userId, budgetId, entryId);
    if (!budget) return { success: false, error: 'Budget not found' };

    updateTag(`user:${loaded.userId}:budgets`);
    return { success: true, data: budget };
  } catch (error) {
    console.error('Delete expense entry error:', error);
    return { success: false, error: 'Failed to delete expense' };
  }
}
