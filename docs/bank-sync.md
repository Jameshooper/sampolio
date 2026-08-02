# Bank Sync (Enable Banking, PSD2 AIS)

Developer reference for Sampolio's read-only bank synchronization via [Enable Banking](https://enablebanking.com), a licensed PSD2 Account Information Services (AIS) aggregator. This documents the engine in `src/lib/bank/`, its server actions, storage, and UI surfaces. For env/secrets and production topology see [operations.md](operations.md); for how synced data feeds forecasts and the retrospective see [projections-and-reconciliation.md](projections-and-reconciliation.md); for the app's general layering see [architecture.md](architecture.md). Root conventions live in `AGENTS.md`.

## 1. Overview

Bank sync pulls **balances and transactions** from the user's real bank accounts into Sampolio's local encrypted store. It is strictly additive and strictly read-only:

- **AIS only.** The integration uses account-information endpoints (`/aspsps`, `/auth`, `/sessions`, `/accounts/{uid}/balances`, `/accounts/{uid}/transactions`, `DELETE /sessions/{id}` — see `src/lib/bank/client.ts`). There is no payment-initiation surface anywhere in the codebase; nothing in this feature can move money.
- **Cache-first.** The UI reads only the local encrypted files. The Enable Banking API is touched in a few well-defined places: the sync engine (`src/lib/bank/sync.ts`), the consent flow (`src/lib/bank/connect.ts` + the callback route), and two narrow calls from `src/lib/actions/bank.ts` — `listBankAspsps` (`getAspsps`, the bank picker) and `disconnectBankConnection` (`deleteSession`, best-effort consent revoke).
- **Hard-disable when unconfigured.** `getBankConfig()` (`src/lib/bank/constants.ts`) returns `null` if any required env var is missing; every caller treats `null` as "feature off" and never substitutes a default. `isBankFeatureConfigured()` wraps this, the `getBankFeatureStatus` server action (`src/lib/actions/bank.ts`) reports `{ configured: boolean }` to the UI (Settings shows a "not configured" notice), and `startBankScheduler()` logs `scheduler idle` and returns without starting a timer. No network calls are made in the unconfigured state.

## 2. Configuration & secrets

Three required env vars, one optional override (`getBankConfig` in `src/lib/bank/constants.ts`):

| Env var | Meaning |
|---|---|
| `ENABLE_BANKING_APP_ID` | Application id registered with Enable Banking; also the JWT `kid` |
| `ENABLE_BANKING_REDIRECT_URL` | Consent callback URL; must match the EB control-panel registration |
| `ENABLE_BANKING_PRIVATE_KEY_FILE` | Path to a 0600 PKCS#8 PEM **outside the repo** |
| `ENABLE_BANKING_BASE_URL` (optional) | API base; defaults to `https://api.enablebanking.com` (`DEFAULT_API_BASE_URL`) |

A separate `BANK_SYNC_VERBOSE=1` flag (`isBankSyncVerbose()`) enables per-tick scheduler logging, per-account sync detail, and the API's raw error `detail` bodies (`describeBankError` — may carry PII, which is why it's verbose-only and never persisted; default logs use the PII-free `redactBankError`). Where these values live in production (launchd plist, secrets layout, the Cloudflare tunnel that makes the callback reachable) is covered in [operations.md](operations.md).

## 3. Authentication to the EB API

`src/lib/bank/jwt.ts` (`getAppToken`) mints an **RS256 JWT with `jose`**: header `{ alg: 'RS256', kid: <app id>, typ: 'JWT' }`, issuer `enablebanking.com`, audience `api.enablebanking.com` (`JWT_ISSUER` / `JWT_AUDIENCE`).

