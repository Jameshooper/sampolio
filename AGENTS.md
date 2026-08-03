# Sampolio - AI Agent Instructions

Instructions for AI coding assistants working on this codebase.

## Project Overview

Sampolio is a self-hosted personal finance planning application. It tracks cash accounts, investments, debts, and receivables, then projects the user's financial future. Data is stored as encrypted JSON files on disk (no external database). It can optionally **sync read-only balances and transactions from real banks** via Enable Banking (PSD2 AIS) — see "Bank Sync" below.

**Tech stack**: Next.js 16 (App Router), TypeScript (strict), PrimeReact, Tailwind CSS v4, NextAuth.js v5, Zod, React Hook Form, ECharts, date-fns, `jose` (RS256 JWT for Enable Banking).

**Package manager**: pnpm

## Directory Structure

```
src/
├── app/
│   ├── api/auth/[...nextauth]/route.ts   # NextAuth handler
│   ├── api/bank/callback/route.ts        # Enable Banking OAuth-style consent callback (one of two non-NextAuth API routes)
│   ├── api/avatars/[userId]/route.ts     # User avatar image (session-gated; plain binary avatar.webp; immutable ?v= cache)
│   ├── auth/                              # Sign-in and sign-up pages
│   ├── (dashboard)/                       # Protected pages (route group)
│   │   ├── overview/page.tsx              # Wealth dashboard (a normal page at /overview; no longer the home)
│   │   ├── cashflow/page.tsx              # Monthly cash flow management
│   │   ├── mortgage/page.tsx              # Shared mortgage ledger, charts, reconcile/import
│   │   ├── budgets/page.tsx               # "Trips & Budgets": stacked Trips (per diem) + Budgets sections (+ [id]/page.tsx budget detail)
│   │   ├── split/page.tsx                 # Split groups list (+ [id]/page.tsx detail) — Splitwise replacement
│   │   ├── goals/page.tsx                 # Financial goals (card grid + progress vs. projections)
│   │   ├── trips/page.tsx                 # Server redirect('/budgets') — trips live on the merged Trips & Budgets page
│   │   ├── bank/page.tsx                  # Connected bank accounts + imported transaction ledger
│   │   ├── playground/page.tsx            # "What If?" scenario explorer (ephemeral)
│   │   └── settings/page.tsx              # User prefs, banking, JSON export/import, admin panel & data maintenance, account self-service (TabView)
│   ├── layout.tsx                         # Root layout (mounts ServiceWorkerRegister)
│   └── page.tsx                           # Home dashboard at / (glance, split balances, activity; add via the global FAB) — auth-guarded, wraps AppLayout
├── components/
│   ├── charts/                            # ECharts and Chart.js components (incl. split-spend-chart / split-net-chart for /split insights)
│   ├── layout/                            # AppLayout, SidebarNav, nav-config (shared), mobile-top-bar/bottom-nav/mobile-nav-drawer
│   ├── modals/                            # Entity create/edit modals (cashflow item, override, users)
│   ├── budgets/                           # Budget wizard, verdict card, coverage bars, expense log, dialogs, budgets-section (merged-page section)
│   ├── mortgage/                          # Mortgage setup wizard, ledger table, charts, Sankey, reconcile/import dialogs
│   ├── split/                             # Split UI (quick-add sheet, expense/settle/recurrence/import dialogs, bank-link details dialog, activity feed, category icons)
│   ├── goals/                             # Goal card + create/edit dialog
│   ├── trips/                             # Trip card, create/edit dialog, per-diem breakdown, trips-section (merged-page section)
│   ├── home/                              # Home dashboard (glance tile, split balances, cross-group activity, feature grid)
│   ├── bank/                              # Bank connections settings panel + account picker + transaction ledger table
│   ├── onboarding/                        # Onboarding wizard
│   ├── providers/                         # Theme, PrimeReact, Session, Celebration providers, ServiceWorkerRegister (PWA)
│   ├── cashflow/                          # Cashflow page pieces (collapsing header, month strip, details panel, projection table)
│   ├── overview/                          # Overview pieces (BannerStack, KpiGroup, plan-check card, net-worth explain dialog, wealth-distribution bar)
│   ├── reconcile/                         # Reconciliation wizard
│   ├── settings/                          # account-panel.tsx: change-password form + danger zone (start fresh / delete account), rendered in Settings → Account; mobile-nav-card.tsx: bottom-nav tab picker (Settings → General)
│   └── ui/                               # Shared UI (CommandPalette, EntityListDrawer, debt-progress-card, jiggle-reorder, user-avatar, avatar-editor-dialog, etc.)
├── lib/
│   ├── actions/                           # Server actions (all backend logic)
│   │   ├── accounts.ts                    # Cash account CRUD
│   │   ├── recurring.ts                   # Recurring income/expense CRUD
│   │   ├── planned.ts                     # One-off/repeating item CRUD + override cleanup
│   │   ├── salary.ts                      # Salary configuration CRUD
│   │   ├── investments.ts                 # Investment account CRUD + contributions
│   │   ├── debts.ts                       # Debt CRUD + reference rates + extra payments
│   │   ├── receivables.ts                 # Receivable CRUD + repayments
│   │   ├── taxed-income.ts                # Taxed income CRUD
│   │   ├── reconciliation.ts              # Balance snapshots, adjustments, sessions
│   │   ├── shared-mortgages.ts            # Shared mortgage CRUD + members/rates/costs/payments/snapshots
│   │   ├── budgets.ts                     # Trip/project budget CRUD + lines/funding/expense log + confirm/unconfirm
│   │   ├── goals.ts                       # Financial goal CRUD (UI at /goals)
│   │   ├── trips.ts                       # Trip CRUD (UI on the merged /budgets page)
│   │   ├── data-transfer.ts               # Settings JSON backup: exportUserData / importUserData (merge|replace)
│   │   ├── split-groups.ts                # Split group CRUD + members/expenses/settle-up/recurrence + CSV import + catch-up + net-balance
│   │   ├── projection.ts                  # Cash flow projection action
│   │   ├── scenario.ts                    # "What If?" projection (ephemeral, never persisted)
│   │   ├── bank.ts                        # Enable Banking: connect/reconnect/refresh, link config, card billing
│   │   ├── admin.ts                       # User management, app settings (admin only)
│   │   ├── maintenance.ts                 # History compaction preview/run (data pruning)
│   │   ├── auth.ts                        # Sign-up, signup-enabled check
│   │   ├── account.ts                     # Self-service: changeMyPassword, getAccountDeletionPreflight, deleteMyAccount, resetMyData
│   │   ├── user-preferences.ts            # User preferences CRUD (incl. updateSplitGroupOrder, updateBottomNavIds)
│   │   ├── user-profiles.ts               # getUserProfiles: {id,name,avatarUrl?} for any authenticated user (no email/role)
│   │   ├── euribor.ts                     # ECB Data Portal 12m-Euribor prefill fetch (graceful failure, in-memory TTL)
│   │   └── app-info.ts                    # App version info
│   ├── db/                                # Database layer
│   │   ├── encryption.ts                  # AES-256-GCM encrypt/decrypt, file I/O
│   │   ├── accounts.ts                    # Account file operations
│   │   ├── recurring-items.ts             # Recurring item file operations
│   │   ├── planned-items.ts               # Planned item file operations
│   │   ├── salary-configs.ts              # Salary config file operations
│   │   ├── investments.ts                 # Investment file operations
│   │   ├── debts.ts                       # Debt file operations
│   │   ├── receivables.ts                 # Receivable file operations
│   │   ├── taxed-income.ts                # Taxed income file operations
│   │   ├── reconciliation.ts              # Reconciliation file operations
│   │   ├── budgets.ts                     # Budget file ops (one doc per budget, sub-entities embedded)
│   │   ├── goals.ts                       # Goal file operations
│   │   ├── trips.ts                       # Trip file operations
│   │   ├── data-transfer.ts               # JSON-backup writer (import at canonical paths; never touches bank data)
│   │   ├── split-groups.ts                # Split group file ops (global shared dir; monthly-chunked expenses + maintained summary + reverse index)
│   │   ├── shared-mortgages.ts            # Shared mortgage file ops (loans, members, rates, costs, payments, snapshots, actuals)
│   │   ├── bank-connections.ts            # Bank connection file ops (linkedAccounts embedded)
│   │   ├── bank-transactions.ts           # Imported transaction ledger (one file per linked bank account)
│   │   ├── bank-sync-runs.ts              # Sync-run audit log file ops
│   │   ├── users.ts                       # User file operations (incl. hardDeleteUser: index removal + recursive user-dir rm, for account self-deletion)
│   │   ├── app-settings.ts               # App settings file operations
│   │   ├── user-preferences.ts            # Preferences file operations
│   │   └── cached.ts                      # Cached query wrappers
│   ├── bank/                              # Enable Banking (PSD2 AIS) engine — see "Bank Sync"
│   │   ├── jwt.ts                         # RS256 JWT minting (jose, kid = app id)
│   │   ├── client.ts                      # Enable Banking REST client (/aspsps, /auth, /sessions, /accounts)
│   │   ├── connect.ts                     # Consent begin/reconnect/complete flow
│   │   ├── reconcile-links.ts             # Merge mapped accounts w/ existing links (hash→uid→IBAN; reconnect resets backfill cursor)
│   │   ├── sync.ts                        # Backfill + incremental sync, auto-anchor snapshots, cross-user fan-out
│   │   ├── scheduler.ts                   # Background sync scheduler (identity-keyed shared budget, LRS-first fairness)
│   │   ├── mappers.ts                     # Map EB API payloads → app types (incl. per-bank card balance interpretation)
│   │   ├── dedup.ts                       # Transaction de-duplication
│   │   ├── repair-booking-dates.ts        # Pure self-heal for ledgers whose bookingDates collapsed onto a sync day (OP cards)
│   │   ├── card-payment-match.ts          # Pure cash-debit ↔ card-settlement matcher (retro card drill-down)
│   │   ├── link-identity.ts               # Pure cross-session/user account identity + freshness (linkIdentityKey, isLinkFresh)
│   │   ├── apply-link-balances.ts         # Pure per-role balance→link-field application (shared by sync + fan-out)
│   │   ├── card-billing.ts               # Pure statement-cycle / bill computation
│   │   ├── teardown.ts                    # teardownBankConnection(userId, connection): best-effort EB revoke + local wipe for ONE connection; shared by disconnectBankConnection and account self-service (deleteMyAccount/resetMyData) — plain module, not 'use server' (takes a raw userId)
│   │   └── constants.ts                   # API base, JWT TTLs, consent validity, rate limits
│   ├── schemas/                           # Zod form validation schemas
│   │   ├── auth.schema.ts                 # Sign-in / sign-up schemas + changePasswordSchema (currentPassword + newPassword strength rules + confirm)
│   │   ├── mortgage.schema.ts             # Mortgage setup form schema
│   │   ├── budget.schema.ts               # Budget form schemas (details, line, funding, expense entry)
│   │   ├── goal.schema.ts                 # Goal form + action schemas
│   │   ├── trip.schema.ts                 # Trip form + action schemas (day/rate-snapshot sub-schemas)
│   │   ├── bank.schema.ts                 # Bank connect + link-config schemas; EB API response schemas
│   │   ├── recurring-item.schema.ts       # Recurring item schema
│   │   ├── planned-item.schema.ts         # Planned item schema
│   │   ├── cashflow-item.schema.ts        # Cashflow item modal form schema (flat superset, `recurrence` discriminator + superRefine)
│   │   ├── salary-config.schema.ts        # Salary config schema
│   │   ├── split.schema.ts                # Split group/expense/settle-up/recurrence/import schemas
│   │   ├── data-transfer.schema.ts        # JSON-backup envelope schema (+ concrete DataExport type)
│   │   ├── user.schema.ts                  # avatarDataUriSchema (data-URI validation for admin updateUser + updateMyAvatar)
│   │   └── occurrence-override.schema.ts  # Override dialog schema
│   ├── auth.ts                            # NextAuth configuration
│   ├── server-logger.ts                   # installTimestampedConsole() — [ISO] prefix on console.* (Node runtime)
│   ├── projection.ts                      # Cash flow projection calculation engine
│   ├── projection-inputs.ts               # Server-only input gathering shared by getProjection + scenarios (transfer helpers live here, NOT in a 'use server' file)
│   ├── scenario-utils.ts                  # Pure scenario-modification application (unit-tested)
│   ├── wealth-assembly.ts                 # Client helper: fetch all wealth inputs + run calculateWealthProjection (mirrors Overview)
│   ├── current-month-actuals.ts           # Pure current-month bank-actual reconciliation (exact match + category-gap blend; unit-tested)
│   ├── retrospective.ts                   # Bank-actual past-months reconstruction (pure engine)
│   ├── wealth-projection.ts               # Net worth/wealth projection engine
│   ├── mortgage-projection.ts             # Shared mortgage amortization engine (dual loan, actual/360, annuity reset)
│   ├── mortgage-utils.ts                  # Pure mortgage helpers (loan-share derivation, Euribor-due detection)
│   ├── mortgage-transfer-utils.ts         # Pure member-transfer helpers for shared mortgages (unit-tested)
│   ├── salary-utils.ts                    # Shared salary calculation utility
│   ├── taxed-income-utils.ts              # Pure taxed-income net math (calculateTaxedIncomeNet) + upcoming-occurrence helper (unit-tested)
│   ├── budget-utils.ts                    # Pure budget engine (restricted-grant allocation, feasibility, transfers)
│   ├── budget-csv.ts                      # Grant-report CSV builders (spending log + summary)
│   ├── csv-utils.ts                       # Generic CSV build/download (semicolon + BOM, fi-FI Excel friendly)
│   ├── debt-utils.ts                      # Pure debt helper (payoff date/info from amortization)
│   ├── bank-utils.ts                      # Pure bank helpers (consent-expiry info, IBAN masking)
│   ├── goal-utils.ts                      # Pure goal engine (progress vs. account/net-worth/manual; goalInjectsIntoCashflow; computeGoalPlan joint funding plan)
│   ├── per-diem-rates.ts                  # Vero.fi 2026 per-diem euro amounts (domestic + PER_DIEM_COUNTRIES_2026 table)
│   ├── per-diem-utils.ts                  # Pure per-diem engine (trip-hours/slice-count, day-list generation, calculatePerDiem; unit-tested)
│   ├── split-utils.ts                     # Pure split engine (cents math, split modes, balances, settle-up, date-grained recurrence)
│   ├── split-draft.ts                     # Pure split-editor logic: draft→SplitSpec, custom amount/percent w/ blank-field auto-fill (unit-tested)
│   ├── split-csv.ts                       # Pure Splitwise-CSV parser (RFC4180, quoted commas; rejects mixed currencies) + row→member mapping
│   ├── split-insights.ts                  # Pure /split summary + insights engine (aggregatePairwiseNets, computeSplitInsights, bucketSpendByCategory, computeGroupPeriodInsights; unit-tested)
│   ├── split-notify.ts                    # Split activity → Home Assistant webhook (pure payload builder + opt-out gate + fire-and-forget POST via next/server after(); plain module, NOT 'use server'; hard-disabled without HA_WEBHOOK_URL)
│   ├── data-transfer-utils.ts             # Pure backup-import helpers (merge-by-id, orphan card-link stripping)
│   ├── maintenance-utils.ts               # Pure history-compaction plan logic (anchor-gated, idempotent)
│   ├── category-utils.ts                  # Pure guessItemCategory (item/merchant name → ITEM_CATEGORIES; incl. Finnish merchant keywords; unit-tested)
│   ├── recurring-detection.ts             # Pure recurring-transaction detector (bank ledger → "track this" suggestions; unit-tested)
│   ├── forecast-vs-actual.ts              # Pure plan-check engine (comparePlanToActual, summarizeMonthProgress, pickDefaultView; Overview card; unit-tested)
│   ├── checkin-utils.ts                   # Pure isCheckInDue (shared by Overview banner + local notification)
│   ├── bank-split-match.ts                # Pure bank-tx↔split-expense matcher ("already split" flags; unit-tested)
│   ├── reorder-utils.ts                   # Pure jiggle-reorder math (arrayMove, targetIndexFromCenters, siblingOffsets, sortByPreferredOrder; unit-tested)
│   ├── bottom-nav-prefs.ts                # Pure mobile bottom-nav tab resolution (NAVIGATION_PAGE_IDS, per-mode defaults, resolveBottomNavIds/toggleBottomNavId; unit-tested)
│   ├── avatar-utils.ts                    # Pure avatar helpers (deterministic getAvatarColor hsl hash, initials; unit-tested)
│   ├── demo-mode.ts                       # UI-only money-masking flag (setDemoMask/isDemoMasked, maskMoney, isDemoExemptPath); zero imports
│   └── constants.ts                       # Currencies, frequencies, categories, formatters
├── proxy.ts                               # Next.js middleware (rate limiting + auth gating) — runs on the Edge runtime; security headers are in next.config.ts
├── instrumentation.ts                     # Next.js register() hook: installs timestamped console + starts bank scheduler (Node runtime)
├── test/
│   ├── setup.ts                           # Test setup (jest-dom matchers)
│   └── mocks.ts                           # Mock entity factories
└── types/
    ├── index.ts                           # All TypeScript type definitions
    └── next-auth.d.ts                     # NextAuth type augmentation
```

