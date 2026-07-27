'use server';

import * as fs from 'fs/promises';
import * as path from 'path';
import { updateTag } from 'next/cache';
import { auth } from '@/lib/auth';
import type { ApiResponse, AccountDeletionBlocker, AccountDeletionPreflight } from '@/types';
import {
  findUserById,
  verifyPassword,
  changePassword as dbChangePassword,
  setUserAvatar,
  hardDeleteUser,
} from '@/lib/db/users';
import { getUserDir } from '@/lib/db/encryption';
import { changePasswordSchema, type ChangePasswordFormData } from '@/lib/schemas/auth.schema';
import { avatarDataUriSchema, avatarDataUriToBuffer } from '@/lib/schemas/user.schema';
import {
  cachedGetAccounts,
  cachedGetGoals,
  cachedGetBudgets,
  cachedGetTrips,
  cachedGetBankConnections,
  cachedGetSplitGroupsForUser,
  cachedGetSplitGroupSummary,
  cachedGetMortgagesForUser,
  cachedGetAllUsers,
} from '@/lib/db/cached';
import {
  deleteSplitGroup as dbDeleteSplitGroup,
  removeSplitGroupMember as dbRemoveSplitGroupMember,
} from '@/lib/db/split-groups';
import {
  deleteMortgage as dbDeleteMortgage,
  removeMortgageMember as dbRemoveMortgageMember,
} from '@/lib/db/shared-mortgages';
import { teardownBankConnection } from '@/lib/bank/teardown';

/** Change the current user's password after re-verifying the current one. */
export async function changeMyPassword(input: ChangePasswordFormData): Promise<ApiResponse<null>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: 'Not authenticated' };

  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' };

  const user = await findUserById(session.user.id);
  if (!user) return { success: false, error: 'User not found' };

  const isValid = await verifyPassword(user, parsed.data.currentPassword);
  if (!isValid) return { success: false, error: 'Current password is incorrect' };

  await dbChangePassword(session.user.id, parsed.data.newPassword);
  return { success: true };
}

/** Set (data URI) or remove (null) the current user's own avatar. */
export async function updateMyAvatar(avatarDataUri: string | null): Promise<ApiResponse<null>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: 'Not authenticated' };

  const parsed = avatarDataUriSchema.nullable().safeParse(avatarDataUri);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid image' };

  const image = parsed.data ? avatarDataUriToBuffer(parsed.data) : null;
  const updated = await setUserAvatar(session.user.id, image);
  if (!updated) return { success: false, error: 'User not found' };

  updateTag('users');
  return { success: true };
}

/** Shared preflight logic between the read-only check (getAccountDeletionPreflight)
 * and the server-side re-check inside deleteMyAccount — never trust the client's
 * copy of this at delete time. */
async function buildDeletionPreflight(userId: string): Promise<AccountDeletionPreflight> {
  const blockers: AccountDeletionBlocker[] = [];

  const [accounts, goals, budgets, trips, bankConnections, splitGroups, mortgages, allUsers] = await Promise.all([
    cachedGetAccounts(userId),
    cachedGetGoals(userId),
    cachedGetBudgets(userId),
    cachedGetTrips(userId),
    cachedGetBankConnections(userId),
    cachedGetSplitGroupsForUser(userId),
    cachedGetMortgagesForUser(userId),
    cachedGetAllUsers(),
  ]);

  let splitGroupsToLeave = 0;
  let splitGroupsToDelete = 0;
  for (const group of splitGroups) {
    const summary = await cachedGetSplitGroupSummary(group.id);
    if ((summary.netByUserId[userId] ?? 0) !== 0) {
      blockers.push({ message: `Settle up to €0 in "${group.name}" first` });
    }
    if (group.members.length === 1) {
      splitGroupsToDelete += 1;
      continue;
    }
    splitGroupsToLeave += 1;
    const isSoleOwner =
      group.members.some((m) => m.userId === userId && m.role === 'owner') &&
      !group.members.some((m) => m.userId !== userId && m.role === 'owner');
    if (isSoleOwner) {
      blockers.push({ message: `Make another member an owner of "${group.name}", or delete the group first` });
    }
  }

  let mortgagesToLeave = 0;
  let mortgagesToDelete = 0;
  for (const mortgage of mortgages) {
    if (mortgage.members.length === 1) {
      mortgagesToDelete += 1;
      continue;
    }
    mortgagesToLeave += 1;
    const isSoleOwner =
      mortgage.members.some((m) => m.userId === userId && m.role === 'owner') &&
      !mortgage.members.some((m) => m.userId !== userId && m.role === 'owner');
    if (isSoleOwner) {
      blockers.push({ message: `Make another member an owner of "${mortgage.name}", or delete it first` });
    }
  }

  const me = allUsers.find((u) => u.id === userId);
  if (me?.role === 'admin') {
    const otherActiveAdmins = allUsers.some((u) => u.id !== userId && u.role === 'admin' && u.isActive);
    const otherActiveUsers = allUsers.some((u) => u.id !== userId && u.isActive);
    if (!otherActiveAdmins && otherActiveUsers) {
      blockers.push({ message: 'You are the only admin — promote another user to admin first' });
    }
  }

  return {
    blockers,
    summary: {
      accounts: accounts.length,
      goals: goals.length,
      budgets: budgets.length,
      trips: trips.length,
      bankConnections: bankConnections.length,
      splitGroupsToLeave,
      splitGroupsToDelete,
      mortgagesToLeave,
      mortgagesToDelete,
    },
  };
}

