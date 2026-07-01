# Epic Worktree Modes & Ultracode/Goal Directive Scoping

> **SUPERSEDED** — This monolithic plan has been decomposed into a governing epic + 5 subtask
> plans. The epic is the new source of truth:
> [`../epics/epic-worktree-modes-directive-scoping-8b50c095-b7c6-40b5-a9d6-2155b26fe4b6.md`](../epics/epic-worktree-modes-directive-scoping-8b50c095-b7c6-40b5-a9d6-2155b26fe4b6.md)
>
> Subtask plans:
> - [`part0-directive-scope-bugfix.md`](part0-directive-scope-bugfix.md)
> - [`part1-epic-worktree-mode-selector.md`](part1-epic-worktree-mode-selector.md)
> - [`part2-worktree-per-subtask.md`](part2-worktree-per-subtask.md)
> - [`part3-high-low-complexity-split.md`](part3-high-low-complexity-split.md)
> - [`part4-directive-wiring.md`](part4-directive-wiring.md)
>
> The full original content is preserved below for reference; all of it has been distributed into
> the epic + subtask plans above.

**Plan ID:** 7c1a4e92-8b3f-4d2a-9e6c-1f5a7b3d9c04

## Metadata

**Complexity:** 8
**Tags:** feature, backend, frontend, database, ui, devops

---

## Goal

Give epics three selectable **worktree topologies** and fix a directive-leak bug, so that
parallel subagent execution becomes a first-class, isolated workflow instead of something the
implementing agent has to improvise.

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

| # | Decision | Default chosen | Alternative |
|---|----------|----------------|-------------|
| D1 | Default mode & mode set | **Settled (Option A):** selector chooses the *auto* mode = `none`/`per-subtask`/`high-low`, default `none`. Manual "Create Epic Worktree" lives under `none` and is always available (no separate `single` mode) | — |
| D2 | High/low boundary | complexity **≥5 = high**, ≤4 = low (matches pair-programming) | A dedicated configurable threshold |
| D3 | Subtask-worktree branch base | off the **epic integration branch** | off `main` directly |
| D4 | Subtask worktree on subtask **removal** | auto-**abandon** (discard branch) | keep until epic merge |
| D5 | Custom-role opt-in shape | single `applyEpicDirectives` checkbox (board flags decide which of goal/ultracode) | a 5-way policy enum |
| D6 | High/low consolidated plans | **new** plan files, originals kept & back-linked (per your answer) | rewrite in place |

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

## Part 0 — Bug fix: scope ultracode/goal directive (do first; independent, low-risk)

**Why first:** isolated, no schema changes, immediately shippable, and de-risks the prompt path
the later parts build on.

### Changes

1. **`src/services/KanbanProvider.ts` — extract a helper.** Factor the prefix logic
   (currently inline at ~3301–3315) into:
   ```
   private async _buildEpicDirectivePrefix(workspaceRoot): Promise<string>
   ```
   returns `''` when neither flag is set, else `"/goal\n"` and/or `"<ultracode>\n\n"` in the
   existing position-zero order. Single source of truth for both call sites.

2. **Built-in role gate (`~3302`).** Replace:
   ```
   if (primaryPlan && primaryPlan.isEpic && role !== 'planner') {
   ```
   with an allowlist:
   ```
   if (primaryPlan && primaryPlan.isEpic && ['lead','coder','intern'].includes(role)) {
   ```
   Excludes reviewer, tester, planner, analyst, researcher, ticket_updater, chat.

3. **Custom-role injection (inside the `role.startsWith('custom_agent_')` branch, before the
   early `return buildCustomAgentPrompt(...)` at `~3166`).** If `primaryPlan?.isEpic` and
   `mergedAddons.applyEpicDirectives === true`, prepend `await _buildEpicDirectivePrefix(...)` to
   the built custom prompt. **Verify during implementation** that this branch truly returns before
   the line-3295 block (the two research passes disagreed); the helper makes either case correct.

4. **`src/services/agentConfig.ts`** — add to `CustomAgentAddons`:
   ```
   applyEpicDirectives?: boolean;   // opt this custom role into epic ultracode/goal prefix
   ```

