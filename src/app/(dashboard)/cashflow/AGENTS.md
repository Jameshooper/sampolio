# Cashflow Page (`/cashflow`)

Monthly cash flow management page — the core feature for tracking income and expenses per cash account.

## Key Files

- `page.tsx` — orchestration: data fetching, `flowData` assembly, edit routing, dialogs, layout.
- `src/components/cashflow/cashflow-header.tsx` — the sticky header (title, account selector, action buttons, month strip). **On mobile it collapses on scroll** (hysteresis: collapse past ~140px, expand under ~24px) to a slim bar with a compact month strip + an account chip; desktop (`lg+`) never collapses.
- `src/components/cashflow/month-strip.tsx` — the month strip (`compact` prop = collapsed variant without the year row).
- `src/components/cashflow/month-details-panel.tsx` — selected-month breakdown + `SortToggle`.
- `src/components/cashflow/projection-table.tsx` — desktop DataTable + labeled mobile card list (in/out/net captions); in Simple mode trims the forecast tail to ~12 months behind a "Show all months" toggle. The DataTable remounts on `key={demoMasked ? 'masked' : 'plain'}` so demo-mode money masking re-runs its cell formatters (PrimeReact memoizes cell output; see `docs/features.md` §10).
- `src/lib/hooks/use-month-selection.ts` — the **single** month-selection mechanism: strip, table rows, and mobile cards all read/write `selectedMonth` through this hook (also derives `months`, `selectedProjection`, `nowMonth`).

## Features

### Account Selector
Dropdown in the page header to switch between cash accounts. Only shows active (non-archived) accounts. Renders a wallet icon + the account's **current balance** ("Everyday · €1 234") via `valueTemplate`/`itemTemplate` so it reads as an account picker. Selected account is stored in AppContext.

### Month Strip Navigation
Horizontal scrollable strip of months from the account's start date through its planning horizon. Clicking a month selects it and scrolls to show details. The current month is highlighted (blue); **retrospective "actual" months** (real bank data, before the anchor) render with a distinct purple/dashed style + a history icon (see "Retrospective" below).

### Retrospective (bank-actual past months)
When the selected cash account is linked to a synced bank account, `getProjection` also returns `retrospective: MonthlyProjection[]` — up to 24 months **before** the forecast anchor, reconstructed **purely from real booked bank transactions** (no Sampolio forecast items). The page merges them as `displayMonths = [...retrospective, ...projection]` and feeds that to the strip, table, mobile cards, waterfall chart, and selected-month lookup.
- Each retrospective month has `isActual: true`; its line items have `source: 'bank-actual'`, grouped by merchant/counterparty.
- Balances chain backward from the anchor, so the newest actual month flows continuously into the forecast's first month; the waterfall draws a **"Now"** boundary marker.
- Actual months/line items are **read-only**: clicking a line deep-links to `/bank`; Add Income/Add Expense are disabled while an actual month is selected.
- Depth is bounded by available synced data (contiguous run only) and `RETROSPECTIVE_MONTHS_BACK` (24) — **not** by the account's Sampolio start date, so it can show months from well before the account was created here. The `BACKFILL_DAYS` window is the practical limiter; see `docs/projections-and-reconciliation.md` and `docs/bank-sync.md`. Empty for accounts with no linked bank account → page behaves exactly as before.

### Month Summary Banner
Shows for the selected month: total income, total expenses, and net change (income - expenses). When the selected month is **actualized** (`selectedProjection.isActualized`, i.e. it's a bank-linked account's current calendar month — see "Current-month actualization" below), the tile labels switch to "Income left" / "Expenses left" / "Net left" (advanced mode) or stay "Money in" / "Money out" / "Left over" (simple mode, where a plain sentence covers the same idea), each with an "of {planned} planned" subline, and an `"adjusted for what's already happened"` tag appears next to the banner. A caption under the Monthly Flow chart notes that some items are already paid for that month.

