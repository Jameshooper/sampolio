# Sampolio — System Architecture

Current-state reference for developers (human and AI) extending the app or hunting bugs.
Conventions and invariants live in the root [`AGENTS.md`](../AGENTS.md); deep feature
mechanics live in [`features.md`](features.md), [`projections-and-reconciliation.md`](projections-and-reconciliation.md),
[`mortgage.md`](mortgage.md), [`bank-sync.md`](bank-sync.md), and [`operations.md`](operations.md).

## 1. Stack

| Layer | Package | Version (package.json) |
|---|---|---|
| Framework | `next` | 16.3.4 (App Router, `cacheComponents: true`) |
| UI runtime | `react` / `react-dom` | 19.2.8 |
| Language | `typescript` | ^6.0.3 (strict) |
| Components | `primereact` | ^10.9.9 (+ `primeicons` ^7.0.0, `react-icons` ^5.7.0, `lucide-react` 1.42.0) |
| Styling | `tailwindcss` | ^4.3.3 (via `@tailwindcss/postcss`) |
| Auth | `next-auth` | 5.0.0-beta.32 (+ `bcryptjs` ^3.0.3 for password hashing) |
| Validation | `zod` | ^4.6.7 |
| Forms | `react-hook-form` ^7.87.0 + `@hookform/resolvers` ^5.9.1 |
| Charts | `echarts` ^6.1.0 (+ `echarts-for-react` ^3.0.6), `chart.js` ^4.5.1 |
| Avatar crop | `react-easy-crop` | ^6.2.3 (lazy-loaded in the avatar editor) |
| Dates | `date-fns` | ^4.4.0 |
| JWT (bank API) | `jose` | ^6.2.12 (RS256 for Enable Banking) |
| IDs | `uuid` | ^14.0.2 |
| Tests | `vitest` ^5.1.1, `@testing-library/react` ^16.3.3, `jsdom` ^31.0.1 |

Package manager: **pnpm 12.3.4** (`packageManager` field). Node: **>= 26** (`engines`; `.nvmrc` = `v26`).
There is no external database and no ORM — persistence is encrypted JSON files on disk.

Compatibility bounds: PrimeReact 10 preserves the resource-based themes used by
`scripts/copy-themes.mjs`; PrimeIcons 7 retains its MIT license. ESLint 9 and
TypeScript 6 remain within the lint plugins' supported peer ranges. Lucide is
pinned to 1.42.0 to satisfy pnpm's minimum release-age policy.

## 2. Runtime topology

A single Node process (`next start`) serves everything: pages, server actions, the API
routes (NextAuth, the bank consent callback, and the avatar image endpoint), and an
in-process background bank-sync scheduler. Production runs as the launchd
service `com.sampolio.app` on port **3999** against `~/.sampolio/data`, built into `.next-prod`
(`NEXT_DIST_DIR`); the dev preview runs `next dev -p 4999` against a repo-local `./data` copy
and the default `.next` dir, so the two never share a build. External access goes through a
cloudflared tunnel gated by Cloudflare Access. Full topology, secrets layout, and deploy
runbook: [`operations.md`](operations.md).

## 3. Route map

| Route | File | Purpose |
|---|---|---|
| `/` | `src/app/page.tsx` | Home dashboard (bank-account glance strip + projected-month tile, merged split balances+activity card; add via the global FAB). Server component: `auth()` + `redirect('/auth/signin')`; wraps `AppLayout` itself (outside the route group). |
| `/overview` | `src/app/(dashboard)/overview/page.tsx` | Wealth dashboard (net worth, KPIs, reminders). |
| `/cashflow` | `src/app/(dashboard)/cashflow/page.tsx` | Monthly cash-flow projection + retrospective. |
| `/mortgage` | `src/app/(dashboard)/mortgage/page.tsx` | Shared-mortgage ledger, charts, reconcile/import. |
| `/budgets`, `/budgets/[id]` | `src/app/(dashboard)/budgets/…` | Merged "Trips & Budgets" page (stacked Trips + Budgets sections) + budget detail editor. |
| `/split`, `/split/[id]` | `src/app/(dashboard)/split/…` | Split groups list + group ledger (Splitwise replacement). |
| `/goals` | `src/app/(dashboard)/goals/page.tsx` | Financial goals: card grid with progress vs. projections, create/edit dialog. |
| `/trips` | `src/app/(dashboard)/trips/page.tsx` | Server `redirect('/budgets')` — trips live on the merged Trips & Budgets page. |
| `/bank` | `src/app/(dashboard)/bank/page.tsx` | Connected bank accounts + imported transaction ledger. |
| `/playground` | `src/app/(dashboard)/playground/page.tsx` | Ephemeral "What If?" scenario explorer. |
| `/settings` | `src/app/(dashboard)/settings/page.tsx` | Preferences, banking, JSON export/import, admin panel, data maintenance, account self-service (password change, start fresh, delete account) (TabView; deep-link `?tab=banking`). |
| `/auth/signin`, `/auth/signup` | `src/app/auth/…` | Credential sign-in / sign-up (pass-through `auth/layout.tsx`). |
| `/dev-login` | `src/app/dev-login/route.ts` | GET handler: dev-only password-less sign-in as `DEV_AUTH_BYPASS`; returns 404 in production or when the flag is unset. |
| `/api/auth/[...nextauth]` | `src/app/api/auth/[...nextauth]/route.ts` | NextAuth handlers. |
| `/api/bank/callback` | `src/app/api/bank/callback/route.ts` | Enable Banking consent callback (one of two non-NextAuth API routes). |
| `/api/avatars/[userId]` | `src/app/api/avatars/[userId]/route.ts` | User avatar image (session-gated; serves the plain-binary `avatar.webp`; `Cache-Control: private, max-age=31536000, immutable` with a `?v={avatarVersion}` buster). Node runtime. |
| `/manifest.webmanifest` | `src/app/manifest.ts` | Static PWA manifest. |

**Auth guarding is layered:**

- `src/proxy.ts` redirects cookie-less requests to `/auth/signin` for `/` and every app-page
  prefix in its `PROTECTED_PREFIXES` list (`/overview`, `/cashflow`, `/mortgage`, `/budgets`,
  `/trips`, `/split`, `/bank`, `/goals`, `/playground`, `/settings`) — a lightweight cookie-presence
  check on the Edge; add new pages to that list.
- `/` guards itself server-side (`auth()` + `redirect`).
- The `(dashboard)` group layout (`src/app/(dashboard)/layout.tsx`) validates the session
  server-side (`auth()` + `redirect('/auth/signin')`) before wrapping children in
  `AppLayout`, so page shells never render unauthenticated even if the edge check is
  bypassed. Independently, **every server action verifies `auth()`** — data is guarded
  regardless of either layer. The group also has a `template.tsx` that re-mounts per
  navigation and wraps children in `PageEntrance` (250ms `rise-in`, restarted on pathname
  change — see §17 Motion); `/` wraps itself the same way in
  `home-dashboard.tsx`.

## 4. Request flow

```
client page ('use client')
  → server action (src/lib/actions/*)      'use server'; auth() → Zod safeParse → op → updateTag
    → cached query (src/lib/db/cached.ts)  'use cache' + cacheTag + cacheLife
      → db module (src/lib/db/*)           read-modify-write of encrypted JSON
        → encryption.ts                    readEncryptedFile / writeEncryptedFile
          → ${DATA_DIR}/…/*.enc
```

Every action returns `ApiResponse<T> = { success: boolean; data?: T; error?: string }`
(`src/types/index.ts`). There are **no REST endpoints** besides the NextAuth handler and the
bank consent callback — all reads and mutations are server actions invoked from client
components.

## 5. Server-action inventory (`src/lib/actions/`)

