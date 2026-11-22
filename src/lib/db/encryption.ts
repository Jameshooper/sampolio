import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;
// HKDF context labels — bind derived keys to this app/purpose and format
// version. Never change one, or files in that format stop decrypting.
const HKDF_INFO = Buffer.from('sampolio-file-encryption-v1');
const HKDF_INFO_V2 = Buffer.from('sampolio-file-encryption-v2');

// File formats (every one is salt(64) | iv(16) | tag(16) | ciphertext):
//   v2  "sv2:" + base64 — HKDF(v2 label) key, and the file's path relative to
//       DATA_DIR authenticated as GCM associated data, so a file decrypts only
//       at the path it was written for (swapping .enc files between users or
//       entities fails). Every write uses v2.
//   v1  base64 — HKDF(v1 label) or legacy PBKDF2 key, no associated data. Read
//       for compatibility unless ENCRYPTION_REQUIRE_PATH_BINDING=true.
// scripts/lib-file-crypto.mjs implements the same formats for the maintenance
// scripts; src/lib/db/file-format-v2.test.ts keeps the two in step.
export const FORMAT_V2_PREFIX = 'sv2:';

// Get the encryption key from the environment. In production a missing key is
// a hard failure: falling back to the publicly known default would silently
// encrypt real data with a compromised key. Called lazily at request time, so
// `next build` never needs the key.
function getEncryptionKey(): string {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY must be set in production — refusing to fall back to the default key.');
    }
    // Development-only convenience fallback.
    console.warn('ENCRYPTION_KEY not set, using default dev key. Set ENCRYPTION_KEY in production!');
    return 'sampolio-default-encryption-key-change-in-prod';
  }
  return key;
}

// Per-file key derivation.
//
// ENCRYPTION_KEY is already a full-entropy 256-bit key, NOT a low-entropy
// password. PBKDF2's whole purpose is to make brute-forcing a *weak* password
// expensive; running 100k SHA-512 iterations over an already-strong key buys
// zero extra security while blocking the event loop ~50-150ms per file — and
// because every file has a unique random salt, that cost is paid on *every*
// read (the salt-keyed cache below almost never hits). A cold page load
// decrypts 150-200 files, so this dominated initial-load time.
//
// New writes derive the per-file key with HKDF-SHA256 (a single HMAC,
// ~microseconds) — the standard KDF for high-entropy input key material. The
// random per-file salt is kept so identical plaintext still yields distinct
// ciphertext. The file format (salt|iv|tag|ciphertext) is unchanged, so only
// the derivation differs between old and new files; decrypt() disambiguates
// via GCM authentication (see below).

function deriveKeyHkdf(password: string, salt: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(password, 'utf8'), salt, HKDF_INFO, KEY_LENGTH),
  );
}

// LRU cache for the legacy PBKDF2 keys — avoids re-running the expensive
// derivation when the same old-format file is read twice before it is migrated.
const DERIVED_KEY_CACHE_MAX = 500;
const derivedKeyCache = new Map<string, Buffer>();

function deriveKeyPbkdf2(password: string, salt: Buffer): Buffer {
  const cacheKey = salt.toString('hex');
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const key = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha512');
  // Simple LRU: evict oldest entry when cache is full
  if (derivedKeyCache.size >= DERIVED_KEY_CACHE_MAX) {
    const oldestKey = derivedKeyCache.keys().next().value;
    if (oldestKey) derivedKeyCache.delete(oldestKey);
  }
  derivedKeyCache.set(cacheKey, key);
  return key;
}

