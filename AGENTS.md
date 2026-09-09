# Sampolio — AI Agent Instructions

This is a self-hosted personal-finance app: Next.js 16 App Router, TypeScript
strict, PrimeReact, Tailwind v4, NextAuth v5, Zod/RHF, ECharts/Chart.js, and
`date-fns`. Use `pnpm`. The app stores encrypted JSON files; Enable Banking is
optional, read-only, and documented in [`docs/bank-sync.md`](docs/bank-sync.md).

## Working rules

- Treat the repository as public. Never commit real household data, secrets,
  tokens, identifying names, or production fixtures. Synthetic tests use Alex,
  Sam, and `*@example.com`; real-data parity tests belong in gitignored
  `*.local.test.ts` files.
- Preserve the existing operational choices: file storage, LAN/prod topology,
  pinned Node runtime, and the preview/prod data boundary. Do not invent
  equipment, schedules, active state, or credentials.
- Use `date-fns`, `uuid.v4`, Finnish `fi-FI` formatting, and types centralized
  in `src/types/index.ts`. Use `formatCurrency`/`formatCents` for displayed
  money and `calculateNetSalary` / `calculateTaxedIncomeNet` for income math.
- All mutations need authentication, Zod validation, the DB layer, the correct
  `updateTag`, an `ApiResponse<T>`, and a global success/error toast. Use the
  one global `ConfirmDialog`; never mount another. Server actions are the
  backend boundary; the only API routes are NextAuth, the bank callback, and
  the session-gated avatar route.
- File DB writes are read-modify-write and have no cross-process locking.
  Shared mortgages and split groups are action-layer access-controlled because
  their files live under `data/shared/`; split writes use the single-node group
  mutex. Keep those limits visible in [`docs/known-gaps.md`](docs/known-gaps.md).

## Where to look

Read the nearest nested `AGENTS.md` for `src/app/**`, `src/components`,
`src/lib/actions`, or `src/lib/db`. Long-form mechanics live here:

- [`docs/architecture.md`](docs/architecture.md): routes, actions, storage,
  encryption, cache tags, auth, middleware, PWA, testing, and tooling.
- [`docs/projections-and-reconciliation.md`](docs/projections-and-reconciliation.md):
  projection, anchoring, actuals, wealth, reconciliation, compaction, scenarios.
- [`docs/mortgage.md`](docs/mortgage.md): shared mortgage data, math, actuals,
  ownership, and workflows.
- [`docs/features.md`](docs/features.md): Split, Budgets, Goals, Trips,
  dashboards, onboarding, and command palette.
- [`docs/operations.md`](docs/operations.md): launchd/Caddy, deploy, backups,
  encryption maintenance, environment, and production-copy workflow.
- [`docs/bank-sync.md`](docs/bank-sync.md): all Enable Banking details.
- [`docs/known-gaps.md`](docs/known-gaps.md) and
  [`docs/improvements.md`](docs/improvements.md): verified gaps and backlog.

Docs are current-state references. Anchor factual claims to a file and symbol,
avoid changelog language, and give each fact one authoritative home.

## Architecture conventions

Server actions in `src/lib/actions/` follow authenticate → Zod parse → DB
operation → cache invalidation → `ApiResponse<T>`. Read actions use cached DB
wrappers where appropriate. Use tags such as
`user:{userId}:accounts`, `user:{userId}:account:{accountId}:recurring`,
`user:{userId}:debts`, `user:{userId}:investments`, `user:{userId}:reconciliation`,
`user:{userId}:bank-connections`, `users`, `app-settings`, and `all-data`; the
full inventory is in `src/lib/actions/AGENTS.md` and `docs/architecture.md`.

DB files use `getDataDir`, `getUserDir`, `ensureDir`, encrypted per-entity files,
and read-modify-write CRUD. Encryption is AES-256-GCM with HKDF-SHA256 for new
writes and a PBKDF2 compatibility read fallback. Use the migration and rotation
scripts only as documented in [`docs/operations.md`](docs/operations.md).

The UI uses PrimeReact plus Tailwind and AppContext from
`src/components/layout/app-layout.tsx`; do not add Redux/Zustand. Use the
shared `ToastProvider`, `AlertBanner`, `KpiTile`, `HelpHint`, `EmptyState`,
delayed loading/skeletons, and lazy heavy charts. Every canvas chart uses
`ChartExplain` plus a tested description in `src/lib/chart-descriptions.ts`.
Use `CATEGORY_COLORS`/`getCategoryColor`, `plainTerm`/`helpText`, and shared
hooks/utilities instead of local copies.

