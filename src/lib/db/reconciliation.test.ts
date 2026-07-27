import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createBalanceSnapshot, getLatestSnapshot, getSnapshotsForEntity } from './reconciliation';

/**
 * Regression tests for the "bank value should win" bug: a cash account linked to
 * a synced bank account kept showing the manually entered balance because the old
 * `createBalanceSnapshot` made a manual snapshot *always* win, so the bank-sync
 * auto-anchor for the current month was silently dropped. The displayed balance
 * (Overview KPI + cashflow anchor) therefore stayed on the stale manual value.
 *
 * The fix: last-write-wins for a given entity/month. Bank-sync only ever writes
 * the CURRENT month, so historical manual reconciliations are never touched.
 *
 * These exercise the real encrypted disk round-trip.
 */
describe('createBalanceSnapshot — last-write-wins per entity/month', () => {
  let dataDir: string;
  const userId = 'test-user';
  const entityId = 'cash-1';

  beforeAll(() => {
    dataDir = path.join(os.tmpdir(), `sampolio-reconc-test-${process.pid}`);
    process.env.DATA_DIR = dataDir;
  });

  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('lets a bank-sync supersede an older manual snapshot for the same month', async () => {
    // User reconciled June by hand before linking the bank.
    await createBalanceSnapshot(userId, 'cash-account', entityId, '2026-06', 9329.34, 9329.34, 'manual');
    // The bank then syncs the real current balance for June.
    const synced = await createBalanceSnapshot(userId, 'cash-account', entityId, '2026-06', 9300, 9263.74, 'bank-sync');

    expect(synced.source).toBe('bank-sync');
    expect(synced.actualBalance).toBe(9263.74);

    const latest = await getLatestSnapshot(userId, 'cash-account', entityId);
    expect(latest?.actualBalance).toBe(9263.74);
    expect(latest?.source).toBe('bank-sync');

    // Still exactly one snapshot for that month (overwrite in place, not append).
    const all = await getSnapshotsForEntity(userId, 'cash-account', entityId);
    expect(all.filter(s => s.yearMonth === '2026-06')).toHaveLength(1);
  });

  it('lets a later manual reconciliation override the bank value (user correction)', async () => {
    const corrected = await createBalanceSnapshot(userId, 'cash-account', entityId, '2026-06', 9300, 9999, 'manual');
    expect(corrected.source).toBe('manual');

    const latest = await getLatestSnapshot(userId, 'cash-account', entityId);
    expect(latest?.actualBalance).toBe(9999);
  });

  it('never overwrites a different (historical) month when the bank syncs the current one', async () => {
    const userId2 = 'test-user-2';
    // A hand-confirmed May reconciliation.
    await createBalanceSnapshot(userId2, 'cash-account', entityId, '2026-05', 5000, 5000, 'manual');
    // Bank syncs the current month (June) only.
    await createBalanceSnapshot(userId2, 'cash-account', entityId, '2026-06', 4900, 4850, 'bank-sync');

    const all = await getSnapshotsForEntity(userId2, 'cash-account', entityId);
    const may = all.find(s => s.yearMonth === '2026-05');
    expect(may?.source).toBe('manual');
    expect(may?.actualBalance).toBe(5000);
    // Latest (by month) is June's bank value.
    expect((await getLatestSnapshot(userId2, 'cash-account', entityId))?.actualBalance).toBe(4850);
  });
});
