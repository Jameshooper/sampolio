/**
 * Enable Banking — pure transaction dedup / merge (no I/O, fully testable).
 *
 * Dedup key: a booked transaction's stable `entry_reference`; for pending or
 * unstable rows (null/absent reference) a deterministic synthetic key derived
 * from the row's content. The merge is idempotent — re-fetching an overlapping
 * window never duplicates rows — and promotes a pending row to its booked
 * counterpart when the booked version (carrying a real reference) arrives.
 *
 * Pending rows are unreliable by design: banks rarely give them a stable id, and
 * when they do it CHANGES on booking (Enable Banking docs), so a pending row can
 * strand — its booked twin arrives under a different key and the promotion above
 * misses (e.g. the counterparty text is rewritten). To stop those phantoms
 * accumulating, pass the fetched `window` to `mergeTransactions`: a fetch returns
 * the bank's authoritative view of that date range, so any stored PENDING row
 * inside it the fetch did not corroborate has booked-under-another-key or been
 * cancelled and is pruned. Booked rows and rows outside the window are never
 * touched.
 */

import type { BankTransaction } from '@/types';

/** Fields that identify a transaction's content for synthetic keying. */
type TxContent = Pick<
  BankTransaction,
  'amount' | 'currency' | 'counterpartyName' | 'remittanceInfo' | 'valueDate'
>;

/**
 * Deterministic synthetic dedup key for a pending / reference-less transaction.
 * Excludes booking date (pending rows often lack it) so a later booked row with
 * the same content can be recognized as the same underlying transaction.
 */
export function syntheticDedupKey(t: TxContent): string {
  // Collapse internal whitespace so the key is stable regardless of how
  // remittance lines are joined (spaces vs newlines).
  const norm = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
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
 * Merge `incoming` rows into `existing`, deduping by `dedupKey` and promoting
 * pending → booked. `nowIso` stamps `lastSeenAt` (and `firstSeenAt` for new
 * rows). When `window` is given, stale PENDING rows inside that fetched range —
 * ones this fetch did not return — are pruned (see the module doc). The result
 * is sorted newest-first by booking date.
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

  for (const inc of incoming) {
    const prior = byKey.get(inc.dedupKey);
    if (prior) {
      // Same identity → refresh fields, preserve firstSeenAt.
      byKey.set(inc.dedupKey, {
        ...prior,
        ...inc,
        firstSeenAt: prior.firstSeenAt,
        lastSeenAt: nowIso,
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
          firstSeenAt: priorPending.firstSeenAt,
          lastSeenAt: nowIso,
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
