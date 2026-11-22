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
| 2 | **No end-to-end tests; component coverage is partial.** Pure engines, schemas, the db layer, a representative action-layer slice, the shared UI primitives, and the three highest-state components (cashflow item modal, split editor, reconcile wizard) and the add-on runtime (ingress proxy, `run.sh`, `config.yaml`) are covered (~74 vitest files); most pages and server actions still have no automated coverage. Tracked as [`improvements.md`](improvements.md) §13.1. | `src/**/*.test.{ts,tsx}` |
| 3 | **Demo-mode masking depends on components re-rendering.** `formatCurrency` reads a process-wide flag, so any new memoized surface can cache unmasked text: ECharts `option` `useMemo`s must list `demoMasked` in their deps, and long-lived PrimeReact `DataTable`s need a `key={demoMasked ? 'masked' : 'plain'}` remount. Not a bug in current code (all call sites comply) — a **convention future code must follow**; see [`docs/features.md`](features.md) §10 and [`src/components/AGENTS.md`](../src/components/AGENTS.md). | `src/lib/demo-mode.ts`, chart/table call sites |
| 4 | **Home Assistant Ingress is unusable, so the add-on publishes a port instead.** Verified in a browser against a mock Supervisor reproducing Ingress exactly: the document, CSS and JS all load with zero 404s, but React never produces output — `window.next` stays undefined and the flight chunks pile up unconsumed. Two causes, neither fixable by `ha-ingress-proxy.mjs`: Turbopack hardcodes `/_next/` as its dynamic-chunk base (`TURBOPACK_CHUNK_BASE_PATH` overrides it, confirmed, but it is an undocumented internal), and the App Router matches routes client-side against `window.location.pathname`, which carries the ingress prefix while the payload was rendered for the un-prefixed path — what `basePath` exists to fix, and `basePath` is baked at build time while the ingress token is not known until the add-on runs. **Consequence:** no host port is published by default; the add-on is reached over `tailscale_serve` (tailnet-only HTTPS) unless a port is set deliberately in the Network section, and on that port Sampolio's own login is the only gate. The proxy is retained (its rewriting is lossless and it sanitises `X-Forwarded-For`); revisit Ingress if Next.js gains runtime base-path support. | `config.yaml`, `ha-ingress-proxy.mjs` |
| 5 | **Over a plain-`http://` `AUTH_URL`, the session cookie is not `Secure`.** `src/lib/auth-cookies.ts` derives the cookie's `Secure` attribute and `__Secure-` name from `AUTH_URL`'s scheme: anything but an explicit `http://` keeps both (fail-safe), `http://` drops both. That is what lets the Home Assistant add-on be signed into at `http://<ha-host>:3999` at all — browsers discard a `__Secure-` cookie that does not arrive over HTTPS, and a LAN IP is not a trustworthy origin the way `localhost` is. The cost is that on such a deployment the session cookie crosses the LAN in clear text. A deliberate trade-off; avoid it by serving over HTTPS (Tailscale Serve on the add-on, Caddy on the launchd path). Note also that `Secure` is a browser rule, not an access control: a non-browser client authenticates over plain HTTP either way. | `src/lib/auth-cookies.ts` |
| 6 | **Jiggle reorder has no vertical edge auto-scroll (v1).** Dragging an item near a viewport edge does not auto-scroll the page, so reordering a long list relies on ordinary page scroll (or the sr-only arrow-key entry buttons). Acceptable for the short group/bank-account lists it drives today. | `src/components/ui/jiggle-reorder.tsx` |

## Housekeeping

- The `improvements.md` items that graduate into work should remove their
  corresponding entry here when fixed; this file documents **now**, not history.
