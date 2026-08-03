# Components (`src/components/`)

React component library for the application.

## UI Framework

**PrimeReact** is the component library (not shadcn/ui or Material-UI). Import components from `primereact/*`:
- `primereact/button` — Button
- `primereact/inputtext` — InputText
- `primereact/inputnumber` — InputNumber
- `primereact/dropdown` — Dropdown
- `primereact/dialog` — Dialog
- `primereact/datatable` — DataTable
- `primereact/tabview` — TabView
- `primereact/steps` — Steps (wizard)
- `primereact/tag` — Tag
- `primereact/inputswitch` — InputSwitch
- `primereact/selectbutton` — SelectButton
- `primereact/message` — Message
- `primereact/tooltip` — Tooltip
- `primereact/progressspinner` — ProgressSpinner

**Icons**: `react-icons` (Material Design `Md*`, Font Awesome `Fa*`), `primeicons`, `lucide-react`.

## Directory Structure

### `charts/`
Data visualization components:
- `net-worth-chart.tsx` — Chart.js (`primereact/chart`) line/area chart for net worth over time; a Total assets/Liquid scope toggle and net-worth-only/breakdown toggle; reuses `wealth-chart.tsx`'s `WEALTH_COLORS`/`wealthCategoriesForScope()`/`computeScopedNetWorth()` so its tooltip enumerates every in-scope non-zero category.
- `wealth-chart.tsx` — Chart.js stacked-band chart of wealth composition, scoped `total` (Cash, Investments, Receivables, Home value / Debts, Credit cards, Mortgage) or `liquid` (Cash, Investments, Debts, Credit cards), plus a Net worth line overlay; all-zero series omitted. Exports the shared color map and scope helpers used by `net-worth-chart.tsx`. Its Chart.js legend is the only legend (no separate HTML legend).
- `monthly-flow-chart.tsx` — ECharts Sankey diagram for income → expenses flow (gross salary **and** gross taxed income split into deduction outflows via `isGrossSource`)
- `cashflow-waterfall-chart.tsx` — ECharts waterfall chart for balance progression
- `expense-treemap-chart.tsx` — ECharts treemap for expense proportions
- `scenario-comparison-chart.tsx` — lazy ECharts "Balance over time" line chart for the Playground (dashed Current plan vs solid With changes, zero markLine, red overlay tracing below-zero stretches)
- `split-spend-chart.tsx` — lazy ECharts stacked bars for the /split Insights section (spend By group / By member / By category toggle; group/member series use the stable hash palette, category mode buckets via `bucketSpendByCategory` top-8 + 'Other' and colors via `getCategoryColor`)
- `split-net-chart.tsx` — lazy ECharts running-net line for the /split Insights section (viewer net over time, zero markLine) over green/orange monthly-change bars; first bar measured against `viewerNetBaseline`, and when the standing balance dwarfs the deltas the bars use a hidden zero-aligned second y-axis so they stay readable

Charts mix ECharts (`echarts-for-react`, preferred for Sankey/waterfall/treemap) and Chart.js (`primereact/chart`, used by the two net-worth charts above). Feature-specific charts live with their feature: see `mortgage/mortgage-charts.tsx` + `mortgage/mortgage-sankey.tsx` and `budgets/budget-month-chart.tsx`.

### `layout/`
- `app-layout.tsx` — Main layout wrapper with AppContext provider. Manages drawer state, selected account, refresh callbacks, sidebar state. This is the central state hub.
- `sidebar-nav.tsx` — Left navigation sidebar with the app routes (from the shared `nav-config.tsx` via `useVisibleNavItems()`, which filters to `simpleModeVisible` entries in Simple display mode), a search quick action (the monthly check-in lives on Overview + ⌘M/palette, not in the chrome), user menu (`useUserMenuItems` in `nav-config.tsx`: a single non-interactive name+email template item, full-contrast name + one opacity-70 truncated email; theme/display-mode/sign-out items use an icon+label template with `flex items-center gap-2`), theme toggle, collapse button.
- `brand-logo.tsx` — Inline-SVG brand mark (euro coin + rising chart, money-green) mirroring `public/icons/icon.svg`; gradient id scoped with `useId()` since the sidebar/top-bar/drawer are all mounted at once. Used as the logo in all nav surfaces and the auth pages (replaced the old 💰 emoji).