## Key Conventions

### Server Actions Pattern

All backend logic uses Next.js Server Actions. **There are no REST API routes** (except the NextAuth handler).

Every server action follows this pattern:
```typescript
'use server';

export async function doSomething(input: SomeInput): Promise<ApiResponse<SomeOutput>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: 'Not authenticated' };

  // Validate with Zod
  const parsed = someSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.errors[0].message };

  // Perform operation
  const result = await dbOperation(session.user.id, parsed.data);

  // Invalidate cache
  updateTag(`user:${session.user.id}:entityType`);

  return { success: true, data: result };
}
```

**Return type**: `ApiResponse<T>` = `{ success: boolean; data?: T; error?: string }`

### Database Layer Pattern

Each entity type has a DB file in `src/lib/db/` that handles file I/O:
```typescript
// Pattern: read-modify-write with encrypted files
const dir = path.join(getUserDir(userId), 'entity-type');
await ensureDir(dir);
const filePath = path.join(dir, `${entityId}.enc`);
await writeEncryptedFile(filePath, entityData);
```

Key functions from `src/lib/db/encryption.ts`:
- `readEncryptedFile<T>(filePath)` — Read and decrypt JSON
- `writeEncryptedFile<T>(filePath, data)` — Encrypt and write JSON
- `getDataDir()` — Returns the data directory path
- `getUserDir(userId)` — Returns a user's data directory
- `ensureDir(dir)` — Creates directory recursively if needed

Per-file key derivation is **HKDF-SHA256** (fast), with a backward-compatible PBKDF2 read fallback for legacy files; a one-shot `scripts/reencrypt-data.mjs` migrates files to the fast format. This eliminated the dominant cold-load cost (per-file PBKDF2 over an already-high-entropy key). See `src/lib/db/AGENTS.md` for details.

### Cache Invalidation

After any mutation, call `updateTag(tagName)` to invalidate cached queries. Common tags:
- `user:${userId}:accounts`
- `user:${userId}:account:${accountId}:recurring`
- `user:${userId}:debts`
- `user:${userId}:investments`
- `user:${userId}:bank-connections` (+ per-connection / per-account variants — see "Bank Sync")
- `users` (admin operations)
- `app-settings`
- `all-data`

### UI Framework

- **Component library**: PrimeReact (not shadcn/ui or Material-UI)
  - Import from `primereact/button`, `primereact/inputtext`, etc.
  - Icons from `primeicons` and `react-icons`
- **Styling**: Tailwind CSS v4 utility classes
- **State management**: React Context (AppContext in `src/components/layout/app-layout.tsx`)
  - No Redux, Zustand, or other state libraries
  - Context provides: drawer state, selected account, refresh callbacks, sidebar state

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
- **Category colors** — `CATEGORY_COLORS` + `getCategoryColor(category)` in `src/lib/constants.ts` is the single category→color map (warm = discretionary, cool = fixed/income; covers cashflow ITEM_CATEGORIES **and** the SPLIT_CATEGORIES names) used by the expense treemap, the cashflow Sankey, category badges, the split spend chart's By-category mode, and the plan-check card's dots. Never assign category colors positionally.
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

### Simple vs Advanced display mode

`UserPreferences.displayMode` (`'simple' | 'advanced'`) drives a per-user progressive-disclosure
mode, read from `useAppContext().displayMode`. Conventions:

- **Resolution**: `AppLayout` resolves an *unset* preference to **`simple` for users who have not
  completed onboarding** and `advanced` for pre-existing accounts (`app-layout.tsx`). Onboarding's
  Done step asks "How much detail do you want to see?" and persists the choice via `setDisplayMode`.
- **Collapse, never remove**: simple mode hides complexity behind expanders ("See all balances",
  "Show details") or falls back to the advanced UI — no feature becomes unreachable. Current scope:
  Overview (Net Worth + Cash tiles only; plain-language KPI labels via `plainTerm`), Cashflow
  ("Money in / Money out / Left over" banner with a sentiment sentence; charts + all-months table
  behind "Show details"), Mortgage (`MyMortgageSummaryCard` personal card; per-loan cards and
  advanced charts hidden), Settings (Data & Storage + Admin tabs hidden), and the reconcile wizard
  (one-screen check-in: auto-starts on the current month, single "Save check-in" button).
