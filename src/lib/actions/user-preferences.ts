'use server';

import { auth } from '@/lib/auth';
import {
  updateUserPreferences as dbUpdateUserPreferences,
} from '@/lib/db/user-preferences';
import { getBankConnections } from '@/lib/db/bank-connections';
import { cachedGetUserPreferences, cachedGetSplitGroupsForUser } from '@/lib/db/cached';
import { getSplitNotifyConfig } from '@/lib/split-notify';
import { NAVIGATION_PAGE_IDS, MAX_BOTTOM_NAV_TABS } from '@/lib/bottom-nav-prefs';
import { updateTag } from 'next/cache';
import { z } from 'zod';
import type { ApiResponse, UserPreferences, TaxDefaults, DisplayMode, SplitNotifyEvent } from '@/types';

export async function getUserPreferences(): Promise<ApiResponse<UserPreferences>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }
    const prefs = await cachedGetUserPreferences(session.user.id);
    return { success: true, data: prefs };
  } catch (error) {
    console.error('Get user preferences error:', error);
    return { success: false, error: 'Failed to fetch preferences' };
  }
}

export async function completeOnboarding(): Promise<ApiResponse<UserPreferences>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }
    const prefs = await dbUpdateUserPreferences(session.user.id, {
      hasCompletedOnboarding: true,
    });
    updateTag(`user:${session.user.id}:preferences`);
    return { success: true, data: prefs };
  } catch (error) {
    console.error('Complete onboarding error:', error);
    return { success: false, error: 'Failed to update preferences' };
  }
}

export async function updateCategories(
  customCategories: string[],
  removedDefaultCategories: string[]
): Promise<ApiResponse<UserPreferences>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }
    const prefs = await dbUpdateUserPreferences(session.user.id, {
      customCategories,
      removedDefaultCategories,
    });
    updateTag(`user:${session.user.id}:preferences`);
    return { success: true, data: prefs };
  } catch (error) {
    console.error('Update categories error:', error);
    return { success: false, error: 'Failed to update categories' };
  }
}

export async function updateCheckInReminders(
  enabled: boolean
): Promise<ApiResponse<UserPreferences>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }
    const parsed = z.boolean().safeParse(enabled);
    if (!parsed.success) {
      return { success: false, error: 'Invalid value' };
    }
    const prefs = await dbUpdateUserPreferences(session.user.id, {
      checkInRemindersEnabled: parsed.data,
    });
    updateTag(`user:${session.user.id}:preferences`);
    return { success: true, data: prefs };
  } catch (error) {
    console.error('Update check-in reminders error:', error);
    return { success: false, error: 'Failed to update check-in reminders' };
  }
}

export async function updateCheckInNotifications(
  enabled: boolean
): Promise<ApiResponse<UserPreferences>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }
    const parsed = z.boolean().safeParse(enabled);
    if (!parsed.success) {
      return { success: false, error: 'Invalid value' };
    }
    const prefs = await dbUpdateUserPreferences(session.user.id, {
      checkInNotificationsEnabled: parsed.data,
    });
    updateTag(`user:${session.user.id}:preferences`);
    return { success: true, data: prefs };
  } catch (error) {
    console.error('Update check-in notifications error:', error);
    return { success: false, error: 'Failed to update check-in notifications' };
  }
}

/**
 * Per-event opt-out for the split push notifications. Every key is optional and
 * `false` means "don't notify me"; an absent key stays enabled (see
 * `isSplitNotifyEnabled`), so a partial record is always valid.
 */
const splitNotificationPrefsSchema = z.object({
  'expense.created': z.boolean().optional(),
  'expense.updated': z.boolean().optional(),
  'expense.deleted': z.boolean().optional(),
  'payment.recorded': z.boolean().optional(),
  'expense.generated': z.boolean().optional(),
});

export async function updateSplitNotificationPrefs(
  prefsInput: Partial<Record<SplitNotifyEvent, boolean>>
): Promise<ApiResponse<UserPreferences>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }
    const parsed = splitNotificationPrefsSchema.safeParse(prefsInput);
    if (!parsed.success) {
      return { success: false, error: 'Invalid notification preferences' };
    }
    // The UI always sends all five keys, so replacing the object wholesale is
    // the intended semantic (no per-key merge).
    const prefs = await dbUpdateUserPreferences(session.user.id, {
      splitNotificationPrefs: parsed.data,
    });
    updateTag(`user:${session.user.id}:preferences`);
    return { success: true, data: prefs };
  } catch (error) {
    console.error('Update split notification prefs error:', error);
    return { success: false, error: 'Failed to update notification preferences' };
  }
}

