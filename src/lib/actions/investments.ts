'use server';

import { z } from 'zod';
import { CURRENCY_VALUES } from '@/lib/constants';
import { auth } from '@/lib/auth';
import {
  createInvestmentAccount as dbCreateInvestmentAccount,
  updateInvestmentAccount as dbUpdateInvestmentAccount,
  deleteInvestmentAccount as dbDeleteInvestmentAccount,
  createContribution as dbCreateContribution,
  updateContribution as dbUpdateContribution,
  deleteContribution as dbDeleteContribution,
} from '@/lib/db/investments';
import {
  cachedGetInvestmentAccounts,
  cachedGetInvestmentAccountById,
  cachedGetContributions,
} from '@/lib/db/cached';
import { updateTag } from 'next/cache';
import type { ApiResponse, InvestmentAccount, InvestmentContribution } from '@/types';

const createInvestmentSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  currency: z.enum(CURRENCY_VALUES),
  startingValuation: z.number().min(0, 'Starting valuation must be non-negative'),
  valuationDate: z.string().regex(/^\d{4}-\d{2}$/, 'Invalid date format (YYYY-MM)'),
  annualGrowthRate: z.number().min(-100).max(1000, 'Growth rate must be reasonable'),
});

const updateInvestmentSchema = createInvestmentSchema.partial().extend({
  isArchived: z.boolean().optional(),
});

const createContributionSchema = z.object({
  type: z.enum(['contribution', 'withdrawal']),
  kind: z.enum(['one-off', 'recurring']),
  amount: z.number().positive('Amount must be positive'),
  description: z.string().optional(),
  scheduledDate: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  frequency: z.enum(['monthly', 'quarterly', 'yearly', 'custom']).optional(),
  customIntervalMonths: z.number().positive().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  isActive: z.boolean().optional(),
});

const updateContributionSchema = createContributionSchema.partial();

// ============================================================
// INVESTMENT ACCOUNTS ACTIONS
// ============================================================

export async function getInvestmentAccounts(): Promise<ApiResponse<InvestmentAccount[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const investments = await cachedGetInvestmentAccounts(session.user.id);
    return { success: true, data: investments };
  } catch (error) {
    console.error('Get investment accounts error:', error);
    return { success: false, error: 'Failed to fetch investment accounts' };
  }
}

export async function getInvestmentAccountById(
  investmentId: string
): Promise<ApiResponse<InvestmentAccount>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const investment = await cachedGetInvestmentAccountById(session.user.id, investmentId);
    if (!investment) {
      return { success: false, error: 'Investment account not found' };
    }

    return { success: true, data: investment };
  } catch (error) {
    console.error('Get investment account error:', error);
    return { success: false, error: 'Failed to fetch investment account' };
  }
}

export async function createInvestmentAccount(
  data: z.infer<typeof createInvestmentSchema>
): Promise<ApiResponse<InvestmentAccount>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const validated = createInvestmentSchema.parse(data);
    const investment = await dbCreateInvestmentAccount(session.user.id, validated);

    updateTag(`user:${session.user.id}:investments`);
    return { success: true, data: investment };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Create investment account error:', error);
    return { success: false, error: 'Failed to create investment account' };
  }
}

export async function updateInvestmentAccount(
  investmentId: string,
  data: z.infer<typeof updateInvestmentSchema>
): Promise<ApiResponse<InvestmentAccount>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const validated = updateInvestmentSchema.parse(data);
    const investment = await dbUpdateInvestmentAccount(session.user.id, investmentId, validated);

    if (!investment) {
      return { success: false, error: 'Investment account not found' };
    }

    updateTag(`user:${session.user.id}:investments`);
    return { success: true, data: investment };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update investment account error:', error);
    return { success: false, error: 'Failed to update investment account' };
  }
}

export async function deleteInvestmentAccount(investmentId: string): Promise<ApiResponse<void>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    await dbDeleteInvestmentAccount(session.user.id, investmentId);
    updateTag(`user:${session.user.id}:investments`);
    return { success: true };
  } catch (error) {
    console.error('Delete investment account error:', error);
    return { success: false, error: 'Failed to delete investment account' };
  }
}

// ============================================================
// CONTRIBUTIONS ACTIONS
// ============================================================

export async function getContributions(
  investmentId: string
): Promise<ApiResponse<InvestmentContribution[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const contributions = await cachedGetContributions(session.user.id, investmentId);
    return { success: true, data: contributions };
  } catch (error) {
    console.error('Get contributions error:', error);
    return { success: false, error: 'Failed to fetch contributions' };
  }
}

export async function createContribution(
  investmentId: string,
  data: z.infer<typeof createContributionSchema>
): Promise<ApiResponse<InvestmentContribution>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const validated = createContributionSchema.parse(data);
    const contribution = await dbCreateContribution(session.user.id, investmentId, validated);

    updateTag(`user:${session.user.id}:investment:${investmentId}:contributions`);
    return { success: true, data: contribution };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Create contribution error:', error);
    return { success: false, error: 'Failed to create contribution' };
  }
}

export async function updateContribution(
  investmentId: string,
  contributionId: string,
  data: z.infer<typeof updateContributionSchema>
): Promise<ApiResponse<InvestmentContribution>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const validated = updateContributionSchema.parse(data);
    const contribution = await dbUpdateContribution(
      session.user.id,
      investmentId,
      contributionId,
      validated
    );

    if (!contribution) {
      return { success: false, error: 'Contribution not found' };
    }

    updateTag(`user:${session.user.id}:investment:${investmentId}:contributions`);
    return { success: true, data: contribution };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update contribution error:', error);
    return { success: false, error: 'Failed to update contribution' };
  }
}

export async function deleteContribution(
  investmentId: string,
  contributionId: string
): Promise<ApiResponse<void>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    await dbDeleteContribution(session.user.id, investmentId, contributionId);
    updateTag(`user:${session.user.id}:investment:${investmentId}:contributions`);
    return { success: true };
  } catch (error) {
    console.error('Delete contribution error:', error);
    return { success: false, error: 'Failed to delete contribution' };
  }
}
