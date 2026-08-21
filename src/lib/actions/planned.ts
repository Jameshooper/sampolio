'use server';

import { z } from 'zod';
import { auth } from '@/lib/auth';
import { cachedGetAccountById, cachedGetPlannedItems, cachedGetPlannedItemById, cachedGetLatestSnapshot } from '@/lib/db/cached';
import {
  getPlannedItems as dbGetPlannedItems,
  createPlannedItem as dbCreatePlannedItem,
  updatePlannedItem as dbUpdatePlannedItem,
  deletePlannedItem as dbDeletePlannedItem,
} from '@/lib/db/planned-items';
import { resolveAnchor, addMonths, compareYearMonths } from '@/lib/projection';
import { updateTag } from 'next/cache';
import type { ApiResponse, PlannedItem, YearMonth } from '@/types';

const createPlannedItemSchema = z.object({
  type: z.enum(['income', 'expense']),
  kind: z.enum(['one-off', 'repeating']),
  name: z.string().min(1, 'Name is required'),
  amount: z.number().positive('Amount must be positive'),
  category: z.string().optional(),
  scheduledDate: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  frequency: z.enum(['monthly', 'quarterly', 'yearly', 'custom']).optional(),
  customIntervalMonths: z.number().min(1).optional(),
  firstOccurrence: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  paidByCardLinkId: z.string().optional(),
  isFixedAmount: z.boolean().optional(),
  isReimbursable: z.boolean().optional(),
  expectedReimbursementMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(),
}).refine(
  (data) => {
    if (data.kind === 'one-off') {
      return !!data.scheduledDate;
    }
    return !!data.firstOccurrence && !!data.frequency;
  },
  {
    message: 'One-off items require scheduledDate, repeating items require firstOccurrence and frequency',
  }
).refine(
  (data) => !data.isReimbursable || (data.kind === 'one-off' && data.type === 'expense' && !!data.expectedReimbursementMonth),
  {
    message: 'Reimbursable items must be one-off expenses with an expected reimbursement month',
  }
);

const updatePlannedItemSchema = z.object({
  type: z.enum(['income', 'expense']).optional(),
  kind: z.enum(['one-off', 'repeating']).optional(),
  name: z.string().min(1).optional(),
  amount: z.number().positive().optional(),
  category: z.string().optional().nullable(),
  scheduledDate: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  frequency: z.enum(['monthly', 'quarterly', 'yearly', 'custom']).optional(),
  customIntervalMonths: z.number().min(1).optional(),
  firstOccurrence: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}$/).optional().nullable(),
  paidByCardLinkId: z.string().optional().nullable(),
  isFixedAmount: z.boolean().optional(),
  isReimbursable: z.boolean().optional(),
  expectedReimbursementMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  reimbursementStatus: z.enum(['pending', 'received']).optional(),
}).refine(
  (data) => data.isReimbursable !== true || !!data.expectedReimbursementMonth,
  {
    message: 'Reimbursable items require an expected reimbursement month',
  }
);

export async function getPlannedItems(accountId: string): Promise<ApiResponse<PlannedItem[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const account = await cachedGetAccountById(session.user.id, accountId);
    if (!account) {
      return { success: false, error: 'Account not found' };
    }

    const items = await cachedGetPlannedItems(session.user.id, accountId);
    return { success: true, data: items };
  } catch (error) {
    console.error('Get planned items error:', error);
    return { success: false, error: 'Failed to fetch planned items' };
  }
}

export async function getPlannedItemById(
  accountId: string,
  itemId: string
): Promise<ApiResponse<PlannedItem>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const account = await cachedGetAccountById(session.user.id, accountId);
    if (!account) {
      return { success: false, error: 'Account not found' };
    }

    const item = await cachedGetPlannedItemById(session.user.id, accountId, itemId);
    if (!item) {
      return { success: false, error: 'Item not found' };
    }

    return { success: true, data: item };
  } catch (error) {
    console.error('Get planned item error:', error);
    return { success: false, error: 'Failed to fetch planned item' };
  }
}

export async function createPlannedItem(
  accountId: string,
  data: z.infer<typeof createPlannedItemSchema>
): Promise<ApiResponse<PlannedItem>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const account = await cachedGetAccountById(session.user.id, accountId);
    if (!account) {
      return { success: false, error: 'Account not found' };
    }

    const parsed = createPlannedItemSchema.parse(data);
    const item = await dbCreatePlannedItem(session.user.id, {
      ...parsed,
      accountId,
    });

    updateTag(`user:${session.user.id}:account:${accountId}:planned`);
    return { success: true, data: item };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Create planned item error:', error);
    return { success: false, error: 'Failed to create planned item' };
  }
}

export async function updatePlannedItem(
  accountId: string,
  itemId: string,
  data: z.infer<typeof updatePlannedItemSchema>
): Promise<ApiResponse<PlannedItem>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const parsedData = updatePlannedItemSchema.parse(data);
    const updateData = {
      ...parsedData,
      category: parsedData.category ?? undefined,
      endDate: parsedData.endDate ?? undefined,
      paidByCardLinkId: parsedData.paidByCardLinkId ?? undefined,
    };

    const item = await dbUpdatePlannedItem(session.user.id, accountId, itemId, updateData);
    if (!item) {
      return { success: false, error: 'Item not found' };
    }

    updateTag(`user:${session.user.id}:account:${accountId}:planned`);
    return { success: true, data: item };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update planned item error:', error);
    return { success: false, error: 'Failed to update planned item' };
  }
}

export async function deletePlannedItem(
  accountId: string,
  itemId: string
): Promise<ApiResponse<null>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    await dbDeletePlannedItem(session.user.id, accountId, itemId);
    updateTag(`user:${session.user.id}:account:${accountId}:planned`);
    return { success: true };
  } catch (error) {
    console.error('Delete planned item error:', error);
    return { success: false, error: 'Failed to delete planned item' };
  }
}

