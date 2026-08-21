# Overview Page (`/overview`)

The **wealth dashboard**. It is a normal page at `/overview` — the root `/` is the separate Home dashboard (`src/app/page.tsx` → `HomeDashboard`), which does not redirect here.

## Key File

`page.tsx` — Client component (`'use client'`) that fetches all data via server actions, then renders the KPI/chart components.

## Features

### KPI Tiles (grouped)
Shared `KpiTile` components (`src/components/ui/kpi-tile.tsx` — zero-delta change
badges render as muted "unchanged", never "+€0,00") organized into three `KpiGroup`
sections (`src/components/overview/kpi-group.tsx`): **Net** (Net Worth, Liquid
Assets), **Assets** (Cash, Investments, Receivables, Home equity, positive Split
balance), **Debts & liabilities** (Debts, Credit cards, Mortgage share, negative
Split balance). The grid is 2-col on mobile / 3-col on `lg`. In **Simple mode** only
Net Worth + Cash render, with a "See all balances" expander revealing the full
groups. Tile semantics:
- **Net Worth**: Sum of all assets minus liabilities (includes mortgage equity and **folds in credit-card liabilities**)
- **Liquid Assets**: Cash + investments
- **Cash**: Total across all cash accounts — uses each account's **current bank-synced balance** when available (`cashCurrentBalances`), falling back to the manual/anchored value
- **Investments**: Total investment valuations
- **Receivables**: Money owed to the user
- **Debts**: Outstanding liabilities (shown as negative)
- **Credit cards**: Total outstanding across synced credit cards (shown as negative; from `getCardLiabilities`), with an "available of limit" subline + utilization bar when the bank exposes limits. The bar's fill still tracks utilization, but its color reads health rather than the tile's own (liability) severity: green below 50%, yellow 50–80%, red at/above 80%, via `KpiTile`'s `progressSeverity` prop (independent of `severity`, which stays `"danger"` for the icon/value). Never also enter a card as a Debt.

The reminder banners all render through `BannerStack` (`src/components/overview/banner-stack.tsx`, built on the shared `AlertBanner`); the header "Monthly check-in" button hides while the check-in banner shows (`isCheckInBannerVisible`) so the banner is the single entry point.

Clicking a KPI card opens the **EntityListDrawer** (`src/components/ui/entity-list-drawer.tsx`) for Cash/Investments/Receivables/Debts — showing all entities of that type with create/edit/archive actions. The Net Worth tile instead opens the plain-words **NetWorthExplainDialog** (`src/components/overview/net-worth-explain-dialog.tsx`), and the Mortgage share / Credit cards / Split balance tiles navigate to their owning pages (`/mortgage`, `/bank`, `/split`).

### Wealth Distribution Bar ("Where your wealth sits")
`WealthDistribution` (`src/components/overview/wealth-distribution.tsx`) — a slim CSS
segmented bar + legend showing how the **current** asset total splits across Cash,
Investments, Receivables, Home equity and a positive Split balance. Rendered directly
below the KPI tiles in **both display modes** (deliberately outside the chart grid,
which Simple mode hides). A dumb display component: it takes the page's `kpiValues`
(already in the display currency), `displayCurrency`, `isMixedCurrency` and `isSimple` —
nothing is fetched or converted.

- Categories with a value ≤ €0.005 are dropped; the card renders `null` only when **no**
  asset is positive. A single positive category still renders (a 100% bar is a real
  answer, and hiding it would make the card appear only once a second asset exists).
- Colors come from the shared `WEALTH_COLORS` map in `charts/wealth-chart.tsx` (via
  `rgb(key)`), so a category reads the same here as in the breakdown chart; the split
  category uses the `split` indigo entry, added there for this card.
