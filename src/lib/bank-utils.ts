/**
 * Pure, client-safe bank helpers (no server / DB / fs imports) — the consent
 * expiry detection mirrors `isEuriborUpdateDue` so the Overview banner can reuse
 * the same one-glance pattern, plus an IBAN mask used everywhere in the UI.
 */

import type { BankAccountLink, BankConnection, BankSyncStatus } from '@/types';
import { CONSENT_EXPIRY_WARNING_DAYS, SYNC_FAILURE_ALERT_THRESHOLD } from './bank/constants';

export interface ConsentExpiryInfo {
  /** Consent is past its valid_until or the connection is marked expired. */
  expired: boolean;
  /** Active consent within the warning window — prompt a one-click reconnect. */
  expiringSoon: boolean;
  /** Whole days until expiry (negative once past); null when no expiry recorded. */
  daysUntilExpiry: number | null;
  expiresAt: Date | null;
}

const MS_PER_DAY = 86_400_000;

export function getConsentExpiryInfo(
  connection: Pick<BankConnection, 'status' | 'consentExpiresAt'>,
  now: Date = new Date()
): ConsentExpiryInfo {
  if (!connection.consentExpiresAt) {
    return {
      expired: connection.status === 'expired',
      expiringSoon: false,
      daysUntilExpiry: null,
      expiresAt: null,
    };
  }
  const expiresAt = new Date(connection.consentExpiresAt);
  const daysUntilExpiry = Math.ceil((expiresAt.getTime() - now.getTime()) / MS_PER_DAY);
  const expired = connection.status === 'expired' || connection.status === 'revoked' || daysUntilExpiry <= 0;
  const expiringSoon = !expired && daysUntilExpiry <= CONSENT_EXPIRY_WARNING_DAYS;
  return { expired, expiringSoon, daysUntilExpiry, expiresAt };
}

/** True when a connection needs the user's attention (expired or expiring soon). */
export function isConsentExpiringSoon(
  connection: Pick<BankConnection, 'status' | 'consentExpiresAt'>,
  now: Date = new Date()
): boolean {
  const info = getConsentExpiryInfo(connection, now);
  return info.expired || info.expiringSoon;
}

/**
 * Next consecutive-failure streak after a run: reset to 0 on a clean ('ok') sync,
 * otherwise +1. A non-expiry failure keeps the connection 'active' (the scheduler
 * keeps retrying), so this streak is what lets a genuinely stuck connection be
 * surfaced — while a one-off transient that recovers next cycle resets to 0.
 */
export function nextConsecutiveSyncFailures(
  prev: number | undefined,
  runStatus: BankSyncStatus
): number {
  return runStatus === 'ok' ? 0 : (prev ?? 0) + 1;
}

/**
 * True when a connection has failed to sync enough times in a row to warrant a
 * user-facing alert. Unlike consent expiry, these failures never change `status`,
 * so without this they would silently fail forever (only a faint Settings hint).
 */
export function isSyncFailing(
  connection: Pick<BankConnection, 'consecutiveSyncFailures'>
): boolean {
  return (connection.consecutiveSyncFailures ?? 0) >= SYNC_FAILURE_ALERT_THRESHOLD;
}

/**
 * Apply the user's curated bank-account display order (a list of
 * BankAccountLink ids). Pure and non-mutating:
 *
 * - No/empty order ⇒ identity (returns the input array as-is).
 * - Within each connection, linked accounts are reordered by their index in
 *   `order`; ids absent from `order` keep their original insertion order AFTER
 *   all ordered ones (stable).
 * - Connections are then reordered by the minimum order index across their
 *   links; connections with no ordered links keep their relative order at the
 *   end.
 */
export function sortConnectionsByAccountOrder(
  connections: BankConnection[],
  order: string[] | undefined
): BankConnection[] {
  if (!order || order.length === 0) return connections;

  const orderIndex = new Map<string, number>();
  order.forEach((id, i) => {
    if (!orderIndex.has(id)) orderIndex.set(id, i);
  });
  const rank = (id: string): number =>
    orderIndex.has(id) ? orderIndex.get(id)! : Number.POSITIVE_INFINITY;

  // Reorder each connection's links (ordered ids first by index, unordered ids
  // keep insertion order after them via the stable original-index tiebreak).
  const withSortedLinks = connections.map((conn) => ({
    ...conn,
    linkedAccounts: conn.linkedAccounts
      .map((link, i) => ({ link, i }))
      .sort((a, b) => rank(a.link.id) - rank(b.link.id) || a.i - b.i)
      .map((x) => x.link),
  }));

  // Reorder connections by their smallest link rank; no ordered links ⇒
  // Infinity ⇒ tiebreak on original index keeps them at the end in place.
  return withSortedLinks
    .map((conn, i) => ({ conn, i }))
    .sort((a, b) => {
      const ra = Math.min(Number.POSITIVE_INFINITY, ...a.conn.linkedAccounts.map((l) => rank(l.id)));
      const rb = Math.min(Number.POSITIVE_INFINITY, ...b.conn.linkedAccounts.map((l) => rank(l.id)));
      return ra - rb || a.i - b.i;
    })
    .map((x) => x.conn);
}

/**
 * The card figures to DISPLAY / use for net worth, filling gaps the bank leaves:
 *  - `outstanding` falls back to a negative `lastBalance` (a card whose only
 *    reported balance is the owed amount, e.g. OP);
 *  - `creditLimit` falls back to the user-entered `manualCreditLimit` (OP never
 *    reports a limit);
 *  - `availableCredit` is derived (limit − outstanding, floored at 0) when the
 *    bank didn't report it but we now know both a limit and an outstanding.
 * A stored NEGATIVE availableCredit (a pre-fix artifact of OP's mislabeled
 * balance, cleared only on the next sync) is treated as unknown, never shown.
 * Pure; any field stays undefined when it can't be determined.
 */
export function effectiveCardNumbers(
  link: Pick<
    BankAccountLink,
    'outstanding' | 'availableCredit' | 'creditLimit' | 'manualCreditLimit' | 'lastBalance'
  >
): { outstanding?: number; availableCredit?: number; creditLimit?: number } {
  const outstanding =
    link.outstanding ??
    (typeof link.lastBalance === 'number' && link.lastBalance < 0 ? -link.lastBalance : undefined);
  const creditLimit = link.creditLimit ?? link.manualCreditLimit;
  const reportedAvailable =
    typeof link.availableCredit === 'number' && link.availableCredit >= 0
      ? link.availableCredit
      : undefined;
  const availableCredit =
    reportedAvailable ??
    (creditLimit != null && outstanding != null ? Math.max(0, creditLimit - outstanding) : undefined);
  return { outstanding, availableCredit, creditLimit };
}

/** Mask an IBAN for display: "FI••••1234". Never show the full IBAN. */
export function maskIban(iban?: string): string {
  if (!iban) return '';
  const s = iban.replace(/\s+/g, '');
  if (s.length <= 6) return '••••';
  return `${s.slice(0, 2)}••••${s.slice(-4)}`;
}
