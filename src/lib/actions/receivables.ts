'use server';

import { z } from 'zod';
import { CURRENCY_VALUES } from '@/lib/constants';
import { auth } from '@/lib/auth';
import {
  createReceivable as dbCreateReceivable,
  updateReceivable as dbUpdateReceivable,
  deleteReceivable as dbDeleteReceivable,
  createRepayment as dbCreateRepayment,
  deleteRepayment as dbDeleteRepayment,
} from '@/lib/db/receivables';
import {
  cachedGetReceivables,
  cachedGetReceivableById,
  cachedGetRepayments,
} from '@/lib/db/cached';
import { updateTag } from 'next/cache';
import type { ApiResponse, Receivable, ReceivableRepayment } from '@/types';

const createReceivableSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  currency: z.enum(CURRENCY_VALUES),
  initialPrincipal: z.number().positive('Initial principal must be positive'),
  note: z.string().optional(),
  hasInterest: z.boolean().optional(),
  annualInterestRate: z.number().min(0).max(100).optional(),
  expectedMonthlyRepayment: z.number().min(0).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}$/, 'Invalid date format (YYYY-MM)'),
});

const updateReceivableSchema = createReceivableSchema.partial().extend({
  isArchived: z.boolean().optional(),
});

const createRepaymentSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}$/, 'Invalid date format (YYYY-MM)'),
  amount: z.number().positive('Amount must be positive'),
  description: z.string().optional(),
  note: z.string().optional(),
  linkedAccountId: z.string().optional(),
});

// ============================================================
// RECEIVABLES ACTIONS
// ============================================================

export async function getReceivables(): Promise<ApiResponse<Receivable[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const receivables = await cachedGetReceivables(session.user.id);
    return { success: true, data: receivables };
  } catch (error) {
    console.error('Get receivables error:', error);
    return { success: false, error: 'Failed to fetch receivables' };
  }
}

export async function getReceivableById(receivableId: string): Promise<ApiResponse<Receivable>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const receivable = await cachedGetReceivableById(session.user.id, receivableId);
    if (!receivable) {
      return { success: false, error: 'Receivable not found' };
    }

    return { success: true, data: receivable };
  } catch (error) {
    console.error('Get receivable error:', error);
    return { success: false, error: 'Failed to fetch receivable' };
  }
}

export async function createReceivable(
  data: z.infer<typeof createReceivableSchema>
): Promise<ApiResponse<Receivable>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const validated = createReceivableSchema.parse(data);
    const receivable = await dbCreateReceivable(session.user.id, validated);

    updateTag(`user:${session.user.id}:receivables`);
    return { success: true, data: receivable };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Create receivable error:', error);
    return { success: false, error: 'Failed to create receivable' };
  }
}

export async function updateReceivable(
  receivableId: string,
  data: z.infer<typeof updateReceivableSchema>
): Promise<ApiResponse<Receivable>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const validated = updateReceivableSchema.parse(data);
    const receivable = await dbUpdateReceivable(session.user.id, receivableId, validated);

    if (!receivable) {
      return { success: false, error: 'Receivable not found' };
    }

    updateTag(`user:${session.user.id}:receivables`);
    return { success: true, data: receivable };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update receivable error:', error);
    return { success: false, error: 'Failed to update receivable' };
  }
}

export async function deleteReceivable(receivableId: string): Promise<ApiResponse<void>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    await dbDeleteReceivable(session.user.id, receivableId);
    updateTag(`user:${session.user.id}:receivables`);
    return { success: true };
  } catch (error) {
    console.error('Delete receivable error:', error);
    return { success: false, error: 'Failed to delete receivable' };
  }
}

// ============================================================
// REPAYMENTS ACTIONS
// ============================================================

export async function getRepayments(
  receivableId: string
): Promise<ApiResponse<ReceivableRepayment[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const repayments = await cachedGetRepayments(session.user.id, receivableId);
    return { success: true, data: repayments };
  } catch (error) {
    console.error('Get repayments error:', error);
    return { success: false, error: 'Failed to fetch repayments' };
  }
}

export async function createRepayment(
  receivableId: string,
  data: z.infer<typeof createRepaymentSchema>
): Promise<ApiResponse<ReceivableRepayment>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const validated = createRepaymentSchema.parse(data);
    const repayment = await dbCreateRepayment(session.user.id, receivableId, validated);

    updateTag(`user:${session.user.id}:receivable:${receivableId}:repayments`);
    updateTag(`user:${session.user.id}:receivables`);
    return { success: true, data: repayment };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Create repayment error:', error);
    return { success: false, error: 'Failed to create repayment' };
  }
}

export async function deleteRepayment(
  receivableId: string,
  repaymentId: string
): Promise<ApiResponse<void>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    await dbDeleteRepayment(session.user.id, receivableId, repaymentId);
    updateTag(`user:${session.user.id}:receivable:${receivableId}:repayments`);
    updateTag(`user:${session.user.id}:receivables`);
    return { success: true };
  } catch (error) {
    console.error('Delete repayment error:', error);
    return { success: false, error: 'Failed to delete repayment' };
  }
}