// ============================================================
// RECURRING ITEM OCCURRENCE OVERRIDES
// ============================================================

const overrideOccurrenceSchema = z.object({
  name: z.string().min(1).optional(),
  amount: z.number().positive().optional(),
  category: z.string().optional().nullable(),
  skipOccurrence: z.boolean().optional(),
});

/**
 * Create or update an occurrence override for a recurring item in a specific month.
 * This stores a PlannedItem with isRecurringOverride=true and linkedRecurringItemId set.
 */
export async function upsertRecurringItemOccurrenceOverride(
  accountId: string,
  recurringItemId: string,
  yearMonth: YearMonth,
  data: z.infer<typeof overrideOccurrenceSchema>
): Promise<ApiResponse<PlannedItem>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const validated = overrideOccurrenceSchema.parse(data);

    // Find existing override for this recurring item + month
    const allPlanned = await dbGetPlannedItems(session.user.id, accountId);
    const existingOverride = allPlanned.find(
      p =>
        p.isRecurringOverride &&
        p.linkedRecurringItemId === recurringItemId &&
        p.scheduledDate === yearMonth
    );

    let result: PlannedItem;

    if (existingOverride) {
      // Update existing override
      const updated = await dbUpdatePlannedItem(
        session.user.id,
        accountId,
        existingOverride.id,
        {
          ...(validated.name !== undefined && { name: validated.name }),
          ...(validated.amount !== undefined && { amount: validated.amount }),
          ...(validated.category !== undefined && {
            category: validated.category ?? undefined,
          }),
          ...(validated.skipOccurrence !== undefined && {
            skipOccurrence: validated.skipOccurrence,
          }),
        }
      );
      if (!updated) {
        return { success: false, error: 'Failed to update override' };
      }
      result = updated;
    } else {
      // Import the original recurring item to get its base values
      const { cachedGetRecurringItemById } = await import('@/lib/db/cached');
      const recurringItem = await cachedGetRecurringItemById(
        session.user.id,
        accountId,
        recurringItemId
      );
      if (!recurringItem) {
        return { success: false, error: 'Recurring item not found' };
      }

      // Create new override as a one-off PlannedItem
      result = await dbCreatePlannedItem(session.user.id, {
        accountId,
        type: recurringItem.type,
        kind: 'one-off',
        name: validated.name ?? recurringItem.name,
        amount: validated.amount ?? recurringItem.amount,
        category: validated.category !== undefined
          ? (validated.category ?? undefined)
          : recurringItem.category,
        scheduledDate: yearMonth,
        linkedRecurringItemId: recurringItemId,
        isRecurringOverride: true,
        skipOccurrence: validated.skipOccurrence ?? false,
      });
    }

    updateTag(`user:${session.user.id}:account:${accountId}:planned`);
    // Opportunistically prune overrides the projection no longer uses.
    await cleanupExpiredOverrides(accountId).catch(() => {});
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Upsert occurrence override error:', error);
    return { success: false, error: 'Failed to save occurrence override' };
  }
}

/**
 * Delete an occurrence override, restoring the original recurring item behavior for that month.
 */
export async function deleteRecurringItemOccurrenceOverride(
  accountId: string,
  recurringItemId: string,
  yearMonth: YearMonth
): Promise<ApiResponse<null>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const allPlanned = await dbGetPlannedItems(session.user.id, accountId);
    const override = allPlanned.find(
      p =>
        p.isRecurringOverride &&
        p.linkedRecurringItemId === recurringItemId &&
        p.scheduledDate === yearMonth
    );

    if (!override) {
      return { success: false, error: 'Override not found' };
    }

    await dbDeletePlannedItem(session.user.id, accountId, override.id);
    updateTag(`user:${session.user.id}:account:${accountId}:planned`);
    await cleanupExpiredOverrides(accountId).catch(() => {});
    return { success: true };
  } catch (error) {
    console.error('Delete occurrence override error:', error);
    return { success: false, error: 'Failed to delete occurrence override' };
  }
}

/**
 * Clean up expired recurring-item occurrence overrides for an account.
 * Deletes override PlannedItems where scheduledDate is more than 2 months ago.
 */
export async function cleanupExpiredOverrides(
  accountId: string
): Promise<ApiResponse<{ deleted: number }>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const account = await cachedGetAccountById(session.user.id, accountId);
    if (!account) {
      return { success: false, error: 'Account not found' };
    }

    const allPlanned = await cachedGetPlannedItems(session.user.id, accountId);

    // Cut off relative to the projection anchor (latest reconciliation snapshot,
    // else genesis) minus 2 months — the SAME window the projection itself uses
    // to exclude overrides (see calculateProjection). This guarantees we only
    // delete overrides the projection already ignores, so forecasts never change.
    const latestSnapshot = await cachedGetLatestSnapshot(session.user.id, 'cash-account', accountId);
    const anchor = resolveAnchor(account.startingDate, account.startingBalance, latestSnapshot);
    const cutoffYM = addMonths(anchor.startMonth, -2);

    const expired = allPlanned.filter(
      p => p.isRecurringOverride && p.scheduledDate && compareYearMonths(p.scheduledDate, cutoffYM) < 0
    );

    for (const item of expired) {
      await dbDeletePlannedItem(session.user.id, accountId, item.id);
    }

    if (expired.length > 0) {
      updateTag(`user:${session.user.id}:account:${accountId}:planned`);
    }

    return { success: true, data: { deleted: expired.length } };
  } catch (error) {
    console.error('Cleanup expired overrides error:', error);
    return { success: false, error: 'Failed to clean up overrides' };
  }
}