- **Nav slimming**: nav entries carry `simpleModeVisible` in `nav-config.tsx`; every surface renders
  from `useVisibleNavItems()` (sidebar, drawer) or, for the bottom-nav, from
  `resolveBottomNavIds()` — whose per-mode defaults `DEFAULT_BOTTOM_NAV_IDS` /
  `DEFAULT_BOTTOM_NAV_IDS_SIMPLE` (`src/lib/bottom-nav-prefs.ts`) swap Overview for Goals in
  Simple mode. Simple mode shows Home, Split, Cashflow, Goals, Settings; everything else
  stays reachable from Home's feature grid (which deliberately lists **all** `navItems`) and the
  command palette. A user's own bottom-nav pick (`UserPreferences.bottomNavIds`, chosen in
  Settings → General → Mobile navigation) overrides the default in BOTH modes.
- **Explain-the-number dialogs**: the Home glance tile and the Overview Net Worth KPI open
  plain-words breakdowns (`home-dashboard.tsx` dialog, `net-worth-explain-dialog.tsx`) built from
  data already on the page — display-only, in both modes.

### Demo mode (UI-only money masking)

A device-local privacy toggle for showing the app to friends: when on, every monetary value
rendered through `formatCurrency` (and its wrapper `formatCents`) is replaced by a fixed
placeholder mask `€✱✱✱,✱✱` (U+2731 asterisks, U+2212 negatives) — chart *shapes* stay real,
only their axis/label/tooltip text masks. Mechanism (`src/lib/demo-mode.ts`):

- **A process-wide flag on `globalThis`, not React state.** `formatCurrency` is a pure formatter
  called from hundreds of non-component call sites (chart option builders, table cell renderers,
  CSV builders) that can't subscribe to context, so a single boolean
  (`setDemoMask`/`isDemoMasked`) lets every formatter branch synchronously. The slot lives on
  `globalThis` (not a module-scoped `let`) because production chunking may instantiate a shared
  module once per chunk graph — a module-local flag set by AppLayout's copy could then disagree
  with the copy a lazy chart chunk's tooltip formatter reads, leaving masked/unmasked values that
  survive a toggle until a reload. `AppLayout` is the sole writer and syncs it **during render**
  (before returning JSX) from `demoMode && !isDemoExemptPath(pathname)`, so the first paint after
  a toggle (or after navigating onto/off an exempt page) already formats correctly. `demo-mode.ts`
  has **zero imports** so `constants.ts` can import it without a cycle.
- **Persistence is per-device** localStorage (`DEMO_MODE_STORAGE_KEY = 'demo-mode'`), NOT a
  `UserPreferences` field — it's about the screen you're showing, not the account. AppLayout also
  listens for `storage` events, so toggling in one tab/window (e.g. the installed PWA) updates
  every other open tab of the origin.
- **Exempt pages**: `/mortgage` and `/split` (exact or prefix-with-slash, so `/splitters` is not
  exempt) keep real values visible even in demo mode (`isDemoExemptPath`).
- **NOT masked**: `formatRate`, input fields, and CSV/JSON exports (only display formatting).
- **Chart-memo dep + remount-key rule** (future code must follow): any ECharts `option` `useMemo`
  that calls `formatCurrency` MUST list `demoMasked` (`useAppContext().demoMasked`) in its deps,
  AND the `<ReactEChartsCore>` element carries `key={demoMasked ? 'masked' : 'plain'}` so a toggle
  remounts the instance — a fresh option/instance is the only guarantee that no internally-cached
  label or tooltip string survives the flip. Done for monthly-flow, cashflow-waterfall,
  expense-treemap, scenario-comparison, split-spend, split-net (Chart.js charts rebuild options
  during render and their tooltip callbacks read the flag at hover time — no key needed).
- **Memoized-widget remount-key rule** (future code must follow): PrimeReact components with
  memoized internals won't re-run `formatCurrency` on a bare re-render, so any long-lived widget
  that bakes money into cells or templates remounts via `key={demoMasked ? 'masked' : 'plain'}` —
  the money `DataTable`s (projection-table, bank-ledger-table, budget-expense-log) and the
  cashflow header's account-selector `Dropdown` (money in its `valueTemplate`). The mortgage
  ledger is on an exempt page; modals mount fresh so they need no key.
- **Toggle surfaces**: the user-menu item (`nav-config.tsx`) and the command palette
  (`action-demo-mode`); AppLayout renders a fixed "Demo" indicator pill (z-45, above mobile
  chrome, below overlays — eye-off icon, click to exit; title notes when the current page is
  exempt). Context exposes `demoMode`/`demoMasked`/`setDemoMode`.

### Responsive & PWA (mobile + desktop)

**Every new page, component, and interface MUST be responsive** — it has to look and work well on a phone (~375px wide) *and* on desktop, with no horizontal overflow. This is a hard requirement, not a nice-to-have. Always check both a mobile (~390px) and a desktop (~1280px) breakpoint before considering UI work done (the `preview_*` tools + `preview_resize` make this easy — assert `document.documentElement.scrollWidth <= window.innerWidth`). The app is also an **installable PWA** (Add to Home Screen on iOS/Android/desktop).