5. **`src/webview/sharedDefaults.js`** — add to the custom-agent default addon list:
   ```
   { id: 'applyEpicDirectives', label: 'Apply epic ultracode/goal directives',
     tooltip: 'When dispatched on an epic, prepend the board\'s ultracode//goal directives (as for Lead/Coder/Intern).',
     default: false }
   ```

6. **`src/webview/kanban.html`** — **VERIFIED during review:** the AGENTS-tab custom-agent form
   (`agentsTabSaveCustomAgent`, ~3570) collects ONLY name + startupCommand and never renders addon
   toggles; the PROMPTS-tab addon renderer (~3371/3443/3496) iterates per built-in role from
   `sharedDefaults.js`, and there is NO custom-agent-specific addon default list in
   `sharedDefaults.js`. Therefore adding the entry to `sharedDefaults.js` alone will NOT auto-surface
   the checkbox. **Bespoke wiring IS required:** either (a) add a `customAgent` addon default list to
   `sharedDefaults.js` AND extend the PROMPTS-tab renderer to emit it for `custom_agent_*` roles, or
   (b) add a dedicated checkbox in the AGENTS-tab inline form that reads/writes
   `nextAgent.addons.applyEpicDirectives` (mirroring how `agentsTabSaveCustomAgent` already preserves
   `existing.addons`). Option (b) is the smaller change and matches the existing AGENTS-tab form
   pattern; prefer it.

### Acceptance
- Dispatching an epic card with ultracode/goal ON injects the prefix into Lead/Coder/Intern
  terminals only; reviewer & tester terminals get the clean prompt.
- A custom agent with `applyEpicDirectives` ON receives the prefix; with it OFF, does not.
- Planner unaffected.

---

## Part 1 — Epic Worktree Mode selector + config foundation

### Backend
1. **Config key** `epic_worktree_mode` in the existing `config` table (no migration needed).
   Reader/writer via existing `db.getConfig` / `setConfig`. Default `'none'` when unset.
2. **Message handlers** in `KanbanProvider.ts`: `getEpicWorktreeMode` (include in the worktree
   config payload sent by `_sendWorktreeConfig`) and `setEpicWorktreeMode` (validate ∈ enum,
   persist, echo back).

### Frontend (`kanban.html`, WORKTREES tab)
3. New **Epics** section in `createWorktreesPanel()` (~9152+) with a 3-option "Auto Mode" control
   (segmented radio or dropdown) bound to `epic_worktree_mode` — `none` / `per-subtask` /
   `high-low`, each with a one-line description. Posts `setEpicWorktreeMode`; reflects state from
   `worktreeConfig`. The existing manual "Create Epic Worktree" controls stay in the panel
   regardless of the selected mode.

### Acceptance
- Selecting a mode persists across reloads; value is read at epic-creation time.

---

## Part 2 — Feature 1: Worktree-per-subtask

### Schema (migration **V42**, `KanbanDatabase.ts`)
Add to `worktrees`: `subtask_plan_id TEXT`, `base_branch TEXT` (and `tier TEXT` for Part 3 — do
all three in one V42). **VERIFIED during review:** `worktrees.path` IS a stored `TEXT NOT NULL`
column today (V30/V31 recreated the table WITH `path`; V24's "derive at read time" approach was
reverted long ago — `getWorktrees()`/`addWorktree()` both read/write the stored `path`). So V42
is purely additive `ALTER TABLE ... ADD COLUMN` for the three new columns; the existing stored
`path` is reused unchanged — no derivation logic. Guard each `ADD COLUMN` like prior migrations
(idempotent try/catch); bump version to 42. Latest shipped migration is V41, so V42 is the
correct next number.

### Worktree creation
1. Extend `_createSafetyWorktree(workspaceRoot, topic?, repoName?)` to accept an optional
   `baseBranch` → emit `git worktree add -b <branch> <path> <baseBranch>` (falls back to current
   HEAD behavior when omitted, preserving existing callers).
