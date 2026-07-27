/**
 * Enable Banking — self-healing repair for "degenerate" booking dates (pure, no I/O).
 *
 * Some banks (notably OP in Finland) return credit-card transactions with NO
 * `booking_date` and NO `value_date` — only a `transaction_date`. Rows synced
 * before the mapper's transaction-date fallback existed all fell back to the
 * sync day, collapsing an entire history onto one `bookingDate`; every
 * downstream grouping (card billing cycles, the retrospective, the ledger)
 * groups by `bookingDate`, so the real spread is lost. This detects such a
 * collapsed group and rewrites each row's `bookingDate` from its real
 * `transactionDate`, so the stored ledger self-heals on the next sync.
 *
 * Pure and idempotent: a second pass finds no degenerate group and changes
 * nothing. When nothing changes, the input array and its row objects are
 * returned untouched (same references) so a no-op sync never rewrites the file.
 * Synthetic dedup keys are unaffected — they exclude bookingDate (see dedup.ts).
 */

import type { BankTransaction } from '@/types';

/** A group is degenerate when at least this many rows are far-older than its day. */
const DEGENERATE_MIN_ROWS = 5;
/** "Far older": a transactionDate more than this many days before the bookingDate. */
const DEGENERATE_DAY_THRESHOLD = 7;

function dayKey(d: string): string {
  return d.slice(0, 10);
}

/** Whole-day difference `laterYmd − earlierYmd` (both 'YYYY-MM-DD'); 0 if unparseable. */
function daysBetween(laterYmd: string, earlierYmd: string): number {
  const later = Date.parse(`${dayKey(laterYmd)}T00:00:00Z`);
  const earlier = Date.parse(`${dayKey(earlierYmd)}T00:00:00Z`);
  if (Number.isNaN(later) || Number.isNaN(earlier)) return 0;
  return (later - earlier) / 86_400_000;
}

export function repairDegenerateBookingDates(rows: BankTransaction[]): {
  rows: BankTransaction[];
  changed: number;
} {
  // Bucket row indices by their bookingDate day.
  const groups = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const key = dayKey(r.bookingDate);
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  });

  // A day is degenerate when ≥ MIN of its rows carry a transactionDate more than
  // THRESHOLD days older than that day.
  const degenerateDays = new Set<string>();
  for (const [day, idxs] of groups) {
    let oldCount = 0;
    for (const i of idxs) {
      const td = rows[i].transactionDate;
      if (td && daysBetween(day, td) > DEGENERATE_DAY_THRESHOLD) oldCount++;
    }
    if (oldCount >= DEGENERATE_MIN_ROWS) degenerateDays.add(day);
  }

  if (degenerateDays.size === 0) return { rows, changed: 0 };

  let changed = 0;
  const out = rows.map((r) => {
    // Only rows inside a degenerate group that have a real transactionDate
    // differing from the collapsed bookingDate are rewritten.
    if (!degenerateDays.has(dayKey(r.bookingDate))) return r;
    if (!r.transactionDate) return r;
    if (dayKey(r.bookingDate) === dayKey(r.transactionDate)) return r;
    changed++;
    return { ...r, bookingDate: r.transactionDate };
  });

  if (changed === 0) return { rows, changed: 0 };
  return { rows: out, changed };
}
