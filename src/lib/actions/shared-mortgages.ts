'use server';

import { z } from 'zod';
import { CURRENCY_VALUES } from '@/lib/constants';
import { auth } from '@/lib/auth';
import { updateTag } from 'next/cache';
import { findUserByEmail } from '@/lib/db/users';
import {
  createMortgage as dbCreateMortgage,
  updateMortgage as dbUpdateMortgage,
  updateMortgageLoan as dbUpdateMortgageLoan,
  deleteMortgage as dbDeleteMortgage,
  addMortgageMember as dbAddMortgageMember,
  removeMortgageMember as dbRemoveMortgageMember,
  updateMortgageMember as dbUpdateMortgageMember,
  setRate as dbSetRate,
  deleteRate as dbDeleteRate,
  setCost as dbSetCost,
  deleteCost as dbDeleteCost,
  bulkSetActuals as dbBulkSetActuals,
  deleteAllActuals as dbDeleteAllActuals,
  deleteActualsForMonth as dbDeleteActualsForMonth,
  createExtraPayment as dbCreateExtraPayment,
  deleteExtraPayment as dbDeleteExtraPayment,
  createBalanceSnapshot as dbCreateSnapshot,
  deleteBalanceSnapshot as dbDeleteSnapshot,
} from '@/lib/db/shared-mortgages';
import {
  cachedGetMortgagesForUser,
  cachedGetMortgageById,
  cachedGetMortgageProjectionData,
  cachedGetMortgageActuals,
} from '@/lib/db/cached';
import { calculateMortgageProjection } from '@/lib/mortgage-projection';
import { getCurrentYearMonth } from '@/lib/projection';
import type {
  ApiResponse,
  SharedMortgage,
  MortgageMember,
  MortgageRateEntry,
  MortgageCostEntry,
  MortgageExtraPayment,
  MortgageBalanceSnapshot,
  MortgageActualEntry,
} from '@/types';

const yearMonth = z.string().regex(/^\d{4}-\d{2}$/, 'Invalid date format (YYYY-MM)');
const currencyEnum = z.enum(CURRENCY_VALUES);
const share = z.number().min(0).max(1);

const aspSubsidySchema = z.object({
  enabled: z.boolean(),
  thresholdRate: z.number().min(0).max(100),
  subsidyShare: z.number().min(0).max(1),
  eligibilityYears: z.number().int().min(0).max(50),
});

const loanInputSchema = z.object({
  label: z.string().min(1),
  kind: z.enum(['asp', 'regular']),
  initialPrincipal: z.number().positive(),
  startDate: yearMonth,
  originalTermMonths: z.number().int().positive(),
  paymentMode: z.enum(['annuity-fixed-term', 'fixed-payment']).optional(),
  margin: z.number().min(0).max(100),
  dayCount: z.enum(['actual/360', '30E/360']).optional(),
  paymentDayOfMonth: z.number().int().min(1).max(31).optional(),
  currentMonthlyPayment: z.number().positive().optional(),
  aspSubsidy: aspSubsidySchema.optional(),
});

const memberInputSchema = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'member']).optional(),
  initialPayment: z.number().min(0),
  loanSharePercent: share,
  ownershipTargetPercent: share,
});

const createMortgageSchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    currency: currencyEnum,
    housePrice: z.number().positive(),
    rateResetMonth: z.number().int().min(1).max(12).optional(),
    rateResetDay: z.number().int().min(1).max(31).optional(),
    loans: z.array(loanInputSchema).min(1, 'At least one loan is required'),
    creatorInitialPayment: z.number().min(0),
    creatorLoanSharePercent: share,
    creatorOwnershipTargetPercent: share,
    members: z.array(memberInputSchema).optional(),
    rates: z.array(z.object({ effectiveDate: yearMonth, euriborRate: z.number().min(-5).max(100), note: z.string().optional() })).optional(),
    costs: z.array(z.object({ type: z.enum(['loan-insurance', 'invoicing-fee', 'service-fee']), loanId: z.string().optional(), effectiveDate: yearMonth, amount: z.number().min(0), note: z.string().optional() })).optional(),
  })
  .refine(
    (d) => {
      const sum = d.creatorOwnershipTargetPercent + (d.members ?? []).reduce((s, m) => s + m.ownershipTargetPercent, 0);
      return Math.abs(sum - 1) < 0.005;
    },
    { message: 'Ownership targets must add up to 100%' }
  );

