/**
 * Enable Banking — background scheduler (in-process, single node).
 *
 * One idempotent `setInterval` ticks every ~30 min and runs any connection whose
 * disk-anchored `nextSyncDueAt` has passed. Because that cursor lives on disk, a
 * restart delays a sync by at most one tick (the backfill is callback-driven and
 * cursor-resumable). A per-account daily budget — keyed by the underlying
 * account's stable cross-user identity (`linkIdentityKey`), not the per-user
 * link id, so two household members' links onto the same joint account SHARE
 * one budget instead of doubling the bank's per-account fetch count — keeps a
 * safety margin under the bank's per-account limit so on-demand "Refresh now"
 * never gets starved. The per-connection lock + status handling live in the
 * sync engine, which also does the actual skip: any account another user's
 * sync (or our own) already refreshed recently enough (`isLinkFresh`) costs
 * zero bank calls this run, regardless of the budget check here.
 */

import type { BankConnection } from '@/types';
import { getAllUsers } from '@/lib/db/users';
import { getBankConnections } from '@/lib/db/bank-connections';
import { runSync } from './sync';
import { redactBankError } from './client';
import { linkIdentityKey, isLinkFresh } from './link-identity';
import {
  SCHEDULER_TICK_MS,
  SCHEDULED_SYNC_INTERVAL_MS,
  MAX_SCHEDULED_FETCHES_PER_DAY,
  isBankFeatureConfigured,
  isBankSyncVerbose,
} from './constants';

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

// Scheduled-fetch counter PER UNDERLYING ACCOUNT — keyed by `linkIdentityKey`
// (identificationHash/IBAN/link-id fallback), not the per-user link id, so two
// users' links onto the same joint account draw from one shared counter.
// Reset each UTC day; backstop on top of the `nextSyncDueAt` cadence so we
// never exceed the per-account allowance even if two users' schedules align.
const fetchesToday = new Map<string, { date: string; count: number }>();

function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function budgetRemaining(identityKey: string, now: number): number {
  const today = utcDate(now);
  const rec = fetchesToday.get(identityKey);
  if (!rec || rec.date !== today) return MAX_SCHEDULED_FETCHES_PER_DAY;
  return Math.max(0, MAX_SCHEDULED_FETCHES_PER_DAY - rec.count);
}

function recordFetch(identityKey: string, now: number): void {
  const today = utcDate(now);
  const rec = fetchesToday.get(identityKey);
  if (!rec || rec.date !== today) fetchesToday.set(identityKey, { date: today, count: 1 });
  else rec.count += 1;
}

/**
 * True when this account's own backfill is complete and it was refreshed
 * recently enough — by us or by a sibling user's fan-out (`sync.ts`) — that a
 * scheduled fetch can be skipped without drawing from the budget at all.
 */
function isAccountFresh(
  link: { syncCursor?: { backfilledThrough?: string }; lastSyncedAt?: string },
  now: number
): boolean {
  return (
    !!link.syncCursor?.backfilledThrough &&
    isLinkFresh(link.lastSyncedAt, now, SCHEDULED_SYNC_INTERVAL_MS, SCHEDULER_TICK_MS)
  );
}

export interface DueConnection {
  userId: string;
  connection: BankConnection;
}

/**
 * Pure ordering + budget-skip decision (no I/O), extracted for unit testing.
 * `due` is already filtered to `active` connections whose `nextSyncDueAt` has
 * passed. Returns them sorted least-recently-synced first — so iteration
 * order across users never systematically starves one household member — with
 * a connection dropped only when an account that still NEEDS a fetch (i.e.
 * isn't already fresh) has no budget left under `budgetRemainingFor`. A
 * connection whose accounts are ALL fresh stays runnable: `runSync` will
 * skip-fetch every account and just advance `nextSyncDueAt` (zero bank calls).
 */
