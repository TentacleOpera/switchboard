# Part 2 — Worktree-per-subtask (Feature 1)

**Plan ID:** 967cf8cd-d2e1-4612-9800-b256513546bb
**Epic ID:** 8b50c095-b7c6-40b5-a9d6-2155b26fe4b6

## Metadata

**Complexity:** 7
**Tags:** backend, database, feature, devops

---

## Goal

In `per-subtask` mode, the extension auto-provisions one worktree per subtask off a shared epic
integration branch, records the mapping in the epic file, and hands the agent the paths — making
parallel subagent execution isolated instead of collision-prone.

### Core problem & background

The current epic worktree model binds a single worktree to an `epic_id`; every subtask routes into
it and parallel subagents collide on files. The root cause is that worktree isolation is delegated
to the agent rather than pre-provisioned and recorded by the extension. This plan pre-provisions
per-subtask worktrees and routes each subtask plan to its own.

---

## User Review Required

Yes — confirm:
- **Merge topology UX**: per-subtask mode changes the merge TARGET (subtask → integration branch,
  not → main). Confirm whether the user merges each subtask individually, or one "merge epic"
  sweeps all children into integration then integration into main.
- **Lazy-create vs creation-only** for the integration worktree when mode is toggled mid-epic
  (recommendation: lazy-create with idempotency guard).

## Complexity Audit

### Routine
- V42 `ADD COLUMN` migration — additive, guarded, mirrors V34/V41 pattern.
- `_createSafetyWorktree` `baseBranch` extension — one new optional param.
- Epic-file WORKTREES block generation — mirrors the existing SUBTASKS block in
  `_regenerateEpicFile`.

### Complex / Risky
- **Per-subtask merge topology**: `mergeWorktree` currently merges into main; new logic merges
  subtask → integration branch first. New git command targeting a different worktree path; conflict
  surface moves to the integration branch.
- **Subtask-add hook coverage**: must fire from 3+ entry points (`createEpicFromPlanIds` loop,
  `assignPlansToEpic`, `addSubtaskToEpic` handler) and be idempotent against duplicate worktrees +
  concurrent integration-worktree creation races.
- **Routing precedence change**: `resolveWorktreePathForPlan` signature widening across multiple
  callers in two providers.
- **Multi-worktree lifecycle cleanup**: epic merge/abandon must walk `subtask_plan_id` children and
  remove their worktrees + branches; partial-failure leaves orphaned worktrees.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - Two subtasks added near-simultaneously both lazy-create the integration worktree → mitigate
    with the existing "epic already has active worktree" guard from `createWorktreeForEpic` (~7739)
    (idempotent).
  - `_regenerateEpicFile` self-write loop: the new WORKTREES block must use the same byte-identical
    no-op skip guard the SUBTASKS block already uses (~8605) to avoid re-firing the plan watcher.
  - Mode toggled while a subtask-add is in flight: read mode once at the start of the create/assign
    operation and use the snapshot.
- **Security:** `baseBranch` passed to `git worktree add` must be validated (no `..`, no shell
  metachars) — reuse the existing `repoName` sanitization in `_createSafetyWorktree` (~8353).
  Branch names are slug-derived, not user-raw.
- **Side Effects:** auto-provisioned worktrees create real on-disk git worktrees + branches outside
  the repo (`../worktrees/`). Abandon/merge must clean these up or they accumulate. A failed
  partial cleanup leaves dangling worktrees (`git worktree prune` is not currently called —
  consider adding it to the epic merge/abandon path).
- **Dependencies & Conflicts:** V42 must ship before this plan. Part 1 (mode config) must ship
  before this plan. No conflict with `WORKTREES_PER_PLAN_DIRECTIVE` — the per-subtask directive
  REPLACES the "create your own" guidance for this mode; `none` mode keeps the old path unchanged.

## Dependencies

- `sess_epicworktree_v42_schema` — V42 worktrees table migration (subtask_plan_id, base_branch,
  tier). Blocks this plan.