### Current-month actualization
For a bank-linked account, the current calendar month's row comes back from `getProjection` with `isActualized: true`: the anchor balance is the live synced balance, so the engine reconciles that month's forecast lines against booked bank transactions and reports only the still-outstanding remainder (see `docs/projections-and-reconciliation.md` §7). UI surfaces:
- **`month-details-panel.tsx`**: the balance-flow header reads "Balance today" → a "Still ahead" pill → "Projected end of month" (plain-language via `plainTerm('balanceToday'|'stillAhead', isSimple)`, `src/lib/plain-language.ts`) instead of "Starting" → "Ending". Matched line items (`item.isPaid`) get a green "Paid" tag and their planned `amount` renders struck-through; gap-reduced unmatched lines get an info tag showing `"{remainingAmount} left"`. Items flagged `isFixedAmount` (the item modal's "Fixed amount" checkbox, expense-only under "More options") never show the partial "left" tag — they are `'exact-only'`: either exact-matched Paid or the full amount stands.
- **`projection-table.tsx`**: an actualized row gets an "in progress" tag next to its month label, on both the desktop DataTable and the mobile card list.
- **Home dashboard**'s explain-the-number dialog switches to "right now" / "still left to come" wording when the underlying month is actualized.

### Charts

All three charts below are **ECharts-based and lazy-loaded** via `next/dynamic({ ssr: false })` in `page.tsx` (each with a short placeholder), so the heavy ECharts bundle stays out of the cashflow page's initial JS. While the page's data loads it renders `ChartsPageSkeleton` (instant-shell pattern) rather than a full-page spinner.

All three also carry the **"Explain this chart"** system (shared guidance in `src/components/AGENTS.md`): an Explain button, "how to read" cue rows, a generated plain-words description (from `src/lib/chart-descriptions.ts`), and — uniquely to this trio — a step **tour** (`useChartTour`/`ChartTourBar`) whose steps highlight live chart elements via ECharts `dispatchAction`. The tour steps live inside each chart file next to the option builders they reference.

**Monthly Flow Chart** (Sankey diagram):
- `src/components/charts/monthly-flow-chart.tsx`
- Visualizes income sources flowing through the budget to expense categories
- Uses **gross** amounts for both salary and taxed income (taxes/contributions/deductions as orange outflow nodes that click through to the owning config/item), while the Selected Month banner shows **net** — a caption under the card header states this explicitly so the two "Income" figures don't read as a bug. `page.tsx` synthesizes the taxed-income flows (`Gross: {name}` inflow + Tax/Contributions/Other-deduction outflows, `linkedEntityId` = the taxed income's id) from the `taxedIncomes` array `getProjection` returns, mirroring the salary synthesis; the chart's deduction split generalizes over both via `isGrossSource` (`'salary' | 'taxed-income'`) in `monthly-flow-chart.tsx`
- Clickable nodes — clicking an item opens its edit modal
- A linked credit-card bill becomes its own amber "Card: X" node (via the `cardBreakdowns` prop, fetched with `getCardStatementBreakdownForAccount`); it drills down to the individual card transactions as leaf nodes. This works on **retrospective months too**: the retro engine collapses a matched cash-side bill-payment debit into a `source: 'credit-card'` line keyed by the card link id, and the breakdown action's past-month fallback reconstructs the settled cycle (see `docs/bank-sync.md`)
- **Actualized month balancing**: item flows keep their **planned** amounts while the Savings/Deficit flow uses the adjusted `netChange`, so the page passes `MonthFlowData.alreadySettledNet` (`netChange − planned net`) and the chart adds a slate balancing flow — an "Already Paid" source into Budget when positive (expenses already settled out of today's balance) or a Budget → "Already Received" outflow when negative (income already banked). Without it the Budget node's outflows exceed its inflows and the widths lie

**Cashflow Waterfall Chart**:
- `src/components/charts/cashflow-waterfall-chart.tsx`
- Shows balance progression month-by-month as a waterfall
- Each bar shows the net change, building on the previous month's ending balance
- **Defaults its visible window to "now + next ~12 months"** (the first forecast month at the left edge) via the dataZoom `start`/`end`; the slider + inside-drag let the user pan back to the retrospective or out to the far future. A "Now" markLine sits at the actual→forecast boundary; retrospective bars are desaturated.

**Expense Treemap Chart**:
- `src/components/charts/expense-treemap-chart.tsx`
- Proportional visualization of expenses by category and individual items

### Month Details Panel
Breakdown of all income and expense items for the selected month:
- Sort by name or amount
- Click items to edit
- Tags for "edited" (overridden) items and categories
- Balance flow: Starting Balance → Net Change → Ending Balance

### Projection Data Table
Full monthly data table with columns: Month, Income, Expenses, Net Change, Balance. Both the desktop table (`scrollable`) and the mobile card list **auto-scroll to the current month on load** (a `requestAnimationFrame` effect keyed on account/month-count finds the `.cf-now-row` / `.cf-now-card` and offsets past the sticky header), so the default view starts at "now" with the retrospective reachable by scrolling up. `nowMonth` = the first forecast month (the anchor).

### Edit Workflows

**Edit Choice Dialog**: When clicking a recurring item, asks whether to edit:
- "This occurrence only" — creates an occurrence override (PlannedItem with `isRecurringOverride: true`)
- "Entire series" — edits the RecurringItem itself

**Occurrence Override Dialog** (`src/components/ui/occurrence-override-dialog.tsx`):
- Allows changing the amount for a single month
- Option to skip the occurrence entirely (`skipOccurrence: true`)

**CashflowItemModal** (`src/components/modals/cashflow-item-modal.tsx`):
- Unified modal for creating/editing income and expenses — **React Hook Form + `zodResolver(cashflowItemSchema)`** (`src/lib/schemas/cashflow-item.schema.ts`: one flat superset schema with a `recurrence` discriminator; `superRefine` enforces the per-variant required fields so RHF keeps a single object across recurrence switches)
- Supports four recurrence types: Recurring, One-off, Salary, and **Gross income** (taxed income; income-only)
- For Salary: shows gross salary, benefits, tax rate, contributions, deductions with live net calculation
- For Gross income: gross amount, one-time or recurring schedule (yearly default frequency), a **"Use my salary's tax settings"** toggle (default on when an active salary config exists; disabled otherwise) vs custom rates, a live net preview via `calculateTaxedIncomeNet` (`src/lib/taxed-income-utils.ts`), and **skip-occurrence chips** (the next ~3 occurrence months via `getUpcomingTaxedIncomeOccurrences` — tap to skip a year, stored as `skippedOccurrences` on the entity). Saving a salary config cascade-recomputes salary-linked taxed incomes server-side (see `docs/projections-and-reconciliation.md`)
- **List view is two sections** (the recurrence filter row is gone; the Income/Expense filter remains): "Regular items" — three summary cards (≈Monthly income / ≈Monthly expenses / ≈Net per month over ACTIVE items' monthly equivalents: quarterly ÷3, yearly ÷12) plus a sortable "≈ / month" DataTable column — and "One-time items" — a compact "Upcoming: +X / −Y" strip (scheduled month ≥ current) + a month-sorted table
- Clicking a `source: 'taxed-income'` projection line routes to entityType `'taxed-income'` (its own mapping in `entity-modal-router.tsx` → this modal with recurrence `'taxed-income'`), never to `'salary'`

## Data Flow

1. Page fetches projection data via `getProjection(accountId)` server action (returns `monthly` forecast + `retrospective` bank-actual past months + `salaryConfigs`/`taxedIncomes` for the Sankey's gross→deductions synthesis)
2. Projection engine (`src/lib/projection.ts`) calculates monthly balances; `src/lib/retrospective.ts` reconstructs the past months from bank transactions
3. Results displayed as charts and tables (`displayMonths = [...retrospective, ...monthly]`)
4. Edits go through server actions → file writes → cache invalidation → refresh

### Injected read-only lines
When the account is linked to a shared mortgage, a confirmed budget, a synced credit card, a cashflow-injecting spend goal, or an unreimbursed trip, `getProjection` injects **read-only** lines into the projection:
- a `mortgage-payment` line (this member's share of the bank charge),
- up to two aggregated `budget` lines per month,
- `credit-card` bill lines — real statement bills (from synced transactions) plus forecast bills for future cycles,
- a `goal` expense line — a spend goal's target amount at its target month (only goals passing `goalInjectsIntoCashflow`, `src/lib/goal-utils.ts`), and/or
- a `trip` income line — a trip's expected tax-free per-diem reimbursement at its reimbursement month.

They are not stored cashflow items — clicking them deep-links to `/mortgage`, `/budgets/{id}`, `/bank`, `/goals`, or `/budgets#trips`, where the underlying data is edited. An expense tagged **"paid by card"** (`paidByCardLinkId`) is excluded from direct cash here and instead rolled into its card's bill, so it isn't double-counted (see `docs/bank-sync.md` and `docs/projections-and-reconciliation.md`). The card dropdown in `CashflowItemModal` is populated by `getCreditCardOptions`.

## Key Types

- `MonthlyProjection` — Monthly income/expense breakdown with balances (`isActual: true` marks a bank-actual retrospective month; `isActualized: true` marks the current-month-actuals row for a bank-linked account, with `totalIncome`/`totalExpenses` holding REMAINING amounts and `plannedTotalIncome`/`plannedTotalExpenses` holding the original planned sums)
- `MonthFlowData` — Processed flow data for visualization
- `CashflowItem` — Individual income/expense item in a month
- `ProjectionLineItem` — Line item in a projection with source tracking (`source`: `'bank-actual'` = a real-transaction retrospective line; `'mortgage-payment'`/`'budget'`/`'credit-card'`/`'goal'`/`'trip'` = injected lines; `remainingAmount`/`isPaid`/`matchedTxId` are set only on an actualized month's lines — `amount` always stays the planned/effective amount, `isPaid` means exact-matched to a booked transaction, `remainingAmount < amount` with `isPaid` false means a category-gap-blended partial)

## Known Issues

_No known issues at this time._
