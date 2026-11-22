import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  assertSafeId,
  isSafeId,
  assertInsideDataDir,
  getUserDir,
  readEncryptedFile,
  writeEncryptedFile,
  deleteFile,
  listFiles,
  encrypt,
  decrypt,
} from './encryption';
import { createUser, findUserById } from './users';
import { getBudgetById, deleteBudget, updateBudget } from './budgets';
import { getGoalById } from './goals';
import { getAccountById } from './accounts';
import { getMortgageById } from './shared-mortgages';
import { getSplitGroupById } from './split-groups';
import { getBankTransactions } from './bank-transactions';
import { writeUserDataFromExport } from './data-transfer';
import { dataExportSchema, type DataExport } from '@/lib/schemas/data-transfer.schema';

/**
 * Regression tests for the path-traversal findings: client-supplied record ids
 * were joined straight into file paths, so `updateBudget('../../../users-index')`
 * read the global user index and `importUserData` with `id: '../user'` overwrote
 * the caller's own account record (making them admin). Ids must be single safe
 * path segments everywhere, and no I/O may leave the data directory.
 */

const TRAVERSAL_IDS = ['../user', '../../x/user', '..', '.', 'a/b', 'a\\b', '', ' ', 'x'.repeat(65), '%2e%2e', 'id\u0000'];

describe('path safety', () => {
  let dataDir: string;
  let alexId: string;
  let samId: string;

  beforeAll(async () => {
    dataDir = path.join(os.tmpdir(), `sampolio-path-safety-${process.pid}`);
    process.env.DATA_DIR = dataDir;
    alexId = (await createUser('alex@example.com', 'Str0ng!Pass', 'Alex')).id;
    samId = (await createUser('sam@example.com', 'Str0ng!Pass', 'Sam')).id;
  });

  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('accepts uuid-like ids and YYYY-MM chunk names, rejects everything else', () => {
    expect(isSafeId('8f14e45f-ceea-467a-9a3b-2d7c1a0f5e11')).toBe(true);
    expect(isSafeId('2026-03')).toBe(true);
    expect(isSafeId('action-test-user')).toBe(true);
    for (const id of TRAVERSAL_IDS) {
      expect(isSafeId(id), JSON.stringify(id)).toBe(false);
      expect(() => assertSafeId(id)).toThrow(/Invalid/);
    }
    expect(isSafeId(undefined)).toBe(false);
    expect(isSafeId(42)).toBe(false);
  });

  it('getUserDir rejects traversal user ids', () => {
    expect(() => getUserDir('../../etc')).toThrow(/Invalid user id/);
    expect(getUserDir(samId)).toBe(path.join(dataDir, 'users', samId));
  });

  it('I/O helpers refuse paths outside the data directory', async () => {
    const outside = path.join(os.tmpdir(), `outside-${process.pid}.enc`);
    expect(() => assertInsideDataDir(outside)).toThrow(/escapes/);
    await expect(readEncryptedFile(outside)).rejects.toThrow(/escapes/);
    await expect(writeEncryptedFile(outside, { a: 1 })).rejects.toThrow(/escapes/);
    await expect(deleteFile(outside)).rejects.toThrow(/escapes/);
    await expect(listFiles(os.tmpdir())).rejects.toThrow(/escapes/);
  });

  it('entity reads with traversal ids cannot reach another user’s files', async () => {
    const victim = `../../${alexId}/user`;
    await expect(getBudgetById(samId, victim)).rejects.toThrow(/Invalid/);
    await expect(getBudgetById(samId, '../../../users-index')).rejects.toThrow(/Invalid/);
    await expect(getGoalById(samId, victim)).rejects.toThrow(/Invalid/);
    await expect(getAccountById(samId, victim)).rejects.toThrow(/Invalid/);
    await expect(getMortgageById(`../../users/${alexId}/user`)).rejects.toThrow(/Invalid/);
    await expect(getSplitGroupById(`../../users/${alexId}/user`)).rejects.toThrow(/Invalid/);
    await expect(getBankTransactions(samId, `../../../${alexId}`)).rejects.toThrow(/Invalid/);
    await expect(updateBudget(samId, '../../../users-index', {})).rejects.toThrow(/Invalid/);
    expect(await findUserById('../users-index')).toBeNull();
  });

  it('entity deletes with traversal ids leave the user index intact', async () => {
    await expect(deleteBudget(samId, '../../../users-index')).rejects.toThrow(/Invalid/);
    await expect(fs.access(path.join(dataDir, 'users-index.enc'))).resolves.toBeUndefined();
    expect((await findUserById(alexId))?.email).toBe('alex@example.com');
  });

  describe('backup import', () => {
    const exportWith = (goal: Record<string, unknown>, preferences: Record<string, unknown> | null = null) => ({
      format: 'sampolio-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      userId: 'x',
      notIncluded: [],
      entities: {
        accounts: [],
        investments: [],
        debts: [],
        receivables: [],
        goals: [goal],
        budgets: [],
        reconciliation: { snapshots: [], adjustments: [], sessions: [] },
        preferences,
      },
    });

    it('the schema rejects path-shaped record ids', () => {
      for (const id of ['../user', `../../${'a'.repeat(36)}/user`, 'a/b']) {
        expect(dataExportSchema.safeParse(exportWith({ id, name: 'g' })).success).toBe(false);
      }
      expect(dataExportSchema.safeParse(exportWith({ id: 'goal-1', name: 'g' })).success).toBe(true);
    });

    it('the schema rejects account fields smuggled in through preferences', () => {
      const parsed = dataExportSchema.safeParse(exportWith({ id: 'goal-1' }, { passwordHash: 'x', role: 'admin' }));
      expect(parsed.success).toBe(false);
    });

    it('the writer refuses traversal ids even if the schema were bypassed', async () => {
      const payload = exportWith({ id: '../user', role: 'admin', passwordHash: 'x' }) as unknown as DataExport;
      await expect(writeUserDataFromExport(samId, payload, 'merge')).rejects.toThrow(/Invalid/);
      const sam = await findUserById(samId);
      expect(sam?.role).toBe('user');
      expect(sam?.id).toBe(samId);
    });
  });

  it('writes are atomic and private (0600 files, 0700 dirs, no temp files left)', async () => {
    const file = path.join(getUserDir(samId), 'probe', 'probe.enc');
    await writeEncryptedFile(file, { hello: 'world' });
    const fileMode = (await fs.stat(file)).mode & 0o777;
    const dirMode = (await fs.stat(path.dirname(file))).mode & 0o777;
    if (process.platform !== 'win32') {
      expect(fileMode).toBe(0o600);
      expect(dirMode).toBe(0o700);
    }
    expect((await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(await readEncryptedFile(file)).toEqual({ hello: 'world' });
  });

  it('rejects ciphertext with a truncated auth tag', () => {
    process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
    const good = Buffer.from(encrypt('{"a":1}'), 'base64');
    // salt(64) + iv(16) + 4-byte tag only
    const truncated = good.subarray(0, 64 + 16 + 4).toString('base64');
    expect(() => decrypt(truncated)).toThrow();
  });
});
