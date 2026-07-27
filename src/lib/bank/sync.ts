/**
 * Enable Banking — sync engine (server-only).
 *
 * Pulls balances + transactions for a connection's accounts and writes them to
 * the local encrypted cache. Cache-first by contract: this is the ONLY place
 * (besides the consent callback) that touches the bank API. Per-account
 * try/catch isolation means one bank/account failing never breaks the others.
 * Writes are serialized per connection by an in-process lock (no file locking
 * exists). Idempotent: overlapping windows are absorbed by the dedup upsert.
 */

import { v4 as uuidv4 } from 'uuid';
import { updateTag } from 'next/cache';
import type {
  BankAccountLink,
  BankConnection,
  BankSyncRun,
  BankSyncRunAccountResult,
  BankSyncTrigger,
  BankTransaction,
} from '@/types';
import {
  getBankConnectionById,
  updateBankConnection,
  getBankSessionSecret,
  getBankConnections,
} from '@/lib/db/bank-connections';
import { getBankTransactions, writeBankTransactions } from '@/lib/db/bank-transactions';
import { appendBankSyncRun } from '@/lib/db/bank-sync-runs';
import { getAccountById } from '@/lib/db/accounts';
import { getAllUsers } from '@/lib/db/users';
import { getRecurringItems } from '@/lib/db/recurring-items';
import { getPlannedItems } from '@/lib/db/planned-items';
import { getTaxedIncomes } from '@/lib/db/taxed-income';
import { getLatestSnapshot, createBalanceSnapshot } from '@/lib/db/reconciliation';
import { calculateProjection, getCurrentYearMonth } from '@/lib/projection';
import {
  getAccountBalances,
  getAccountTransactions,
  getSession,
  BankApiError,
  redactBankError,
  describeBankError,
} from './client';
import { mapBalances, mapTransactions, mapSessionAccountHashes, type MappedBalance } from './mappers';
import { mergeTransactions } from './dedup';
import { repairDegenerateBookingDates } from './repair-booking-dates';
import { applyLinkBalances } from './apply-link-balances';
import { linkIdentityKey, isLinkFresh } from './link-identity';
import { nextConsecutiveSyncFailures } from '@/lib/bank-utils';
import {
  BACKFILL_DAYS,
  INCREMENTAL_OVERLAP_DAYS,
  PENDING_RECONCILE_LOOKBACK_DAYS,
  SCHEDULED_SYNC_INTERVAL_MS,
  SCHEDULER_TICK_MS,
  RATE_LIMIT_BACKOFF_MS,
  TRANSIENT_BACKOFF_MS,
  isBankSyncVerbose,
} from './constants';

// ---------- per-connection in-process lock ----------
const inFlight = new Map<string, Promise<BankSyncRun>>();

/**
 * True while a sync for this connection is running. Used by the cross-user
 * fan-out to skip a sibling whose OWN connection is concurrently syncing (the
 * in-process lock only serializes writes within one connection, not across
 * connections, so fan-out must check this explicitly to avoid a write race
 * with that sibling's own in-flight sync).
 */
export function isConnectionSyncInFlight(connectionId: string): boolean {
  return inFlight.has(connectionId);
}

