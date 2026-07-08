# Epic Worktree Modes & Ultracode/Goal Directive Scoping

**Plan ID:** 8b50c095-b7c6-40b5-a9d6-2155b26fe4b6

## Metadata

**Complexity:** 7
**Tags:** feature, backend, frontend, database, ui, devops

---

## Goal

Give epics three selectable **worktree topologies** and fix a directive-leak bug, so that
parallel subagent execution becomes a first-class, isolated workflow instead of something the
implementing agent has to improvise.

This epic governs five subtask plans (Parts 0–4) that decompose the work along its natural
dependency edges. Each subtask plan is self-contained and linked to this epic via `**Epic ID:**`.

### Core problems & background (root-cause analysis)

1. **The current epic worktree model only supports one shared worktree per epic.**
   `createWorktreeForEpic` binds a single worktree to an `epic_id`, and every subtask plan in
   that epic routes into it (`TaskViewerProvider.resolveWorktreePathForPlan`). That is fine for
   *independent feature development* (one branch, one integration point), but when the
   implementing agent fans out to **parallel subagents**, they all share one working tree and
   collide on files. Today the only mitigation is `WORKTREES_PER_PLAN_DIRECTIVE`, which *asks the
   agent* to create its own worktrees per plan — unreliable, tool-dependent, and invisible to the
   board. The root cause is that worktree isolation is delegated to the agent rather than
   pre-provisioned and recorded by the extension.

2. **Epic decomposition has no structured "split by complexity" path.** Pair programming already
   dispatches Lead always and Coder for complexity ≥5, but an epic's N subtask plans are never
   reorganized to exploit a clean high/low parallel split. The infrastructure (worktrees, pair
   prompts, subagent directives) exists; what's missing is (a) provisioning the two tier
   worktrees and (b) instructing the planner to consolidate N plans into two.

3. **The ultracode/goal epic directives leak into review prompts.** `generateUnifiedPrompt()`
   gates the prepend on `role !== 'planner'` (`KanbanProvider.ts:~3302`), so the
   `/goal` + ultracode prefix is injected into **reviewer and tester** prompts — execution-mode
   directives hijacking review-mode terminals. Root cause: the gate is a denylist of one role
   instead of an allowlist of the execution roles. Separately, custom-agent prompts **return
   early** (`KanbanProvider.ts:~3166`, via `buildCustomAgentPrompt`) *before* the directive block,
   so custom roles never receive the directive at all even when appropriate.

### What we are building

- A **global "Epic Worktree Auto Mode" selector** in the WORKTREES tab → new *Epics* section,
  persisted as a single config value (`epic_worktree_mode`), applied to **newly created** epics.
  The selector chooses **what automatic worktree provisioning happens** — it does not gate manual
  creation, which is always available:
  - `none` *(default — current behavior, migration-safe)*: no automatic epic worktrees. The
    existing manual "Create Epic Worktree" button is part of this mode and is unchanged — you can
    still hand-create a shared epic worktree; there is simply no automation.
  - `per-subtask` *(Feature 1)*: extension auto-provisions one worktree per subtask off a shared
    epic integration branch, records the mapping in the epic file, and hands the agent the paths.
  - `high-low` *(Feature 2)*: at epic creation, provisions exactly two tier worktrees (high / low);
    the planner consolidates the epic's subtasks into two plan files; the implementing agent runs
    both tiers in parallel via subagents.
- A **bug fix**: scope the ultracode/goal directive to `lead`/`coder`/`intern` only, plus a new
  per-custom-role opt-in (`applyEpicDirectives`).

### Non-goals

- No per-epic mode override (explicitly a **global** default per requirements).
- No change to non-epic plan dispatch, the planner's `improve-plan.md` core flow (only additive
  directives), or the existing Merge/Abandon UX beyond extending it for multi-worktree epics.
- No auto-migration of existing epics into a new topology — mode applies to epics created *after*
  it is set.

---

## Confirm-on-review decisions

These were chosen as sensible, migration-safe defaults. Flag any you want changed before build:

