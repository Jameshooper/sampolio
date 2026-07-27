'use server';

import { z } from 'zod';
import { CURRENCY_VALUES } from '@/lib/constants';
import { auth } from '@/lib/auth';
import {
  createDebt as dbCreateDebt,
  updateDebt as dbUpdateDebt,
  deleteDebt as dbDeleteDebt,
  setReferenceRate as dbSetReferenceRate,
  deleteReferenceRate as dbDeleteReferenceRate,
  createExtraPayment as dbCreateExtraPayment,
  deleteExtraPayment as dbDeleteExtraPayment,
} from '@/lib/db/debts';
import {
  cachedGetDebts,
  cachedGetDebtById,
  cachedGetReferenceRates,
  cachedGetExtraPayments,
} from '@/lib/db/cached';
import { updateTag } from 'next/cache';
import type { ApiResponse, Debt, DebtReferenceRate, DebtExtraPayment } from '@/types';

const createDebtSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  currency: z.enum(CURRENCY_VALUES),
  debtType: z.enum(['amortized', 'fixed-installment']),
  initialPrincipal: z.number().positive('Initial principal must be positive'),
  startDate: z.string().regex(/^\d{4}-\d{2}$/, 'Invalid date format (YYYY-MM)'),
  // Amortized loan fields
  interestModelType: z.enum(['none', 'fixed', 'variable']).optional(),
  fixedInterestRate: z.number().min(0).max(100).optional(),
  referenceRateMargin: z.number().min(0).max(100).optional(),
  rateResetFrequency: z.enum(['monthly', 'quarterly', 'yearly']).optional(),
  monthlyPayment: z.number().positive().optional(),
  // Fixed-installment fields
  installmentAmount: z.number().positive().optional(),
  totalInstallments: z.number().positive().int().optional(),
  // Link to cash account
  linkedAccountId: z.string().optional(),
});

const updateDebtSchema = createDebtSchema.partial().extend({
  isArchived: z.boolean().optional(),
  remainingInstallments: z.number().int().min(0).optional(),
});

// ============================================================
// DEBTS ACTIONS
// ============================================================

export async function getDebts(): Promise<ApiResponse<Debt[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const debts = await cachedGetDebts(session.user.id);
    return { success: true, data: debts };
  } catch (error) {
    console.error('Get debts error:', error);
    return { success: false, error: 'Failed to fetch debts' };
  }
}

export async function getDebtById(debtId: string): Promise<ApiResponse<Debt>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const debt = await cachedGetDebtById(session.user.id, debtId);
    if (!debt) {
      return { success: false, error: 'Debt not found' };
    }

    return { success: true, data: debt };
  } catch (error) {
    console.error('Get debt error:', error);
    return { success: false, error: 'Failed to fetch debt' };
  }
}

export async function createDebt(
  data: z.infer<typeof createDebtSchema>
): Promise<ApiResponse<Debt>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const validated = createDebtSchema.parse(data);
    const debt = await dbCreateDebt(session.user.id, validated);

    updateTag(`user:${session.user.id}:debts`);
    return { success: true, data: debt };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Create debt error:', error);
    return { success: false, error: 'Failed to create debt' };
  }
}

export async function updateDebt(
  debtId: string,
  data: z.infer<typeof updateDebtSchema>
): Promise<ApiResponse<Debt>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const validated = updateDebtSchema.parse(data);
    const debt = await dbUpdateDebt(session.user.id, debtId, validated);

    if (!debt) {
      return { success: false, error: 'Debt not found' };
    }

    updateTag(`user:${session.user.id}:debts`);
    return { success: true, data: debt };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update debt error:', error);
    return { success: false, error: 'Failed to update debt' };
  }
}

export async function deleteDebt(debtId: string): Promise<ApiResponse<void>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    await dbDeleteDebt(session.user.id, debtId);
    updateTag(`user:${session.user.id}:debts`);
    return { success: true };
  } catch (error) {
    console.error('Delete debt error:', error);
    return { success: false, error: 'Failed to delete debt' };
  }
}

// ============================================================
// REFERENCE RATES ACTIONS
// ============================================================

export async function getReferenceRates(debtId: string): Promise<ApiResponse<DebtReferenceRate[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const rates = await cachedGetReferenceRates(session.user.id, debtId);
    return { success: true, data: rates };
  } catch (error) {
    console.error('Get reference rates error:', error);
    return { success: false, error: 'Failed to fetch reference rates' };
  }
}

export async function setReferenceRate(
  debtId: string,
  yearMonth: string,
  rate: number
): Promise<ApiResponse<DebtReferenceRate>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const referenceRate = await dbSetReferenceRate(session.user.id, debtId, yearMonth, rate);
    updateTag(`user:${session.user.id}:debt:${debtId}:rates`);
    return { success: true, data: referenceRate };
  } catch (error) {
    console.error('Set reference rate error:', error);
    return { success: false, error: 'Failed to set reference rate' };
  }
}

export async function deleteReferenceRate(
  debtId: string,
  rateId: string
): Promise<ApiResponse<void>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    await dbDeleteReferenceRate(session.user.id, debtId, rateId);
    updateTag(`user:${session.user.id}:debt:${debtId}:rates`);
    return { success: true };
  } catch (error) {
    console.error('Delete reference rate error:', error);
    return { success: false, error: 'Failed to delete reference rate' };
  }
}

// ============================================================
// EXTRA PAYMENTS ACTIONS
// ============================================================

export async function getExtraPayments(debtId: string): Promise<ApiResponse<DebtExtraPayment[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const payments = await cachedGetExtraPayments(session.user.id, debtId);
    return { success: true, data: payments };
  } catch (error) {
    console.error('Get extra payments error:', error);
    return { success: false, error: 'Failed to fetch extra payments' };
  }
}

export async function createExtraPayment(
  debtId: string,
  data: { date: string; amount: number; description?: string; note?: string }
): Promise<ApiResponse<DebtExtraPayment>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const payment = await dbCreateExtraPayment(session.user.id, debtId, data.date, data.amount, data.description || data.note);
    updateTag(`user:${session.user.id}:debt:${debtId}:payments`);
    return { success: true, data: payment };
  } catch (error) {
    console.error('Create extra payment error:', error);
    return { success: false, error: 'Failed to create extra payment' };
  }
}

export async function deleteExtraPayment(
  debtId: string,
  paymentId: string
): Promise<ApiResponse<void>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    await dbDeleteExtraPayment(session.user.id, debtId, paymentId);
    updateTag(`user:${session.user.id}:debt:${debtId}:payments`);
    return { success: true };
  } catch (error) {
    console.error('Delete extra payment error:', error);
    return { success: false, error: 'Failed to delete extra payment' };
  }
}