// ---------- date helpers (UTC, YYYY-MM-DD) ----------
function todayYmd(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
function subDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Invalidate cache tags, tolerating a missing request scope (background tick). */
function safeUpdateTags(tags: string[]): void {
  for (const tag of tags) {
    try {
      updateTag(tag);
    } catch {
      // No request scope (scheduler tick) — `updateTag` throws and is swallowed.
      // The 'use cache' store can't be invalidated here; the bank/snapshot reads
      // use the bounded 'synced' cacheLife profile so the UI still catches up to
      // disk within minutes (see next.config.ts). A request-scoped mutation /
      // "Refresh now" still revalidates instantly via these tags.
    }
  }
}

/**
 * One concise, PII-free line per completed run (ALWAYS) so "is sync running and
 * succeeding?" is answerable from the logs at a glance — this subsystem used to
 * log only failures, which made a working sync look like an outage. Under the
 * verbose flag, also emit per-account detail (role, window, tx counts).
 */
function logSyncSummary(
  connection: BankConnection,
  run: BankSyncRun,
  nextSyncDueAt: string | undefined
): void {
  const totalAdded = run.perAccount.reduce((s, r) => s + r.txAdded, 0);
  const totalUpdated = run.perAccount.reduce((s, r) => s + r.txUpdated, 0);
  const totalRemoved = run.perAccount.reduce((s, r) => s + (r.txRemoved ?? 0), 0);
  const errs = run.perAccount.filter((r) => r.error).map((r) => r.error);
  console.log(
    `[bank-sync] ${connection.aspspName} ${run.trigger} → ${run.status} | ` +
      `${run.perAccount.length} acct(s) +${totalAdded}/~${totalUpdated}${totalRemoved ? `/-${totalRemoved}` : ''} tx | ` +
      `next ${nextSyncDueAt ?? 'paused (reconnect needed)'}` +
      (errs.length ? ` | errors: ${errs.join(', ')}` : '')
  );
  if (isBankSyncVerbose()) {
    const roleById = new Map(connection.linkedAccounts.map((l) => [l.id, l.accountRole]));
    for (const r of run.perAccount) {
      console.log(
        `[bank-sync]   ${roleById.get(r.linkedAccountId) ?? 'acct'} bal=${r.balanceFetched} ` +
          `+${r.txAdded}/~${r.txUpdated}/-${r.txRemoved ?? 0} range=${r.fromDate}..${r.toDate}` +
          (r.error ? ` ERR=${r.error}` : '')
      );
    }
  }
}

export interface SyncOptions {
  psuIp?: string; // present ⇒ PSU-IP-Address sent (higher rate allowance)
}

/** Run a sync for one connection, serialized per connection. */
export function runSync(
  userId: string,
  connectionId: string,
  trigger: BankSyncTrigger,
  opts: SyncOptions = {},
  now: number = Date.now()
): Promise<BankSyncRun> {
  const existing = inFlight.get(connectionId);
  if (existing) return existing;
  const promise = doRunSync(userId, connectionId, trigger, opts, now).finally(() => {
    inFlight.delete(connectionId);
  });
  inFlight.set(connectionId, promise);
  return promise;
}

async function doRunSync(
  userId: string,
  connectionId: string,
  trigger: BankSyncTrigger,
  opts: SyncOptions,
  now: number
): Promise<BankSyncRun> {
  const nowIso = new Date(now).toISOString();
  const run: BankSyncRun = {
    id: uuidv4(),
    connectionId,
    trigger,
    startedAt: nowIso,
    status: 'ok',
    perAccount: [],
    psuPresent: !!opts.psuIp,
  };

  const connection = await getBankConnectionById(userId, connectionId);
  if (!connection) {
    run.status = 'error';
    run.error = 'NOT_FOUND';
    run.finishedAt = new Date().toISOString();
    console.error(`[bank-sync] ${trigger} aborted: connection ${connectionId} not found`);
    return run;
  }

  if (connection.status === 'expired' || connection.status === 'revoked') {
    run.status = 'error';
    run.error = 'EXPIRED_SESSION';
    run.finishedAt = new Date().toISOString();
    await appendBankSyncRun(userId, connectionId, run);
    console.log(
      `[bank-sync] ${connection.aspspName} ${trigger} → skipped (${connection.status}; reconnect needed)`
    );
    return run;
  }

  const secret = await getBankSessionSecret(userId, connectionId);
  if (!secret?.sessionId) {
    run.status = 'error';
    run.error = 'NO_SESSION';
    run.finishedAt = new Date().toISOString();
    await appendBankSyncRun(userId, connectionId, run);
    console.warn(`[bank-sync] ${connection.aspspName} ${trigger} → no stored session secret`);
    return run;
  }

  const accounts = connection.linkedAccounts.filter((l) => !l.isExcluded);
  const today = todayYmd(now);

  let anyExpired = false;
  let anyRateLimited = false;
  let anyTransient = false;
  let anySuccess = false;
  const touchedTags = new Set<string>();
  const updatedLinks: BankAccountLink[] = [...connection.linkedAccounts];

  // ---- one-time identification_hash backfill ----
  // Links created before we started capturing `identification_hash` only have
  // an `accountUid`. Backfill the stable hash from the live session's account
  // list so a future re-consent can match this account even if it has no IBAN
  // and its uid rotates (e.g. a credit card). Guarded so steady state (every
  // link already hashed) costs zero extra API calls; a failure here never
  // blocks the sync — it just retries next run.
  if (accounts.some((l) => l.accountUid && !l.identificationHash)) {
    try {
      const rawSession = await getSession(secret.sessionId);
      const hashByUid = new Map(
        mapSessionAccountHashes(rawSession).map((h) => [h.uid, h.identificationHash])
      );
      for (let i = 0; i < updatedLinks.length; i++) {
        const hash = hashByUid.get(updatedLinks[i].accountUid);
        if (hash && !updatedLinks[i].identificationHash) {
          updatedLinks[i] = { ...updatedLinks[i], identificationHash: hash };
        }
      }
    } catch (err) {
      console.warn(`[bank-sync] identification_hash backfill skipped: ${redactBankError(err)}`);
    }
  }

  // ---- cross-user fan-out: lazily scan all users' connections, once per run ----
  // Only populated the first time a fetched link with a stable identity needs
  // to look for siblings — a run with no such link (nothing shared, or all
  // fetches skip-fresh) never touches this.
  let siblingScanPromise: Promise<{ userId: string; connection: BankConnection }[]> | null = null;
  function getAllUserConnectionsOnce(): Promise<{ userId: string; connection: BankConnection }[]> {
    if (!siblingScanPromise) {
      siblingScanPromise = (async () => {
        const users = await getAllUsers();
        const lists = await Promise.all(
          users.map(async (u) => {
            const conns = await getBankConnections(u.id);
            return conns.map((c) => ({ userId: u.id, connection: c }));
          })
        );
        return lists.flat();
      })();
    }
    return siblingScanPromise;
  }

  /**
   * Fan the just-fetched raw data out to every OTHER user's link on the same
   * underlying account (matched by `linkIdentityKey`) so their sync can skip
   * re-fetching it this cycle. Applies on both scheduled and manual runs.
   * Never throws — a fan-out problem must never fail the PRIMARY sync; every
   * failure is caught and logged (PII-free) at the narrowest scope it occurs.
   */
  async function fanOutToSiblings(params: {
    primaryLink: BankAccountLink;
    incoming: BankTransaction[];
    balances: MappedBalance[];
    fromDate: string;
    toDate: string;
  }): Promise<void> {
    const identityKey = linkIdentityKey(params.primaryLink);
    let all: { userId: string; connection: BankConnection }[];
    try {
      all = await getAllUserConnectionsOnce();
    } catch (err) {
      console.error('[bank-sync] fan-out sibling scan failed:', redactBankError(err));
      return;
    }

    for (const { userId: siblingUserId, connection: siblingConn } of all) {
      // Siblings live on a DIFFERENT connection (any user) — never ourselves.
      if (siblingConn.id === connectionId) continue;
      // Avoid a write race with that connection's own concurrent sync.
      if (isConnectionSyncInFlight(siblingConn.id)) continue;

      const matches = siblingConn.linkedAccounts
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => !l.isExcluded && linkIdentityKey(l) === identityKey);
      if (matches.length === 0) continue;

      const updatedSiblingLinks = [...siblingConn.linkedAccounts];
      const siblingTags = new Set<string>();

      for (const { l: siblingLink, i } of matches) {
        try {
          // Self-heal the sibling's stored ledger too (same OP collapse), so
          // its persisted rows carry the corrected bookingDate after the merge.
          const { rows: existing } = repairDegenerateBookingDates(
            await getBankTransactions(siblingUserId, siblingLink.id)
          );
          // Reuse the already-mapped rows (no re-parsing raw API JSON); only
          // the foreign key differs per sibling's own storage file.
          const siblingIncoming = params.incoming.map((t) => ({
            ...t,
            linkedAccountId: siblingLink.id,
          }));
          const { merged } = mergeTransactions(existing, siblingIncoming, nowIso, {
            fromDate: params.fromDate,
            toDate: params.toDate,
          });
          await writeBankTransactions(siblingUserId, siblingLink.id, merged);
          siblingTags.add(`user:${siblingUserId}:bank-account:${siblingLink.id}:transactions`);

          const applied = applyLinkBalances(siblingLink, params.balances, nowIso);
          updatedSiblingLinks[i] = {
            ...siblingLink,
            lastBalance: applied.lastBalance,
            lastBalanceType: applied.lastBalanceType,
            lastBalanceAt: applied.lastBalanceAt,
            outstanding: applied.outstanding,
            availableCredit: applied.availableCredit,
            creditLimit: applied.creditLimit,
            syncCursor: {
              lastBookingDate: merged[0]?.bookingDate ?? siblingLink.syncCursor?.lastBookingDate,
              lastSeenEntryRefs: merged.slice(0, 25).map((t) => t.dedupKey),
              // Preserved untouched: the sibling's own deep backfill (if still
              // pending) must still run on their own session, not be marked
              // done by a fan-out that only carried the primary's window.
              backfilledThrough: siblingLink.syncCursor?.backfilledThrough,
            },
            lastSyncedAt: nowIso,
          };

          if (
            applied.anchorBalanceAmount != null &&
            (siblingLink.accountRole === 'cash' || siblingLink.accountRole === 'savings') &&
            siblingLink.linkedFinancialAccountId
          ) {
            const anchored = await autoAnchorAccount(
              siblingUserId,
              siblingLink.linkedFinancialAccountId,
              applied.anchorBalanceAmount
            );
            if (anchored) siblingTags.add(`user:${siblingUserId}:reconciliation`);
          }
        } catch (err) {
          console.error(
            `[bank-sync] fan-out to sibling link failed (${siblingConn.aspspName}/${siblingLink.accountRole}):`,
            redactBankError(err)
          );
        }
      }

      try {
        await updateBankConnection(siblingUserId, siblingConn.id, {
          linkedAccounts: updatedSiblingLinks,
        });
        // Keep the memoized scan current: a later account in this same run can
        // fan out to another link on this SAME sibling connection, and its
        // read-modify-write must build on these updates, not the stale scan
        // snapshot (which would clobber them on disk).
        siblingConn.linkedAccounts = updatedSiblingLinks;
        siblingTags.add(`user:${siblingUserId}:bank-connections`);
        siblingTags.add(`user:${siblingUserId}:bank-connection:${siblingConn.id}`);
        safeUpdateTags([...siblingTags]);
      } catch (err) {
        console.error('[bank-sync] fan-out connection persist failed:', redactBankError(err));
      }
    }
  }

  for (const link of accounts) {
    const result: BankSyncRunAccountResult = {
      linkedAccountId: link.id,
      balanceFetched: false,
      txAdded: 0,
      txUpdated: 0,
    };

    const idx = updatedLinks.findIndex((l) => l.id === link.id);
    const current = idx >= 0 ? updatedLinks[idx] : link;
    const hasStableIdentity = !!(current.identificationHash || current.iban);
    const backfillComplete = !!current.syncCursor?.backfilledThrough;

    // ---- skip-fetch: another user's sync (or our own) already refreshed this
    // exact account recently enough — 0 bank calls. Scheduled runs only: a
    // manual "Refresh now" always asks the bank (the user explicitly requested
    // fresh data, and attended calls are exempt from the rate limit anyway).
    // Never skip a link still mid-backfill — deep history is session-specific.
    if (
      trigger === 'scheduled' &&
      hasStableIdentity &&
      backfillComplete &&
      isLinkFresh(current.lastSyncedAt, now, SCHEDULED_SYNC_INTERVAL_MS, SCHEDULER_TICK_MS)
    ) {
      result.skippedFresh = true;
      run.perAccount.push(result);
      continue;
    }

    let phase: 'transactions' | 'balances' = 'transactions';
    try {
      // Self-heal any historical rows whose bookingDate collapsed onto the sync
      // day (OP: no booking/value date). The repaired rows flow into the merge
      // below and are persisted, so the fix sticks on this run.
      const { rows: prior } = repairDegenerateBookingDates(
        await getBankTransactions(userId, link.id)
      );
      const isBackfill = !link.syncCursor?.backfilledThrough;
      let fromDate = isBackfill
        ? subDaysYmd(today, BACKFILL_DAYS)
        : subDaysYmd(link.syncCursor?.lastBookingDate ?? today, INCREMENTAL_OVERLAP_DAYS);

      // Stretch an incremental window back to re-cover any stored pending row so
      // it gets reconciled (confirmed or pruned) even when it settled slower than
      // the small overlap — a card hold can take weeks. Bounded by the lookback
      // so one stuck pending can't push the fetch past what the bank serves.
      if (!isBackfill) {
        const pendingFloor = subDaysYmd(today, PENDING_RECONCILE_LOOKBACK_DAYS);
        for (const t of prior) {
          if (t.status === 'pending' && t.bookingDate < fromDate && t.bookingDate >= pendingFloor) {
            fromDate = t.bookingDate;
          }
        }
      }
      result.fromDate = fromDate;
      result.toDate = today;

      // --- transactions (paginated) ---
      const incoming: BankTransaction[] = [];
      let continuationKey: string | undefined;
      let guard = 0;
      do {
        const raw = await getAccountTransactions(
          link.accountUid,
          {
            dateFrom: fromDate,
            dateTo: today,
            continuationKey,
            strategy: isBackfill ? 'longest' : 'default',
          },
          opts.psuIp
        );
        const mapped = mapTransactions(raw, link.id, nowIso, () => uuidv4());
        incoming.push(...mapped.transactions);
        continuationKey = mapped.continuationKey;
      } while (continuationKey && ++guard < 50);

      // Reconcile against the fetched window: absorb overlap AND prune stale
      // pendings the bank no longer reports in [fromDate, today].
      const { merged, added, updated, removed } = mergeTransactions(prior, incoming, nowIso, {
        fromDate,
        toDate: today,
      });
      await writeBankTransactions(userId, link.id, merged);
      result.txAdded = added;
      result.txUpdated = updated;
      result.txRemoved = removed;
      touchedTags.add(`user:${userId}:bank-account:${link.id}:transactions`);

      // --- balances ---
      phase = 'balances';
      const rawBal = await getAccountBalances(link.accountUid, opts.psuIp);
      const balances = mapBalances(rawBal);

      const newCursor = {
        lastBookingDate: merged[0]?.bookingDate ?? link.syncCursor?.lastBookingDate,
        lastSeenEntryRefs: merged.slice(0, 25).map((t) => t.dedupKey),
        backfilledThrough: isBackfill ? today : link.syncCursor?.backfilledThrough ?? today,
      };

      const applied = applyLinkBalances(current, balances, nowIso);
      result.balanceFetched = applied.balanceFound;

      if (idx >= 0) {
        updatedLinks[idx] = {
          ...updatedLinks[idx],
          lastBalance: applied.lastBalance,
          lastBalanceType: applied.lastBalanceType,
          lastBalanceAt: applied.lastBalanceAt,
          outstanding: applied.outstanding,
          availableCredit: applied.availableCredit,
          creditLimit: applied.creditLimit,
          syncCursor: newCursor,
          lastSyncedAt: nowIso,
        };
      }

      // --- auto-anchor (keystone): cash/savings balance → BalanceSnapshot ---
      if (
        applied.anchorBalanceAmount != null &&
        (link.accountRole === 'cash' || link.accountRole === 'savings') &&
        link.linkedFinancialAccountId
      ) {
        const anchored = await autoAnchorAccount(
          userId,
          link.linkedFinancialAccountId,
          applied.anchorBalanceAmount
        );
        if (anchored) touchedTags.add(`user:${userId}:reconciliation`);
      }

      anySuccess = true;

      // --- cross-user fan-out: propagate this fetch to every sibling link on
      // the same underlying account (see fanOutToSiblings doc comment). Only
      // possible when this account has a stable cross-user identity; a
      // failure here is fully isolated and never fails this primary sync.
      if (hasStableIdentity) {
        try {
          await fanOutToSiblings({
            primaryLink: current,
            incoming,
            balances,
            fromDate,
            toDate: today,
          });
        } catch (err) {
          console.error('[bank-sync] fan-out failed:', redactBankError(err));
        }
      }
    } catch (err) {
      result.error = redactBankError(err);
      if (err instanceof BankApiError) {
        if (err.code === 'EXPIRED_SESSION') anyExpired = true;
        else if (err.code === 'RATE_LIMITED') {
          anyRateLimited = true;
          result.rateLimited = true;
        } else if (err.code === 'TRANSIENT' || err.code === 'BAD_RESPONSE') {
          anyTransient = true;
        }
      } else {
        anyTransient = true;
      }
      // No mutation on a failed fetch beyond recording the error. `result.error`
      // stays PII-free (code only); the verbose form additionally surfaces the
      // API `detail` body so an opaque `UNKNOWN (400)` becomes diagnosable.
      console.error(
        `[bank-sync] account fetch failed (${connection.aspspName}/${link.accountRole} ${phase}):`,
        isBankSyncVerbose() ? describeBankError(err) : result.error
      );
    }

    run.perAccount.push(result);
  }

  // ---- aggregate status + next-due scheduling ----
  const failed = run.perAccount.filter((r) => r.error).length;
  run.status = failed === 0 ? 'ok' : anySuccess ? 'partial' : 'error';
  run.finishedAt = new Date().toISOString();

  let nextSyncDueAt: string | undefined;
  if (anyExpired) {
    nextSyncDueAt = undefined; // stop until reconnect
  } else if (anyRateLimited) {
    nextSyncDueAt = new Date(now + RATE_LIMIT_BACKOFF_MS).toISOString();
  } else if (anyTransient) {
    nextSyncDueAt = new Date(now + TRANSIENT_BACKOFF_MS).toISOString();
  } else {
    nextSyncDueAt = new Date(now + SCHEDULED_SYNC_INTERVAL_MS).toISOString();
  }

  const connUpdate: Partial<Omit<BankConnection, 'id' | 'userId' | 'createdAt'>> = {
    linkedAccounts: updatedLinks,
    lastSyncAt: nowIso,
    lastSyncStatus: run.status,
    lastError: run.perAccount.find((r) => r.error)?.error,
    nextSyncDueAt,
    // Streak of non-ok runs — drives the Overview "keeps failing" banner. Reset
    // on a clean sync so a one-off transient (e.g. a single 400) never alarms.
    // Status stays 'active' on a non-expiry failure so the scheduler keeps
    // retrying; only an expired consent pauses it (handled below).
    consecutiveSyncFailures: nextConsecutiveSyncFailures(
      connection.consecutiveSyncFailures,
      run.status
    ),
  };
  if (anyExpired) connUpdate.status = 'expired';

  await updateBankConnection(userId, connectionId, connUpdate);
  await appendBankSyncRun(userId, connectionId, run);

  touchedTags.add(`user:${userId}:bank-connections`);
  touchedTags.add(`user:${userId}:bank-connection:${connectionId}`);
  touchedTags.add(`user:${userId}:bank-connection:${connectionId}:runs`);
  safeUpdateTags([...touchedTags]);

  logSyncSummary(connection, run, nextSyncDueAt);

  return run;
}

