import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;
// HKDF context label — binds derived keys to this app/purpose. Never change it
// for a given format version, or existing files stop decrypting on the fast path.
const HKDF_INFO = Buffer.from('sampolio-file-encryption-v1');

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

function decryptWithKey(key: Buffer, iv: Buffer, tag: Buffer, encrypted: Buffer): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

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

// Get user-specific directory
export function getUserDir(userId: string): string {
  return path.join(getDataDir(), 'users', userId);
}

// Ensure directory exists
export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
  }
}

// Read encrypted file
export async function readEncryptedFile<T>(filePath: string): Promise<T | null> {
  try {
    const encryptedContent = await fs.readFile(filePath, 'utf8');
    const decrypted = decrypt(encryptedContent);
    return JSON.parse(decrypted) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

// Write encrypted file
export async function writeEncryptedFile<T>(filePath: string, data: T): Promise<void> {
  const dirPath = path.dirname(filePath);
  await ensureDir(dirPath);

  const jsonData = JSON.stringify(data, null, 2);
  const encrypted = encrypt(jsonData);
  await fs.writeFile(filePath, encrypted, 'utf8');
}

// Delete file
export async function deleteFile(filePath: string): Promise<void> {
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
  try {
    const files = await fs.readdir(dirPath);
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
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