2. **Epic creation in `per-subtask` mode** (`createEpicFromPlanIds`): create the **epic
   integration worktree** off `main`/default branch, `epic_id`-bound (this is the convergence
   point). Record its branch as the base for subtask worktrees.
3. **Subtask-add hook** — in `assignPlansToEpic` / `updateEpicStatus` / the subtask loop inside
   `createEpicFromPlanIds`: when the epic's mode is `per-subtask`, for each *newly* added subtask
   create a worktree branched off the epic integration branch, bound via `subtask_plan_id`. Guard
   against duplicates (subtask already has an active worktree).

### Routing precedence (`TaskViewerProvider.resolveWorktreePathForPlan` + `_cardsToPromptPlans`)
4. New order: **subtask worktree → epic worktree → project worktree → fallback**. A subtask plan
   with its own worktree routes there; the epic-level prompt still references the integration
   worktree. **VERIFIED during review:** `resolveWorktreePathForPlan(db, plan)` currently takes
   `{epicId, project}` only — to route by `subtask_plan_id` it must also receive the plan's own
   `planId` (extend the param object to `{ epicId?, project?, planId? }`) and look up
   `activeWorktrees.find(w => w.subtask_plan_id === planId)`. Confirm every caller
   (`_cardsToPromptPlans` builds the worktreePathMap at ~2674/2949; the TaskViewerProvider paths at
   ~1871/3122/16173) passes `planId` — most already pass the full plan object, so this is a
   signature widening, not a new fetch.

### Epic file representation (`_regenerateEpicFile`, `KanbanProvider.ts:~8541`)
5. Add a second auto-generated block, mirroring SUBTASKS:
   ```
   <!-- BEGIN WORKTREES (auto-generated, do not edit) -->
   ## Worktrees
   - **Epic integration**: `<branch>` → `<path>`
   - [Subtask topic](../plans/<basename>): `<branch>` → `<path>`
   <!-- END WORKTREES -->
   ```
   Regenerated whenever subtasks/worktrees change. Only emitted when the epic actually has
   worktrees (so `single`-mode epics are unaffected).

### Lifecycle
6. **Subtask removed from epic** → abandon its worktree (D4). **Subtask done** → its branch merges
   into the epic integration branch. **Epic Merge** → merge integration branch to main, then clean
   up all child subtask worktrees (extend the `mergeWorktree`/`abandonWorktree` handlers to walk
   `subtask_plan_id` children of the epic). **Abandon epic** → remove all children + integration.
   **VERIFIED during review:** the current `mergeWorktree` handler (~7894) runs
   `git -C workspaceRoot merge <branch>` — i.e. it merges the worktree branch directly into the
   **main repo** (workspaceRoot), NOT into an epic integration branch. The per-subtask convergence
   model (subtask → integration → main) therefore requires **new merge logic**, not just "walk
   children": a subtask merge must target the epic integration worktree's path/branch first
   (`git -C <integrationWtPath> merge <subtaskBranch>`), and only the epic-level merge targets main.
   Add a `mergeSubtaskWorktree` path (or a `targetWorktreeId` field on the merge message) that
   resolves the epic integration worktree from the subtask's `epic_id` and merges there. Walking
   children on epic merge/abandon remains necessary for cleanup.

### Prompt
7. Add a `per-subtask` variant of `EPIC_ORCHESTRATION_DIRECTIVE` (`agentPromptBuilder.ts`) that
   **lists the pre-created subtask worktree paths** and instructs the agent to dispatch one
   subagent per subtask into its assigned worktree (replacing the "create your own worktree"
   guidance for this mode).

### Acceptance
- Creating an epic in `per-subtask` mode creates an integration worktree; adding subtasks creates
  one worktree each off the integration branch; the epic `.md` lists them; the executor prompt
  references real paths; epic Merge converges branches and cleans up.

---

## Part 3 — Feature 2: High/low complexity split

### Worktree provisioning
1. **Epic creation in `high-low` mode**: create the epic integration branch, then exactly **two**
   tier worktrees off it — `tier='high'` and `tier='low'` (branch names `…-high` / `…-low`),
   `epic_id`-bound, distinguished by the new `tier` column (V42).

