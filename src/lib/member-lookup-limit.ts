import { findUserByEmail } from '@/lib/db/users';
import type { User } from '@/types';

/**
 * Throttle for "add a person by email" lookups (split groups, shared
 * mortgages). Adding by email necessarily tells the caller whether an account
 * exists, so failed lookups are capped per signed-in user to stop that from
 * being used to enumerate accounts. In-memory, single process.
 */

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const MAX_FAILED_MEMBER_LOOKUPS = 20;

type LookupRecord = { count: number; windowStart: number };
// On globalThis so every bundle in the process shares one set of counters.
const failures: Map<string, LookupRecord> = ((globalThis as { __sampolioMemberLookups?: Map<string, LookupRecord> })
  .__sampolioMemberLookups ??= new Map());

export function isMemberLookupThrottled(userId: string, now = Date.now()): boolean {
  const record = failures.get(userId);
  if (!record || now - record.windowStart > WINDOW_MS) return false;
  return record.count >= MAX_FAILED_MEMBER_LOOKUPS;
}

export function recordFailedMemberLookup(userId: string, now = Date.now()): void {
  const record = failures.get(userId);
  if (!record || now - record.windowStart > WINDOW_MS) {
    failures.set(userId, { count: 1, windowStart: now });
  } else {
    record.count++;
  }
}

export const MEMBER_LOOKUP_THROTTLED_ERROR = 'Too many unknown emails tried. Please wait a while and try again.';

/** Test hook. */
export function resetMemberLookupLimitForTests(): void {
  failures.clear();
}


/** Resolve an email to an active account for `requesterId`, applying the throttle. */
export async function resolveMemberByEmail(
  requesterId: string,
  email: string
): Promise<{ ok: true; user: User } | { ok: false; error: string }> {
  if (isMemberLookupThrottled(requesterId)) return { ok: false, error: MEMBER_LOOKUP_THROTTLED_ERROR };
  const user = await findUserByEmail(email);
  if (!user || !user.isActive) {
    recordFailedMemberLookup(requesterId);
    return { ok: false, error: `No active account for ${email}` };
  }
  return { ok: true, user };
}