const updateMortgageSchema = z.object({
  name: z.string().min(1).optional(),
  housePrice: z.number().positive().optional(),
  rateResetMonth: z.number().int().min(1).max(12).optional(),
  rateResetDay: z.number().int().min(1).max(31).optional(),
  isArchived: z.boolean().optional(),
});

const updateLoanSchema = loanInputSchema.partial();
const addMemberSchema = z.object({ email: z.string().email(), initialPayment: z.number().min(0), loanSharePercent: share, ownershipTargetPercent: share, role: z.enum(['owner', 'member']).optional() });
const updateMemberSchema = z.object({ role: z.enum(['owner', 'member']).optional(), initialPayment: z.number().min(0).optional(), loanSharePercent: share.optional(), ownershipTargetPercent: share.optional() });
const setRateSchema = z.object({ effectiveDate: yearMonth, euriborRate: z.number().min(-5).max(100), note: z.string().optional() });
const setCostSchema = z.object({ type: z.enum(['loan-insurance', 'invoicing-fee', 'service-fee']), loanId: z.string().optional(), effectiveDate: yearMonth, amount: z.number().min(0), note: z.string().optional() });
const extraPaymentSchema = z.object({ loanId: z.string().min(1), date: yearMonth, amount: z.number().positive(), mode: z.enum(['shorten-term', 'lower-payment']), note: z.string().optional() });
const snapshotSchema = z.object({ loanId: z.string().min(1), yearMonth, actualBalance: z.number().min(0), note: z.string().optional() });
const actualInputSchema = z.object({
  loanId: z.string().min(1),
  yearMonth,
  remaining: z.number().min(0),
  repayment: z.number().min(0),
  interest: z.number().min(0),
  insurance: z.number().min(0),
  subsidy: z.number().min(0).optional(),
});
const importActualsSchema = z.object({
  entries: z.array(actualInputSchema).min(1, 'No rows to import'),
  replaceAll: z.boolean().optional(),
});

// ============================================================
// ACCESS CONTROL
// ============================================================

type LoadResult =
  | { ok: true; mortgage: SharedMortgage; userId: string }
  | { ok: false; error: string };

async function loadMortgageForMember(
  mortgageId: string,
  opts?: { requireOwner?: boolean }
): Promise<LoadResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: 'Unauthorized' };
  const mortgage = await cachedGetMortgageById(mortgageId);
  if (!mortgage) return { ok: false, error: 'Mortgage not found' };
  const me = mortgage.members.find((m) => m.userId === session.user.id);
  if (!me) return { ok: false, error: 'You do not have access to this mortgage' };
  if (opts?.requireOwner && me.role !== 'owner') {
    return { ok: false, error: 'Only an owner can do that' };
  }
  return { ok: true, mortgage, userId: session.user.id };
}

function invalidateForMembers(mortgage: SharedMortgage): void {
  updateTag(`mortgage:${mortgage.id}`);
  for (const m of mortgage.members) updateTag(`user:${m.userId}:mortgages`);
}

// ============================================================
// READS
// ============================================================

export async function getMyMortgages(): Promise<ApiResponse<SharedMortgage[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const mortgages = await cachedGetMortgagesForUser(session.user.id);
    return { success: true, data: mortgages };
  } catch (error) {
    console.error('Get mortgages error:', error);
    return { success: false, error: 'Failed to fetch mortgages' };
  }
}

