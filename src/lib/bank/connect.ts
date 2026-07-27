/**
 * Enable Banking — consent orchestration (server-only, shared by the server
 * action that starts a connection and the OAuth callback route that finishes it).
 *
 * Layer B (bank consent): PSD2 forbids silent renewal, so the user must complete
 * SCA. "begin" creates a pending connection + a single-use `state` and returns
 * the bank's auth URL; "complete" verifies that `state`, exchanges the code for a
 * session, maps accounts (re-using stable link ids across re-consent), and marks
 * the connection active. The live session_id is stored in a separate, uncached,
 * never-logged secret file.
 */

import * as crypto from 'crypto';
import { updateTag } from 'next/cache';
import type { BankConnection } from '@/types';
import {
  createBankConnection,
  updateBankConnection,
  getBankConnectionById,
  writeBankSessionSecret,
  findConnectionByState,
} from '@/lib/db/bank-connections';
import { startAuthorization, createSession } from './client';
import { mapSessionAccounts } from './mappers';
import { reconcileLinks } from './reconcile-links';
import { sessionResponseSchema } from '@/lib/schemas/bank.schema';
import { getBankConfig, CONSENT_REQUESTED_VALIDITY_DAYS } from './constants';
import { runSync } from './sync';

const MS_PER_DAY = 86_400_000;

function invalidate(userId: string, connectionId: string): void {
  // `updateTag` works in server actions but can throw in a GET route handler
  // (the consent callback's context). Tolerate that so a tag-revalidation
  // failure never aborts the flow before the initial backfill runs — the cache
  // still revalidates on the next request-scoped mutation / "Refresh now".
  for (const tag of [
    `user:${userId}:bank-connections`,
    `user:${userId}:bank-connection:${connectionId}`,
    `user:${userId}:accounts`,
  ]) {
    try {
      updateTag(tag);
    } catch {
      // ignore — see comment above
    }
  }
}

/**
 * Begin a bank connection: create a pending BankConnection, mint a single-use
 * CSRF `state`, request authorization, and return the bank's SCA URL.
 */
export async function beginConnection(
  userId: string,
  aspspName: string,
  aspspCountry: string
): Promise<{ authUrl: string; connectionId: string }> {
  const config = getBankConfig();
  if (!config) throw new Error('Enable Banking is not configured');

  const connection = await createBankConnection(userId, {
    aspspName,
    aspspCountry,
    applicationId: config.appId,
    status: 'pending',
  });

  const state = crypto.randomBytes(32).toString('hex');
  const validUntilIso = new Date(
    Date.now() + CONSENT_REQUESTED_VALIDITY_DAYS * MS_PER_DAY
  ).toISOString();

  const { url, authorization_id } = await startAuthorization({
    aspspName,
    aspspCountry,
    state,
    redirectUrl: config.redirectUrl,
    validUntilIso,
    language: 'en',
  });

  await writeBankSessionSecret(userId, {
    connectionId: connection.id,
    state,
    authorizationId: authorization_id,
    createdAt: new Date().toISOString(),
  });

  invalidate(userId, connection.id);
  return { authUrl: url, connectionId: connection.id };
}

/**
 * Renew an existing connection's consent (PSD2 requires a fresh SCA ~every 180
 * days). Reuses the SAME connection id + a fresh single-use state, so the
 * callback's `completeConnection` re-matches accounts and preserves every stable
 * link id + the user's config (role, linked account, custom name, card cycle).
 * `reconcileLinks` also clears the backfill marker, so the post-SCA sync re-runs a
 * full deep backfill within the fresh-consent window — deepening history for an
 * already-connected account (see `reconcile-links.ts`).
 */
export async function beginReconnect(
  userId: string,
  connectionId: string
): Promise<{ authUrl: string; connectionId: string }> {
  const config = getBankConfig();
  if (!config) throw new Error('Enable Banking is not configured');

  const connection = await getBankConnectionById(userId, connectionId);
  if (!connection) throw new Error('Connection not found');

  const state = crypto.randomBytes(32).toString('hex');
  const validUntilIso = new Date(
    Date.now() + CONSENT_REQUESTED_VALIDITY_DAYS * MS_PER_DAY
  ).toISOString();

  const { url, authorization_id } = await startAuthorization({
    aspspName: connection.aspspName,
    aspspCountry: connection.aspspCountry,
    state,
    redirectUrl: config.redirectUrl,
    validUntilIso,
    language: 'en',
  });

  await writeBankSessionSecret(userId, {
    connectionId: connection.id,
    state,
    authorizationId: authorization_id,
    createdAt: new Date().toISOString(),
  });

  invalidate(userId, connection.id);
  return { authUrl: url, connectionId: connection.id };
}

/**
 * Complete a bank connection from the callback: verify the single-use `state`
 * for this user, exchange the code for a session, map accounts, mark active.
 * Returns the connection, or null when the state doesn't match (CSRF / replay).
 */
export async function completeConnection(
  userId: string,
  code: string,
  state: string,
  psuIp?: string
): Promise<{ connection: BankConnection } | null> {
  const match = await findConnectionByState(userId, state);
  if (!match) return null; // unknown/replayed state — reject

  const { connection, secret } = match;

  const raw = await createSession(code);
  const parsed = sessionResponseSchema.safeParse(raw);
  if (!parsed.success) {
    await updateBankConnection(userId, connection.id, {
      status: 'error',
      lastError: 'BAD_RESPONSE',
    });
    invalidate(userId, connection.id);
    return { connection };
  }

  const sessionId = parsed.data.session_id;
  const mapped = mapSessionAccounts(raw);
  const linkedAccounts = reconcileLinks(connection.linkedAccounts, mapped, connection.id);

  const now = new Date().toISOString();
  const consentExpiresAt =
    parsed.data.access?.valid_until ??
    new Date(Date.now() + CONSENT_REQUESTED_VALIDITY_DAYS * MS_PER_DAY).toISOString();

  // Persist the live session_id and burn the single-use state (so the same
  // callback can't be replayed). Keep authorizationId for reference.
  await writeBankSessionSecret(userId, {
    connectionId: connection.id,
    state: crypto.randomBytes(16).toString('hex'), // rotate → old state no longer valid
    authorizationId: secret.authorizationId,
    sessionId,
    createdAt: secret.createdAt,
  });

  const updated = await updateBankConnection(userId, connection.id, {
    status: 'active',
    linkedAccounts,
    consentGrantedAt: now,
    consentExpiresAt,
    nextSyncDueAt: now, // sync as soon as possible (backfill runs next)
    lastError: undefined,
  });

  invalidate(userId, connection.id);

  // Run the backfill synchronously within the callback request so the user lands
  // on settings with data already present. On a first connect this is the deep
  // ~24-month backfill; on a renewal `reconcileLinks` has cleared the backfill
  // marker so it re-runs the deep backfill too (we're inside the fresh-session
  // window). The PSU is right here, so pass their IP for the higher rate
  // allowance. A backfill failure must never fail the consent itself — the
  // scheduler/Refresh-now will retry.
  try {
    await runSync(userId, connection.id, 'callback-backfill', { psuIp });
  } catch (err) {
    console.error('[bank] backfill after consent failed:', err);
  }

  invalidate(userId, connection.id);
  return { connection: updated ?? connection };
}