/**
 * Write a `source:'bank-sync'` BalanceSnapshot for the current month so the
 * forecast re-anchors on the real balance via `resolveAnchor`. Snapshots are
 * last-write-wins per entity/month: this overwrites a same-month manual
 * reconciliation (and a later manual reconciliation overwrites this until the
 * next sync). Only the CURRENT month is ever written, so historical manual
 * reconciliations are never touched. Returns true when a snapshot was written.
 */
async function autoAnchorAccount(
  userId: string,
  financialAccountId: string,
  actualBalance: number
): Promise<boolean> {
  const account = await getAccountById(userId, financialAccountId);
  if (!account) return false;

  const currentMonth = getCurrentYearMonth();

  // Baseline projection (anchored on the latest EXISTING snapshot) to estimate
  // what the system expected for the current month → variance for the record.
  const [recurringItems, plannedItems, taxedIncomes, priorSnapshot] = await Promise.all([
    getRecurringItems(userId, financialAccountId),
    getPlannedItems(userId, financialAccountId),
    getTaxedIncomes(userId, financialAccountId),
    getLatestSnapshot(userId, 'cash-account', financialAccountId),
  ]);
  const monthly = calculateProjection(
    account,
    recurringItems,
    plannedItems,
    taxedIncomes,
    undefined,
    priorSnapshot
  );
  const row = monthly.find((m) => m.yearMonth === currentMonth);
  const expected = row?.endingBalance ?? priorSnapshot?.actualBalance ?? account.startingBalance;

  const snapshot = await createBalanceSnapshot(
    userId,
    'cash-account',
    financialAccountId,
    currentMonth,
    expected,
    actualBalance,
    'bank-sync'
  );
  return snapshot.source === 'bank-sync';
}