- **Breakpoint switch — Tailwind `lg` (1024px)**: below `lg` = mobile chrome, at/above `lg` = the desktop sidebar layout. **Drive visibility with CSS** (`lg:hidden` / `hidden lg:block`) to stay hydration-safe and avoid flashes; only use the SSR-safe `useIsMobile()` / `useMediaQuery()` hook (`src/lib/hooks/use-media-query.ts`) when logic must branch (which component to mount, a numeric prop, `maximized={isMobile}`).
- **Navigation chrome**: desktop uses the fixed collapsible `SidebarNav` (`hidden lg:flex`); mobile uses `MobileTopBar` (hamburger + brand + search; the monthly check-in deliberately lives on Overview, not in the chrome), `BottomNav` (1–4 user-chosen tabs + a fixed "More"; see `src/lib/bottom-nav-prefs.ts`), and `MobileNavDrawer` (PrimeReact `Sidebar`, the full menu). All four nav surfaces read the **shared `src/components/layout/nav-config.tsx`** (`navItems`, `isNavItemActive`, `useUserMenuItems`) — add a nav entry there, never in one surface only. The sidebar/drawer user button renders the user's `UserAvatar` (not a generic icon), and the user-menu's avatar+name+email header item navigates to `/settings?tab=account` — the Settings page maps a `?tab=` slug to the index of its *rendered* tabs (Simple mode hides some), unknown slug ⇒ first tab. `<main>` uses `lg:ml-16`/`lg:ml-64` (no base margin) + top/bottom padding for the mobile bars, all with `env(safe-area-inset-*)` so the iPhone notch / home indicator are respected (root `viewport` sets `viewport-fit=cover`). Mobile chrome (`MobileTopBar`, `BottomNav`) is `z-40`; the desktop `SidebarNav` and PrimeReact/command-palette overlays sit at `z-50`+.
- **Dialogs**: a global mobile cap in `globals.css` (`@media (max-width:640px)` → `.p-dialog { width:95vw; max-width:95vw; max-height:calc(92vh − safe-area insets) }` + scrollable content) fixes **every** PrimeReact `Dialog` at once — you normally don't need per-dialog responsive props. For genuinely huge wizards, `maximized={isMobile}` is an option (the 95vw cap turns "maximized" into a tall centered box; the inset-aware `max-height` keeps its header clear of the dynamic island in the installed PWA).
- **Overlay safe-area insets (installed PWA)**: portalled overlays render at the viewport edges (`viewport-fit=cover`), so `globals.css` pads them for `env(safe-area-inset-*)`. Off-canvas drawers (PrimeReact `Sidebar`) get top/bottom/side padding so the header clears the island and the footer clears the home indicator — **the position class lives on the `.p-sidebar-mask`, the panel is its child**, so target `.p-sidebar-mask.p-sidebar-left > .p-sidebar` (not `.p-sidebar.p-sidebar-left`, which matches nothing). Top-anchored `Toast`s drop below the island. Sticky in-page headers must pin **below** the mobile top bar (`sticky top-[calc(3.5rem+env(safe-area-inset-top))] lg:top-[env(safe-area-inset-top)]`), never `top-0` — the `lg:` offset matters because a **desktop-breakpoint installed PWA (iPad)** also runs edge-to-edge under the OS status bar with no mobile top bar to clear it. For the same reason `<main>` keeps `lg:pt-[env(safe-area-inset-top)]`/`lg:pb-[env(safe-area-inset-bottom)]` (not `lg:pt-0`), the desktop `SidebarNav` aside pads itself with both insets, and `AppLayout` paints a fixed `hidden lg:block` glass strip of height `env(safe-area-inset-top)` under the status bar so scrolled content never shows through it (all of these are 0 in a normal desktop browser).
- **Tables (mixed strategy)**: lighter tables (e.g. cashflow projection, bank ledger) render a `lg:hidden` card/list view beside a `hidden lg:block` DataTable; the wide mortgage ledger keeps a single DataTable with a **frozen first column** (`frozen alignFrozen="left"` + `scrollable`) for horizontal scroll. Don't let a raw wide table overflow the viewport.
- **Charts**: containers must be width-fluid (`width:100%`) with responsive heights (e.g. `h-72 lg:h-96`); Chart.js charts set `maintainAspectRatio:false` and fill the wrapper (don't also pass a fixed `height` prop — they fight). ECharts/Sankey resize to the container; pass a shorter mobile height where it helps.
- **Toolbars / page headers**: stack on mobile (`flex-col sm:flex-row`), full-width controls (`w-full sm:w-auto` / `flex-1 sm:flex-none`). Full-bleed sticky bars that use negative margins must match the responsive content padding (`-mx-2 px-2 sm:-mx-4 sm:px-4 lg:-mx-6 lg:px-6`). Keep tap targets ≥44px. `TabView`s with many tabs use `scrollable`.

**PWA implementation** (all in place — keep it intact when touching the shell):
- `src/app/manifest.ts` → `/manifest.webmanifest` (name/icons/`display:standalone`/theme+background color). `src/app/layout.tsx` sets the `viewport` export (`themeColor`, `viewport-fit=cover`) and `metadata` (`appleWebApp`, `icons`, legacy `apple-mobile-web-app-capable` via `other`) and mounts `<ServiceWorkerRegister>` (root layout — `app/page.tsx` bypasses the dashboard group layout).
- **Icons**: master SVGs `public/icons/icon.svg` + `icon-maskable.svg`; PNG set generated by `node scripts/generate-icons.mjs` (uses `sharp`, committed output). Re-run after editing the SVGs.
- **Theme CSS** (`/themes/`): `scripts/copy-themes.mjs` (wired into `build`/`postinstall`, or `pnpm copy-themes`) recolors PrimeReact's `lara-{light,dark}-green` themes into `public/themes/sampolio-{light,dark}.css`; `public/themes/glass-overrides.css` is a separate hand-authored liquid-glass override stylesheet that `theme-provider.tsx` appends **after** the theme link so its rules win by source order. Re-run `copy-themes` after a PrimeReact upgrade; all three files are covered by the SW's stale-while-revalidate `/themes/*.css` rule.
- **Service worker** `public/sw.js`: GET-only (never caches POST/server actions/RSC/`/api`/`/auth`), network-first for navigations (so a deploy's shell is never stale), cache-first for hashed `/_next/static/*`, stale-while-revalidate for stable-named `/themes/*.css` + `/icons/*`, offline fallback `public/offline.html`, and a `notificationclick` handler (focuses/opens `/overview` for the opt-in local check-in notification — see `CheckinNotifier`). **Bump `CACHE_VERSION` in `sw.js` on any deploy that changes cached assets.** Registration is production-only and no-ops on `localhost` (won't poison dev HMR).
- `next.config.ts` serves `/sw.js` `no-cache` and adds `worker-src 'self'` to the CSP; `src/proxy.ts` exempts `manifest.webmanifest`, `sw.js`, `offline.html`, and `icons` from the auth/rate-limit matcher so the install screen can fetch them.

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

### Projection Engine

Full reference: [`docs/projections-and-reconciliation.md`](docs/projections-and-reconciliation.md). The pure engine is `calculateProjection(account, recurringItems, plannedItems, taxedIncomes?, filters?, latestSnapshot?, mortgageTransfers?, budgetTransfers?, cardBillTransfers?, currentMonthActuals?, goalTransfers?, tripTransfers?)` in `src/lib/projection.ts` — `goalTransfers`/`tripTransfers` are appended after `currentMonthActuals` (append-only, so existing positional call sites like `src/lib/bank/sync.ts` compile unchanged); `getProjection` (`src/lib/actions/projection.ts`) gathers all inputs (via `cachedGetAccountProjectionData`) and also returns the bank-actual `retrospective`.

Hard invariants (violating any of these produces wrong numbers):

- **TaxedIncome** enters projections at `netAmount`, never `grossAmount`. A recurring taxed income skips any month listed in `skippedOccurrences` (one-offs ignore the field). Nets are **frozen at write time** (`calculateTaxedIncomeNet` in `src/lib/taxed-income-utils.ts`); the salary actions (`create/update/deleteSalaryConfig`) cascade-recompute all `useSalaryTaxSettings` rows via `recomputeSalaryLinkedTaxedIncomes` (`src/lib/db/taxed-income.ts`), invalidating the `taxed-income` tag only when rows changed. `getProjection` also returns the full `taxedIncomes` so the cashflow Sankey can synthesize a gross inflow + Tax/Contributions/Other-deduction outflows for `source: 'taxed-income'` lines, mirroring salary (`isGrossSource` in `monthly-flow-chart.tsx`).
- **Occurrence overrides** are `PlannedItem`s flagged `isRecurringOverride` + `linkedRecurringItemId` (+ optional `skipOccurrence`); the projection applies them *in place of* that month's recurring occurrence. The DB layer must persist those flags — dropping them double-counts the item. `cleanupExpiredOverrides` uses the **anchor-based** cutoff.
- **Anchoring**: `resolveAnchor()` in `projection.ts` is the *single* helper — latest reconciliation snapshot wins, else genesis `startingDate`/`startingBalance`. Snapshot precedence is **last-write-wins per entity/month** (`createBalanceSnapshot`); bank sync writes only the **current** month. Debt snapshots are stored negative and negated in `wealth-projection.ts`.
- **"Paid by card"**: an expense tagged `paidByCardLinkId` is excluded from direct cash (filtered in `getProjection`) and rolled into that card's injected `credit-card` bill line — never both.
- **Card bill bases** (`computeCardBilling` + `computeCardBillTransfersForAccount`): a closed statement is a firm bill (`basis: 'statement'`); the current OPEN cycle is billed unconditionally as actual booked+pending spend so far blended toward the cycle forecast (tagged items + `expectedMonthlySpend`) — only the *still-unspent* part of the forecast (`max(0, forecast − actualToDate)`) is added, **pro-rated over the days still ahead** (`basis: 'open-cycle'`, "(cycle in progress)"), so once actuals reach the expected total nothing extra is piled on; flat `taggedSpend + expectedMonthlySpend` estimates (`basis: 'forecast'`, "(estimate)") apply only to cycles beyond that. Real transactions always drive the next bill — never let the flat estimate cover a cycle that has synced data. The engine also emits the **previous** closed statement's bill (from its `cycleSpend` only — `lastStatementBalance` applies only to the newest close, never the previous one) while `yearMonthOf(prevDue) >= yearMonthOf(now)`, ordered first in `bills[]`, so the current month's already-due bill doesn't vanish mid-month when `now` crosses the statement day; it ages out on its own once its due month is in the past.
- **Cycle spend excludes card payments.** `cycleSpend` counts purchases net of merchant refunds but skips card **payments/settlements** (`isCardPayment`: a *credit* — positive amount — flagged by a settlement transaction code, OR by a settlement-pattern `counterpartyName` with no MCC — OP's "Suoritus" credits — or a "bare" credit with no counterparty/MCC). A bill payment booked inside a cycle window would otherwise cancel that cycle's purchases (it reduces the outstanding balance, it is not negative spend). Feed `computeCardBilling` the richer `toCardTxn(t)` shape (carries `bankTransactionCode`/`counterpartyName`/`merchantCategoryCode`), never a bare `{bookingDate, amount}`.
- **Card balances vary by bank; dates too.** `pickCardBalances` reads booked from `ITBD|CLBD|OPBD|PRCD` and available from `ITAV|XPCD|CLAV|FWAV`, and reinterprets a lone NEGATIVE available (OP's single mislabeled `ITAV`) as the booked/owed balance; booked-without-available clears stale `availableCredit`/`creditLimit` on the link. Display/net-worth go through `effectiveCardNumbers` (`bank-utils.ts`): owed falls back to a negative `lastBalance`, limit to the user's `manualCreditLimit` (OP never reports one), available is derived. Transaction `bookingDate` falls back `booking_date || value_date || transaction_date || sync-day` (OP cards send only `transaction_date`), and every sync self-heals previously collapsed ledgers via `repairDegenerateBookingDates` (`repair-booking-dates.ts`, pure) before merging.
- **Retrospective card drill-down**: a past month's opaque cash-side card-bill debit is collapsed into one `source: 'credit-card'` line (`itemId` = card link id, name `Card: {name}`) by matching cash debits ↔ card settlement credits (exact cents, ±4 days; `matchCardPayments` in `card-payment-match.ts`, sources from `getCardPaymentSourcesForAccount`); `getCardStatementBreakdownForAccount` reconstructs the settled cycle for past months with the same cash-debit matcher (never bucket by the credit's month — it often books in the next month), so the Sankey/treemap expand it like a forecast bill. On top of the exact seeds, `matchCardPaymentsWithFingerprints` LEARNS a card's cash-side fingerprint (normalized counterparty + first remittance line, seed ≥ €50, ambiguous fingerprints dropped) and tags older same-fingerprint debits whose settlement credits the bank no longer serves (Nordea's short card-history window). Seed candidates must come from ALL booked debits — including the anchor month the retrospective never emits — since the only in-range settlement credit may be the current month's.
- **Injected lines** (`mortgage-payment`, `budget`, `credit-card`, `goal`, `trip`) are read-only, not stored entities; they deep-link to their owning page (`goal` → `/goals`, `trip` → `/budgets#trips`).
- **Retrospective** months (`source: 'bank-actual'`, `isActual: true`) are reconstructed purely from booked bank transactions, chained backward from the anchor, capped at `RETROSPECTIVE_MONTHS_BACK` (24) — **not** bounded by the account's Sampolio `startingDate`. They are read-only in the UI (no add/edit).
- **Current-month actualization** (`src/lib/current-month-actuals.ts`, `applyCurrentMonthActuals`) fixes the mid-month double-count for bank-linked accounts: when the anchor month equals the current calendar month and the account has linked cash/savings bank transactions, the anchor balance is already the LIVE synced balance (it reflects everything paid so far), so `calculateProjection`'s optional 10th param `currentMonthActuals?: CurrentMonthActuals | null` (`{ transactions: ActualTxLike[] }`, booked-only) reconciles that month's forecast lines against booked transactions instead of re-adding the full plan on top. Each line's `amount` stays the planned/effective amount; a new `remainingAmount`/`isPaid`/`matchedTxId` drive the actualized totals (exact match first, then a category-gap blend for unmatched variable expenses), and the row is flagged `isActualized: true` with `plannedTotalIncome`/`plannedTotalExpenses` preserved for "of €Y planned" UI. Policy varies by line source: income (including `trip` lines) and `mortgage-payment`/statement-basis `credit-card` bills are `'exact-only'` (never gap-reduced); recurring/planned expenses are `'full'`; `budget`/`goal` lines and open-cycle/forecast card bills are `'none'` (untouched — the open cycle already self-blends in card billing). Pending transactions never enter the match set (they mutate on booking). `autoAnchorAccount` (`src/lib/bank/sync.ts`) deliberately omits the param — its snapshot baseline must stay the pure planned projection for a meaningful variance. Scenario runs (`runScenarioProjection`) pass the same `currentMonthActuals` to both the current and modified runs for Playground parity.

### Shared Mortgage (multi-user, non-user-scoped)

Full reference: [`docs/mortgage.md`](docs/mortgage.md). A mortgage is **shared** by members and lives in the global `data/shared/mortgages/` dir (`{id}.enc` + `{id}/rates|costs|extra-payments|snapshots|actuals/`, with a `data/shared/mortgage-members/{userId}.enc` reverse index).

Hard invariants:

- **Access control lives in the action layer** (`loadMortgageForMember` checks `mortgage.members[].userId`); the encryption key is global, so the file layer alone protects nothing.
- **Cache tags are `mortgage:{id}`-keyed** (member-agnostic) so one `updateTag` reaches every member; only the membership list uses `user:{userId}:mortgages`.
- **Never also enter the mortgage as a `Debt`** — member equity already folds into net worth via `wealth-projection.ts` (double counting).
- **`deriveLoanShares` (`src/lib/mortgage-utils.ts`) is the single source of truth** for the share split; the derived `loanSharePercent` is stored and used at **full precision** (rounding breaks 50/50 convergence at payoff).
- **Drift snapshots are applied inline** at their month by the engine (continuous history), unlike `resolveAnchor` which discards pre-snapshot history; the schedule is emitted **from genesis**. Recorded `MortgageActualEntry` months are used **verbatim**, and forecasts after the last actual hold the bank's current installment (`levelPayment = scheduledPayment`) until the next Euribor reset.
- The member's monthly cashflow line is a **read-only `mortgage-payment` injection** (`MortgageTransfer`), not a stored entity; edits happen on `/mortgage` only. `setMyMortgageLinkedAccount` is deliberately not owner-gated (affects only that member's private cashflow).

