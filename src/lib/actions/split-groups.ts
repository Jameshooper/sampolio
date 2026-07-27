'use server';

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { auth } from '@/lib/auth';
import { updateTag } from 'next/cache';
import { findUserByEmail } from '@/lib/db/users';
import { updateUserPreferences as dbUpdateUserPreferences } from '@/lib/db/user-preferences';
import {
  createSplitGroup as dbCreateSplitGroup,
  updateSplitGroup as dbUpdateSplitGroup,
  deleteSplitGroup as dbDeleteSplitGroup,
  addSplitGroupMember as dbAddMember,
  removeSplitGroupMember as dbRemoveMember,
  updateSplitGroupMemberRole as dbUpdateMemberRole,
  addExpense as dbAddExpense,
  updateExpense as dbUpdateExpense,
  deleteExpense as dbDeleteExpense,
  getExpenseById as dbGetExpenseById,
  upsertExpenseByOccurrence as dbUpsertOccurrence,
  bulkImportExpenses as dbBulkImport,
  addRecurrenceRule as dbAddRule,
  updateRecurrenceRule as dbUpdateRule,
  deleteRecurrenceRule as dbDeleteRule,
  deleteGeneratedOccurrencesAfter as dbDeleteGeneratedOccurrencesAfter,
} from '@/lib/db/split-groups';
import {
  cachedGetSplitGroupsForUser,
  cachedGetSplitGroupById,
  cachedGetSplitGroupSummary,
  cachedGetSplitExpensesForMonths,
  cachedGetUserPreferences,
} from '@/lib/db/cached';
import {
  resolveSplit,
  paymentNet,
  suggestSettleUp,
  generateOccurrenceDates,
  planRecurrenceRuleUpdate,
  guessCategory,
} from '@/lib/split-utils';
import { monthsWindow, computeSplitInsights, type SplitInsights, type SplitInsightsGroupInput } from '@/lib/split-insights';
import { buildNetByUserId, paymentParties } from '@/lib/split-csv';
import {
  createSplitGroupSchema,
  updateSplitGroupSchema,
  addSplitMemberSchema,
  splitGroupMemberRoleSchema,
  createSplitExpenseSchema,
  updateSplitExpenseSchema,
  quickAddSplitExpenseSchema,
  settleUpSchema,
  createSplitRecurrenceRuleSchema,
  updateSplitRecurrenceRuleSchema,
  markSplitGroupSeenSchema,
  importSplitwiseSchema,
} from '@/lib/schemas/split.schema';
import type {
  ApiResponse,
  SplitGroup,
  SplitGroupMember,
  SplitGroupMemberRole,
  SplitGroupSummary,
  SplitExpense,
  SplitExpenseItem,
  SplitPayment,
  SplitRecurrenceRule,
  SplitMemberBalance,
  SplitActivityEvent,
  SplitSpec,
  SplitExpenseBankLink,
  SplitLinkCandidate,
} from '@/types';

const todayISO = (): string => new Date().toISOString().slice(0, 10);

// ============================================================
// ACCESS CONTROL + INVALIDATION
// ============================================================

type LoadResult =
  | { ok: true; group: SplitGroup; userId: string }
  | { ok: false; error: string };

async function loadGroupForMember(groupId: string, opts?: { requireOwner?: boolean }): Promise<LoadResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: 'Unauthorized' };
  const group = await cachedGetSplitGroupById(groupId);
  if (!group) return { ok: false, error: 'Group not found' };
  const me = group.members.find((m) => m.userId === session.user.id);
  if (!me) return { ok: false, error: 'You do not have access to this group' };
  if (opts?.requireOwner && me.role !== 'owner') return { ok: false, error: 'Only an owner can do that' };
  return { ok: true, group, userId: session.user.id };
}

/** One invalidation reaches every member (group/summary/expense tags + each member's list). */
function invalidateGroup(group: SplitGroup): void {
  updateTag(`split-group:${group.id}`);
  updateTag(`split-group:${group.id}:summary`);
  updateTag(`split-group:${group.id}:expenses`);
  for (const m of group.members) updateTag(`user:${m.userId}:split-groups`);
}

