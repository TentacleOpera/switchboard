# Part 3 — High/low Complexity Split (Feature 2)

**Plan ID:** e89c1955-19ce-4131-8dd6-5dde323be80d
**Epic ID:** 8b50c095-b7c6-40b5-a9d6-2155b26fe4b6

## Metadata

**Complexity:** 7
**Tags:** backend, feature, devops

---

## Goal

In `high-low` mode, provision exactly two tier worktrees (high/low) at epic creation, instruct the
planner to consolidate the epic's N subtasks into two plan files (high-complexity ≥5, low ≤4), and
instruct the executor to run both tiers in parallel via subagents in their tier worktrees.

### Core problem & background

Epic decomposition has no structured "split by complexity" path. Pair programming already
dispatches Lead always and Coder for complexity ≥5, but an epic's N subtask plans are never
reorganized to exploit a clean high/low parallel split. The infrastructure (worktrees, pair
prompts, subagent directives) exists; what's missing is provisioning the two tier worktrees and
instructing the planner to consolidate N plans into two.

---

## User Review Required

Yes — confirm:
- **D2 boundary**: complexity ≥5 = high, ≤4 = low (matches pair-programming). Alternative: a
  dedicated configurable threshold.
- **D6 consolidated plans**: new plan files, originals kept & back-linked. Alternative: rewrite in
  place.

## Complexity Audit

### Routine
- Worktree provisioning reuses `_createSafetyWorktree` (with `baseBranch` from Part 2) — two calls
  with `tier='high'`/`tier='low'`.
- Executor directive reuses pair-programming + subagent directive patterns.

