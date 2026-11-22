# Database Layer (`src/lib/db/`)

File-based encrypted storage layer. No external database — all data is stored as individually encrypted JSON files on disk.

## Encryption (`encryption.ts`)

- **Algorithm**: AES-256-GCM
- **Key derivation**: **HKDF-SHA256** per file (a single HMAC, ~microseconds). `ENCRYPTION_KEY` is already a full-entropy 256-bit key, so PBKDF2's password-stretching iterations bought **zero** security while blocking the event loop ~50-150ms per file — and with a unique salt per file the derived-key cache almost never hit, so a cold page load (150-200 files) paid that cost 150-200×. HKDF is the correct KDF for high-entropy input key material; this is not a security regression.
- **Tag length pinned**: the decipher is created with `authTagLength: 16` and rejects shorter tags (a truncated file can't be accepted with a weaker tag).
- **Per-file security**: each file gets a random 64-byte salt and 16-byte IV (HKDF derives a distinct per-file key from `ENCRYPTION_KEY` + salt, so identical plaintext still yields distinct ciphertext).
- **Format v2 (all writes)**: `"sv2:" + base64(salt + iv + authTag + ciphertext)`, key = HKDF(`sampolio-file-encryption-v2`), and the file's DATA_DIR-relative `/`-separated path (`dataRelativePath`) authenticated as GCM associated data. `writeEncryptedFile` → `encryptForPath(json, finalPath)` (bound to the final path, not the atomic-write temp file); `readEncryptedFile` → `decryptForPath(content, path)`. A file copied to any other path fails authentication.
- **Backward-compatible reads (v1)**: unprefixed `base64(salt + iv + authTag + ciphertext)`. `decrypt()` tries HKDF (`sampolio-file-encryption-v1`) first and, on GCM auth failure, falls back to the legacy `pbkdf2Sync(…, 100000, …, 'sha512')` key. Refused when `ENCRYPTION_REQUIRE_PATH_BINDING=true`. A v1 file upgrades to v2 on its next write.
- **Migration** (`scripts/reencrypt-data.mjs`, format code shared via `scripts/lib-file-crypto.mjs`): walks `DATA_DIR`, decrypts any format, re-encrypts as v2, atomic 0600 temp+fsync+rename per file. Idempotent, never deletes; `--dry-run` reports counts per source format. Procedure (and the pre-4.0 rollback caveat): `docs/operations.md` §8. `file-format-v2.test.ts` keeps the scripts' implementation byte-compatible with this file.
- **Key source**: `ENCRYPTION_KEY` environment variable (64-char hex string). **Missing key is a hard failure in production** (throws on first use); development falls back to a known default with a console warning.
- **Key rotation** (`scripts/rotate-encryption-key.mjs`): decrypts with `OLD_ENCRYPTION_KEY` (any format), re-encrypts as v2 with the new `ENCRYPTION_KEY`; refuses identical keys, `--dry-run` supported, resumable. See `docs/operations.md` §8.
- **Performance**: LRU cache (max 500 entries) retained for the legacy PBKDF2 fallback keys only (HKDF is fast enough to skip caching). See `encryption.test.ts` for round-trip + legacy-compat coverage.

### Core Functions

```typescript
readEncryptedFile<T>(filePath: string): Promise<T>
writeEncryptedFile<T>(filePath: string, data: T): Promise<void> // atomic: 0600 temp + fsync + rename
updateEncryptedFile<T>(filePath, mutate): Promise<T>            // locked read-modify-write of one file
withFileLock(key, fn) / serialized(lockKeyOf, fn)              // in-process lock (globalThis table; not reentrant)
assertSafeId(id, what?) / isSafeId(id)                         // ^[A-Za-z0-9_-]{1,64}$ — use in EVERY path builder
assertInsideDataDir(path)                                      // called by every I/O helper below
getDataDir(): string              // ~/.sampolio/data/ or custom
getUserDir(userId: string): string // ~/.sampolio/data/users/{userId} (validates userId)
ensureDir(dir: string): Promise<void> // mkdir 0700
listFiles(dir: string): Promise<string[]> // hides *.tmp
deleteFile(filePath: string): Promise<void>
```

**Rules for new DB code**: build every path through a `getXFile(…)` helper that wraps each
client-supplied id in `assertSafeId` (record ids reach these functions straight from server
actions — `../` would otherwise escape into another user's directory). Do read-modify-write
of a shared or aggregate file through `updateEncryptedFile` or a `serialized(...)` wrapper
keyed on that file/directory, and never call another function serialized on the same key from
inside one. `revoked-sessions.ts` keeps signed-out session ids (see `docs/architecture.md` §9).

## Data Directory Structure

```
{dataDir}/
├── users-index.enc           # { users: [{ id, email }] }
├── app-settings.enc          # { selfSignupEnabled, updatedAt, updatedBy }
├── shared/                   # Shared (non-user-scoped) entities — access control in the action layer
│   ├── mortgages/{id}.enc    # SharedMortgage (loans + members embedded)
│   ├── mortgages/{id}/       # rates/ costs/ extra-payments/ snapshots/ (+ embedded actuals)
│   ├── mortgage-members/{userId}.enc   # Reverse index: userId → mortgageIds
│   ├── split-groups/{id}.enc           # SplitGroup (members + recurrence rules embedded)
│   ├── split-groups/{id}/expenses/{YYYY-MM}.enc  # Monthly chunk: array of that month's expenses/payments
│   ├── split-groups/{id}/summary.enc   # Maintained running balances (netByUserId) + month index
│   └── split-group-members/{userId}.enc  # Reverse index: userId → groupIds
└── users/{userId}/
    ├── user.enc              # User profile with passwordHash (+ avatarVersion)
    ├── preferences.enc       # Onboarding, categories, tax defaults
    ├── avatar.webp           # Profile picture — PLAIN binary (NOT encrypted); optional; excluded from JSON backup
    ├── accounts/{id}.enc     # One file per cash account
    ├── accounts/{id}/        # Per-account sub-entities, one file each
    │   ├── recurring/{itemId}.enc
    │   ├── planned/{itemId}.enc
    │   ├── salary/{configId}.enc
    │   └── taxed-income/{incomeId}.enc
    ├── investments/{id}.enc  (+ investments/{id}/contributions/{cid}.enc)
    ├── debts/{id}.enc        (+ debts/{id}/reference-rates/ + extra-payments/)
    ├── receivables/{id}.enc  (+ receivables/{id}/repayments/)
    ├── budgets/{id}.enc      # One doc per budget (lines, funding, expenses embedded)
    ├── goals/{id}.enc        # Financial goals (UI at /goals)
    ├── trips/{id}.enc        # Trips / per diem (UI on the merged /budgets page)
    ├── bank/                 # Enable Banking sync (read-only) — bank-connections.ts / bank-transactions.ts / bank-sync-runs.ts
    │   ├── connections/{connectionId}.enc               # BankConnection (linkedAccounts[] embedded)
    │   ├── accounts/{linkedAccountId}/transactions.enc  # Imported transaction ledger (one file per linked bank account)
    │   └── sync-runs/{id}.enc                           # Sync-run audit log
    └── reconciliation/       # Three AGGREGATE files (arrays), not one file per row
        ├── balance-snapshots.enc
        ├── reconciliation-adjustments.enc
        └── reconciliation-sessions.enc
```

> Most entities are **user-scoped** (`users/{userId}/…`). The exceptions are the **shared mortgage** and the **split groups** (`split-groups.ts`), which live under `shared/` because they are co-owned by multiple members; the encryption key is global, so member access control is enforced in the action layer (`loadMortgageForMember` / `loadGroupForMember`), not by the filesystem.
>
> **Split-group storage is monthly-chunked, not one-file-per-row**: at ~2,500 expenses/group, one file per row would mean thousands of separate decrypts (and, pre-HKDF, thousands of PBKDF2 runs) on every cache miss. Even with fast HKDF derivation, chunking keeps file counts and I/O bounded. Each `{YYYY-MM}.enc` holds a month's array, and a `summary.enc` (delta-maintained on add, rebuilt on edit/delete/import) holds running balances so the hot paths never decrypt full history. The per-group in-process mutex lives in the action layer.
>
> **Avatars are the one unencrypted file** (`users/{id}/avatar.webp`, 256×256 WebP). `users.ts` owns them: `setUserAvatar(userId, Buffer | null)` writes/removes the file and bumps `User.avatarVersion`; `getAvatarPath(userId)` resolves the path (used by the `/api/avatars/[userId]` route); `avatarUrlFor(user)` / `toPublicUser(user)` produce the versioned URL (`?v={avatarVersion}` cache-buster). Deliberately plaintext — it's low-sensitivity and this enables zero-decrypt streaming + immutable HTTP caching — and deliberately outside the JSON backup (`data-transfer.ts` never touches it).

## DB File Pattern

Each entity type has its own file in this directory. They all follow the same pattern:

```typescript
// List all entities
export async function getItems(userId: string): Promise<Item[]> {
  const dir = path.join(getUserDir(userId), 'items');
  await ensureDir(dir);
  const files = await listFiles(dir);
  const encFiles = files.filter(f => f.endsWith('.enc'));
  return Promise.all(encFiles.map(f => readEncryptedFile<Item>(path.join(dir, f))));
}

// Get single entity
export async function getItemById(userId: string, itemId: string): Promise<Item | null> {
  const filePath = path.join(getUserDir(userId), 'items', `${itemId}.enc`);
  try { return await readEncryptedFile<Item>(filePath); }
  catch { return null; }
}

// Create entity
export async function createItem(userId: string, data: CreateItemRequest): Promise<Item> {
  const item: Item = { id: uuidv4(), ...data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const filePath = path.join(getUserDir(userId), 'items', `${item.id}.enc`);
  await ensureDir(path.dirname(filePath));
  await writeEncryptedFile(filePath, item);
  return item;
}

// Update entity (read-modify-write)
export async function updateItem(userId: string, itemId: string, updates: Partial<Item>): Promise<Item> {
  const existing = await getItemById(userId, itemId);
  if (!existing) throw new Error('Not found');
  const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
  await writeEncryptedFile(path.join(getUserDir(userId), 'items', `${itemId}.enc`), updated);
  return updated;
}

// Delete entity
export async function deleteItem(userId: string, itemId: string): Promise<void> {
  await deleteFile(path.join(getUserDir(userId), 'items', `${itemId}.enc`));
}
```

## Cached Queries (`cached.ts`)

Wraps DB read functions with Next.js `cacheLife('indefinite')` and `cacheTag()`:

```typescript
export async function cachedGetAccounts(userId: string) {
  'use cache';
  cacheLife('indefinite');
  cacheTag(`user:${userId}:accounts`);
  return getAccounts(userId);
}
```

After mutations, server actions call `updateTag(tagName)` to invalidate.

## Known Limitations

- **In-process locks only**: `withFileLock` serializes writers inside one `next start` process. There is no cross-process locking, so a second process (a maintenance script while the app runs, or two app instances) can still lose updates. Per-record entity files (one file per account/goal/…) are not locked; two simultaneous edits of the same record keep the last one. Bank files rely on the sync engine's per-connection lock.
- **No multi-file transactions**: each file write is atomic, but an operation that rewrites several files (e.g. a mortgage plus its member index) can stop between them on a crash.