// ============================================================
// PER-GROUP IN-PROCESS MUTEX
// Serializes read-modify-write of a group's chunks/summary on this single node,
// so two devices adding/importing at once can't clobber each other.
// ============================================================

const chains = new Map<string, Promise<unknown>>();

function withGroupLock<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(groupId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(
    groupId,
    run.catch(() => {}),
  );
  return run;
}

// ============================================================
// BUILDERS
// ============================================================

function buildExpenseRow(
  group: SplitGroup,
  input: { title: string; category: string; amountCents: number; date: string; note?: string; split: SplitSpec },
  createdByUserId: string,
  source: SplitExpenseItem['source'],
  extra?: {
    id?: string;
    createdAt?: string;
    generatedFromRuleId?: string;
    occurrenceKey?: string;
    bankLink?: SplitExpenseBankLink;
  },
): SplitExpenseItem {
  const memberIds = group.members.map((m) => m.userId);
  const { netByUserId, paidBy, owed } = resolveSplit(memberIds, input.amountCents, input.split);
  const now = new Date().toISOString();
  return {
    kind: 'expense',
    id: extra?.id ?? uuidv4(),
    groupId: group.id,
    date: input.date,
    currency: group.currency,
    note: input.note,
    netByUserId,
    source,
    generatedFromRuleId: extra?.generatedFromRuleId,
    occurrenceKey: extra?.occurrenceKey,
    createdByUserId,
    createdAt: extra?.createdAt ?? now,
    updatedAt: now,
    title: input.title,
    category: input.category,
    amountCents: input.amountCents,
    paidBy,
    owed,
    splitMode: input.split.splitMode,
    bankLink: extra?.bankLink,
  };
}

// ============================================================
// READS
// ============================================================

export async function getMySplitGroups(): Promise<ApiResponse<SplitGroup[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const groups = (await cachedGetSplitGroupsForUser(session.user.id)).filter((g) => !g.isArchived);
    return { success: true, data: groups };
  } catch (error) {
    console.error('Get split groups error:', error);
    return { success: false, error: 'Failed to fetch groups' };
  }
}

export interface SplitGroupView {
  group: SplitGroup;
  summary: SplitGroupSummary;
  balances: SplitMemberBalance[];
}

export async function getSplitGroupView(groupId: string): Promise<ApiResponse<SplitGroupView>> {
  const loaded = await loadGroupForMember(groupId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  const summary = await cachedGetSplitGroupSummary(groupId);
  const balances = loaded.group.members.map((m) => ({
    userId: m.userId,
    name: m.name,
    netCents: summary.netByUserId[m.userId] ?? 0,
  }));
  return { success: true, data: { group: loaded.group, summary, balances } };
}

/** Expenses for the given months (defaults to the months present in the summary's latest year). */
export async function getSplitExpenses(groupId: string, months?: string[]): Promise<ApiResponse<SplitExpense[]>> {
  const loaded = await loadGroupForMember(groupId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  const summary = await cachedGetSplitGroupSummary(groupId);
  const target = months ?? summary.monthsWithData;
  const rows = await cachedGetSplitExpensesForMonths(groupId, target);
  return { success: true, data: rows };
}

function toActivityEvent(group: SplitGroup, row: SplitExpense, viewerId: string): SplitActivityEvent {
  const nameOf = (id: string) => group.members.find((m) => m.userId === id)?.name ?? 'Someone';
  const isPayment = row.kind === 'payment';
  return {
    id: row.id,
    groupId: group.id,
    groupName: group.name,
    groupEmoji: group.emoji,
    kind: row.kind,
    title: isPayment
      ? `${nameOf((row as SplitPayment).fromUserId)} paid ${nameOf((row as SplitPayment).toUserId)}`
      : (row as SplitExpenseItem).title,
    category: isPayment ? 'Payment' : (row as SplitExpenseItem).category,
    amountCents: row.kind === 'payment' ? (row as SplitPayment).amountCents : (row as SplitExpenseItem).amountCents,
    viewerNetCents: row.netByUserId[viewerId] ?? 0,
    actorUserId: row.createdByUserId,
    actorName: nameOf(row.createdByUserId),
    date: row.date,
    createdAt: row.createdAt,
    source: row.source,
  };
}

/** Recent activity for the Home feed (cross-group) or, with `groupId`, for one
 * group's Activity section. Reads only the latest month chunks. */
export async function getSplitActivity(limit = 20, groupId?: string): Promise<ApiResponse<SplitActivityEvent[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const userId = session.user.id;
    // Scoping to the user's own groups doubles as the access check when a
    // single groupId is requested.
    const groups = (await cachedGetSplitGroupsForUser(userId)).filter(
      (g) => !g.isArchived && (!groupId || g.id === groupId)
    );
    const events: SplitActivityEvent[] = [];
    for (const g of groups) {
      const summary = await cachedGetSplitGroupSummary(g.id);
      const months = summary.monthsWithData.slice(-3); // newest few months — enough for a recent feed
      const rows = await cachedGetSplitExpensesForMonths(g.id, months);
      for (const r of rows) events.push(toActivityEvent(g, r, userId));
    }
    events.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { success: true, data: events.slice(0, limit) };
  } catch (error) {
    console.error('Get split activity error:', error);
    return { success: false, error: 'Failed to fetch activity' };
  }
}

/** Logged-in user's net split balance across all groups, in cents (for Overview KPIs). */
export async function getMySplitNetBalance(): Promise<ApiResponse<{ netCents: number }>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const userId = session.user.id;
    const groups = (await cachedGetSplitGroupsForUser(userId)).filter((g) => !g.isArchived);
    let netCents = 0;
    for (const g of groups) {
      const summary = await cachedGetSplitGroupSummary(g.id);
      netCents += summary.netByUserId[userId] ?? 0;
    }
    return { success: true, data: { netCents } };
  } catch (error) {
    console.error('Get split net balance error:', error);
    return { success: false, error: 'Failed to compute split balance' };
  }
}

