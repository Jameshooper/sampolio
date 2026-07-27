/**
 * Enable Banking — sync-run audit log (file I/O).
 *
 * One encrypted file per connection holding a capped, append-only list of the
 * most recent sync runs (newest first). Used for the "last sync" UI and for
 * debugging. Entries carry only codes/counts/durations — never PII.
 *
 * Layout: data/users/{userId}/bank/sync-runs/{connectionId}.enc
 */

import * as path from 'path';
import type { BankSyncRun } from '@/types';
import {
  getUserDir,
  ensureDir,
  readEncryptedFile,
  writeEncryptedFile,
  deleteFile,
} from './encryption';

/** Keep only the most recent runs per connection (bounded growth). */
const MAX_SYNC_RUNS = 50;

function getSyncRunsDir(userId: string): string {
  return path.join(getUserDir(userId), 'bank', 'sync-runs');
}

function getSyncRunsFile(userId: string, connectionId: string): string {
  return path.join(getSyncRunsDir(userId), `${connectionId}.enc`);
}

interface SyncRunsData {
  runs: BankSyncRun[];
}

export async function getBankSyncRuns(
  userId: string,
  connectionId: string
): Promise<BankSyncRun[]> {
  const data = await readEncryptedFile<SyncRunsData>(getSyncRunsFile(userId, connectionId));
  return data?.runs ?? [];
}

export async function getLatestBankSyncRun(
  userId: string,
  connectionId: string
): Promise<BankSyncRun | null> {
  const runs = await getBankSyncRuns(userId, connectionId);
  return runs.length > 0 ? runs[0] : null;
}

/** Prepend a run and trim to the cap. Returns the stored run. */
export async function appendBankSyncRun(
  userId: string,
  connectionId: string,
  run: BankSyncRun
): Promise<BankSyncRun> {
  const dir = getSyncRunsDir(userId);
  await ensureDir(dir);
  const existing = await getBankSyncRuns(userId, connectionId);
  const runs = [run, ...existing].slice(0, MAX_SYNC_RUNS);
  await writeEncryptedFile<SyncRunsData>(getSyncRunsFile(userId, connectionId), { runs });
  return run;
}

export async function deleteBankSyncRuns(
  userId: string,
  connectionId: string
): Promise<void> {
  await deleteFile(getSyncRunsFile(userId, connectionId));
}