### Budgets (trip/project budgets with grant funding)

Full reference: [`docs/features.md`](docs/features.md) §Budgets. A user-scoped, bounded-period plan (cost lines + funding sources + expense log) embedded in **one encrypted doc** at `data/users/{id}/budgets/{id}.enc` (one cache tag `user:{userId}:budgets`). Pure engine: `src/lib/budget-utils.ts` (`computeFeasibility`).

Hard invariants:

- A **restricted grant's surplus is unusable** — reported, never netted against other categories or out-of-pocket.
- Cashflow injection only when `status === 'confirmed' && !isArchived` with a `linkedAccountId` (≤2 aggregated read-only `source: 'budget'` lines/month); `confirmBudget` **requires a manual `exchangeRate`** when budget currency ≠ account currency.
- Regular income on the budget page is **display-only** — never enters out-of-pocket math, never injected back (no double counting by construction).
- `BudgetExpenseEntry.date` is a plain `'YYYY-MM-DD'` string (month via `date.slice(0, 7)`, never `new Date()` parsing).
- CSV export (`csv-utils.ts` + `budget-csv.ts`): semicolon + UTF-8 BOM + comma decimals (fi-FI Excel). Budget UI uses `BUDGET_CATEGORIES`, not `ITEM_CATEGORIES`.
- **Linked split group** (`linkedSplitGroupId`, optional; picker offers only same-currency groups): the "From split group" section shows the viewer's cost share of the group's expenses in the budget period, **computed at read time** (`buildSplitBudgetEntries` in `budget-utils.ts`) — never copied into the budget doc, never fed into `computeFeasibility` or the cashflow injection (display-only, like regular income). Share rule: native rows use `paid − net`; imported rows (net-only) fall back to `max(0, −net)`.
- **Trip-funded per-diem funding** (`BudgetFundingSource.linkedTripId?`, per-diem sources only; the Zod schema requires rate+days XOR `linkedTripId`, and rejects `linkedTripId` on any other funding type): a per-diem source can draw its amount from a linked `Trip`'s live per-diem total. The stored amount is a write-time snapshot; `hydrateBudgetFundingFromTrips(budget, trips)` (pure, `budget-utils.ts`) re-derives it at read time in `getBudgets`/`getBudgetById` and `getBudgetTransfersForAccount` (a missing/deleted trip → the stored snapshot stands). Linking requires `budget.currency === 'EUR'`, and a trip funds **at most ONE budget** (validated across all budgets in `resolveTripLinkedAmount`, curly-quote error). Double-count guard: `tripIdsFundedByActiveBudgets(budgets)` (confirmed && !archived && `linkedAccountId` && a per-diem source with `linkedTripId`) filters `getTripTransfersForAccount` so such trips stop injecting their own `source: 'trip'` income — the budget's funding-income line already covers them (a draft/archived budget → the trip keeps injecting).

### Bank Sync (Enable Banking — PSD2 AIS, read-only)

Full reference: [`docs/bank-sync.md`](docs/bank-sync.md); production topology/secrets in [`docs/operations.md`](docs/operations.md). Sampolio syncs **read-only** balances + transactions via Enable Banking. Engine in `src/lib/bank/` (constants, jwt, client, connect, reconcile-links, sync, scheduler, mappers, dedup, link-identity, apply-link-balances, card-billing); actions in `src/lib/actions/bank.ts`; the consent callback is the only non-NextAuth API route.

Hard invariants:

- **Hard-disables when unconfigured**: without all `ENABLE_BANKING_*` env vars there are **no network calls** and the UI shows a "not configured" notice.
- **Deep history exists only in the ~1h fresh-consent window**: the first/post-reconnect sync backfills `BACKFILL_DAYS = 730` with `strategy: 'longest'`; raising the constant never deepens an existing connection — **reconnect** does (`reconcileLinks` clears `syncCursor.backfilledThrough`; dedup absorbs overlap).
- **Re-consent matching is `identificationHash` → `accountUid` → IBAN** (`reconcileLinks`): EB rotates account uids every session, and `identification_hash` is the only key that survives for no-IBAN accounts (cards) — never drop it from the matcher. `sync.ts` backfills missing hashes onto pre-existing links via `GET /sessions/{id}` (an EB-side lookup, no bank allowance spent).
- **Cross-user fan-out for shared/joint accounts** (one fetch per underlying account per cycle): `linkIdentityKey` (`link-identity.ts`: `identificationHash ?? iban ?? link.id`) is the *only* thing that may match links across users. Sibling writes go through the same `mergeTransactions`/`applyLinkBalances`/`autoAnchorAccount` paths (never bypass dedup), never touch a sibling's `backfilledThrough` (their deep backfill needs their own session), and are fully isolated — a fan-out failure never fails the primary sync. Scheduled runs skip-fetch a fresh link (`isLinkFresh`; `skippedFresh` in the audit); manual refreshes never skip (attended calls are exempt from the ASPSP limit). The scheduler's daily budget (`MAX_SCHEDULED_FETCHES_PER_DAY = 3`, ~8h cadence) is keyed by `linkIdentityKey` — shared across users — and only actually-fetched accounts draw from it.
- **Pending transactions are fetched with a second, gated `transaction_status=PDNG` query.** Banks return booked-only by default, so each per-link sync runs an extra paginated transactions fetch over the same window — always on attended runs (`psuIp` present), on unattended runs only on the link's first sync of the UTC day (`shouldFetchPending` in `sync.ts`; keeps unattended transactions-endpoint calls ≤4/day/account: 3 scheduled booked + 1 PDNG). The PDNG fetch is **fully non-fatal**: a failure logs a warning, sets `pendingFetchOk: false` in the audit, and the run continues booked-only. Per-bank reality (probe-verified 2026-07-28): Nordea serves PDNG rows (stable `entry_reference`, `booking_date: null`, `transaction_date` = purchase date); S-Pankki serves none under any status.
- **Pending rows are reconciled against the fetched window, not accumulated.** `mergeTransactions(existing, incoming, nowIso, window)` prunes any stored **pending** row inside `[fromDate, today]` the fetch didn't return (it booked under a changed key or was cancelled) — booked/out-of-window rows are never touched. The prune `window` is passed **only when the PDNG fetch ran and succeeded** (a booked-only fetch must not prune pendings it never asked about). Incremental windows are stretched back over stored pendings (bounded by `PENDING_RECONCILE_LOOKBACK_DAYS = 45`) so slow-settling card holds are always re-fetched. Never revert to an append-only merge: banks rewrite a pending's id/counterparty on booking, so an accumulate-only store strands phantom duplicates that inflate card cycle spend.
- **Merge identity is stable and dates are preserved.** `dedupKey` is the `entry_reference` for booked **and** pending rows when present (EB only returns refs for pendings when they survive booking), synthetic otherwise. The merge preserves the stored row's `id` on every refresh/promotion (`SplitExpenseBankLink.txId` references it), coalesces `transactionDate`/`valueDate` (the mapper always sets the keys, possibly undefined — a plain spread would wipe them), never downgrades a booked row back to pending (banks can report both statuses for one ref mid-booking), and **fuzzy-promotes** an unmatched incoming booked row onto a stored pending with the same amount+currency whose date is within `[booked − PENDING_BOOKING_MATCH_MAX_LAG_DAYS (7), booked + 1]` (one-to-one, name-affinity preferred, never a pending the same fetch still reports) — carrying the pending's purchase date into `transactionDate`.
- **UI shows the purchase date; engines stay on `bookingDate`.** `txDisplayDate(t)` (`bank-utils.ts`) = `transactionDate ?? bookingDate` drives the ledger's primary date, sort, month grouping, and split prefill, and `bank-split-match` matches on it; retrospective, card billing cycles, current-month actuals, dedup keys, and sync cursors all keep using `bookingDate`. The sync cursor's `lastBookingDate` anchors on the newest **booked** row (never a pending's date).
- Each sync writes a `source: 'bank-sync'` `BalanceSnapshot` for the **current month only**, and **only for `cash`/`savings` links** with a `linkedFinancialAccountId` — cards update link fields (`outstanding`, `creditLimit`) instead and fold into net worth as card liabilities. Precedence is last-write-wins (see Projection Engine).
- **Never enter a synced card as a `Debt`** (double counting — the card-liability fold-in already covers it).
- `updateTag` throws in GET route handlers and background (scheduler) scope — callback code wraps it in try/catch; scheduler-written data relies on the bounded `synced` cacheLife profile, never `'indefinite'`.
- IBANs are masked and never logged.

### Goals

Full reference: [`docs/features.md`](docs/features.md) §Goals. A user-scoped financial target (actions, DB at `data/users/{id}/goals/{id}.enc`, cached queries tag `user:{userId}:goals`, Zod schema, `calculateGoalProgress`/`computeGoalPlan` engine) surfaced at **`/goals`** (card grid + create/edit dialog in `src/components/goals/`). A goal is `goalType: 'reserve'` (default, held indefinitely) or `'spend'` (an amount actually spent at the target date); a spend goal tracked against an account balance with a target date may set `injectIntoCashflow` to inject its `targetAmount` as a real `source: 'goal'` expense line at the target month — the single predicate `goalInjectsIntoCashflow` (`src/lib/goal-utils.ts`) gates this, shared by the projection gatherer (`getGoalTransfersForAccount`) and the plan engine. That is the **one exception** to "goals only read projections" — every other goal never feeds back into the cashflow/wealth engines. Active goals with a `priority` (lower funds first) are planned jointly by `computeGoalPlan`, which subtracts earlier goals' claims from the shared pool (an account balance, or net worth — every non-manual goal's claim also reduces the net-worth pool) so competing goals see a realistic remainder instead of double-counting; an injecting goal's claim releases to 0 once its target month passes (the double-claim guard), and manual goals stand alone. Progress is computed client-side: `getProjection` per *linked* account and `fetchWealthProjectionMonths` (`src/lib/wealth-assembly.ts`, the extracted Overview wealth assembly) whenever any active non-manual goal exists — reuse that helper rather than re-assembling wealth inputs. Amounts display in the goal's currency with no conversion (app-wide limitation).

### Trips (Vero.fi per-diem travel reimbursements)

