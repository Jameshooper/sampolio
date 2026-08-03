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
  const preferences = await import('@/lib/db/user-preferences');
  const splitGroups = await import('@/lib/db/split-groups');
  return {
    cachedGetUserPreferences: preferences.getUserPreferences,
    cachedGetSplitGroupsForUser: splitGroups.getSplitGroupsForUser,
  };
});

import { auth } from '@/lib/auth';
import { updateTag } from 'next/cache';
import { getUserPreferences, updateBottomNavIds } from './user-preferences';

const mockAuth = vi.mocked(auth);
const userId = 'prefs-action-test-user';

describe('user-preferences actions: updateBottomNavIds', () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = path.join(os.tmpdir(), `sampolio-prefs-actions-test-${process.pid}`);
    process.env.DATA_DIR = dataDir;
  });

  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockAuth.mockResolvedValue({ user: { id: userId } } as any);
  });

  it('rejects without a session', async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await updateBottomNavIds(['home'])).error).toBe('Unauthorized');
    expect(updateTag).not.toHaveBeenCalled();
  });

  it('rejects unknown ids, an empty list and more than four tabs, writing nothing', async () => {
    expect((await updateBottomNavIds(['nope'])).error).toBe('Invalid navigation tabs');
    expect((await updateBottomNavIds([])).error).toBe('Invalid navigation tabs');
    expect(
      (await updateBottomNavIds(['home', 'split', 'overview', 'cashflow', 'goals'])).error
    ).toBe('Invalid navigation tabs');
    expect(updateTag).not.toHaveBeenCalled();
    expect((await getUserPreferences()).data?.bottomNavIds).toBeUndefined();
  });

  it('persists a valid list in order and invalidates the preferences tag', async () => {
    const result = await updateBottomNavIds(['goals', 'home']);
    expect(result.success).toBe(true);
    expect(result.data?.bottomNavIds).toEqual(['goals', 'home']);
    expect(updateTag).toHaveBeenCalledWith(`user:${userId}:preferences`);

    const roundtrip = await getUserPreferences();
    expect(roundtrip.data?.bottomNavIds).toEqual(['goals', 'home']);
  });

  it('dedupes repeated ids, keeping the first occurrence', async () => {
    const result = await updateBottomNavIds(['home', 'home', 'split']);
    expect(result.success).toBe(true);
    expect(result.data?.bottomNavIds).toEqual(['home', 'split']);
  });

  it('clears the preference on null (back to per-mode defaults)', async () => {
    await updateBottomNavIds(['bank', 'mortgage']);
    expect((await getUserPreferences()).data?.bottomNavIds).toEqual(['bank', 'mortgage']);

    const cleared = await updateBottomNavIds(null);
    expect(cleared.success).toBe(true);
    expect((await getUserPreferences()).data?.bottomNavIds).toBeUndefined();
  });
});
