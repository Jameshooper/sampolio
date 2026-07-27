# Sampolio — UI/UX & Product Improvement Suggestions

Evidence-backed backlog of UI/UX, performance, and integration improvements.
**No suggestion removes functionality**; every interface must keep working well on
mobile (~375–390px) *and* desktop. Hard defects belong in
[`known-gaps.md`](known-gaps.md), not here.

The July 2026 audit backlog (cashflow header collapse, KPI grouping, mortgage
tabs, bank ledger pagination, playground stacking, category colors, the §11
integration features, and the rest) has been implemented in full — see the
retired-ideas note at the bottom. What remains:

## Open items

### 13.1 Broader UI test coverage
Component tests now cover the shared primitives (AlertBanner/KpiTile/EmptyState),
the cashflow item modal, the split editor, and the reconcile wizard. Natural next
targets: the budget verdict card (per-month strip math at the DOM level), the
month strip / projection table, the bank ledger (search + month grouping), and
eventually a thin e2e smoke (sign-in → add expense → see it in the projection).
There is still no coverage for most server actions or the bank
client/connect/sync modules ([architecture.md](architecture.md) §15).

### 13.2 Held-back dependency majors (checked 2026-07-23)
- **PrimeReact 11 / primeicons 8 — evaluated in depth and deliberately declined
  (2026-07-23)**: v11 is a ground-up rewrite under NEW packages (`@primereact/ui`,
  `@primereact/core`, `@primeuix/themes`) with a **proprietary dual license** — a
  key is required even on the free Community tier (individuals qualify; register
  at primeui.dev/licenses/community), unlike MIT v10. Missing direct equivalents
  for components in use: ConfirmDialog (13+ imperative sites), SelectButton (13),
  MultiSelect, Steps (4 wizards), the Chart.js wrapper (4 chart files); renames
  with API changes: Dropdown→Select (24 files), Calendar→DatePicker, Sidebar→
  Drawer, TabView→Tabs, InputSwitch→ToggleSwitch. All 81 primereact-importing
  files would change; the theme pipeline (`copy-themes.mjs` over `lara-*-green` +
  ~90 `.p-*` selectors in globals.css/glass-overrides.css) must be rebuilt as a
  design-token preset. v11.0.0 shipped with no changelog/migration guide (promised
  from 11.0.1). **Revisit when**: a migration guide + component parity exist
  (≥11.1), and the maintainer has decided the licensing question (obtain a
  Community key, or migrate to a permanently-MIT stack instead).
- **TypeScript 7**: blocked by typescript-eslint (supports TS ≤6; tracking
  typescript-eslint/typescript-eslint#10940). `tsc --noEmit` itself passed on 7.0.2.
- **eslint 10**: `eslint-plugin-react` (via eslint-config-next) crashes at
  rule-creation under 10.x; retry when the Next lint stack catches up. Note
  eslint-config-next 16.2.11 promoted the React Compiler hook rules to `error`;
  `eslint.config.mjs` pins them back to `warn` (the codebase's fetch-effect
  patterns trip them by design).

### Future ideas (unvetted)
- **Remote/push check-in notification**: the local opt-in notification only fires
  on app open; true scheduled delivery needs a push service — deliberately out of
  scope so far.
- **Manual card-payment fingerprint**: months older than a card's served history
  whose billing identity changed before that history begins can never
  auto-attribute; a "mark as card payment" affordance on a ledger row could teach
  the fingerprint manually and light up the backlog.
- **Cross-currency conversion** for aggregate displays (app-wide limitation, see
  AGENTS.md §Known Limitations).
- **Recurring-suggestion tuning**: the detector is conservative (3 consecutive
  months, one charge/month); quarterly/yearly pattern detection is unexplored.

---

*Retired ideas, for the record: the March 2026 audit items (the "Am I okay?" hero,
Simple/Advanced mode, monthly check-in rename, playground, goals backend, skeleton
loading states, progress-framed mortgage copy) and the entire July 2026 audit
backlog — collapsing cashflow header + single month-selection hook + gross-vs-net
caption + labeled mobile cards + account-selector affordance (§1), grouped KPI
tiles + zero-delta suppression + check-in de-duplication + shared
AlertBanner/KpiTile/EmptyState primitives (§2), tabbed mortgage layout +
consolidated Manage menu + payoff summary card (§3), stacked budget header +
per-month coverage strip (§4), split empty-state copy + per-group activity (§5),
bank ledger month grouping/search + card-row formatting (§6), lazy settings
tabs (§7), playground stacking/history/apply-to-plan (§8), Home glance tile +
quick-add copy (§9), lazy modal router + split item modal ("More options") +
category auto-suggest + CATEGORY_COLORS + labeled drawer actions + Simple-mode
phase 2 (§10), recurring-transaction detection, "Split this", plan-vs-reality,
Euribor prefill, local check-in notification, budget↔split link (§11), and the
§12 performance items — are all shipped. The shared-expense-ratio idea was
superseded by Split groups.*