|| # | Decision | Default chosen | Alternative |
||---|----------|----------------|-------------|
|| D1 | Default mode & mode set | **Settled (Option A):** selector chooses the *auto* mode = `none`/`per-subtask`/`high-low`, default `none`. Manual "Create Epic Worktree" lives under `none` and is always available (no separate `single` mode) | — |
|| D2 | High/low boundary | complexity **≥5 = high**, ≤4 = low (matches pair-programming) | A dedicated configurable threshold |
|| D3 | Subtask-worktree branch base | off the **epic integration branch** | off `main` directly |
|| D4 | Subtask worktree on subtask **removal** | auto-**abandon** (discard branch) | keep until epic merge |
|| D5 | Custom-role opt-in shape | single `applyEpicDirectives` checkbox (board flags decide which of goal/ultracode) | a 5-way policy enum |
|| D6 | High/low consolidated plans | **new** plan files, originals kept & back-linked (per your answer) | rewrite in place |

---

## Architecture overview

```
WORKTREES tab ──(epic_worktree_mode: single|per-subtask|high-low)──► config table
                                                   │
Epic created ──────────────────────────────────────┤
   none       → no auto worktree (manual button as today)  [default]
   per-subtask→ create epic integration worktree (branch off main, epic_id-bound)
   high-low   → create epic integration branch + 2 tier worktrees (high/low)
                                                   │
Subtask added (per-subtask mode) ──────────────────┘
   → create worktree branched off epic branch, bound to subtask_plan_id
   → _regenerateEpicFile() rewrites BEGIN/END WORKTREES block in the epic .md

Dispatch ► generateUnifiedPrompt(role, …)
   built-in roles: prepend ultracode/goal ONLY if role ∈ {lead,coder,intern}
   custom roles  : prepend ONLY if addons.applyEpicDirectives === true (injected
                   inside the custom-agent branch, before its early return)
   planner (high-low epic): inject consolidation directive
   executor: inject mode-specific orchestration directive (pre-created worktree paths)

Convergence: subtask branch ─merge→ epic integration branch ─merge→ main (one merge up)
```

---

## Subtask plan dependency graph

```
Part 0 (bug fix — directive scope)         [independent, ships first]
    │
    ▼
Part 1 (mode selector + config)            [config foundation]
    │
    ├──► Part 2 (worktree-per-subtask)     [needs Part 1 + V42 schema]
    │
    └──► Part 3 (high/low split)           [needs Part 1 + V42 schema]
              │
              ▼
         Part 4 (directive wiring)         [needs Parts 2 & 3]
```

Part 0 ships independently as a standalone low-risk PR. Parts 2 and 3 both depend on Part 1
(mode config) and the V42 schema; they can proceed in parallel after that. Part 4 finalizes
shared prompt wiring once 2 & 3 land.

