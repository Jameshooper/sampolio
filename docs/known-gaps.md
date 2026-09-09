# Sampolio — Known Gaps & Defects

Factual defects, dead code, stale comments, and missing pieces **as of the current
codebase**. Everything here is verified against the code (file + line/symbol given)
or observed in the running app. Design-level limitations (no file locking, no
cross-currency conversion, single-node assumptions, the cookie-presence rate-limiter
tradeoff) live in `AGENTS.md` §Safety, testing, and operations; forward-looking ideas live in
[`improvements.md`](improvements.md).

## Open gaps

| # | What | Notes |
|---|---|---|
| 1 | **Backup automation lives outside the repo.** The daily backup (a launchd agent plus a backup script kept outside the repo) is not version-controlled with the app. Accepted for now — see [`operations.md`](operations.md) §6. | External to repo |
| 2 | **No end-to-end tests; component coverage is partial.** Pure engines, schemas, the db layer, a representative action-layer slice, the shared UI primitives, and the three highest-state components (cashflow item modal, split editor, reconcile wizard) are covered (~40 vitest files); most pages and server actions still have no automated coverage. Tracked as [`improvements.md`](improvements.md) §13.1. | `src/**/*.test.{ts,tsx}` |
| 3 | **Demo-mode masking depends on components re-rendering.** `formatCurrency` reads a process-wide flag, so any new memoized surface can cache unmasked text: ECharts `option` `useMemo`s must list `demoMasked` in their deps, and long-lived PrimeReact `DataTable`s need a `key={demoMasked ? 'masked' : 'plain'}` remount. Not a bug in current code (all call sites comply) — a **convention future code must follow**; see [`docs/features.md`](features.md) §10 and [`src/components/AGENTS.md`](../src/components/AGENTS.md). | `src/lib/demo-mode.ts`, chart/table call sites |
| 4 | **Jiggle reorder has no vertical edge auto-scroll (v1).** Dragging an item near a viewport edge does not auto-scroll the page, so reordering a long list relies on ordinary page scroll (or the sr-only arrow-key entry buttons). Acceptable for the short group/bank-account lists it drives today. | `src/components/ui/jiggle-reorder.tsx` |

## Housekeeping

- The `improvements.md` items that graduate into work should remove their
  corresponding entry here when fixed; this file documents **now**, not history.
