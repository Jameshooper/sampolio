# Sampolio — Known Gaps & Defects

Factual defects, dead code, stale comments, and missing pieces **as of the current
codebase**. Everything here is verified against the code (file + line/symbol given)
or observed in the running app. Design-level limitations (in-process-only file
locks, no cross-currency conversion, single-node assumptions, in-memory rate limits)
live in `AGENTS.md` §Safety, testing, and operations; forward-looking ideas live in
[`improvements.md`](improvements.md).

## Open gaps

| # | What | Notes |
|---|---|---|
| 1 | **Backup automation lives outside the repo.** The daily backup (a launchd agent plus a backup script kept outside the repo) is not version-controlled with the app. Accepted for now — see [`operations.md`](operations.md) §6. | External to repo |
| 2 | **No end-to-end tests; component coverage is partial.** Pure engines, schemas, the db layer, a representative action-layer slice, the shared UI primitives, and the three highest-state components (cashflow item modal, split editor, reconcile wizard) plus a security regression suite (path safety, concurrency, sessions, proxy, exploit inputs through real actions) are covered (~70 vitest files); most pages and server actions still have no automated coverage. Tracked as [`improvements.md`](improvements.md) §13.1. | `src/**/*.test.{ts,tsx}` |
| 3 | **Demo-mode masking depends on components re-rendering.** `formatCurrency` reads a process-wide flag, so any new memoized surface can cache unmasked text: ECharts `option` `useMemo`s must list `demoMasked` in their deps, and long-lived PrimeReact `DataTable`s need a `key={demoMasked ? 'masked' : 'plain'}` remount. Not a bug in current code (all call sites comply) — a **convention future code must follow**; see [`docs/features.md`](features.md) §10 and [`src/components/AGENTS.md`](../src/components/AGENTS.md). | `src/lib/demo-mode.ts`, chart/table call sites |
| 4 | **Jiggle reorder has no vertical edge auto-scroll (v1).** Dragging an item near a viewport edge does not auto-scroll the page, so reordering a long list relies on ordinary page scroll (or the sr-only arrow-key entry buttons). Acceptable for the short group/bank-account lists it drives today. | `src/components/ui/jiggle-reorder.tsx` |
| 5 | **CSP still allows inline script.** `script-src 'self' 'unsafe-inline'` remains because pages are partially prerendered and Next's inline bootstrap/RSC scripts carry no per-request nonce. XSS defence therefore rests on escaping (React, plus `escapeHtml` in ECharts tooltip formatters, guarded by a static test). A nonce-based CSP would require dynamic rendering of every page. | `next.config.ts`, `src/lib/html-escape.ts` |
| 6 | **Rate limits and login counters trust the proxy hop count and live in one process.** The launch scripts bind `127.0.0.1`, so only the local reverse proxies can reach the app; if it is exposed some other way (`SAMPOLIO_HOST=0.0.0.0`, or a published Docker port) with `TRUSTED_PROXY_HOPS ≥ 1`, a client reaching the port directly can choose its own `X-Forwarded-For` and get fresh rate-limit/lockout buckets — use `TRUSTED_PROXY_HOPS=0` there. The per-account cap (50 failures / 15 min from any address) can still be used to lock a known account temporarily. Counters reset on restart and are not shared between processes. | `src/lib/client-ip.ts`, `src/proxy.ts`, `src/lib/db/users.ts`, `scripts/run-sampolio.sh` |

## Housekeeping

- The `improvements.md` items that graduate into work should remove their
  corresponding entry here when fixed; this file documents **now**, not history.