const yearMonthRe = /^\d{4}-\d{2}$/;

/** Lightweight cross-group projection for the bank ledger's "already split"
 * matching (see `matchTransactionsToSplits` in `src/lib/bank-split-match.ts`).
 * Read-only; skips groups whose summary has no overlap with the requested
 * months so it never reads a chunk it doesn't need. */
export async function getMySplitLinkCandidates(months: string[]): Promise<ApiResponse<SplitLinkCandidate[]>> {
  try {
    if (!Array.isArray(months) || months.some((m) => typeof m !== 'string' || !yearMonthRe.test(m))) {
      return { success: false, error: 'Invalid months (expected YYYY-MM)' };
    }
    const requested = [...new Set(months)].sort().reverse().slice(0, 36);
    if (requested.length === 0) return { success: true, data: [] };

    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const userId = session.user.id;
    const groups = (await cachedGetSplitGroupsForUser(userId)).filter((g) => !g.isArchived);

    const candidates: SplitLinkCandidate[] = [];
    for (const g of groups) {
      const summary = await cachedGetSplitGroupSummary(g.id);
      const overlap = requested.filter((m) => summary.monthsWithData.includes(m));
      if (overlap.length === 0) continue; // no chunk read needed
      const rows = await cachedGetSplitExpensesForMonths(g.id, overlap);
      for (const r of rows) {
        if (r.kind !== 'expense') continue;
        candidates.push({
          expenseId: r.id,
          groupId: g.id,
          groupName: g.name,
          title: r.title,
          date: r.date,
          amountCents: r.amountCents,
          currency: r.currency,
          bankLink: r.bankLink
            ? { txId: r.bankLink.txId, linkedAccountId: r.bankLink.linkedAccountId, ownerUserId: r.bankLink.ownerUserId }
            : undefined,
        });
      }
    }
    return { success: true, data: candidates };
  } catch (error) {
    console.error('Get split link candidates error:', error);
    return { success: false, error: 'Failed to fetch split link candidates' };
  }
}

/**
 * Cross-group insights for the /split page charts: monthly spend by group, paid
 * attribution by member, and the viewer's running net over the last
 * `monthsBack` months. Pure aggregation in `computeSplitInsights`; this action
 * only gathers inputs. Groups with no activity in the window still contribute
 * their standing balance to the running-net line (baseline), but a group whose
 * summary has no overlapping month never triggers a chunk read.
 */
