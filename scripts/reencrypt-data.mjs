// One-shot migration: re-encrypt every *.enc file into the fast HKDF key
// derivation, replacing the legacy per-file PBKDF2 (100k SHA-512 iterations)
// that dominated cold-load time.
//
//   node scripts/reencrypt-data.mjs [--dry-run]
//
// The read path in src/lib/db/encryption.ts is backward-compatible (it tries
// HKDF, then falls back to PBKDF2), so this migration is a *performance* warm-up,
// not a correctness requirement — the app reads old and new files either way.
// Running it once means every subsequent read hits the fast path.
//
// Safety:
//   - Idempotent: re-encrypting an already-HKDF file just re-derives with HKDF.
//   - Atomic per file: writes a temp file then renames over the original, so a
//     crash mid-run never leaves a half-written .enc.
//   - Never deletes data. TAKE A BACKUP FIRST anyway (snapshot the live data
//     dir; for a local copy, `cp -a data data.bak`).
//
// Key/dir resolution (mirrors the app + .claude/launch.json):
//   ENCRYPTION_KEY env, else <DATA_DIR>/.encryption_key file.
//   DATA_DIR env, else ./data.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;
const HKDF_INFO = Buffer.from('sampolio-file-encryption-v1'); // must match encryption.ts

const DRY_RUN = process.argv.includes('--dry-run');

function deriveKeyHkdf(password, salt) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(password, 'utf8'), salt, HKDF_INFO, KEY_LENGTH));
}
function deriveKeyPbkdf2(password, salt) {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha512');
}

function decryptWithKey(key, iv, tag, encrypted) {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** Returns { plaintext, wasLegacy } or throws if neither key works. */
function decrypt(password, encryptedData) {
  const combined = Buffer.from(encryptedData, 'base64');
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  try {
    return { plaintext: decryptWithKey(deriveKeyHkdf(password, salt), iv, tag, encrypted), wasLegacy: false };
  } catch {
    return { plaintext: decryptWithKey(deriveKeyPbkdf2(password, salt), iv, tag, encrypted), wasLegacy: true };
  }
}

function encrypt(password, data) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKeyHkdf(password, salt);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith('.enc')) yield full;
  }
}

async function resolveKey(dataDir) {
  if (process.env.ENCRYPTION_KEY) return process.env.ENCRYPTION_KEY;
  try {
    const fromFile = (await fs.readFile(path.join(dataDir, '.encryption_key'), 'utf8')).trim();
    if (fromFile) {
      console.warn(`ENCRYPTION_KEY not set; using ${path.join(dataDir, '.encryption_key')}`);
      return fromFile;
    }
  } catch {
    /* fall through */
  }
  console.error('ERROR: ENCRYPTION_KEY not set and no <DATA_DIR>/.encryption_key file found. Aborting to avoid corrupting data.');
  process.exit(1);
}

async function main() {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const password = await resolveKey(dataDir);
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Re-encrypting *.enc under: ${dataDir}`);

  let total = 0, migrated = 0, alreadyNew = 0, failed = 0;
  for await (const file of walk(dataDir)) {
    total++;
    let result;
    try {
      const content = await fs.readFile(file, 'utf8');
      result = decrypt(password, content);
    } catch (e) {
      failed++;
      console.error(`  FAILED to decrypt: ${file} — ${e.message}`);
      continue;
    }
    if (!result.wasLegacy) alreadyNew++;
    else migrated++;
    if (DRY_RUN) continue;
    try {
      const reencrypted = encrypt(password, result.plaintext);
      const tmp = `${file}.tmp-reencrypt`;
      await fs.writeFile(tmp, reencrypted, 'utf8');
      await fs.rename(tmp, file); // atomic on same filesystem
    } catch (e) {
      failed++;
      console.error(`  FAILED to write: ${file} — ${e.message}`);
    }
  }

  console.log('\nDone.');
  console.log(`  total .enc files : ${total}`);
  console.log(`  legacy → HKDF    : ${migrated}${DRY_RUN ? ' (would migrate)' : ''}`);
  console.log(`  already HKDF     : ${alreadyNew}${DRY_RUN ? '' : ' (re-written)'}`);
  console.log(`  failed           : ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