---

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Part 0 — Directive Scope Bug Fix (ultracode/goal leak)](../plans/part0-directive-scope-bugfix.md) — **CODE REVIEWED**
- [ ] [Part 1 — Epic Worktree Mode Selector + Config Foundation](../plans/part1-epic-worktree-mode-selector.md) — **CODE REVIEWED**
- [ ] [Part 2 — Worktree-per-subtask (Feature 1)](../plans/part2-worktree-per-subtask.md) — **CODE REVIEWED**
- [ ] [Part 3 — High/low Complexity Split (Feature 2)](../plans/part3-high-low-complexity-split.md) — **CODE REVIEWED**
- [ ] [Part 4 — Directive Wiring Centralization (cross-cutting)](../plans/part4-directive-wiring.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Subtasks

- [ ] [Part 0 — Directive scope bug fix](../plans/part0-directive-scope-bugfix.md) — **CREATED**
- [ ] [Part 1 — Epic worktree mode selector + config](../plans/part1-epic-worktree-mode-selector.md) — **CREATED**
- [ ] [Part 2 — Worktree-per-subtask](../plans/part2-worktree-per-subtask.md) — **CREATED**
- [ ] [Part 3 — High/low complexity split](../plans/part3-high-low-complexity-split.md) — **CREATED**
- [ ] [Part 4 — Directive wiring centralization](../plans/part4-directive-wiring.md) — **CREATED**

---

## Cross-cutting risks & edge cases

- **Migration safety (4k installs):** default `none` + no auto-creation means existing epics and
  existing worktree rows are untouched; V42 is additive `ADD COLUMN` only (3 new nullable columns).
- **`worktrees.path` storage — RESOLVED during review:** path IS a stored `TEXT NOT NULL` column
  (V30/V31 recreated the table with it; V24's derivation was reverted). V42 does not touch `path`;
  no derivation logic is needed.
- **Branch/worktree name collisions:** reuse the existing slug + numeric-suffix retry in
  `_createSafetyWorktree`.
- **Subtask added before integration worktree exists** (mode toggled mid-epic): create the
  integration worktree lazily on first subtask add if missing; or only honor mode at creation
  (confirm — leaning lazy-create for robustness). **Lazy-create MUST be idempotent:** reuse the
  existing "epic already has an active worktree" guard from `createWorktreeForEpic` (~7739) so two
  near-simultaneous subtask adds cannot race and create two integration worktrees for one epic.
- **Mode changed after epic creation:** mode is read at creation/subtask-add; pre-existing epics
  keep their topology. Document this so users aren't surprised.
- **Merge ordering for per-subtask:** subtasks merge into the integration branch independently;
  conflicts surface there, not on main — which is the intended isolation benefit.
- **Custom-agent early return:** confirmed during review — the custom-agent branch returns at
  `buildCustomAgentPrompt(...)` (~3184–3189), BEFORE the epic-directive block (~3315), so custom
  agents never receive the directive today. The helper-injection point (Part 0 step 3) is correct.

---

## Open verification items (to settle during build, not blocking approval)

1. Exact line of the custom-agent early return vs the epic-directive block. **Partially resolved
   during review:** confirmed the custom-agent branch returns at `buildCustomAgentPrompt(...)`
   (~3184–3189) BEFORE the epic-directive block (~3315). Confirm the exact line hasn't drifted at
   build time.
2. ~~Whether `worktrees.path` is stored or derived post-V24.~~ **RESOLVED during review:** `path` is
   a stored `TEXT NOT NULL` column (V30/V31). V42 is additive only; no derivation logic.
3. Confirm `assignPlansToEpic` and `updateEpicStatus` are the only subtask-add entry points (plus
   the loop inside `createEpicFromPlanIds`). **Expanded during review:** also enumerate the
   webview message-handler layer — `addSubtaskToEpic` (~7947) calls `updateEpicStatus`, and any
   `removeSubtaskFromEpic` path must trigger worktree abandon (D4). The subtask-add hook must fire
   from ALL of: `createEpicFromPlanIds` subtask loop, `assignPlansToEpic`, and the
   `addSubtaskToEpic` message handler (which funnels through `updateEpicStatus`).
4. **NEW — confirm the epic-link marker key** that `GlobalPlanWatcherService` parses to stamp
   `epic_id` on imported plan files (needed for the high-low consolidated plans to link to the
   epic). Read `GlobalPlanWatcherService._handlePlanFile` / `insertFileDerivedPlan` before
   authoring the planner consolidation directive.

---

## Adversarial Synthesis

Key risks: (1) the original plan built its schema story on a V24 "derive path" claim that V30/V31
reverted — `path` is stored, so V42 is simpler but a phantom derivation code path was almost
introduced; (2) the per-subtask merge topology is net-new git logic (merge target changes from
main to the integration branch), under-specified as "walk children"; (3) the high-low consolidated
plans have no confirmed path to receive `epic_id` linkage via the file watcher. Mitigations: V42 is
additive-only on the stored-path schema; add an explicit `mergeSubtaskWorktree`/target-worktree
resolution; confirm the watcher's epic-link marker before authoring the consolidation directive
and have the planner emit it.

---

## Recommendation

Complexity 8 → **Send to Lead Coder.** Multi-file coordination across two providers, a schema
migration, new git merge topology, and a planner-authored-file linkage dependency — this is
architectural, not a routine Coder pass. Ship Part 0 first as an independent low-risk PR, then
Parts 1–4 per the dependency graph above.

