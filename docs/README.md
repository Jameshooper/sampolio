# Sampolio Documentation

Deep reference documentation for developers (human and AI) extending the app and
hunting issues. Everything here describes the **current state** of the code —
no changelogs, no history. If a doc and the code disagree, the doc is a defect:
fix it in the same change (see the root [`AGENTS.md`](../AGENTS.md)
§Documentation Discipline).

**Division of labor**: the root `AGENTS.md` (symlinked as `CLAUDE.md` and
`.github/copilot-instructions.md`) holds the working conventions and hard
invariants and is loaded into every AI session; the six per-directory
`AGENTS.md` files cover their areas; `docs/` holds the long-form mechanics.
Each fact should have exactly one authoritative home, with links between them.

## The doc set

| Doc | Read it when you need… |
|---|---|
| [`architecture.md`](architecture.md) | The system map: stack, every route, server-action inventory, on-disk storage layout, encryption, caching & tag invalidation, auth, middleware/rate limits, PWA, testing state, tooling, shared UI/motion/loading/form conventions |
| [`projections-and-reconciliation.md`](projections-and-reconciliation.md) | How the numbers are computed: cashflow projection, anchoring & snapshots, occurrence overrides, injected transfer lines, retrospective, wealth projection, the reconciliation workflow, history compaction, scenarios |
| [`bank-sync.md`](bank-sync.md) | Enable Banking (PSD2 AIS): consent lifecycle & reconnect, sync/backfill engine, scheduler & rate limits, storage, account links, credit-card billing, troubleshooting |
| [`mortgage.md`](mortgage.md) | The shared-mortgage feature: data model, amortization engine math, actuals & reconcile/import workflows, ownership/equity, cashflow integration |
| [`features.md`](features.md) | Split groups, Budgets, Goals, Trips (per-diem calculator), the Home & Overview dashboards, onboarding, command palette, Simple/Advanced display modes, demo masking, avatars |
| [`operations.md`](operations.md) | Running production: infrastructure topology, deploy, backups, encryption maintenance & re-encryption, scripts, the full env-var reference, dev-on-prod-copy workflow |
| [`known-gaps.md`](known-gaps.md) | What is verifiably wrong or missing **today**. Remove entries as they are fixed |
| [`improvements.md`](improvements.md) | The evidence-backed backlog of UI/UX, performance, data-integration, and automation improvements (no feature removals) |

## Conventions for these docs

- **Current-state only.** Never write "previously", "was changed", "migrated" —
  describe what the code does now, anchored to file paths and symbols.
- **Every factual claim must be anchored** to code (`path` + symbol/constant). If
  you can't anchor it, don't write it.
- Cross-link between docs by relative filename; link up to `AGENTS.md` for
  conventions rather than restating them.
- When adding a doc, add it to this table and to the root `AGENTS.md`
  documentation map.
