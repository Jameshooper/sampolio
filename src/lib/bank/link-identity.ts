/**
 * Enable Banking — pure helpers for cross-session/cross-user account identity
 * and freshness (no I/O). Used by the cross-user fan-out to recognize when two
 * users' `BankAccountLink`s point at the same underlying bank account, and to
 * skip re-fetching an account another user's sync already refreshed this cycle.
 */

import type { BankAccountLink } from '@/types';

/**
 * The stable cross-session/cross-user identity of the underlying bank account
 * behind a link. `identificationHash` (Enable Banking's recommended key) wins
 * when present; IBAN is the fallback for accounts without a captured hash yet;
 * the app's own link uuid is the last resort, which makes an unmatched link a
 * singleton group of one (never collides with another link's key by accident).
 */
export function linkIdentityKey(
  link: Pick<BankAccountLink, 'id' | 'iban' | 'identificationHash'>
): string {
  return link.identificationHash ?? link.iban ?? link.id;
}

/**
 * Every identification hash known for a link — the deduped union of the plural
 * `identificationHashes` and the singular `identificationHash`, order-preserving
 * (array first). Empty for a legacy link that has neither.
 */
export function linkIdentityHashes(
  link: Pick<BankAccountLink, 'identificationHash' | 'identificationHashes'>
): string[] {
  const out: string[] = [];
  const push = (h: unknown) => {
    if (typeof h === 'string' && h && !out.includes(h)) out.push(h);
  };
  if (Array.isArray(link.identificationHashes)) {
    for (const h of link.identificationHashes) push(h);
  }
  push(link.identificationHash);
  return out;
}

/**
 * True when two links point at the same underlying bank account. Enable Banking
 * hashes every identification basis it knows for an account (IBAN, BBAN, …), and
 * which one lands in the singular `identification_hash` can change between
 * sessions — so when BOTH sides expose hashes, a non-empty intersection is the
 * decisive signal. Otherwise (a legacy link with no hashes on either side) this
 * falls back to `linkIdentityKey` equality, i.e. exactly today's behavior.
 */
export function linksShareIdentity(
  a: Pick<BankAccountLink, 'id' | 'iban' | 'identificationHash' | 'identificationHashes'>,
  b: Pick<BankAccountLink, 'id' | 'iban' | 'identificationHash' | 'identificationHashes'>
): boolean {
  const ha = linkIdentityHashes(a);
  const hb = linkIdentityHashes(b);
  if (ha.length && hb.length) {
    const set = new Set(hb);
    return ha.some((h) => set.has(h));
  }
  return linkIdentityKey(a) === linkIdentityKey(b);
}

/**
 * True when `lastSyncedAt` is recent enough that this cycle's sync can be
 * skipped — i.e. another user's sync (or our own) already refreshed this
 * account within the last `intervalMs`, allowing for `tickMs` of scheduler
 * jitter. An unparseable or missing `lastSyncedAt` is never considered fresh.
 */
export function isLinkFresh(
  lastSyncedAt: string | undefined,
  nowMs: number,
  intervalMs: number,
  tickMs: number
): boolean {
  if (!lastSyncedAt) return false;
  const lastMs = Date.parse(lastSyncedAt);
  if (Number.isNaN(lastMs)) return false;
  return nowMs - lastMs < intervalMs - tickMs;
}