export async function getMortgage(mortgageId: string): Promise<ApiResponse<SharedMortgage>> {
  const loaded = await loadMortgageForMember(mortgageId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  return { success: true, data: loaded.mortgage };
}

export type MortgageProjectionInputsResult = {
  mortgage: SharedMortgage;
  rates: MortgageRateEntry[];
  costs: MortgageCostEntry[];
  extraPayments: MortgageExtraPayment[];
  snapshots: MortgageBalanceSnapshot[];
  actuals: MortgageActualEntry[];
};

export async function getMortgageProjectionInputs(
  mortgageId: string
): Promise<ApiResponse<MortgageProjectionInputsResult>> {
  const loaded = await loadMortgageForMember(mortgageId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  const data = await cachedGetMortgageProjectionData(mortgageId);
  if (!data) return { success: false, error: 'Mortgage not found' };
  return { success: true, data };
}

/** Aggregated equity/liability for the logged-in member across all their mortgages (for Overview KPIs). */
export async function getMyMortgageEquity(): Promise<
  ApiResponse<{ equity: number; liabilityShare: number; stake: number } | null>
> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const userId = session.user.id;
    const mortgages = (await cachedGetMortgagesForUser(userId)).filter((m) => !m.isArchived);
    if (mortgages.length === 0) return { success: true, data: null };

    const currentMonth = getCurrentYearMonth();
    let equity = 0;
    let liabilityShare = 0;
    let stake = 0;
    for (const mortgage of mortgages) {
      const data = await cachedGetMortgageProjectionData(mortgage.id);
      if (!data) continue;
      const months = calculateMortgageProjection(data, currentMonth);
      const current = months[months.length - 1];
      const pos = current?.members.find((p) => p.userId === userId);
      if (pos) {
        equity += pos.equity;
        liabilityShare += pos.liability;
        stake += pos.stake;
      }
    }
    return { success: true, data: { equity, liabilityShare, stake } };
  } catch (error) {
    console.error('Get mortgage equity error:', error);
    return { success: false, error: 'Failed to compute mortgage equity' };
  }
}

// ============================================================
// MUTATIONS
// ============================================================

export async function createMortgage(
  data: z.infer<typeof createMortgageSchema>
): Promise<ApiResponse<SharedMortgage>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const validated = createMortgageSchema.parse(data);

    // Resolve partner emails → members
    const resolved: MortgageMember[] = [];
    for (const m of validated.members ?? []) {
      const user = await findUserByEmail(m.email);
      if (!user || !user.isActive) {
        return { success: false, error: `No active account for ${m.email}` };
      }
      if (user.id === session.user.id) continue; // creator handled separately
      resolved.push({
        userId: user.id,
        email: user.email,
        name: user.name,
        role: m.role ?? 'member',
        initialPayment: m.initialPayment,
        loanSharePercent: m.loanSharePercent,
        ownershipTargetPercent: m.ownershipTargetPercent,
      });
    }

    const mortgage = await dbCreateMortgage(
      { userId: session.user.id, email: session.user.email ?? '', name: session.user.name ?? 'You' },
      validated,
      resolved
    );
    invalidateForMembers(mortgage);
    return { success: true, data: mortgage };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Create mortgage error:', error);
    return { success: false, error: 'Failed to create mortgage' };
  }
}

export async function updateMortgage(
  mortgageId: string,
  data: z.infer<typeof updateMortgageSchema>
): Promise<ApiResponse<SharedMortgage>> {
  try {
    const ownerFields = data.isArchived !== undefined;
    const loaded = await loadMortgageForMember(mortgageId, { requireOwner: ownerFields });
    if (!loaded.ok) return { success: false, error: loaded.error };
    const validated = updateMortgageSchema.parse(data);
    const updated = await dbUpdateMortgage(mortgageId, validated, loaded.userId);
    if (!updated) return { success: false, error: 'Mortgage not found' };
    invalidateForMembers(updated);
    return { success: true, data: updated };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update mortgage error:', error);
    return { success: false, error: 'Failed to update mortgage' };
  }
}

export async function updateMortgageLoan(
  mortgageId: string,
  loanId: string,
  data: z.infer<typeof updateLoanSchema>
): Promise<ApiResponse<SharedMortgage>> {
  try {
    const loaded = await loadMortgageForMember(mortgageId);
    if (!loaded.ok) return { success: false, error: loaded.error };
    const validated = updateLoanSchema.parse(data);
    const updated = await dbUpdateMortgageLoan(mortgageId, loanId, validated, loaded.userId);
    if (!updated) return { success: false, error: 'Mortgage not found' };
    invalidateForMembers(updated);
    return { success: true, data: updated };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update mortgage loan error:', error);
    return { success: false, error: 'Failed to update loan' };
  }
}

