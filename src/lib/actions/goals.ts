'use server';

import { z } from 'zod';
import { CURRENCY_VALUES } from '@/lib/constants';
import { auth } from '@/lib/auth';
import {
  createGoal as dbCreateGoal,
  updateGoal as dbUpdateGoal,
  deleteGoal as dbDeleteGoal,
} from '@/lib/db/goals';
import {
  cachedGetGoals,
  cachedGetGoalById,
} from '@/lib/db/cached';
import { updateTag } from 'next/cache';
import type { ApiResponse, Goal } from '@/types';

// Server-side defense mirroring the client's `goalSchema` (`src/lib/schemas/goal.schema.ts`):
// injectIntoCashflow requires a spend goal, an account-balance target, and a target date.
function refineInjectIntoCashflow(
  data: { goalType?: 'reserve' | 'spend'; targetDate?: string; trackingMethod?: 'account-balance' | 'net-worth' | 'manual'; injectIntoCashflow?: boolean },
  ctx: z.RefinementCtx
) {
  if (data.injectIntoCashflow) {
    if ((data.goalType ?? 'reserve') !== 'spend' || !data.targetDate || data.trackingMethod !== 'account-balance') {
      ctx.addIssue({
        code: 'custom',
        path: ['injectIntoCashflow'],
        message: 'Injecting into cashflow requires a spend goal tracked against an account balance with a target date',
      });
    }
  }
}

const createGoalObjectSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  targetAmount: z.number().positive('Target amount must be positive'),
  currency: z.enum(CURRENCY_VALUES),
  targetDate: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  trackingMethod: z.enum(['account-balance', 'net-worth', 'manual']),
  linkedAccountId: z.string().optional(),
  description: z.string().optional(),
  currentManualAmount: z.number().min(0).optional(),
  goalType: z.enum(['reserve', 'spend']).optional(),
  priority: z.number().int().min(1).max(999).nullable().optional(),
  injectIntoCashflow: z.boolean().optional(),
});

const createGoalSchema = createGoalObjectSchema.superRefine(refineInjectIntoCashflow);

const updateGoalSchema = createGoalObjectSchema.partial().extend({
  isArchived: z.boolean().optional(),
}).superRefine(refineInjectIntoCashflow);

// ============================================================
// GOALS ACTIONS
// ============================================================

export async function getGoals(): Promise<ApiResponse<Goal[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const goals = await cachedGetGoals(session.user.id);
    return { success: true, data: goals };
  } catch (error) {
    console.error('Get goals error:', error);
    return { success: false, error: 'Failed to fetch goals' };
  }
}

export async function getGoalById(goalId: string): Promise<ApiResponse<Goal>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const goal = await cachedGetGoalById(session.user.id, goalId);
    if (!goal) {
      return { success: false, error: 'Goal not found' };
    }

    return { success: true, data: goal };
  } catch (error) {
    console.error('Get goal error:', error);
    return { success: false, error: 'Failed to fetch goal' };
  }
}

export async function createGoal(
  data: z.infer<typeof createGoalSchema>
): Promise<ApiResponse<Goal>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const validated = createGoalSchema.parse(data);
    const goal = await dbCreateGoal(session.user.id, validated);

    updateTag(`user:${session.user.id}:goals`);
    return { success: true, data: goal };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Create goal error:', error);
    return { success: false, error: 'Failed to create goal' };
  }
}

export async function updateGoal(
  goalId: string,
  data: z.infer<typeof updateGoalSchema>
): Promise<ApiResponse<Goal>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const validated = updateGoalSchema.parse(data);
    const goal = await dbUpdateGoal(session.user.id, goalId, validated);

    if (!goal) {
      return { success: false, error: 'Goal not found' };
    }

    updateTag(`user:${session.user.id}:goals`);
    return { success: true, data: goal };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update goal error:', error);
    return { success: false, error: 'Failed to update goal' };
  }
}

export async function deleteGoal(goalId: string): Promise<ApiResponse<void>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    await dbDeleteGoal(session.user.id, goalId);
    updateTag(`user:${session.user.id}:goals`);
    return { success: true };
  } catch (error) {
    console.error('Delete goal error:', error);
    return { success: false, error: 'Failed to delete goal' };
  }
}