### `modals/`
Entity create/edit forms:
- `cashflow-item-modal.tsx` — Unified modal for income/expense items (RHF + `zodResolver(cashflowItemSchema)`, `src/lib/schemas/cashflow-item.schema.ts`). Handles recurring, one-off (incl. reimbursement tracking: expect-reimbursement checkbox + expected month + pending/received status on edit), salary, and Gross income (taxed income: salary-tax-settings toggle or custom rates, live net preview, skip-occurrence chips) types; its list view is two sections — Regular items (monthly-equivalent summary cards + "≈ / month" column) and One-time items (upcoming strip + month-sorted table). Largest and most complex modal.
- `occurrence-override-dialog.tsx` — Edit/skip a single occurrence of a recurring item.
- `users-modal.tsx` — Admin user management
- `index.ts` — Barrel exports for all modals

Investment / debt / receivable create-edit forms are no longer standalone modal files — they are rendered from `ui/entity-list-drawer.tsx` (routed via `ui/entity-modal-router.tsx`).

### `mortgage/`
Shared-mortgage UI: `mortgage-setup-wizard.tsx`, `mortgage-ledger-table.tsx`, `mortgage-charts.tsx`, `mortgage-sankey.tsx`, `mortgage-history-strips.tsx`, `mortgage-panels.tsx`, `mortgage-dialogs.tsx`, `mortgage-reconcile-dialog.tsx`, `mortgage-import-dialog.tsx`.

### `budgets/`
Trip/project budget UI: `budgets-section.tsx` (the Budgets half of the merged "Trips & Budgets" page at `/budgets`, `<section id="budgets">`), `budget-setup-wizard.tsx`, `budget-card.tsx`, `budget-verdict-card.tsx`, `budget-coverage-bars.tsx`, `budget-vs-actual-bars.tsx`, `budget-expense-log.tsx`, `budget-month-chart.tsx`, `budget-panels.tsx`, `budget-dialogs.tsx`, `budget-confirm-dialog.tsx`, `budget-export-dialog.tsx`, `budget-templates.ts`.

### `split/`
Split-group UI (Splitwise replacement): quick-add sheet (amount field first + autofocused), expense/settle/recurrence/import dialogs, activity feed, category icons, `group-period-card.tsx` — the detail page's "Last 30 days" insights card (segmented who-paid bar on `getAvatarColor`, `.collapse-grid` details with category chips / top expenses / `describeGroupPeriod` sentences; pure math in `computeGroupPeriodInsights`, deliberately no ECharts import) — and `bank-link-details-dialog.tsx` — display-only dialog showing another member's linked bank transaction (member, bank, date, amount, counterparty; never an IBAN). Member displays (balance banner, settle-up dropdowns, activity actors, detail rows) show `<UserAvatar>`s; detail/activity rows are whole-row clickable (expense → edit dialog, payment → row menu).

### `goals/`
Financial goal UI (rendered by `/goals`):
- `goal-card.tsx` — Progress bar, on-track/behind/achieved tag, projected reach date, edit/archive/delete actions.
- `goal-dialog.tsx` — Create/edit dialog (RHF + `zodResolver(goalSchema)`); conditional fields per tracking method (account dropdown / manual amount).

### `trips/`
Trip per-diem UI (rendered as the Trips section of the merged `/budgets` page; `/trips` redirects there):
- `trips-section.tsx` — The Trips half of the merged "Trips & Budgets" page (`<section id="trips">`, rendered first).
- `trip-card.tsx` — Summary card for a trip (status, total per diem, reimbursement month).
- `trip-dialog.tsx` — Create/edit dialog (day list, per-country segments, free-meal counts, rate snapshot).
- `per-diem-breakdown.tsx` — Day-by-day per-diem calculation breakdown.

