// Re-encrypt every *.enc file into the current format (v2: HKDF key per file +
// the file's path bound as GCM associated data), with the SAME key.
//
//   node scripts/reencrypt-data.mjs [--dry-run]
//
// The app reads v1 (HKDF or legacy PBKDF2) and v2 files and writes v2, so files
// upgrade on their next write anyway. Running this once upgrades everything up
// front — after that you can set ENCRYPTION_REQUIRE_PATH_BINDING=true so the
// app refuses any remaining or re-planted v1 file (docs/operations.md §8).
//
// Safety:
//   - Idempotent: a v2 file is decrypted and re-written as v2.
//   - Atomic per file: 0600 temp file + fsync + rename, so a crash mid-run
//     never leaves a half-written .enc.
//   - Never deletes data. TAKE A BACKUP FIRST anyway, and stop the app while it
//     runs on production data.
//
// Key/dir resolution (matches scripts/lib-secrets.sh):
//   ENCRYPTION_KEY env, else ~/.sampolio/secrets/encryption_key, else
//   <DATA_DIR>/.encryption_key. DATA_DIR env, else ./data.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { decryptAny, encryptV2, relPathFor, resolveEncryptionKey, walkEncFiles, writeAtomic, isMain } from './lib-file-crypto.mjs';

/** Re-encrypt one data tree; returns counts by source format. */
export async function reencryptDataDir(dataDir, password, { dryRun = false, log = console } = {}) {
  const counts = { total: 0, v1Pbkdf2: 0, v1Hkdf: 0, v2: 0, failed: 0 };
  for await (const file of walkEncFiles(dataDir)) {
    counts.total++;
    const relPath = relPathFor(dataDir, file);
    let result;
    try {
      result = decryptAny(password, await fs.readFile(file, 'utf8'), relPath);
    } catch (e) {
      counts.failed++;
      log.error(`  FAILED to decrypt: ${relPath} — ${e.message}`);
      continue;
    }
    if (result.format === 'v2') counts.v2++;
    else if (result.format === 'v1-hkdf') counts.v1Hkdf++;
    else counts.v1Pbkdf2++;
    if (dryRun) continue;
    try {
      await writeAtomic(file, encryptV2(password, result.plaintext, relPath));
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
  const password = await resolveEncryptionKey(dataDir);
  if (!password) {
    console.error('ERROR: no ENCRYPTION_KEY (env, ~/.sampolio/secrets/encryption_key or <DATA_DIR>/.encryption_key). Aborting to avoid corrupting data.');
    process.exit(1);
  }
  console.log(`${dryRun ? '[dry-run] ' : ''}Re-encrypting *.enc under: ${dataDir}`);
  const c = await reencryptDataDir(dataDir, password, { dryRun });
  console.log('\nDone.');
  console.log(`  total .enc files     : ${c.total}`);
  console.log(`  v1 legacy PBKDF2     : ${c.v1Pbkdf2}${dryRun ? ' (would upgrade to v2)' : ' → v2'}`);
  console.log(`  v1 HKDF              : ${c.v1Hkdf}${dryRun ? ' (would upgrade to v2)' : ' → v2'}`);
  console.log(`  already v2           : ${c.v2}${dryRun ? '' : ' (re-written)'}`);
  console.log(`  failed               : ${c.failed}`);
  if (c.failed > 0) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