function decryptWithKey(key: Buffer, iv: Buffer, tag: Buffer, encrypted: Buffer, aad?: Buffer): string {
  // Pin the tag length: without it Node accepts truncated (4–15 byte) tags,
  // weakening GCM's integrity guarantee for a short or damaged file.
  if (tag.length !== TAG_LENGTH) {
    throw new Error('Invalid ciphertext');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/** Legacy v1 (no path binding). Kept for compatibility tests; writes use encryptForPath. */
export function encrypt(data: string): string {
  const password = getEncryptionKey();
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKeyHkdf(password, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Combine salt + iv + tag + encrypted data
  const combined = Buffer.concat([salt, iv, tag, encrypted]);
  return combined.toString('base64');
}

/** Decrypt a v1 file (HKDF, then legacy PBKDF2). */
export function decrypt(encryptedData: string): string {
  const password = getEncryptionKey();
  const combined = Buffer.from(encryptedData, 'base64');

  // Extract components
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  // Fast path: HKDF (the format all new writes use). GCM authentication makes
  // the key choice unambiguous — a wrong key fails the auth tag — so we can try
  // the fast derivation first and fall back to the legacy PBKDF2 derivation
  // only for files written before the migration. Forging a GCM tag is
  // infeasible, so a successful decrypt means the key (hence the format) matched.
  try {
    return decryptWithKey(deriveKeyHkdf(password, salt), iv, tag, encrypted);
  } catch {
    // Legacy fallback: the expensive PBKDF2 derivation. Only reached for
    // not-yet-migrated files; the wasted HKDF attempt above cost microseconds.
    return decryptWithKey(deriveKeyPbkdf2(password, salt), iv, tag, encrypted);
  }
}

// Get the data directory path
export function getDataDir(): string {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return dataDir;
}

/** A file's identity for v2: its path relative to DATA_DIR, '/'-separated so a
 * data copy moves between macOS/Linux/Windows hosts unchanged. */
export function dataRelativePath(filePath: string): string {
  return path
    .relative(path.resolve(/*turbopackIgnore: true*/ getDataDir()), path.resolve(/*turbopackIgnore: true*/ filePath))
    .split(path.sep)
    .join('/');
}

function aadFor(relativePath: string): Buffer {
  return Buffer.from(`sampolio:v2:${relativePath}`, 'utf8');
}

function requirePathBinding(): boolean {
  return process.env.ENCRYPTION_REQUIRE_PATH_BINDING === 'true';
}

/** Encrypt `data` in format v2 for the file at `filePath`. */
export function encryptForPath(data: string, filePath: string): string {
  const password = getEncryptionKey();
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(password, 'utf8'), salt, HKDF_INFO_V2, KEY_LENGTH));
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(aadFor(dataRelativePath(filePath)));
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  return FORMAT_V2_PREFIX + Buffer.concat([salt, iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

/** Decrypt the contents of the file at `filePath` (v2 bound to that path, or v1). */
export function decryptForPath(content: string, filePath: string): string {
  if (content.startsWith(FORMAT_V2_PREFIX)) {
    const combined = Buffer.from(content.slice(FORMAT_V2_PREFIX.length), 'base64');
    if (combined.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH) throw new Error('Invalid ciphertext');
    const salt = combined.subarray(0, SALT_LENGTH);
    const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const key = Buffer.from(
      crypto.hkdfSync('sha256', Buffer.from(getEncryptionKey(), 'utf8'), salt, HKDF_INFO_V2, KEY_LENGTH)
    );
    // A wrong key OR a file moved from another path fails authentication here.
    return decryptWithKey(key, iv, tag, encrypted, aadFor(dataRelativePath(filePath)));
  }
  if (requirePathBinding()) {
    throw new Error(`Refusing unbound (v1) encrypted file ${dataRelativePath(filePath)} — ENCRYPTION_REQUIRE_PATH_BINDING is on`);
  }
  return decrypt(content);
}

// ==================== Path safety ====================
//
// Every record id ends up as a file or directory name. Ids are generated by the
// app (uuid v4; split expense chunks use YYYY-MM), so a single safe path
// segment is all that is ever legitimate. Validating at every path builder
// stops `../` traversal into another user's directory (which stays inside the
// data dir, so a containment check alone would not catch it); the containment
// check in the I/O helpers below is the second, independent layer.

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** True when `id` is usable as a single file/directory name. */
export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID_RE.test(id);
}

/** Returns `id` unchanged, or throws when it is not a single safe path segment. */
export function assertSafeId(id: unknown, what = 'id'): string {
  if (!isSafeId(id)) {
    throw new InvalidIdError(what);
  }
  return id;
}

export class InvalidIdError extends Error {
  constructor(what: string) {
    super(`Invalid ${what}`);
    this.name = 'InvalidIdError';
  }
}

/** Throws unless `filePath` resolves inside the data directory. */
export function assertInsideDataDir(filePath: string): string {
  const root = path.resolve(/*turbopackIgnore: true*/ getDataDir());
  const full = path.resolve(/*turbopackIgnore: true*/ filePath);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('Path escapes the data directory');
  }
  return full;
}

// Get user-specific directory
export function getUserDir(userId: string): string {
  return path.join(getDataDir(), 'users', assertSafeId(userId, 'user id'));
}

// Data files hold financial records: keep them private to the service account
// (the ciphertext is useless without the key, but there is no reason to expose it).
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Ensure directory exists
export async function ensureDir(dirPath: string): Promise<void> {
  assertInsideDataDir(dirPath);
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true, mode: DIR_MODE });
  }
}

