import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

// Action-layer tests: exercise the real auth-guard → Zod → db → updateTag
// pipeline with auth() and Next's cache APIs mocked (there is no request
// scope under vitest), and the db writing to a temp DATA_DIR.
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('next/cache', () => ({
  updateTag: vi.fn(),
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));
// The cached wrappers use the 'use cache' directive, which needs the Next
// runtime — route them straight to the underlying db functions instead.
vi.mock('@/lib/db/cached', async () => {
  const goals = await import('@/lib/db/goals');
  const accounts = await import('@/lib/db/accounts');
  return {
    cachedGetGoals: goals.getGoals,
    cachedGetGoalById: goals.getGoalById,
    cachedGetAccountById: accounts.getAccountById,
  };
});

import { auth } from '@/lib/auth';
import { updateTag } from 'next/cache';
import { getGoals, createGoal, updateGoal, deleteGoal } from './goals';
import { createPlannedItem } from './planned';
import { createAccount } from '@/lib/db/accounts';
import { getPlannedItems } from '@/lib/db/planned-items';

const mockAuth = vi.mocked(auth);
const userId = 'action-test-user';

describe('server actions: auth guard + validation + persistence', () => {
  let dataDir: string;
  let accountId: string;

  beforeAll(async () => {
    dataDir = path.join(os.tmpdir(), `sampolio-actions-test-${process.pid}`);
    process.env.DATA_DIR = dataDir;
    const account = await createAccount(userId, {
      name: 'Test account',
      currency: 'EUR',
      startingBalance: 1000,
      startingDate: '2026-01',
      planningHorizonMonths: 12,
    });
    accountId = account.id;
  });

  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockAuth.mockResolvedValue({ user: { id: userId } } as any);
  });

  describe('goals actions', () => {
    it('rejects every operation without a session', async () => {
      mockAuth.mockResolvedValue(null as never);
      expect((await getGoals()).error).toBe('Unauthorized');
      expect((await createGoal({ name: 'X', targetAmount: 1, currency: 'EUR', trackingMethod: 'manual' })).error).toBe('Unauthorized');
      expect((await updateGoal('some-id', { name: 'Y' })).error).toBe('Unauthorized');
      expect((await deleteGoal('some-id')).error).toBe('Unauthorized');
      expect(updateTag).not.toHaveBeenCalled();
    });

    it('creates, updates, lists and deletes a goal, invalidating the goals tag', async () => {
      const created = await createGoal({
        name: 'Emergency fund',
        targetAmount: 10000,
        currency: 'EUR',
        trackingMethod: 'manual',
        currentManualAmount: 100,
      });
      expect(created.success).toBe(true);
      expect(updateTag).toHaveBeenCalledWith(`user:${userId}:goals`);

      const updated = await updateGoal(created.data!.id, { isArchived: true });
      expect(updated.data?.isArchived).toBe(true);

      const list = await getGoals();
      expect(list.data?.map((g) => g.id)).toContain(created.data!.id);

      const deleted = await deleteGoal(created.data!.id);
      expect(deleted.success).toBe(true);
      expect((await getGoals()).data).toHaveLength(0);
    });

    it('rejects invalid input via the Zod schema', async () => {
      const res = await createGoal({
        name: '',
        targetAmount: -5,
        currency: 'EUR',
        trackingMethod: 'manual',
      });
      expect(res.success).toBe(false);
      expect(res.error).toBeTruthy();
      expect(updateTag).not.toHaveBeenCalled();
    });

    it('accepts and persists goalType, priority, and injectIntoCashflow', async () => {
      const created = await createGoal({
        name: 'New sofa',
        targetAmount: 1200,
        currency: 'EUR',
        trackingMethod: 'account-balance',
        linkedAccountId: accountId,
        targetDate: '2026-12',
        goalType: 'spend',
        priority: 3,
        injectIntoCashflow: true,
      });
      expect(created.success).toBe(true);
      expect(created.data?.goalType).toBe('spend');
      expect(created.data?.priority).toBe(3);
      expect(created.data?.injectIntoCashflow).toBe(true);
    });

    it('rejects injectIntoCashflow without the required combo (goalType=spend + account-balance + targetDate)', async () => {
      const missingGoalType = await createGoal({
        name: 'Bad goal', targetAmount: 1000, currency: 'EUR',
        trackingMethod: 'account-balance', linkedAccountId: accountId, targetDate: '2026-12',
        injectIntoCashflow: true, // goalType defaults to 'reserve'
      });
      expect(missingGoalType.success).toBe(false);

      const missingTargetDate = await createGoal({
        name: 'Bad goal', targetAmount: 1000, currency: 'EUR',
        trackingMethod: 'account-balance', linkedAccountId: accountId,
        goalType: 'spend', injectIntoCashflow: true,
      });
      expect(missingTargetDate.success).toBe(false);

      const wrongTrackingMethod = await createGoal({
        name: 'Bad goal', targetAmount: 1000, currency: 'EUR',
        trackingMethod: 'net-worth', targetDate: '2026-12',
        goalType: 'spend', injectIntoCashflow: true,
      });
      expect(wrongTrackingMethod.success).toBe(false);
    });

    it('updates a legacy goal (no goalType stored) fine, without forcing a migration', async () => {
      const created = await createGoal({
        name: 'Legacy goal', targetAmount: 5000, currency: 'EUR', trackingMethod: 'manual', currentManualAmount: 100,
      });
      expect(created.success).toBe(true);
      expect(created.data?.goalType).toBeUndefined();

      const updated = await updateGoal(created.data!.id, { name: 'Legacy goal renamed' });
      expect(updated.success).toBe(true);
      expect(updated.data?.name).toBe('Legacy goal renamed');
      expect(updated.data?.goalType).toBeUndefined();
    });
  });

  describe('planned-item action (reimbursement chain)', () => {
    it('rejects a reimbursable item without an expected month', async () => {
      const res = await createPlannedItem(accountId, {
        type: 'expense',
        kind: 'one-off',
        name: 'Conference trip',
        amount: 500,
        scheduledDate: '2026-08',
        isReimbursable: true,
      });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/reimburs/i);
    });

    it('persists reimbursement fields end-to-end and defaults status to pending', async () => {
      const res = await createPlannedItem(accountId, {
        type: 'expense',
        kind: 'one-off',
        name: 'Conference trip',
        amount: 500,
        scheduledDate: '2026-08',
        isReimbursable: true,
        expectedReimbursementMonth: '2026-10',
      });
      expect(res.success).toBe(true);
      expect(updateTag).toHaveBeenCalledWith(`user:${userId}:account:${accountId}:planned`);

      const stored = (await getPlannedItems(userId, accountId)).find((i) => i.id === res.data!.id);
      expect(stored?.isReimbursable).toBe(true);
      expect(stored?.reimbursementStatus).toBe('pending');
      expect(stored?.expectedReimbursementMonth).toBe('2026-10');
    });

    it('returns Account not found for an account the user does not own', async () => {
      const res = await createPlannedItem('not-an-account', {
        type: 'expense',
        kind: 'one-off',
        name: 'X',
        amount: 1,
        scheduledDate: '2026-08',
      });
      expect(res.success).toBe(false);
      expect(res.error).toBe('Account not found');
    });
  });
});