- Not a canvas chart, so it deliberately has **no** `ChartExplain` integration — the bar
  is `role="img"` with a generated `aria-label` ("Wealth distribution: Cash 60%,
  Investments 40%."), and the legend + footer carry the same information as text. Tiny
  non-zero segments keep a `0.375rem` minimum width so they stay visible.
- Title/labels via `plainTerm`/`helpText` (`wealthMix`, plus `receivables`,
  `homeEquity`, `investments`, `splitBalance`), with a `HelpHint` next to the title and
  the page's "(mixed currencies)" note when accounts span currencies.
- Footer sentence (only when something is owed): "After €X of debts and credit cards,
  your net worth is €Y." An **owed** split balance counts there, never as a segment;
  mortgage liability is deliberately excluded because `mortgageEquity` is already net of
  the loan share — so assets − footer total ≡ the Net Worth KPI.

Tested in `src/components/overview/wealth-distribution.test.tsx` (jsdom).

### Net Worth Projection Chart
Chart.js line/area chart (`src/components/charts/net-worth-chart.tsx`, via `primereact/chart`) showing projected net worth over time:
- A **Total assets / Liquid** scope toggle (`wealthScope`, default `total`), plus a toggle between "Net Worth Only" and "Breakdown"
- Breakdown mode renders **stacked bands** (`WealthChart`, `src/components/charts/wealth-chart.tsx`): total scope = Cash, Investments, Receivables, Home value / Debts, Credit cards, Mortgage; liquid scope = Cash, Investments, Debts, Credit cards — plus a Net worth line overlay; all-zero series are omitted. Chart.js's own legend is the chart's only legend.
- Time horizon selector: 6M, 1Y, 3Y, 5Y
- Displays projected net worth at horizon end with absolute and percentage change; the tooltip enumerates every in-scope non-zero category

### Plan Check Card ("Plan vs reality")
`PlanCheckCard` (`src/components/overview/forecast-vs-actual-card.tsx`) — purely presentational; the page passes the primary active account's `{ monthly, retrospective }` from its existing `getProjection` calls (no second fetch). Two views behind a segmented month toggle, default chosen by `pickDefaultView` (this-month when actualized and the month is under way, else last closed month):

- **Last month (deviation)**: `comparePlanToActual` (`src/lib/forecast-vs-actual.ts`, pure/tested) joins the **recurring** part of the current plan (`source === 'recurring' | 'planned-repeating'` only — one-offs would flood the list with fake "under plan" rows; injected card/mortgage/budget lines excluded) against the last retrospective month's actuals, recategorized from merchant names via `guessItemCategory`. Card-settlement actual lines (`source === 'credit-card'`) are dropped symmetrically — card-tagged plan items never appear in the cash breakdown either. Top-4 off-plan rows with worded verdicts ("€X more/less than planned", red/green), a bullet bar (actual fill + plan tick), and a `.collapse-grid` expander listing the actual merchant lines. Footers: on-plan count and an unmatched-spend total (≥ €20). `status: 'on'` inside `onPlanTolerance` = max(€5, 3% of planned).
- **This month (progress)**: `summarizeMonthProgress` over the actualized `monthly[0]` lines — top-5 categories by planned, neutral "€X of €Y" (progress, never judged), expanders mirror `month-details-panel` (paid tag / "€X left" tag / line-through).

Copy via `plainTerm`/`helpText` (`planCheck`, `overPlan`/`underPlan`/`onPlan`, `lastMonthBaseline`, `paidOfPlanned`). Returns `null` only when there's neither a retrospective nor an actualized month (manual accounts); otherwise empty views render an `EmptyState`. It is the sole card in the chart grid's right column, with a full-width text "View month details" button → `/cashflow` beneath it.

### Quick Action Buttons
Floating action buttons for common operations:
- Add Income, Add Expense — opens `CashflowItemModal`
- Add Receivable — opens receivable form in drawer
- Add Debt — opens debt form in drawer

### Last Reconciled Date
Shows when data was last reconciled. Clicking opens the reconciliation wizard.

### Shared Mortgage Summary & Euribor Reminder
If the user is a member of a shared mortgage, the page computes their current-month equity/liability/stake (via the mortgage engine) and folds equity into net worth. It also surfaces a **reminder banner** when a mortgage's yearly Euribor rate is due for an update (`isEuriborUpdateDue` from `src/lib/mortgage-utils.ts`).

### Bank Consent Renewal Banner
When a bank connection's consent is approaching expiry (`getBankConnectionsNeedingAttention`), a **reminder banner** appears prompting reconnection; it deep-links to `/settings?tab=banking`.

## Data Flow

1. The page fetches (parallel server-action calls): accounts, investments, debts, receivables, budgets, shared mortgage(s), wealth projection, credit-card liabilities + current bank balances
2. Data passed to client components for rendering
3. User interactions (create/edit) happen via modals/drawers that call server actions
4. After mutations, `refreshData()` from AppContext triggers re-fetch

## Dependencies

- `src/lib/actions/investments.ts` — Investment data
- `src/lib/actions/debts.ts` — Debt data
- `src/lib/actions/receivables.ts` — Receivable data
- `src/lib/actions/accounts.ts` — Cash account data
- `src/lib/actions/shared-mortgages.ts` — Shared mortgage data + projection inputs
- `src/lib/wealth-projection.ts` — Wealth projection calculation (folds in mortgage equity)
- `src/lib/mortgage-projection.ts` / `src/lib/mortgage-utils.ts` — Mortgage engine + Euribor-due check
- `src/components/charts/net-worth-chart.tsx` / `wealth-chart.tsx` — Main chart + shared scoped stacked-band/color helpers
- `src/components/ui/entity-list-drawer.tsx` — Entity list panel
