import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { readEncryptedFile, writeEncryptedFile, encrypt, FORMAT_V2_PREFIX, getUserDir } from './encryption';
// The maintenance scripts' implementation of the same format (plain ESM).
import { encryptV2, decryptAny, relPathFor } from '../../../scripts/lib-file-crypto.mjs';
import { reencryptDataDir } from '../../../scripts/reencrypt-data.mjs';
import { rotateDataDir } from '../../../scripts/rotate-encryption-key.mjs';

/**
 * Format v2 binds each encrypted file to its data-dir-relative path (GCM
 * associated data), so a file copied over another user's or entity's file no
 * longer decrypts. v1 files stay readable unless ENCRYPTION_REQUIRE_PATH_BINDING
 * is on. The scripts' copy of the format must stay byte-compatible.
 */

const KEY = 'b'.repeat(64);
const quiet = { error: () => {}, log: () => {}, warn: () => {} } as unknown as Console;
let dataDir: string;

/** A legacy v1 PBKDF2 blob, exactly as pre-HKDF builds wrote it. */
function legacyPbkdf2Blob(plaintext: string, password = KEY): string {
  const salt = crypto.randomBytes(64);
  const iv = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha512');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([salt, iv, cipher.getAuthTag(), enc]).toString('base64');
}

beforeEach(async () => {
  dataDir = path.join(os.tmpdir(), `sampolio-v2-${process.pid}-${Math.random().toString(36).slice(2)}`);
  process.env.DATA_DIR = dataDir;
  process.env.ENCRYPTION_KEY = KEY;
  delete process.env.ENCRYPTION_REQUIRE_PATH_BINDING;
});

