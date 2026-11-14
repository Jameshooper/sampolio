/**
 * Periodic push of each user's summary numbers to Home Assistant.
 *
 * Deliberately a plain interval rather than anything cleverer: the numbers
 * change when a bank sync lands or an item is edited, and a household does not
 * need either reflected within seconds. One timer, no queue, no retry — a
 * missed push is simply superseded by the next one.
 *
 * OFF BY DEFAULT: `HA_SUMMARY_MINUTES` unset, 0, or no `HA_WEBHOOK_URL` ⇒ the
 * timer is never started and no call is ever made.
 */
import { pushHaSummaryForUser } from '@/lib/ha-summary-collect';
import { getHaSummaryWebhook } from '@/lib/ha-summary';
import { getAllUsers } from '@/lib/db/users';

const MIN_MINUTES = 5;
const MAX_MINUTES = 24 * 60;

let timer: NodeJS.Timeout | null = null;

/**
 * Resolve the interval in minutes. Returns null when the feature is off.
 * Clamped: below 5 minutes is pointless load on a household NAS, and above a
 * day the figures are stale enough to mislead.
 */
export function resolveSummaryIntervalMinutes(
  raw: string | undefined = process.env.HA_SUMMARY_MINUTES
): number | null {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(Math.max(parsed, MIN_MINUTES), MAX_MINUTES);
}

/** Push once for every user. Never throws. */
export async function pushSummariesForAllUsers(): Promise<void> {
  try {
    const users = await getAllUsers();
    for (const user of users) {
      await pushHaSummaryForUser(user.id);
    }
  } catch (error) {
    console.warn(
      `[ha-summary] Scheduled push failed: ${error instanceof Error ? error.name : 'unknown error'}.`
    );
  }
}

/** Start the timer if the feature is configured. Safe to call more than once. */
export function startHaSummaryScheduler(): void {
  if (timer) return;

  const minutes = resolveSummaryIntervalMinutes();
  if (minutes === null) return;
  if (!getHaSummaryWebhook()) {
    console.warn('[ha-summary] ha_summary_minutes is set but no Home Assistant webhook is configured — not starting.');
    return;
  }

  console.log(`[ha-summary] Pushing account summaries to Home Assistant every ${minutes} min.`);
  timer = setInterval(() => void pushSummariesForAllUsers(), minutes * 60_000);
  // Do not hold the process open for the sake of a status push.
  timer.unref?.();
  // One immediately, so Home Assistant has figures without waiting a cycle.
  void pushSummariesForAllUsers();
}

/** Stop the timer. Used by tests; harmless in production. */
export function stopHaSummaryScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