### Planner consolidation directive (`agentPromptBuilder.ts` + planner dispatch)
2. When dispatching the **planner** for a `high-low` epic, inject a directive instructing it to:
   - Read the epic's N subtask plans.
   - Consolidate them into **exactly two** plan files following the pair-programming structure:
     one **high-complexity** (subtasks scoring ≥5), one **low-complexity** (≤4) — D2.
   - Write the two new plans to `.switchboard/plans/`, **keeping the originals** and back-linking
     to them for traceability (D6).
   - Note: this is additive to `improve-plan.md`, not a replacement of it.
   - **VERIFIED during review — epic linkage gap:** the planner writes `.md` files only; it cannot
     set `epic_id` in the DB directly. `GlobalPlanWatcherService` auto-imports new plan files and
     stamps `epic_id` only if the file embeds an epic-link marker the watcher parses. The two
     consolidated plans MUST therefore embed a marker the watcher reads (e.g. an
     `**Epic:** <epicPlanId>` / `**Epic ID:** <uuid>` line mirroring how epic files embed
     `**Plan ID:**`) so they land linked to the epic on import instead of as orphan CREATED cards.
     Confirm the exact marker key the watcher parses (`GlobalPlanWatcherService._handlePlanFile` /
     `insertFileDerivedPlan`) before authoring the directive, and have the consolidation directive
     instruct the planner to emit that marker.

### Executor directive
3. A `high-low` variant of the orchestration directive instructing the implementing agent to use
   subagents to run the **high** and **low** plans **in parallel**, each inside its tier worktree
   (paths supplied from the worktrees table).

### Reality check on "infra already there"
4. True for worktree creation (reuses `_createSafetyWorktree`) and parallel/subagent prompting
   (reuses pair-programming + subagent directives). **Net-new and the bulk of the effort** is the
   planner consolidation directive and the two-plan authoring/linking logic — call this out so it
   isn't under-scoped.

### Acceptance
- Creating an epic in `high-low` mode yields two tier worktrees; dispatching the planner produces
  two consolidated plans (high/low) that link back to originals; the executor runs both tiers in
  parallel in their worktrees.

---

## Part 4 — Workflow & directive wiring (cross-cutting)

- Centralize the three orchestration-directive variants (`single`/per-subtask/high-low) in
  `agentPromptBuilder.ts`; select by the epic's mode at prompt-build time.
- Ensure the planner consolidation directive is gated to `high-low` epics only.
- Confirm no directive variant changes behavior for non-epic plans or `single`-mode epics.

---

## Suggested implementation / dependency order

```
Part 0 (bug fix)  ──►  Part 1 (mode selector + config)  ──►  Part 2 (per-subtask)
                                                          └─►  Part 3 (high-low)  ──► Part 4 (directive wiring)
```

Part 0 ships independently. Parts 2 and 3 both depend on Part 1 (mode config) and the V42 schema;
they can proceed in parallel after that. Part 4 finalizes shared prompt wiring once 2 & 3 land.

---

## Risks & edge cases

- **Migration safety (4k installs):** default `none` + no auto-creation means existing epics and
  existing worktree rows are untouched; V42 is additive `ADD COLUMN` only (3 new nullable columns).
