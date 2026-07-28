# Sampolio — System Architecture

Current-state reference for developers (human and AI) extending the app or hunting bugs.
Conventions and invariants live in the root [`AGENTS.md`](../AGENTS.md); deep feature
mechanics live in [`features.md`](features.md), [`projections-and-reconciliation.md`](projections-and-reconciliation.md),
[`mortgage.md`](mortgage.md), [`bank-sync.md`](bank-sync.md), and [`operations.md`](operations.md).

## 1. Stack

| Layer | Package | Version (package.json) |
|---|---|---|
| Framework | `next` | 16.2.7 (App Router, `cacheComponents: true`) |
| UI runtime | `react` / `react-dom` | 19.2.7 |
| Language | `typescript` | ^6.0.3 (strict) |
| Components | `primereact` | ^10.9.8 (+ `primeicons` ^7.0.0, `react-icons` ^5.7.0, `lucide-react` ^1.23.0) |
| Styling | `tailwindcss` | ^4.3.0 (via `@tailwindcss/postcss`) |
| Auth | `next-auth` | 5.0.0-beta.31 (+ `bcryptjs` ^3.0.3 for password hashing) |
| Validation | `zod` | ^4.4.3 |
| Forms | `react-hook-form` ^7.81.0 + `@hookform/resolvers` ^5.4.0 |
| Charts | `echarts` ^6.1.0 (+ `echarts-for-react` ^3.0.6), `chart.js` ^4.5.1 |
| Avatar crop | `react-easy-crop` | ^6.2.2 (lazy-loaded in the avatar editor) |
| Dates | `date-fns` | ^4.4.0 |
| JWT (bank API) | `jose` | ^6.2.3 (RS256 for Enable Banking) |
| IDs | `uuid` | ^14.0.1 |
| Tests | `vitest` ^4.1.10, `@testing-library/react` ^16.3.2, `jsdom` ^29.1.1 |

Package manager: **pnpm 11.5.1** (`packageManager` field). Node: **>= 26** (`engines`; `.nvmrc` = `v26`).
There is no external database and no ORM — persistence is encrypted JSON files on disk.

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
| `/` | `src/app/page.tsx` | Home dashboard (quick-add, split balances, activity). Server component: `auth()` + `redirect('/auth/signin')`; wraps `AppLayout` itself (outside the route group). |
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
  change — see root `AGENTS.md` → "Motion"); `/` wraps itself the same way in
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
| `bank.ts` | `getBankFeatureStatus`, `getBankConnections`, `listBankAspsps`, `startBankConnection`, `reconnectBankConnection`, `refreshBankConnection`, `disconnectBankConnection`, `updateBankAccountLink`, `getBankConnectionsNeedingAttention`, `getCardLiabilities`, `getCreditCardOptions`, `getCardStatementBreakdownForAccount`, `getBankSyncRuns`, `getBankTransactionsForLink`, `getBankConnection` |
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
| `user-preferences.ts` | `getUserPreferences`, `completeOnboarding`, `updateCategories`, `updateCheckInReminders`, `updateCheckInNotifications`, `updateSplitNotificationPrefs` (five-key opt-out record for the split webhook events), `getSplitNotifyStatus` (is `HA_WEBHOOK_URL` configured), `updateBankAccountOrder`, `updateSplitGroupOrder`, `updateDisplayMode`, `updateTaxDefaults` |
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
(no barrel — import the concrete module).
Root is `getDataDir()` = `$DATA_DIR` or `<cwd>/data`. Exact layout (file names from code):

