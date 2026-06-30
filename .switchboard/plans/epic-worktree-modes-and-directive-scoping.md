# Epic Worktree Modes & Ultracode/Goal Directive Scoping

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

- A **global "Epic Worktree Mode" selector** in the WORKTREES tab → new *Epics* section, persisted
  as a single config value (`epic_worktree_mode`), applied to **newly created** epics:
  - `none` *(default — current behavior, migration-safe)*: no automatic epic worktrees at all. The
    existing manual "Create Epic Worktree" button is unchanged and remains available.
  - `per-subtask` *(Feature 1)*: extension auto-provisions one worktree per subtask off a shared
    epic integration branch, records the mapping in the epic file, and hands the agent the paths.
  - `high-low` *(Feature 2)*: at epic creation, provisions exactly two tier worktrees (high / low);
    the planner consolidates the epic's subtasks into two plan files; the implementing agent runs
    both tiers in parallel via subagents.
  - **Open fork (D1):** whether a fourth `single` option (auto-provision one shared worktree at
    creation) is also offered, or whether "single shared worktree" stays purely as the manual
    button. Recommendation: keep it manual → three selector modes (`none`/`per-subtask`/`high-low`).
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
| D1 | Default mode & mode set | `none` (no auto worktrees = today). Selector = `none`/`per-subtask`/`high-low`; "single shared" stays the manual button | Add a 4th `single` mode that auto-provisions one shared worktree at creation |
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

6. **`src/webview/kanban.html`** — confirm the custom-agent addon renderer (~3373–3378, 3513–3532)
   surfaces the new checkbox; it should, since it iterates the defaults list. No bespoke wiring
   expected.

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
3. New **Epics** section in `createWorktreesPanel()` (~9152+) with a 3-option control (segmented
   radio or dropdown) bound to `epic_worktree_mode`, each option carrying a one-line description.
   Posts `setEpicWorktreeMode`; reflects state from `worktreeConfig`.

### Acceptance
- Selecting a mode persists across reloads; value is read at epic-creation time.

---

## Part 2 — Feature 1: Worktree-per-subtask

### Schema (migration **V42**, `KanbanDatabase.ts`)
Add to `worktrees`: `subtask_plan_id TEXT`, `base_branch TEXT` (and `tier TEXT` for Part 3 — do
all three in one V42). Per V24, **path is derived from git at read time** — do not reintroduce a
stored path; continue deriving. Idempotent `ALTER TABLE ... ADD COLUMN` guarded like prior
migrations; bump version to 42.

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
   worktree.

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

- **Migration safety (4k installs):** default `single` + no auto-creation means existing epics and
  existing worktree rows are untouched; V42 is additive `ADD COLUMN` only.
- **Branch/worktree name collisions:** reuse the existing slug + numeric-suffix retry in
  `_createSafetyWorktree`.
- **Subtask added before integration worktree exists** (mode toggled mid-epic): create the
  integration worktree lazily on first subtask add if missing; or only honor mode at creation
  (confirm — leaning lazy-create for robustness).
- **Mode changed after epic creation:** mode is read at creation/subtask-add; pre-existing epics
  keep their topology. Document this so users aren't surprised.
- **`worktrees.path` vs V24:** verify whether a `path` column still exists or is fully derived; the
  plan assumes derivation. Align before writing migration V42.
- **Merge ordering for per-subtask:** subtasks merge into the integration branch independently;
  conflicts surface there, not on main — which is the intended isolation benefit.
- **Custom-agent early return:** confirm the exact return point so the directive helper is invoked
  on the right path (Part 0, step 3).

---

## Open verification items (to settle during build, not blocking approval)

1. Exact line of the custom-agent early return vs the epic-directive block.
2. Whether `worktrees.path` is stored or derived post-V24.
3. Confirm `assignPlansToEpic` and `updateEpicStatus` are the only subtask-add entry points (plus
   the loop inside `createEpicFromPlanIds`).