### `bank/`
Enable Banking (PSD2 AIS, **read-only** sync) UI:
- `bank-connections-panel.tsx` — Connect/reconnect/disconnect banks; per-linked-account config (role cash/credit-card, anchor account, exclude, card statement/due day, manual credit limit, expected monthly spend, custom name) with autosave + field tooltips; the card summary line renders `effectiveCardNumbers` (owed/available/limit, each independent). Rendered in **Settings → Accounts & Banking**.
- **PrimeReact Dropdown null-option gotcha**: an option whose `value` is `null`/`''` makes the Dropdown emit the whole **option object** in `onChange` (its `getOptionValue` treats empty as "no value" and falls back to the option itself). Every "— not linked —"-style sentinel option's `onChange` must normalize: `typeof e.value === 'string' ? e.value : null` (see bank-connections-panel, budget-expense-log, mortgage-dialogs).
- `account-picker.tsx` — Sticky bank-tab row (connection/consent status dots, hidden for a single connection) + account-chip row (name + balance/owed); drives the `/bank` page's selected account.
- `bank-ledger-table.tsx` — Imported transaction ledger for one linked account: search box, infinite-scroll desktop DataTable (rows revealed as the inner scroll area nears its end) with a "Split" flag-pill column, and compact month-grouped mobile rows — each row is a whole-row `role="button"` that toggles expansion; the "already split" pill and Split-this button sit between the title and the amount (inner buttons `stopPropagation`), so the amount + chevron form a constant-width right rail and amounts right-align across rows. Rendered on the `/bank` page.
- `account-picker.tsx` — sticky bank/account chip switcher with **jiggle-mode reorder** (root `AGENTS.md` → "Motion"): a long-press enters the mode, and **one shared jiggle state drives two `useJiggleReorder` instances** — the bank-tabs row reorders connections, the account-chips row reorders accounts within the active connection. Every move persists the flat id order to `UserPreferences.bankAccountOrder` (`updateBankAccountOrder`) immediately, and the page applies it via the pure `sortConnectionsByAccountOrder` (`src/lib/bank-utils.ts`) to the picker, the link list, and the default selection. (The old ⇅-button + ◀/▶ nudge-arrow reorder was removed in favor of jiggle mode.)