| Module | Exported actions |
|---|---|
| `account.ts` | `changeMyPassword`, `getAccountDeletionPreflight`, `deleteMyAccount`, `resetMyData`, `updateMyAvatar` (self-service; Settings → Account) |
| `accounts.ts` | `getAccounts`, `getAccountById`, `createAccount`, `updateAccount`, `deleteAccount` |
| `admin.ts` | `getUsers`, `getUserById`, `createUser`, `updateUser` (incl. optional `avatarDataUri`), `deleteUser`, `getSettings`, `updateSettings`, `revalidateAllCaches` |
| `app-info.ts` | `getAppVersion` |
| `auth.ts` | `signUp`, `checkSignupEnabled` |
| `bank.ts` | `getBankFeatureStatus`, `getBankConnections`, `listBankAspsps`, `startBankConnection`, `reconnectBankConnection`, `refreshBankConnection`, `disconnectBankConnection`, `updateBankAccountLink`, `getBankConnectionsNeedingAttention`, `getCardLiabilities`, `getHomeBankGlance`, `getCreditCardOptions`, `getCardStatementBreakdownForAccount`, `getBankSyncRuns`, `getBankTransactionsForLink`, `getBankConnection` |
| `budgets.ts` | `getBudgets`, `getBudgetById`, `createBudget`, `updateBudget`, `deleteBudget`, `confirmBudget`, `unconfirmBudget`, `addBudgetLine`, `updateBudgetLine`, `deleteBudgetLine`, `addBudgetFundingSource`, `updateBudgetFundingSource`, `deleteBudgetFundingSource`, `addBudgetExpenseEntry`, `updateBudgetExpenseEntry`, `deleteBudgetExpenseEntry` |
| `debts.ts` | `getDebts`, `getDebtById`, `createDebt`, `updateDebt`, `deleteDebt`, `getReferenceRates`, `setReferenceRate`, `deleteReferenceRate`, `getExtraPayments`, `createExtraPayment`, `deleteExtraPayment` |
| `data-transfer.ts` | `exportUserData`, `importUserData` (Settings JSON backup; merge/replace) |
| `euribor.ts` | `fetchCurrentEuribor12m` (ECB Data Portal fetch, in-memory TTL cache, graceful failure; prefills the mortgage rate-update dialog) |
| `goals.ts` | `getGoals`, `getGoalById`, `createGoal`, `updateGoal`, `deleteGoal` |
| `investments.ts` | `getInvestmentAccounts`, `getInvestmentAccountById`, `createInvestmentAccount`, `updateInvestmentAccount`, `deleteInvestmentAccount`, `getContributions`, `createContribution`, `updateContribution`, `deleteContribution` |
| `maintenance.ts` | `previewHistoryCompaction`, `compactHistory` |
| `planned.ts` | `getPlannedItems`, `getPlannedItemById`, `createPlannedItem`, `updatePlannedItem`, `deletePlannedItem`, `upsertRecurringItemOccurrenceOverride`, `deleteRecurringItemOccurrenceOverride`, `cleanupExpiredOverrides` |
| `projection.ts` | `getProjection` |
| `receivables.ts` | `getReceivables`, `getReceivableById`, `createReceivable`, `updateReceivable`, `deleteReceivable`, `getRepayments`, `createRepayment`, `deleteRepayment` |
| `reconciliation.ts` | `getBalanceSnapshots`, `getSnapshotsForEntity`, `getSnapshotsForMonth`, `getLatestSnapshot`, `createBalanceSnapshot`, `deleteBalanceSnapshot`, `getAdjustmentsForSnapshot`, `createAdjustment`, `deleteAdjustment`, `getReconciliationSessions`, `getSessionForMonth`, `getLatestCompletedSession`, `startReconciliationSession`, `completeReconciliationSession`, `updateSessionSnapshots`, `getReconciliationSummary`, `applyReconciliationBalances` |
| `recurring.ts` | `getRecurringItems`, `getRecurringItemById`, `createRecurringItem`, `updateRecurringItem`, `deleteRecurringItem` |
| `salary.ts` | `getSalaryConfigs`, `getSalaryConfigById`, `createSalaryConfig`, `updateSalaryConfig`, `deleteSalaryConfig` |
| `scenario.ts` | `runScenarioProjection` |
| `shared-mortgages.ts` | `getMyMortgages`, `getMortgage`, `getMortgageProjectionInputs`, `getMyMortgageEquity`, `createMortgage`, `updateMortgage`, `updateMortgageLoan`, `deleteMortgage`, `addMortgageMemberByEmail`, `removeMortgageMember`, `updateMortgageMember`, `setMyMortgageLinkedAccount`, `setMortgageRate`, `deleteMortgageRate`, `setMortgageCost`, `deleteMortgageCost`, `addMortgageExtraPayment`, `deleteMortgageExtraPayment`, `recordMortgageBalanceSnapshot`, `deleteMortgageBalanceSnapshot`, `getMortgageActuals`, `importMortgageActuals`, `clearMortgageActuals`, `reconcileMortgageMonth`, `revertMortgageMonth` |
| `split-groups.ts` | `getMySplitGroups`, `getSplitGroupView`, `getSplitExpenses`, `getSplitActivity`, `getSplitInsights`, `getMySplitNetBalance`, `getMySplitLinkCandidates`, `getSettleUpSuggestions`, `createSplitGroup`, `updateSplitGroup`, `deleteSplitGroup`, `addSplitGroupMember`, `removeSplitGroupMember`, `setDefaultSplitGroup`, `createSplitExpense`, `quickAddSplitExpense`, `updateSplitExpense`, `deleteSplitExpense`, `recordSettleUp`, `createSplitRecurrenceRule`, `updateSplitRecurrenceRule`, `deleteSplitRecurrenceRule`, `catchUpGroupRecurrences`, `importSplitwiseCsv`, `markSplitGroupSeen` — every mutating action additionally calls `notifySplitActivity` (`src/lib/split-notify.ts`) after its write + cache invalidation, which schedules a Home Assistant webhook POST for after the response (§11) |
| `taxed-income.ts` | `getTaxedIncomes`, `getTaxedIncomeById`, `createTaxedIncome`, `updateTaxedIncome`, `deleteTaxedIncome` |
| `trips.ts` | `getTrips`, `getTripById`, `createTrip`, `updateTrip`, `deleteTrip` |
| `user-preferences.ts` | `getUserPreferences`, `completeOnboarding`, `updateCategories`, `updateCheckInReminders`, `updateCheckInNotifications`, `updateSplitNotificationPrefs` (five-key opt-out record for the split webhook events), `getSplitNotifyStatus` (is `HA_WEBHOOK_URL` configured), `updateBankAccountOrder`, `updateSplitGroupOrder`, `updateBottomNavIds` (mobile bottom-nav tabs; `null` resets to the per-display-mode defaults), `updateDisplayMode`, `updateTaxDefaults` |
| `user-profiles.ts` | `getUserProfiles` — `{ id, name, avatarUrl? }` for any authenticated user (no email/role; safe for cross-user member displays) |

Tax & contribution defaults (`UserPreferences.taxDefaults`) are **per-user** preferences
(not app settings) and are consumed only as **form prefill** for new salary
configurations (salary modal + onboarding) — each `SalaryConfig` stores its own
immutable copy of the rates, so changing the defaults never touches existing salaries
or other users.

**No barrel exports**: there is no `src/lib/actions/index.ts` — always import from the
concrete module path (e.g. `import { getBankConnections } from '@/lib/actions/bank'`).

## 6. DB layer & on-disk storage

Each entity has a module in `src/lib/db/` doing read-modify-write of `.enc` files
(no barrel — import the concrete module). Storage invariants (all in
`src/lib/db/encryption.ts`):

- **Ids are single path segments.** Every path builder passes record ids through
  `assertSafeId` (`^[A-Za-z0-9_-]{1,64}$`; uuids and `YYYY-MM` chunk names), and
  `getUserDir` validates the user id. The I/O helpers (`readEncryptedFile`,
  `writeEncryptedFile`, `deleteFile`, `listFiles`, `fileExists`, `ensureDir`) also
  refuse any path that resolves outside `getDataDir()` (`assertInsideDataDir`).
  Action loaders map an invalid id to "not found" (`isSafeId`).
