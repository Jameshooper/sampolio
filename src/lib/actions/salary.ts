'use server';

import { z } from 'zod';
import { auth } from '@/lib/auth';
import { cachedGetAccountById, cachedGetSalaryConfigs, cachedGetSalaryConfigById } from '@/lib/db/cached';
import {
  createSalaryConfig as dbCreateSalaryConfig,
  updateSalaryConfig as dbUpdateSalaryConfig,
  deleteSalaryConfig as dbDeleteSalaryConfig,
} from '@/lib/db/salary-configs';
import { recomputeSalaryLinkedTaxedIncomes } from '@/lib/db/taxed-income';
import { updateTag } from 'next/cache';
import type { ApiResponse, SalaryConfig } from '@/types';

const salaryBenefitSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Benefit name is required'),
  amount: z.number().min(0, 'Amount must be non-negative'),
  isTaxable: z.boolean(),
});

const createSalaryConfigSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  grossSalary: z.number().positive('Gross salary must be positive'),
  benefits: z.array(salaryBenefitSchema).optional(),
  taxRate: z.number().min(0).max(100, 'Tax rate must be between 0 and 100'),
  contributionsRate: z.number().min(0).max(100, 'Contributions rate must be between 0 and 100'),
  otherDeductions: z.number().min(0).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}$/, 'Invalid date format (YYYY-MM)'),
  endDate: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  isActive: z.boolean().optional(),
  isLinkedToRecurring: z.boolean().optional(),
});

const updateSalaryConfigSchema = z.object({
  name: z.string().min(1).optional(),
  grossSalary: z.number().positive().optional(),
  benefits: z.array(salaryBenefitSchema).optional(),
  taxRate: z.number().min(0).max(100).optional(),
  contributionsRate: z.number().min(0).max(100).optional(),
  otherDeductions: z.number().min(0).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}$/).optional().nullable(),
  isActive: z.boolean().optional(),
  isLinkedToRecurring: z.boolean().optional(),
});

export async function getSalaryConfigs(accountId: string): Promise<ApiResponse<SalaryConfig[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const account = await cachedGetAccountById(session.user.id, accountId);
    if (!account) {
      return { success: false, error: 'Account not found' };
    }

    const configs = await cachedGetSalaryConfigs(session.user.id, accountId);
    return { success: true, data: configs };
  } catch (error) {
    console.error('Get salary configs error:', error);
    return { success: false, error: 'Failed to fetch salary configs' };
  }
}

export async function getSalaryConfigById(
  accountId: string,
  configId: string
): Promise<ApiResponse<SalaryConfig>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const account = await cachedGetAccountById(session.user.id, accountId);
    if (!account) {
      return { success: false, error: 'Account not found' };
    }

    const config = await cachedGetSalaryConfigById(session.user.id, accountId, configId);
    if (!config) {
      return { success: false, error: 'Salary config not found' };
    }

    return { success: true, data: config };
  } catch (error) {
    console.error('Get salary config error:', error);
    return { success: false, error: 'Failed to fetch salary config' };
  }
}

export async function createSalaryConfig(
  accountId: string,
  data: z.infer<typeof createSalaryConfigSchema>
): Promise<ApiResponse<SalaryConfig>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const account = await cachedGetAccountById(session.user.id, accountId);
    if (!account) {
      return { success: false, error: 'Account not found' };
    }

    const parsed = createSalaryConfigSchema.parse(data);
    const config = await dbCreateSalaryConfig(session.user.id, {
      ...parsed,
      accountId,
    });

    updateTag(`user:${session.user.id}:account:${accountId}:salary`);

    // Cascade: taxed incomes on this account that follow the salary's tax
    // settings get their frozen net recomputed against the new rates.
    const changed = await recomputeSalaryLinkedTaxedIncomes(session.user.id, accountId);
    if (changed > 0) updateTag(`user:${session.user.id}:account:${accountId}:taxed-income`);

    return { success: true, data: config };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Create salary config error:', error);
    return { success: false, error: 'Failed to create salary config' };
  }
}

export async function updateSalaryConfig(
  accountId: string,
  configId: string,
  data: z.infer<typeof updateSalaryConfigSchema>
): Promise<ApiResponse<SalaryConfig>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const parsedData = updateSalaryConfigSchema.parse(data);
    const updateData = {
      ...parsedData,
      endDate: parsedData.endDate ?? undefined,
    };

    const config = await dbUpdateSalaryConfig(session.user.id, accountId, configId, updateData);
    if (!config) {
      return { success: false, error: 'Salary config not found' };
    }

    updateTag(`user:${session.user.id}:account:${accountId}:salary`);

    // Cascade: recompute taxed incomes that follow the salary's tax settings.
    const changed = await recomputeSalaryLinkedTaxedIncomes(session.user.id, accountId);
    if (changed > 0) updateTag(`user:${session.user.id}:account:${accountId}:taxed-income`);

    return { success: true, data: config };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update salary config error:', error);
    return { success: false, error: 'Failed to update salary config' };
  }
}

export async function deleteSalaryConfig(
  accountId: string,
  configId: string
): Promise<ApiResponse<null>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    await dbDeleteSalaryConfig(session.user.id, accountId, configId);
    updateTag(`user:${session.user.id}:account:${accountId}:salary`);

    // Cascade: deleting the active salary config may change the account's
    // resolved tax settings — recompute salary-linked taxed incomes.
    const changed = await recomputeSalaryLinkedTaxedIncomes(session.user.id, accountId);
    if (changed > 0) updateTag(`user:${session.user.id}:account:${accountId}:taxed-income`);

    return { success: true };
  } catch (error) {
    console.error('Delete salary config error:', error);
    return { success: false, error: 'Failed to delete salary config' };
  }
}