export function orderRunnableConnections(
  due: DueConnection[],
  now: number,
  budgetRemainingFor: (identityKey: string) => number
): { runnable: DueConnection[]; budgetSkipped: DueConnection[] } {
  const sorted = [...due].sort((a, b) => {
    const aAt = a.connection.lastSyncAt ? Date.parse(a.connection.lastSyncAt) : -Infinity;
    const bAt = b.connection.lastSyncAt ? Date.parse(b.connection.lastSyncAt) : -Infinity;
    return aAt - bAt;
  });

  const runnable: DueConnection[] = [];
  const budgetSkipped: DueConnection[] = [];
  for (const entry of sorted) {
    const accounts = entry.connection.linkedAccounts.filter((l) => !l.isExcluded);
    if (accounts.length === 0) continue;
    const needsFetch = accounts.filter((l) => !isAccountFresh(l, now));
    const exhausted = needsFetch.some((l) => budgetRemainingFor(linkIdentityKey(l)) <= 0);
    if (exhausted) {
      budgetSkipped.push(entry);
      continue;
    }
    runnable.push(entry);
  }
  return { runnable, budgetSkipped };
}

async function tick(): Promise<void> {
  if (!isBankFeatureConfigured()) return;
  const now = Date.now();
  const verbose = isBankSyncVerbose();

  let users;
  try {
    users = await getAllUsers();
  } catch (err) {
    console.error('[bank-scheduler] user scan failed:', err);
    return;
  }

  // Per-tick visibility (verbose only): answers "why didn't it sync this tick?".
  let evaluated = 0;
  const skipped = { inactive: 0, notDue: 0, noAccounts: 0, budget: 0 };
  const due: DueConnection[] = [];

  for (const user of users) {
    let connections;
    try {
      connections = await getBankConnections(user.id);
    } catch {
      continue; // one user's read failing must not stop the others
    }

    for (const conn of connections) {
      evaluated++;
      if (conn.status !== 'active' || !conn.nextSyncDueAt) {
        skipped.inactive++;
        continue;
      }
      if (new Date(conn.nextSyncDueAt).getTime() > now) {
        skipped.notDue++;
        continue;
      }
      due.push({ userId: user.id, connection: conn });
    }
  }

  // Fairness: evaluate budget + run least-recently-synced connections first,
  // across ALL users — collecting the full due list before running any of
  // them prevents user-iteration order from systematically starving one
  // household member.
  const { runnable, budgetSkipped } = orderRunnableConnections(due, now, (key) =>
    budgetRemaining(key, now)
  );
  skipped.budget += budgetSkipped.length;
  skipped.noAccounts += due.length - runnable.length - budgetSkipped.length;

  let ran = 0;
  for (const { userId, connection: conn } of runnable) {
    ran++;
    try {
      const run = await runSync(userId, conn.id, 'scheduled', {}, now);
      // Record a budget draw only for accounts the run actually fetched from
      // the bank (not `skippedFresh`) — a fetch attempt that hit the bank
      // (even if it errored) still counts; a skip-fresh costs nothing.
      const fetchedIds = new Set(
        run.perAccount.filter((r) => !r.skippedFresh).map((r) => r.linkedAccountId)
      );
      for (const l of conn.linkedAccounts) {
        if (fetchedIds.has(l.id)) recordFetch(linkIdentityKey(l), now);
      }
    } catch (err) {
      // Per-connection isolation: one failure never breaks the loop.
      console.error('[bank-scheduler] sync failed:', redactBankError(err));
    }
  }

  if (verbose) {
    console.log(
      `[bank-scheduler] tick: ${evaluated} connection(s) evaluated, ${ran} run, skipped ` +
        `${skipped.notDue} not-due / ${skipped.inactive} inactive / ` +
        `${skipped.noAccounts} no-accounts / ${skipped.budget} budget-exhausted`
    );
  }
}

/** Start the scheduler once. No-op if already started or feature unconfigured. */
export function startBankScheduler(): void {
  if (started) return;
  if (!isBankFeatureConfigured()) {
    console.log('[bank-scheduler] Enable Banking not configured — scheduler idle');
    return;
  }
  started = true;
  timer = setInterval(() => {
    tick().catch((err) => console.error('[bank-scheduler] tick error:', err));
  }, SCHEDULER_TICK_MS);
  // A short delayed first tick so boot isn't blocked and disk is settled.
  setTimeout(() => {
    tick().catch(() => {});
  }, 15_000);
  console.log('[bank-scheduler] started');
}

export function stopBankScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