### Complex / Risky
- **High-low planner consolidation**: planner authors two NEW plan files that must auto-link to the
  epic via a file-watcher marker — depends on `GlobalPlanWatcherService` parsing semantics not yet
  confirmed (epic open item #4). This is the bulk of the effort.
- **Two-plan authoring/linking logic**: the consolidation directive must instruct the planner to
  back-link to originals and emit the epic-link marker.

## Edge-Case & Dependency Audit

- **Race Conditions:** planner writes two files near-simultaneously; the file watcher imports both
  — order doesn't matter as long as both embed the epic-link marker.
- **Security:** planner consolidation directive injects epic plan IDs (UUIDs) into the prompt — no
  injection risk.
- **Side Effects:** high-low consolidation keeps originals AND adds two new plans → board card
  count grows; originals must be visibly back-linked so the user doesn't think they're duplicates.
- **Dependencies & Conflicts:** V42 (the `tier` column) must ship first. Part 1 (mode config) must
  ship first. Part 2's `_createSafetyWorktree` `baseBranch` extension is reused. No conflict with
  Part 2 — they provision different worktree shapes for different modes.

## Dependencies

- `sess_epicworktree_v42_schema` — V42 worktrees table migration (needs the `tier` column). Blocks
  this plan.
- `sess_epicworktree_mode_config` — Part 1, `epic_worktree_mode` config key + handlers. Blocks this
  plan's provisioning logic.
- `sess_epicworktree_per_subtask` — Part 2's `_createSafetyWorktree` `baseBranch` extension is
  reused (soft dependency — could be cherry-picked if Part 2 is delayed).

## Proposed Changes

### `src/services/KanbanProvider.ts`
- **Context:** `createEpicFromPlanIds` (~8644) creates epics; `generateUnifiedPrompt` (~3147)
  builds planner/executor prompts.
- **Logic:**
  1. **Epic creation in `high-low` mode**: create the epic integration branch, then exactly **two**
     tier worktrees off it — `tier='high'` and `tier='low'` (branch names `…-high` / `…-low`),
     `epic_id`-bound, distinguished by the new `tier` column (V42). Reuse
     `_createSafetyWorktree` with `baseBranch` (from Part 2).
- **Edge Cases:** if one tier worktree creation fails, roll back the other + the integration
  branch (don't leave a half-provisioned epic).

### `src/services/agentPromptBuilder.ts`
- **Context:** `EPIC_ORCHESTRATION_DIRECTIVE` (~350); planner dispatch at `generateUnifiedPrompt`
  (~3147, role === 'planner' branch ~3236).
- **Logic:**
  1. **Planner consolidation directive** — when dispatching the **planner** for a `high-low` epic,
     inject a directive instructing it to:
     - Read the epic's N subtask plans.
     - Consolidate them into **exactly two** plan files following the pair-programming structure:
       one **high-complexity** (subtasks scoring ≥5), one **low-complexity** (≤4) — D2.
     - Write the two new plans to `.switchboard/plans/`, **keeping the originals** and back-linking
       to them for traceability (D6).
     - Note: this is additive to `improve-plan.md`, not a replacement of it.
     - **VERIFIED during review — epic linkage gap:** the planner writes `.md` files only; it
       cannot set `epic_id` in the DB directly. `GlobalPlanWatcherService` auto-imports new plan
       files and stamps `epic_id` only if the file embeds an epic-link marker the watcher parses.
       The two consolidated plans MUST therefore embed a marker the watcher reads (e.g. an
       `**Epic:** <epicPlanId>` / `**Epic ID:** <uuid>` line mirroring how epic files embed
       `**Plan ID:**`) so they land linked to the epic on import instead of as orphan CREATED
       cards. Confirm the exact marker key the watcher parses
       (`GlobalPlanWatcherService._handlePlanFile` / `insertFileDerivedPlan`) before authoring the
       directive, and have the consolidation directive instruct the planner to emit that marker.
  2. **Executor directive** — a `high-low` variant of the orchestration directive instructing the
     implementing agent to use subagents to run the **high** and **low** plans **in parallel**,
     each inside its tier worktree (paths supplied from the worktrees table). Selection by mode is
     finalized in Part 4.
- **Edge Cases:** if the planner produces fewer/more than two consolidated plans, the executor
  directive should still reference the tier worktrees by `tier` column, not by assumed plan count.

### Reality check on "infra already there"
True for worktree creation (reuses `_createSafetyWorktree`) and parallel/subagent prompting
(reuses pair-programming + subagent directives). **Net-new and the bulk of the effort** is the
planner consolidation directive and the two-plan authoring/linking logic — call this out so it
isn't under-scoped.

## Verification Plan

### Automated Tests
- **SKIP for this session** per session directives. Tests to author for the separate run:
  - Assert creating an epic in `high-low` mode yields two worktrees with `tier='high'` and
    `tier='low'`.
  - Assert the planner consolidation directive is injected only for `high-low` epics (not
    `per-subtask` or `none`).

### Manual / Static Verification (this session)
- **Compilation SKIP** per session directives.
- Static cross-check (done during review): confirmed `EPIC_ORCHESTRATION_DIRECTIVE` (~350) and the
  planner dispatch branch (~3236) against current `src/`.
- **BLOCKER before authoring the consolidation directive:** read
  `GlobalPlanWatcherService._handlePlanFile` / `insertFileDerivedPlan` to confirm the epic-link
  marker key (epic open item #4). This is a code-reading task for the implementer.
- Pre-merge checklist: grep for any new `confirm(`/`window.confirm` — forbidden per CLAUDE.md.

## Acceptance
- Creating an epic in `high-low` mode yields two tier worktrees; dispatching the planner produces
  two consolidated plans (high/low) that link back to originals and to the epic; the executor runs
  both tiers in parallel in their worktrees.

## Recommendation

Complexity 7 → **Send to Lead Coder.** The planner consolidation directive + file-watcher linkage
is net-new and the bulk of the effort. Ships after Part 1 + V42; can proceed in parallel with
Part 2. Resolve epic open item #4 before authoring the consolidation directive.

---

## Review Findings

Reviewed `src/services/KanbanProvider.ts` (`_provisionHighLowTierWorktrees` all-or-nothing provisioning + high-low branch in `createEpicFromPlanIds` + high-low `resolvedOptions`) and `src/services/agentPromptBuilder.ts` (`EPIC_ORCHESTRATION_DIRECTIVE_HIGH_LOW`, `PLANNER_HIGH_LOW_CONSOLIDATION_DIRECTIVE`). Epic open item #4 is RESOLVED correctly: the implementer read `GlobalPlanWatcherService`/`insertFileDerivedPlan` and confirmed there is NO epic-link content marker (`epic_id` is DB-owned, set only via `updateEpicStatus`), so the consolidation directive instructs the planner to link the two new plans via `assign-to-epic.js` (which routes through the running extension's `/kanban/epic/assign`); both `assign-to-epic.js` and `get-state.js` exist, and `epicPlanId` resolves to the epic's planId via `_cardId` = `card.planId || card.sessionId`. One fix applied (cross-cutting with Part 2): the merge handler only routed `subtask_plan_id` worktrees into the integration branch — tier worktrees fell through to a plain main-merge (bypassing the integration branch and never cleaning up) and the high-low integration worktree wasn't detected (it looked for `subtask_plan_id` children, not tier) — added a tier-merge branch and widened integration detection to `(subtask_plan_id || w.tier)` with `!w.tier` on the integration lookup (`src/services/KanbanProvider.ts:8017`, `8027`, `8748`). Validation: static only; no confirm-gates. Remaining risks: `get-state.js` requires compiled `out/services/KanbanDatabase` (per CLAUDE.md the build outputs `dist/`), so its planId-lookup step can fail in environments without `out/` — `assign-to-epic.js` itself is unaffected (uses the extension API); also, after consolidation the epic shows N+2 subtask cards (originals kept per D6) — by design, but a UX wart.
