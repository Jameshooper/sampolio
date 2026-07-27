import { v4 as uuidv4 } from 'uuid';
import type { BankAccountLink } from '@/types';
import type { MappedBankAccount } from './mappers';

/**
 * Merge freshly-mapped accounts with existing links, preserving stable link ids
 * and any user configuration (role, linked financial account, custom name, card
 * cycle config) across re-consent. Accounts are re-matched in priority order:
 *
 *   1. `identificationHash` — Enable Banking's recommended stable key, constant
 *      across sessions AND users (per EB's FAQ), so it survives even the
 *      no-IBAN + rotated-uid case (typically credit cards).
 *   2. `accountUid` — stable only within a session; EB rotates it on every
 *      re-authorisation, so this alone loses no-IBAN accounts on reconnect.
 *   3. IBAN — a fallback for accounts that expose one; absent on cards.
 *
 * On re-consent (a `prior` link exists) we additionally **clear**
 * `syncCursor.backfilledThrough` so the post-SCA sync re-runs a full ~24-month
 * backfill (`BACKFILL_DAYS`). Re-consent happens inside the bank's ~1h "fresh
 * session" — the only window where ASPSPs serve deep history — so it's exactly
 * when an already-connected account's history can be deepened. The dedup merge
 * folds the re-fetched window over existing transactions, so nothing is lost or
 * duplicated; every other field of the link is preserved.
 */
export function reconcileLinks(
  existing: BankAccountLink[],
  mapped: MappedBankAccount[],
  connectionId: string
): BankAccountLink[] {
  return mapped.map((m) => {
    const prior =
      existing.find((e) => !!m.identificationHash && e.identificationHash === m.identificationHash) ??
      existing.find((e) => e.accountUid === m.accountUid || (!!m.iban && e.iban === m.iban));
    if (prior) {
      return {
        ...prior, // keep id, accountRole, linkedFinancialAccountId, custom name, card config
        connectionId,
        accountUid: m.accountUid,
        identificationHash: m.identificationHash ?? prior.identificationHash,
        iban: m.iban ?? prior.iban,
        name: m.name ?? prior.name,
        currency: m.currency,
        // Force a fresh deep backfill on the next sync (see doc comment above).
        syncCursor: prior.syncCursor
          ? { ...prior.syncCursor, backfilledThrough: undefined }
          : prior.syncCursor,
      };
    }
    return {
      id: uuidv4(),
      connectionId,
      accountUid: m.accountUid,
      identificationHash: m.identificationHash,
      iban: m.iban,
      name: m.name,
      currency: m.currency,
      accountRole: m.accountRole,
    };
  });
}
