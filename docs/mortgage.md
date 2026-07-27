# Shared Mortgage — deep dive

The mortgage is one of Sampolio's two shared, multi-user entities (the other is the split
group). This document covers its data model, the amortization engine, actuals/reconcile,
ownership math, and its integration points. Conventions (server-action pattern, cache
tags, encrypted-file storage) live in the root `AGENTS.md`; anchoring and transfer
injection into cashflow are detailed in
[projections-and-reconciliation.md](projections-and-reconciliation.md); the overall
storage/crypto picture is in [architecture.md](architecture.md).

## 1. Data model & storage

Unlike user-scoped entities (under `data/users/{id}/`), a mortgage lives in a **global
shared directory** and is decryptable with the app's global key. Layout (path helpers in
`src/lib/db/shared-mortgages.ts`):

```
data/shared/mortgages/{id}.enc                    # SharedMortgage (loans + members embedded)
data/shared/mortgages/{id}/rates/{id}.enc         # MortgageRateEntry (Euribor reset history)
data/shared/mortgages/{id}/costs/{id}.enc         # MortgageCostEntry (insurance / invoicing / service fees)
data/shared/mortgages/{id}/extra-payments/{id}.enc # MortgageExtraPayment
data/shared/mortgages/{id}/snapshots/{id}.enc     # MortgageBalanceSnapshot (drift re-anchors)
data/shared/mortgages/{id}/actuals/{id}.enc       # MortgageActualEntry (recorded bank months)
data/shared/mortgage-members/{userId}.enc         # { mortgageIds: string[] } reverse index
```

- The reverse index (`getMortgageIdsForUser`) lets `getMortgagesForUser` read only the
  user's mortgages instead of scanning/decrypting the whole shared dir. It is maintained
  by `createMortgage` / `addMortgageMember` / `removeMortgageMember` / `deleteMortgage`.
- Sub-entity writes are **upserts**: `setRate` upserts by `effectiveDate`; `setCost` by
  `type + loanId + effectiveDate`; `createBalanceSnapshot` by `loanId + yearMonth`;
  `setActual` by `loanId + yearMonth`. `deleteMortgage` cascades all five sub-dirs.

**Types** (`src/types/index.ts`): `SharedMortgage` (name, currency, `housePrice`,
`rateResetMonth`/`rateResetDay` — default 12 / 14 set in `createMortgage`, `loans[]`,
`members[]`, `isArchived`), `MortgageLoan` (kind `'asp' | 'regular'`, `initialPrincipal`,
`startDate`, `originalTermMonths`, `paymentMode` `'annuity-fixed-term' | 'fixed-payment'`,
`margin`, `dayCount` `'actual/360' | '30E/360'`, optional `paymentDayOfMonth`,
`currentMonthlyPayment`, `aspSubsidy`), `MortgageMember` (denormalized `email`/`name`,
`role` `'owner' | 'member'`, `initialPayment`, `loanSharePercent`,
`ownershipTargetPercent`, optional `linkedAccountId`).

**Access control** is enforced in the action layer, not storage:
`loadMortgageForMember(mortgageId, opts?)` in `src/lib/actions/shared-mortgages.ts`
checks `mortgage.members[].userId` against `session.user.id`; `opts.requireOwner`
additionally requires `role === 'owner'`. Owner-gated actions: `deleteMortgage`,
`addMortgageMemberByEmail`, `removeMortgageMember`, `updateMortgageMember`, and
`updateMortgage` only when `isArchived` is being changed. Everything else (rates, costs,
extra payments, snapshots, actuals/reconcile, loan edits) is open to any member. Members
are resolved by account email via `findUserByEmail`; `removeMortgageMember` refuses to
remove the only owner, and `updateMortgageMember` refuses to demote the only owner to
member (the guard that makes ownership transfer safe: promote another member, then
demote yourself).

**Cache tags** are keyed by mortgage id (member-agnostic) so one `updateTag` reaches
every member: `mortgage:{id}` plus `:rates`, `:costs`, `:payments`, `:snapshots`,
`:actuals`. Only the membership list uses `user:{userId}:mortgages`
(`invalidateForMembers` fans out both). Cached readers live in `src/lib/db/cached.ts`
(`cachedGetMortgageById`, `cachedGetMortgageProjectionData`, `cachedGetMortgageActuals`, …).

## 2. Amortization engine

`src/lib/mortgage-projection.ts` — pure functions, no I/O. Entry point:

```ts
calculateMortgageProjection(input: MortgageProjectionInput, endDate: YearMonth): MortgageProjectionMonth[]
```

