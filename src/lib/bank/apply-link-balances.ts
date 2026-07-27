/**
 * Enable Banking — pure per-role balance application (no I/O).
 *
 * Given a link's role and a freshly fetched balance snapshot, decides the
 * link fields a sync should write. Shared by the primary sync path and the
 * cross-user fan-out: a sibling user's link may have a DIFFERENT
 * `accountRole` for the very same underlying account (e.g. one spouse tracks
 * it as `cash`, the other as `other`), so the role must be re-derived per
 * link rather than assumed from the primary fetch.
 */

import type { BankAccountLink } from '@/types';
import type { MappedBalance } from './mappers';
import { pickAnchorBalance, pickCardBalances } from './mappers';

export type BalanceApplicationLink = Pick<
  BankAccountLink,
  | 'accountRole'
  | 'lastBalance'
  | 'lastBalanceType'
  | 'lastBalanceAt'
  | 'outstanding'
  | 'availableCredit'
  | 'creditLimit'
>;

export interface AppliedLinkBalances {
  /** Whether a usable balance was found this fetch (drives `balanceFetched`). */
  balanceFound: boolean;
  lastBalance?: number;
  lastBalanceType?: string;
  lastBalanceAt?: string;
  outstanding?: number;
  availableCredit?: number;
  creditLimit?: number;
  /** cash/savings only: the anchor balance, when found — feeds auto-anchoring. */
  anchorBalanceAmount?: number;
}

/**
 * Derive the link balance fields a sync should write. When nothing usable is
 * found in `balances`, every field falls back to the link's current value (a
 * no-op update) so a transient balance-fetch miss never blanks out a
 * previously-known balance.
 */
export function applyLinkBalances(
  link: BalanceApplicationLink,
  balances: MappedBalance[],
  nowIso: string
): AppliedLinkBalances {
  if (link.accountRole === 'credit-card') {
    // Card: booked balance (ITBD) is negative = owed; available (ITAV) is
    // spendable credit. Both are real-time (no need to wait for postings).
    // outstanding = -booked; creditLimit = available + outstanding.
    const { booked, available } = pickCardBalances(balances);

    // A genuine fetch MISS (empty/unusable balances) is a no-op: preserve every
    // prior field so a transient miss never blanks a previously-known balance.
    if (!booked && !available) {
      return {
        balanceFound: false,
        lastBalance: link.lastBalance,
        lastBalanceType: link.lastBalanceType,
        lastBalanceAt: link.lastBalanceAt,
        outstanding: link.outstanding,
        availableCredit: link.availableCredit,
        creditLimit: link.creditLimit,
      };
    }

    const outstanding = booked ? Math.max(0, -booked.amount) : link.outstanding;

    // When the bank reports a real available balance, derive availableCredit +
    // creditLimit from it. When a booked balance was found but NO available one
    // (e.g. OP's single negative balance we reinterpret as booked), explicitly
    // CLEAR both — returned as undefined so the link write drops any stale value
    // (e.g. a pre-fix negative availableCredit). The manual credit-limit
    // fallback (effectiveCardNumbers) then reconstructs available-to-spend.
    let availableCredit: number | undefined;
    let creditLimit: number | undefined;
    if (available) {
      availableCredit = available.amount;
      creditLimit = outstanding != null ? available.amount + outstanding : link.creditLimit;
    } else {
      availableCredit = undefined;
      creditLimit = undefined;
    }

    return {
      balanceFound: true,
      lastBalance: booked?.amount ?? available?.amount ?? link.lastBalance,
      lastBalanceType: (booked ?? available)?.type ?? link.lastBalanceType,
      lastBalanceAt: nowIso,
      outstanding,
      availableCredit,
      creditLimit,
    };
  }

  // Deposit accounts (cash/savings/other): a single anchor balance.
  const anchorBalance = pickAnchorBalance(balances);
  return {
    balanceFound: !!anchorBalance,
    lastBalance: anchorBalance?.amount ?? link.lastBalance,
    lastBalanceType: anchorBalance?.type ?? link.lastBalanceType,
    lastBalanceAt: anchorBalance ? nowIso : link.lastBalanceAt,
    anchorBalanceAmount: anchorBalance?.amount,
  };
}
