// Key rotation: decrypt every *.enc file with the OLD key (any format) and
// re-encrypt it with the NEW key in the current format (v2, path-bound).
// Complements scripts/reencrypt-data.mjs, which keeps the same key.
//
//   OLD_ENCRYPTION_KEY=<old> ENCRYPTION_KEY=<new> node scripts/rotate-encryption-key.mjs [--dry-run]
//
// Key/dir resolution:
//   OLD_ENCRYPTION_KEY env (required).
//   ENCRYPTION_KEY env, else ~/.sampolio/secrets/encryption_key, else
//     <DATA_DIR>/.encryption_key (the NEW key — update the key file BEFORE
//     running, or pass the env var).
//   DATA_DIR env, else ./data.
//
// Safety:
//   - Refuses to run when old and new keys are identical (use reencrypt-data.mjs).
//   - Atomic per file: 0600 temp file + fsync + rename.
//   - Never deletes data — but a crash mid-run leaves the tree MIXED between
//     keys, so TAKE A BACKUP FIRST and, on prod data, stop the app while
//     rotating. Re-running with the same env is safe: files already rotated
//     fail old-key decryption, decrypt with the new key, and are counted.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { decryptAny, encryptV2, relPathFor, resolveEncryptionKey, walkEncFiles, writeAtomic, isMain } from './lib-file-crypto.mjs';

/** Rotate one data tree from oldKey to newKey; returns counts. */
export async function rotateDataDir(dataDir, oldKey, newKey, { dryRun = false, log = console } = {}) {
  const counts = { total: 0, rotated: 0, alreadyNewKey: 0, failed: 0 };
  for await (const file of walkEncFiles(dataDir)) {
    counts.total++;
    const relPath = relPathFor(dataDir, file);
    const content = await fs.readFile(file, 'utf8');
    let plaintext;
    try {
      plaintext = decryptAny(oldKey, content, relPath).plaintext;
    } catch {
      // Old key failed — already rotated (resumed run) or corrupt.
      try {
        decryptAny(newKey, content, relPath);
        counts.alreadyNewKey++;
      } catch (e2) {
        counts.failed++;
        log.error(`  FAILED to decrypt with either key: ${relPath} — ${e2.message}`);
      }
      continue;
    }
    if (dryRun) {
      counts.rotated++;
      continue;
    }
    try {
      await writeAtomic(file, encryptV2(newKey, plaintext, relPath));
      counts.rotated++;
    } catch (e) {
      counts.failed++;
      log.error(`  FAILED to write: ${relPath} — ${e.message}`);
    }
  }
  return counts;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const oldKey = process.env.OLD_ENCRYPTION_KEY;
  if (!oldKey) {
    console.error('ERROR: OLD_ENCRYPTION_KEY not set. Aborting.');
    process.exit(1);
  }
  const newKey = await resolveEncryptionKey(dataDir);
  if (!newKey) {
    console.error('ERROR: the NEW key was not found (ENCRYPTION_KEY env, ~/.sampolio/secrets/encryption_key or <DATA_DIR>/.encryption_key). Aborting.');
    process.exit(1);
  }
  if (oldKey === newKey) {
    console.error('ERROR: OLD_ENCRYPTION_KEY and ENCRYPTION_KEY are identical — nothing to rotate. Use scripts/reencrypt-data.mjs for a format migration.');
    process.exit(1);
  }
  console.log(`${dryRun ? '[dry-run] ' : ''}Rotating encryption key for *.enc under: ${dataDir}`);
  const c = await rotateDataDir(dataDir, oldKey, newKey, { dryRun });
  console.log('\nDone.');
  console.log(`  total .enc files   : ${c.total}`);
  console.log(`  rotated old → new  : ${c.rotated}${dryRun ? ' (would rotate)' : ''}`);
  console.log(`  already on new key : ${c.alreadyNewKey}`);
  console.log(`  failed             : ${c.failed}`);
  if (c.failed > 0) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