export async function getSplitInsights(monthsBack = 12): Promise<ApiResponse<SplitInsights>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const parsed = z.number().int().min(1).max(36).safeParse(monthsBack);
    if (!parsed.success) return { success: false, error: 'Invalid range' };
    const userId = session.user.id;

    const months = monthsWindow(parsed.data);
    const monthSet = new Set(months);
    const groups = (await cachedGetSplitGroupsForUser(userId)).filter((g) => !g.isArchived);

    const inputs: SplitInsightsGroupInput[] = [];
    for (const g of groups) {
      const summary = await cachedGetSplitGroupSummary(g.id);
      const overlap = summary.monthsWithData.filter((m) => monthSet.has(m));
      const rows = overlap.length > 0 ? await cachedGetSplitExpensesForMonths(g.id, overlap) : [];
      inputs.push({
        group: { id: g.id, name: g.name, emoji: g.emoji, currency: g.currency, members: g.members },
        rows,
        totalNetByUserId: summary.netByUserId,
      });
    }

    return { success: true, data: computeSplitInsights(userId, inputs, months) };
  } catch (error) {
    console.error('Get split insights error:', error);
    return { success: false, error: 'Failed to compute insights' };
  }
}

export async function getSettleUpSuggestions(groupId: string): Promise<ApiResponse<ReturnType<typeof suggestSettleUp>>> {
  const loaded = await loadGroupForMember(groupId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  const summary = await cachedGetSplitGroupSummary(groupId);
  const balances = loaded.group.members.map((m) => ({
    userId: m.userId,
    name: m.name,
    netCents: summary.netByUserId[m.userId] ?? 0,
  }));
  return { success: true, data: suggestSettleUp(balances) };
}

// ============================================================
// GROUP MUTATIONS
// ============================================================

export async function createSplitGroup(
  data: z.infer<typeof createSplitGroupSchema>,
): Promise<ApiResponse<SplitGroup>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const validated = createSplitGroupSchema.parse(data);

    const resolved: SplitGroupMember[] = [];
    for (const m of validated.members ?? []) {
      const user = await findUserByEmail(m.email);
      if (!user || !user.isActive) return { success: false, error: `No active account for ${m.email}` };
      if (user.id === session.user.id) continue;
      resolved.push({ userId: user.id, email: user.email, name: user.name, role: m.role ?? 'member' });
    }

    const group = await dbCreateSplitGroup(
      { userId: session.user.id, email: session.user.email ?? '', name: session.user.name ?? 'You' },
      validated,
      resolved,
    );
    invalidateGroup(group);
    return { success: true, data: group };
  } catch (error) {
    if (error instanceof z.ZodError) return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    console.error('Create split group error:', error);
    return { success: false, error: 'Failed to create group' };
  }
}

export async function updateSplitGroup(
  groupId: string,
  data: z.infer<typeof updateSplitGroupSchema>,
): Promise<ApiResponse<SplitGroup>> {
  const loaded = await loadGroupForMember(groupId, { requireOwner: true });
  if (!loaded.ok) return { success: false, error: loaded.error };
  try {
    const validated = updateSplitGroupSchema.parse(data);
    const updated = await dbUpdateSplitGroup(groupId, validated, loaded.userId);
    if (!updated) return { success: false, error: 'Group not found' };
    invalidateGroup(updated);
    return { success: true, data: updated };
  } catch (error) {
    if (error instanceof z.ZodError) return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    console.error('Update split group error:', error);
    return { success: false, error: 'Failed to update group' };
  }
}

export async function deleteSplitGroup(groupId: string): Promise<ApiResponse<void>> {
  const loaded = await loadGroupForMember(groupId, { requireOwner: true });
  if (!loaded.ok) return { success: false, error: loaded.error };
  await dbDeleteSplitGroup(groupId);
  invalidateGroup(loaded.group);
  return { success: true };
}