- **Writes are atomic and private**: temp file (`0600`) + fsync + rename
  (`writeFileAtomic`); directories are created `0700`; `listFiles` hides `*.tmp`.
- **Read-modify-write is serialized in-process** with `withFileLock` /
  `updateEncryptedFile` / `serialized(lockKeyOf, fn)` (lock table on `globalThis`, so
  route handlers and server actions share it; not reentrant, not cross-process).
  Locked today: users index + per-user `user.enc`, preferences, app settings,
  reconciliation (per user dir; also held by the backup import), each shared mortgage
  (`mortgage:{id}`), and both member reverse indexes. Split groups keep their
  action-layer `withGroupLock`; bank files rely on the sync engine's per-connection lock.
Root is `getDataDir()` = `$DATA_DIR` or `<cwd>/data`. Exact layout (file names from code):

```
data/
├── .encryption_key  .auth_secret               # legacy secret location, still read by the launch scripts (new installs: ~/.sampolio/secrets/)
├── .auth_url                                   # AUTH_URL persisted by the launch scripts
├── revoked-sessions.enc                        # signed-out session ids (db/revoked-sessions.ts)
├── app-settings.enc                            # AppSettings (db/app-settings.ts)
├── users-index.enc                             # email → userId index (db/users.ts)
├── users/{userId}/
│   ├── user.enc                                # User record (incl. avatarVersion)
│   ├── preferences.enc                         # UserPreferences (single file)
│   ├── avatar.webp                             # profile picture — PLAIN binary (unencrypted, deliberate); excluded from JSON backup
│   │                                           #   ↑ the only unencrypted file in the tree; low-sensitivity, enables zero-decrypt streaming + HTTP caching
│   ├── accounts/{accountId}.enc                # one file per account
│   ├── accounts/{accountId}/recurring/{itemId}.enc
│   ├── accounts/{accountId}/planned/{itemId}.enc
│   ├── accounts/{accountId}/salary/{configId}.enc
│   ├── accounts/{accountId}/taxed-income/{incomeId}.enc
│   ├── investments/{id}.enc  + investments/{id}/contributions/{id}.enc
│   ├── debts/{id}.enc        + debts/{id}/reference-rates/{id}.enc
│   │                         + debts/{id}/extra-payments/{id}.enc
│   ├── receivables/{id}.enc  + receivables/{id}/repayments/{id}.enc
│   ├── goals/{id}.enc
│   ├── trips/{id}.enc                          # whole trip embedded (day list + rate snapshot)
│   ├── budgets/{id}.enc                        # whole budget embedded (lines/funding/log)
│   ├── reconciliation/balance-snapshots.enc    # one collection file, not per-snapshot
│   ├── reconciliation/reconciliation-adjustments.enc
│   ├── reconciliation/reconciliation-sessions.enc
│   └── bank/
│       ├── connections/{connectionId}.enc          # BankConnection, linkedAccounts embedded
│       ├── connections/{connectionId}.session.enc  # EB session secret — never cached
│       ├── accounts/{linkedAccountId}/transactions.enc  # full ledger per linked account
│       └── sync-runs/{connectionId}.enc             # sync audit log per connection
└── shared/                                     # multi-user entities (global key; ACL in action layer)
    ├── mortgages/{id}.enc                      # SharedMortgage (loans + members embedded)
    ├── mortgages/{id}/{rates|costs|extra-payments|snapshots|actuals}/{id}.enc
    ├── mortgage-members/{userId}.enc           # reverse index userId → mortgageIds
    ├── split-groups/{id}.enc                   # group doc (members + recurrence rules embedded)
    ├── split-groups/{id}/expenses/{YYYY-MM}.enc  # monthly-chunked expense arrays
    ├── split-groups/{id}/summary.enc           # maintained balance summary
    └── split-group-members/{userId}.enc        # reverse index userId → groupIds
```

Storage granularity is deliberately mixed: **one file per entity** (accounts, items, debts,
goals, trips…), **one file per collection** (reconciliation snapshots/adjustments/sessions, bank
transaction ledgers, user preferences), and **monthly chunks** (split expenses). Locking is
in-process only (see the storage invariants above): aggregate files use `withFileLock` /
`serialized`, split groups the per-group `withGroupLock` mutex
(`src/lib/actions/split-groups.ts`); there is no cross-process locking.

## 7. Encryption

`src/lib/db/encryption.ts`, AES-256-GCM with a random 64-byte salt and 16-byte IV per write
and a pinned 16-byte tag (`salt | iv | tag | ciphertext`). Two formats:

- **v2** (every write, `encryptForPath`): `"sv2:" + base64(...)`, key = HKDF-SHA256(`ENCRYPTION_KEY`,
  salt, `sampolio-file-encryption-v2`), and the file's DATA_DIR-relative path (`/`-separated,
  `dataRelativePath`) authenticated as GCM associated data (`sampolio:v2:<path>`). A file only
  decrypts at the path it was written for: copying one `.enc` over another user's or entity's
  file fails authentication. Copying the whole tree to another `DATA_DIR` keeps relative paths,
  so the production-copy workflow still works.
- **v1** (read-only compatibility, `decrypt`): `base64(...)` with HKDF (`sampolio-file-encryption-v1`)
  or legacy **PBKDF2** (100k iterations, SHA-512, LRU-cached) keys and no associated data.
  `decryptForPath` refuses v1 when `ENCRYPTION_REQUIRE_PATH_BINDING=true` (set it after
  migrating everything with `scripts/reencrypt-data.mjs`, so an old or planted v1 file can't be
  substituted).

`scripts/lib-file-crypto.mjs` implements the same formats for the re-encrypt and rotation scripts;
`src/lib/db/file-format-v2.test.ts` checks the two read each other's files. If `ENCRYPTION_KEY` is unset,
`getEncryptionKey()` **throws in production** (refusing to start); outside production it logs
a warning and falls back to a hardcoded default key
(`'sampolio-default-encryption-key-change-in-prod'`) as a dev convenience.
Details and migration notes: `src/lib/db/AGENTS.md` and [`operations.md`](operations.md) §8.

## 8. Caching

All cached reads live in `src/lib/db/cached.ts` (`cachedGet*` wrappers using the Next.js 16
`'use cache'` directive + `cacheTag` + `cacheLife`). Two profiles, defined in `next.config.ts`:

| Profile | stale / revalidate / expire | Used for |
|---|---|---|
| `indefinite` | 1y / 1y / 1y | Everything mutated only via request-scoped server actions — invalidated purely by `updateTag`. |
| `synced` | 60s / 300s / 3600s | Data the **background bank scheduler** writes outside request scope: `cachedGetBankConnections`, `cachedGetBankConnectionById`, `cachedGetBankTransactions`, `cachedGetBankSyncRuns`, `cachedGetLatestBankSyncRun`, and `cachedGetLatestSnapshot` (bank-sync anchor snapshots). |

The scheduler caveat: `updateTag` throws outside request scope, so background sync writes
cannot invalidate the cache (`safeUpdateTags` in `src/lib/bank/sync.ts` swallows it) — the
`synced` profile's short revalidate window is what makes those reads eventually consistent.
Never give background-mutated data `indefinite`.

Every wrapper tags `all-data` plus a specific tag; mutations call `updateTag`. Tag families:

