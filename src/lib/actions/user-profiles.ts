'use server';

import { z } from 'zod';
import { auth } from '@/lib/auth';
import { cachedGetAllUsers } from '@/lib/db/cached';
import { avatarUrlFor } from '@/lib/db/users';
import type { ApiResponse, UserProfile } from '@/types';

const getUserProfilesSchema = z.array(z.string().min(1)).min(1).max(50);

/**
 * Resolve display identities (name + avatar URL) for a set of user ids, for
 * collaborative UIs (split groups, shared mortgages) that need to render other
 * members' avatars.
 *
 * Available to ANY authenticated user — deliberately: it returns only `id`,
 * `name`, and `avatarUrl`, never email/role. Those names are already
 * denormalized onto co-members via group/mortgage membership, and the avatar is
 * a low-sensitivity public-within-the-app image, so this exposes nothing a
 * collaborator can't already see. It is NOT admin-gated on purpose.
 */
export async function getUserProfiles(userIds: string[]): Promise<ApiResponse<UserProfile[]>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: 'Not authenticated' };

  const parsed = getUserProfilesSchema.safeParse(userIds);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' };

  const requested = new Set(parsed.data);
  const users = await cachedGetAllUsers();
  const profiles: UserProfile[] = users
    .filter((u) => requested.has(u.id))
    .map((u) => ({ id: u.id, name: u.name, avatarUrl: avatarUrlFor(u) }));

  return { success: true, data: profiles };
}