- `sess_epicworktree_mode_config` — Part 1, `epic_worktree_mode` config key + handlers. Blocks this
  plan's provisioning logic.

## Proposed Changes

### `src/services/KanbanDatabase.ts`
- **Context:** `worktrees` table (schema at ~162; migrations through V41). `getWorktrees()` (~2589)
  and `addWorktree()` (~2614) read/write the stored `path` column.
- **Logic:** migration **V42**. Add to `worktrees`: `subtask_plan_id TEXT`, `base_branch TEXT`
  (and `tier TEXT` for Part 3 — do all three in one V42). **VERIFIED during review:**
  `worktrees.path` IS a stored `TEXT NOT NULL` column today (V30/V31 recreated the table WITH
  `path`; V24's "derive at read time" approach was reverted long ago — `getWorktrees()`/
  `addWorktree()` both read/write the stored `path`). So V42 is purely additive
  `ALTER TABLE ... ADD COLUMN` for the three new columns; the existing stored `path` is reused
  unchanged — no derivation logic. Guard each `ADD COLUMN` like prior migrations (idempotent
  try/catch); bump version to 42. Latest shipped migration is V41, so V42 is the correct next
  number.
- **Edge Cases:** existing rows get NULL for the new columns — correct (no subtask/tier binding for
  legacy worktrees).

### `src/services/KanbanProvider.ts`
- **Context:** `_createSafetyWorktree` (~8341) creates worktrees; `createEpicFromPlanIds` (~8644)
  and `assignPlansToEpic` (~8820) add subtasks; `_regenerateEpicFile` (~8547) writes the epic .md;
  `mergeWorktree`/`abandonWorktree` (~7894/~7912) handle lifecycle; `addSubtaskToEpic` (~7947) is
  the webview message handler.
- **Logic:**
  1. Extend `_createSafetyWorktree(workspaceRoot, topic?, repoName?)` to accept an optional
     `baseBranch` → emit `git worktree add -b <branch> <path> <baseBranch>` (falls back to current
     HEAD behavior when omitted, preserving existing callers).
  2. **Epic creation in `per-subtask` mode** (`createEpicFromPlanIds`): create the **epic
     integration worktree** off `main`/default branch, `epic_id`-bound (this is the convergence
     point). Record its branch as the base for subtask worktrees.
  3. **Subtask-add hook** — in `assignPlansToEpic` / `updateEpicStatus` / the subtask loop inside
     `createEpicFromPlanIds` / the `addSubtaskToEpic` message handler: when the epic's mode is
     `per-subtask`, for each *newly* added subtask create a worktree branched off the epic
     integration branch, bound via `subtask_plan_id`. Guard against duplicates (subtask already has
     an active worktree). Lazy-create the integration worktree if missing (idempotent guard).
  4. **Routing precedence** (`resolveWorktreePathForPlan`): new order subtask worktree → epic
     worktree → project worktree → fallback. See `TaskViewerProvider` change below.
  5. **Epic file representation** (`_regenerateEpicFile`): add a second auto-generated block,
     mirroring SUBTASKS:
     ```
     <!-- BEGIN WORKTREES (auto-generated, do not edit) -->
     ## Worktrees
     - **Epic integration**: `<branch>` → `<path>`
     - [Subtask topic](../plans/<basename>): `<branch>` → `<path>`
     <!-- END WORKTREES -->
     ```
     Regenerated whenever subtasks/worktrees change. Only emitted when the epic actually has
     worktrees (so `none`-mode epics are unaffected). Use the byte-identical no-op skip guard
     (~8605) to avoid the self-write loop.
  6. **Lifecycle:** subtask removed from epic → abandon its worktree (D4). Subtask done → its
     branch merges into the epic integration branch. Epic Merge → merge integration branch to
     main, then clean up all child subtask worktrees. Abandon epic → remove all children +
     integration. **VERIFIED during review:** the current `mergeWorktree` handler (~7894) runs
     `git -C workspaceRoot merge <branch>` — i.e. it merges into the **main repo**, NOT into an
     epic integration branch. The per-subtask convergence model requires **new merge logic**: a
     subtask merge must target the epic integration worktree's path/branch first
     (`git -C <integrationWtPath> merge <subtaskBranch>`), and only the epic-level merge targets
     main. Add a `mergeSubtaskWorktree` path (or a `targetWorktreeId` field on the merge message)
     that resolves the epic integration worktree from the subtask's `epic_id` and merges there.
     Walking children on epic merge/abandon remains necessary for cleanup.