```
data/
├── .encryption_key  .auth_secret  .auth_url    # secrets as dot-files; injected as env by launch config / prod plist
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
transaction ledgers, user preferences), and **monthly chunks** (split expenses). There is no
file locking; split groups get a per-group in-process mutex (`withGroupLock` in
`src/lib/actions/split-groups.ts`), everything else relies on the single-user assumption.

## 7. Encryption

`src/lib/db/encryption.ts`. Every `.enc` file is `base64(salt(64) | iv(16) | gcmTag(16) | ciphertext)`,
AES-256-GCM. The per-file key is derived from `ENCRYPTION_KEY` + the random salt via
**HKDF-SHA256** (`deriveKeyHkdf`, info label `sampolio-file-encryption-v1`); `decrypt()` tries
HKDF first and falls back to legacy **PBKDF2** (100k iterations, SHA-512, LRU-cached) for
pre-migration files — GCM tag verification disambiguates the two. If `ENCRYPTION_KEY` is unset,
`getEncryptionKey()` **throws in production** (refusing to start); outside production it logs
a warning and falls back to a hardcoded default key
(`'sampolio-default-encryption-key-change-in-prod'`) as a dev convenience.
Details and migration notes: `src/lib/db/AGENTS.md` (one-shot migrator: `scripts/reencrypt-data.mjs`).

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
  `verifyPassword` (`src/lib/db/users.ts`), account lockout (`isAccountLocked`,
  `recordFailedLogin` — also recorded for nonexistent emails to block enumeration),
  `isActive` check.
- **`dev-bypass`**: only registered when `NODE_ENV !== 'production'` **and**
  `DEV_AUTH_BYPASS` is set; signs in as that email with no password. Driven by the
  `/dev-login` GET route; `src/proxy.ts` additionally redirects cookie-less dev requests for
  `/` and the auth pages straight to `/dev-login`.

Session strategy is **JWT** (`maxAge` 30 days, `updateAge` 1h); the token carries
`id`/`email`/`name`/`role` (`UserRole`), surfaced via `src/types/next-auth.d.ts`. Cookie name
is `__Secure-authjs.session-token` in production, `authjs.session-token` otherwise. Sign-up is
gated by app settings (`checkSignupEnabled` in `src/lib/actions/auth.ts` reads
`cachedGetAppSettings`; toggled from the admin panel). In production an outer
**Cloudflare Access** layer authenticates before requests ever reach the app — see
[`operations.md`](operations.md).

## 10. Middleware & security

`src/proxy.ts` (Edge runtime). Matcher: everything **except** `_next/static`, `_next/image`,
`favicon.ico`, `manifest.webmanifest`, `sw.js`, `offline.html`, `icons`, `themes`, and
`*.png|jpg|svg` (PWA/install assets must load without auth). Behavior:

- **Rate limiting** (in-memory `Map` per IP, 1-minute window, resets on restart):
  unauthenticated requests to `/api/auth*` or `/auth/*` → **20/min**; all other
  unauthenticated requests → **300/min**. Requests bearing a session cookie are exempt
  (server actions burst hundreds of POSTs per page load). 429 with `Retry-After`.
- **Auth redirect** for cookie-less `/` and every path in `PROTECTED_PREFIXES` (see §3).
- **Stale-cookie recovery**: a session cookie on `/auth/signin|signup` means the server-side
  `auth()` rejected the JWT — the middleware deletes the cookie to break the redirect loop.

Security headers are set for every route in `next.config.ts` (`headers()`):
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-DNS-Prefetch-Control`,
`Permissions-Policy` (camera/mic/geo/topics off), `Strict-Transport-Security`, and a CSP
(key directives: `default-src 'self'`; `script-src` allows `unsafe-inline`/`unsafe-eval`
for Next; `style-src 'unsafe-inline'` for PrimeReact; `worker-src 'self'` for the service
worker; `frame-ancestors 'none'`; plus `img-src`/`font-src`/`connect-src`/`base-uri`/
`form-action` all `'self'`-scoped and `upgrade-insecure-requests` — full list in
`next.config.ts`). `/sw.js` is additionally served `no-cache, no-store` with
`Service-Worker-Allowed: /`. `poweredByHeader: false`.

## 11. Instrumentation & background work

`src/instrumentation.ts` `register()` (Node runtime only): installs
`installTimestampedConsole()` (`src/lib/server-logger.ts` — ISO-timestamp prefix on every
`console.*`), then `startBankScheduler()` (`src/lib/bank/scheduler.ts`, 30-min tick,
per-account daily rate limits from `src/lib/bank/constants.ts`). No other daemons, queues, or
cron exist. Bank-sync mechanics: [`bank-sync.md`](bank-sync.md).

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
any deploy that changes cached assets. Responsive/PWA UI rules: root `AGENTS.md`.

## 13. Frontend structure

`src/components/`:

| Directory | Contents |
|---|---|
| `layout/` | `AppLayout` (AppContext + SessionProvider + ToastProvider host), `SidebarNav`, `MobileTopBar`, `BottomNav`, `MobileNavDrawer`, shared `nav-config.tsx` (single source for all four nav surfaces) |
| `providers/` | `PrimeProvider`, `ThemeProvider`, `ToastProvider`, `CelebrationProvider`, `ServiceWorkerRegister` |
| `charts/` | ECharts/Chart.js components (cashflow waterfall, treemap, monthly flow, net-worth, wealth, scenario comparison) |
| `modals/` | Cashflow item modal, occurrence-override dialog, users (admin) modal |
| `home/` | `HomeDashboard` (quick-add card, split balances, activity feed) |
| `bank/` | Connections settings panel, account picker, transaction ledger table, account-order dialog |
| `cashflow/` | Collapsing header, month strip, month-details panel, projection table |
| `overview/` | `BannerStack`, `KpiGroup`, forecast-vs-actual card, net-worth explain dialog |
| `budgets/` | Merged-page Budgets section, setup wizard, verdict card, coverage bars, expense log, dialogs |
| `goals/` | Goal card, create/edit dialog |
| `trips/` | Merged-page Trips section, trip card, create/edit dialog, per-diem breakdown |
| `mortgage/` | Setup wizard, ledger table, charts, Sankey, reconcile/import dialogs |
| `split/` | Quick-add modal, `SplitEditor`, expense/settle/recurrence/import dialogs, activity feed |
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
wraps components in ThemeProvider). ~50 test files:

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
  `reconciliation`, `data-transfer`, `taxed-income`
- **Schemas** (`src/lib/schemas/*.test.ts`): `auth.schema`, `cashflow-schemas`,
  `occurrence-override.schema`
- **Convenience engines** (`src/lib/*.test.ts`): `category-utils`,
  `recurring-detection`, `forecast-vs-actual`
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

**No coverage exists for**: most pages, server actions (auth/validation/cache-tag
behavior — except a representative goals/trips slice), the bank client/connect/sync
modules, `proxy.ts`, and there are no e2e/browser tests. Manual
verification uses the `sampolio-preview` launch config + `preview_*` tools.

## 16. Tooling

`package.json` scripts: `dev` (`next dev -p 4999`), `dev:preview` (same port, additionally
sets `DEV_AUTH_BYPASS`), `build` (`copy-themes` + `next build`), `start`, `lint` (`eslint`),
`test` / `test:watch` / `test:coverage` (vitest), `copy-themes` + `postinstall`
(`scripts/copy-themes.mjs` — recolors PrimeReact's `lara-{light,dark}-green` theme CSS into
`public/themes/sampolio-{light,dark}.css`; the hand-authored `public/themes/glass-overrides.css`
liquid-glass override layer is loaded after the theme by `theme-provider.tsx`).

**Port convention**: production (`com.sampolio.app`, `next start`) owns **3999**; dev
(`pnpm dev` or the `.claude/launch.json` `sampolio-preview` config) runs on **4999** against a
`./data` copy — no collision with prod. Prod builds into `.next-prod` via
`NEXT_DIST_DIR`; dev uses `.next`.

Lint: flat config `eslint.config.mjs` = `eslint-config-next/core-web-vitals` +
`eslint-config-next/typescript`, ignoring `.next/`, `.next-prod/`, `out/`, `build/`.