export async function deleteMortgage(mortgageId: string): Promise<ApiResponse<void>> {
  try {
    const loaded = await loadMortgageForMember(mortgageId, { requireOwner: true });
    if (!loaded.ok) return { success: false, error: loaded.error };
    const memberIds = loaded.mortgage.members.map((m) => m.userId);
    await dbDeleteMortgage(mortgageId);
    updateTag(`mortgage:${mortgageId}`);
    for (const uid of memberIds) updateTag(`user:${uid}:mortgages`);
    return { success: true };
  } catch (error) {
    console.error('Delete mortgage error:', error);
    return { success: false, error: 'Failed to delete mortgage' };
  }
}

export async function addMortgageMemberByEmail(
  mortgageId: string,
  data: z.infer<typeof addMemberSchema>
): Promise<ApiResponse<SharedMortgage>> {
  try {
    const loaded = await loadMortgageForMember(mortgageId, { requireOwner: true });
    if (!loaded.ok) return { success: false, error: loaded.error };
    const validated = addMemberSchema.parse(data);
    const user = await findUserByEmail(validated.email);
    if (!user || !user.isActive) {
      return { success: false, error: 'No active Sampolio account uses that email yet' };
    }
    if (loaded.mortgage.members.some((m) => m.userId === user.id)) {
      return { success: false, error: 'That person is already a member' };
    }
    const member: MortgageMember = {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: validated.role ?? 'member',
      initialPayment: validated.initialPayment,
      loanSharePercent: validated.loanSharePercent,
      ownershipTargetPercent: validated.ownershipTargetPercent,
    };
    const updated = await dbAddMortgageMember(mortgageId, member);
    if (!updated) return { success: false, error: 'Mortgage not found' };
    invalidateForMembers(updated);
    updateTag(`user:${user.id}:mortgages`);
    return { success: true, data: updated };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Add mortgage member error:', error);
    return { success: false, error: 'Failed to add member' };
  }
}

export async function removeMortgageMember(
  mortgageId: string,
  userId: string
): Promise<ApiResponse<SharedMortgage>> {
  try {
    const loaded = await loadMortgageForMember(mortgageId, { requireOwner: true });
    if (!loaded.ok) return { success: false, error: loaded.error };
    const owners = loaded.mortgage.members.filter((m) => m.role === 'owner');
    const target = loaded.mortgage.members.find((m) => m.userId === userId);
    if (!target) return { success: false, error: 'Member not found' };
    if (target.role === 'owner' && owners.length <= 1) {
      return { success: false, error: 'Cannot remove the only owner' };
    }
    const updated = await dbRemoveMortgageMember(mortgageId, userId);
    if (!updated) return { success: false, error: 'Mortgage not found' };
    invalidateForMembers(loaded.mortgage); // covers the removed member's tag too
    updateTag(`user:${userId}:mortgages`);
    return { success: true, data: updated };
  } catch (error) {
    console.error('Remove mortgage member error:', error);
    return { success: false, error: 'Failed to remove member' };
  }
}

export async function updateMortgageMember(
  mortgageId: string,
  userId: string,
  data: z.infer<typeof updateMemberSchema>
): Promise<ApiResponse<SharedMortgage>> {
  try {
    const loaded = await loadMortgageForMember(mortgageId, { requireOwner: true });
    if (!loaded.ok) return { success: false, error: loaded.error };
    const validated = updateMemberSchema.parse(data);
    if (validated.role === 'member') {
      const target = loaded.mortgage.members.find((m) => m.userId === userId);
      const owners = loaded.mortgage.members.filter((m) => m.role === 'owner');
      if (target?.role === 'owner' && owners.length <= 1) {
        return { success: false, error: 'Make another member an owner first — a mortgage must always have one' };
      }
    }
    const updated = await dbUpdateMortgageMember(mortgageId, userId, validated);
    if (!updated) return { success: false, error: 'Mortgage not found' };
    invalidateForMembers(updated);
    return { success: true, data: updated };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update mortgage member error:', error);
    return { success: false, error: 'Failed to update member' };
  }
}

/**
 * Link (or unlink) the *current* user's own cash account that this mortgage's
 * monthly transfer is paid from. Any member may set this for their own row — it
 * only affects their private cashflow, so it is not owner-gated. Pass `null` to
 * clear. Returns the updated mortgage.
 */
