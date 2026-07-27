/**
 * Shared per-connection bank teardown: best-effort EB session revoke, then
 * delete all local data for that connection. A PLAIN module (not 'use server')
 * so it can take a raw userId/connection — every export from a 'use server'
 * file becomes a client-invokable endpoint, which a raw-userId helper must
 * never be. Used by `disconnectBankConnection` (src/lib/actions/bank.ts) and
 * by account self-service (src/lib/actions/account.ts: deleteMyAccount,
 * resetMyData) to tear down every connection of the current user.
 */

import type { BankConnection } from '@/types';
import { deleteBankTransactionsForAccount } from '@/lib/db/bank-transactions';
import { deleteBankSyncRuns } from '@/lib/db/bank-sync-runs';
import {
  deleteBankConnection as dbDeleteConnection,
  getBankSessionSecret,
} from '@/lib/db/bank-connections';
import { deleteSession, redactBankError } from '@/lib/bank/client';

/** Revoke the session at the bank (never throws), then wipe transactions,
 * sync-run history, and the connection itself for this one connection. */
export async function teardownBankConnection(
  userId: string,
  connection: BankConnection
): Promise<void> {
  const secret = await getBankSessionSecret(userId, connection.id);
  if (secret?.sessionId) {
    try {
      await deleteSession(secret.sessionId);
    } catch (err) {
      console.error('[bank] session revoke failed (continuing):', redactBankError(err));
    }
  }

  for (const link of connection.linkedAccounts) {
    await deleteBankTransactionsForAccount(userId, link.id);
  }
  await deleteBankSyncRuns(userId, connection.id);
  await dbDeleteConnection(userId, connection.id);
}