export async function addSplitGroupMember(
  groupId: string,
  data: z.infer<typeof addSplitMemberSchema>,
): Promise<ApiResponse<SplitGroup>> {
  const loaded = await loadGroupForMember(groupId, { requireOwner: true });
  if (!loaded.ok) return { success: false, error: loaded.error };
  try {
    const { email, role } = addSplitMemberSchema.parse(data);
    const user = await findUserByEmail(email);
    if (!user || !user.isActive) return { success: false, error: `No active account for ${email}` };
    const updated = await dbAddMember(groupId, {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: role ?? 'member',
    });
    if (!updated) return { success: false, error: 'Group not found' };
    invalidateGroup(updated);
    return { success: true, data: updated };
  } catch (error) {
    if (error instanceof z.ZodError) return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    console.error('Add split member error:', error);
    return { success: false, error: 'Failed to add member' };
  }
}

export async function removeSplitGroupMember(groupId: string, userId: string): Promise<ApiResponse<SplitGroup>> {
  const loaded = await loadGroupForMember(groupId, { requireOwner: true });
  if (!loaded.ok) return { success: false, error: loaded.error };
  const summary = await cachedGetSplitGroupSummary(groupId);
  if ((summary.netByUserId[userId] ?? 0) !== 0) {
    return { success: false, error: 'Settle this member up to €0 before removing them' };
  }
  const updated = await dbRemoveMember(groupId, userId);
  if (!updated) return { success: false, error: 'Group not found' };
  invalidateGroup(updated);
  // also drop the removed user's membership-list cache
  updateTag(`user:${userId}:split-groups`);
  return { success: true, data: updated };
}

export async function updateSplitGroupMemberRole(
  groupId: string,
  userId: string,
  role: SplitGroupMemberRole,
): Promise<ApiResponse<SplitGroup>> {
  const loaded = await loadGroupForMember(groupId, { requireOwner: true });
  if (!loaded.ok) return { success: false, error: loaded.error };
  try {
    const parsedRole = splitGroupMemberRoleSchema.parse(role);
    const target = loaded.group.members.find((m) => m.userId === userId);
    if (!target) return { success: false, error: 'Member not found' };
    if (target.role === 'owner' && parsedRole !== 'owner') {
      const ownerCount = loaded.group.members.filter((m) => m.role === 'owner').length;
      if (ownerCount <= 1) {
        return { success: false, error: 'Make another member an owner first — a group must always have one' };
      }
    }
    const updated = await dbUpdateMemberRole(groupId, userId, parsedRole);
    if (!updated) return { success: false, error: 'Group not found' };
    invalidateGroup(updated);
    updateTag(`user:${userId}:split-groups`);
    return { success: true, data: updated };
  } catch (error) {
    if (error instanceof z.ZodError) return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    console.error('Update split member role error:', error);
    return { success: false, error: 'Failed to update member role' };
  }
}

