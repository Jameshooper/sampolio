# Feature reference — Split, Budgets, Goals, Trips, Dashboards

Deep reference for the features outside the core cashflow/wealth engines. Conventions
(server-action pattern, `ApiResponse<T>`, cache tags, encrypted-file storage) live in the
root `AGENTS.md`; projection anchoring and transfer injection are detailed in
[projections-and-reconciliation.md](projections-and-reconciliation.md); bank sync in
[bank-sync.md](bank-sync.md); the mortgage in [mortgage.md](mortgage.md); the overall
system picture in [architecture.md](architecture.md).

## 1. Split groups (shared expense splitting — Splitwise replacement)

### Shared-entity model & access control

A `SplitGroup` is a shared, multi-user entity (like `SharedMortgage`). Storage
(`src/lib/db/split-groups.ts`):

```
data/shared/split-groups/{id}.enc                     # group meta + members + recurrence rules
data/shared/split-groups/{id}/expenses/{YYYY-MM}.enc  # array of that month's rows
data/shared/split-groups/{id}/summary.enc             # SplitGroupSummary (running balances + month index)
data/shared/split-group-members/{userId}.enc          # { groupIds: string[] } reverse index
```

Access control lives in the action layer: `loadGroupForMember` in
`src/lib/actions/split-groups.ts` checks `group.members[].userId` against the session;
`requireOwner` gates `updateSplitGroup`, `deleteSplitGroup`, `addSplitGroupMember`,
`removeSplitGroupMember` (which also refuses while the member's net ≠ 0),
`updateSplitGroupMemberRole` (which also refuses demoting the group's only owner —
promote another member first to transfer ownership), and `importSplitwiseCsv`. Members
are account-only, added by email via `findUserByEmail`; the creator is an `owner`.
`setDefaultSplitGroup` stores `defaultSplitGroupId` in the user's preferences (used by
the quick-add modal).

**Cache tags** (`invalidateGroup`): `split-group:{id}`, `split-group:{id}:summary`,
`split-group:{id}:expenses`, plus each member's `user:{userId}:split-groups` — one
invalidation reaches every member. Cached readers in `src/lib/db/cached.ts`.

### Money model — INTEGER CENTS, Splitwise-compatible signs

All split money is **integer cents** (`toCents`/`fromCents` in
`src/lib/split-utils.ts`; the Zod schemas enforce `z.number().int()`). Every row
(`SplitExpense` in `src/types/index.ts`, a discriminated union of
`kind: 'expense'` → `SplitExpenseItem` and `kind: 'payment'` → `SplitPayment`) carries
`netByUserId` — cents per member, summing to 0 — as the **canonical** balance
contribution: **`net > 0` ⇒ the member is OWED, `net < 0` ⇒ the member OWES.** This is
the same sign convention as the Splitwise CSV export, so imports copy the numbers
directly. A member's running balance = Σ net across rows.

### Pure engine (`src/lib/split-utils.ts`, unit-tested)

- `resolveSplit(memberIds, amountCents, spec)` reduces a `SplitSpec`
  (`paidByUserId` + `splitMode` + optional `splitConfig` / `participantUserIds`) to
  `{ netByUserId, paidBy, owed }`. Single-payer model. Modes:
  - `equal` — even split with the remainder cents handed to the first ids in order
    (deterministic: 10.00 / 3 → 3.34 / 3.33 / 3.33);
  - `full` — payer owes nothing; the other participants split the whole amount;
  - `exact` — `splitConfig` is cents per member and **must sum exactly** to the total
    (throws otherwise);
  - `percent` / `shares` — `splitConfig` values are weights; allocation uses the
    **largest-remainder method** (ties broken by index) so parts sum exactly.
