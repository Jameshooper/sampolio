// Shared encrypted-file format for the maintenance scripts
// (reencrypt-data.mjs, rotate-encryption-key.mjs). Must stay byte-compatible
// with src/lib/db/encryption.ts — src/lib/db/file-format-v2.test.ts checks
// that files written here are read by the app and vice versa.
//
// Formats (every file: salt(64) | iv(16) | tag(16) | ciphertext, AES-256-GCM):
//   v2  "sv2:" + base64(...)  key = HKDF-SHA256(ENCRYPTION_KEY, salt, "sampolio-file-encryption-v2")
//       with GCM associated data "sampolio:v2:<path relative to DATA_DIR, '/'-separated>",
//       so a file only decrypts at the path it was written for.
//   v1  base64(...)           key = HKDF-SHA256(..., "sampolio-file-encryption-v1"), no AAD
//   v1  base64(...)           legacy key = PBKDF2-SHA512(ENCRYPTION_KEY, salt, 100k)

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;
const HKDF_INFO_V1 = Buffer.from('sampolio-file-encryption-v1');
const HKDF_INFO_V2 = Buffer.from('sampolio-file-encryption-v2');
export const V2_PREFIX = 'sv2:';

function hkdf(password, salt, info) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(password, 'utf8'), salt, info, KEY_LENGTH));
}

function split(buf) {
  if (buf.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH) throw new Error('Invalid ciphertext');
  return {
    salt: buf.subarray(0, SALT_LENGTH),
    iv: buf.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH),
    tag: buf.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH),
    encrypted: buf.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH),
  };
}

function open(key, iv, tag, encrypted, aad) {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** Data-dir-relative, '/'-separated path: the identity a v2 file is bound to. */
export function relPathFor(dataDir, file) {
  return path.relative(path.resolve(dataDir), path.resolve(file)).split(path.sep).join('/');
}

export function aadFor(relPath) {
  return Buffer.from(`sampolio:v2:${relPath}`, 'utf8');
}

/** Encrypt in the current (v2) format for the file at `relPath`. */
export function encryptV2(password, data, relPath) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, hkdf(password, salt, HKDF_INFO_V2), iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(aadFor(relPath));
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  return V2_PREFIX + Buffer.concat([salt, iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

/**
 * Decrypt any supported format. Returns { plaintext, format } where format is
 * 'v2' | 'v1-hkdf' | 'v1-pbkdf2'; throws when the key (or, for v2, the path) is wrong.
 */
export function decryptAny(password, content, relPath) {
  if (content.startsWith(V2_PREFIX)) {
    const { salt, iv, tag, encrypted } = split(Buffer.from(content.slice(V2_PREFIX.length), 'base64'));
    return { plaintext: open(hkdf(password, salt, HKDF_INFO_V2), iv, tag, encrypted, aadFor(relPath)), format: 'v2' };
  }
  const { salt, iv, tag, encrypted } = split(Buffer.from(content, 'base64'));
  try {
    return { plaintext: open(hkdf(password, salt, HKDF_INFO_V1), iv, tag, encrypted), format: 'v1-hkdf' };
  } catch {
    const legacy = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha512');
    return { plaintext: open(legacy, iv, tag, encrypted), format: 'v1-pbkdf2' };
  }
}

/** Atomic private replace: 0600 temp file in the same directory, fsync, rename. */
export async function writeAtomic(file, contents) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

export async function* walkEncFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkEncFiles(full);
    else if (entry.isFile() && entry.name.endsWith('.enc')) yield full;
  }
}

/**
 * The current key, resolved like scripts/lib-secrets.sh: ENCRYPTION_KEY env,
 * then <SAMPOLIO_SECRETS_DIR or ~/.sampolio/secrets>/encryption_key, then the
 * legacy <DATA_DIR>/.encryption_key. Returns null when none is found.
 */
export async function resolveEncryptionKey(dataDir) {
  if (process.env.ENCRYPTION_KEY) return process.env.ENCRYPTION_KEY;
  const secretsDir = process.env.SAMPOLIO_SECRETS_DIR || path.join(os.homedir(), '.sampolio', 'secrets');
  for (const file of [path.join(secretsDir, 'encryption_key'), path.join(dataDir, '.encryption_key')]) {
    try {
      const value = (await fs.readFile(file, 'utf8')).trim();
      if (value) {
        console.warn(`ENCRYPTION_KEY not set; using ${file}`);
        return value;
      }
    } catch {
      /* try the next location */
    }
  }
  return null;
}

/** True when this module is the entry point (so importing a script for tests doesn't run it). */
export function isMain(importMetaUrl) {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(importMetaUrl);
}