// ==================== In-process file locks ====================
//
// File writes are read-modify-write. Two concurrent requests that both read,
// modify and write the same file lose one update (observed: 5 of 20 parallel
// snapshot writes survived). `withFileLock` serialises callers per file path
// within this Node process. It is not reentrant and not cross-process; the app
// runs as a single `next start` process (see docs/known-gaps.md).

// Kept on globalThis: Next bundles route handlers and server actions as
// separate module instances in the same process, and a per-module Map would
// give each its own (useless) lock table.
const fileLocks: Map<string, Promise<unknown>> = ((globalThis as { __sampolioFileLocks?: Map<string, Promise<unknown>> })
  .__sampolioFileLocks ??= new Map());

export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = fileLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  fileLocks.set(key, tail);
  void tail.then(() => {
    if (fileLocks.get(key) === tail) fileLocks.delete(key);
  });
  return run;
}

/**
 * Wrap a mutating DB function so calls sharing a lock key (derived from the
 * first argument — usually the file or directory it rewrites) run one at a time. The wrapped function must not call
 * another function serialized on the same key (the lock is not reentrant).
 */
export function serialized<A extends [unknown, ...unknown[]], R>(
  lockKeyOf: (first: NoInfer<A[0]>) => string,
  fn: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return (...args: A) => withFileLock(lockKeyOf(args[0]), () => fn(...args));
}

/** Locked read-modify-write of one encrypted JSON file. */
export async function updateEncryptedFile<T>(
  filePath: string,
  mutate: (current: T | null) => T | Promise<T>
): Promise<T> {
  return withFileLock(filePath, async () => {
    const current = await readEncryptedFile<T>(filePath);
    const next = await mutate(current);
    await writeEncryptedFile(filePath, next);
    return next;
  });
}

// Read encrypted file
export async function readEncryptedFile<T>(filePath: string): Promise<T | null> {
  assertInsideDataDir(filePath);
  try {
    const encryptedContent = await fs.readFile(filePath, 'utf8');
    const decrypted = decryptForPath(encryptedContent, filePath);
    return JSON.parse(decrypted) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

// Write encrypted file
//
// Atomic: write a private temp file in the same directory, fsync it, then
// rename over the target. A crash or full disk mid-write leaves the previous
// version intact instead of a truncated file that no longer decrypts.
export async function writeEncryptedFile<T>(filePath: string, data: T): Promise<void> {
  assertInsideDataDir(filePath);
  const dirPath = path.dirname(filePath);
  await ensureDir(dirPath);

  const jsonData = JSON.stringify(data, null, 2);
  // Bound to the final path (not the temp file writeFileAtomic renames from).
  const encrypted = encryptForPath(jsonData, filePath);
  await writeFileAtomic(filePath, encrypted);
}

/** Atomic private write (temp file + fsync + rename) for any data-dir file. */
export async function writeFileAtomic(filePath: string, contents: string | Buffer): Promise<void> {
  assertInsideDataDir(filePath);
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(tmpPath, 'wx', FILE_MODE);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.rm(tmpPath, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true });
    throw error;
  }
}

// Delete file
export async function deleteFile(filePath: string): Promise<void> {
  assertInsideDataDir(filePath);
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

// List files in directory
export async function listFiles(dirPath: string): Promise<string[]> {
  assertInsideDataDir(dirPath);
  try {
    // Hide in-flight/abandoned atomic-write temp files from directory scans.
    const files = (await fs.readdir(dirPath)).filter((f) => !f.endsWith('.tmp'));
    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

// Check if file exists
export async function fileExists(filePath: string): Promise<boolean> {
  assertInsideDataDir(filePath);
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
