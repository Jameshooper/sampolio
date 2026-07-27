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
- **Credit cards**: Total outstanding across synced credit cards (shown as negative; from `getCardLiabilities`), with an "available of limit" subline + utilization bar when the bank exposes limits. Never also enter a card as a Debt.

The reminder banners all render through `BannerStack` (`src/components/overview/banner-stack.tsx`, built on the shared `AlertBanner`); the header "Monthly check-in" button hides while the check-in banner shows (`isCheckInBannerVisible`) so the banner is the single entry point.

Clicking a KPI card opens the **EntityListDrawer** (`src/components/ui/entity-list-drawer.tsx`) for Cash/Investments/Receivables/Debts — showing all entities of that type with create/edit/archive actions. The Net Worth tile instead opens the plain-words **NetWorthExplainDialog** (`src/components/overview/net-worth-explain-dialog.tsx`), and the Mortgage share / Credit cards / Split balance tiles navigate to their owning pages (`/mortgage`, `/bank`, `/split`).

### Net Worth Projection Chart
Chart.js line/area chart (`src/components/charts/net-worth-chart.tsx`, via `primereact/chart`) showing projected net worth over time:
- A **Total assets / Liquid** scope toggle (`wealthScope`, default `total`), plus a toggle between "Net Worth Only" and "Breakdown"
- Breakdown mode renders **stacked bands** (`WealthChart`, `src/components/charts/wealth-chart.tsx`): total scope = Cash, Investments, Receivables, Home value / Debts, Credit cards, Mortgage; liquid scope = Cash, Investments, Debts, Credit cards — plus a Net worth line overlay; all-zero series are omitted. Chart.js's own legend is the chart's only legend.
- Time horizon selector: 6M, 1Y, 3Y, 5Y
- Displays projected net worth at horizon end with absolute and percentage change; the tooltip enumerates every in-scope non-zero category

### This Month Impact Panel
Shows top income and expense items affecting the current month, with amounts and categories. Each account's "balance" line uses the same current balance as the Cash KPI (bank-synced value when available via `cashCurrentBalances`, else the manual starting value) — never the raw `startingBalance` when a synced bank balance exists.

### Plan vs Reality Card
`ForecastVsActualCard` (`src/components/overview/forecast-vs-actual-card.tsx`) — rendered beside the This Month Impact panel when the selected account has bank-actual retrospective data. Compares the current month's forecast expense breakdown against the last closed retrospective month's actuals (pure join in `src/lib/forecast-vs-actual.ts`), showing the top category deviations as paired plan/actual bars. Hidden entirely when there's no synced bank account (no retrospective data).

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