where `input = { mortgage, rates, costs, extraPayments, snapshots, actuals? }`.

- **Sub-loans**: each `MortgageLoan` (e.g. ASP + regular) is projected independently by
  `projectLoan`, then merged per month. Months before a loan's `startDate` / after its
  payoff get a zero row. A safety guard caps the loop at `originalTermMonths × 2 + 24`.
- **Emission from genesis**: the schedule always starts at `getMortgageStartDate`
  (earliest loan `startDate`), so the ledger shows full history — no anchor trimming.
- **Interest** = `balance × (rate/100) × dayCountFraction`. `dayCountFraction` is
  `1/12` for `30E/360`; for `actual/360` it is exact debit-to-debit days `/ 360` when
  `paymentDayOfMonth` is set (clamped to month length), else calendar days of the period
  month `/ 360`.
- **Rate resolution** (`getEffectiveAnnualRate`): the most recent `MortgageRateEntry`
  with `effectiveDate <= month`, plus the loan's `margin`. Months before the first entry
  fall back to the earliest entry; with no entries at all, just the margin.
  `euriborRate` is stored **excluding** the margin.
- **Annuity reset** (`annuity-fixed-term`, Finnish *tasaerä*): whenever the effective
  rate changes between months, the level P+I payment is recomputed via
  `recomputeAnnuityPayment(balance, rate, originalTermMonths − monthsSinceStart)` so the
  maturity stays fixed. Between resets the installment is constant.
  `fixed-payment` mode uses `currentMonthlyPayment` and never recomputes.
  `currentMonthlyPayment` also seeds month 1's level payment when present.
- **Time-effective costs** (`getEffectiveCost`): a `MortgageCostEntry` applies from its
  `effectiveDate` forward until a newer entry; earlier months keep the old value (0
  before the first entry). `loan-insurance` is per-loan (`loanId` required, validated in
  `setMortgageCost`); `invoicing-fee` and `service-fee` are mortgage-level — the
  invoicing fee is split evenly across the loans (`invoicingFeeShare`), the service fee
  is per-person (see §4).
- **ASP subsidy** (`computeAspSubsidy`): only for `kind === 'asp'` loans with
  `aspSubsidy.enabled`, within `eligibilityYears × 12` months of the loan start, and only
  when the effective rate exceeds `thresholdRate`. Then
  `subsidy = interestAccrued × ((rate − threshold) / rate) × subsidyShare`;
  `interestPaid = interestAccrued − subsidy`.
- **Extra payments** (`MortgageExtraPayment`): applied in their month on top of the
  scheduled principal, capped so the balance never goes negative. `mode: 'shorten-term'`
  keeps the installment (loan finishes earlier); `'lower-payment'` re-annuitizes the
  reduced balance over the remaining term after the month, shrinking future installments.
- **Per-month output** (`MortgageProjectionMonth`): per-loan rows
  (`MortgageLoanProjectionMonth`, incl. `isActual`), summary totals (`totalRemaining`,
  `totalRepayment` = Σ P+I, `totalCharge` = Σ full bank charge, `totalInterest`,
  `totalSubsidy`, `totalInsurance`, mortgage-level `invoicingFee`/`serviceFee`), running
  cumulatives (`cumPrincipalPaid` etc.), `isHistorical`, `isAllActual`, and per-member
  positions (§4). Helpers: `getPayoffMonth` (first month `totalRemaining <= 0.005`),
  `getMemberPositionForMonth`.

## 3. Actuals, forecast carry-forward, drift snapshots