Full reference: [`docs/features.md`](docs/features.md) §Trips. A user-scoped entity (single-doc storage at `data/users/{id}/trips/{id}.enc`, cached queries tag `user:{userId}:trips`, Zod schema, actions in `src/lib/actions/trips.ts`) surfaced as the **Trips section of the merged "Trips & Budgets" page at `/budgets`** (`src/components/trips/trips-section.tsx`, `<section id="trips">`; card grid + create/edit dialog in `src/components/trips/`; `/trips` is a server `redirect('/budgets')` for old links), implementing the Finnish Tax Administration's tax-exempt per-diem allowance rules (decision VH/6575/00.01.00/2025). Rate euros live in `src/lib/per-diem-rates.ts` (`PER_DIEM_COUNTRIES_2026`, domestic full/partial, default-foreign fallback); the pure calculation engine is `src/lib/per-diem-utils.ts` (`computeTripHours`, `generateTripDays`, `calculatePerDiem`) — full 24h slices from departure each earn a full per diem at that slice's country rate, a trailing remainder slice earns full/partial/half-foreign/nothing depending on hours and whether the trip has any full day, free meals halve full (2+ meals) or partial/half-foreign (1+ meal) days, and a per-day `overrideAmount` always wins. A `Trip` snapshots the rates in effect at creation (`TripRateSnapshot`) so a later rate-table change never retroactively alters an already-planned or -reimbursed trip. A non-`'reimbursed'` trip injects `calculatePerDiem(trip).total` as a read-only `source: 'trip'` income line ("Per diem: {name}") in its linked account's cashflow at `expectedReimbursementMonth` (`getTripTransfersForAccount` in `src/lib/projection-inputs.ts`) — marking a trip `'reimbursed'` stops the injection, same as a settled budget/goal. A trip whose per-diem is already funded through an active (confirmed, account-linked) budget via `linkedTripId` also stops injecting its own line (the guard `tripIdsFundedByActiveBudgets` in `getTripTransfersForAccount` — see Budgets above), so the budget's funding-income line isn't double-counted.

### Split (shared expense-splitting groups — a Splitwise replacement)

Full reference: [`docs/features.md`](docs/features.md) §Split. A **shared, multi-user** entity in the global `data/shared/split-groups/` dir; access control in the action layer (`loadGroupForMember`); members are account-only; cache tags keyed `split-group:{id}` (+ `:summary`, `:expenses`), membership list under `user:{userId}:split-groups`. Pure engine: `src/lib/split-utils.ts`; shared `<SplitEditor>` (`split-draft.ts`) is the single "how to split" UI across quick-add/edit/recurring dialogs.

Hard invariants:

