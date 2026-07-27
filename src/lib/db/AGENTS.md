# Database Layer (`src/lib/db/`)

File-based encrypted storage layer. No external database — all data is stored as individually encrypted JSON files on disk.

## Encryption (`encryption.ts`)

- **Algorithm**: AES-256-GCM
- **Key derivation**: **HKDF-SHA256** per file (a single HMAC, ~microseconds). `ENCRYPTION_KEY` is already a full-entropy 256-bit key, so PBKDF2's password-stretching iterations bought **zero** security while blocking the event loop ~50-150ms per file — and with a unique salt per file the derived-key cache almost never hit, so a cold page load (150-200 files) paid that cost 150-200×. HKDF is the correct KDF for high-entropy input key material; this is not a security regression.
- **Per-file security**: each file gets a random 64-byte salt and 16-byte IV (HKDF derives a distinct per-file key from `ENCRYPTION_KEY` + salt, so identical plaintext still yields distinct ciphertext).
- **Backward-compatible reads**: the file format (`salt + iv + authTag + ciphertext`, base64) is unchanged, so old and new files are byte-identical in shape — only the derivation differs. `decrypt()` tries HKDF first and, on GCM auth failure, falls back to the legacy `pbkdf2Sync(…, 100000, …, 'sha512')` key. GCM authentication makes the key choice unambiguous (forging a tag is infeasible); the wasted HKDF attempt on a legacy file costs microseconds. New writes always use HKDF.
- **Migration** (`scripts/reencrypt-data.mjs`): one-shot walk of `DATA_DIR` that decrypts (compat reader) → re-encrypts (HKDF) → atomic temp+rename per file. Idempotent, never deletes; `--dry-run` reports counts. Reads `ENCRYPTION_KEY` from env or `<DATA_DIR>/.encryption_key`. Run once after deploy (backup first) so every read hits the fast path; correctness does not depend on it (reads stay backward-compatible).
- **Storage format**: Base64-encoded string containing `salt + iv + authTag + ciphertext`
- **Key source**: `ENCRYPTION_KEY` environment variable (64-char hex string). **Missing key is a hard failure in production** (throws on first use); development falls back to a known default with a console warning.
- **Key rotation** (`scripts/rotate-encryption-key.mjs`): decrypts with `OLD_ENCRYPTION_KEY` (HKDF + PBKDF2 fallback), re-encrypts with the new `ENCRYPTION_KEY`; refuses identical keys, `--dry-run` supported, resumable. See `docs/operations.md` §8.
- **Performance**: LRU cache (max 500 entries) retained for the legacy PBKDF2 fallback keys only (HKDF is fast enough to skip caching). See `encryption.test.ts` for round-trip + legacy-compat coverage.

### Core Functions

```typescript
readEncryptedFile<T>(filePath: string): Promise<T>
writeEncryptedFile<T>(filePath: string, data: T): Promise<void>
getDataDir(): string              // ~/.sampolio/data/ or custom
getUserDir(userId: string): string // ~/.sampolio/data/users/{userId}
ensureDir(dir: string): Promise<void>
listFiles(dir: string): Promise<string[]>
deleteFile(filePath: string): Promise<void>
```

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

- **No file locking**: Concurrent read-modify-write operations can cause data loss. Acceptable for single-user scenarios.
- **No transactions**: Operations are not atomic — a crash mid-write could corrupt a file.