/** Read-only check surfaced by the "Delete account" dialog before the user
 * types their confirmation. Never mutates anything. */
export async function getAccountDeletionPreflight(): Promise<ApiResponse<AccountDeletionPreflight>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: 'Not authenticated' };
  const preflight = await buildDeletionPreflight(session.user.id);
  return { success: true, data: preflight };
}

/** Permanently deletes the current user's account: leaves/deletes every shared
 * split group and mortgage they belong to, tears down bank connections
 * (best-effort consent revoke), then hard-deletes the user directory + index
 * entry. Irreversible — gated by typing the account's own email. */
export async function deleteMyAccount(input: { confirmationText: string }): Promise<ApiResponse<null>> {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) return { success: false, error: 'Not authenticated' };
  const userId = session.user.id;
  const userEmail = session.user.email;

  if (input.confirmationText.trim().toLowerCase() !== userEmail.trim().toLowerCase()) {
    return { success: false, error: 'Confirmation text does not match your account email' };
  }

  // Re-run the preflight server-side — never trust a client-supplied "no blockers".
  const preflight = await buildDeletionPreflight(userId);
  if (preflight.blockers.length > 0) {
    return { success: false, error: preflight.blockers.map((b) => b.message).join(' ') };
  }

  // (a) Bank teardown — best-effort revoke, never fails the deletion.
  const connections = await cachedGetBankConnections(userId);
  for (const connection of connections) {
    try {
      await teardownBankConnection(userId, connection);
    } catch (err) {
      console.error('[account] bank teardown failed during account deletion (continuing):', err);
    }
  }

  // (b) Split groups: delete outright if the user is the sole member, else just leave.
  const touchedSplitGroupMemberIds = new Set<string>();
  const splitGroups = await cachedGetSplitGroupsForUser(userId);
  for (const group of splitGroups) {
    for (const m of group.members) touchedSplitGroupMemberIds.add(m.userId);
    if (group.members.length === 1) {
      await dbDeleteSplitGroup(group.id);
    } else {
      await dbRemoveSplitGroupMember(group.id, userId);
    }
    updateTag(`split-group:${group.id}`);
    updateTag(`split-group:${group.id}:summary`);
    updateTag(`split-group:${group.id}:expenses`);
  }

  // (c) Shared mortgages: same rule.
  const touchedMortgageMemberIds = new Set<string>();
  const mortgages = await cachedGetMortgagesForUser(userId);
  for (const mortgage of mortgages) {
    for (const m of mortgage.members) touchedMortgageMemberIds.add(m.userId);
    if (mortgage.members.length === 1) {
      await dbDeleteMortgage(mortgage.id);
    } else {
      await dbRemoveMortgageMember(mortgage.id, userId);
    }
    updateTag(`mortgage:${mortgage.id}`);
  }

  // (d) Hard delete: remove from the users index, then rm the whole user dir.
  await hardDeleteUser(userId);

  // (e) Cache-tag fan-out.
  updateTag(`user:${userId}`);
  updateTag('users');
  for (const uid of touchedSplitGroupMemberIds) updateTag(`user:${uid}:split-groups`);
  for (const uid of touchedMortgageMemberIds) updateTag(`user:${uid}:mortgages`);

  return { success: true };
}

// Dirs wiped by "Start fresh" — every OWNED financial data dir. Deliberately
// excludes user.enc, preferences.enc, and never touches shared split-groups /
// shared-mortgages (those live outside the user dir entirely).
const RESET_DIRS = ['accounts', 'investments', 'receivables', 'debts', 'goals', 'budgets', 'trips', 'reconciliation', 'bank'];

/** "Start fresh": wipes all of the current user's own financial data (incl.
 * disconnecting + revoking bank consents) but keeps the account itself,
 * login, and preferences. Shared split groups/mortgages are never touched. */
export async function resetMyData(): Promise<ApiResponse<null>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: 'Not authenticated' };
  const userId = session.user.id;

  const connections = await cachedGetBankConnections(userId);
  for (const connection of connections) {
    try {
      await teardownBankConnection(userId, connection);
    } catch (err) {
      console.error('[account] bank teardown failed during data reset (continuing):', err);
    }
  }

  const userDir = getUserDir(userId);
  await Promise.all(RESET_DIRS.map((d) => fs.rm(path.join(userDir, d), { recursive: true, force: true })));

  updateTag(`user:${userId}`);
  return { success: true };
}