export async function setMyMortgageLinkedAccount(
  mortgageId: string,
  accountId: string | null
): Promise<ApiResponse<SharedMortgage>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: 'Not authenticated' };
  const loaded = await loadMortgageForMember(mortgageId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  const updated = await dbUpdateMortgageMember(mortgageId, session.user.id, {
    linkedAccountId: accountId ?? undefined,
  });
  if (!updated) return { success: false, error: 'Mortgage not found' };
  invalidateForMembers(updated);
  // The cashflow projection (getProjection) recomputes fresh each call and will
  // pick up / drop this transfer on the next load — no extra cache tag needed.
  return { success: true, data: updated };
}

// ---------- Rates ----------

export async function setMortgageRate(
  mortgageId: string,
  data: z.infer<typeof setRateSchema>
): Promise<ApiResponse<MortgageRateEntry>> {
  try {
    const loaded = await loadMortgageForMember(mortgageId);
    if (!loaded.ok) return { success: false, error: loaded.error };
    const validated = setRateSchema.parse(data);
    const entry = await dbSetRate(mortgageId, validated);
    updateTag(`mortgage:${mortgageId}:rates`);
    return { success: true, data: entry };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Set mortgage rate error:', error);
    return { success: false, error: 'Failed to set rate' };
  }
}