- **Edge Cases:** partial cleanup failure → log + continue (don't block the whole merge); consider
  `git worktree prune` after cleanup.

### `src/services/TaskViewerProvider.ts`
- **Context:** `resolveWorktreePathForPlan` (~7373) currently takes `{epicId, project}` only.
- **Logic:** extend the param object to `{ epicId?, project?, planId? }` and look up
  `activeWorktrees.find(w => w.subtask_plan_id === planId)` FIRST (new precedence: subtask → epic
  → project → fallback). Confirm every caller (`_cardsToPromptPlans` builds the worktreePathMap at
  ~2674/2949 in KanbanProvider; the TaskViewerProvider paths at ~1871/3122/16173) passes `planId`
  — most already pass the full plan object, so this is a signature widening, not a new fetch.
- **Edge Cases:** `planId` undefined (legacy callers) → skip subtask lookup, fall through to epic.

### `src/services/agentPromptBuilder.ts`
- **Context:** `EPIC_ORCHESTRATION_DIRECTIVE` (~350) is the single epic orchestration directive.
- **Logic:** add a `per-subtask` variant that **lists the pre-created subtask worktree paths** and
  instructs the agent to dispatch one subagent per subtask into its assigned worktree (replacing
  the "create your own worktree" guidance for this mode). Selection by mode is finalized in Part 4.
- **Edge Cases:** if no subtask worktrees exist (mode mismatch / lazy-create failed), fall back to
  the base `EPIC_ORCHESTRATION_DIRECTIVE`.

## Verification Plan

### Automated Tests
- **SKIP for this session** per session directives. Tests to author for the separate run:
  - Migration test: load a pre-V42 DB fixture, run V42, assert the three new columns exist and are
    nullable, and that existing `worktrees.path` rows are intact.
  - `resolveWorktreePathForPlan` precedence test: subtask with its own worktree → returns subtree
    path; subtask without → epic; neither → project; none → undefined.
  - Lifecycle test: create epic in `per-subtask` mode → integration worktree + N subtask worktrees
    exist; abandon epic → all children + integration removed.

### Manual / Static Verification (this session)
- **Compilation SKIP** per session directives.
- Static cross-check (done during review): confirmed `_createSafetyWorktree` (~8341),
  `createEpicFromPlanIds` (~8644), `assignPlansToEpic` (~8820), `_regenerateEpicFile` (~8547),
  `mergeWorktree` (~7894), `resolveWorktreePathForPlan` (~7373), and `addSubtaskToEpic` (~7947)
  against current `src/`.
- Pre-merge checklist: confirm V42 migration is guarded by `getMigrationVersion() < 42` and wrapped
  in try/catch + ROLLBACK like V31/V34; confirm `_regenerateEpicFile` WORKTREES block uses the
  byte-identical no-op skip; grep for any new `confirm(`/`window.confirm` — forbidden per CLAUDE.md.

## Acceptance
- Creating an epic in `per-subtask` mode creates an integration worktree; adding subtasks creates
  one worktree each off the integration branch; the epic `.md` lists them; the executor prompt
  references real paths; epic Merge converges branches and cleans up.

## Recommendation

Complexity 7 → **Send to Lead Coder.** New git merge topology, multi-entry-point hook coverage,
and a routing signature change across two providers. Ships after Part 1 + V42; can proceed in
parallel with Part 3.