/** Whether this server has the Home Assistant webhook configured (else the UI notes it). */
export async function getSplitNotifyStatus(): Promise<ApiResponse<{ configured: boolean }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
  return { success: true, data: { configured: getSplitNotifyConfig() !== null } };
}

const bankAccountOrderSchema = z.array(z.string().min(1)).max(200);

export async function updateBankAccountOrder(
  order: string[]
): Promise<ApiResponse<UserPreferences>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }
    const parsed = bankAccountOrderSchema.safeParse(order);
    if (!parsed.success) {
      return { success: false, error: 'Invalid order' };
    }
    // Sanitize: keep only ids that still correspond to a linked bank account,
    // preserving the requested order. Prevents stale/forged ids from being
    // persisted.
    const connections = await getBankConnections(session.user.id);
    const validIds = new Set(
      connections.flatMap((c) => c.linkedAccounts.map((l) => l.id))
    );
    const sanitized = parsed.data.filter((id) => validIds.has(id));

    const prefs = await dbUpdateUserPreferences(session.user.id, {
      bankAccountOrder: sanitized,
    });
    updateTag(`user:${session.user.id}:preferences`);
    return { success: true, data: prefs };
  } catch (error) {
    console.error('Update bank account order error:', error);
    return { success: false, error: 'Failed to update account order' };
  }
}

const splitGroupOrderSchema = z.array(z.string().min(1)).max(200);

export async function updateSplitGroupOrder(
  order: string[]
): Promise<ApiResponse<UserPreferences>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }
    const parsed = splitGroupOrderSchema.safeParse(order);
    if (!parsed.success) {
      return { success: false, error: 'Invalid order' };
    }
    // Sanitize: keep only ids of groups the user is actually a member of
    // (including archived ones, so toggling archive never drops an order
    // entry), preserving the requested order.
    const groups = await cachedGetSplitGroupsForUser(session.user.id);
    const validIds = new Set(groups.map((g) => g.id));
    const sanitized = parsed.data.filter((id) => validIds.has(id));

    const prefs = await dbUpdateUserPreferences(session.user.id, {
      splitGroupOrder: sanitized,
    });
    updateTag(`user:${session.user.id}:preferences`);
    return { success: true, data: prefs };
  } catch (error) {
    console.error('Update split group order error:', error);
    return { success: false, error: 'Failed to update group order' };
  }
}

const displayModeSchema = z.enum(['simple', 'advanced']);

export async function updateDisplayMode(
  mode: DisplayMode
): Promise<ApiResponse<UserPreferences>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }
    const parsed = displayModeSchema.safeParse(mode);
    if (!parsed.success) {
      return { success: false, error: 'Invalid display mode' };
    }
    const prefs = await dbUpdateUserPreferences(session.user.id, {
      displayMode: parsed.data,
    });
    updateTag(`user:${session.user.id}:preferences`);
    return { success: true, data: prefs };
  } catch (error) {
    console.error('Update display mode error:', error);
    return { success: false, error: 'Failed to update display mode' };
  }
}

/**
 * The mobile bottom-nav tabs (1-4 `NavigationPage` ids; "More" is always the
 * fixed last cell and is never stored). `null` clears the preference back to the
 * per-display-mode defaults — `dbUpdateUserPreferences` spreads `undefined` and
 * `JSON.stringify` then drops the key entirely.
 */
const bottomNavIdsSchema = z.union([
  z.array(z.enum(NAVIGATION_PAGE_IDS)).min(1).max(MAX_BOTTOM_NAV_TABS),
  z.null(),
]);

export async function updateBottomNavIds(
  ids: string[] | null
): Promise<ApiResponse<UserPreferences>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }
    const parsed = bottomNavIdsSchema.safeParse(ids);
    if (!parsed.success) {
      return { success: false, error: 'Invalid navigation tabs' };
    }
    // The enum already guarantees every id is a real page — only duplicates
    // need sanitizing (order preserved).
    const sanitized = parsed.data === null ? undefined : [...new Set(parsed.data)];

    const prefs = await dbUpdateUserPreferences(session.user.id, {
      bottomNavIds: sanitized,
    });
    updateTag(`user:${session.user.id}:preferences`);
    return { success: true, data: prefs };
  } catch (error) {
    console.error('Update bottom nav ids error:', error);
    return { success: false, error: 'Failed to update navigation tabs' };
  }
}

export async function updateTaxDefaults(
  taxDefaults: TaxDefaults
): Promise<ApiResponse<UserPreferences>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }
    const prefs = await dbUpdateUserPreferences(session.user.id, {
      taxDefaults,
    });
    updateTag(`user:${session.user.id}:preferences`);
    return { success: true, data: prefs };
  } catch (error) {
    console.error('Update tax defaults error:', error);
    return { success: false, error: 'Failed to update tax defaults' };
  }
}
