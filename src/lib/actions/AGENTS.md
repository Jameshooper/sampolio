# Server Actions (`src/lib/actions/`)

All backend logic for the application. There are **no REST API routes** — everything uses Next.js Server Actions.

## Architecture

Every action file starts with `'use server'` and exports async functions. The consistent pattern is:

1. **Authenticate**: `const session = await auth()` — reject if no session
2. **Validate**: Use Zod schema to parse input
3. **Execute**: Call DB layer functions from `src/lib/db/`
4. **Invalidate cache**: Call `updateTag(tagName)` for affected data
5. **Return**: `ApiResponse<T>` = `{ success: boolean; data?: T; error?: string }`

## Action Files

| File | Entity | Operations |
|------|--------|------------|
| `accounts.ts` | Cash accounts | CRUD |
| `recurring.ts` | Recurring income/expenses | CRUD (scoped to account) |
| `planned.ts` | One-off/repeating items | CRUD (scoped to account) |
| `salary.ts` | Salary configurations | CRUD (scoped to account); create/update/delete cascade-recompute salary-linked taxed incomes (`recomputeSalaryLinkedTaxedIncomes`, invalidating the `taxed-income` tag when rows changed) |
| `investments.ts` | Investment accounts | CRUD + contribution/withdrawal management |
| `debts.ts` | Debts/liabilities | CRUD + reference rates + extra payments |
| `receivables.ts` | Receivables | CRUD + repayment recording |
| `taxed-income.ts` | Bonuses/holiday pay | CRUD (scoped to account) |
| `reconciliation.ts` | Balance verification | Snapshots, adjustments, sessions |
| `shared-mortgages.ts` | Shared mortgages | CRUD + members/rates/costs/payments/snapshots/actuals (member-scoped, not user-scoped) |
| `budgets.ts` | Trip/project budgets | CRUD + lines/funding/expense log + confirm/unconfirm. Per-diem funding sources may carry `linkedTripId` (EUR-only budget; one budget per trip — validated in `resolveTripLinkedAmount`); reads hydrate the amount from the trip's live per-diem via `hydrateBudgetFundingFromTrips` |
| `goals.ts` | Financial goals | CRUD (UI at `/goals`) |
| `trips.ts` | Trips (Vero.fi per diem) | CRUD (UI on the merged `/budgets` page; `/trips` redirects) |
| `data-transfer.ts` | JSON backup | `exportUserData` (all user-scoped entities, one versioned envelope) / `importUserData` (merge or replace; never touches bank data) |
| `split-groups.ts` | Split groups (Splitwise replacement) | CRUD + members/expenses/settle-up/recurrence + `updateSplitGroupMemberRole` (owner-gated, refuses demoting the last owner) + CSV import + `catchUpGroupRecurrences` + `getMySplitNetBalance` + `getMySplitLinkCandidates` (read-only projection for the bank ledger's "already split" matching) + `getSplitInsights` (read-only /split summary + spend/net charts, via the pure `split-insights.ts`) + `markSplitGroupSeen` (membership-checked, monotonic per-group seen-watermark into `UserPreferences.splitLastSeenAt`) (member-scoped, not user-scoped; per-group in-process mutex; integer cents. `updateSplitRecurrenceRule` prunes an end-dated rule's generated tail inside one `withGroupLock`, then runs `catchUpGroupRecurrences` OUTSIDE it — the mutex is non-reentrant). Every mutating action also calls `notifySplitActivity` (`src/lib/split-notify.ts`) after its write + `invalidateGroup`: `createSplitExpense`/`quickAddSplitExpense` ⇒ `expense.created`, `updateSplitExpense` ⇒ `expense.updated`, `deleteSplitExpense` ⇒ `expense.deleted` (pre-reads the row via `getExpenseById`; payment rows notify nothing), `recordSettleUp` ⇒ `payment.recorded`, `catchUpGroupRecurrences` ⇒ one `expense.generated` per generated row (author = the rule's payer). The call only *schedules* the POST (`after()`), so it is safe inside `withGroupLock` and can never fail or delay the mutation |
| `projection.ts` | Cash flow projection | Read-only calculation (input gathering + transfer helpers live in `src/lib/projection-inputs.ts`, shared with scenarios — plain server module, NOT 'use server', so the userId-taking helpers are never client-invokable; also returns the bank-actual `retrospective` past months via `getRetrospectiveForAccount`) |
| `scenario.ts` | "What If?" projection | Read-only, ephemeral — never persisted. Same inputs/transfers/card-exclusion as `getProjection` (absolute balances match the cashflow page); card bills recomputed from the modified item lists |
| `bank.ts` | Bank sync (Enable Banking, PSD2 AIS) | Connect/reconnect/refresh, link config, card billing/liabilities, recurring-transaction suggestions (`getRecurringSuggestions`, on-demand from cached reads) — **read-only**; hard-disables when unconfigured |
| `euribor.ts` | Euribor prefill | `fetchCurrentEuribor12m` — ECB Data Portal fetch (5s timeout, 6h in-memory TTL, always-graceful failure); prefills the mortgage Euribor dialog, never auto-applies |
| `admin.ts` | Users & app settings | User CRUD, settings (admin only) |
| `maintenance.ts` | Data maintenance | History compaction preview/run (prune snapshots/sessions) |
| `auth.ts` | Authentication | Sign-up, signup-enabled check |
| `account.ts` | Account self-service | `changeMyPassword` (re-verifies current password), `getAccountDeletionPreflight`, `deleteMyAccount` (email-typed confirm; re-runs preflight server-side; bank teardown + shared-entity leave/delete + `hardDeleteUser`), `resetMyData` ("start fresh": bank teardown + wipe owned data dirs, keeps user.enc/preferences.enc), `updateMyAvatar` (data-URI or null → `setUserAvatar`, bumps `avatarVersion`) — all session-scoped, none accept a userId |
| `user-preferences.ts` | User preferences | Read/update preferences (categories, display mode, tax defaults, check-in reminders/notifications, `updateBankAccountOrder` — bank-link display order, and `updateSplitGroupOrder` — split-group display order, both sanitized against current ids). `updateSplitNotificationPrefs` stores the five-key `splitNotificationPrefs` opt-out record wholesale (the UI always sends all five; absent key ⇒ notifications on); `getSplitNotifyStatus` reports whether the server has the Home Assistant webhook configured (`getSplitNotifyConfig() !== null`, mirroring `getBankFeatureStatus`) |
| `user-profiles.ts` | User profiles (display) | `getUserProfiles(userIds)` → `{ id, name, avatarUrl? }` for any authenticated user (no email/role — safe for cross-user member/actor displays) |
| `app-info.ts` | App metadata | Version info |

## Cache Tags

After mutations, invalidate the appropriate cache tag:

```
user:{userId}:accounts
user:{userId}:account:{accountId}:recurring
user:{userId}:account:{accountId}:planned
user:{userId}:account:{accountId}:salary
user:{userId}:account:{accountId}:taxed-income
user:{userId}:investments
user:{userId}:debts
user:{userId}:receivables
user:{userId}:reconciliation
user:{userId}:budgets
user:{userId}:goals
user:{userId}:trips
user:{userId}:mortgages        (a member's mortgage membership list)
mortgage:{mortgageId}          (member-agnostic; one updateTag reaches every member)
user:{userId}:split-groups     (a member's split-group membership list)
split-group:{groupId}          (member-agnostic doc) + :summary (running balances) + :expenses (monthly chunks)
user:{userId}:bank-connections
user:{userId}:bank-connection:{connectionId}                       (+ :runs for its sync-run log)
user:{userId}:bank-account:{linkedAccountId}:transactions
users                          (admin operations)
app-settings                   (admin operations)
all-data                       (admin cache clear)
```

> Scenarios (`scenario.ts`) and projections (`projection.ts`) are read-only and use **no** tags of their own.

## Adding a New Server Action

1. Create file in this directory with `'use server'` at top
2. Define Zod schema for input validation
3. Follow the authenticate → validate → execute → invalidate → return pattern
4. Add cached query wrapper in `src/lib/db/cached.ts` if data is read frequently
5. Use descriptive cache tags following the `user:{userId}:entity-type` pattern
