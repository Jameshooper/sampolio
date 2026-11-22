'use server';

import { z } from 'zod';
import { CURRENCY_VALUES } from '@/lib/constants';
import { auth } from '@/lib/auth';
import {
  createAccount as dbCreateAccount,
  updateAccount as dbUpdateAccount,
  deleteAccount as dbDeleteAccount,
} from '@/lib/db/accounts';
import { cachedGetAccounts, cachedGetAccountById } from '@/lib/db/cached';
import { getMonthsBetween } from '@/lib/projection';
import { updateTag } from 'next/cache';
import type { ApiResponse, FinancialAccount } from '@/types';

// A real calendar month (01–12), not just any two digits.
const yearMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Invalid date format (YYYY-MM)');

/** Same 50-year ceiling as planningHorizonMonths: a custom end date further
 * out would make every projection build millions of months. */
const MAX_CUSTOM_HORIZON_MONTHS = 600;

function customEndDateError(startingDate: string, customEndDate: string | null | undefined): string | null {
  if (!customEndDate) return null;
  if (customEndDate < startingDate) return 'The end date must be after the start date';
  if (getMonthsBetween(startingDate, customEndDate) > MAX_CUSTOM_HORIZON_MONTHS) {
    return 'The end date must be within 50 years of the start date';
  }
  return null;
}

const createAccountSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  currency: z.enum(CURRENCY_VALUES),
  startingBalance: z.number(),
  startingDate: yearMonthSchema,
  planningHorizonMonths: z.number().min(1).max(600),
  customEndDate: yearMonthSchema.optional(),
}).superRefine((d, ctx) => {
  const error = customEndDateError(d.startingDate, d.customEndDate);
  if (error) ctx.addIssue({ code: 'custom', path: ['customEndDate'], message: error });
});

const updateAccountSchema = z.object({
  name: z.string().min(1).optional(),
  currency: z.enum(CURRENCY_VALUES).optional(),
  startingBalance: z.number().optional(),
  startingDate: yearMonthSchema.optional(),
  planningHorizonMonths: z.number().min(1).max(600).optional(),
  customEndDate: yearMonthSchema.optional().nullable(),
  isArchived: z.boolean().optional(),
});

export async function getAccounts(): Promise<ApiResponse<FinancialAccount[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const accounts = await cachedGetAccounts(session.user.id);
    return { success: true, data: accounts };
  } catch (error) {
    console.error('Get accounts error:', error);
    return { success: false, error: 'Failed to fetch accounts' };
  }
}

export async function getAccountById(accountId: string): Promise<ApiResponse<FinancialAccount>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const account = await cachedGetAccountById(session.user.id, accountId);
    if (!account) {
      return { success: false, error: 'Account not found' };
    }

    return { success: true, data: account };
  } catch (error) {
    console.error('Get account error:', error);
    return { success: false, error: 'Failed to fetch account' };
  }
}

export async function createAccount(
  data: z.infer<typeof createAccountSchema>
): Promise<ApiResponse<FinancialAccount>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const parsed = createAccountSchema.parse(data);
    const account = await dbCreateAccount(session.user.id, parsed);
    updateTag(`user:${session.user.id}:accounts`);
    return { success: true, data: account };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Create account error:', error);
    return { success: false, error: 'Failed to create account' };
  }
}

export async function updateAccount(
  accountId: string,
  data: z.infer<typeof updateAccountSchema>
): Promise<ApiResponse<FinancialAccount>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const parsedData = updateAccountSchema.parse(data);
    if (parsedData.customEndDate || parsedData.startingDate) {
      const existing = await cachedGetAccountById(session.user.id, accountId);
      if (!existing) return { success: false, error: 'Account not found' };
      const endDate = parsedData.customEndDate === undefined ? existing.customEndDate : parsedData.customEndDate;
      const error = customEndDateError(parsedData.startingDate ?? existing.startingDate, endDate);
      if (error) return { success: false, error };
    }
    const updateData = {
      ...parsedData,
      customEndDate: parsedData.customEndDate ?? undefined,
    };

    const account = await dbUpdateAccount(session.user.id, accountId, updateData);
    if (!account) {
      return { success: false, error: 'Account not found' };
    }

    updateTag(`user:${session.user.id}:accounts`);
    return { success: true, data: account };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update account error:', error);
    return { success: false, error: 'Failed to update account' };
  }
}

export async function deleteAccount(accountId: string): Promise<ApiResponse<null>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    await dbDeleteAccount(session.user.id, accountId);
    updateTag(`user:${session.user.id}:accounts`);
    return { success: true };
  } catch (error) {
    console.error('Delete account error:', error);
    return { success: false, error: 'Failed to delete account' };
  }
}