- `user:{userId}` (umbrella), `user:{userId}:accounts`, `user:{userId}:account:{accountId}:recurring|planned|salary|taxed-income`
- `user:{userId}:investments`, `:investment:{id}:contributions`, `:debts`, `:debt:{id}:rates|payments`, `:receivables`, `:receivable:{id}:repayments`
- `user:{userId}:goals`, `:trips`, `:budgets`, `:preferences`, `:reconciliation`
- `user:{userId}:bank-connections`, `:bank-connection:{connectionId}`, `:bank-connection:{connectionId}:runs`, `:bank-account:{linkedAccountId}:transactions`
- `user:{userId}:mortgages` (membership), `mortgage:{id}` + `:rates|costs|payments|snapshots|actuals` (member-agnostic)
- `user:{userId}:split-groups` (membership), `split-group:{id}` + `:summary`, `:expenses`
- `users`, `app-settings`, `all-data` (admin "revalidate all")

Batch wrappers (`cachedGetAccountProjectionData`, `cachedGetWealthData`, the mortgage-inputs
batch) fetch a page's whole dataset in one cached call with the union of tags.

## 9. Auth

`src/lib/auth.ts` — NextAuth v5, two Credentials providers:

- **`credentials`**: Zod-validated email+password, `bcryptjs` verification via
  `verifyPassword` (`src/lib/db/users.ts`). Lockout (`isAccountLocked` /
  `recordFailedLogin`) counts failures per (email, client IP) — 10 in 15 min lock that
  pair — and per email from any IP — 50 lock the account — for 15 min; the client IP
  comes from `getClientIp` (`src/lib/client-ip.ts`, trusted hops only). Unknown or
  inactive accounts run `verifyDummyPassword` (a real cost-12 bcrypt compare) so
  timing doesn't reveal which emails exist. Log lines carry a hashed `logTag(email)`,
  never the address; the Auth.js logger drops `CredentialsSignin` stack traces.
- **`dev-bypass`**: only registered when `NODE_ENV !== 'production'` **and**
  `DEV_AUTH_BYPASS` is set; signs in as that email with no password. Driven by the
  `/dev-login` GET route; `src/proxy.ts` additionally redirects cookie-less dev requests for
  `/` and the auth pages straight to `/dev-login`.

Session strategy is **JWT** (`maxAge` 30 days rolling, `updateAge` 1h); the token carries
`id`/`email`/`name`/`role` (`UserRole`) plus `sid` (session id, stable across refreshes)
and `sv` (`User.sessionVersion` at sign-in), surfaced via `src/types/next-auth.d.ts`.
**Every request re-validates** in the `jwt` callback (`validateSessionClaims`,
`src/lib/session-validation.ts`): the `sid` must not be signed out
(`src/lib/db/revoked-sessions.ts`, written by the `signOut` event), and the account must
exist, be active and still carry the same `sessionVersion` — bumped by password change,
deactivation, deletion and role change (`src/lib/db/users.ts`). Returning `null` clears the
cookie. Tokens without `sid` (issued before this check existed) are rejected once.
The session cookie's `Secure` attribute and name follow `AUTH_URL`'s scheme
(`src/lib/auth-cookies.ts`): `__Secure-authjs.session-token` unless `AUTH_URL` is an explicit
`http://`, then `authjs.session-token` — fail-safe, so an unset value keeps the secure form.
Every rejected sign-in logs one `[auth]` reason with a hashed user tag (`logTag`), never the
email or password. Sign-up is gated by app settings (`checkSignupEnabled` in
`src/lib/actions/auth.ts`) and defaults to **closed**; the first-account (admin) path is decided by
`isFirstUserSetup` (empty index **and** no user directories) and re-checked inside the
users-index lock by `createUser(..., { onlyIfFirstUser })`. One password policy
(`passwordPolicySchema`, `src/lib/schemas/auth.schema.ts`) covers sign-up, admin-created
users, admin resets and self-service changes. In production an outer
**Cloudflare Access** layer authenticates before requests ever reach the app — see
[`operations.md`](operations.md).

## 10. Middleware & security

`src/proxy.ts` (Node runtime — Next 16 proxies always run on Node). Matcher: everything **except** `_next/static`, `_next/image`,
`favicon.ico`, `manifest.webmanifest`, `sw.js`, `offline.html`, `icons`, `themes`, and
`*.png|jpg|svg` (PWA/install assets must load without auth). Behavior:

- **Signed-in = verified, not present**: `hasValidSession` decrypts the session cookie
  with `AUTH_SECRET` (`next-auth/jwt` `decode`); a cookie that merely has the right name
  counts as signed out. Revocation is checked later by `auth()`.
- **Rate limiting** (in-memory `Map` per client IP from `getClientIp`, 1-minute window,
  resets on restart): credential posts (`POST /api/auth/callback*`, `POST /auth/*`,
  i.e. sign-in and sign-up) → **20/min** whether signed in or not; other signed-out
  `/api/auth*` / `/auth/*` traffic shares that bucket; all other signed-out requests →
  **300/min**. Verified sessions are exempt from the general limit (server actions burst
  during page loads). 429 with `Retry-After`.
- **Body cap**: signed-out server-action POSTs (`Next-Action` header) without a
  `Content-Length` or above 64 KB get 413 — the 20 MB action body limit in
  `next.config.ts` exists only for the signed-in backup import.
- **Client IP**: `X-Forwarded-For` is trusted only for `TRUSTED_PROXY_HOPS` entries from
  the right (default 1 — Caddy and cloudflared both set it); `0` ignores the header.
- **Auth redirect** for `/` and every path in `PROTECTED_PREFIXES` (see §3) without a
  verified session cookie.
- **Session cookie on `/auth/signin|signup`**: decided with the full check `auth()` makes
  (`hasLiveSession` → `validateSessionClaims`: signature, expiry, sign-out revocation,
  account active, session version). Live ⇒ redirect into the app, cookie untouched (the
  sign-in page calls `router.refresh()` right after authenticating, so deleting on sight
  made every sign-in undo itself). Invalid, unreadable or revoked ⇒ delete it, which breaks
  the `/` ↔ `/auth/signin` loop a server-rejected token would otherwise cause.
  `src/proxy.test.ts` pins all three cases.

Security headers are set for every route in `next.config.ts` (`headers()`):
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-DNS-Prefetch-Control`,
`Permissions-Policy` (camera/mic/geo/topics off), `Strict-Transport-Security`, and a CSP
(key directives: `default-src 'self'`; `script-src 'self' 'unsafe-inline'` — inline is
needed for Next's bootstrap/RSC scripts, `unsafe-eval` only in development for React
Refresh; `object-src 'none'`; `style-src 'unsafe-inline'` for PrimeReact; `worker-src 'self'` for the service
worker; `frame-ancestors 'none'`; plus `img-src`/`font-src`/`connect-src`/`base-uri`/
`form-action` all `'self'`-scoped and `upgrade-insecure-requests` — full list in
`next.config.ts`). `/sw.js` is additionally served `no-cache, no-store` with
`Service-Worker-Allowed: /`. `poweredByHeader: false`. Because inline script is allowed,
markup built from strings must escape user text: ECharts tooltip formatters return HTML,
so every name/category/series/axis string goes through `escapeHtml`
(`src/lib/html-escape.ts`); `src/lib/security-helpers.test.ts` fails on a raw
`${x.name}`-style interpolation inside an HTML template literal in `src/components`.

## 11. Instrumentation & background work

`src/instrumentation.ts` `register()` (Node runtime only): installs
`installTimestampedConsole()` (`src/lib/server-logger.ts` — ISO-timestamp prefix on every
`console.*`), then applies a pending add-on password reset (`runAdminPasswordReset` in
`src/lib/addon-maintenance.ts` — a no-op unless `SAMPOLIO_RESET_ADMIN_PASSWORD=true`, and never
allowed to stop the server starting), then `startBankScheduler()` (`src/lib/bank/scheduler.ts`,
30-min tick, per-account daily rate limits from `src/lib/bank/constants.ts`), then
`startHaSummaryScheduler()` (`src/lib/ha-summary-scheduler.ts` — an `unref`'d interval that pushes
numbers-only summaries to Home Assistant, off unless `HA_SUMMARY_MINUTES` and `HA_WEBHOOK_URL` are
both set). Those two schedulers are the only background timers; there are no queues or cron.
Bank-sync mechanics: [`bank-sync.md`](bank-sync.md).

Split-activity Home Assistant webhook POSTs (`src/lib/split-notify.ts`) run
**post-response** via `after()` from `next/server` — the codebase's only use of that
hook — so the mutation returns before any outbound HTTP happens. Fire-and-forget: no
retry, no queue. Contract and opt-outs: [`features.md`](features.md) §1.

## 12. PWA

Installable PWA: `src/app/manifest.ts` (static manifest, `display: standalone`, theme
`#2F6B4F`), master icons in `public/icons/` (regenerate PNGs with
`node scripts/generate-icons.mjs`), and `public/sw.js` registered by
`<ServiceWorkerRegister>` in the root layout (production-only, no-op on localhost).
`sw.js` strategies: GET + same-origin only; never intercepts `/api/`, `/auth/`, or RSC
requests; **network-first** for navigations with `public/offline.html` fallback;
**cache-first** for hashed `/_next/static/*`; **stale-while-revalidate** for `/themes/*` and
`/icons/*`; everything else uncached. `CACHE_VERSION` (currently `'v7'`) must be bumped on
any deploy that changes cached assets. Responsive/PWA UI rules: root `AGENTS.md`
and [`src/components/AGENTS.md`](../src/components/AGENTS.md).

