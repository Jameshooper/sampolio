/**
 * Enable Banking — pure transaction dedup / merge (no I/O, fully testable).
 *
 * Dedup key: a row's `entry_reference` when the bank supplies one (booked and
 * pending alike — EB only returns it for a pending row when it survives booking
 * unchanged); otherwise a deterministic synthetic key derived from the row's
 * content. The merge is idempotent — re-fetching an overlapping window never
 * duplicates rows — and promotes a pending row to its booked counterpart three
 * ways, strongest first:
 *
 *  1. same key (a stable reference, or identical content) → refresh in place;
 *  2. exact synthetic: a booked row whose content hashes to a stored pending's
 *     synthetic key;
 *  3. fuzzy: a booked row with the same amount + currency within a few days of a
 *     stored pending, when the bank rewrote the row's identity on booking (new
 *     reference AND new counterparty text). Bounded by
 *     PENDING_BOOKING_MATCH_MAX_{LAG,LEAD}_DAYS, one-to-one, and never allowed
 *     to consume a pending the same fetch still reports.
 *
 * Identity continuity matters beyond cosmetics: `SplitExpenseBankLink.txId`
 * references `BankTransaction.id`, so every promotion/refresh path preserves the
 * stored row's `id` (a fetch mints a fresh uuid for every mapped row).
 *
 * The structured `referenceNumber`/`referenceNumberSchema` are display-only: they
 * are deliberately OUTSIDE the key (a row that gains or loses one must not split
 * into two), and every merge path coalesces them like the dates, so a later fetch
 * that omits them never wipes what the bank told us once.
 *
 * Even so a pending row can strand — the booked twin may fall outside the fuzzy
 * bounds, or the pending may simply have been cancelled. To stop those phantoms
 * accumulating, pass the fetched `window` to `mergeTransactions`: a fetch returns
 * the bank's authoritative view of that date range, so any stored PENDING row
 * inside it the fetch did not corroborate is pruned. Booked rows and rows outside
 * the window are never touched. Pass NO window when the fetch asked for booked
 * rows only — it says nothing about pendings and must not prune them.
 */

import type { BankTransaction } from '@/types';

/** A booked row may be dated up to this many days AFTER its pending twin. */
export const PENDING_BOOKING_MATCH_MAX_LAG_DAYS = 7;
/** A pending row may be dated at most this many days AFTER its booked twin. */
export const PENDING_BOOKING_MATCH_MAX_LEAD_DAYS = 1;

/** Fields that identify a transaction's content for synthetic keying. */
type TxContent = Pick<
  BankTransaction,
  'amount' | 'currency' | 'counterpartyName' | 'remittanceInfo' | 'valueDate'
>;

/**
 * Collapse internal whitespace + case so text compares stably regardless of how
 * the bank joined remittance lines (spaces vs newlines).
 */
