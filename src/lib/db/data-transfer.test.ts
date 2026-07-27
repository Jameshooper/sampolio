import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { writeUserDataFromExport } from './data-transfer';
import { getAccounts } from './accounts';
import { getRecurringItems } from './recurring-items';
import { getGoals } from './goals';
import { getBalanceSnapshots } from './reconciliation';
import { getUserDir, writeEncryptedFile } from './encryption';
import { dataExportSchema } from '@/lib/schemas/data-transfer.schema';
import type { DataExport } from '@/lib/schemas/data-transfer.schema';
import { createMockAccount, createMockRecurringItem } from '@/test/mocks';
import type { BalanceSnapshot, Goal } from '@/types';

/** Real disk round-trips of the JSON backup writer (encrypted write → decrypt read). */
describe('data-transfer db layer', () => {
  let dataDir: string;
  const userId = 'import-user';

  const account = createMockAccount({ id: 'acc-1', userId: 'export-user' });
  const recurring = createMockRecurringItem({ id: 'rec-1', accountId: 'acc-1' });
  const goal: Goal = {
    id: 'goal-1', userId: 'export-user', name: 'Emergency fund', targetAmount: 10000,
    currency: 'EUR', trackingMethod: 'manual', currentManualAmount: 500, isArchived: false,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const snapshot: BalanceSnapshot = {
    id: 'snap-1', userId: 'export-user', entityType: 'cash-account', entityId: 'acc-1',
    yearMonth: '2026-06', expectedBalance: 100, actualBalance: 120, variance: 20,
    source: 'manual', createdAt: '2026-06-01T00:00:00.000Z',
  };

  const payload: DataExport = {
    format: 'sampolio-export',
    version: 1,
    exportedAt: '2026-07-03T00:00:00.000Z',
    userId: 'export-user',
    entities: {
      accounts: [{ ...account, recurringItems: [recurring], plannedItems: [], salaryConfigs: [], taxedIncomes: [] }],
      investments: [],
      debts: [],
      receivables: [],
      goals: [goal],
      budgets: [],
      reconciliation: { snapshots: [snapshot], adjustments: [], sessions: [] },
      preferences: null,
    },
    notIncluded: [],
  };

  beforeAll(async () => {
    dataDir = path.join(os.tmpdir(), `sampolio-data-transfer-test-${process.pid}`);
    process.env.DATA_DIR = dataDir;
  });

  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('the schema accepts a real payload and rejects garbage', () => {
    expect(dataExportSchema.safeParse(payload).success).toBe(true);
    expect(dataExportSchema.safeParse({ hello: 'world' }).success).toBe(false);
    expect(dataExportSchema.safeParse({ ...payload, format: 'other' }).success).toBe(false);
  });

  it('imports a payload, rewriting userId and preserving ids', async () => {
    const counts = await writeUserDataFromExport(userId, payload, 'merge');
    expect(counts).toMatchObject({ accounts: 1, accountSubItems: 1, goals: 1, snapshots: 1 });

    const accounts = await getAccounts(userId);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe('acc-1');
    expect(accounts[0].userId).toBe(userId);

    const items = await getRecurringItems(userId, 'acc-1');
    expect(items.map((i) => i.id)).toEqual(['rec-1']);

    const goals = await getGoals(userId);
    expect(goals.map((g) => g.id)).toEqual(['goal-1']);
    expect(goals[0].userId).toBe(userId);

    const snapshots = await getBalanceSnapshots(userId);
    expect(snapshots.map((s) => s.id)).toEqual(['snap-1']);
  });

  it('merge mode upserts by id and keeps unrelated entities', async () => {
    // Pre-existing goal not present in the payload must survive a merge.
    const extraGoal: Goal = { ...goal, id: 'goal-keep', name: 'Keep me' };
    await writeEncryptedFile(path.join(getUserDir(userId), 'goals', 'goal-keep.enc'), extraGoal);

    const modified: DataExport = {
      ...payload,
      entities: { ...payload.entities, goals: [{ ...goal, name: 'Renamed fund' }] },
    };
    await writeUserDataFromExport(userId, modified, 'merge');

    const goals = await getGoals(userId);
    expect(goals).toHaveLength(2);
    expect(goals.find((g) => g.id === 'goal-1')?.name).toBe('Renamed fund');
    expect(goals.find((g) => g.id === 'goal-keep')?.name).toBe('Keep me');
  });

  it('replace mode wipes exported entity types but never bank data', async () => {
    const bankDir = path.join(getUserDir(userId), 'bank-connections');
    await fs.mkdir(bankDir, { recursive: true });
    const bankFile = path.join(bankDir, 'conn-1.enc');
    await fs.writeFile(bankFile, 'sentinel');

    await writeUserDataFromExport(userId, payload, 'replace');

    const goals = await getGoals(userId);
    expect(goals.map((g) => g.id)).toEqual(['goal-1']); // goal-keep wiped by replace
    await expect(fs.readFile(bankFile, 'utf8')).resolves.toBe('sentinel');
  });
});
