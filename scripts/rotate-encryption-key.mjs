// Key rotation: decrypt every *.enc file with the OLD key and re-encrypt it
// with the NEW key (HKDF format). Complements scripts/reencrypt-data.mjs,
// which re-encrypts with the SAME key (format migration only).
//
//   OLD_ENCRYPTION_KEY=<old> ENCRYPTION_KEY=<new> node scripts/rotate-encryption-key.mjs [--dry-run]
//
// Key/dir resolution:
//   OLD_ENCRYPTION_KEY env (required).
//   ENCRYPTION_KEY env, else <DATA_DIR>/.encryption_key file (the NEW key —
//     update the dot-file to the new key BEFORE running, or pass the env var).
//   DATA_DIR env, else ./data.
//
// Safety:
//   - Refuses to run when old and new keys are identical (use reencrypt-data.mjs).
//   - Atomic per file: writes a temp file then renames over the original.
//   - Old-key decryption is backward-compatible (tries HKDF, then legacy PBKDF2).
//   - Never deletes data — but a crash mid-run leaves the tree MIXED between
//     keys, so TAKE A BACKUP FIRST (`cp -a data data.bak`) and, on prod data,
//     stop the app while rotating. Re-running with the same env is safe: files
//     already rotated fail old-key decryption and are counted, not corrupted.

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

/** Decrypt with a given password (HKDF first, PBKDF2 fallback) or throw. */
function decrypt(password, encryptedData) {
  const combined = Buffer.from(encryptedData, 'base64');
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  try {
    return decryptWithKey(deriveKeyHkdf(password, salt), iv, tag, encrypted);
  } catch {
    return decryptWithKey(deriveKeyPbkdf2(password, salt), iv, tag, encrypted);
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

async function resolveNewKey(dataDir) {
  if (process.env.ENCRYPTION_KEY) return process.env.ENCRYPTION_KEY;
  try {
    const fromFile = (await fs.readFile(path.join(dataDir, '.encryption_key'), 'utf8')).trim();
    if (fromFile) {
      console.warn(`ENCRYPTION_KEY not set; using ${path.join(dataDir, '.encryption_key')} as the NEW key`);
      return fromFile;
    }
  } catch {
    /* fall through */
  }
  console.error('ERROR: ENCRYPTION_KEY (the NEW key) not set and no <DATA_DIR>/.encryption_key file found. Aborting.');
  process.exit(1);
}

async function main() {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const oldKey = process.env.OLD_ENCRYPTION_KEY;
  if (!oldKey) {
    console.error('ERROR: OLD_ENCRYPTION_KEY not set. Aborting.');
    process.exit(1);
  }
  const newKey = await resolveNewKey(dataDir);
  if (oldKey === newKey) {
    console.error('ERROR: OLD_ENCRYPTION_KEY and ENCRYPTION_KEY are identical — nothing to rotate. Use scripts/reencrypt-data.mjs for a format migration.');
    process.exit(1);
  }

  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Rotating encryption key for *.enc under: ${dataDir}`);

  let total = 0, rotated = 0, alreadyNewKey = 0, failed = 0;
  for await (const file of walk(dataDir)) {
    total++;
    let plaintext;
    try {
      const content = await fs.readFile(file, 'utf8');
      plaintext = decrypt(oldKey, content);
    } catch {
      // Old key failed — already rotated (resumed run) or corrupt.
      try {
        const content = await fs.readFile(file, 'utf8');
        decrypt(newKey, content);
        alreadyNewKey++;
        continue;
      } catch (e2) {
        failed++;
        console.error(`  FAILED to decrypt with either key: ${file} — ${e2.message}`);
        continue;
      }
    }
    rotated++;
    if (DRY_RUN) continue;
    try {
      const reencrypted = encrypt(newKey, plaintext);
      const tmp = `${file}.tmp-rotate`;
      await fs.writeFile(tmp, reencrypted, 'utf8');
      await fs.rename(tmp, file); // atomic on same filesystem
    } catch (e) {
      rotated--;
      failed++;
      console.error(`  FAILED to write: ${file} — ${e.message}`);
    }
  }

  console.log('\nDone.');
  console.log(`  total .enc files   : ${total}`);
  console.log(`  rotated old → new  : ${rotated}${DRY_RUN ? ' (would rotate)' : ''}`);
  console.log(`  already on new key : ${alreadyNewKey}`);
  console.log(`  failed             : ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