- `paymentNet(from, to, amount)` → `{ [from]: +amount, [to]: -amount }` (a settle-up
  raises the payer's balance).
- `computeMemberBalances(members, rows)` sums `netByUserId` per member.
- `suggestSettleUp(balances)` — greedy debt simplification: largest debtor pays largest
  creditor until all balances zero out (fewest transfers for 2 members; general for n).
- `generateOccurrenceDates(rule, upToInclusive)` — date-grained recurrence
  (`daily | weekly | biweekly | monthly | yearly` from `anchorDate`), resumes exactly
  after `lastGeneratedThrough`, honors `endDate`, hard guard at 10 000 iterations.
- `guessCategory(title)` — keyword lookup (Finnish + English merchant words), fallback
  `'General'`. Used by `quickAddSplitExpense` when no category is given.

### Storage strategy & concurrency

- **Monthly chunks**: one encrypted file holds the array of a month's rows — not one
  file per row (thousands of per-file decrypts per cache miss otherwise). `addExpense`
  (hot path) appends to one chunk and **delta-updates** `summary.enc`
  (`bumpSummaryForAdd`: O(1), no other chunks read; `monthsWithData` is refreshed from
  chunk **filenames**, no decrypt). `updateExpense` (may move a row across chunks),
  `deleteExpense`, `bulkImportExpenses`, and occurrence overwrites call
  `rebuildSummary` (full recompute from all chunks). Empty chunks are deleted.
- `SplitGroupSummary` = `{ netByUserId, expenseCount, paymentCount, lastActivityAt?,
  monthsWithData, updatedAt }` — the hot reads (balances, month index) never decrypt
  history.
- **Per-group in-process mutex**: `withGroupLock(groupId, fn)` in
  `src/lib/actions/split-groups.ts` chains promises per group id, serializing
  read-modify-write of chunks/summary/rule cursors. Correct only because the app is a
  single node (`next start`); there is no on-disk locking anywhere in the codebase.

### Recurrence — materialized, not computed

Unlike the cashflow projection (which expands recurring items on the fly), split
recurrence **writes real rows**. `SplitRecurrenceRule`s are embedded in the group doc
(`addRecurrenceRule` / `updateRecurrenceRule` / `deleteRecurrenceRule`).
`catchUpGroupRecurrences(groupId)`:

- generates one expense per due occurrence with the deterministic
  `occurrenceKey = ${ruleId}:${YYYY-MM-DD}`; `upsertExpenseByOccurrence` overwrites an
  existing occurrence in place (preserving `id`/`createdAt`) so re-runs never duplicate;
- advances each rule's `lastGeneratedThrough` monotonically;
- skips `invalidateGroup` entirely when nothing was generated;
- runs under `withGroupLock`.

It is a **server action**, triggered from client effects — the Home dashboard calls it
for every group on mount (`home-dashboard.tsx` `fetchData`), and
`createSplitRecurrenceRule` calls it immediately (back-dated anchors materialize at
once). It must **not** run from the background bank scheduler: `updateTag` only works in
request scope. Stopping a rule = `isActive: false` or an `endDate`; pausing keeps
already-generated rows.

**End date editing**: `updateSplitRecurrenceRuleSchema` is a partial extended with
`endDate: nullable().optional()` — sending `null` clears it ("Never"). The pure
`planRecurrenceRuleUpdate` (`src/lib/split-utils.ts`) detects whether the request
carries the `endDate` key and, when the effective end moved back past
`lastGeneratedThrough`, returns a `pruneAfter` date: `updateSplitRecurrenceRule` then
deletes the rule's generated occurrences after it (`deleteGeneratedOccurrencesAfter`
in `src/lib/db/split-groups.ts` — chunk rewrite + one summary rebuild, caller holds
the lock) and clamps `lastGeneratedThrough` to the new end. Prune + rule update run
inside **one** `withGroupLock`; `catchUpGroupRecurrences` (re-materializing occurrences
when the end was extended) runs **outside** it — the mutex is non-reentrant, calling it
inside would deadlock. A generated row the user has since edited still carries
`generatedFromRuleId` and is pruned too (accepted edge). The dialog
(`recurrence-rule-dialog.tsx`) has an "Ends" Calendar (placeholder "Never",
`showButtonBar` Clear, min = start date, hint "Shortening the end date removes
generated expenses after it."); the detail page's rule list shows "· until {date}".

### Splitwise CSV import

- `parseCsv` (`src/lib/split-csv.ts`) is a real RFC 4180 parser: quoted commas, `""`
  escapes, CR/LF/CRLF, BOM strip.
- `parseSplitwiseCsv` expects `Date,Description,Category,Cost,Currency,<member…>`
  (member columns are signed net balances summing to ~0), skips blank separator rows and
  the trailing `Total balance` footer, flags `Payment`-category rows, requires a
  non-empty per-row currency and a `YYYY-MM-DD` date, and parses amounts leniently
  (`parseAmountToCents`: `98,90`, `1.234,56`, `1,234.56`, currency symbols, Unicode
  minus). Rows whose member balances don't sum to 0 get a non-fatal warning. A file
  containing more than one currency is rejected outright (fatal error, no rows kept).
- The import dialog (`src/components/split/split-import-dialog.tsx`) auto-maps each
  member column to a group member by fuzzy first-name match and requires every column to
  be mapped. `importSplitwiseCsv` (owner-gated) rejects mappings to non-members, builds
  rows with `source: 'import'` and `buildNetByUserId`; payment rows get payer/payee from
  `paymentParties` (column signs; rows that aren't a clean pairwise transfer are
  skipped), and rejects the import when any row's currency differs from the group's.
  Imported rows are stored with the **group's** currency, and `paidBy`/`owed`
  are left `undefined` — imports only know net, and the ledger displays who *added* a
  row, not who paid. `bulkImportExpenses` writes ~1 file per month (optionally
  `replaceAll`), then rebuilds the summary once.

### Bank-transaction linking

`SplitExpenseItem.bankLink?: SplitExpenseBankLink` is an optional, denormalized
pointer to the bank transaction an expense was created from: `txId`,
`linkedAccountId`, `ownerUserId` (whose bank connection), `bookingDate`, `amount`,
`currency`, and optional `counterpartyName`/`bankName` — denormalized so other
group members can see basic details without access to the owner's bank data, and
deliberately **never carries an IBAN**. It is created one way: the bank ledger's
"Split this" action passes it through `QuickAddSplitInitial.bankLink` into
`createSplitExpense`, which stamps `ownerUserId` server-side from the session (never
client-supplied). `updateSplitExpenseSchema` omits `bankLink` entirely, so editing an
expense can never add, forge, or drop the link; `updateSplitExpense` carries
`existing.bankLink` through its row rebuild unchanged.

Bank ledger rows show an **"already split" flag** (filled pill = linked, dashed
pill = heuristic) computed by the pure `matchTransactionsToSplits`
(`src/lib/bank-split-match.ts`, unit-tested): an explicit `bankLink.txId` match
always wins regardless of amount/date drift; otherwise a greedy one-to-one
heuristic pairs unlinked candidates by same currency + exact cents + booking date
within ±3 calendar days (spend rows only), closest date first, so a recurring
same-amount expense doesn't over-match. Candidates come from the read-only action
`getMySplitLinkCandidates(months)` (months validated `YYYY-MM`, deduped, capped at
36; per non-archived group it intersects the requested months with
`summary.monthsWithData` before reading any chunk).

Clicking the flag on `/bank` navigates to `/split/{groupId}?expense={id}&month={YYYY-MM}`
(scroll + flash-highlight on the split group page). On the split group detail page,
a `bankLink` marks the row with a small inline bank glyph in the subtitle and adds a
"View bank transaction" item to the row menu: the owner's own transaction navigates to
`/bank?account=…&tx=…`; another member's opens `BankLinkDetailsDialog`
(`src/components/split/bank-link-details-dialog.tsx`), a display-only dialog showing
the member, bank, date, amount, and counterparty.

### Overview fold-in

`getMySplitNetBalance()` sums the logged-in user's net across non-archived groups —
**summaries only**, no chunk reads. The Overview page passes it as
`WealthProjectionData.splitNetTotal` (`src/lib/wealth-projection.ts` adds it flat to net
worth, mirroring the card-liability fold-in) and shows a **"Split balance" KPI** when
non-zero (green when owed, red when owing). It replaces any manually-kept receivable
mirroring Splitwise totals — **such a manual receivable must be deleted** or the amount
is double-counted. Split balances are *not* injected into the cashflow projection.

### UI map

- `/split` (`src/app/(dashboard)/split/page.tsx`, nav "Split") — group list;
  `group-form-dialog.tsx` creates/edits groups. Group cards render in a responsive
  grid (`grid-cols-1 md:grid-cols-2`, single column on mobile) with equal-height
  cards; each is a clickable `<Link>` with a hover tint/border affordance. A group
  card shows a "new activity" dot when `summary.lastActivityAt >
  splitLastSeenAt[groupId]` (hidden when the group has no watermark baseline yet)
  and member `<UserAvatar>`s. The page also renders:
  - an **"Across all groups" summary card** — the viewer's aggregated pairwise
    position per counterparty (with avatars), from the pure `aggregatePairwiseNets`
    (`src/lib/split-insights.ts`): it sums each group's `suggestSettleUp` output so it
    always agrees with what each group's settle-up screen would say. Cross-currency
    positions stay separate with a "(mixed currencies)" note. Styled with a muted
    (`bg-gray-50`/`dark:bg-gray-900/40`) surface, distinct from the group cards'
    white/dark-gray cards, so its non-interactive, aggregate nature reads at a glance.
  - an always-expanded **Insights** section — `getSplitInsights(monthsBack = 12)`
    (`src/lib/actions/split-groups.ts`; cached summaries → overlapping months' chunks →
    the pure `computeSplitInsights`) drives two lazy ECharts: `split-spend-chart.tsx`
    (stacked spend, **By member (default) / By category / By group** toggle; tooltips append each
    series' share of the month total as a percentage, and By-member mode also renders
    in-bar `{pct}%` labels — suppressed under 8% or on empty months so thin slices stay
    clean. Category mode buckets the engine's full `spendByCategory` through the pure
    `bucketSpendByCategory(insights, 8)` — top-8 categories by window total plus an
    aggregated 'Other' — and colors each category via `getCategoryColor`, never
    positionally) and `split-net-chart.tsx` (running viewer-net line with a zero
    markLine over green/orange **monthly-change bars**; the first month's bar is
    measured against `insights.viewerNetBaseline` — the position just before the
    window — and when a large standing balance dwarfs the deltas the bars move to a
    hidden second y-axis whose zero is pixel-aligned with the primary axis's zero, so
    they stay readable without lying about their anchor). **Spend**
    counts `kind === 'expense'` rows only. **Paid attribution**: native rows use exact `paidBy` shares; net-only
    **imported rows credit each member `max(0, net)` — a documented LOWER BOUND** (a
    payer who also consumed shows only their net), mirroring the imported-row fallback
    in `buildSplitBudgetEntries`. **Running net** baselines each group just before the
    window (`totalNetByUserId[viewer] − Σ window viewer net`) then accumulates
    month-by-month, summed across groups. Each chart's plain-words description
    (`describeSplitSpend`/`describeSplitNet`, `src/lib/chart-descriptions.ts`) covers the
    whole window AND the current month: "This month so far: €X" (or "No shared expenses
    yet this month"), a typical-month comparison (average over nonzero prior months,
    emitted only at ≥2 of them), a mode-aware "This month, {X} leads instead" when the
    current month's top group/category/payer differs from the window's, and the net
    chart's "This month it moved up/down €X so far".
  - Group cards **reorder via jiggle mode** (the Motion guidance in
    [`architecture.md`](architecture.md#17-shared-ui-implementation-rules)): a long-press
    enters the mode, drag/drop or arrow keys reorder, and the flat id order persists to
    `UserPreferences.splitGroupOrder` (`updateSplitGroupOrder`, sanitized against the
    current group ids). The jiggle-reorder math is strictly one-dimensional (item
    centers from `offsetTop`), so the grid collapses to a single column for the
    duration of jiggle mode and reverts to the 2-up grid once it exits.
- `/split/[id]` — balance banner, a **"Last 30 days" insights card**
  (`src/components/split/group-period-card.tsx`, between the banner and the recurring
  rules; hidden when the group has no expenses): total spend headline and a
  default-**open** `.collapse-grid` expander holding two small **CSS mini-treemaps**
  side by side (1-col on mobile) — "By category" (top 5 + an 'Other' bucket, tiles
  tinted `getCategoryColor`, top-3 legend with amounts) and "Who paid" (tiles tinted
  each member's `getAvatarColor`, avatar/name/%/amount legend) — both laid out by the
  pure slice-and-dice `computeTreemapLayout` (`src/lib/treemap-layout.ts`, unit-tested);
  each treemap is `role="img"` whose label carries names + percentages only (money
  lives in the legends and `title` tooltips). Below them: top-3 single expenses and
  plain-words sentences from `describeGroupPeriod`. Collapsed, the card is just the
  headline + toggle. All math in the pure
  `computeGroupPeriodInsights(members, rows, fromDate, toDate)`
  (`src/lib/split-insights.ts`) over the already-loaded expense chunks — the 30-day
  window spans at most two calendar months, always inside the initial 3-chunk load, so
  the card needs no extra fetch. Payments count only toward `settledCents`; imported
  rows use the same `max(0, net)` lower-bound paid attribution (a caveat note shows
  when any are in-window). Then an **Expenses / Activity** toggle (Activity reuses
  `SplitActivityFeed` with `showGroup={false}`, fetched lazily via
  `getSplitActivity(30, groupId)` — the same action as Home's cross-group feed, now
  taking an optional `groupId`), month-paginated ledger (sticky month headers; older
  months load via **infinite scroll** — an IntersectionObserver sentinel with
  `rootMargin` 300px, re-observed on each reveal + view switch, mirroring
  `bank-ledger-table.tsx`, wraps the kept "Load older months" button as the a11y
  fallback + loading indicator — driven by `summary.monthsWithData`; when the loaded
  window is empty but older months exist the empty state says "Nothing this month"
  with a load-older action instead of "No expenses yet"), recurring rules
  (`recurrence-rule-dialog.tsx`), Settle-up (`settle-up-dialog.tsx`, prefilled from
  `getSettleUpSuggestions`), Import. **Whole rows are `role="button"`**: an expense row
  opens the edit dialog, a payment row opens its row menu, and trailing action buttons
  `stopPropagation`. Each expense row's subtitle reads
  `"{Payer} paid {amount} · added by {Adder}"` with **first names** ('You' for self); a
  `paidBy`-less imported row omits the payer segment. The trailing net indicator is a
**stacked** label-over-amount block ("you lent" / "you borrowed" at `text-xs` above the
`tabular-nums` amount — zero net stays a single "—"); titles are single-line
`truncate text-sm leading-snug` and the only trailing button is the row menu, so the
title keeps most of the row's width on a phone. Rows show member `<UserAvatar>`s,
  and the page applies optimistic UI on delete / rule pause-resume. A row with a
  `bankLink` shows an inline bank glyph in its subtitle + a "View bank transaction" row-menu
item (see "Bank-transaction linking" above); `?expense=&month=`
  deep-links to a row (extends `visibleCount` to reach the month, then scroll +
  flash-highlights it). The **Activity tab** makes its rows clickable through
  `SplitActivityFeed`'s `onEventClick`/`isEventClickable`/`myId` props — an expense event
  opens the edit dialog (fetching that month's chunk if it isn't loaded).
- **Celebrations**: creating a split expense (in-group dialog and the global
  quick-add) fires a ~1.5s checkmark badge-pop (an expanding ring ripple + a 6-dot
  burst, then a 450ms check draw), and a settle-up fires a ~1.5s canvas confetti
  burst, via `useCelebration()`
  (`src/components/providers/celebration-provider.tsx`) — two of the three sanctioned
  exceptions to the ≤250ms motion rule ([architecture.md](architecture.md#17-shared-ui-implementation-rules); the jiggle-mode
  wobble is the third). Under reduced motion `celebrate()` returns `false` and callers
  fall back to the flash-highlight row + toast.
- **New since last visit**: `UserPreferences.splitLastSeenAt?: Record<groupId, ISO>`
  is a per-group watermark written by `markSplitGroupSeen(groupId, seenAt)`
  (`src/lib/actions/split-groups.ts`; membership-checked,
  `markSplitGroupSeenSchema` ISO datetime, future-clamped, monotonic forward-only,
  spread-merged into the record). The detail page snapshots the watermark **at
  mount** (never updated during the visit) and marks rows created after it **by
  other members** with a primary dot (+ sr-only "New"); it persists the watermark
  forward via dwell-marking — `useDwellSeen` (`src/lib/hooks/use-dwell-seen.ts`, IO
  threshold 0.5, ~1.6s continuous dwell) feeds `computeSeenWatermark`
  (`split-utils.ts`, pure): a **contiguous frontier** from the newest row (own rows
  auto-pass; a never-on-screen row is never marked), debounced 2s with an unmount
  flush. A first-ever visit shows no dots and stamps the baseline to now. Accepted
  edges: your own off-page quick-adds self-dot until you open the group, and the
  watermark only considers loaded months.
- **Global quick-add FAB** (mounted in `app-layout.tsx`) opens the
  `entityType: 'split-expense'` drawer → `QuickAddSplitModal`
  (`quick-add-split-modal.tsx`): title + amount is enough — `quickAddSplitExpense`
  defaults to *you paid, split equally, today*, with `guessCategory` and
  "Save & add another". The **amount field is first and autofocused** (the daily-driver
  hot path is "enter a number"); `split-expense-dialog.tsx` mirrors the amount-first
  order and autofocuses amount only when creating. Accepts an optional `bankLink`
  (prefilled by the bank ledger's "Split this"); after a successful save the modal
  fire-and-forget calls `setDefaultSplitGroup` so the next quick-add preselects the
  last-used group.
- **Shared `<SplitEditor>`** (`split-editor.tsx`; logic in `src/lib/split-draft.ts`,
  unit-tested): the single "how to split" UI used by quick-add, group add/edit
  (`split-expense-dialog.tsx`) and recurring dialogs. Presets `me-equal` / `me-full` /
  `other-equal` / `other-full` plus **Custom** (pick payer; split by exact amounts or
  percentages). `resolveDraftSpec` maps the draft to the engine's `exact`/`percent`
  modes; members left blank **auto-absorb the remainder equally** (with two people, one
  entered value fills the other), with errors when entered values exceed the
  total / 100%. `draftFromExpense` / `draftFromSpec` rebuild the editor state for edit
  flows.
- `split-activity-feed.tsx` renders the cross-group feed (see Home, §4);
  `category-icon.tsx` maps categories to icons. Split categories are
  `SPLIT_CATEGORIES` in `src/lib/constants.ts` (mirrors Splitwise's set).

### Home Assistant notifications

Split mutations POST one JSON payload to a Home Assistant webhook, which fans it out
to the recipients' phones (HA owns the delivery policy; Sampolio owns the payload).
Engine: `src/lib/split-notify.ts` — a **plain server module, NOT `'use server'`**
(synchronous exports, and the transport must never become a client-invokable
endpoint). Emitted **post-response** through `after()` from `next/server` — the only
use of that hook in the codebase — so a slow or dead Home Assistant can never fail or
delay a save.

**Configuration.** `getSplitNotifyConfig()` needs `HA_WEBHOOK_URL` (the full webhook
URL, secret id included) **and** `AUTH_URL` (the deep-link base, trailing slash
stripped). Either missing/blank ⇒ null ⇒ the feature is hard-disabled with **zero
network calls**, mirroring `getBankConfig()`. See
[`docs/operations.md`](operations.md) §9.

**Events and their author.**

| Event | Raised by | `author` |
|---|---|---|
| `expense.created` | `createSplitExpense`, `quickAddSplitExpense` | the acting member |
| `expense.updated` | `updateSplitExpense` | the acting member |
| `expense.deleted` | `deleteSplitExpense` | the acting member |
| `payment.recorded` | `recordSettleUp` | the **recorder** (may differ from the payer) |
| `expense.generated` | `catchUpGroupRecurrences` (one per generated row) | the **rule's payer** (matches the row's `createdByUserId`) |

**Recipients and opt-out.** `recipients` = the group's members **minus the author**,
minus anyone who turned that event off. Each entry is `{ id, name, email }` (the
`author` object deliberately carries no email). The per-user opt-out lives in
`UserPreferences.splitNotificationPrefs?: Partial<Record<SplitNotifyEvent, boolean>>`
— **opt-out semantics**: an absent object, an absent key, or `true` all mean
*notify me*; only an explicit `false` disables (`isSplitNotifyEnabled`). No migration
was needed and new event types default to on. Preferences are read with the **plain**
db read (not the `'use cache'` wrapper — `after()` runs outside a reliable cache
scope). UI: Settings → General → **"Push notifications"** (both display modes) with
five toggles — New expenses / Edited expenses / Deleted expenses / Settle-ups /
Recurring expenses. `getSplitNotifyStatus()` tells the panel whether the server is
configured; when it isn't, an info `AlertBanner` says so and the toggles still save.

**Skip rules.** No POST at all when: the feature is unconfigured; `recipients` is
empty (a solo group, or every other member opted out — `buildSplitWebhookPayload`
returns `null`); or a **payment** row is deleted (`deleteSplitExpense` snapshots the
row first and only notifies for `kind === 'expense'`).

**Timeout & redaction.** One `fetch` per event, aborted after **5s**
(`SPLIT_NOTIFY_TIMEOUT_MS`). `postSplitWebhook` never rejects: a non-2xx logs
`Split webhook delivery failed ({event}): HTTP {status}`, a throw logs the event plus
the error's `name`. The **webhook URL is never logged** (it embeds the secret webhook
id) and neither is any payload content (names, emails, titles, amounts). Delivery is
best-effort — no retry, no queue, no delivery log.

**Payload contract.** `message` is prebuilt (fi-FI money via `formatCents`) so the HA
automation needs no formatting logic; `url` deep-links to the group.

```jsonc
{
  "event": "expense.created",          // one of the five above
  "ts": "2026-03-04T10:20:30.000Z",   // ISO event timestamp
  "message": "Alex added 'Groceries' — €42,50 in Flatmates",
  "url": "https://money.example.com/split/g1",
  "group":  { "id": "g1", "name": "Flatmates", "emoji": "🏠", "currency": "EUR" },
  "author": { "id": "a1", "name": "Alex" },
  "recipients": [
    { "id": "s1", "name": "Sam", "email": "sam@example.com" },
    { "id": "k1", "name": "Kim", "email": "kim@example.com" }
  ],
  // present for the four expense.* events only
  "expense": {
    "id": "e1", "title": "Groceries", "category": "Food",
    "amountCents": 4250, "currency": "EUR",
    "date": "2026-03-04", "source": "manual"   // 'recurring' for expense.generated
  },
  // present for payment.recorded only
  "payment": { "fromUserId": "s1", "toUserId": "a1", "amountCents": 4250, "currency": "EUR" }
}
```

Message shapes (single quotes around the title, em dash before the amount):

- `expense.created` — `{Author} added '{title}' — {amount} in {group}`
- `expense.updated` — `{Author} updated '{title}' — {amount} in {group}`
- `expense.deleted` — `{Author} deleted '{title}' — {amount} in {group}`
- `expense.generated` — `Recurring expense '{title}' — {amount} added in {group} (paid by {payer})`
- `payment.recorded` — `{Payer} paid {Payee} {amount} in {group}`, plus
  ` (recorded by {Author})` **only** when a third member logged it

An unknown member id renders as `Someone`. The pure builder + opt-out gate +
transport are unit-tested in `src/lib/split-notify.test.ts`.

## 2. Budgets (trip/project budgets with grant funding)

### Storage & access

A `Budget` is user-scoped and stored as **one encrypted document** at
`data/users/{id}/budgets/{id}.enc` with `lines`, `fundingSources`, and `expenseEntries`
embedded (`src/lib/db/budgets.ts`). One read/write per edit, one cache tag
`user:{userId}:budgets`. Actions in `src/lib/actions/budgets.ts` load via
`loadOwnBudget` (session user only).

### Pure engine (`src/lib/budget-utils.ts`)

- `expandBudgetLines` expands one-off lines (their `month`, clamped into the period)
  and monthly lines (their `startMonth…endMonth` range, clamped) into per-month costs.
- `allocateFunding` — deterministic greedy allocation of funding to planned costs:
  **restricted** sources (`restrictedToCategories` non-empty) go first, most
  constrained first (fewest allowed categories, ties by list order); each walks its
  allowed categories by **descending uncovered cost** (ties alphabetical). A restricted
  source's leftover is `unusableSurplus` — it can never pay other categories and is
  never netted against out-of-pocket. Unrestricted sources then fill remaining costs the
  same way; their surplus stays usable. (Deliberately greedy, not max-flow — see the
  function comment.)
- `expandFundingReceipts` — when usable money arrives: `upfront` → first month;
  `monthly` → even split across the period; `specific-month` → that month (clamped).
- `computeFeasibility(budget)` → `{ totalCosts, totalFunding, usableFunding,
  unusableSurplus, outOfPocket, freeSurplus, allocation, perMonth[] }` where
  `outOfPocket = max(0, totalCosts − usableFunding)` and each `BudgetMonthRow` carries
  planned costs, funding received, net, and cumulative net. Computed client-side on the
  budget page and server-side for injection.
- `computeActualsRollup` — planned vs. actual per category and claimed vs. usable per
  funding source, from the expense log. **Entries dated outside the period still
  count** ("real trips bleed at the edges").
- `computeBudgetTransfers(budget)` — the injected lines (below), converted by
  `budget.exchangeRate ?? 1`.

**Per-diem sources** always store `amount = perDiemRate × perDiemDays`
(`calcPerDiemTotal`; recomputed by `withPerDiemAmount` on every save in the actions).

**Trip-funded per-diem sources** (`BudgetFundingSource.linkedTripId?`): a per-diem
funding source can instead draw its amount from a linked `Trip`'s live per-diem total.
The funding schema requires **rate + days XOR `linkedTripId`**, and rejects
`linkedTripId` on any non-per-diem funding type. The stored `amount` is a write-time
snapshot; `hydrateBudgetFundingFromTrips(budget, trips)` (pure, `budget-utils.ts`)
re-derives it from `calculatePerDiem(trip).total` at **read time** in `getBudgets` /
`getBudgetById` and in `getBudgetTransfersForAccount` — a missing/deleted trip leaves
the stored snapshot standing. Linking requires **`budget.currency === 'EUR'`**, and a
trip funds **at most one budget** (`resolveTripLinkedAmount` scans every budget's
funding sources; conflict → a curly-quote "already funds …" error). The funding dialog's
per-diem editor offers a `SelectButton` "From a trip | Manual rate × days"; the trip
options show live per-diem totals, already-linked trips are disabled, and picking one
prefills the source name + `specific-month` timing at the trip's reimbursement month. A
**"New trip" button** in trip mode creates a trip without leaving the budget: it opens
`TripDialog` layered over the funding dialog, prefilled from the budget (name,
`linkedAccountId`, reimbursement month = `budget.endMonth`; `TripDialog` takes an
optional create-only `initial` prop and its `onSaved` passes the created `Trip`
through); on save the funding dialog auto-selects the new trip and refreshes the page's
trips list via `onTripsChanged`. A funding row shows "from trip: {name}" deep-linked to
`/budgets#trips` (amber hint if the trip was deleted), and the `TripCard` shows a
"Funds: {budget}" tag.

**Double-count guard**: a trip whose per-diem already reaches cashflow through a budget
must NOT also inject its own `source: 'trip'` reimbursement income —
`tripIdsFundedByActiveBudgets(budgets)` (confirmed && `!isArchived` && `linkedAccountId`
&& a per-diem source with `linkedTripId`) is subtracted inside
`getTripTransfersForAccount`. A draft or archived budget doesn't suppress the trip
(the money isn't reaching cashflow yet, so the trip keeps injecting). The
`confirmBudget` toast mentions the handoff, and deleting a trip that funds a budget warns.

### Confirm / unconfirm & cashflow injection

`status: 'draft' | 'confirmed'` is changed **only** by `confirmBudget` /
`unconfirmBudget`. `confirmBudget(budgetId, { linkedAccountId, exchangeRate? })`
requires the budget to be unarchived and — when the budget currency differs from the
account currency — a positive `exchangeRate` (`1 budget unit = X account units`).
`unconfirmBudget` reverts to `'draft'` but keeps `linkedAccountId`/`exchangeRate` so
re-confirming is one click. `updateBudget` refuses a currency change that would leave a
confirmed, linked budget without a rate.

`getBudgetTransfersForAccount` (`src/lib/projection-inputs.ts`) selects budgets with
`status === 'confirmed' && !isArchived && linkedAccountId === accountId` and injects up
to **2 aggregated read-only lines per month** (one expense = planned costs, one income =
usable funding received; amounts > 0.005 only) as the 8th parameter of
`calculateProjection` — rendered with `source: 'budget'` and deep-linking to
`/budgets/{id}`. Errors never break the cashflow projection. Elapsed confirmed months
disappear behind the reconciliation anchor naturally — see
[projections-and-reconciliation.md](projections-and-reconciliation.md).

**Regular income** (`includeRegularIncome`) is pulled into the budget page
**display-only** via the existing `getProjection` (excluding `source === 'budget'`
lines); it never enters the out-of-pocket math and is never injected back — no double
counting by construction.

### Expense log & CSV export

`BudgetExpenseEntry.date` is a plain `'YYYY-MM-DD'` string (month = `date.slice(0, 7)`,
never `new Date()` parsing). Exports (`src/lib/budget-csv.ts` on top of
`src/lib/csv-utils.ts`): `buildExpenseLogCsv` (itemized spending log with a total row)
and `buildBudgetSummaryCsv` (planned vs. spent per category + funding-source section).
`toCsv` emits **semicolon delimiter + UTF-8 BOM + CRLF + comma decimals**
(`formatCsvNumber`) so files open correctly by double-click in fi-FI Excel;
`downloadCsv` triggers the browser download.

Budget UI categories come from the short `BUDGET_CATEGORIES` list in
`src/lib/constants.ts` (Accommodation, Travel, Local transport, Food, Insurance, Fees,
Equipment, Other) — not the cashflow `ITEM_CATEGORIES`.

### UI

`/budgets` is the merged **"Trips & Budgets"** page (nav entry `budgets`, label
"Trips & Budgets", `MdLuggage`): two stacked sections — Trips first
(`src/components/trips/trips-section.tsx`, `<section id="trips">`) then Budgets
(`src/components/budgets/budgets-section.tsx`, `<section id="budgets">`, the budget
list with `budget-card.tsx`) — fetched together (`Promise.all([getBudgets, getTrips,
getAccounts])`, one `loaded` flag + refresh callback). `/budgets/[id]` is the
single-page budget editor, unchanged. Components in `src/components/budgets/`:
`budget-setup-wizard.tsx` (4 steps: "The plan",
"What it costs", "Who's paying", "Does it add up?"; templates in
`budget-templates.ts`), `budget-verdict-card.tsx` (feasibility headline),
`budget-coverage-bars.tsx`, `budget-vs-actual-bars.tsx`, `budget-month-chart.tsx`,
`budget-expense-log.tsx`, `budget-confirm-dialog.tsx`, `budget-export-dialog.tsx`,
`budget-dialogs.tsx` / `budget-panels.tsx` (line/funding editors).

## 3. Goals

Financial targets tracked against a projection, surfaced at **`/goals`**
(`src/app/(dashboard)/goals/page.tsx`): a budgets-style card grid with a
`ProgressBar`, on-track/behind/achieved `Tag`, projected reach date, archived
toggle, and a create/edit dialog (`src/components/goals/goal-dialog.tsx`, RHF +
`zodResolver(goalSchema)`; the account dropdown appears for `account-balance`
goals — `goalSchema` superRefines `linkedAccountId` required then — and a manual
amount input for `manual` goals). Nav entry `goals` in `nav-config.tsx`
(`MdFlag`; with the default tabs it lands in the mobile "More" drawer in Advanced
mode, while in Simple mode it is one of the four default bottom tabs, replacing
Overview — see `DEFAULT_BOTTOM_NAV_IDS_SIMPLE` in `src/lib/bottom-nav-prefs.ts`;
either way a user can put it on the bottom bar from Settings → General → Mobile
navigation) and a `nav-goals` command in the command palette.

**Goal type**: every goal is either a **reserve** (default; money set aside and
kept — never removed from a projection) or a **spend** goal (an amount you plan to
actually spend at the target date). A spend goal tracked against an account
balance, with a target date, may opt into **`injectIntoCashflow`**: the target
amount is then injected as a real read-only expense line (`Goal: {name}`, category
`Goals`, `source: 'goal'`) in the linked account's cashflow at the target month —
see `getGoalTransfersForAccount` in
[projections-and-reconciliation.md](projections-and-reconciliation.md) §5. The
single predicate deciding whether a goal injects,
`goalInjectsIntoCashflow(goal)` (`src/lib/goal-utils.ts`), is shared by that
gatherer and the goal-plan engine below — it requires `goalType === 'spend'`,
`injectIntoCashflow: true`, a `targetDate`, `trackingMethod ===
'account-balance'`, a `linkedAccountId`, and not archived.

**Priority & the joint funding plan**: an optional `priority` (lower funds
first; unset sorts after every prioritized goal, ordered by target date, then
name — `compareGoalsForPlan`) lets goals that compete for the same money queue
up realistically instead of each pretending it has the whole pool to itself.
Active goals are planned jointly by `computeGoalPlan(goals, cashProjections,
wealthProjections)`:

- **Pools**: an account-balance goal draws on its linked account's balance;
  a net-worth goal draws on total net worth. **Every** non-manual goal's claim
  (its `targetAmount`, held as a constant reservation) also reduces the
  net-worth pool — an account reservation is spoken-for wealth at the
  whole-net-worth level too, so a net-worth goal sees less headroom once an
  earlier account-balance goal has claimed its share.
- **The double-claim guard**: an injecting goal's claim drops to **0** from its
  target month onward — by then the expense line has already removed the money
  from the projection, so reserving it again would double-count it. The
  injecting goal's own evaluation, symmetrically, **adds its target amount
  back** for months at/after the target date, so its own feasibility is judged
  against the pre-spend balance.
- Manual goals are **standalone** — no pool, no claims, unaffected by (and
  invisible to) the plan.
- Each `GoalPlanEntry` also carries `competingGoalIds` (earlier goals sharing a
  pool), `claimedAheadNow`, and `requiredMonthlySaving` (`max(0, targetAmount −
  currentAmount) / monthsUntil(targetDate)`, `null` with no target date, once
  already reached, or `targetDatePassed: true`). `GoalCard` surfaces these as an
  "After N other goal(s)" caption and a "Save ~€X/mo…" line.

Archived goals are **not** planned jointly (no claims to reason about) and keep
the standalone `calculateGoalProgress` path.

**Progress data is assembled client-side**: `getProjection(accountId)` is called
for every account an active goal links, and `fetchWealthProjectionMonths`
(`src/lib/wealth-assembly.ts` — the Overview wealth assembly extracted into a
reusable client helper) runs whenever **any** active non-manual goal exists (an
account-balance goal's claim needs the net-worth pool too, not just net-worth
goals). A goal whose linked account no longer exists shows a warning on its card
(progress 0). Amounts display in the goal's currency, no conversion. The backend:

- **Type** `Goal` (`src/types/index.ts`): `targetAmount`, `currency`,
  `targetDate?: string` (**`YYYY-MM`**), `trackingMethod`, `linkedAccountId?`,
  `currentManualAmount?`, `goalType?: 'reserve' | 'spend'` (readers default
  missing to `'reserve'` — **no migration of stored goals**), `priority?: number
  | null`, `injectIntoCashflow?: boolean`, `isArchived?`, plus
  `CreateGoalRequest` / `UpdateGoalRequest`.
- **DB** (`src/lib/db/goals.ts`): one file per goal at
  `data/users/{id}/goals/{id}.enc`; `getGoals` returns goals **sorted by name**
  (archived ones included).
- **Cached queries**: `cachedGetGoals` / `cachedGetGoalById` in `src/lib/db/cached.ts`,
  tag `user:{userId}:goals`.
- **Actions** (`src/lib/actions/goals.ts`): `getGoals`, `getGoalById`, `createGoal`,
  `updateGoal` (accepts `isArchived`), `deleteGoal` — standard auth + Zod + `updateTag`.
  The action-layer Zod schemas mirror the client `goalSchema`'s `superRefine`:
  `injectIntoCashflow: true` requires `goalType === 'spend'`, a `targetDate`, and
  `trackingMethod === 'account-balance'`, or the request is rejected server-side
  even if a client bypasses the form. Clearing `priority` must send `null`
  (`.nullable()`) — `undefined` is dropped by server-action serialization.
- **Form schema**: `goalSchema` in `src/lib/schemas/goal.schema.ts` (no
  schema-level `.default()` on `goalType` — that would diverge zod's input/output
  types and break the RHF resolver's inference; the dialog always sends an
  explicit value).
- **Pure engine** (`src/lib/goal-utils.ts`):
  - `calculateGoalProgress(goal, cashProjections?, wealthProjections?)` →
    `{ currentAmount, targetAmount, percentComplete (clamped [0,100]),
    projectedAmountAtTarget, onTrack, projectedDate }`. Tracking methods:
    - `'manual'` — `currentAmount = currentManualAmount`; on-track ⇔ 100%;
    - `'account-balance'` — reads the linked account's monthly projections
      (current = first month's `startingBalance`; `projectedDate` = first month
      whose `endingBalance ≥ target`);
    - `'net-worth'` — same logic against `WealthProjectionMonth.netWorth`.
  - `goalInjectsIntoCashflow(goal)` — the injection predicate (see above).
  - `compareGoalsForPlan(a, b)` — the joint-plan ordering (see above).
  - `computeGoalPlan(goals, cashProjections, wealthProjections): { entries:
    GoalPlanEntry[] }` — the joint funding plan (see above). Caller passes
    **active** goals only.

  Goals only **read** projections for their own progress computation; the one
  exception is an injecting spend goal, which **writes back** a real expense
  line via `GoalTransfer` (§5 of
  [projections-and-reconciliation.md](projections-and-reconciliation.md)) —
  every other goal type/mode still never feeds back into the cashflow/wealth
  engines.

## 4. Trips (Vero.fi per-diem calculator)

Tax-exempt per-diem allowances for business travel, surfaced as the **Trips section
of the merged "Trips & Budgets" page at `/budgets`**
(`src/components/trips/trips-section.tsx`, `<section id="trips">`, rendered above
the Budgets section; `/trips` is a server `redirect('/budgets')` for old links and
stays in `PROTECTED_PREFIXES`): a Goals-style card grid (name, destination,
departure→return date/time + duration, status `Tag`, per-diem total, linked
account, reimbursement month, quick status-advance button) with a collapsed
"reimbursed" section, and a create/edit dialog
(`src/components/trips/trip-dialog.tsx`, RHF + `zodResolver(tripSchema)`) plus a
presentational `PerDiemBreakdown` component. There is no separate `trips` nav entry
(the `budgets` entry covers both; hidden in Simple mode — reachable from Home's
feature grid); the command palette keeps a `nav-trips` command ("Go to Trips (per
diem)") routing to `/budgets`, and cashflow `trip` lines deep-link to
`/budgets#trips`.

**The rules** (Finnish Tax Administration decision VH/6575/00.01.00/2025,
implemented in `src/lib/per-diem-utils.ts` against the euro amounts in
`src/lib/per-diem-rates.ts`):

- The trip is measured from departure to return date/time
  (`computeTripHours` — parses both as **local** date/times and diffs epoch ms at
  minute precision; a trip crossing a DST transition is off by ±1h from the literal
  wall-clock span, an accepted simplification). Each full 24h slice from departure
  is a "travel day" earning a **full** per diem at that slice's country rate
  (domestic €54, else that country's listed rate, or €52 for an unlisted
  destination).
- The trailing remainder slice (R hours left over):
  - **No full day at all** (whole trip < 24h), domestic: R > 10h → full (€54);
    R > 6h → partial (€25); else nothing.
  - **No full day at all, foreign**: R ≥ 10h → the country's full per diem (§13:
    "lasting a minimum of 10 hours"); under 10h the **domestic** provisions and
    amounts apply instead (R > 6h → domestic partial €25); else nothing.
  - **≥ 1 full day, remainder lands back in Finland**: R ≥ 2h → extra partial
    (€25); R > 6h → extra full (€54) instead (checked full-first, since R > 6h
    implies R ≥ 2h).
  - **≥ 1 full day, remainder abroad**: R > 10h → full country rate; R > 2h → half
    the country rate (`half-foreign`); else nothing.
- **Free meals**: a full or half-foreign day is halved at 2+ free meals (§13
  defines foreign "free meals" as two meals); a domestic partial day is halved at
  1+ free meal (§12). A per-day manual `overrideAmount` always wins, applied
  after the meal reduction.
- Each day is rounded to cents; the trip total is the sum.

**Per-day country attribution & simplifications**: `TripDay.countryCode` is
editable per day (a `Dropdown` in the day editor) — the day list defaults every
full slice to the trip's `destinationCountry` and the remainder slice to the last
full day's (possibly edited) country, or the destination when there's no full
day (`generateTripDays`), but a multi-leg trip is modeled entirely through these
per-day overrides, not a route. There's no kilometre/mileage allowance — only the
daily per-diem. `generateTripDays` re-runs on every start/end/destination change
and preserves existing per-day edits (country/meals/override) by matching the new
slice's calendar date against the old one, falling back to the same slice index
when dates shifted (a simple, deterministic rule, not a diff/merge).

**Rate snapshotting**: every `Trip` stores the rates in effect at creation
(`TripRateSnapshot`: `domesticFull`, `domesticPartial`, `defaultForeign`,
`countryRates`), prefilled from `buildDefaultRateSnapshot()`
(`src/lib/per-diem-rates.ts`) on create and editable in a collapsed "Per-diem
rates" panel in the dialog — so a later year's rate-table update never
retroactively changes an already-planned or already-reimbursed trip.

**Cashflow injection**: a trip with `status !== 'reimbursed'` injects
`calculatePerDiem(trip).total` as a read-only `source: 'trip'` income line
("Per diem: {name}") in its linked account's cashflow at
`expectedReimbursementMonth` — see `getTripTransfersForAccount` in
[projections-and-reconciliation.md](projections-and-reconciliation.md) §5.
Advancing status to `'reimbursed'` (a one-click action on the trip card) stops the
injection; the card surfaces that consequence as a hint the moment a trip is
marked `'completed'`. A trip whose per-diem is **already funded through an active
(confirmed, account-linked) budget** via `linkedTripId` also stops injecting its own
line — the guard `tripIdsFundedByActiveBudgets` in `getTripTransfersForAccount` (see
§Budgets → "Double-count guard") — so the budget's funding-income line isn't
double-counted. The backend:

- **Type** `Trip` (`src/types/index.ts`): `destinationCountry`, `startDateTime` /
  `endDateTime` (**`YYYY-MM-DDTHH:mm`**, local), `days: TripDay[]`, `rates:
  TripRateSnapshot`, `linkedAccountId`, `expectedReimbursementMonth` (**`YYYY-MM`**),
  `status: 'planned' | 'completed' | 'reimbursed'`, `notes?`, plus
  `CreateTripRequest` / `UpdateTripRequest`.
- **DB** (`src/lib/db/trips.ts`): one file per trip at
  `data/users/{id}/trips/{id}.enc`; `getTrips` returns trips sorted by
  `startDateTime` descending (newest first).
- **Cached queries**: `cachedGetTrips` / `cachedGetTripById` in
  `src/lib/db/cached.ts`, tag `user:{userId}:trips`.
- **Actions** (`src/lib/actions/trips.ts`): `getTrips`, `getTripById`,
  `createTrip`, `updateTrip`, `deleteTrip` — standard auth + Zod + `updateTag`.
- **Form/action schema**: `tripSchema` / `updateTripSchema` in
  `src/lib/schemas/trip.schema.ts` (day/rate-snapshot sub-schemas; refines
  `endDateTime > startDateTime`).
- **Pure engine** (`src/lib/per-diem-utils.ts`, unit-tested): `computeTripHours`,
  `computeSliceCount`, `generateTripDays`, `resolveDayRate`, `calculatePerDiem(trip)
  → { days: TravelDayBreakdown[], total }`.

Trips only **write** into the cashflow projection via this one injected income
line — there's no other read-back, and (unlike Goals) there's no joint-funding
plan to reason about since a per-diem total is a fixed, self-contained
computation rather than a pool claim.

## 5. Home dashboard (`/`)

`src/app/page.tsx` is a server component: it `auth()`-guards (redirects to
`/auth/signin`) and **wraps `AppLayout` itself** — the root route sits outside the
`(dashboard)` route group, so it doesn't get the group layout's wrapper. It renders
`HomeDashboard` (`src/components/home/home-dashboard.tsx`, client), which shows:

- a **bank-connection attention banner** (`BankAttentionBanner`, shared with Overview's
  `BannerStack` — see [bank-sync.md](bank-sync.md) §11) when a connection needs attention
  (expired/expiring consent or a failing sync), fetched independently via
  `getBankConnectionsNeedingAttention` so it never delays the glance; its action button
  routes to `/bank`, where the "Renew consent" button lives;
- a **top glance row** — bank balances first, the projection beside them:
  - an **"Accounts & cards" strip**: compact per-account tiles (2-col grid) from the
    `getHomeBankGlance` action — every non-excluded bank link with at least one
    transaction in the last 30 days (`txDisplayDate`, any status — a pending row counts
    as activity); cash/savings tiles show `lastBalance` (negative in red), card tiles
    show live used amount `/ limit` (`effectiveCardNumbers`) with a thin used-ratio bar
    (amber at ≥80%; no bar when no limit is known). Tiles link to `/bank`, follow the
    user's `bankAccountOrder`, format each in its own currency (no aggregate), and the
    strip disappears entirely when bank sync is unconfigured or nothing was active;
  - the **"this month" glance tile**: the primary account's projected end-of-month
    balance + a one-line sentiment ("You're on track" / spending-more-than-earning /
    ends-in-the-red), computed from `getProjection` for the first non-archived account
    (fetched independently so it never blocks the split data). Beside the strip it
    renders compact (`sm:w-64`); with no strip it reverts to full width. Tapping it
    opens a **plain-words breakdown dialog** (starting balance + income − spending =
    expected end balance, with an Overview link inside). The region's skeleton waits
    for the bank fetch too — the row's geometry depends on whether bank rows exist;
- a greeting (adding a shared expense happens via the global quick-add FAB — see
  §1 — which is always visible on Home);
- one merged **Split card**: an overall-position line from `aggregatePairwiseNets`'
  `totalByCurrency` (single currency → colored owed/owe amount; several → a neutral
  "Balances across multiple currencies" — never a naive cross-currency sum), an
  "All groups" link, per-group **tiles** in a 2-col (3-col ≥sm) grid (emoji, name,
  counterparty avatar, "you're owed / you owe €X" phrase that wraps rather than
  truncates), then a divided **Recent activity** section: `getSplitActivity(5)` (reads
  only each group's newest ~3 month chunks) rendered by `SplitActivityFeed`
  (`emptyText="No recent activity"`), showing each actor's `<UserAvatar>` and
  `added by {actorName}` ("added by You" for own rows); clicking an event navigates to
  its group;
- a **feature grid** built from the shared `navItems` (minus `home`).

On mount it also runs `catchUpGroupRecurrences` for every group (cheap no-op when
nothing is due) and registers itself as the AppContext refresh callback.

## 6. Overview (`/overview`)

`src/app/(dashboard)/overview/page.tsx` (client component) is the wealth dashboard; its
own `AGENTS.md` in the same directory has the full breakdown. Summary:

- **KPI tiles**: net worth = cash + investments + receivables − debts − card
  liabilities + mortgage equity + split net. Rendered with the shared `KpiTile`
  (`src/components/ui/kpi-tile.tsx`; zero-delta badges suppressed) in **grouped
  sections** — Net / Assets / Debts & liabilities (`KpiGroup`,
  `src/components/overview/kpi-group.tsx`, 2-col grid on mobile). In **Simple mode**
  only Net Worth + Cash show, behind a "See all balances" expander; jargon-y tile
  titles use their plain-language wording there (`plainTerm` from
  `src/lib/plain-language.ts`, e.g. Receivables → "Money owed to you"), and dense
  tiles carry a `HelpHint` "?" tooltip in both modes. Clicking the **Net Worth tile**
  opens `NetWorthExplainDialog` (`src/components/overview/net-worth-explain-dialog.tsx`),
  a plain-words row-by-row breakdown whose rows mirror the net-worth sum exactly.
  Cash uses each
  account's **latest snapshot balance** (bank-sync or manual reconciliation, via
  `getLatestSnapshot('cash-account', …)`) with `startingBalance` as fallback
  (`cashCurrentBalances`). A **"Credit cards"** tile (negative, from
  `getCardLiabilities`) appears when outstanding > 0, with an available-of-limit
  subline + utilization bar when the bank exposes limits; a **"Split balance"** tile
  appears when the net ≠ 0 (see §1) — under Assets when positive, under Debts when
  negative. Clicking a tile opens the `EntityListDrawer`
  (`src/components/ui/entity-list-drawer.tsx`) for create/edit/archive.
- **Wealth distribution bar** ("Where your wealth sits", `WealthDistribution` in
  `src/components/overview/wealth-distribution.tsx`): a slim CSS segmented bar + legend
  below the KPI tiles showing how the current asset total splits across Cash,
  Investments, Receivables, Home equity and a positive Split balance — colored from the
  shared `WEALTH_COLORS` map, `role="img"` with a generated `aria-label` (no
  `ChartExplain`, since it is not a canvas chart), shown in **both** display modes, with
  a footer sentence reconciling assets minus debts/cards/owed-split to the Net Worth KPI.
- **Banners** (all via the shared `AlertBanner` in `BannerStack`,
  `src/components/overview/banner-stack.tsx`): monthly **check-in due** (no snapshot
  for the current month, or months behind the last one — opens the reconciliation
  wizard; can be turned off via `UserPreferences.checkInRemindersEnabled` in
  Settings → General → Reminders, for bank-synced users who rarely need manual
  check-ins), **Euribor due** (`isEuriborUpdateDue`, see [mortgage.md](mortgage.md)),
  and **bank consent renewal** (`getBankConnectionsNeedingAttention`, deep-links to
  `/settings?tab=banking` — see [bank-sync.md](bank-sync.md)). The Overview header's
  "Monthly check-in" button is the primary check-in affordance, but it **hides while
  the check-in reminder banner shows** (`isCheckInBannerVisible`) so there is a single
  entry point; it is deliberately **not** in the sidebar/top-bar chrome (still
  reachable via ⌘M and the command palette).
- **Net-worth projection chart**: a **Total assets / Liquid** `SelectButton`
  (`wealthScope`, default `total`) plus a toggle between net-worth-only and
  breakdown series, horizon selector `6M / 1Y / 3Y / 5Y` (default `1y`).
  `WealthChart` (`src/components/charts/wealth-chart.tsx`) draws **stacked bands**
  per scope — total: Cash, Investments, Receivables, Home value (assets) /
  Debts, Credit cards, Mortgage (liabilities); liquid: Cash, Investments, Debts,
  Credit cards — plus a **Net worth line overlay** (Chart.js's legend is the
  chart's only legend, shown in both modes; there is no separate hard-coded HTML
  legend), omitting any all-zero series. `net-worth-chart.tsx` reuses the shared
  `WEALTH_COLORS` / `wealthCategoriesForScope()` / `computeScopedNetWorth()`
  exports from `wealth-chart.tsx`; its tooltip enumerates every in-scope
  non-zero category.
- **This-month impact panel**: top income/expense lines for the current month; account
  balance lines use the same `cashCurrentBalances` values as the Cash KPI.
- Mortgage equity/liability come from running `calculateMortgageProjection` for the
  member's active mortgages and folding positions into the wealth projection
  (`mortgageProjections` + `currentUserId` guard in `src/lib/wealth-projection.ts`).

## 7. Onboarding wizard & command palette

- **Onboarding** (`src/components/onboarding/onboarding-wizard.tsx`): five steps —
  Welcome, Cash Account, Income (either a "Simple Amount" or a "Full Salary" config;
  the salary rates **prefill from `UserPreferences.taxDefaults`**, with "not sure?
  pick Simple Amount" guidance), Expenses, Done. The Done step asks **"How much
  detail do you want to see?"** and persists the answer as the display mode
  (`setDisplayMode`); finishing lands on Home (`/`). Creates the first account plus
  starter recurring items.
- **Command palette** (`src/components/ui/command-palette.tsx`): navigation commands
  `nav-home`, `nav-split`, `nav-overview`, `nav-cashflow`, `nav-mortgage`,
  `nav-budgets` ("Go to Trips & Budgets"), `nav-goals`, `nav-trips` ("Go to Trips
  (per diem)" — routes to `/budgets`, same as `nav-budgets`), `nav-bank`,
  `nav-playground`, `nav-settings` (each with a path in the
  `executeCommand` `paths` map) and action commands `action-reconcile`,
  `action-add-income`, `action-add-expense`, `action-add-split-expense`, plus a dynamic
  `dynamic-add` entry. New pages must add both a `nav-config.tsx` entry and a palette
  command (see root `AGENTS.md`, "Adding things").

## 8. Playground ("What If?", `/playground`)

Ephemeral scenario explorer: `runScenarioProjection` (`src/lib/actions/scenario.ts`)
clones the live projection inputs, applies the requested modifications
(`add-income` / `add-expense` / `remove-item` / `modify-amount`; an `add-*` mod may
carry `isOneOff`/`scheduledDate` to model a one-off event), and runs the real
engine twice — nothing is persisted and no cache tag exists. Engine details in
[projections-and-reconciliation.md](projections-and-reconciliation.md). The page
(`src/app/(dashboard)/playground/page.tsx`, subtitle "Test changes against your real
plan — the same account, income, and bills as your Cashflow — without saving
anything.") adds the account picker, the modification form, and the
current-vs-modified delta view on top, plus:

- **Templates over real items**: besides the add-income/add-expense templates,
  "Cancel an existing expense" and "Change an item's amount" fetch the account's
  real recurring + planned items into a grouped Dropdown and emit
  `remove-item`/`modify-amount` mods.
- **One-off events**: the frequency picker's "Once" option + a month picker send
  `isOneOff: true`/`scheduledDate` ('YYYY-MM'); `applyScenarioModifications` turns
  those into a synthetic one-off `PlannedItem` (`scenario-…` id) instead of a
  recurring item.
- **Staged changes**: "Add another change" stacks 2–3 modifications (chips with
  remove) so one run can answer "raise **and** a new car payment"; a filled form
  joins the run implicitly, keeping the single-change flow one tap.
- **Comparison chart**: a lazy ECharts "Balance over time" line chart
  (`src/components/charts/scenario-comparison-chart.tsx`) draws the dashed Current
  plan vs the solid With-changes series over the full horizon, with a dashed zero
  markLine and a red null-gapped overlay series tracing below-zero stretches
  (deliberately **not** an ECharts `visualMap`, which ECharts 6 applies unreliably
  to 1-D line data).
- **KPIs**: end balance current/modified/difference plus a **"Lowest point"** tile
  (minimum `endingBalance` + its month, red when below zero).
- **Recent runs**: a session-local list of the last 5 runs' labels + end-balance
  deltas for quick comparison (component state only — nothing stored).
- **"Add to my plan"**: after a run, each staged `add-income`/`add-expense` gets a
  button that materializes it as a real item — recurring via `createRecurringItem`
  (start month = current), or a one-off via `createPlannedItem` — with a toast and
  the AppContext refresh.

## 9. Data-integration conveniences

- **Recurring-transaction suggestions** (`/bank`): `detectRecurringCandidates`
  (`src/lib/recurring-detection.ts`, pure/tested — ≥3 consecutive months, day ±3,
  amount ±20% of median, one charge/month, no matching tracked item by name or
  amount, and **still recurring**: the latest occurrence must be in the current
  or previous month, else the pattern is treated as stopped and skipped)
  drives `getRecurringSuggestions(accountId)` (`src/lib/actions/bank.ts`,
  which also feeds the account's injected mortgage-transfer amounts (last 12
  months, via `getMortgageTransfersForAccount`) into the existing-item matcher
  so the monthly mortgage payment is never proposed — it's already in the plan
  as a `mortgage-payment` line,
  computed on demand from cached reads). `RecurringSuggestions`
  (`src/components/bank/recurring-suggestions.tsx`) renders "Track this?" cards:
  one tap creates the real recurring item; Dismiss is per-device
  (localStorage `sampolio-dismissed-suggestions`).
- **"Split this" from a bank row** (`/bank` ledger): spend rows get a Split-this
  action — a desktop column and, on mobile, a button that's a **sibling** of the
  row's expand chevron (visible without expanding; nested buttons are invalid
  HTML) — that opens `QuickAddSplitModal` prefilled (`initial` prop: title =
  counterparty, amount, date, `guessCategory`, plus `bankLink` so the created
  expense is linked back to the transaction — see §1 "Bank-transaction linking")
  — hosted inside `bank-ledger-table.tsx`, no drawer plumbing. Already-linked or
  heuristically-matched rows show an "already split" flag pill instead.
- **Plan check card** (Overview): `PlanCheckCard`
  (`src/components/overview/forecast-vs-actual-card.tsx`, purely presentational — the
  page passes the primary account's `monthly` + `retrospective` from its existing
  `getProjection` calls) with two views behind a month toggle, default via
  `pickDefaultView`. **Last month**: `comparePlanToActual`
  (`src/lib/forecast-vs-actual.ts`, pure/tested) joins the *recurring* part of the
  current plan (one-off planned items and injected card/mortgage/budget lines
  excluded; past forecasts aren't stored) with the last retrospective month's actuals
  by category — actual lines re-categorized from merchant names via
  `guessItemCategory`, card-settlement lines dropped symmetrically with the plan side.
  Top-4 off-plan rows render worded verdicts ("€X more/less than planned"), a bullet
  bar (actual fill, plan tick) and expand to the actual merchant lines; on-plan count
  and unmatched-spend footers close the view (`onPlanTolerance` = max(€5, 3% of
  planned)). **This month**: `summarizeMonthProgress` over the actualized current
  month — "€X of €Y" progress per category, never judged, expanding to per-item
  paid/"€X left" tags. Hidden only when there's neither a retrospective nor an
  actualized month.
- **Euribor prefill**: `fetchCurrentEuribor12m()` (`src/lib/actions/euribor.ts`)
  fetches the latest 12-month Euribor from the ECB Data Portal
  (series `FM.M.U2.EUR.RT.MM.EURIBOR1YD_.HSTA`, csvdata, 5s timeout, 6h in-memory
  TTL, always-graceful failure) and prefills the Euribor dialog's rate while the
  field still holds its opening default, with a "Prefilled from ECB Data Portal —
  confirm before saving" note. Never auto-applies.
- **Check-in notification** (opt-in): `UserPreferences.checkInNotificationsEnabled`
  (Settings → General → Reminders, "Also notify on this device"; requests
  Notification permission on enable). `CheckinNotifier`
  (`src/components/providers/checkin-notifier.tsx`, mounted in AppLayout) shows one
  local notification per month (`sampolio-checkin-notified-YYYY-MM` in
  localStorage) via the service worker when the check-in is due (`isCheckInDue`,
  `src/lib/checkin-utils.ts` — shared with the Overview banner); `public/sw.js`
  has a `notificationclick` handler opening `/overview`. No push service.
- **Budget ↔ split link**: see §Budgets (`linkedSplitGroupId`) — the viewer's share
  of a linked group's expenses in the budget period renders read-only via
  `buildSplitBudgetEntries` (`src/lib/budget-utils.ts`); never persisted, never in
  feasibility/cashflow math.

## 10. Demo mode (UI-only money masking)

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
  (before returning JSX) from `demoMode`, so the first paint after a toggle already formats
  correctly. `demo-mode.ts` has **zero imports** so `constants.ts` can import it without a cycle.
- **Persistence is per-device** localStorage (`DEMO_MODE_STORAGE_KEY = 'demo-mode'`), NOT a
  `UserPreferences` field — it's about the screen you're showing, not the account. AppLayout also
  listens for `storage` events, so toggling in one tab/window (e.g. the installed PWA) updates
  every other open tab of the origin.
- **No exempt pages**: every page masks, `/mortgage` and `/split` included.
- **NOT masked**: `formatRate`, input fields, and CSV/JSON exports (only display formatting).
- **Chart-memo dep + remount-key rule** (future code must follow): any ECharts `option` `useMemo`
  that calls `formatCurrency` MUST list `demoMasked` (`useAppContext().demoMasked`) in its deps,
  AND the `<ReactEChartsCore>` element carries `key={demoMasked ? 'masked' : 'plain'}` so a toggle
  remounts the instance — a fresh option/instance is the only guarantee that no internally-cached
  label or tooltip string survives the flip. Done for monthly-flow, cashflow-waterfall,
  expense-treemap, scenario-comparison, split-spend, split-net, mortgage-sankey (Chart.js charts
  rebuild options during render and their tooltip callbacks read the flag at hover time — no key
  needed).
- **Memoized-widget remount-key rule** (future code must follow): PrimeReact components with
  memoized internals won't re-run `formatCurrency` on a bare re-render, so any long-lived widget
  that bakes money into cells or templates remounts via `key={demoMasked ? 'masked' : 'plain'}` —
  the money `DataTable`s (projection-table, bank-ledger-table, budget-expense-log, and
  mortgage-ledger-table, whose composite key carries a demo segment) and the cashflow header's
  account-selector `Dropdown` (money in its `valueTemplate`); modals mount fresh so they need no
  key.
- **Toggle surfaces**: the user-menu item (`nav-config.tsx`) and the command palette
  (`action-demo-mode`); AppLayout renders a fixed "Demo" indicator pill (z-45, above mobile
  chrome, below overlays — eye-off icon, click to exit). Context exposes
  `demoMode`/`demoMasked`/`setDemoMode`.

## 11. Simple vs Advanced display mode

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

## 12. User avatars

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
  cache-buster from `avatarUrlFor`. Node runtime (needs `fs`). In `proxy.ts`, cookie-bearing requests are exempt
  from rate limiting and this path is not auth-redirected.
- **Read path**: `PublicUser.avatarUrl` is computed by `toPublicUser` / `avatarUrlFor`
  (`db/users.ts`); `UserProfile { id, name, avatarUrl? }` is returned by `getUserProfiles`
  (`src/lib/actions/user-profiles.ts`) to **any** authenticated user (no email/role leaked, so it
  is safe for cross-user member displays). Client: `<UserAvatar>` (`src/components/ui/user-avatar.tsx`,
  renders the image or initials on a deterministic `getAvatarColor` hsl hash from `avatar-utils.ts`),
  the `useUserProfiles` hook (`src/lib/hooks/use-user-profiles.ts`, module cache + inflight dedup +
  `invalidateUserProfiles`), and `AvatarEditorDialog` (drop/paste/browse → EXIF-normalized ≤2048px
  source → `react-easy-crop` round crop + zoom [lazy-loaded dependency] → 256×256 WebP q0.85,
  JPEG fallback).
- **Write path**: `updateMyAvatar` (`actions/account.ts`, self); admin `updateUser` accepts an
  `avatarDataUri` field (`avatarDataUriSchema` in `src/lib/schemas/user.schema.ts`).
- **Cache invalidation is the `users` tag only** — the avatar is **never denormalized** into shared
  split/mortgage docs (those carry names only), and is **not** in the session JWT (cookie size);
  every avatar render resolves through the route + `useUserProfiles`.