## 13. Frontend structure

`src/components/`:

| Directory | Contents |
|---|---|
| `layout/` | `AppLayout` (AppContext + SessionProvider + ToastProvider host), `SidebarNav`, `MobileTopBar`, `BottomNav` (1–4 user-chosen tabs + fixed "More"; resolved by `src/lib/bottom-nav-prefs.ts` from `UserPreferences.bottomNavIds`, customizable in Settings → General), `MobileNavDrawer`, shared `nav-config.tsx` (single source for all four nav surfaces) |
| `providers/` | `PrimeProvider`, `ThemeProvider`, `ToastProvider`, `CelebrationProvider`, `ServiceWorkerRegister` |
| `charts/` | ECharts/Chart.js components (cashflow waterfall, treemap, monthly flow, net-worth, wealth, scenario comparison) |
| `modals/` | Cashflow item modal, occurrence-override dialog, users (admin) modal |
| `home/` | `HomeDashboard` (bank glance strip, projected-month tile, merged split balances + activity card) |
| `bank/` | Connections settings panel, account picker, transaction ledger table, account-order dialog |
| `cashflow/` | Collapsing header, month strip, month-details panel, projection table |
| `overview/` | `BannerStack`, `KpiGroup`, plan-check card (`forecast-vs-actual-card.tsx`), net-worth explain dialog |
| `budgets/` | Merged-page Budgets section, setup wizard, verdict card, coverage bars, expense log, dialogs |
| `goals/` | Goal card, create/edit dialog |
| `trips/` | Merged-page Trips section, trip card, create/edit dialog, per-diem breakdown |
| `mortgage/` | Setup wizard, ledger table, charts, Sankey, reconcile/import dialogs |
| `split/` | Quick-add modal, `SplitEditor`, expense/settle/recurrence/import dialogs, activity feed, `group-period-card` (last-30-days insights) |
| `onboarding/` | Onboarding wizard |
| `reconcile/` | Reconciliation wizard |
| `ui/` | `CommandPalette`, `EntityListDrawer`, `EntityModalRouter`, `KpiTile`, `AlertBanner`, `HelpHint`, `EmptyState`, skeletons, delayed-loading primitives, form primitives |

State management is React Context only — `AppContext` in
`src/components/layout/app-layout.tsx` (drawer state, selected account, refresh callbacks,
sidebar state); no Redux/Zustand. Hooks (`src/lib/hooks/`): `use-delayed-flag.ts` (spinner
debounce), `use-media-query.ts` (SSR-safe `useIsMobile`), `use-month-selection.ts`
(cashflow month selection), `use-reduced-motion.ts`, and `use-dwell-seen.ts` (split
"seen" dwell tracking). Forms use React Hook Form +
Zod resolvers with PrimeReact inputs wrapped in `Controller`. Pure calculation engines live
beside the UI in `src/lib/` (`projection.ts`, `wealth-projection.ts`,
`mortgage-projection.ts`, `retrospective.ts`, `split-utils.ts`, `budget-utils.ts`, etc.) —
see [`projections-and-reconciliation.md`](projections-and-reconciliation.md) and
[`features.md`](features.md).

## 14. Types & schemas

All domain types (entities, `Create*`/`Update*Request`, `ApiResponse<T>`, projection shapes)
are centralized in the single file `src/types/index.ts`; `src/types/next-auth.d.ts` augments
the NextAuth session. Zod form/action schemas live one-per-feature in `src/lib/schemas/`
(`auth`, `bank`, `budget`, `cashflow-item`, `data-transfer`, `goal`, `mortgage`,
`occurrence-override`, `planned-item`, `recurring-item`, `salary-config`, `split`, `trip`).
Entity IDs are `uuid` v4 strings.

## 15. Testing

Vitest (`vitest.config` + `src/test/setup.ts` with jest-dom + jsdom stubs for
localStorage/matchMedia; mock factories in `src/test/mocks.ts`; `src/test/render.tsx`
wraps components in ThemeProvider). ~74 test files:

- **Pure engines** (`src/lib/*.test.ts`): `projection`, `wealth-projection`,
  `mortgage-projection` (exact-match reference-spreadsheet reproduction), `mortgage-utils`,
  `mortgage-transfer-utils`, `retrospective`, `current-month-actuals`, `salary-utils`,
  `taxed-income-utils`, `budget-utils`, `budget-csv`, `csv-utils`, `debt-utils`,
  `goal-utils`, `per-diem-utils`,
  `bank-utils`, `maintenance-utils`, `split-utils`, `split-draft`, `split-csv`,
  `split-notify` (pure payload builder + opt-out gate + the fire-and-forget transport
  with a stubbed `fetch`; `notifySplitActivity` itself is out of scope — `after()`
  needs a request scope), `bank-split-match`, `data-transfer-utils`, `scenario-utils`,
  `chart-descriptions`
- **Bank engine** (`src/lib/bank/*.test.ts`): `card-billing`, `dedup`, `mappers`,
  `reconcile-links`, `link-identity`, `apply-link-balances`, `scheduler`,
  `card-payment-match`, `repair-booking-dates`
- **DB layer** (`src/lib/db/*.test.ts`): `encryption`, `budgets`, `planned-items`,
  `reconciliation`, `data-transfer`, `taxed-income`, `path-safety` (traversal ids,
  data-dir containment, import id/field rules, atomic 0600 writes, GCM tag length),
  `concurrency-and-sessions` (first-user race, locked read-modify-write, lockout,
  dummy-bcrypt timing, session revocation), `file-format-v2` (path binding, swapped files,
  v1 compatibility and refusal, script/app interoperability, re-encrypt and rotation)
- **Security & regression** (`src/lib/*.test.ts`, `src/proxy.test.ts`,
  `src/lib/actions/security.test.ts`): `security-helpers` (client IP, callback-path
  sanitiser, `escapeHtml`, the raw-tooltip-interpolation guard, member-lookup throttle),
  `calculation-regressions` (recurrence month-end/leap days, cents rounding, split
  weights, per-diem time-zone independence, projection length cap), the proxy (forged
  cookies, XFF rotation, body cap) and the audit's exploit inputs through real actions
- **Schemas** (`src/lib/schemas/*.test.ts`): `auth.schema`, `cashflow-schemas`,
  `occurrence-override.schema`
- **Convenience engines** (`src/lib/*.test.ts`): `category-utils`,
  `recurring-detection`, `forecast-vs-actual`, `bottom-nav-prefs`