afterEach(async () => {
  delete process.env.ENCRYPTION_REQUIRE_PATH_BINDING;
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe('format v2', () => {
  it('every write is v2', async () => {
    const file = path.join(getUserDir('alex-id'), 'user.enc');
    await writeEncryptedFile(file, { name: 'Alex' });
    expect((await fs.readFile(file, 'utf8')).startsWith(FORMAT_V2_PREFIX)).toBe(true);
    expect(await readEncryptedFile(file)).toEqual({ name: 'Alex' });
  });

  it('a file copied to another user’s or entity’s path no longer decrypts', async () => {
    const alex = path.join(getUserDir('alex-id'), 'user.enc');
    const sam = path.join(getUserDir('sam-id'), 'user.enc');
    await writeEncryptedFile(alex, { name: 'Alex', role: 'user' });
    await writeEncryptedFile(sam, { name: 'Sam', role: 'admin' });
    await fs.copyFile(alex, sam); // swap attempt
    await expect(readEncryptedFile(sam)).rejects.toThrow();

    const goalA = path.join(getUserDir('alex-id'), 'goals', 'goal-a.enc');
    const goalB = path.join(getUserDir('alex-id'), 'goals', 'goal-b.enc');
    await writeEncryptedFile(goalA, { target: 1 });
    await fs.mkdir(path.dirname(goalB), { recursive: true });
    await fs.copyFile(goalA, goalB);
    await expect(readEncryptedFile(goalB)).rejects.toThrow();
  });

  it('a v2 file is still readable after copying the whole data tree elsewhere (prod → ./data)', async () => {
    const file = path.join(getUserDir('alex-id'), 'accounts', 'acc-1.enc');
    await writeEncryptedFile(file, { balance: 1550.55 });
    const copy = `${dataDir}-copy`;
    await fs.cp(dataDir, copy, { recursive: true });
    process.env.DATA_DIR = copy;
    expect(await readEncryptedFile(path.join(copy, 'users', 'alex-id', 'accounts', 'acc-1.enc'))).toEqual({ balance: 1550.55 });
    await fs.rm(copy, { recursive: true, force: true });
  });

  it('reads v1 files (HKDF and legacy PBKDF2) unless path binding is required', async () => {
    const hkdfFile = path.join(dataDir, 'v1-hkdf.enc');
    const pbkdf2File = path.join(dataDir, 'v1-pbkdf2.enc');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(hkdfFile, encrypt(JSON.stringify({ v: 'hkdf' })));
    await fs.writeFile(pbkdf2File, legacyPbkdf2Blob(JSON.stringify({ v: 'pbkdf2' })));
    expect(await readEncryptedFile(hkdfFile)).toEqual({ v: 'hkdf' });
    expect(await readEncryptedFile(pbkdf2File)).toEqual({ v: 'pbkdf2' });

    process.env.ENCRYPTION_REQUIRE_PATH_BINDING = 'true';
    await expect(readEncryptedFile(hkdfFile)).rejects.toThrow(/unbound/i);
    await expect(readEncryptedFile(pbkdf2File)).rejects.toThrow(/unbound/i);
  });

  it('a v1 file upgrades to v2 on its next write', async () => {
    const file = path.join(dataDir, 'app-settings.enc');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(file, encrypt(JSON.stringify({ a: 1 })));
    const value = await readEncryptedFile<{ a: number }>(file);
    await writeEncryptedFile(file, { ...value, b: 2 });
    expect((await fs.readFile(file, 'utf8')).startsWith(FORMAT_V2_PREFIX)).toBe(true);
    process.env.ENCRYPTION_REQUIRE_PATH_BINDING = 'true';
    expect(await readEncryptedFile(file)).toEqual({ a: 1, b: 2 });
  });
});

describe('maintenance scripts share the format', () => {
  it('the app reads what the scripts write, and the scripts read what the app writes', async () => {
    const file = path.join(getUserDir('alex-id'), 'preferences.enc');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, encryptV2(KEY, JSON.stringify({ from: 'script' }), relPathFor(dataDir, file)));
    expect(await readEncryptedFile(file)).toEqual({ from: 'script' });

    await writeEncryptedFile(file, { from: 'app' });
    const res = decryptAny(KEY, await fs.readFile(file, 'utf8'), relPathFor(dataDir, file));
    expect(res.format).toBe('v2');
    expect(JSON.parse(res.plaintext)).toEqual({ from: 'app' });
    expect(() => decryptAny(KEY, encryptV2(KEY, 'x', 'users/a/user.enc'), 'users/b/user.enc')).toThrow();
  });

  it('reencrypt-data upgrades every v1 file to v2', async () => {
    const a = path.join(dataDir, 'users', 'alex-id', 'user.enc');
    const b = path.join(dataDir, 'users-index.enc');
    const c = path.join(dataDir, 'app-settings.enc');
    await fs.mkdir(path.dirname(a), { recursive: true });
    await fs.writeFile(a, legacyPbkdf2Blob('{"n":1}'));
    await fs.writeFile(b, encrypt('{"n":2}'));
    await writeEncryptedFile(c, { n: 3 });

    const counts = await reencryptDataDir(dataDir, KEY, { log: quiet });
    expect(counts).toMatchObject({ total: 3, v1Pbkdf2: 1, v1Hkdf: 1, v2: 1, failed: 0 });
    process.env.ENCRYPTION_REQUIRE_PATH_BINDING = 'true';
    expect(await readEncryptedFile(a)).toEqual({ n: 1 });
    expect(await readEncryptedFile(b)).toEqual({ n: 2 });
    expect(await readEncryptedFile(c)).toEqual({ n: 3 });
    const mode = (await fs.stat(a)).mode & 0o777;
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
  });

  it('rotate-encryption-key moves every format to the new key as v2, and resumes safely', async () => {
    const a = path.join(dataDir, 'users', 'alex-id', 'user.enc');
    const b = path.join(dataDir, 'users-index.enc');
    await fs.mkdir(path.dirname(a), { recursive: true });
    await fs.writeFile(a, legacyPbkdf2Blob('{"n":1}'));
    await writeEncryptedFile(b, { n: 2 });

    const NEW = 'c'.repeat(64);
    const first = await rotateDataDir(dataDir, KEY, NEW, { log: quiet });
    expect(first).toMatchObject({ total: 2, rotated: 2, failed: 0 });
    const again = await rotateDataDir(dataDir, KEY, NEW, { log: quiet });
    expect(again).toMatchObject({ rotated: 0, alreadyNewKey: 2, failed: 0 });

    process.env.ENCRYPTION_KEY = NEW;
    process.env.ENCRYPTION_REQUIRE_PATH_BINDING = 'true';
    expect(await readEncryptedFile(a)).toEqual({ n: 1 });
    expect(await readEncryptedFile(b)).toEqual({ n: 2 });
  });
});