**`MortgageActualEntry`** — one recorded bank month per loan: `remaining` (end-of-month
balance), `repayment` (the bank's **full** charge incl. insurance + invoicing share),
`interest` (after subsidy), `insurance`, `subsidy` (defaults to 0). All positive
magnitudes.

When `projectLoan` finds an actual for a loan-month it uses the figures **verbatim**
instead of computing them: `endingPrincipal = max(0, remaining)`,
`principalPaid = startingPrincipal − endingPrincipal`, `monthlyCharge = repayment`,
`scheduledPayment = repayment − insurance − invoicingFeeShare`. This makes the historical
ledger exact (see §7).

**Forecast carry-forward**: each actual also sets `levelPayment = scheduledPayment`, so
forecast months after the last actual hold the bank's current P+I installment until the
next Euribor reset re-annuitizes it — forecasts do not drift back to the model's own
annuity.

**Drift snapshots** (`MortgageBalanceSnapshot`) are the lighter single-point correction:
the loan balance is reset to `actualBalance` at the **start** of the snapshot's month,
*inline* — earlier months stay untouched and forward months re-base from the observed
value. This is deliberately different from the cashflow engine's `resolveAnchor`
(`src/lib/projection.ts`), which starts the projection *at* the snapshot and discards
pre-anchor history — see
[projections-and-reconciliation.md](projections-and-reconciliation.md).

## 4. Ownership & equity

`deriveLoanShares(housePrice, initialPayments, targetPercents)` in
`src/lib/mortgage-utils.ts` is the single source of truth for the share split:

```
remainingToTarget_m = max(0, targetPercent_m × housePrice − initialPayment_m)
share_m             = remainingToTarget_m / Σ remainingToTarget
```

(even split if everyone is already at/over target). The member who paid less up front
carries a larger share of the monthly loan, which is what pulls both members toward
their targets over time. The **full-precision** fraction is stored as
`MortgageMember.loanSharePercent` and used as-is — rounding it would stop ownership from
converging exactly at payoff.

Per month, `calculateMortgageProjection` emits a `MortgageMemberPosition` for each member:

- `stake = initialPayment + loanSharePercent × initialLoanTotal` (constant; ≈ the
  member's target share of the house)
- `liability = loanSharePercent × totalRemaining`
- `equity = stake − liability`
- `ownershipPercent = equity / housePrice`; `leftToOwnTarget = ownershipTargetPercent × housePrice − equity`
- `monthlyDeposit = loanSharePercent × totalCharge + serviceFee` — the amount this member
  transfers to the loan account (their share of the full bank charge plus the per-person
  service fee).

**Net-worth fold-in**: `src/lib/wealth-projection.ts` adds the **current user's**
per-mortgage `equity` to net worth (liability/stake are exposed separately in
`mortgagesBreakdown` for the chart bands) — only when **both**
`data.mortgageProjections` and `data.currentUserId` are provided, so callers that don't
pass them are unaffected.
`getMyMortgageEquity` (`src/lib/actions/shared-mortgages.ts`) aggregates
equity/liability/stake across the user's non-archived mortgages for Overview KPIs.

**Invariant**: never also enter the mortgage as a `Debt` — equity already nets the
liability, so a `Debt` entry would double-count it.

## 5. Cashflow integration

Each member may set `MortgageMember.linkedAccountId` — their own cash account the monthly
transfer is paid from — via `setMyMortgageLinkedAccount(mortgageId, accountId | null)`.
This action is **not owner-gated** (any member, but only for their own row): it only
affects that member's private cashflow, never the shared mortgage math.

`getMortgageTransfersForAccount` (exported helper in `src/lib/projection-inputs.ts`, called by `gatherProjectionInputs` in the same file)
finds non-archived mortgages whose membership row links to the account, runs the engine
from genesis to `maxTerm + 24` months, and emits one `MortgageTransfer`
(`{ yearMonth, mortgageId, mortgageName, amount }`, type in `src/lib/projection.ts`) per
month where the member's `monthlyDeposit > 0.005`. `getProjection` passes these as the
7th parameter of `calculateProjection`, which renders each as a **read-only expense line
with `source: 'mortgage-payment'`**. The line is not a stored entity; clicking it in the
cashflow UI deep-links to `/mortgage`. Errors in the mortgage path are caught and logged
so they never break the core cashflow projection. Details of transfer injection:
[projections-and-reconciliation.md](projections-and-reconciliation.md).

**Euribor reminder**: the Overview page (`src/app/(dashboard)/overview/page.tsx`) calls
`isEuriborUpdateDue(mortgage, rates)` (`src/lib/mortgage-utils.ts`) and shows a banner
when due. "Due" = inside the window around the reset anchor
(`rateResetMonth`/`rateResetDay`): ≤ 7 days before the next reset or 0–60 days after the
last one, **and** no rate entry exists with `effectiveDate >= resetYearMonth` — so the
banner appears once a year and disappears as soon as the new rate is entered.

## 6. Workflows (UI)

All mortgage UI lives in `src/components/mortgage/` and renders on
`src/app/(dashboard)/mortgage/page.tsx`. The page is segmented into an in-page
`TabView` — **Overview** (hero + ownership + sub-loan cards) / **Charts** (horizon
selector, the seven lazy charts + a "Payoff at a glance" summary card) /
**Schedule** (ledger + history strips) / **Tools** (transfer comparison) — so
mobile isn't one ~7 000px scroll. Entry points: a header **"Update Euribor rate"**
button appears only while the update is due (plus the `AlertBanner` reminder);
everything else lives under a single **"Manage"** menu grouped Loan · Members ·
Data; per-month **Reconcile** stays on the ledger rows.

- **Setup wizard** (`mortgage-setup-wizard.tsx`): five steps — Home, People, Loans,
  Rate & fees, Review. Validated by `mortgageSetupSchema`
  (`src/lib/schemas/mortgage.schema.ts`; ownership targets must sum to 100% within
  0.005). It calls `deriveLoanShares` live as down payments/targets are edited, then
  `createMortgage` writes the doc plus genesis rate/cost entries.
- **Euribor update** (`mortgage-dialogs.tsx`, also the rates strip in
  `mortgage-history-strips.tsx`): enter the new `euriborRate` and pick its
  **effective-from month**. The engine applies a rate from its `effectiveDate` month
  with no built-in lag — banks apply a reset only after their notice period (e.g. a
  mid-December fixing hits payments from ~February), so the user encodes that lag in the
  chosen month. The dialog previews the new total installment via
  `recomputeAnnuityPayment`.
- **Per-month reconcile** (`mortgage-reconcile-dialog.tsx`): the everyday path. Opened
  from a "Reconcile" button / per-row ✓ on elapsed forecast rows, prefilled with the
  projected per-loan figures so a no-drift month is a one-click confirm. Confirm calls
  `reconcileMortgageMonth(mortgageId, entries)` → `bulkSetActuals(…, replaceAll=false)`
  (upsert; other months untouched), flipping the month forecast → actual. The ↩ on an
  actual row calls `revertMortgageMonth(mortgageId, yearMonth)` →
  `deleteActualsForMonth`, reverting it to a forecast.
- **Bulk import** (`mortgage-import-dialog.tsx`): paste/CSV of
  `month, loan, remaining, repayment, interest, insurance[, subsidy]` — the 7th
  `subsidy` column is optional (blank ⇒ €0). The loan token matches a loan **id, kind,
  or label** (case-insensitive); a header row is skipped; numbers accept fi formats
  (`1 234,56`); values are taken as absolute magnitudes. A "Replace all existing imported
  history" checkbox (default **on**) maps to `importMortgageActuals`'s `replaceAll`,
  which clears all actuals before writing. `clearMortgageActuals` drops everything.
- **Extra payments**: `addMortgageExtraPayment` / `deleteMortgageExtraPayment` with
  `mode: 'shorten-term' | 'lower-payment'` (engine behavior in §2).
- **Members dialog**: owner-gated add/remove/update (`addMortgageMemberByEmail`,
  `removeMortgageMember`, `updateMortgageMember`) — an owner sees a role dropdown
  (Owner/Member) on every member row instead of a static tag, so ownership transfer is
  just promoting the other member then demoting yourself; the linked-account picker
  inside it uses the non-gated `setMyMortgageLinkedAccount` (§5).
- **Transfer comparison** (`mortgage-transfer-comparison.tsx` + `mortgageOfferSchema`):
  an ephemeral, client-side simulator of a competing bank's refinancing offer — never
  persisted.

## 7. Verification guarantees

`src/lib/mortgage-projection.test.ts` (vitest) exercises the engine against the
synthetic fixture in `src/test/mocks.ts`. The accuracy guarantees below are
asserted by the gitignored local twin `mortgage-projection.local.test.ts`, which
runs the same engine against a reference spreadsheet's "Loan progress" table
spanning 41 months:

- **Auto-model accuracy** (no actuals): total remaining balance within **0.7%** at every
  checkpoint; per-loan split at the current month within **~€700**; each member's
  `monthlyDeposit` within **~€12**. The residual is the bank's irregular early payments
  (interest-only start) that a clean annuity cannot reproduce.
- **Exactness with actuals**: with the bank's recorded rows imported, the ledger
  reproduces the spreadsheet **to the cent** (`toBeCloseTo(…, 2)`) — remaining balances,
  `totalInterest`, `totalCharge`, and member deposits — including the interest-only
  genesis month (zero principal), with `isActual`/`isAllActual` flagged.
- **Unit behaviors**: day-count fractions (30E/360 = 1/12; actual/360 calendar-day and
  exact debit-span variants), annuity closed form, time-effective rate/cost lookups, ASP
  subsidy activation above threshold (and zero below / for regular loans), both
  extra-payment modes, drift snapshots re-basing the month while leaving earlier history
  untouched, ownership identities (stakes sum to house price; `equity = stake − liability`
  exactly; ownership converges to 50/50 at payoff).