function norm(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Shift a 'YYYY-MM-DD' (or ISO datetime) by whole days, UTC-safe. */
function shiftYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Signed whole-day distance from `b` to `a` (both 'YYYY-MM-DD' or ISO). */
function dayDiff(a: string, b: string): number {
  const ms =
    Date.parse(`${a.slice(0, 10)}T00:00:00.000Z`) - Date.parse(`${b.slice(0, 10)}T00:00:00.000Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * Weak "same merchant" signal for fuzzy promotion: banks commonly decorate the
 * counterparty on booking ("MERCHANT X" → "UNKNOWN*MERCHANT X", or truncate it),
 * so a prefix relation or a shared first token is as much as can be required.
 * A preference only — never a precondition for a match.
 */
function nameAffinity(a: string | undefined, b: string | undefined): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x.startsWith(y) || y.startsWith(x)) return true;
  return x.split(' ')[0] === y.split(' ')[0];
}

/**
 * Deterministic synthetic dedup key for a pending / reference-less transaction.
 * Excludes booking date (pending rows often lack it) so a later booked row with
 * the same content can be recognized as the same underlying transaction.
 */
export function syntheticDedupKey(t: TxContent): string {
  const basis = [
    t.amount.toFixed(2),
    t.currency,
    norm(t.counterpartyName),
    norm(t.remittanceInfo),
    t.valueDate ?? '',
  ].join('|');

  // djb2 (xor variant) — small, stable, dependency-free.
  let h = 5381;
  for (let i = 0; i < basis.length; i++) {
    h = ((h << 5) + h) ^ basis.charCodeAt(i);
    h |= 0;
  }
  return `syn:${(h >>> 0).toString(16)}`;
}

export interface MergeResult {
  merged: BankTransaction[];
  added: number;
  updated: number;
  removed: number; // stale in-window pending rows pruned (0 when no window given)
}

/** The date range a fetch covered — inclusive 'YYYY-MM-DD' bounds. */
export interface FetchWindow {
  fromDate: string;
  toDate: string;
}

/**
 * Best stored PENDING row a booked `inc` may have been booked from, or undefined.
 * Ranked: name affinity first, then nearest booking date, then dedupKey for a
 * deterministic tie-break. `incomingKeys` are the keys this same fetch reported —
 * such a pending is still live per the bank and must never be consumed here.
 */
function bestFuzzyPendingMatch(
  byKey: Map<string, BankTransaction>,
  inc: BankTransaction,
  incomingKeys: Set<string>
): BankTransaction | undefined {
  const earliest = shiftYmd(inc.bookingDate, -PENDING_BOOKING_MATCH_MAX_LAG_DAYS);
  const latest = shiftYmd(inc.bookingDate, PENDING_BOOKING_MATCH_MAX_LEAD_DAYS);
  const candidates: { t: BankTransaction; affinity: boolean; distance: number }[] = [];

  for (const t of byKey.values()) {
    if (t.status !== 'pending') continue;
    if (incomingKeys.has(t.dedupKey)) continue;
    if (t.currency !== inc.currency) continue;
    if (t.amount.toFixed(2) !== inc.amount.toFixed(2)) continue;
    const day = t.bookingDate.slice(0, 10);
    if (day < earliest || day > latest) continue;
    candidates.push({
      t,
      affinity: nameAffinity(t.counterpartyName, inc.counterpartyName),
      distance: Math.abs(dayDiff(day, inc.bookingDate)),
    });
  }

  candidates.sort(
    (a, b) =>
      (a.affinity === b.affinity ? 0 : a.affinity ? -1 : 1) ||
      a.distance - b.distance ||
      a.t.dedupKey.localeCompare(b.t.dedupKey)
  );
  return candidates[0]?.t;
}

/**
 * Merge `incoming` rows into `existing`, deduping by `dedupKey` and promoting
 * pending → booked (see the module doc for the three promotion paths). `nowIso`
 * stamps `lastSeenAt` (and `firstSeenAt` for new rows). When `window` is given,
 * stale PENDING rows inside that fetched range — ones this fetch did not return —
 * are pruned. The result is sorted newest-first by booking date.
 */
export function mergeTransactions(
  existing: BankTransaction[],
  incoming: BankTransaction[],
  nowIso: string,
  window?: FetchWindow
): MergeResult {
  const byKey = new Map<string, BankTransaction>();
  for (const t of existing) byKey.set(t.dedupKey, t);

  let added = 0;
  let updated = 0;
  let removed = 0;

  // dedupKeys currently in `byKey` that this fetch corroborated (added, updated,
  // or promoted-into). Everything else that's pending + in-window is stale.
  const confirmed = new Set<string>();
  const incomingKeys = new Set(incoming.map((t) => t.dedupKey));

  for (const inc of incoming) {
    const prior = byKey.get(inc.dedupKey);
    if (prior) {
      // Never downgrade booked → pending: while a booking is in flight the bank
      // can report the same reference in BOTH the booked and the PDNG response
      // of one run, and the booked pages precede the appended PDNG rows, so
      // without this the status and bookingDate would regress every other run.
      if (prior.status === 'booked' && inc.status === 'pending') {
        byKey.set(inc.dedupKey, { ...prior, lastSeenAt: nowIso });
        confirmed.add(inc.dedupKey);
        updated++;
        continue;
      }
      // Same identity → refresh fields, preserving the stored id/firstSeenAt and
      // any date or reference the incoming row omits (the mapper always sets those
      // keys, so a bare spread would wipe them with undefined).
      byKey.set(inc.dedupKey, {
        ...prior,
        ...inc,
        id: prior.id,
        firstSeenAt: prior.firstSeenAt,
        lastSeenAt: nowIso,
        transactionDate: inc.transactionDate ?? prior.transactionDate,
        valueDate: inc.valueDate ?? prior.valueDate,
        referenceNumber: inc.referenceNumber ?? prior.referenceNumber,
        referenceNumberSchema: inc.referenceNumberSchema ?? prior.referenceNumberSchema,
      });
      confirmed.add(inc.dedupKey);
      updated++;
      continue;
    }

    // pending → booked promotion: a booked row carrying a real entry_reference
    // supersedes an earlier synthetic-keyed pending row with the same content.
    if (inc.status === 'booked' && inc.entryReference) {
      const sig = syntheticDedupKey(inc);
      const priorPending = byKey.get(sig);
      if (priorPending && priorPending.status === 'pending') {
        byKey.delete(sig);
        byKey.set(inc.dedupKey, {
          ...inc,
          id: priorPending.id,
          firstSeenAt: priorPending.firstSeenAt,
          lastSeenAt: nowIso,
          // A booked row often drops the purchase date the pending carried.
          transactionDate:
            inc.transactionDate ?? priorPending.transactionDate ?? priorPending.bookingDate,
          referenceNumber: inc.referenceNumber ?? priorPending.referenceNumber,
          referenceNumberSchema: inc.referenceNumberSchema ?? priorPending.referenceNumberSchema,
        });
        confirmed.add(inc.dedupKey);
        updated++;
        continue;
      }
    }

    // Fuzzy promotion: the bank rewrote both the reference and the counterparty
    // on booking, so only amount + date proximity can tie the rows together.
    // The delete makes the match one-to-one within this merge.
    if (inc.status === 'booked') {
      const match = bestFuzzyPendingMatch(byKey, inc, incomingKeys);
      if (match) {
        byKey.delete(match.dedupKey);
        byKey.set(inc.dedupKey, {
          ...inc,
          id: match.id,
          firstSeenAt: match.firstSeenAt,
          lastSeenAt: nowIso,
          transactionDate: inc.transactionDate ?? match.transactionDate ?? match.bookingDate,
          referenceNumber: inc.referenceNumber ?? match.referenceNumber,
          referenceNumberSchema: inc.referenceNumberSchema ?? match.referenceNumberSchema,
        });
        confirmed.add(inc.dedupKey);
        updated++;
        continue;
      }
    }

    byKey.set(inc.dedupKey, {
      ...inc,
      firstSeenAt: inc.firstSeenAt || nowIso,
      lastSeenAt: nowIso,
    });
    confirmed.add(inc.dedupKey);
    added++;
  }

  // Prune stale pendings the bank no longer reports in the re-fetched window.
  // Only PENDING, only inside [fromDate, toDate], only if this fetch didn't
  // corroborate them — booked rows and out-of-window rows are always kept.
  if (window) {
    for (const [key, t] of byKey) {
      if (confirmed.has(key)) continue;
      if (t.status !== 'pending') continue;
      if (t.bookingDate >= window.fromDate && t.bookingDate <= window.toDate) {
        byKey.delete(key);
        removed++;
      }
    }
  }

  const merged = [...byKey.values()].sort((a, b) => {
    const byDate = b.bookingDate.localeCompare(a.bookingDate);
    return byDate !== 0 ? byDate : a.dedupKey.localeCompare(b.dedupKey);
  });
  return { merged, added, updated, removed };
}