- **Money is INTEGER CENTS everywhere.** Every row carries `netByUserId` (sums to 0) as the canonical balance contribution: **`net > 0` ⇒ OWED, `net < 0` ⇒ OWES** (the Splitwise CSV sign convention). Balances = `Σ net`. `resolveSplit` distributes cents remainders deterministically.
- **Storage is monthly-chunked** (`{id}/expenses/{YYYY-MM}.enc`, never one file per row) with a maintained `summary.enc` — delta-updated on the hot add path, fully rebuilt (`rebuildSummary`) on edit/delete/import.
- **All chunk/summary/cursor writes go through the per-group in-process mutex** (`withGroupLock`) — correct only because the app is single-node.
- **Recurrence is materialized** with deterministic `occurrenceKey = ${ruleId}:${YYYY-MM-DD}` (re-runs overwrite, never duplicate); `catchUpGroupRecurrences` runs in a **server action** (request scope, where `updateTag` works), never from the background scheduler.
- **Rule end date is editable** (`updateSplitRecurrenceRuleSchema` accepts `endDate: null` to clear): `planRecurrenceRuleUpdate` (`split-utils.ts`, pure) detects an endDate change and, when it moved back past already-materialized occurrences, prunes the generated tail (`deleteGeneratedOccurrencesAfter`) and clamps `lastGeneratedThrough` — prune + rule update run inside **one** `withGroupLock`, then `catchUpGroupRecurrences` runs **outside** it (the mutex is non-reentrant; calling it inside deadlocks). User-edited generated rows still carry `generatedFromRuleId` and get pruned too (accepted).
- **New-since-last-visit** is a per-group ISO watermark `UserPreferences.splitLastSeenAt` written by `markSplitGroupSeen` (membership-checked, future-clamped, monotonic forward-only). The detail page freezes the watermark at mount (dots on other members' newer rows), then advances it via dwell-marking: `useDwellSeen` (`src/lib/hooks/use-dwell-seen.ts`, ~1.6s continuous on-screen) + `computeSeenWatermark` (contiguous frontier; own rows auto-pass). First visit stamps the baseline with no dots; the list page dots a group card when `summary.lastActivityAt > splitLastSeenAt[groupId]`.
- CSV import: rows keep only per-member net (`paidBy`/`owed` undefined); the group's currency is stamped on imported rows. Mixed-currency files are rejected at parse time, and the action rejects rows whose currency differs from the group's.
- The user's aggregate net folds into net worth via `WealthProjectionData.splitNetTotal` (Overview "Split balance" KPI) — **never keep a manual receivable for the same balances** (double counting). Split is **not** injected into the cashflow projection.
- **Split↔bank linking**: `SplitExpenseItem.bankLink?: SplitExpenseBankLink` is an optional, denormalized pointer (txId, linkedAccountId, `ownerUserId`, date/amount/currency, counterparty/bank name — **never IBANs**) so other group members can see basic details without access to the owner's bank data; `ownerUserId` is stamped server-side from the session in `createSplitExpense`, never client-supplied. `updateSplitExpenseSchema` omits `bankLink` (unforgeable/uneditable via edit) and `updateSplitExpense` carries `existing.bankLink` through its row rebuild. "Split this" on `/bank` is what creates the link. A ledger row's "already split" flag comes from the pure `matchTransactionsToSplits` (`src/lib/bank-split-match.ts`): an explicit `bankLink.txId` match always wins; otherwise a greedy one-to-one heuristic (same currency + exact cents + booking date within ±3 days, spend only) flags candidates with no `bankLink`. Candidates are read-only via `getMySplitLinkCandidates(months)` (`src/lib/actions/split-groups.ts`).
- **Detail-row interactions** (`split/[id]/page.tsx`): whole rows are `role="button"` — an expense row opens the edit dialog, a payment row opens its row menu; trailing action buttons `stopPropagation`. The subtitle reads `"{Payer} paid {amount} · added by {Adder}"` with **first names** ('You' for self); a `paidBy`-less imported row omits the payer segment. The Activity tab feeds these clicks through `SplitActivityFeed`'s `onEventClick`/`isEventClickable`/`myId` props (expense events open the edit dialog, fetching that month's chunk if not loaded; Home's cross-group feed instead navigates to the group; own rows read "added by You"). Group cards on `/split` reorder via **jiggle mode** (see Motion) persisting `UserPreferences.splitGroupOrder?: string[]` (`updateSplitGroupOrder`, sanitized against current group ids like `bankAccountOrder`).
- **Home Assistant webhook notifications** (`src/lib/split-notify.ts`, a plain server module — NOT `'use server'`): five events — `expense.created` / `expense.updated` / `expense.deleted` / `payment.recorded` / `expense.generated` — each emitted **post-response** via `after()` from `next/server` (the codebase's only use of that hook), so a notification can never fail or delay the mutation. **Hard-disabled** without `HA_WEBHOOK_URL` (`AUTH_URL` doubles as the deep-link base): `getSplitNotifyConfig()` returns null and no network call happens, mirroring `getBankConfig()`. Recipients = the group's members **except the author**, except anyone who opted that event out (`UserPreferences.splitNotificationPrefs`, absent object/key ⇒ on — Settings → General → "Push notifications"); **empty recipients ⇒ no POST at all**. Deleting a **payment** row emits nothing (only expense rows notify). The payload carries a prebuilt fi-FI `message`, the group/author/recipients, and the expense or payment block — **never log the payload or the webhook URL** (it embeds the secret webhook id); failures log the event type plus an HTTP status or error name only. Author per event: the acting member, except `expense.generated`, whose author is the rule's payer.
- **List-page aggregates** (`split/page.tsx`): an "Across all groups" summary card and an always-expanded **Insights** section, both from the pure engine `src/lib/split-insights.ts`. `aggregatePairwiseNets` sums the viewer's per-counterparty position (per group's `suggestSettleUp`, so it always agrees with each group's settle-up screen; cross-currency kept separate, "(mixed currencies)" note). `getSplitInsights(monthsBack = 12)` (`split-groups.ts`; cached summaries → overlapping months' chunks → pure `computeSplitInsights`) feeds the lazy ECharts `split-spend-chart` (stacked spend with a By group / By member / **By category** toggle — category mode buckets via `bucketSpendByCategory(insights, 8)` top-N + 'Other' and colors via `getCategoryColor`) + `split-net-chart` (running viewer-net line over green/orange **monthly-change bars**; the first bar is measured against `insights.viewerNetBaseline`, and when a large standing balance dwarfs the deltas the bars move to a hidden second y-axis whose zero is pixel-aligned with the primary axis's zero). **Imported-row paid attribution is a documented LOWER BOUND**: native rows use exact `paidBy` shares, but net-only imported rows credit each member `max(0, net)`.
- **Group-detail "Last 30 days" card** (`src/components/split/group-period-card.tsx`, between the balance banner and the recurring-rules card on `/split/[id]`): pure `computeGroupPeriodInsights(members, rows, fromDate, toDate)` over the page's already-loaded expense chunks (the 30-day window spans ≤2 calendar months, always within the initial 3-chunk load — no extra fetch). Total spend headline + a segmented who-paid bar tinted with `getAvatarColor(userId)` (`role="img"` with a descriptive label), and a default-closed `.collapse-grid` expander with top-3 category chips, top-3 expenses, and `describeGroupPeriod` sentences. Same imported-row lower-bound rule (flagged with a caveat note); payments count only toward `settledCents`. Deliberately **no ECharts import** so the detail bundle stays lean; hidden when the group has no expenses at all.

### Scenarios / "What If?" Playground (ephemeral — never persisted)

Full reference: [`docs/projections-and-reconciliation.md`](docs/projections-and-reconciliation.md) §Scenarios. `runScenarioProjection` (`src/lib/actions/scenario.ts`) gathers the same inputs as `getProjection` via the shared `gatherProjectionInputs` (`src/lib/projection-inputs.ts`), applies the requested modifications (`add-income` / `add-expense` / `remove-item` / `modify-amount` — pure logic in `src/lib/scenario-utils.ts`; `modify-amount` matches recurring **and** planned items; an `add-*` mod with `isOneOff`/`scheduledDate` becomes a synthetic one-off `PlannedItem` at that month instead of a recurring item), and runs `calculateProjection` twice. The page's "Cancel an existing expense" / "Change an item's amount" templates fetch real recurring+planned items into a grouped dropdown for `remove-item`/`modify-amount`; results render a lazy ECharts comparison chart (`src/components/charts/scenario-comparison-chart.tsx`: dashed Current vs solid With-changes lines, zero markLine, a red null-gapped overlay tracing below-zero stretches — deliberately not a `visualMap`, which ECharts 6 applies unreliably to 1-D line data) plus a "Lowest point" KPI (min `endingBalance` + its month). **No stored entity, no cache tag**; synthetic items get `scenario-…` IDs. Both runs include anchoring, taxed income, overrides, the mortgage/budget transfer injections, and the `paidByCardLinkId` exclusion — so Playground absolute balances match the cashflow page. Credit-card bill lines are **recomputed from the modified item lists** for the modified run (modifying/removing a card-tagged expense flows into the bill). The transfer helpers live in `projection-inputs.ts` (a plain server module) — never export them from a `'use server'` file (every export there becomes a client-invokable endpoint taking a raw `userId`).

### Account Self-Service

Surfaced in Settings → **Account** tab (`src/components/settings/account-panel.tsx`, both display modes; actions in `src/lib/actions/account.ts`, all session-scoped — none accept a raw `userId`):

- **Change password**: `changeMyPassword` re-verifies `currentPassword` via `verifyPassword` before calling `changePassword` (`src/lib/db/users.ts`). Validated by `changePasswordSchema` (`src/lib/schemas/auth.schema.ts`) — same strength rules as sign-up.
- **Start fresh** (`resetMyData`): tears down every bank connection (best-effort EB consent revoke via the shared `teardownBankConnection` helper, `src/lib/bank/teardown.ts`), then `fs.rm`s the owned data dirs (`accounts`, `investments`, `receivables`, `debts`, `goals`, `budgets`, `trips`, `reconciliation`, `bank`) under `getUserDir(userId)`. Keeps `user.enc` + `preferences.enc`; never touches shared split groups/mortgages.
- **Delete account** (`deleteMyAccount`): gated by typing the account's own email (case-insensitive). `getAccountDeletionPreflight` / the delete action's server-side re-check share `buildDeletionPreflight`, which blocks on: a nonzero split-group balance, being the sole owner of a shared split group or mortgage that still has other members, or being the only active admin while other active users exist. With no blockers: bank teardown as above, then each shared split group/mortgage is either deleted outright (user is the sole member) or the user is removed from `members[]` (db functions in `split-groups.ts`/`shared-mortgages.ts`, mirroring `removeSplitGroupMember`/`removeMortgageMember`'s cache-tag fan-out to every co-member), then `hardDeleteUser` (index removal + recursive user-dir `fs.rm`, `src/lib/db/users.ts` — distinct from the existing `deleteUser`, which is a soft deactivate used by admin and is untouched).
- `teardownBankConnection` (`src/lib/bank/teardown.ts`) is a plain module (not `'use server'`) factoring the per-connection revoke+wipe logic shared by `disconnectBankConnection` (`bank.ts`) and the two account actions above — a raw-`userId` helper must never be exported from a `'use server'` file.

### User avatars

Optional per-user profile picture, shown wherever a person is displayed (split balance
banner/detail, settle-up dropdowns, activity-feed actors, split list cards + summary rows, Home
split widget, mortgage member cards + members dialog, admin users table + edit dialog, Settings →
Account "Profile picture" block).

- **Storage is a PLAIN, UNENCRYPTED binary** at `data/users/{id}/avatar.webp` (256×256 WebP) —
  deliberate: it enables zero-decrypt streaming + HTTP caching, and an avatar is low-sensitivity.
  It is **excluded from the JSON backup** (`data-transfer.ts` never touches it). `User.avatarVersion?: number`
  is the only encrypted-record field; `setUserAvatar(userId, Buffer | null)` (`src/lib/db/users.ts`)
  writes/removes the file and bumps the version.
- **Served by `src/app/api/avatars/[userId]/route.ts`** (the SECOND non-NextAuth API route,
  alongside the bank callback): session-gated, a `^[A-Za-z0-9-]+$` userId guard (blocks path
  traversal), `Cache-Control: private, max-age=31536000, immutable`, and a `?v={avatarVersion}`
  cache-buster from `avatarUrlFor`. Node runtime (needs `fs`). `proxy.ts` needed **no** change —
  cookie-bearing requests are already exempt and the path isn't auth-redirected.
- **Read path**: `PublicUser.avatarUrl` is computed by `toPublicUser` / `avatarUrlFor`
  (`db/users.ts`); `UserProfile { id, name, avatarUrl? }` is returned by `getUserProfiles`
  (`src/lib/actions/user-profiles.ts`) to **any** authenticated user (no email/role leaked, so it
  is safe for cross-user member displays). Client: `<UserAvatar>` (`src/components/ui/user-avatar.tsx`,
  renders the image or initials on a deterministic `getAvatarColor` hsl hash from `avatar-utils.ts`),
  the `useUserProfiles` hook (`src/lib/hooks/use-user-profiles.ts`, module cache + inflight dedup +
  `invalidateUserProfiles`), and `AvatarEditorDialog` (drop/paste/browse → EXIF-normalized ≤2048px
  source → `react-easy-crop` round crop + zoom [new lazy-loaded dependency] → 256×256 WebP q0.85,
  JPEG fallback).
- **Write path**: `updateMyAvatar` (`actions/account.ts`, self); admin `updateUser` gained an
  `avatarDataUri` field (`avatarDataUriSchema` in `src/lib/schemas/user.schema.ts`).
- **Cache invalidation is the `users` tag only** — the avatar is **never denormalized** into shared
  split/mortgage docs (those carry names only), and is **not** in the session JWT (cookie size);
  every avatar render resolves through the route + `useUserProfiles`.

### Date Handling

- **Library**: `date-fns` for all date operations
- **Format**: Year-month strings as `"YYYY-MM"` (type `YearMonth = string`)
- **Locale**: Finnish (`fi-FI`) for number formatting in `src/lib/constants.ts`

### ID Generation

- Use `uuid` package (`import { v4 as uuidv4 } from 'uuid'`) for all entity IDs

### Salary Calculation

Use `calculateNetSalary` from `src/lib/salary-utils.ts` — the single canonical implementation. Do NOT define salary calculation inline in components. Taxed (gross) incomes use `calculateTaxedIncomeNet` from `src/lib/taxed-income-utils.ts` — a deliberately separate formula (salary taxes gross + taxable benefits; taxed income taxes the raw gross), shared by the DB layer (frozen at write time) and the modal's live net preview.

### Type Definitions

All types are centralized in `src/types/index.ts`. Key types:
- `FinancialAccount`, `RecurringItem`, `PlannedItem`, `SalaryConfig`
- `InvestmentAccount`, `InvestmentContribution`
- `Debt`, `DebtReferenceRate`, `DebtExtraPayment`
- `Receivable`, `ReceivableRepayment`
- `TaxedIncome`
- `BalanceSnapshot`, `ReconciliationAdjustment`, `ReconciliationSession`
- `MonthlyProjection`, `WealthProjectionMonth`
- Request types: `Create*Request`, `Update*Request`

## Adding a New Entity Type

1. **Define types** in `src/types/index.ts` (entity + create/update request types)
2. **Create DB file** in `src/lib/db/` following the existing pattern (CRUD + file I/O)
3. **Add cached queries** in `src/lib/db/cached.ts`
4. **Create server actions** in `src/lib/actions/` with Zod validation and cache tags
5. **Create Zod schema** in `src/lib/schemas/` for form validation
6. **Add UI components** (modal form, list display) following existing patterns
7. **Update projection engine** if the entity affects financial projections

## Adding a New Page

1. Create directory under `src/app/(dashboard)/` with `page.tsx` (the group layout wraps it in `AppLayout` **and** performs the server-side `auth()` redirect — do **not** wrap or re-guard it yourself).
2. Add the page's id to the `NavigationPage` union in `src/types/index.ts`, then a nav entry in the shared **`src/components/layout/nav-config.tsx`** (`navItems`) — all four nav surfaces (sidebar, bottom-nav, drawer, and the mobile tab defaults via `src/lib/bottom-nav-prefs.ts`) read from it. Never edit one surface only. Add the id to `NAVIGATION_PAGE_IDS` in `bottom-nav-prefs.ts` too (its compile-time guard fails otherwise) so the page becomes selectable in the Settings → General → Mobile navigation picker; changing `DEFAULT_BOTTOM_NAV_IDS`/`DEFAULT_BOTTOM_NAV_IDS_SIMPLE` is a separate, deliberate call. Decide whether the page belongs in Simple mode's slimmed nav (`simpleModeVisible: true`) — hidden pages stay reachable from Home's feature grid.
3. Add command-palette entries in `src/components/ui/command-palette.tsx` (a `nav-*` command + its path in the `executeCommand` `paths` map).
4. Add the URL prefix to `PROTECTED_PREFIXES` in `src/proxy.ts` so the edge middleware redirects cookie-less visitors before the page shell loads.

**Note on the home page**: `/` is the **Home dashboard** (`src/app/page.tsx` → `HomeDashboard`, auth-guarded, wraps `AppLayout` because root is outside the `(dashboard)` group). The wealth **Overview** is a normal page at **`/overview`**. `isNavItemActive` special-cases `/` (exact match) so Home and Overview never both highlight.

## Known Limitations

- **Race conditions**: File-based storage has no atomic operations or file locking. Concurrent write requests could cause data loss. Acceptable for single-user scenarios.
- **No cross-currency conversion**: Multi-currency is supported but currencies are not converted for aggregation — values in different currencies are summed as-is. Aggregate displays use the primary account's currency with a "(mixed currencies)" note when applicable.
- **Hardcoded locale**: Number formatting uses `fi-FI` locale (Finnish) in `src/lib/constants.ts`.
- **Shared mortgage concurrency**: Shared mortgages have no file locking either; concurrent edits by two members can clobber. Acceptable for a small household.
- **Split groups**: members are **account-only** (both people need a Sampolio account — no non-account/"virtual" members). Concurrency safety relies on a **per-group in-process mutex** (`withGroupLock`), which is correct only because the app is single-node; there is still no on-disk locking. Split balances fold into the Overview net-worth KPI but are **not** injected into the cashflow projection. Imported rows keep only per-member net (payer/owed shares are inferred for display). The `guessCategory`/description-autocomplete are best-effort conveniences.
- **Split push notifications are best-effort fire-and-forget**: one POST per event to the Home Assistant webhook, with no retry, queue, or delivery log. A Home Assistant that is down, unreachable, or slower than the 5s timeout silently drops that event — the split data is unaffected and there is no way to replay it. The feature is off entirely without `HA_WEBHOOK_URL` + `AUTH_URL`.
- **Mortgage auto-amortization is a model**: with zero data entry the engine tracks the real bank balance within ~0.7% (validated in `mortgage-projection.test.ts`); recorded `MortgageActualEntry` months make it exact. Recording flows (per-month reconcile, bulk CSV import, drift adjustment) and carry-forward semantics: [`docs/mortgage.md`](docs/mortgage.md).
- **Euribor effective month**: the engine applies a rate from its `effectiveDate` month with no built-in lag — enter each rate's "effective from" month accounting for the bank's notice period (a mid-December fixing may apply to payments from ~February).
- **Wealth horizon past an account's own plan**: when the Overview horizon (e.g. 5Y) outruns a cash account's planning horizon, `wealth-projection.ts` holds the account flat at its last projected ending balance (no further flows are invented); a fully-repaid receivable contributes 0 from payoff on.
- **Data retention / growth**: reconciliation history accumulates but is never wrong (projections read only the latest snapshot per entity). Prunable from Settings → Data & storage; compaction is anchor-gated, idempotent, and never touches mortgage data — details in [`docs/projections-and-reconciliation.md`](docs/projections-and-reconciliation.md).
- **Bank sync is read-only and optional**: hard-disables without `ENABLE_BANKING_*` env vars; consent is time-boxed and must be renewed; syncs are rate-limited; a connected-but-not-yet-synced account shows its manual value; retrospective depth is bounded by the backfill, and deepening an existing connection requires **Reconnect**. Details in [`docs/bank-sync.md`](docs/bank-sync.md).
- **S-Pankki serves neither pending transactions nor purchase dates** (probe-verified 2026-07-28: empty under PDNG/HOLD/SCHD/OTHR with and without date filters while the bank's own app showed reserved amounts; booked rows carry only `booking_date`). S-Pankki card purchases therefore display their booking date (typically 1–3 days after purchase, e.g. weekend buys book Monday) and reserved amounts never appear — a bank-API limitation, not an app defect. Banks that do serve the data (Nordea, OP) get pending rows and purchase-date display.
- **Rate limiter is cookie-presence based and in-memory**: `src/proxy.ts` exempts any request bearing a session-cookie *name* from the general limiter (cookie validity is only checked server-side — the edge can't validate the JWT cheaply), and the store resets on restart. Accepted single-node tradeoff; auth itself is never bypassable this way.
- **Avatars are stored unencrypted and excluded from backups**: `data/users/{id}/avatar.webp` is a plain binary (deliberate — zero-decrypt streaming + HTTP caching for a low-sensitivity asset) and is **not** part of the JSON export/import, so a backup restore does not carry avatars over. Everything else in the user dir stays encrypted.
- **Jiggle reorder has no vertical auto-scroll**: the v1 primitive (`useJiggleReorder`) does not auto-scroll the page when a dragged item nears a viewport edge, so reordering a long list relies on ordinary page scroll (or the sr-only arrow-key entry buttons). Acceptable for the short group/bank-account lists it drives today.
- **Mortgage-engine accuracy is proven only locally**: the committed mortgage suite runs on a synthetic fixture, so a clone of this repo cannot reproduce the "within 0.7% / exact with actuals" guarantees in [`docs/mortgage.md`](docs/mortgage.md) §7 — those live in the gitignored `mortgage-projection.local.test.ts`. A contributor changing the engine gets the behavioral tests but not the real-world parity check.

## Known Bugs (Pending Fixes)

Tracked in [`docs/known-gaps.md`](docs/known-gaps.md) — verified defects and missing pieces with file:line evidence.

## Development Commands

```bash
pnpm dev          # Start dev server on port 4999 (prod owns 3999; prefer the sampolio-preview launch config, which also injects the data-copy env)
pnpm build        # Production build
pnpm lint         # Run ESLint
pnpm test         # Run tests (vitest)
pnpm test:watch   # Run tests in watch mode
pnpm test:coverage # Run tests with coverage
```

### Committed fixtures are synthetic; real-data parity tests are local-only

**Never commit real personal data to a fixture, an assertion, a test title, or a
code comment** — this repo is public. Every committed fixture uses invented
values and placeholder people (`Alex` / `Sam`, `*@example.com`). The shared
mortgage mock in `src/test/mocks.ts` is a synthetic €250k / two-loan household,
not anyone's actual loan.

Tests that must assert against the maintainer's *real* records live in
gitignored `*.local.test.ts` files beside the suite they mirror
(`src/lib/mortgage-projection.local.test.ts`, `src/lib/split-csv.local.test.ts`).
Vitest's default glob still picks them up, so `pnpm test` runs them locally while
they never ship. When you change an engine, update **both** the committed
synthetic suite and its local parity twin.

Deriving a new expectation for the synthetic mortgage fixture? Run the engine and
read the value back rather than hand-computing it — the balances, payoff month,
and per-member deposits are all downstream of the fixture's loan terms.

## Documentation Discipline

**After every implementation task, update the documentation in the same change.** Code
and docs ship together — a feature, behavior change, new constant/convention, or removed
capability is not "done" until the docs reflect it. Concretely:

- Update the **root `AGENTS.md`** (this file; `CLAUDE.md` is a symlink to it) when you
  change a convention, engine behavior, data model, or a tunable constant's meaning.
- Update the **nearest per-directory `AGENTS.md`** (e.g. `src/app/(dashboard)/cashflow/AGENTS.md`,
  `src/lib/actions/AGENTS.md`, `src/lib/db/AGENTS.md`, `src/components/AGENTS.md`) for changes
  local to that area.
- Update any **`docs/*.md`** whose factual claims your change affects.
- Keep the **"Known Limitations" / "Known Bugs"** sections honest — add, amend, or remove entries
  as the change warrants (code defects belong in `docs/known-gaps.md`).

Treat stale docs as a defect: if you touch code a doc describes and the doc is now wrong, fix it.
**Docs are current-state only** — no changelog/"previously" phrasing; describe what the code does today.

### Documentation map (`docs/`)

| Doc | Covers |
|---|---|
| [`docs/README.md`](docs/README.md) | Index of the doc set |
| [`docs/architecture.md`](docs/architecture.md) | System reference: routes, actions inventory, storage layout, caching, auth, middleware, PWA, testing state |
| [`docs/projections-and-reconciliation.md`](docs/projections-and-reconciliation.md) | Projection/retrospective/wealth engines, anchoring, overrides, transfer injection, reconciliation, compaction, scenarios |
| [`docs/bank-sync.md`](docs/bank-sync.md) | Enable Banking deep-dive: consent, sync, scheduler, card billing, storage, troubleshooting |
| [`docs/mortgage.md`](docs/mortgage.md) | Shared-mortgage deep-dive: engine math, actuals, ownership/equity, workflows |
| [`docs/features.md`](docs/features.md) | Split, Budgets, Goals, Trips (per diem), Home/Overview dashboards, onboarding, command palette |
| [`docs/operations.md`](docs/operations.md) | Prod infrastructure, deploy, backups, encryption maintenance, env-var reference |
| [`docs/known-gaps.md`](docs/known-gaps.md) | Verified defects, stale comments, convention drift, missing pieces |
| [`docs/improvements.md`](docs/improvements.md) | Evidence-backed UI/UX/perf/integration improvement backlog |

## Versioning

`package.json` `version` is the app version shown in Settings → About (read by
`src/lib/actions/app-info.ts`). **At the end of every AI implementation session that
changes code, bump the version in the same change**, sized by the session's impact:

- **patch** — small fixes, tweaks, copy/UI polish
- **minor** — a new feature, page, or noticeable behavior change
- **major** — large reworks, data-model or storage-format changes

Docs-only or config-only sessions don't bump. One bump per session, not per commit.

## Git Workflow

This is a **single-maintainer personal app — do not open pull requests.** When asked
to commit/push, commit **directly to `main`** and push it (no feature branch, no PR).
Deploys come straight from the working tree, independent of git. (This overrides any
default "branch first / open a PR" assistant behavior.)

## Testing With a Copy of Production Data

A self-hosted instance keeps its data in its own directory (`$SAMPOLIO_DATA_DIR`, conventionally
`~/.sampolio/data`). **Never edit, move, or write back to the live data directory** — it is the
irreplaceable copy. To exercise the app against real data, work on a **copy** inside the repo at
`./data` (the whole `/data` dir is gitignored, so the copy and its secrets are never committed):

```bash
# One-time: copy live data (incl. the dot-file secrets) into the repo. Trailing
# slashes + -a preserve hidden files. NEVER run this the other direction.
rsync -a ~/.sampolio/data/ ./data/
```

The data directory carries its own secrets as dot-files (the app reads them from the environment, not from disk, so they must be injected):
- `data/.encryption_key` — `ENCRYPTION_KEY` (AES-256-GCM key; decrypts every `.enc` file)
- `data/.auth_secret` — `AUTH_SECRET` (NextAuth)
- `data/.auth_url` — the prod `AUTH_URL` (use `http://localhost:4999` locally instead)
- `data/.dev_user` — the email `DEV_AUTH_BYPASS` signs in as. Create it yourself
  (`echo you@example.com > data/.dev_user`); it lives under the gitignored `/data`
  so no real account ever reaches the repo. Absent ⇒ the bypass is simply off.

**Port 3999 is reserved for a running production instance**: a self-hosted deployment runs `next start -p 3999` against the live data directory, so the dev preview uses **port 4999** and must never point at the production port or data. When prod and dev share one clone they must **not** share the Next.js build dir: prod sets `NEXT_DIST_DIR=.next-prod` while the dev preview leaves it unset (→ `.next`), so `next dev` can't clobber the build `next start` serves (`distDir` in `next.config.ts`). The dev preview writing `.next/` therefore never endangers prod.

**Run the dev server on the copy** via the `sampolio-preview` config in `.claude/launch.json`, which exports those env vars from the dot-files, points `DATA_DIR` at `./data`, and enables the dev auth bypass:

```jsonc
// .claude/launch.json → runtimeArgs (sh -c):
export ENCRYPTION_KEY=$(cat data/.encryption_key);
export AUTH_SECRET=$(cat data/.auth_secret);
export AUTH_URL=http://localhost:4999;
export DATA_DIR=$PWD/data;
export DEV_AUTH_BYPASS=$(cat data/.dev_user 2>/dev/null);   // dev-only sign-in bypass
exec ./node_modules/.bin/next dev -p 4999
```

- **`DEV_AUTH_BYPASS`** + visiting **`/dev-login`** signs you in as that user with no password (dev only). It comes from the gitignored `data/.dev_user`, so the real address stays out of the repo. The account must already exist in the data — for an empty `./data` you'd have to create one first.
- Verify in the browser with the `preview_*` tools (`preview_start sampolio-preview`, then `preview_eval`/`preview_screenshot`). The preview page can drift back to `/` between calls — re-navigate inside a single eval and rely on screenshots as the source of truth.
- To re-seed mortgage actuals from a reference spreadsheet, export it to `actuals.csv` and re-import via the "Import actual history" dialog with *Replace all* checked.

**Deploying to prod**: rebuild into `.next-prod` (`NEXT_DIST_DIR=.next-prod pnpm build`) and restart the service, gating the restart on `pnpm lint` and `pnpm test` and on a data snapshot taken first. Never restart prod if any gate fails. Deployment is environment-specific and lives outside this repo.
