import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

// Action-layer regression tests for the audit's exploit inputs, run through the
// real server actions with auth() and Next's cache APIs mocked (no request
// scope under vitest) and the db writing to a temp DATA_DIR.
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('next/cache', () => ({ updateTag: vi.fn(), cacheTag: vi.fn(), cacheLife: vi.fn() }));
vi.mock('@/lib/db/cached', async () => {
  const budgets = await import('@/lib/db/budgets');
  const trips = await import('@/lib/db/trips');
  const accounts = await import('@/lib/db/accounts');
  return {
    cachedGetBudgetById: budgets.getBudgetById,
    cachedGetBudgets: budgets.getBudgets,
    cachedGetTrips: trips.getTrips,
    cachedGetAccounts: accounts.getAccounts,
    cachedGetAccountById: accounts.getAccountById,
    cachedGetSplitGroupsForUser: async () => [],
    cachedGetBankConnections: async () => [],
  };
});

import { auth } from '@/lib/auth';
import { updateBudget, deleteBudget, getBudgetById } from './budgets';
import { importUserData } from './data-transfer';
import { createAccount, updateAccount } from './accounts';
import { signUp } from './auth';
import { createUser, findUserById } from '@/lib/db/users';
import { updateAppSettings } from '@/lib/db/app-settings';

const mockAuth = vi.mocked(auth);
const asUser = (id: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockAuth.mockResolvedValue({ user: { id, email: `${id}@example.com`, name: id, role: 'user' } } as any);

describe('server actions reject the audit exploit inputs', () => {
  let dataDir: string;
  let alexId: string;
  let samId: string;

  beforeAll(async () => {
    dataDir = path.join(os.tmpdir(), `sampolio-security-actions-${process.pid}`);
    process.env.DATA_DIR = dataDir;
    alexId = (await createUser('alex@example.com', 'Str0ng!Pass', 'Alex')).id; // first user → admin
    samId = (await createUser('sam@example.com', 'Str0ng!Pass', 'Sam')).id;
  });

  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    vi.clearAllMocks();
    asUser(samId);
  });

  it('updateBudget cannot read the users index or another user record', async () => {
    for (const id of ['../../../users-index', `../../${alexId}/user`]) {
      const res = await updateBudget(id, {});
      expect(res.success).toBe(false);
      expect(JSON.stringify(res)).not.toContain('passwordHash');
      expect(JSON.stringify(res)).not.toContain('alex@example.com');
    }
    expect((await getBudgetById(`../../${alexId}/user`)).success).toBe(false);
  });

  it('deleteBudget cannot delete the users index', async () => {
    expect((await deleteBudget('../../../users-index')).success).toBe(false);
    await expect(fs.access(path.join(dataDir, 'users-index.enc'))).resolves.toBeUndefined();
  });

  it('importUserData cannot overwrite account records (self escalation or takeover)', async () => {
    const now = new Date().toISOString();
    for (const id of ['../user', `../../${alexId}/user`]) {
      const res = await importUserData(
        {
          format: 'sampolio-export',
          version: 1,
          exportedAt: now,
          userId: samId,
          notIncluded: [],
          entities: {
            accounts: [],
            investments: [],
            debts: [],
            receivables: [],
            goals: [{ id, email: 'sam@example.com', passwordHash: 'x', role: 'admin', isActive: true }],
            budgets: [],
            reconciliation: { snapshots: [], adjustments: [], sessions: [] },
            preferences: null,
          },
        },
        { mode: 'merge' }
      );
      expect(res.success).toBe(false);
    }
    expect((await findUserById(samId))?.role).toBe('user');
    expect((await findUserById(alexId))?.email).toBe('alex@example.com');
  });

  it('createAccount / updateAccount reject unbounded or invalid custom end dates', async () => {
    const base = { name: 'Main', currency: 'EUR' as const, startingBalance: 0, startingDate: '2026-01', planningHorizonMonths: 120 };
    expect((await createAccount({ ...base, customEndDate: '9999-12' })).success).toBe(false);
    expect((await createAccount({ ...base, customEndDate: '2026-13' })).success).toBe(false);
    const ok = await createAccount({ ...base, customEndDate: '2030-12' });
    expect(ok.success).toBe(true);
    expect((await updateAccount(ok.data!.id, { customEndDate: '9999-12' })).success).toBe(false);
  });

  it('signUp: no anonymous "first user" while accounts exist, even if the index is gone', async () => {
    await updateAppSettings({ selfSignupEnabled: false }, alexId);
    await fs.rm(path.join(dataDir, 'users-index.enc'));
    const res = await signUp({ email: 'mallory@example.com', password: 'Str0ng!Pass', name: 'Mallory' });
    expect(res.success).toBe(false);
  });
});