export async function deleteMortgageRate(
  mortgageId: string,
  rateId: string
): Promise<ApiResponse<void>> {
  const loaded = await loadMortgageForMember(mortgageId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  await dbDeleteRate(mortgageId, rateId);
  updateTag(`mortgage:${mortgageId}:rates`);
  return { success: true };
}

// ---------- Costs ----------

export async function setMortgageCost(
  mortgageId: string,
  data: z.infer<typeof setCostSchema>
): Promise<ApiResponse<MortgageCostEntry>> {
  try {
    const loaded = await loadMortgageForMember(mortgageId);
    if (!loaded.ok) return { success: false, error: loaded.error };
    const validated = setCostSchema.parse(data);
    if (validated.type === 'loan-insurance' && !validated.loanId) {
      return { success: false, error: 'Insurance needs a loan' };
    }
    const entry = await dbSetCost(mortgageId, validated);
    updateTag(`mortgage:${mortgageId}:costs`);
    return { success: true, data: entry };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Set mortgage cost error:', error);
    return { success: false, error: 'Failed to set cost' };
  }
}

export async function deleteMortgageCost(
  mortgageId: string,
  costId: string
): Promise<ApiResponse<void>> {
  const loaded = await loadMortgageForMember(mortgageId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  await dbDeleteCost(mortgageId, costId);
  updateTag(`mortgage:${mortgageId}:costs`);
  return { success: true };
}

// ---------- Extra payments ----------

export async function addMortgageExtraPayment(
  mortgageId: string,
  data: z.infer<typeof extraPaymentSchema>
): Promise<ApiResponse<MortgageExtraPayment>> {
  try {
    const loaded = await loadMortgageForMember(mortgageId);
    if (!loaded.ok) return { success: false, error: loaded.error };
    const validated = extraPaymentSchema.parse(data);
    if (!loaded.mortgage.loans.some((l) => l.id === validated.loanId)) {
      return { success: false, error: 'Unknown loan' };
    }
    const entry = await dbCreateExtraPayment(mortgageId, validated);
    updateTag(`mortgage:${mortgageId}:payments`);
    return { success: true, data: entry };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Add extra payment error:', error);
    return { success: false, error: 'Failed to add extra payment' };
  }
}

export async function deleteMortgageExtraPayment(
  mortgageId: string,
  paymentId: string
): Promise<ApiResponse<void>> {
  const loaded = await loadMortgageForMember(mortgageId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  await dbDeleteExtraPayment(mortgageId, paymentId);
  updateTag(`mortgage:${mortgageId}:payments`);
  return { success: true };
}

// ---------- Drift snapshots ----------

export async function recordMortgageBalanceSnapshot(
  mortgageId: string,
  data: z.infer<typeof snapshotSchema>
): Promise<ApiResponse<MortgageBalanceSnapshot>> {
  try {
    const loaded = await loadMortgageForMember(mortgageId);
    if (!loaded.ok) return { success: false, error: loaded.error };
    const validated = snapshotSchema.parse(data);
    if (!loaded.mortgage.loans.some((l) => l.id === validated.loanId)) {
      return { success: false, error: 'Unknown loan' };
    }
    const entry = await dbCreateSnapshot(mortgageId, validated);
    updateTag(`mortgage:${mortgageId}:snapshots`);
    return { success: true, data: entry };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Record drift snapshot error:', error);
    return { success: false, error: 'Failed to record balance' };
  }
}

export async function deleteMortgageBalanceSnapshot(
  mortgageId: string,
  snapshotId: string
): Promise<ApiResponse<void>> {
  const loaded = await loadMortgageForMember(mortgageId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  await dbDeleteSnapshot(mortgageId, snapshotId);
  updateTag(`mortgage:${mortgageId}:snapshots`);
  return { success: true };
}

// ---------- Actual monthly history (import) ----------

export async function getMortgageActuals(
  mortgageId: string
): Promise<ApiResponse<MortgageActualEntry[]>> {
  const loaded = await loadMortgageForMember(mortgageId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  const actuals = await cachedGetMortgageActuals(mortgageId);
  return { success: true, data: actuals };
}

export async function importMortgageActuals(
  mortgageId: string,
  data: z.infer<typeof importActualsSchema>
): Promise<ApiResponse<{ imported: number }>> {
  try {
    const loaded = await loadMortgageForMember(mortgageId);
    if (!loaded.ok) return { success: false, error: loaded.error };
    const validated = importActualsSchema.parse(data);
    // Every row must reference a real loan.
    const loanIds = new Set(loaded.mortgage.loans.map((l) => l.id));
    const unknown = validated.entries.find((e) => !loanIds.has(e.loanId));
    if (unknown) return { success: false, error: `Unknown loan "${unknown.loanId}"` };
    const count = await dbBulkSetActuals(mortgageId, validated.entries, validated.replaceAll ?? false);
    updateTag(`mortgage:${mortgageId}:actuals`);
    return { success: true, data: { imported: count } };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Import actuals error:', error);
    return { success: false, error: 'Failed to import actuals' };
  }
}

export async function clearMortgageActuals(mortgageId: string): Promise<ApiResponse<void>> {
  const loaded = await loadMortgageForMember(mortgageId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  await dbDeleteAllActuals(mortgageId);
  updateTag(`mortgage:${mortgageId}:actuals`);
  return { success: true };
}

/**
 * Reconcile one month: record the (per-loan) figures as the confirmed actual,
 * flipping that month from forecast to actual. Upserts in place (does not touch
 * other months). The caller typically passes the projected values, optionally
 * edited to match the bank statement.
 */
export async function reconcileMortgageMonth(
  mortgageId: string,
  entries: z.infer<typeof actualInputSchema>[]
): Promise<ApiResponse<{ saved: number }>> {
  try {
    const loaded = await loadMortgageForMember(mortgageId);
    if (!loaded.ok) return { success: false, error: loaded.error };
    const validated = z.array(actualInputSchema).min(1, 'Nothing to reconcile').parse(entries);
    const loanIds = new Set(loaded.mortgage.loans.map((l) => l.id));
    const unknown = validated.find((e) => !loanIds.has(e.loanId));
    if (unknown) return { success: false, error: `Unknown loan "${unknown.loanId}"` };
    // Upsert these rows, leaving every other recorded month untouched.
    const count = await dbBulkSetActuals(mortgageId, validated, false);
    updateTag(`mortgage:${mortgageId}:actuals`);
    return { success: true, data: { saved: count } };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Reconcile month error:', error);
    return { success: false, error: 'Failed to reconcile month' };
  }
}

/** Un-reconcile a month: drop its recorded actuals so it reverts to a forecast. */
export async function revertMortgageMonth(
  mortgageId: string,
  yearMonth: string
): Promise<ApiResponse<{ removed: number }>> {
  const loaded = await loadMortgageForMember(mortgageId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  const removed = await dbDeleteActualsForMonth(mortgageId, yearMonth);
  updateTag(`mortgage:${mortgageId}:actuals`);
  return { success: true, data: { removed } };
}