export async function setDefaultSplitGroup(groupId: string): Promise<ApiResponse<void>> {
  const loaded = await loadGroupForMember(groupId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  await dbUpdateUserPreferences(loaded.userId, { defaultSplitGroupId: groupId });
  updateTag(`user:${loaded.userId}:preferences`);
  return { success: true };
}

/**
 * Move the viewer's "new since last visit" watermark for a group forward to
 * `seenAt` (an ISO createdAt). Monotonic — never moves backward — so a stale
 * flush can't un-see rows. A future timestamp is clamped to now.
 */
export async function markSplitGroupSeen(groupId: string, seenAt: string): Promise<ApiResponse<void>> {
  const loaded = await loadGroupForMember(groupId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  const parsed = markSplitGroupSeenSchema.safeParse({ seenAt });
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid timestamp' };

  const nowIso = new Date().toISOString();
  const next = parsed.data.seenAt > nowIso ? nowIso : parsed.data.seenAt;

  const prefs = await cachedGetUserPreferences(loaded.userId);
  const existing = prefs.splitLastSeenAt?.[groupId];
  if (existing && existing >= next) return { success: true }; // monotonic no-op

  await dbUpdateUserPreferences(loaded.userId, {
    splitLastSeenAt: { ...prefs.splitLastSeenAt, [groupId]: next },
  });
  updateTag(`user:${loaded.userId}:preferences`);
  return { success: true };
}

// ============================================================
// EXPENSE MUTATIONS
// ============================================================

export async function createSplitExpense(
  groupId: string,
  data: z.infer<typeof createSplitExpenseSchema>,
): Promise<ApiResponse<SplitExpense>> {
  const loaded = await loadGroupForMember(groupId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  try {
    const validated = createSplitExpenseSchema.parse(data);
    // The owner is stamped from the authenticated member — never trust a
    // client-supplied ownerUserId (the schema doesn't even accept one).
    const bankLink: SplitExpenseBankLink | undefined = validated.bankLink
      ? { ...validated.bankLink, ownerUserId: loaded.userId }
      : undefined;
    const row = buildExpenseRow(loaded.group, validated, loaded.userId, 'manual', { bankLink });
    await withGroupLock(groupId, () => dbAddExpense(groupId, row));
    invalidateGroup(loaded.group);
    return { success: true, data: row };
  } catch (error) {
    if (error instanceof z.ZodError) return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    console.error('Create split expense error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to add expense' };
  }
}

export async function quickAddSplitExpense(
  groupId: string,
  data: z.infer<typeof quickAddSplitExpenseSchema>,
): Promise<ApiResponse<SplitExpense>> {
  const loaded = await loadGroupForMember(groupId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  try {
    const validated = quickAddSplitExpenseSchema.parse(data);
    const row = buildExpenseRow(
      loaded.group,
      {
        title: validated.title,
        category: validated.category || guessCategory(validated.title),
        amountCents: validated.amountCents,
        date: validated.date ?? todayISO(),
        split: { paidByUserId: loaded.userId, splitMode: 'equal' },
      },
      loaded.userId,
      'manual',
    );
    await withGroupLock(groupId, () => dbAddExpense(groupId, row));
    invalidateGroup(loaded.group);
    return { success: true, data: row };
  } catch (error) {
    if (error instanceof z.ZodError) return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    console.error('Quick-add split expense error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to add expense' };
  }
}

export async function updateSplitExpense(
  groupId: string,
  expenseId: string,
  data: z.infer<typeof updateSplitExpenseSchema>,
): Promise<ApiResponse<SplitExpense>> {
  const loaded = await loadGroupForMember(groupId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  try {
    const validated = updateSplitExpenseSchema.parse(data);
    const existing = await dbGetExpenseById(groupId, expenseId);
    if (!existing || existing.kind !== 'expense') return { success: false, error: 'Expense not found' };
    const next = buildExpenseRow(loaded.group, validated, existing.createdByUserId, existing.source, {
      id: existing.id,
      createdAt: existing.createdAt,
      generatedFromRuleId: existing.generatedFromRuleId,
      occurrenceKey: existing.occurrenceKey,
      // The link is never editable via the edit dialog (the update schema
      // omits it) — always carry the existing one through, or editing an
      // expense would silently erase it.
      bankLink: existing.bankLink,
    });
    const saved = await withGroupLock(groupId, () => dbUpdateExpense(groupId, expenseId, next));
    if (!saved) return { success: false, error: 'Expense not found' };
    invalidateGroup(loaded.group);
    return { success: true, data: saved };
  } catch (error) {
    if (error instanceof z.ZodError) return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    console.error('Update split expense error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to update expense' };
  }
}

export async function deleteSplitExpense(groupId: string, expenseId: string): Promise<ApiResponse<void>> {
  const loaded = await loadGroupForMember(groupId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  const ok = await withGroupLock(groupId, () => dbDeleteExpense(groupId, expenseId));
  if (!ok) return { success: false, error: 'Expense not found' };
  invalidateGroup(loaded.group);
  return { success: true };
}

export async function recordSettleUp(
  groupId: string,
  data: z.infer<typeof settleUpSchema>,
): Promise<ApiResponse<SplitExpense>> {
  const loaded = await loadGroupForMember(groupId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  try {
    const validated = settleUpSchema.parse(data);
    const memberIds = loaded.group.members.map((m) => m.userId);
    if (!memberIds.includes(validated.fromUserId) || !memberIds.includes(validated.toUserId)) {
      return { success: false, error: 'Both parties must be members of the group' };
    }
    const now = new Date().toISOString();
    const payment: SplitPayment = {
      kind: 'payment',
      id: uuidv4(),
      groupId,
      date: validated.date ?? todayISO(),
      currency: loaded.group.currency,
      note: validated.note,
      netByUserId: paymentNet(validated.fromUserId, validated.toUserId, validated.amountCents),
      source: 'manual',
      createdByUserId: loaded.userId,
      createdAt: now,
      updatedAt: now,
      fromUserId: validated.fromUserId,
      toUserId: validated.toUserId,
      amountCents: validated.amountCents,
    };
    await withGroupLock(groupId, () => dbAddExpense(groupId, payment));
    invalidateGroup(loaded.group);
    return { success: true, data: payment };
  } catch (error) {
    if (error instanceof z.ZodError) return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    console.error('Record settle-up error:', error);
    return { success: false, error: 'Failed to record payment' };
  }
}

// ============================================================
// RECURRENCE
// ============================================================

export async function createSplitRecurrenceRule(
  groupId: string,
  data: z.infer<typeof createSplitRecurrenceRuleSchema>,
): Promise<ApiResponse<SplitGroup>> {
  const loaded = await loadGroupForMember(groupId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  try {
    const v = createSplitRecurrenceRuleSchema.parse(data);
    const now = new Date().toISOString();
    const rule: SplitRecurrenceRule = {
      id: uuidv4(),
      title: v.title,
      category: v.category,
      amountCents: v.amountCents,
      currency: loaded.group.currency,
      note: v.note,
      split: v.split,
      interval: v.interval,
      anchorDate: v.anchorDate,
      endDate: v.endDate,
      isActive: v.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    };
    const updated = await dbAddRule(groupId, rule);
    if (!updated) return { success: false, error: 'Group not found' };
    invalidateGroup(updated);
    // Materialize any occurrences already due (e.g. a back-dated anchor).
    await catchUpGroupRecurrences(groupId);
    return { success: true, data: updated };
  } catch (error) {
    if (error instanceof z.ZodError) return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    console.error('Create recurrence rule error:', error);
    return { success: false, error: 'Failed to create recurring expense' };
  }
}

export async function updateSplitRecurrenceRule(
  groupId: string,
  ruleId: string,
  data: z.infer<typeof updateSplitRecurrenceRuleSchema>,
): Promise<ApiResponse<SplitGroup>> {
  const loaded = await loadGroupForMember(groupId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  try {
    const v = updateSplitRecurrenceRuleSchema.parse(data);
    const prev = loaded.group.recurrenceRules.find((r) => r.id === ruleId);
    if (!prev) return { success: false, error: 'Recurring rule not found' };

    const { updates, pruneAfter } = planRecurrenceRuleUpdate(prev, v);

    // Prune the now-orphaned generated tail (if the end date moved back past
    // already-materialized occurrences) and persist the update — both are
    // read-modify-write on the group's chunks/doc, so they run under one lock.
    const updated = await withGroupLock(groupId, async () => {
      if (pruneAfter !== null) await dbDeleteGeneratedOccurrencesAfter(groupId, ruleId, pruneAfter);
      return dbUpdateRule(groupId, ruleId, updates);
    });
    if (!updated) return { success: false, error: 'Group not found' };
    invalidateGroup(updated);
    // Re-materialize any occurrences newly due (e.g. the end date was extended).
    // MUST run OUTSIDE the lock above: withGroupLock is NOT reentrant and
    // catchUpGroupRecurrences takes the lock itself (mirrors createSplitRecurrenceRule).
    await catchUpGroupRecurrences(groupId);
    return { success: true, data: updated };
  } catch (error) {
    if (error instanceof z.ZodError) return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    console.error('Update recurrence rule error:', error);
    return { success: false, error: 'Failed to update recurring expense' };
  }
}

export async function deleteSplitRecurrenceRule(groupId: string, ruleId: string): Promise<ApiResponse<SplitGroup>> {
  const loaded = await loadGroupForMember(groupId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  const updated = await dbDeleteRule(groupId, ruleId);
  if (!updated) return { success: false, error: 'Group not found' };
  invalidateGroup(updated);
  return { success: true, data: updated };
}

/**
 * Idempotently materialize any due recurring expenses for a group. Runs under
 * the per-group mutex; uses deterministic occurrenceKeys so a re-run overwrites
 * rather than duplicates; advances each rule's cursor monotonically; and only
 * invalidates the cache when something was actually generated.
 */
export async function catchUpGroupRecurrences(groupId: string): Promise<ApiResponse<{ generated: number }>> {
  const loaded = await loadGroupForMember(groupId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  return withGroupLock(groupId, async () => {
    try {
      const group = loaded.group;
      const today = todayISO();
      let generated = 0;
      for (const rule of group.recurrenceRules) {
        if (!rule.isActive) continue;
        const dates = generateOccurrenceDates(rule, today);
        if (dates.length === 0) continue;
        for (const d of dates) {
          const row = buildExpenseRow(
            group,
            { title: rule.title, category: rule.category, amountCents: rule.amountCents, date: d, note: rule.note, split: rule.split },
            rule.split.paidByUserId,
            'recurring',
            { generatedFromRuleId: rule.id, occurrenceKey: `${rule.id}:${d}` },
          );
          await dbUpsertOccurrence(groupId, row);
          generated++;
        }
        const last = dates[dates.length - 1];
        const cursor = !rule.lastGeneratedThrough || last > rule.lastGeneratedThrough ? last : rule.lastGeneratedThrough;
        await dbUpdateRule(groupId, rule.id, { lastGeneratedThrough: cursor });
      }
      if (generated > 0) invalidateGroup(group);
      return { success: true, data: { generated } };
    } catch (error) {
      console.error('Catch-up recurrences error:', error);
      return { success: false, error: 'Failed to generate recurring expenses' };
    }
  });
}

// ============================================================
// CSV IMPORT (Splitwise export)
// ============================================================

export async function importSplitwiseCsv(
  data: z.infer<typeof importSplitwiseSchema>,
): Promise<ApiResponse<{ imported: number }>> {
  const parsedInput = importSplitwiseSchema.safeParse(data);
  if (!parsedInput.success) return { success: false, error: parsedInput.error.issues[0]?.message ?? 'Invalid import' };
  const loaded = await loadGroupForMember(parsedInput.data.groupId, { requireOwner: true });
  if (!loaded.ok) return { success: false, error: loaded.error };

  const { groupId, columnUserIds, rows, replaceAll } = parsedInput.data;
  const memberIds = new Set(loaded.group.members.map((m) => m.userId));
  for (const uid of columnUserIds) {
    if (uid && !memberIds.has(uid)) return { success: false, error: 'A mapped column points to a non-member' };
  }

  // Rows are stamped with the group currency below, so a foreign-currency CSV
  // would import with wrong amounts — reject any row that doesn't match.
  const foreign = [...new Set(rows.map((r) => r.currency).filter((c) => c !== loaded.group.currency))];
  if (foreign.length > 0) {
    return {
      success: false,
      error: `CSV currency ${foreign.join(', ')} does not match the group currency ${loaded.group.currency}`,
    };
  }

  const now = new Date().toISOString();
  const expenses: SplitExpense[] = [];
  for (const r of rows) {
    const netByUserId = buildNetByUserId(r.netByColumn, columnUserIds);
    const base = {
      id: uuidv4(),
      groupId,
      date: r.date,
      currency: loaded.group.currency,
      netByUserId,
      source: 'import' as const,
      createdByUserId: loaded.userId,
      createdAt: now,
      updatedAt: now,
    };
    if (r.isPayment) {
      const parties = paymentParties(r.netByColumn, columnUserIds);
      if (!parties) continue; // not a clean pairwise transfer — skip
      expenses.push({ ...base, kind: 'payment', ...parties });
    } else {
      expenses.push({ ...base, kind: 'expense', title: r.description, category: r.category, amountCents: r.amountCents });
    }
  }

  const imported = await withGroupLock(groupId, () => dbBulkImport(groupId, expenses, replaceAll ?? false));
  invalidateGroup(loaded.group);
  return { success: true, data: { imported } };
}
