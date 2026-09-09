---
name: verify-documentation
description: >
  Verify and update Sampolio's documentation after implementing or modifying a
  feature, so doc updates are never forgotten. Triggers automatically as the
  FINAL step of any substantial implementation — new feature/page/flow, changed
  pure-engine or business logic, new/changed server action or DB-layer file, new
  entity type, type/schema change, new cache tag / env var / tunable constant,
  bank-sync or other integration change, or a user-visible UI/nav change. Checks
  whether the change belongs in the root AGENTS.md (edit it, never its CLAUDE.md
  / .github/copilot-instructions.md symlinks), a nested per-directory AGENTS.md,
  or a docs/*.md reference, and either updates the obvious target or asks when
  ambiguous. Tolerates "no documentation changes needed" for trivial edits. Run
  AFTER the implementation is otherwise complete (lint/tests pass) and before any
  commit or deploy. Docs only — never edits code, tests, or config.
---

# Verify Documentation

Run as the **final step** of any substantial implementation, before declaring the
task complete and before any commit or `/deploy-prod`. Sampolio's rule is that
**code and docs ship together** (root `AGENTS.md` → "Documentation Discipline");
this skill operationalizes that rule so a doc update is never forgotten.

Sampolio has **three documentation surfaces**:

| Surface | Location | Use for |
|---|---|---|
| Root `AGENTS.md` | repo root | Conventions, engine behavior, data model, tunable constants, cross-cutting rules — **routing to topical details and known gaps** |
| Nested `AGENTS.md` | `src/**/AGENTS.md` | Conventions, data flows, and gotchas local to one directory/area |
| `docs/*.md` | `docs/` (topical references plus `README.md` index) | Long-form feature/system references (e.g. bank sync, infrastructure) |

**Edit `AGENTS.md` at the repo root — never `CLAUDE.md` or
`.github/copilot-instructions.md`.** Both are symlinks to the root `AGENTS.md`;
editing it updates all three.

This skill **only touches docs** — never code, tests, migrations, or config.

## When to Use

### Model-invoked (proactive — default)

After completing any substantial implementation. "Substantial" means **any** of:

- New feature, page, workflow, or modal flow added
- Modified business logic in a pure engine — `projection.ts`,
  `wealth-projection.ts`, `mortgage-projection.ts`, `budget-utils.ts`,
  `split-utils.ts`, `card-billing.ts`, `goal-utils.ts`, `retrospective.ts`,
  `maintenance-utils.ts`, `salary-utils.ts` (validation, allocation, anchoring,
  amortization, cents math, etc.)
- New or changed server action (`src/lib/actions/`) or DB-layer file
  (`src/lib/db/`)
- New entity type (the checklist in `docs/architecture.md`)
- New or changed cache tag, env var, or tunable constant other code relies on
  (e.g. `BACKFILL_DAYS`, `RETROSPECTIVE_MONTHS_BACK`)
- Data-model / type change in `src/types/index.ts`
- New external integration, or a change to how Enable Banking is called
- User-visible UI/flow change — new nav entry (`nav-config.tsx`), command-palette
  entry, responsive/PWA-shell change, or deep-link target

### Skip (trivial — exit with "no updates needed")

- Typos, comment-only edits, formatting
- Dependency bumps with no behavior change
- Single-line bug fixes in non-business-logic code
- Pure refactors with no externally visible change
- Plan-mode sessions, exploration, code review, Q&A — no code changed

### User-invoked

When the user asks to "check docs", "update documentation", "review docs after
this change", or runs `/verify-documentation`.

## Step 1 — Classify the Change

Summarize what this session implemented:

- **Which directories / areas** were touched
- **Which engine(s) or action(s)** changed
- **What behaviors** changed (new action? new constant? new UI flow? new
  Known Limitation?)

If the conversation context is unclear, inspect the actual diff:

```bash
git -C $HOME/sampolio status --short
git -C $HOME/sampolio diff --stat
git -C $HOME/sampolio diff
```

If the change matches **any** "Skip" criterion, **exit immediately** with:

```
## Documentation Verification

**No documentation updates needed** — trivial change ({reason}).
```

Otherwise continue.

## Step 2 — Identify Candidate Doc Surfaces

**Nested `AGENTS.md`.** List the current nested docs and find the nearest one at
or above each touched directory:

```bash
find $HOME/sampolio -name AGENTS.md -not -path '*/node_modules/*'
```

These exist today (always re-run the command — the set grows): `src/components/`,
`src/lib/actions/`, `src/lib/db/`, `src/app/(dashboard)/settings/`,
`src/app/(dashboard)/cashflow/`, `src/app/(dashboard)/overview/`.

**`docs/*.md`.** List them and match the change by topic:

```bash
ls $HOME/sampolio/docs
```

- `README.md` — index of the doc set (update when docs are added/renamed)
- `architecture.md` — system reference (routes, actions, storage, caching, auth)
- `projections-and-reconciliation.md` — projection/retrospective/wealth engines, anchoring, reconciliation, scenarios
- `bank-sync.md` — bank sync / PSD2 AIS behavior deep-dive
- `mortgage.md` — shared-mortgage engine + workflows deep-dive
- `features.md` — Split, Budgets, Goals, dashboards, onboarding, command palette
- `operations.md` — production topology, deploy, backups, encryption maintenance, env vars
- `known-gaps.md` — verified defects & missing pieces (keep honest: add on find, remove on fix)
- `improvements.md` — evidence-backed improvement backlog

All docs are **current-state only** — no changelog/"previously" phrasing.

**Root `AGENTS.md`.** A candidate when the change is a convention, engine
behavior, data model, tunable constant, new-entity pattern, or a cross-cutting invariant. Keep detailed behavior in the mapped topical
reference and defects in `docs/known-gaps.md`.

If **no** existing candidate matches, a **new** `docs/*.md` or **new** nested
`AGENTS.md` may be warranted — hold that for Step 4.

## Step 3 — Decide the Action Per Candidate

### Bucket A — Obvious update (auto-apply)

The change clearly belongs in exactly one doc and the edit is straightforward
(update a cache tag, action name, constant value/meaning, file path, add a row,
amend a Known Limitation). Auto-edit in Step 5; report what changed.

### Bucket B — Ambiguous (ask the user)

Multiple plausible targets, a major restructuring, or a possible new file. Use
the available user-question tool (or ask in chat) with concrete options, e.g.:

> This surfaces the existing Goals backend in a new UI. Where should it go?
> (a) New nested `src/app/(dashboard)/goals/AGENTS.md` (recommended)
> (b) A new `docs/goals.md` reference
> (c) Just the root `AGENTS.md` "Goals" section

Do not edit until the user picks, unless the current request already authorizes the restructuring and target.

### Bucket C — Skip (no action)

A parent surface already covers this generally, or the change is too small for
this candidate. Note in the report; do nothing.

## Step 4 — Special Cases

### New `docs/*.md` file

Only when the change is a large, standalone feature/system worth a long-form
reference. **Ask the user before creating it.** If they agree: use
**lowercase-kebab** naming (match `bank-sync.md`), read `docs/bank-sync.md` +
`docs/operations.md` for tone, then draft, and add the new file to the
`docs/README.md` index and the root `AGENTS.md` documentation map.

### New nested `AGENTS.md`

If the change lands in a substantial subfolder (roughly 5+ files, non-obvious
logic) with no covering `AGENTS.md`, **ask the user** before adding one. Model it
on an existing nested doc (e.g. `src/lib/actions/AGENTS.md`), keep it terse, and
**don't duplicate** what the root or a parent `AGENTS.md` already says.

### Root `AGENTS.md` edits

Edit the correct sub-section, sparingly:

- One line per concept; no verbose prose
- Nothing derivable from reading the code in two minutes
- No duplication of a nested `AGENTS.md` or `docs/*.md`
- Prefer a nested `AGENTS.md` or `docs/*.md` when the content is area-specific
- **Edit the root `AGENTS.md` file only** — the `CLAUDE.md` and
  `.github/copilot-instructions.md` symlinks update automatically

### Known Limitations / Known Bugs

Keep them honest: add an entry when the change introduces a caveat, amend one
whose facts changed, and **remove** one your change fixed (and move a fixed item
out of "Known Bugs").

## Step 5 — Apply Bucket A Updates

For each obvious candidate:

1. Read the target doc.
2. Find the section covering the affected concept — use existing structure; don't
   add a new section unless genuinely needed.
3. Edit inline, matching the tone and density of neighbouring entries.
4. Update concrete details that changed: cache tags, env vars, constant
   names/values, action/DB-function names, type names, file paths, nav/command
   entries, deep-link targets.
5. Don't repeat content a parent surface already covers.

**Do not edit historical / point-in-time content** without explicit instruction —
this includes `docs/sampolio-codebase-architecture-report.md`,
`docs/sampolio-ux-audit.md`, and any dated "snapshot" narrative.

## Step 6 — Report

End with:

```
## Documentation Verification

**Updated automatically:**
- `AGENTS.md` — {one-line summary; note which sub-section}
- `src/.../AGENTS.md` — {one-line summary}
- `docs/{file}.md` — {one-line summary}

**Pending your decision:** (only when a user question was needed)
- {the question asked and the answer}

**Skipped (no update needed):**
- `docs/{file}.md` — {reason}

**Suggested follow-ups:** (optional)
- {e.g. "docs/sampolio-codebase-architecture-report.md is stale — regenerate?"}
- {e.g. "consider a nested AGENTS.md for src/.../X (5+ files, non-obvious)"}
```

If nothing changed and nothing is pending, collapse to a single line:
**No documentation updates needed** with the reason.

## Guardrails

- **Docs only.** Never edit code, tests, migrations, or config.
- **Edit `AGENTS.md`, never its symlinks** (`CLAUDE.md`,
  `.github/copilot-instructions.md`).
- **Never edit the historical docs** (`sampolio-codebase-architecture-report.md`,
  `sampolio-ux-audit.md`) or dated "snapshot" sections without explicit
  instruction.
- **Never create speculative docs** for features that "might grow later" — only
  when the current change is itself substantial enough.
- **Never bloat `AGENTS.md`.** Prefer a nested `AGENTS.md` or `docs/*.md` for
  area-specific content; one line per concept.
- **Never duplicate parent content.**
- **Don't trigger on read-only sessions** (exploration, plan mode, review, Q&A —
  no code changed = nothing to verify).
- Independent of `/deploy-prod`: docs must be current **before** you deploy, but
  this skill never builds, commits, or restarts anything.