- **TTL**: `JWT_TTL_SECONDS = 23h` (a margin under the API's 24h cap). The token is memory-cached and re-minted `JWT_REMINT_SKEW_SECONDS = 5 min` before expiry, so one token is reused across requests.
- The private key is loaded once via `importPKCS8` and kept only in memory; it is never logged or persisted. `resetAppTokenCache()` drops both caches (tests/maintenance).

Every request goes through `ebFetch` in `src/lib/bank/client.ts`, which attaches the bearer token and maps failures to a typed `BankApiError` with a `BankErrorCode`: 401 → `EXPIRED_SESSION`, 403 → `AUTH_FAILED`, 429 or `ASPSP_RATE_LIMIT_EXCEEDED` → `RATE_LIMITED`, 5xx/network → `TRANSIENT`, malformed JSON → `BAD_RESPONSE`. When a PSU IP is available (user-triggered flows) it is sent as `PSU-IP-Address`, which grants a higher rate allowance at the ASPSP.

## 4. Consent flow

Consent (a time-boxed PSD2 authorization requiring SCA) is orchestrated by `src/lib/bank/connect.ts`, shared by the `startBankConnection` server action and the callback route.

1. **Begin** — `beginConnection(userId, aspspName, aspspCountry)` creates a `pending` `BankConnection`, mints a single-use CSRF `state` (32 random bytes hex), calls `POST /auth` requesting `access.valid_until = now + CONSENT_REQUESTED_VALIDITY_DAYS` (**180 days**; the bank may shorten it), stores `{ state, authorizationId }` in the connection's session-secret file, and returns the bank's SCA URL for the browser redirect.
2. **SCA at the bank** — the user authenticates; the bank redirects to `ENABLE_BANKING_REDIRECT_URL`.
3. **Callback** — `GET src/app/api/bank/callback/route.ts` (one of the app's two non-NextAuth API routes, alongside the avatar image endpoint):
   - Requires an authenticated Sampolio session (same hostname, so the cookie is present); otherwise bounces to sign-in.
   - `?error=` → redirect to `/settings?bankError=sca_declined`; missing `code`/`state` → `bankError=missing_params`.
   - Redirect URLs are built against `externalBase()` — `AUTH_URL` first, then `x-forwarded-*` headers — because behind Caddy/Cloudflare the raw `request.url` is the internal bind address.
   - Calls `completeConnection(userId, code, state, psuIp)`.
4. **Complete** — `completeConnection` (`connect.ts`):
   - **CSRF/replay check**: `findConnectionByState` (`src/lib/db/bank-connections.ts`) matches the `state` against this user's stored session secrets; no match → `null` → `bankError=invalid_state`.
   - Exchanges the code via `POST /sessions`; the response is validated with `sessionResponseSchema` (`src/lib/schemas/bank.schema.ts`) — only `session_id` and `access.valid_until` are load-bearing; a parse failure marks the connection `status: 'error'` / `lastError: 'BAD_RESPONSE'`.
   - Maps the session's accounts (`mapSessionAccounts`) and merges them with existing links via `reconcileLinks` (section 5).
   - **Burns the state**: rewrites the session-secret file with the live `sessionId` and a fresh random state, so the same callback URL cannot be replayed.
   - Marks the connection `active`, sets `consentGrantedAt` / `consentExpiresAt` (the returned `access.valid_until`, falling back to now + 180 days) and `nextSyncDueAt = now`.
   - **Runs the backfill synchronously within the callback request** (`runSync(..., 'callback-backfill', { psuIp })`) so the user lands on Settings with data present. A backfill failure is logged but never fails the consent — the scheduler / "Refresh now" retries.

**`updateTag` in the callback**: the local `invalidate()` helper wraps every `updateTag` in try/catch because `updateTag` works in server actions but throws inside a GET route handler. A tag-revalidation failure must never abort the flow before the initial backfill runs; the cache still revalidates on the next request-scoped mutation.

**Expiry surfacing**: `getConsentExpiryInfo` (`src/lib/bank-utils.ts`) computes `{ expired, expiringSoon, daysUntilExpiry }` with a warning window of `CONSENT_EXPIRY_WARNING_DAYS = 14`. `getBankConnectionsNeedingAttention` (`src/lib/actions/bank.ts`) feeds the Overview reconnect banner, also flagging connections whose `consecutiveSyncFailures >= SYNC_FAILURE_ALERT_THRESHOLD` (**3**) — non-expiry failures never flip `status`, so the streak is what surfaces a stuck connection.

## 5. Reconnect / consent renewal

PSD2 forbids silent renewal, so renewal is a fresh SCA on the **same connection**: `reconnectBankConnection` (action) → `beginReconnect` (`connect.ts`) reuses the connection id with a fresh single-use state; the callback completes it through the same `completeConnection` path.

`reconcileLinks` (`src/lib/bank/reconcile-links.ts`) merges the freshly mapped accounts with the existing links:

- **Matching** (priority order): `identificationHash` → `accountUid` → IBAN. `identification_hash` is Enable Banking's recommended stable key — constant across sessions *and users* (EB FAQ) — which matters because EB rotates every account `uid` on re-authorisation, so a no-IBAN account (typically a credit card) would otherwise fail both fallbacks and get a new link, orphaning its transaction file and card config. Links created before the hash was captured get it **backfilled** during a normal sync via `GET /sessions/{id}` (`getSession` + `mapSessionAccountHashes` — an EB-side lookup, no ASPSP allowance spent), so existing connections are protected before their first re-consent.
- **Preserved** on a match: the link `id` (stable across re-consent — everything downstream keys on it), `accountRole`, `linkedFinancialAccountId`, `customName`, and all card-cycle config. Refreshed from the bank: `accountUid`, `identificationHash`, `iban`, `name`, `currency`.
- **Backfill-cursor clearing**: a matched link gets `syncCursor.backfilledThrough` cleared, which forces the next sync to re-run the full deep backfill. Rationale: deep transaction history is only served inside the ASPSP's ~1h "fresh session" window right after consent (afterwards most cap at ~90 days), and re-consent is exactly inside that window — so renewing consent also **deepens** an already-connected account's history. The dedup merge absorbs the overlap.
- Accounts the bank no longer returns are dropped (the result is `mapped.map(...)`); brand-new accounts get a fresh uuid link with the mapper-inferred role.

## 6. Sync engine

`runSync(userId, connectionId, trigger, opts, now)` in `src/lib/bank/sync.ts`. Triggers: `'callback-backfill' | 'scheduled' | 'manual'` (`BankSyncTrigger`). Runs are **serialized per connection** by an in-process `inFlight` map (a concurrent call returns the existing promise). Excluded links (`isExcluded`) are skipped. Each account is synced inside its own try/catch, so one failing account/bank never breaks the others.

### Backfill vs incremental

The mode is decided per link by `syncCursor.backfilledThrough`:

| | Backfill (cursor unset) | Incremental (cursor set) |
|---|---|---|
| Window | `today − BACKFILL_DAYS` (**730 days**) → today | `lastBookingDate − INCREMENTAL_OVERLAP_DAYS` (**3 days**) → today, stretched back to re-cover stored pendings |
| Strategy param | `longest` | `default` |
| When | First sync after consent (runs inside the fresh-session window) and after a reconnect clears the cursor | Every subsequent sync |

`strategy: 'longest'` fetches from the earliest available transaction without erroring on unavailable periods, so actual depth is ASPSP-dependent; 730 days is a floor request, not a guarantee. Raising `BACKFILL_DAYS` only affects future backfills — an already-backfilled link must be **reconnected** to deepen (section 5). Pagination follows `continuation_key` with a 50-page guard.

An incremental window is **stretched back to cover any stored pending row** (bounded by `PENDING_RECONCILE_LOOKBACK_DAYS` = **45 days**, sized above a card's ~30-day authorization hold) so a slow-settling pending is always re-fetched and reconciled — otherwise, with only a 3-day overlap, a pending that took longer to book would fall out of the window before its booked twin appeared and strand as a phantom. Pending reconciliation (pruning) happens in the dedup merge below.

### Pending (PDNG) fetch

Banks return **booked-only** from the plain transactions endpoint, so each per-link sync runs a **second paginated fetch** over the same window with `transaction_status=PDNG` (`strategy: 'default'`), appended to the same incoming batch before the merge. Gating (`shouldFetchPending` in `sync.ts`, pure): attended runs (`psuIp` present — manual refresh, callback backfill) always fetch pending; unattended (scheduled) runs only on the link's **first sync of the UTC day**, keeping unattended transactions-endpoint calls at ≤4/day/account (3 scheduled booked + 1 PDNG) under the PSD2 Art. 36(5) allowance. The PDNG fetch is **fully non-fatal**: a failure logs a warning and sets `pendingFetchOk: false` in the audit; the run continues booked-only and — critically — passes **no prune window** to the merge (see Dedup). Per-account audit gains `pendingFetched` (row count) and `pendingFetchOk`; both absent when the gate skipped the fetch.

Per-bank reality (live probe, 2026-07-28): **Nordea** serves PDNG rows — stable `entry_reference` (kept on booking), `booking_date`/`value_date` null, `transaction_date` = the purchase date. **S-Pankki** serves no pending rows under any status (PDNG/HOLD/SCHD/OTHR, with or without date filters) even while its own app shows "Reserved amount" entries — nothing app-side can surface them.

### Transaction dates

`mapTransactions` (`mappers.ts`) sets a row's `bookingDate` from `booking_date || value_date || transaction_date || <sync day>` — the real transaction date beats "today", because some banks (OP, for card accounts) send **only** `transaction_date`, and every engine (billing cycles, retrospective, dedup, sync cursors) buckets by `bookingDate`. The **UI** instead shows the purchase date: `txDisplayDate(t)` (`src/lib/bank-utils.ts`) = `transactionDate ?? bookingDate` drives the ledger's primary date column, sort order, month grouping, and split prefill, and `bank-split-match` compares on it (Nordea/OP send `transaction_date` 0–4 days before booking; a PDNG row's purchase date is carried into `transactionDate` when it books — see Dedup). **S-Pankki sends no `transaction_date`/`value_date` at all** on booked rows, so its rows display their booking date (a card purchase made Friday shows the Monday it booked) — a bank-API limitation. Ledgers written before that fallback existed can carry a **degenerate collapse**: hundreds of rows share one `bookingDate` (the sync day) while their real dates live in `transactionDate`. `repairDegenerateBookingDates` (`src/lib/bank/repair-booking-dates.ts`, pure, unit-tested) self-heals this on every sync: it runs over the stored ledger right after load (primary path and fan-out), and any `bookingDate` group where ≥5 rows have a `transactionDate` more than 7 days older is rewritten to the rows' `transactionDate`s. Idempotent; synthetic dedup keys are unaffected (they exclude `bookingDate`).

### Dedup

`mergeTransactions` (`src/lib/bank/dedup.ts`, pure, unit-testable) merges incoming rows into the stored list by `dedupKey`:

- A **booked or pending** transaction with an `entry_reference` uses that reference as the key (per the [EB FAQ](https://enablebanking.com/docs/faq/), refs are only returned for pending rows when they remain unchanged after booking — so a ref-keyed pending flips to booked through a plain same-key refresh, e.g. Nordea).
- Reference-less rows (and `status: 'other'`) get a deterministic **synthetic key** (`syntheticDedupKey`): a djb2 hash over normalized amount, currency, counterparty, remittance info, and value date (booking date is excluded because pending rows often lack it).
- **Row identity and dates survive refreshes**: a same-key refresh preserves the stored row's `id` (a `SplitExpenseBankLink.txId` references it — rotating ids would orphan explicit split links) and coalesces `transactionDate`/`valueDate` from the prior row when the incoming row lacks them (the mapper always sets the keys, possibly `undefined`, so a plain spread would wipe them). A **booked row is never downgraded** back to pending by a same-key PDNG twin (banks can report both statuses for one ref while a booking is in flight).
- **Pending → booked promotion**: an incoming booked row with a real reference supersedes an earlier synthetic-keyed pending row with the same content, preserving `id`/`firstSeenAt` and carrying `transactionDate` (falling back to the pending's `bookingDate`, i.e. the purchase date).
- **Fuzzy pending → booked promotion**: a booked row that matched no exact key is matched against stored pendings by amount+currency with the pending dated within `[booked − PENDING_BOOKING_MATCH_MAX_LAG_DAYS (7), booked + PENDING_BOOKING_MATCH_MAX_LEAD_DAYS (1)]` — one-to-one greedy, name-affinity preferred, nearest date as tie-break, and never a pending the same fetch still reports. This catches banks that rewrite the reference/counterparty on booking, preserving `id`/`firstSeenAt` and carrying the purchase date into `transactionDate`.
- **Stale-pending pruning** (`mergeTransactions(..., window)`): a fetch that asked for pendings returns the bank's authoritative view of `[fromDate, today]`, so any stored **pending** row inside it that the fetch did not corroborate has booked-under-another-key or been cancelled and is **pruned**. Booked rows and rows outside the window are never touched. The `window` is passed **only when the PDNG fetch ran and succeeded** — a booked-only fetch must not prune pendings it never asked about (and a failed/partial fetch skips the write entirely). The removed count is logged and recorded per-account (`txRemoved`).
- The merge is idempotent — re-fetching an overlapping window never duplicates rows — which is what makes the incremental overlap and the reconnect re-backfill safe.

### Balances & auto-anchoring

After transactions, the sync fetches balances (`mapBalances` in `src/lib/bank/mappers.ts`):

- **Deposit accounts** (`cash`/`savings`): `pickAnchorBalance` picks by priority `CLBD, ITBD, XPCD, OPBD, PRCD, ITAV` and updates the link's `lastBalance*` fields. If the link has a `linkedFinancialAccountId`, `autoAnchorAccount` writes a **`source: 'bank-sync'` `BalanceSnapshot` for the current month** — the `expectedBalance` comes from a baseline projection so the snapshot records the variance. This is the keystone: `resolveAnchor` then starts the account's forecast from the real bank balance (see [projections-and-reconciliation.md](projections-and-reconciliation.md)).
- **Cards**: see section 10.

**Snapshot precedence is last-write-wins per entity/month** (`createBalanceSnapshot` in `src/lib/db/reconciliation.ts`): a bank sync supersedes the current month's prior snapshot (manual or an earlier sync), and a later manual reconciliation supersedes the bank value until the next sync. Bank sync only ever writes the **current** month, so historical manual reconciliations are never touched.

### Cross-user fan-out (shared/joint accounts)

Two household members can each hold their own consent to the **same underlying bank account** (e.g. a joint account) — EB explicitly supports this; each user gets their own connection, session, and account uid. The ASPSP's unattended allowance, however, is per *account* per provider, not per consent — so without coordination the two users would double the fetch count and each pull identical data.

The sync engine instead does **one fetch per underlying account per cycle, fanned out to every user's copy**:

- **Identity**: `linkIdentityKey(link)` (`src/lib/bank/link-identity.ts`, pure) = `identificationHash ?? iban ?? link.id`. Fan-out and budget sharing happen *only* between links with equal keys; a link with neither hash nor IBAN is a singleton group.
- **Fan-out** (`fanOutToSiblings` in `sync.ts`, runs on both scheduled and manual fetches): after a successful fetch of an identity-bearing link, all users' connections are scanned once per run for sibling links (different connection, same key, not `isExcluded`, owning connection not currently syncing). Each sibling gets the **same mapped rows** merged into its own transaction file through the normal `mergeTransactions` path (same window — dedup/pruning semantics identical; `dedupKey` is content-derived so it's valid across users), balance fields applied per the *sibling's own* `accountRole` (`applyLinkBalances`, pure), an `autoAnchorAccount` snapshot if the sibling is an anchored cash/savings link, its `syncCursor` advanced **without touching `backfilledThrough`** (a sibling's own deep backfill must still run on its own session), and `lastSyncedAt` stamped. Sibling cache tags fire through `safeUpdateTags`. Every sibling operation is isolated — a fan-out failure never fails the primary sync.
- **Skip-fetch when fresh**: on **scheduled** runs only, an account with a stable cross-user identity (`identificationHash` or IBAN) whose backfill is complete and whose `lastSyncedAt` is within `SCHEDULED_SYNC_INTERVAL_MS − SCHEDULER_TICK_MS` (`isLinkFresh`) is skipped entirely — 0 bank calls; the audit result is marked `skippedFresh`. Manual "Refresh now" never skips (the user asked for fresh data; attended calls are exempt from the limit anyway) — and its fan-out freshens the other user's copy too.

Net effect for a joint account: whichever user's sync fires first fetches; the other's copy is refreshed by fan-out and its own scheduled run costs nothing. Both users see ~8h-fresh data while the bank sees a single account's normal cadence.

### Run status, backoff, audit log

Aggregate `run.status` is `ok` (no per-account errors), `partial` (some), or `error` (all failed). `nextSyncDueAt` scheduling after a run:

| Outcome | Next sync due |
|---|---|
| Any `EXPIRED_SESSION` | `undefined` — paused until reconnect; connection `status` → `'expired'` |
| Any `RATE_LIMITED` | now + `RATE_LIMIT_BACKOFF_MS` (**6h**) |
| Any transient/bad-response | now + `TRANSIENT_BACKOFF_MS` (**1h**) |
| Clean | now + `SCHEDULED_SYNC_INTERVAL_MS` (24h / `MAX_SCHEDULED_FETCHES_PER_DAY` = **~8h**) |

`consecutiveSyncFailures` increments on any non-`ok` run and resets to 0 on a clean one (`nextConsecutiveSyncFailures` in `src/lib/bank-utils.ts`). Non-expiry failures keep `status: 'active'` so the scheduler keeps retrying.

Every run is appended to the **audit log** (`appendBankSyncRun`, `src/lib/db/bank-sync-runs.ts`), capped at the **50** most recent per connection (`MAX_SYNC_RUNS`), newest first. Entries carry codes/counts/date ranges only — never PII. One concise summary line is always logged per run (`logSyncSummary`); verbose mode adds per-account detail.

## 7. Scheduler

`startBankScheduler()` (`src/lib/bank/scheduler.ts`) is started once from `src/instrumentation.ts` `register()` — **Node runtime only** (`NEXT_RUNTIME === 'nodejs'`), after installing the timestamped console. It is a no-op when already started or when the feature is unconfigured.

- **Cadence**: one `setInterval` tick every `SCHEDULER_TICK_MS = 30 min` (plus a first tick 15s after boot). A tick collects all users' `active` connections whose disk-persisted `nextSyncDueAt` has passed (a process restart delays a sync by at most one tick), then runs them **least-recently-synced first** (`orderRunnableConnections`, pure/exported) so iteration order never systematically starves one household member.
- **Rate limits**: the documented ASPSP allowance is ~`PER_ACCOUNT_DAILY_LIMIT = 4` *unattended* fetches/day per account — attended calls (manual "Refresh now", which sends the requester's IP as PSU headers) are exempt. The scheduler budgets `MAX_SCHEDULED_FETCHES_PER_DAY = 3` per **underlying account** — the in-memory counter (reset each UTC day) is keyed by `linkIdentityKey`, not the per-user link id, so two users' links onto the same joint account draw from one shared counter. `RESERVED_RETRY_FETCHES = 1` stays as headroom for unattended retry re-runs (the 1h transient backoff). Only accounts a run **actually fetched** draw budget (`skippedFresh` costs nothing), and a connection is budget-skipped only when an account that still *needs* a fetch has no budget left. Manual "Refresh now" (`refreshBankConnection` action) additionally enforces `MIN_MANUAL_REFRESH_INTERVAL_MS = 5 min` since the last sync.
- **Cache staleness caveat**: the scheduler runs outside any request scope, where `updateTag` throws — `safeUpdateTags` (`sync.ts`) swallows it, so a background sync **cannot invalidate the `'use cache'` store**. Bank/snapshot cached reads therefore use the bounded `cacheLife('synced')` profile (`next.config.ts`: stale 60s / revalidate 300s / expire 3600s) so the UI catches up to disk within ~5 minutes. Request-scoped mutations (e.g. "Refresh now") still invalidate instantly via tags. Never give a background-mutated read the `indefinite` profile.

## 8. Data model & storage

All files are per-user AES-256-GCM encrypted JSON under `data/users/{userId}/bank/`:

| Path | Contents | DB module |
|---|---|---|
| `bank/connections/{connectionId}.enc` | `BankConnection` with `linkedAccounts[]` embedded | `src/lib/db/bank-connections.ts` |
| `bank/connections/{connectionId}.session.enc` | `BankSessionSecret` (`state`, `authorizationId`, live `sessionId`) — **uncached, never logged**, read only by the action/sync layers | `src/lib/db/bank-connections.ts` |
| `bank/accounts/{linkedAccountId}/transactions.enc` | Full deduped `BankTransaction[]` for one linked account | `src/lib/db/bank-transactions.ts` |
| `bank/sync-runs/{connectionId}.enc` | Capped list of `BankSyncRun` (newest first) | `src/lib/db/bank-sync-runs.ts` |

Types live in `src/types/index.ts` (`BankConnection`, `BankAccountLink`, `BankSessionSecret`, `BankTransaction`, `BankSyncRun`, and the status/role/trigger unions). `BankConnectionStatus` is `pending | active | expired | error | revoked`.

**Cache tags** (invalidated by the actions; used by `src/lib/db/cached.ts`, all bank reads on `cacheLife('synced')`):

- `user:{userId}:bank-connections`
- `user:{userId}:bank-connection:{connectionId}`
- `user:{userId}:bank-connection:{connectionId}:runs`
- `user:{userId}:bank-account:{linkedAccountId}:transactions`
- plus `user:{userId}:reconciliation` when an anchor snapshot is written and `user:{userId}:accounts` around connect/link changes.

Like all storage in this app there is no file locking; the per-connection in-process lock in `sync.ts` is the only write serialization (single-node assumption).

## 9. Account links (`BankAccountLink`)

One link per real bank account, embedded in its connection. `id` is Sampolio's uuid and stays stable across re-consent. User-editable fields (validated by `updateBankAccountLinkSchema`, persisted by the `updateBankAccountLink` action, **autosaved** from the Settings panel):

| Field | Meaning |
|---|---|
| `accountRole` | `cash` \| `credit-card` \| `savings` \| `other` — initially inferred from the bank's `cash_account_type`/product (`inferAccountRole` in `mappers.ts`) |
| `linkedFinancialAccountId` | cash/savings: the `FinancialAccount` this balance **anchors**; credit-card: the cash account the bill is **paid from** |
| `customName` | User display name; wins over the bank-provided `name` |
| `isExcluded` | Opt this real account out of syncing and all modeling |
| `statementDay`, `paymentDueDay` | Card cycle config (1–31; AIS rarely exposes these, so they're manual) |
| `expectedMonthlySpend` | Forecast buffer per cycle for untracked card spend; only its pro-rata share of the not-yet-elapsed days applies to the current open cycle |
| `creditLimit` | Editable, but auto-derived on sync when the bank exposes both card balances |
| `manualCreditLimit` | User-entered fallback limit ("Credit limit" in the panel) for banks that never report one (OP); feeds `effectiveCardNumbers` |

Sync-maintained fields: `lastBalance`/`lastBalanceType`/`lastBalanceAt`, `outstanding`, `availableCredit`, and `syncCursor { lastBookingDate, lastSeenEntryRefs, backfilledThrough }`. Setting `linkedFinancialAccountId` on a cash/savings link also flips the target account's `bankSyncEnabled` flag (in `updateBankAccountLink`).

## 10. Credit cards

Most banks return two real-time card balances: **`ITBD`** (booked; negative = owed) and **`ITAV`** (available to spend). `pickCardBalances` (`mappers.ts`) picks by priority — booked from `ITBD, CLBD, OPBD, PRCD`, available from `ITAV, XPCD, CLAV, FWAV` — with one reinterpretation: **OP returns exactly one balance, a NEGATIVE `ITAV`**, which is semantically the booked/owed amount mislabeled as "available", so a lone negative available is returned as the booked balance (no available). The sync (`applyLinkBalances`, pure) derives:

- `outstanding = max(0, -booked)`
- `creditLimit = available + outstanding` (when both are present)
- booked-found-but-no-available **clears** `availableCredit`/`creditLimit` on the link (drops any stale pre-fix value); a fetch that finds no usable balance at all preserves priors (a transient miss never blanks a known balance).

Display and net worth go through **`effectiveCardNumbers(link)`** (`src/lib/bank-utils.ts`, pure): `outstanding` falls back to a negative `lastBalance`, `creditLimit` falls back to the user's `manualCreditLimit`, `availableCredit` is derived (`max(0, limit − outstanding)`) when the bank didn't report it, and a stored negative `availableCredit` is treated as unknown. Used by the `/bank` card summary, the Settings panel summary, and `getCardLiabilities`.

**Card billing** is the pure engine `computeCardBilling` (`src/lib/bank/card-billing.ts`, unit-tested). Given `statementDay` + `paymentDueDay` + the card's transactions it produces dated `CardBill`s: a **firm bill** (`basis: 'statement'`) for the most recent closed statement (spend in the `(prevClose, close]` cycle, or `lastStatementBalance` when known; due on the next `paymentDueDay` after the close). It **also** emits the **previous** closed statement's bill (derived from its `cycleSpend` only — `lastStatementBalance` applies only to the newest close, never the previous one) while that bill's due month is still current or future (`yearMonthOf(prevDue) >= yearMonthOf(now)`), ordered first in `bills[]`; this keeps the current month's already-due bill from vanishing mid-month when `now` crosses the statement day, and it ages out on its own once its due month is in the past. Then a **blended open-cycle bill** (`basis: 'open-cycle'`, unconditional): actual booked+pending spend so far (`actualToDate`) blended toward the caller-supplied `openCycleForecast` (tagged card items for the cycle's spend month + `expectedMonthlySpend`). Only the *still-unspent* part of the forecast — `max(0, openCycleForecast − actualToDate)` — is added, scaled by the fraction of the cycle still ahead, so real transactions drive the next bill, the estimate only fills the not-yet-elapsed remainder and decays to zero at close, and once actuals reach the expected total nothing extra is stacked on. `getOpenCycleMonths(statementDay, paymentDueDay, now?)` exposes the open cycle's due/spend months so callers can compute the forecast. Without cycle config it reports only the outstanding, no bills. `transactionsForCycle(transactions, closeYmd)` returns the rows booked in `(close − 1 month, close]` — used to drill a bill into its purchases (`getCardStatementBreakdownForAccount`; for the open cycle the drill-down total is `actualToDate`, matching the purchases it lists). `suggestStatementDay(dueDay, STATEMENT_GRACE_DAYS = 18)` proposes a close day from the due day in the Settings UI.

**Cycle spend counts purchases, never card payments.** `cycleSpend` sums purchases (debits) net of merchant refunds (credits with a merchant identity), but skips card **payments/settlements** — the credit that pays down a prior statement. `isCardPayment(t)` classifies a *credit* (positive amount) as a payment when its `bankTransactionCode` matches a settlement keyword (`suoritus`, `payment`, `autopay`, `direct debit`, …), **or** its `counterpartyName` matches the same keywords while carrying no `merchantCategoryCode` (OP reports settlements as a credit named "Suoritus" with no code; the MCC guard keeps merchant refunds from processors named e.g. "…Payments…" in the net), **or** it is a "bare" credit with no `counterpartyName` and no `merchantCategoryCode` (a bank-to-card transfer). Erring toward "payment" for an ambiguous credit only over-estimates the bill slightly (the safe direction); mistaking a payment for a refund would zero out the whole cycle. All three callers (`computeCardBillTransfersForAccount`, `getCardLiabilities`, `getCardStatementBreakdownForAccount`) pass transactions through `toCardTxn(t)`, which carries the fields `isCardPayment` needs.

Where bills flow (details in [projections-and-reconciliation.md](projections-and-reconciliation.md)):

- **Cashflow**: `computeCardBillTransfersForAccount` (`src/lib/projection-inputs.ts`) injects statement + open-cycle + forecast bills as read-only `credit-card` expense lines into the paying account's projection (`CardBillTransfer`, 9th param of `calculateProjection`); expenses tagged `paidByCardLinkId` are moved out of direct cash into the bill.
- **Net worth**: `getCardLiabilities` (`src/lib/actions/bank.ts`) feeds the wealth projection's card-liability fold-in and the Overview "Credit cards" KPI. Never also enter a synced card as a `Debt` (double counting).

- **Retrospective drill-down (past months)**: the retrospective collapses a month's opaque cash-side bill-payment debit into one `source: 'credit-card'` "Card: X" line (`itemId` = the card link id) by matching the account's cash debits against the card's settlement credits — exact cents, booking dates within ±4 days (`matchCardPayments`, `src/lib/bank/card-payment-match.ts`, pure; credit sources gathered by `getCardPaymentSourcesForAccount` in `projection-inputs.ts`). `getCardStatementBreakdownForAccount` has a matching **past-month fallback**: when no `computeCardBilling` bill lands in the requested month, it reruns the same cash-debit matcher for that month (the card-side credit often books 1–2 days later, possibly in the next month, so it never buckets by credit month), and returns the debits of the cycle the latest matched payment settled — so the Sankey/treemap expand past-month card payments exactly like forecast bills. Both paths use `matchCardPaymentsWithFingerprints`: exact matches act as SEEDS that teach the card's cash-side fingerprint (normalized counterparty + first remittance line — stable per e-invoicing agreement; seeds must be ≥ €50 and a fingerprint learned for two cards is dropped), and older debits with the same fingerprint are tagged even when the bank no longer serves their settlement credits (Nordea serves only ~1–2 months of card history). Seeds are gathered from ALL booked cash debits including the current/anchor month. Hard limit: a billing identity that changed (new counterparty/reference) before the card's served history begins can never seed, so those months stay unattributed; a fingerprint-tagged month whose card ledger lacks the cycle's purchases gets the collapsed line but no drill-down (the breakdown action emits nothing empty).

The backfilled transaction history of cash/savings links also powers the cashflow **retrospective** (`calculateRetrospective`, `src/lib/retrospective.ts`, up to 24 months back) and, for the current calendar month, **current-month actualization**: `getCurrentMonthActualsForAccount` (`src/lib/projection-inputs.ts`) feeds that month's booked transactions into `calculateProjection` so the forecast reconciles against what's already cleared instead of double-counting it on top of the live synced anchor balance — see [projections-and-reconciliation.md](projections-and-reconciliation.md).

## 11. UI surfaces

- **`/bank`** (`src/app/(dashboard)/bank/page.tsx`, sidebar "Bank", content centered `max-w-4xl mx-auto`): a page header with a **"Refresh"** button (calls `refreshBankConnection` for every connection sequentially, toasts success/failure — an already-recent-refresh error surfaces as an info toast, not an error) and "Manage connections" (deep-links to Settings → Accounts & Banking), **recurring-transaction suggestions** ("Looks recurring — track it?" — see [features.md](features.md) §8), a sticky `AccountPicker` (`src/components/bank/account-picker.tsx`: a bank-tab row with connection/consent health status dots, hidden when only one connection; an account-chip row showing name + balance/owed), a selected-account summary header (icon, name, masked IBAN · currency · role, balance / card owed-available-limit, connection status + consent-expiry `Tag`s, and — only when the consent is expired or expiring soon — a **"Renew consent"** button that calls `reconnectBankConnection` and redirects to the returned auth URL, same flow as the Settings panel), then **one** `BankLedgerTable` for the selected account filling the rest of the page. Selection lives in the `?account=` URL param; `?tx=` deep-links to a transaction (auto-selects its account, expands the row, scrolls + flash-highlights, then the param is stripped). Params are read reactively via `useSearchParams` (wrapped in a `Suspense` boundary — a mount-time `window.location` read misses params set by client-side navigation). Ledgers are fetched lazily and cached per link, with a `DelayedSkeleton` while loading; a manual Refresh clears the per-link fetched marks so the selected account's ledger silently refetches (existing rows stay on screen — no skeleton flash). The page also computes `splitMatches` (months of the loaded ledger → `getMySplitLinkCandidates` → `matchTransactionsToSplits`) and passes the map to the ledger table, refreshed after a "Split this" save — see [features.md](features.md) §1 "Bank-transaction linking".

  `BankLedgerTable` (`src/components/bank/bank-ledger-table.tsx`): a counterparty/amount search box (`IconField`/`InputIcon`) over both views, an infinite-scroll DataTable on desktop (rows revealed as the inner scroll area nears its end, not a paginator — with a "Split" flag-pill column, and split matches carried **on each row object** — PrimeReact memoizes `BodyRow`/`BodyCell`, so a closure-captured lookup map never reaches already-rendered cells), and month-grouped sections with sticky headers + "Load older months" on mobile. Mobile rows are compact: the whole row is a `role="button"` that toggles expansion (Enter/Space too; inner buttons `stopPropagation`), leading with a stacked date column (month initials over day number, the split-detail style), then a single text column (status dot — green booked / amber pending / gray other — + counterparty, with the optional remittance line beneath inside the same column so it never inflates the row), then the "already split" flag pill and the "Split this" button **between the text and the amount**, and finally the amount + expand chevron pinned at the right end so amounts right-align across every row. The flag pill is filled ("split", linked) or dashed ("split?", heuristic) and deep-links to `/split/{groupId}?expense={id}&month={YYYY-MM}`.
- **Settings → Accounts & Banking** (`src/components/bank/bank-connections-panel.tsx`): connect (ASPSP picker via `listBankAspsps`), reconnect, "Refresh now", disconnect, sync-run history, and the autosaved per-link config of section 9. Deep-link: `/settings?tab=banking` (the `/bank` page and Overview banner both link there).
- **Overview and Home**: the same consent-renewal / sync-failing attention banner (`src/components/bank/bank-attention-banner.tsx`, shared by `BannerStack` and `HomeDashboard`), driven by `getBankConnectionsNeedingAttention`; its action button routes to `/bank`, where the "Renew consent" button lives.
- Cashflow `credit-card` and `bank-actual` lines deep-link to `/bank`.

## 12. Logging & privacy

- **IBANs are never logged** and always masked in the UI via `maskIban` (`src/lib/bank-utils.ts`): `FI••••1234`.
- Default logging uses `redactBankError` (`client.ts`) — error **codes** only (`BankApiError.code`/`apiCode`/HTTP status); for non-bank errors only the error name, since messages may carry PII. Persisted fields (`lastError`, run results) store codes only.
- `describeBankError` appends the API's `detail` body (truncated) and is used **only** under `BANK_SYNC_VERBOSE` — never persisted.
- The REST client never logs request bodies, tokens, or amounts. The session-secret file is read by an uncached accessor and never logged.
- All server logs carry an ISO-timestamp prefix (`installTimestampedConsole` in `src/lib/server-logger.ts`, installed from `instrumentation.ts`). Sync logs are prefixed `[bank-sync]`, scheduler logs `[bank-scheduler]`.

## 13. Troubleshooting

| Symptom | Cause | Fix / where to look |
|---|---|---|
| Settings shows "not configured", no Connect button works | One of the three `ENABLE_BANKING_*` env vars missing — `getBankConfig()` returns null | Set the env vars ([operations.md](operations.md)); scheduler logs `[bank-scheduler] Enable Banking not configured — scheduler idle` |
| Syncs stopped; connection shows expired; Overview/Home banner | Consent past `consentExpiresAt` (requested validity 180 days) or bank returned `EXPIRED_SESSION` — `nextSyncDueAt` is cleared, scheduler skips it | User must **Reconnect**/"Renew consent" (`/bank` or Settings → Accounts & Banking); renewal keeps all links/config |
| "Just refreshed — please wait a few minutes" on Refresh now / `/bank`'s Refresh | `MIN_MANUAL_REFRESH_INTERVAL_MS` (5 min) since `lastSyncAt` not yet elapsed | Wait; the scheduled sync also runs every ~8h |
| Sync run says `RATE_LIMITED` | ASPSP 429 / `ASPSP_RATE_LIMIT_EXCEEDED` | Automatic 6h backoff; scheduled budget is 3/day per **underlying account** (shared across users' links via `linkIdentityKey`); manual refreshes are attended and exempt |
| Joint account synced by two users: one user's sync-run log shows `skippedFresh` / no new fetch | Cross-user fan-out — the other user's sync already fetched this cycle and wrote both copies (section 6) | Expected; data is current. A manual Refresh now always fetches |
| Account connected but still shows its manual/starting balance | No sync has written a current-month `bank-sync` snapshot yet, or the link has no `linkedFinancialAccountId` | Set the linked account in Settings; run Refresh now; check the sync-run log |
| Bank data visibly stale for a few minutes after a scheduled sync | Background writes can't `updateTag`; reads are on the `synced` cacheLife (revalidate 300s) | Expected — catches up within ~5 min; "Refresh now" updates instantly |
| Retrospective/history shallower than expected; raising `BACKFILL_DAYS` did nothing | Deep history is only served in the ~1h fresh-session window; `syncCursor.backfilledThrough` is already set | **Reconnect** the connection — `reconcileLinks` clears the cursor and the post-SCA sync re-runs the deep backfill |
| Connection failing repeatedly without expiring | Non-expiry error (e.g. persistent 400) — status stays `active`, `consecutiveSyncFailures` grows | Banner appears at 3 consecutive failures; set `BANK_SYNC_VERBOSE=1` to see the API's raw (unsanitized) error detail in the logs |
| Duplicate-looking transactions suspected | Same-content dupes are deduped by `entry_reference` / synthetic key (idempotent merge); a pending whose booked twin was rewritten (e.g. counterparty gains an `UNKNOWN*` prefix) is fuzzy-promoted (amount+currency+date window) or pruned once a pending-inclusive fetch re-covers it | Check `dedupKey`s in the ledger data; a lingering pending clears on the next PDNG-successful sync whose window includes it (within `PENDING_RECONCILE_LOOKBACK_DAYS`); see `src/lib/bank/dedup.ts` tests |
| No pending ("reserved") transactions for a bank; ledger dates lag the bank app by 1–3 days | The ASPSP doesn't serve them: S-Pankki returns zero rows under every `transaction_status` and no `transaction_date`/`value_date` on booked rows (probe 2026-07-28) | Nothing app-side — bank-API limitation. Nordea/OP serve the data and get pending rows + purchase-date display |
| Pending rows appear on manual refresh but seem stale later in the day | Unattended (scheduled) runs fetch PDNG only on the first sync of the UTC day (`shouldFetchPending`) to stay within the 4/day unattended allowance | Expected; a manual Refresh now always re-fetches pendings, and a booked twin fuzzy-promotes the stale pending on any run |