### `onboarding/`
- `onboarding-wizard.tsx` — 5-step guided setup: Welcome → Cash Account → Income (salary rates prefill from the user's `taxDefaults`) → Expenses → Done (asks the detail level and persists it as the display mode; lands on Home). Shown to new users who haven't completed onboarding.

### `providers/`
Context providers wrapped around the app:
- `theme-provider.tsx` — Dark/light mode management
- `prime-provider.tsx` — PrimeReact configuration
- `toast-provider.tsx` — app-wide toast surface. Mounts one `<Toast>` (bottom-center) in `AppLayout`; use `useToast()` (`success`/`error`/`info`/`show`) instead of per-component `<Toast>` refs. Fire it after every mutation.
- `celebration-provider.tsx` — `useCelebration().celebrate('checkmark' | 'confetti')`: the celebration overlays (split-expense create / settle-up; see root `AGENTS.md` → "Motion"). The checkmark is a ~900ms badge-pop with an expanding ring + 6-dot burst + check draw (every keyframe uses `forwards` since the overlay unmounts). Mounted inside `ToastProvider` in `AppLayout`; returns `false` under reduced motion so callers fall back to flash-highlight + toast.

### `reconcile/`
- `reconcile-wizard.tsx` — Monthly check-in. Advanced mode: 3 steps (Select month → Enter actual balances for all entities → Review variances and confirm), with special handling for debt installments. **Simple mode**: one screen — auto-starts a session on the current month, shows the pre-filled balances list with reassurance copy, and a single "Save check-in" button.

### `ui/`
Shared UI components:
- `command-palette.tsx` — Cmd+K command palette with search, navigation, and action commands (incl. `action-demo-mode` toggle)
- `jiggle-reorder.tsx` — shared iOS-style jiggle-mode reorder primitive (`useJiggleReorder` hook + `JiggleModeBar` pill); long-press → mode, drag/arrow-keys reorder; wobble on `[data-jiggle-inner]`, drag on `[data-jiggle-item]`; pure math in `src/lib/reorder-utils.ts`. Used by /split (group list) and /bank (account-picker). See root `AGENTS.md` → "Motion".
- `user-avatar.tsx` — `<UserAvatar>`: renders a user's avatar image (from `/api/avatars/[userId]`) or initials on a deterministic `getAvatarColor` hsl hash (`src/lib/avatar-utils.ts`). Profiles resolved via the `useUserProfiles` hook (`src/lib/hooks/use-user-profiles.ts`, module cache + inflight dedup).
- `avatar-editor-dialog.tsx` — `AvatarEditorDialog`: drop/paste/browse → EXIF-normalized ≤2048px source → `react-easy-crop` round crop + zoom (lazy-loaded dependency) → 256×256 WebP q0.85 (JPEG fallback), saved via `updateMyAvatar` / admin `updateUser`.
- `entity-list-drawer.tsx` — Slide-in drawer showing lists of entities by type (cash, investments, receivables, debts) with inline create/edit/archive forms
- `entity-modal-router.tsx` — Routes entity types to the correct create/edit form
- `kpi-tile.tsx` — `KpiTile`: the shared KPI card (title/value/change badge/subline/progress bar); zero-delta changes render as muted "unchanged" text instead of a "+€0,00" badge; optional `help` prop renders a `HelpHint`
- `alert-banner.tsx` — `AlertBanner`: shared reminder/attention banner (check-in, Euribor, bank consent, budget warnings) with optional action button and dismiss
- `help-hint.tsx` — `HelpHint`: tap/hover "?" affordance showing plain-language help text (`src/lib/plain-language.ts`)
- `empty-state.tsx` — `EmptyState`: shared icon + title + body + action block for empty lists
- `debt-progress-card.tsx` — Compact debt payoff progress card (uses `getDebtPayoffInfo` from `lib/debt-utils.ts`)
- `status-hero-card.tsx` — Headline status/summary card
- `form-primitives.tsx` — Shared form field building blocks
- `delayed-loading.tsx` — `DelayedSpinner` / `DelayedSkeleton`: loading indicators that appear only after ~300ms (via `useDelayedFlag` in `lib/hooks/use-delayed-flag.ts`), so fast loads never flash a spinner
- `chart-explain.tsx` — the "Explain this chart" system: `ChartExplain` wrapper (button + inline `.collapse-grid` panel + sr-only description via `aria-describedby`), `ChartExplainButton`/`ChartExplainPanel` (canned `ReadCue[]` rows with `ChartCueSwatch` shapes + a generated "in plain words" list), `useChartExplain` (panel state; defaults open in Simple mode), and `useChartTour`/`ChartTourBar` (step tours with ECharts `dispatchAction` highlights — cashflow trio only). Descriptions come from the pure `src/lib/chart-descriptions.ts` (unit-tested); money formatting is demo-mask-aware (`demoMasked` in describe `useMemo` deps). Every canvas chart must integrate this — see root `AGENTS.md` → "Chart explanations".
- `skeletons.tsx` — content-shaped page skeletons (`KpiGridSkeleton`, `ChartsPageSkeleton`, `ListPageSkeleton`, `HomeSkeleton` (Home's glance/balances/activity region), `SplitDetailSkeleton`) used in place of full-page spinners on heavy pages (instant-shell pattern); size each block to the real content so the swap never shifts layout

Motion conventions (tokens, `animate-fade-in`/`rise-in`/`scale-in`, `.pressable`, `.collapse-grid`, the global reduced-motion kill-switch) live in the root `AGENTS.md` → "Motion" — clickable cards get `pressable` (which now includes a guarded hover shadow; extra `hover:shadow-md` is optional), tappable text rows get `transition-colors` + `active:bg-*`, and entrance classes go on once-mounted wrappers only.
- `index.ts` — Barrel exports

The occurrence-override dialog lives in `modals/occurrence-override-dialog.tsx`.

## Patterns

### Modal/Drawer Flow
1. User clicks action button → AppContext's `openDrawer()` sets drawer state
2. `EntityModalRouter` reads drawer state and renders the appropriate modal
3. Modal calls server action on save → cache invalidated → `refreshData()` called
4. Parent component re-fetches data
5. Submit buttons show `loading` while awaiting; on success the modal closes and a `useToast()` toast confirms; on hot paths the parent updates optimistically and reconciles via the background `refreshData()` (see root `AGENTS.md` → "Feedback & loading UX")

### Form Pattern
All forms use React Hook Form with Zod validation:
```tsx
const { register, handleSubmit, formState: { errors } } = useForm<FormData>({
  resolver: zodResolver(formSchema),
  defaultValues: { ... }
});
```