- **`worktrees.path` storage — RESOLVED during review:** path IS a stored `TEXT NOT NULL` column
  (V30/V31 recreated the table with it; V24's derivation was reverted). V42 does not touch `path`;
  no derivation logic is needed. The original "verify whether path is stored or derived" item is
  closed.
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
- **Custom-agent early return:** confirm the exact return point so the directive helper is invoked
  on the right path (Part 0, step 3).

---

## Open verification items (to settle during build, not blocking approval)

1. Exact line of the custom-agent early return vs the epic-directive block. **Partially resolved
   during review:** the custom-agent branch returns at `buildCustomAgentPrompt(...)` (~3184–3189),
   BEFORE the epic-directive block (~3315) — so custom agents never receive the directive today,
   confirming the plan's premise. The helper-injection point (Part 0 step 3) is correct; confirm
   the exact line hasn't drifted at build time.
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

## User Review Required

Yes — confirm before build:
- **D-table decisions (D1–D6)** in the Confirm-on-review section: defaults chosen are
  migration-safe, but D4 (auto-abandon subtask worktree on subtask removal) and D6 (new
  consolidated plan files, originals kept) are irreversible-ish and worth an explicit nod.
- **Lazy-create vs creation-only** for the integration worktree when mode is toggled mid-epic
  (Risks section). Recommendation is lazy-create with an idempotency guard; confirm.
- **Merge topology change**: per-subtask mode changes the merge TARGET (subtask → integration
  branch, not → main). This is new git logic in `mergeWorktree`; confirm the UX (does the user
  merge each subtask individually, or one "merge epic" sweeps all children into integration then
  integration into main?).
- **Custom-agent checkbox wiring option (a vs b)** in Part 0 step 6.

## Complexity Audit

### Routine
- Part 0 bug fix: allowlist gate swap + helper extraction + `CustomAgentAddons` field +
  `sharedDefaults` entry — single-file-ish, reuses existing prompt path.
- Config key `epic_worktree_mode` + `getEpicWorktreeMode`/`setEpicWorktreeMode` message handlers —
  mirrors existing config read/write pattern (`db.getConfig`/`setConfig`).
- V42 `ADD COLUMN` migration — additive, guarded, mirrors V34/V41 pattern.
- WORKTREES-tab Epics section UI — mirrors existing project/epic worktree form controls.
- Epic-file WORKTREES block generation — mirrors the existing SUBTASKS block in
  `_regenerateEpicFile`.

### Complex / Risky
- **Per-subtask merge topology**: `mergeWorktree` currently merges into main; new logic merges
  subtask → integration branch first. New git command targeting a different worktree path; conflict
  surface moves to the integration branch.
- **High-low planner consolidation**: planner authors two NEW plan files that must auto-link to the
  epic via a file-watcher marker — depends on `GlobalPlanWatcherService` parsing semantics not yet
  confirmed (open item #4).
- **Subtask-add hook coverage**: must fire from 3+ entry points (`createEpicFromPlanIds` loop,
  `assignPlansToEpic`, `addSubtaskToEpic` handler) and be idempotent against duplicate worktrees +
  concurrent integration-worktree creation races.
- **Routing precedence change**: `resolveWorktreePathForPlan` signature widening across multiple
  callers in two providers.
- **Multi-worktree lifecycle cleanup**: epic merge/abandon must walk `subtask_plan_id` children and
  remove their worktrees + branches; partial-failure leaves orphaned worktrees.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - Two subtasks added near-simultaneously in `per-subtask` mode both lazy-create the integration
    worktree → mitigate with the existing "epic already has active worktree" guard (idempotent).
  - `_regenerateEpicFile` self-write loop: the new WORKTREES block must use the same byte-identical
    no-op skip guard the SUBTASKS block already uses (~8605) to avoid re-firing the plan watcher.
  - Mode toggled while a subtask-add is in flight: mode is read at creation/subtask-add time; a
    mid-flight toggle could provision for the old mode. Read mode once at the start of the
    create/assign operation and use the snapshot.
- **Security:**
  - `baseBranch` passed to `git worktree add` must be validated (no `..`, no shell metachars) —
    reuse the existing `repoName` sanitization in `_createSafetyWorktree` (~8353). Branch names are
    slug-derived, not user-raw.
  - Planner consolidation directive injects epic plan IDs into the prompt — these are UUIDs, no
    injection risk.
- **Side Effects:**
  - Auto-provisioned worktrees create real on-disk git worktrees + branches outside the repo
    (`../worktrees/`). Abandon/merge must clean these up or they accumulate. A failed partial
    cleanup leaves dangling worktrees (`git worktree prune` is not currently called — consider
    adding it to the epic merge/abandon path).
  - High-low consolidation keeps originals AND adds two new plans → board card count grows;
    originals must be visibly back-linked so the user doesn't think they're duplicates.
- **Dependencies & Conflicts:**
  - V42 must ship before Parts 2 & 3 (both need the new columns). Part 1 (config) is independent of
    V42. Part 0 is fully independent.
  - `agentPromptBuilder.ts` directive centralization (Part 4) must land after Parts 2 & 3 define
    their variant shapes, or the variants won't exist to centralize.
  - No conflict with the existing `WORKTREES_PER_PLAN_DIRECTIVE` (agent-side worktree creation) —
    the new modes pre-provision worktrees extension-side and the per-subtask directive REPLACES the
    "create your own" guidance for that mode; `none` mode keeps the old directive path unchanged.

## Dependencies

- `sess_epicworktree_v42_schema` — V42 worktrees table migration (subtask_plan_id, base_branch,
  tier). Blocks Parts 2 & 3.
- `sess_epicworktree_mode_config` — `epic_worktree_mode` config key + handlers. Blocks Parts 2 & 3
  provisioning logic (Part 1).
- `sess_epicworktree_directive_scope_fix` — Part 0 ultracode/goal allowlist + custom-role opt-in.
  Independent; de-risks the prompt path Parts 2–4 build on.
- No external library dependencies. All git operations use the existing `cp.execFile('git', …)`
  pattern already in `_createSafetyWorktree` / `mergeWorktree`.

## Adversarial Synthesis

Key risks: (1) the plan built its schema story on a V24 "derive path" claim that V30/V31 reverted —
`path` is stored, so V42 is simpler but the plan's derivation instruction would have introduced a
phantom code path; (2) the per-subtask merge topology is net-new git logic (merge target changes
from main to the integration branch), under-specified as "walk children"; (3) the high-low
consolidated plans have no confirmed path to receive `epic_id` linkage via the file watcher.
Mitigations: V42 is additive-only on the stored-path schema; add an explicit
`mergeSubtaskWorktree`/target-worktree resolution; confirm the watcher's epic-link marker before
authoring the consolidation directive and have the planner emit it.

## Verification Plan

### Automated Tests
- **SKIP for this session** per session directives — the test suite is run separately by the user.
  The following tests should be authored/extended for the separate test run:
  - `prompt-working-dir-regression.test.js` style: assert `generateUnifiedPrompt('reviewer', …)`
    for an epic does NOT contain `GOAL_EPIC_PREFIX`/`ULTRACODE_EPIC_PREFIX`; assert
    `lead`/`coder`/`intern` DO; assert a `custom_agent_*` with `applyEpicDirectives:true` DOES and
    with `:false` does NOT.
  - Migration test: load a pre-V42 DB fixture, run V42, assert the three new columns exist and are
    nullable, and that existing `worktrees.path` rows are intact.
  - `resolveWorktreePathForPlan` precedence test: subtask with its own worktree → returns subtree
    path; subtask without → epic; neither → project; none → undefined.
  - Lifecycle test: create epic in `per-subtask` mode → integration worktree + N subtask worktrees
    exist; abandon epic → all children + integration removed.

### Manual / Static Verification (this session)
- **Compilation SKIP** per session directives.
- Static cross-check (done during review): confirmed line locations, schema, signature, and
  directive constants against current `src/`.
- Pre-merge checklist for the implementer:
  1. Grep for any new `confirm(` / `window.confirm` introduced in `kanban.html` worktree handlers —
     forbidden per CLAUDE.md.
  2. Confirm V42 migration is guarded by `getMigrationVersion() < 42` and wrapped in try/catch +
    ROLLBACK like V31/V34.
  3. Confirm `_regenerateEpicFile` WORKTREES block uses the byte-identical no-op skip.
  4. Confirm no `dist/` changes are required for testing (installed-VSIX flow per CLAUDE.md).

## Recommendation

Complexity 8 → **Send to Lead Coder.** Multi-file coordination across two providers, a schema
migration, new git merge topology, and a planner-authored-file linkage dependency — this is
architectural, not a routine Coder pass. Ship Part 0 first as an independent low-risk PR, then
Parts 1–4.