- **Local-only parity suites** (`*.local.test.ts`, **gitignored**): mirror a
  committed suite but assert against the maintainer's real financial records
  (`mortgage-projection.local`, `split-csv.local`). Vitest's default glob picks
  them up, so `pnpm test` runs them locally; they never ship. Every *committed*
  fixture is synthetic — invented figures, placeholder people. Change an engine
  and you update both halves.
- **Components** (`src/components/**/*.test.tsx`, jsdom via a
  `// @vitest-environment jsdom` docblock per file): the shared UI primitives
  (`alert-banner`, `kpi-tile`, `empty-state`) plus the highest-state components —
  the cashflow item modal, the split editor, and the reconcile wizard (server
  actions mocked with `vi.mock`)
- **Home Assistant add-on runtime** (`src/test/*.test.ts`, covering repo-root
  files the app itself never imports): `ha-ingress-proxy` (path/Location
  rewriting, `X-Ingress-Path` validation, and integration cases against a real
  loopback upstream), `run-sh` (options.json → environment mapping, required-secret
  refusal, PEM write, Tailscale invocation — the real script run against PATH
  stubs for `tailscale`/`tailscaled` and node's long-running children), and
  `addon-manifest` (`config.yaml` ↔ `package.json` ↔ `run.sh` consistency, plus
  the unpublished-port and no-privileges posture)
- **Auth & add-on recovery** (`src/lib/*.test.ts`, `src/proxy.test.ts`): `auth-cookies`
  (cookie `Secure`/name from `AUTH_URL`, fail-safe), `proxy` (a valid session survives the
  auth pages, an invalid one is cleared), `addon-maintenance` (password reset runs once),
  `ha-summary` / `ha-summary-scheduler` (allowlisted keys only, no IBAN or line-item text;
  off unless configured)

**No coverage exists for**: most pages, server actions (auth/validation/cache-tag
behavior — except a representative goals/trips/user-preferences slice and the security
regression suite), the bank client/connect/sync modules, and there are no e2e/browser tests. Manual
verification uses the `sampolio-preview` launch config + `preview_*` tools.

## 16. Tooling

`package.json` scripts: `dev` (`next dev -p 4999 -H 127.0.0.1` — loopback only, since
`dev:preview` enables a password-less login; pass `-H 0.0.0.0` deliberately to test from
another device), `dev:preview` (same, additionally sets `DEV_AUTH_BYPASS`), `build` (`copy-themes` + `next build`), `start`, `lint` (`eslint`),
`test` / `test:watch` / `test:coverage` (vitest), `copy-themes` + `postinstall`
(`scripts/copy-themes.mjs` — recolors PrimeReact's `lara-{light,dark}-green` theme CSS into
`public/themes/sampolio-{light,dark}.css`; the hand-authored `public/themes/glass-overrides.css`
liquid-glass override layer is loaded after the theme by `theme-provider.tsx`).

**Port convention**: production (`com.sampolio.app`, `next start`) owns **3999**; dev
(`pnpm dev` or the `.claude/launch.json` `sampolio-preview` config) runs on **4999** against a
`./data` copy — no collision with prod. Prod builds into `.next-prod` via
`NEXT_DIST_DIR`; dev uses `.next`.

CI: `.github/workflows/ci.yml` (read-only token, SHA-pinned actions) runs install →
lint → `tsc --noEmit` → test → `pnpm audit --prod` → build on pushes to `main` and PRs, and a
`docker` job that builds the `Dockerfile` (base image pinned by digest) and smoke-tests the
container (HTTP 200, no `.env`/`.git` in the image, strict path binding on, v2 `0600` data files). `.github/dependabot.yml` opens
weekly npm and Docker and monthly Actions update PRs. Transitive
security floors live in `pnpm-workspace.yaml` `overrides`.

Lint: flat config `eslint.config.mjs` = `eslint-config-next/core-web-vitals` +
`eslint-config-next/typescript`, ignoring `.next/`, `.next-prod/`, `out/`, `build/`.

## 17. Shared UI implementation rules

The component inventory is in [`src/components/AGENTS.md`](../src/components/AGENTS.md).
This section owns cross-cutting UI behavior; display-mode and money-masking details
live in [`features.md`](features.md#10-demo-mode-ui-only-money-masking).

### Feedback & loading UX (perceived performance)

Every mutation should confirm; every load should feel instant. The primitives:

- **Global toast** — one `<Toast>` is mounted by `ToastProvider` (`src/components/providers/toast-provider.tsx`, wrapping the app in `AppLayout`). Use `useToast()` → `success/error/info/show`; **do not** mount per-component `<Toast>` refs. Fire a toast after every create/update/delete/settle/import so the user knows it worked.
- **Global confirm dialog** — likewise, exactly ONE `<ConfirmDialog />` receiver is mounted in `AppLayout`; components call PrimeReact's imperative `confirmDialog({...})` and **never mount their own `<ConfirmDialog />`** — every mounted receiver answers every `confirmDialog()` call, so a second receiver produces a stacked duplicate that stays open after accept/reject.
- **Delayed loading** — `useDelayedFlag(active, 300)` (`src/lib/hooks/use-delayed-flag.ts`) reveals a flag only after `active` holds for ~300ms and drops it instantly when false, so fast ops (the norm after the HKDF encryption fix) never flash a spinner. `DelayedSpinner` / `DelayedSkeleton` (`src/components/ui/delayed-loading.tsx`) build on it.
- **Instant shell + skeletons** — heavy pages render their chrome immediately and show a content-shaped, delayed skeleton for the data region instead of a full-page `ProgressSpinner`. Reusable layouts in `src/components/ui/skeletons.tsx` (`KpiGridSkeleton`, `ChartsPageSkeleton`, `ListPageSkeleton`, `HomeSkeleton` — Home's glance/balances/activity region, `SplitDetailSkeleton`). Skeletons must match the real content's position AND height — a skeleton taller than what it replaces makes content jump on load. Pages fetch with a first-load-only `loaded` flag: refetches update silently and never re-show the skeleton; register the AppContext refresh callback in a **separate** effect from the fetch effect (goals/page.tsx is the reference pattern).
- **Optimistic UI** — on daily-driver hot paths (e.g. split-expense delete, recurring pause/resume in `split/[id]/page.tsx`), apply the change to local state immediately + toast + reconcile with a background refresh; on failure, roll back the snapshot and toast the error. Server actions/schemas are unchanged.
- **Chart code-splitting** — heavy charts are lazy via `next/dynamic({ ssr: false, loading })`: the ECharts trio on cashflow (`monthly-flow`/`cashflow-waterfall`/`expense-treemap`) and the seven mortgage charts (one shared chunk). The **modal router is lazy too**: `entity-modal-router.tsx` (mounted by `AppLayout` on every page) `next/dynamic`s `CashflowItemModal`, `EntityListDrawer`, `UsersModal`, and `QuickAddSplitModal`, so none of them ship in the shared first-load bundle. Keeps each page's initial JS small.
- **Shared UI primitives** (`src/components/ui/`) — use `AlertBanner` for reminder/attention banners, `KpiTile` for KPI cards (zero-delta change badges are suppressed automatically; optional `help` prop renders a plain-language hint), `HelpHint` for tap-friendly "?" explanations, and `EmptyState` for empty lists; never hand-roll these per page.
- **Chart explanations** (`src/components/ui/chart-explain.tsx` + pure engine `src/lib/chart-descriptions.ts`, unit-tested) — EVERY canvas chart gets an "Explain" button opening an inline `.collapse-grid` panel with (a) canned "How to read this chart" cue rows (`ChartCueSwatch` color/shape swatches matching the real palette) and (b) a generated "in plain words" description built from the chart's own data (money ALWAYS via `formatCurrency` with `demoMasked` in the describe `useMemo` deps; sentences ≤ ~15 words; proportions via `shareToWords`). An sr-only copy is always rendered and wired via `aria-describedby`. The panel defaults OPEN in Simple display mode (words first). The three cashflow charts additionally have step tours (`useChartTour` + `ChartTourBar`, ECharts `dispatchAction` highlights). New charts must integrate via the `ChartExplain` wrapper and add a describe function + test to `chart-descriptions.ts` — never ship a bare canvas chart.
- **Plain language** — `src/lib/plain-language.ts` is the single jargon→everyday-wording map (`plainTerm(key, isSimple)` picks the wording per display mode, `helpText(key)` feeds `HelpHint` tooltips). One concept, one name app-wide (e.g. reconciliation is always "monthly check-in" in UI copy; Euribor banners lead with "mortgage interest rate"). Add new finance terms to the map, never inline in a component.
- **Category colors** — `CATEGORY_COLORS` + `getCategoryColor(category)` in `src/lib/constants.ts` is the single category→color map (warm = discretionary, cool = fixed/income; covers cashflow ITEM_CATEGORIES **and** the SPLIT_CATEGORIES names) used by the expense treemap, the cashflow Sankey, category badges, the split spend chart's By-category mode, the split group-detail category treemap, and the plan-check card's dots. Never assign category colors positionally.
- **Category auto-suggest** — `guessItemCategory(name)` (`src/lib/category-utils.ts`, pure/tested) prefills the cashflow item form's category from the name (the split quick-add has its own `guessCategory` for split categories), and also recategorizes bank merchant names (incl. common Finnish chains) for the Overview plan-check card. Suggestions re-evaluate while auto-set and stop once the user picks manually.

### Motion (animations, transitions, press feedback)

Motion is feedback, never choreography: 120–250ms, opacity/transform only, CSS-first (no
motion library), and it must never gate input. The primitives:

- **Tokens** — durations `--motion-fast` (120ms, press), `--motion-base` (180ms, hovers/fades),
  `--motion-slow` (250ms, entrances/expanders) on `:root` in `src/app/globals.css`; easings
  `--ease-fluid` (entrances) / `--ease-snap` (press/settle) in its `@theme` (→ Tailwind
  `ease-fluid`/`ease-snap` utilities). Never hardcode new durations/curves — consume the tokens
  (CSS files use `var(--motion-*)`; note `public/themes/glass-overrides.css` changes require a
  `CACHE_VERSION` bump in `public/sw.js`).
- **Entrance utilities** — `animate-fade-in` (180ms opacity), `animate-rise-in` (250ms opacity +
  8px rise), `animate-scale-in` (160ms; command palette). They're *mount* animations with the
  default `none` fill — NEVER add `forwards`/`both`: a filled entrance keeps the element
  permanently promoted (own stacking context/composited layer), which breaks `backdrop-filter`
  on glass headers above it (content stays crisp instead of blurring). Apply to a wrapper that
  mounts once (skeleton→content swap, conditional-render reveals like "Show archived");
  refetches must not remount the wrapper. Caution: they animate `transform`, so never put one on
  an element that positions itself with `-translate-*` utilities (wrap it instead — see the
  command palette's inner/outer split).
- **Page entrance** — `PageEntrance` (`src/components/ui/page-entrance.tsx`) wraps page content
  in `rise-in` and imperatively RESTARTS it on pathname change; a bare `animate-rise-in` on a
  route wrapper never plays because Next 16 pre-mounts prefetched routes hidden (the animation
  clock is spent before reveal; layout effects fire at reveal, hence the restart). Used by
  `src/app/(dashboard)/template.tsx` and Home (`home-dashboard.tsx`, outside the group).
- **Press/hover** — `.pressable` (globals.css, un-layered so it wins on PrimeReact Cards) gives
  card-sized clickable surfaces transition + `:active` scale(0.98), plus a centralized guarded
  hover box-shadow lift (`@media (hover: hover) and (pointer: fine)`, box-shadow only — never
  transform, so it can't fight Tailwind `hover:scale-*` utilities like KpiTile's) — per-element
  `hover:shadow-md` is now optional/redundant on `.pressable` surfaces. Text/list rows get
  `transition-colors` + an `active:bg-*` tint instead — never transform. PrimeReact buttons/inputs/
  menu rows are covered globally in `glass-overrides.css` (buttons get `:enabled:active`
  scale(0.97)); when adding a `transition` there, MERGE with the theme's property list on the
  theme's own selector — a later shorthand replaces it wholesale, and a lower-specificity selector
  silently never applies. Ripple stays off. Tailwind's `hover:` is already touch-safe; hand-written
  CSS `:hover` must sit in `@media (hover: hover) and (pointer: fine)`.
- **Cursor** — Tailwind v4's preflight no longer sets `cursor: pointer` on `<button>` (v3 did), and
  the PrimeReact theme CSS never set it on `.p-button`/`.p-menuitem-link`. Restored globally:
  `globals.css` covers native `button`/`[role="button"]`, `glass-overrides.css` covers
  `.p-button:enabled`/`.p-menuitem-link`.
- **Reduced motion** — one global kill-switch at the end of globals.css (0.01ms durations, covers
  PrimeReact too). Never add per-component `prefers-reduced-motion` blocks; JS-driven motion bails
  out via `useReducedMotion()` (`src/lib/hooks/use-reduced-motion.ts`).
- **Expanders** — `.collapse-grid`/`.is-open` (globals.css) animates auto-height for
  always-mounted content (add `inert` when closed); conditionally-rendered or heavy reveals use
  `animate-fade-in` instead.
- **Jiggle-mode reorder** — the shared iOS-style reorder primitive
  (`src/components/ui/jiggle-reorder.tsx`: `useJiggleReorder` hook + `JiggleModeBar` bottom pill;
  pure math in `src/lib/reorder-utils.ts`). A long-press (~500ms) enters a persistent "jiggle
  mode": every item wobbles and any item can be dragged to a new slot (FLIP-style sibling shifts
  on the motion tokens); Escape/Done (or the bar) exits. Keyboard + sr-only entry buttons make it
  a11y-complete. The wobble (`jiggle-wobble`, ±1deg infinite) lives on the inner
  `[data-jiggle-inner]` element while the drag translate lives on the outer `[data-jiggle-item]`,
  so the two transforms never collide. Non-passive native `touchmove` `preventDefault` keeps the
  drag from scrolling the page. Used by **/split** (group list → `UserPreferences.splitGroupOrder`),
  **/bank** (one shared mode across two rows — connection tabs + accounts within the active
  connection → `bankAccountOrder`), and **Settings → General → Mobile navigation**
  (`mobile-nav-card.tsx` bottom-nav tab preview → `bottomNavIds`). Skipped entirely under reduced motion (the hook bails via
  `useReducedMotion()` and the CSS wobble is killed).
- **Celebrations** — `useCelebration().celebrate('checkmark' | 'confetti')`
  (`src/components/providers/celebration-provider.tsx`, mounted inside `ToastProvider` in
  `app-layout.tsx`): a ~1.5s checkmark badge-pop on split-expense create (an expanding ring
  ripple + a 6-dot burst, then a 450ms check draw; overlay unmounts at ~1550ms) and a ~1.5s
  hand-rolled canvas confetti burst on settle-up. Classes `celebrate-container`/`-ring`/`-badge`/
  `-dot`/`-check`, keyframes `celebrate-pop`/`-draw`/`-ring`/`-dot` in globals.css — every
  animation in that block uses the `forwards` fill (the whole overlay unmounts, so there is no
  lingering-composited-layer concern the entrance utilities have; a no-fill pop reverted to its
  start frame before unmount and flickered). Both render `z-[2000] pointer-events-none` (never
  gate input). The checkmark pop, the confetti burst, and the jiggle-mode wobble above (infinite,
  transform-only, dead under reduced motion) are the THREE sanctioned exceptions to the ≤250ms
  rule — no further exceptions without amending this list. Gated by `useReducedMotion()` — reduced
  ⇒ `celebrate()` returns `false` and callers fall back to the flash-highlight row + toast.
- **Do NOT**: `transition: all`, animating height/width/filter/backdrop-filter, effects >250ms
  (except the three sanctioned exceptions above), count-up on money values, exit animations on
  optimistic deletes or overlay close, list stagger, press effects on inputs. The bottom-nav active pill (`bottom-nav.tsx`) is the one sanctioned
  positional animation (N+1 equal user-chosen cells, `left` calc from `100 / cells`); its `<nav>` must stay `fixed` **without**
  `relative` (fixed already anchors the absolute pill; `relative` would win the cascade and
  un-fix the bar). Don't touch `.progressbar-instant` or `flash-highlight`. In CSS comments,
  never write a star-followed-by-slash glob (e.g. spell `--motion-{fast,base,slow}`) — it closes
  the comment and the parser eats the next rule.

### Responsive & PWA (mobile + desktop)

**Every new page, component, and interface MUST be responsive** — it has to look and work well on a phone (~375px wide) *and* on desktop, with no horizontal overflow. This is a hard requirement, not a nice-to-have. Always check both a mobile (~390px) and a desktop (~1280px) breakpoint before considering UI work done (use any available browser/UI automation with a resized viewport — assert `document.documentElement.scrollWidth <= window.innerWidth`). The app is also an **installable PWA** (Add to Home Screen on iOS/Android/desktop).

- **Breakpoint switch — Tailwind `lg` (1024px)**: below `lg` = mobile chrome, at/above `lg` = the desktop sidebar layout. **Drive visibility with CSS** (`lg:hidden` / `hidden lg:block`) to stay hydration-safe and avoid flashes; only use the SSR-safe `useIsMobile()` / `useMediaQuery()` hook (`src/lib/hooks/use-media-query.ts`) when logic must branch (which component to mount, a numeric prop, `maximized={isMobile}`).
- **Navigation chrome**: desktop uses the fixed collapsible `SidebarNav` (`hidden lg:flex`); mobile uses `MobileTopBar` (hamburger + brand + search; the monthly check-in deliberately lives on Overview, not in the chrome), `BottomNav` (1–4 user-chosen tabs + a fixed "More"; see `src/lib/bottom-nav-prefs.ts`), and `MobileNavDrawer` (PrimeReact `Sidebar`, the full menu). All four nav surfaces read the **shared `src/components/layout/nav-config.tsx`** (`navItems`, `isNavItemActive`, `useUserMenuItems`) — add a nav entry there, never in one surface only. The sidebar/drawer user button renders the user's `UserAvatar` (not a generic icon), and the user-menu's avatar+name+email header item navigates to `/settings?tab=account` — the Settings page maps a `?tab=` slug to the index of its *rendered* tabs (Simple mode hides some), unknown slug ⇒ first tab. `<main>` uses `lg:ml-16`/`lg:ml-64` (no base margin) + top/bottom padding for the mobile bars, all with `env(safe-area-inset-*)` so the iPhone notch / home indicator are respected (root `viewport` sets `viewport-fit=cover`). Mobile chrome (`MobileTopBar`, `BottomNav`) is `z-40`; the desktop `SidebarNav` and PrimeReact/command-palette overlays sit at `z-50`+.
- **Dialogs**: a global mobile cap in `globals.css` (`@media (max-width:640px)` → `.p-dialog { width:95vw; max-width:95vw; max-height:calc(92vh − safe-area insets) }` + scrollable content) fixes **every** PrimeReact `Dialog` at once — you normally don't need per-dialog responsive props. For genuinely huge wizards, `maximized={isMobile}` is an option (the 95vw cap turns "maximized" into a tall centered box; the inset-aware `max-height` keeps its header clear of the dynamic island in the installed PWA).
- **Overlay safe-area insets (installed PWA)**: portalled overlays render at the viewport edges (`viewport-fit=cover`), so `globals.css` pads them for `env(safe-area-inset-*)`. Off-canvas drawers (PrimeReact `Sidebar`) get top/bottom/side padding so the header clears the island and the footer clears the home indicator — **the position class lives on the `.p-sidebar-mask`, the panel is its child**, so target `.p-sidebar-mask.p-sidebar-left > .p-sidebar` (not `.p-sidebar.p-sidebar-left`, which matches nothing). Top-anchored `Toast`s drop below the island. Sticky in-page headers must pin **below** the mobile top bar (`sticky top-[calc(3.5rem+env(safe-area-inset-top))] lg:top-[env(safe-area-inset-top)]`), never `top-0` — the `lg:` offset matters because a **desktop-breakpoint installed PWA (iPad)** also runs edge-to-edge under the OS status bar with no mobile top bar to clear it. For the same reason `<main>` keeps `lg:pt-[env(safe-area-inset-top)]`/`lg:pb-[env(safe-area-inset-bottom)]` (not `lg:pt-0`), the desktop `SidebarNav` aside pads itself with both insets, and `AppLayout` paints a fixed `hidden lg:block` glass strip of height `env(safe-area-inset-top)` under the status bar so scrolled content never shows through it (all of these are 0 in a normal desktop browser).
- **Tables (mixed strategy)**: lighter tables (e.g. cashflow projection, bank ledger) render a `lg:hidden` card/list view beside a `hidden lg:block` DataTable; the wide mortgage ledger keeps a single DataTable with a **frozen first column** (`frozen alignFrozen="left"` + `scrollable`) for horizontal scroll. Don't let a raw wide table overflow the viewport.
- **Charts**: containers must be width-fluid (`width:100%`) with responsive heights (e.g. `h-72 lg:h-96`); Chart.js charts set `maintainAspectRatio:false` and fill the wrapper (don't also pass a fixed `height` prop — they fight). ECharts/Sankey resize to the container; pass a shorter mobile height where it helps.
- **Toolbars / page headers**: stack on mobile (`flex-col sm:flex-row`), full-width controls (`w-full sm:w-auto` / `flex-1 sm:flex-none`). Full-bleed sticky bars that use negative margins must match the responsive content padding (`-mx-2 px-2 sm:-mx-4 sm:px-4 lg:-mx-6 lg:px-6`). Keep tap targets ≥44px. `TabView`s with many tabs use `scrollable`.

PWA manifest, service-worker caching, and registration details live in §12.

### Forms

New and migrated forms use **React Hook Form + Zod** (`@hookform/resolvers/zod`):
```typescript
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { someSchema, type SomeFormData } from '@/lib/schemas/some.schema';

const { control, handleSubmit, formState: { errors } } = useForm<SomeFormData>({
  resolver: zodResolver(someSchema),
  defaultValues: { ... },
});
```
- Zod schemas live in `src/lib/schemas/`
- PrimeReact inputs require `Controller` wrapper (they use value/onChange, not ref-based)
- Legacy forms may still use raw `useState` — migrate when touching them

### Dates, IDs, and salary calculations

Use `date-fns` for dates, `YYYY-MM` (`YearMonth`) for month values, `uuid.v4`
for entity IDs, and Finnish `fi-FI` display formatting. Use `calculateNetSalary`
from `src/lib/salary-utils.ts` rather than inline salary math. Taxed income uses
`calculateTaxedIncomeNet` from `src/lib/taxed-income-utils.ts`: salary taxes gross
plus taxable benefits; taxed income taxes raw gross. The DB freezes the taxed
net amount at write time, and the modal uses the same formula for its preview.

### Adding an entity

1. **Define types** in `src/types/index.ts` (entity + create/update request types)
2. **Create DB file** in `src/lib/db/` following the existing pattern (CRUD + file I/O)
3. **Add cached queries** in `src/lib/db/cached.ts`
4. **Create server actions** in `src/lib/actions/` with Zod validation and cache tags
5. **Create Zod schema** in `src/lib/schemas/` for form validation
6. **Add UI components** (modal form, list display) following existing patterns
7. **Update projection engine** if the entity affects financial projections
