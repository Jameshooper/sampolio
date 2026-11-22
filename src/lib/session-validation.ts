import { findUserById } from '@/lib/db/users';
import { isSessionRevoked } from '@/lib/db/revoked-sessions';
import type { User } from '@/types';

/**
 * Per-request session check used by the Auth.js `jwt` callback. A session is
 * valid only while its `sid` hasn't been signed out, the account still exists
 * and is active, and its `sessionVersion` matches the one captured at sign-in
 * (bumped by password change, deactivation, deletion and role change).
 * Returns the current account so the token can pick up name/role changes, or
 * null to end the session.
 */
export async function validateSessionClaims(claims: { id?: unknown; sid?: unknown; sv?: unknown }): Promise<User | null> {
  const { id, sid, sv } = claims;
  if (typeof id !== 'string' || typeof sid !== 'string') return null;
  if (await isSessionRevoked(sid)) return null;
  const current = await findUserById(id);
  if (!current || !current.isActive) return null;
  if ((current.sessionVersion ?? 0) !== (typeof sv === 'number' ? sv : 0)) return null;
  return current;
}