Every new UI must work at roughly 390 px and 1280 px with no horizontal
overflow. Tailwind `lg` (1024 px) separates mobile and desktop chrome; use CSS
visibility for hydration-safe layout. Keep tap targets at least 44 px, charts
fluid, tables responsive/frozen as appropriate, and dialogs safe-area aware.
The PWA shell, service worker, theme assets, and `CACHE_VERSION` rules are in
`docs/architecture.md`; preserve them.

Motion is CSS-first and feedback-only: use `--motion-fast/base/slow`, shared
entrance/press/collapse primitives, and `useReducedMotion`. Never add
`transition: all`, long/list-stagger animations, input press effects, or filled
entrance animations. The sanctioned celebration and jiggle exceptions are
documented in `docs/architecture.md` §17.

Simple mode collapses detail without removing access. It is resolved by
`AppLayout`, uses `plainTerm`, and controls nav through `nav-config.tsx` and
`bottom-nav-prefs.ts`; Home's feature grid and the command palette remain full.
Demo mode is device-local UI masking: it masks display formatting only, never
inputs or exports. Formatters use the `globalThis` flag; money-bearing memoized
widgets and ECharts options follow the remount/dependency rules in
`docs/features.md` §10.

## Adding things

For a new entity: define types, DB file, cached reads, server actions and Zod
schema, UI, tests, and projection integration when needed. For a new page:
create it under `src/app/(dashboard)/`; add the type, shared `navItems`,
`NAVIGATION_PAGE_IDS`, command-palette command/path, and `PROTECTED_PREFIXES`.
The dashboard group already wraps/authenticates pages; `/` is Home and
`/overview` is the wealth page. Keep all four nav surfaces in sync.

## Projection and feature invariants

`calculateProjection` is the sole cashflow engine; full rules are in
[`docs/projections-and-reconciliation.md`](docs/projections-and-reconciliation.md).
Taxed income projects at frozen `netAmount`; snapshots are last-write-wins per
entity/month; occurrence overrides replace that occurrence; card-paid expenses
enter the card bill once; injected mortgage/budget/card/goal/trip lines are
read-only. Scenarios reuse the same gathered inputs and are never persisted.

Shared mortgage, Budgets, Goals, Trips, Split, avatars, and self-service have
their authoritative references in `docs/features.md`, `docs/mortgage.md`, and
the nested action/component/DB guides. Do not duplicate their mechanics here.

## Safety, testing, and operations

Known limitations include file-write races, no cross-currency conversion,
Finnish locale, bounded bank retrospective depth, bank-specific transaction
gaps, in-memory cookie-based rate limiting, plaintext avatar files excluded
from JSON backups, and local-only real-data parity. Keep the root limitations
and [`docs/known-gaps.md`](docs/known-gaps.md) honest.

Commands: `pnpm dev` (preview port 4999), `pnpm build`, `pnpm lint`,
`pnpm test`, `pnpm test:watch`, `pnpm test:coverage`. Source the preview
environment from its configured dot-files; never point development at the
production port 3999 or live data. To test real records, copy the live data
one way into the gitignored repo `./data`, inject its secrets through the
preview configuration, and never write back. Run lint and tests before a
deploy; deployment is only performed on an explicit deploy request.

## Documentation discipline

After a substantial implementation, update the relevant root, nearest nested,
and topical docs in the same change. Edit the root `AGENTS.md` directly;
`CLAUDE.md` and `.github/copilot-instructions.md` are compatibility symlinks.
Do not edit historical docs. Validate links, current-state claims, and size
limits before handoff. Claude-specific preview commands have a tool-neutral
equivalent: use the configured preview launcher or run the same Next dev
command with the copied `./data` environment, then inspect the app in any
available browser/UI automation and assert the viewport has no overflow.

For code sessions, bump `package.json` `version` once: patch for fixes/polish,
minor for a feature or noticeable behavior change, major for a data-model or
storage-format change. Docs-only or config-only sessions do not bump it. This single-maintainer
repo commits directly to `main`; do not open PRs unless explicitly requested.

`.agents/skills` is the canonical skill location for both agents; keep
compatibility aliases intact. Read a selected `SKILL.md` fully before acting.
