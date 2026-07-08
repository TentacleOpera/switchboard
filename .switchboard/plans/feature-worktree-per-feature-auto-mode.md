# Add a "Per Feature" Worktree Auto Mode

**Plan ID:** 3f2b9c17-6a4e-4d81-b0c5-8e2f1a7d4b93

## Metadata

**Complexity:** 4
**Tags:** feature, backend, frontend, ui

---

## Goal

Add a second **Feature Worktree Auto Mode** option — `per-feature` — that automatically
provisions **one shared worktree for the whole feature at feature-creation time**, with every
subtask routing into that single worktree. No per-subtask splitting, no manual button click.

After the companion plan (`remove-per-subtask-high-low-and-enable-agent-worktree-cleanup.md`)
removes `per-subtask` and `high-low`, the auto-mode selector becomes a two-option control:
`none` (no auto-provisioning) and `per-feature` (one worktree per feature). Within-feature
parallelism is the agent's responsibility — the companion plan narrows the git safety guardrail
so agents can `git worktree add`/`remove` themselves when worktree-per-plan guidance is active,
untracked by the extension.

### Core problems & background (root-cause analysis)

The WORKTREES tab's FEATURES → **Auto Mode** control today offers three values (`kanban.html`
`AUTO_MODE_OPTIONS`, ~10168; backend enum in `setFeatureWorktreeMode`, `KanbanProvider.ts:9185`):
`none`, `per-subtask`, and `high-low`. The companion plan removes `per-subtask` and `high-low`
as unreleased over-engineering — extension-tracked subtask-level parallelism creates mess
(N-way merge sprawl, terminal explosion, zombie accumulation) and the right parallelism unit is
the **feature** (one worktree per feature, multiple features in flight), not the subtask within
one feature.

That leaves `none` as the sole auto mode: no automatic worktrees, and the only way to get a
feature-scoped worktree is the manual **"Create Feature Worktree"** button — clicked every time,
for every feature. There is no automatic single-worktree mode. For the common workflow — "I want
this feature's work isolated in its own worktree automatically" — `none` requires a manual click
every time, and the removed `per-subtask` was actively wrong (it scattered one feature across N
checkouts).

**Root cause:** the automatic path jumps from "nothing" to manual-only. The missing mode simply
automates what the manual button already does: one worktree per feature, off the default branch,
every subtask routing into it. Per the project memory
[[merge-prompt-pattern-is-plan-only]] and the feature-as-smallest-worktree-unit decision recorded
in [[expand-git-policy-granular-controls]], the *feature* is the intended default worktree
granularity.

### Why this is small

The behavior is **already fully implemented** — it is just not reachable as an auto mode:

- **Creation:** `_ensureFeatureIntegrationWorktree` (`KanbanProvider.ts:9736`) already creates a
  single worktree bound to `feature_id` (no `tier`, no `subtask_plan_id`), off the resolved default
  branch, idempotently, opening agent terminals. This is exactly a per-feature worktree. It was
  built for `per-subtask` mode's integration worktree; after the companion plan removes
  `per-subtask`, it is repurposed as the per-feature worktree creator.
- **Routing:** the resolver precedence (after companion plan's optional simplification) is
  feature worktree → project worktree → main. In per-feature mode subtasks have no own worktree,
  so they fall through to the shared feature worktree. No routing change.
- **Merge:** the `mergeWorktree` handler (`KanbanProvider.ts:9248`) treats a feature worktree as
  an "integration" worktree needing child-convergence logic **only when children exist**
  (`allWorktrees.some(w => (w.subtask_plan_id || w.tier) && …)`). A per-feature worktree has no
  children, so it falls through to the plain merge-prompt path — the same path a `none`-mode
  manual feature worktree uses. Correct as-is.
- **Abandon / cleanup:** same story — no children to walk, plain abandon applies.
- **Prompt directive:** with no tier or subtask worktrees, `resolveFeatureOrchestrationDirective`
  (`agentPromptBuilder.ts:678`) falls back to the base `FEATURE_ORCHESTRATION_DIRECTIVE`, which
  says "If your tool supports worktree-per-plan isolation, activate it now" — agents can
  self-provision within-feature worktrees via git if they want parallelism. The companion plan's
  narrowed guardrail permits `git worktree remove` for cleanup. Correct as-is.

So the entire change is: **make `per-feature` a selectable value, and branch to
`_ensureFeatureIntegrationWorktree` at creation.** Everything downstream already works.

### Non-goals

- No new merge/abandon/routing/directive code — all reused unchanged (see above).
- No change to `none` provisioning behavior. (The D3 base-branch fix does change the base of
  **manually** created worktrees — see D3; that is intentional debt removal, not a mode behavior
  change.)
- No migration of existing features into the new topology — mode is read at creation time.
- No per-feature *override* — Auto Mode remains a single global default.
- No extension tracking of agent-created worktrees — agents self-provision via `git worktree add`
  for within-feature parallelism; the extension does not track, route, or clean up those
  worktrees. The narrowed guardrail (companion plan) permits agents to `git worktree remove` them.

---

## User Review Required

Before build, confirm the defaults in the **Confirm-on-review decisions** table below. The one
decision that changes existing user-facing behavior and **must** be acknowledged is:

- **D3 — base-branch alignment.** After this plan, all three manual creation buttons
  (`createWorktree` / `createWorktreeForFeature` / `createWorktreeForProject`) branch off the
  resolved **default branch** instead of the currently-checked-out HEAD. Anyone who previously
  clicked "Create Worktree" *while on a feature branch* expecting it to fork from that branch will
  now get a worktree off the default branch. This is the intended, more-predictable behavior
  (matches the work-on-main default [[work-on-main-never-branch-unless-asked]]), but it is a
  behavior change to call out in the changelog.

The remaining decisions (D1 value name/label, D2 radio order, D4 directive variant) are
sensible defaults chosen by this plan; flag any to change before build.

---

## Confirm-on-review decisions

Sensible defaults chosen; flag any to change before build.

| # | Decision | Default chosen | Alternative |
|---|----------|----------------|-------------|
| D1 | Value name & label | `per-feature` / **"Per Feature"** | "Shared" / "One Per Feature" |
| D2 | Radio order | after `none` (only two options: none → per-feature) | — |
| D3 | Base branch for the worktree | resolved **default branch** for **all** creation paths (auto AND the three manual buttons) — see below | leave the manual buttons on current HEAD (rejected — that's the drift we're fixing) |
| D4 | Orchestration directive | base `FEATURE_ORCHESTRATION_DIRECTIVE` (no tier/subtask paths to list; agents self-provision if they want parallelism) | a new per-feature directive variant that names the shared worktree path |

**D3 — no re-provisioning on toggle or subtask-add.** Mode is read **only at feature-creation
time**. `setFeatureWorktreeMode` only writes a config value — flipping it is inert for every
already-created feature. A feature created *before* the mode was set to `per-feature` gets **no**
automatic worktree; the user clicks the manual "Create Feature Worktree" button if they want one.
This is a hard requirement: an earlier draft proposed lazy-creating the worktree when a subtask is
later added to an existing feature — that was **rejected** as it would spin up worktrees for
old/code-reviewed features and break the read-at-creation invariant.

**D3 — fix the base-branch drift, don't work around it.** Today the three manual creation handlers
(`createWorktree` unbound, `createWorktreeForFeature`, `createWorktreeForProject`) all call
`_createSafetyWorktree` with **no** base branch → they branch off whatever the repo's **current
HEAD** happens to be. Only the auto path (`_ensureFeatureIntegrationWorktree`) passes the resolved
**default branch**. That split is pure historical drift — the manual buttons predate the
integration-worktree helper. A worktree exists to hold isolated work that merges back to main; it
should start from the default branch, not from a stray feature branch someone left checked out. So
this plan **aligns all four creation paths on the default branch** (`_resolveDefaultBranch`),
removing the inconsistency rather than adding a mode on top of it. This is a three-line change and
leaving it would reintroduce the same confusion the next time someone reads this code.

---

## Complexity Audit

### Routine
- Enum widening in `setFeatureWorktreeMode` (1 line) — after companion plan trims to `['none']`,
  this becomes `['none', 'per-feature']`.
- Creation branch in `createFeatureFromPlanIds` (reuses existing `_ensureFeatureIntegrationWorktree`
  — the sole surviving provisioner after companion plan deletes the other two).
- `AUTO_MODE_OPTIONS` array entry (webview, generic renderer — no new wiring).
- Known-mode guard update in `agentPromptBuilder` (add `'per-feature'` to the known-modes list so
  no warning fires).
- (D3) Thread `_resolveDefaultBranch` into the three manual creation handlers (mechanical; the
  `baseBranch` param and its validation already exist on `_createSafetyWorktree`).

### Complex / Risky
- **None.** No new git logic, no schema, no routing/merge/abandon changes — every downstream path
  is the already-shipped `none`-mode-feature-worktree path. The only judgment call is D3 (base
  branch), which is a one-word choice between two existing helpers.

---

## Edge-Case & Dependency Audit

**Race Conditions**
- `_ensureFeatureIntegrationWorktree` already has a race fallback
  (`KanbanProvider.ts:9764-9766`): if a near-simultaneous call creates the worktree first, the
  catch re-reads `getWorktrees()` and returns the now-existing row. `per-feature` reuses this
  unchanged.
- `createFeatureFromPlanIds` snapshots `feature_worktree_mode` **once** (10717). After the
  companion plan removes per-subtask/high-low, the snapshot branch simplifies to just the
  per-feature check — no mid-creation mode toggle can split the feature between two provisioning
  behaviors.

**Security**
- `baseBranch` is passed to `git` via `execFileAsync` args (no shell) and is already validated in
  `_createSafetyWorktree` (`KanbanProvider.ts:10016`) — rejects `..` and `\\`; `/` is intentionally
  allowed (legitimate in refs like `release/1.0`). D3 threads an already-sanitized value; no new
  injection surface.
- Enum widening: an invalid mode is still rejected by the existing `showWarningMessage` guard
  (`setFeatureWorktreeMode`, 9187). `per-feature` is added to the allow-list, so it passes.

**Side Effects**
- **D3 behavior change:** the three manual creation buttons now branch off the default branch
  instead of current HEAD. Worktree rows created before this change keep their recorded
  `base_branch` (or NULL); the merge path reads the branch *name*, not the base, so historical rows
  are unaffected. Call this out in the changelog (see User Review Required).
- Mid-lifecycle mode toggle is **inert** for all existing features — `setFeatureWorktreeMode`
  writes a config value only; zero worktrees created on toggle.
- Adding a subtask to a pre-existing feature via `assignPlansToFeature` / `addSubtaskToFeature`
  creates **zero** per-feature worktrees — after the companion plan, there is no provisioner call
  in that path at all (the per-subtask provisioner was deleted). No `per-feature` branch is added
  there either.
- No `confirm()` / `window.confirm` / modal confirmation introduced anywhere (per CLAUDE.md
  [[no-confirm-dialogs-ever]]). Verified: no confirm gates in the touched webview code.

**Dependencies & Conflicts**
- **Depends on companion plan** `remove-per-subtask-high-low-and-enable-agent-worktree-cleanup.md`
  being executed first or in the same coder pass. The companion plan trims the enum to `['none']`,
  deletes the other two provisioners, and simplifies `resolveFeatureOrchestrationDirective`. This
  plan then widens the enum to `['none', 'per-feature']` and adds the creation branch.
- **Migration safety (~4k installs):** purely additive — a new enum value + one creation branch.
  Default stays `none`; existing features and worktree rows untouched. **No schema change** — the
  `worktrees.base_branch` column already exists (`KanbanDatabase.ts:31`, `addWorktree` 6th param
  at 3071) and is already written by the auto path. See [[switchboard-dev-only-no-migrations]].
- No conflict with `none` provisioning — its branch is untouched and remains unchanged.

---

## Dependencies

- Companion: `remove-per-subtask-high-low-and-enable-agent-worktree-cleanup.md` (Plan A) — must
  execute first or in the same pass. Plan A removes per-subtask/high-low and narrows the guardrail;
  this plan adds `per-feature` against the simplified two-mode world.
- No prior session (`sess_…`) dependency; all referenced code is in `main`.

---

## Adversarial Synthesis

**Risk Summary:** Key risks are (1) the D3 base-branch alignment silently changing the base of the
three manual creation buttons — a real behavior change for users who forked off a checked-out
feature branch, and (2) the read-at-creation invariant must stay intact so a mid-lifecycle toggle
or subtask-add never mass-provisions worktrees for old features. Mitigations: D3 deliberately
converges all four creation paths on the default branch (matching the work-on-main convention) and
is changelog-flagged; the `per-feature` branch is added **only** to `createFeatureFromPlanIds`,
never to `assignPlansToFeature`, and after the companion plan there is no provisioner call in that
path at all — so the invariant is preserved by the absence of the code, not by a new guard.

---

## Proposed Changes

### 1. `src/services/KanbanProvider.ts`

**a. Widen the mode enum** — `setFeatureWorktreeMode` handler (~9185). After companion Plan A
trims to `['none']`, widen to:
```ts
const validModes = ['none', 'per-feature'];
```

**b. Provision at feature creation** — `createFeatureFromPlanIds` (~10717). After companion Plan A
deletes the per-subtask/high-low branches, replace the snapshot branch with:
```ts
const featureWorktreeModeSnapshot = (await db.getConfig('feature_worktree_mode')) || 'none';
if (featureWorktreeModeSnapshot === 'per-feature') {
    await this._ensureFeatureIntegrationWorktree(workspaceRoot, db, effectiveFeaturePlanId, featureName);
}
```
The subtask loop below is unchanged (after Plan A, there is no `_provisionSubtaskWorktreeIfNeeded`
call in it — Plan A deleted it). Subtasks correctly get **no** own worktree and share the feature
worktree.

**c. Leave the `assignPlansToFeature` / `addSubtaskToFeature` path untouched.** After companion
Plan A, there is no provisioner call in this path at all. No `per-feature` branch is added here —
mode is read only at feature-creation, and the invariant is preserved by the absence of the code.

**d. (D3) Align the three manual creation handlers on the default branch.** Each currently omits
the `baseBranch` arg to `_createSafetyWorktree` and so branches off current HEAD; pass the
resolved default branch and record it via `addWorktree`'s `base_branch` param, matching the auto
helper. All three sit adjacent in the message switch:
- `createWorktree` (unbound, ~9051)
- `createWorktreeForFeature` (~9090)
- `createWorktreeForProject` (~9125)

For each, resolve once and thread it through, e.g. for the feature handler:
```ts
const defaultBranch = await this._resolveDefaultBranch(workspaceRoot);
const { branch, path: wtPath } = await this._createSafetyWorktree(workspaceRoot, msg.featureTopic, msg.repoName, defaultBranch);
await db.addWorktree(branch, wtPath, msg.featureId ? String(msg.featureId) : undefined, undefined, undefined, defaultBranch);
```
(unbound passes `msg.project` to `addWorktree` as today; project handler passes `msg.project` and
no feature id — only the trailing `base_branch` arg is added). `_createSafetyWorktree` already
validates `baseBranch` (rejects `..`/`\\`) and falls back cleanly, so this is purely passing a
value that was already plumbed through for the auto path. No behavior change beyond the base branch.

### 2. `src/services/agentPromptBuilder.ts`

After companion Plan A simplifies `resolveFeatureOrchestrationDirective` and its guard, add
`'per-feature'` to the known-mode list so it does **not** log the "Unknown feature_worktree_mode"
warning:
```ts
if (mode !== undefined && !['none', 'per-feature'].includes(mode)) {
    console.warn(`[agentPromptBuilder] Unknown feature_worktree_mode "${mode}" …`);
}
```
No new directive variant (D4). The base `FEATURE_ORCHESTRATION_DIRECTIVE` already says "If your
tool supports worktree-per-plan isolation, activate it now" — agents self-provision if they want
within-feature parallelism. The companion plan's narrowed guardrail permits `git worktree remove`
for cleanup.

### 3. `src/webview/kanban.html`

After companion Plan A removes per-subtask and high-low from `AUTO_MODE_OPTIONS`, add the
`per-feature` entry:
```js
const AUTO_MODE_OPTIONS = [
    { value: 'none', label: 'None', desc: 'No automatic worktrees — use the manual creation buttons below to create an individual worktree for a single project or feature to keep work isolated.' },
    { value: 'per-feature', label: 'Per Feature', desc: 'Automatically create ONE shared worktree for the whole feature at creation. Every subtask runs inside it — one branch, one working copy, one merge back to main. The isolation of a worktree without fragmenting the feature across many checkouts. For within-feature parallelism, agents can create their own worktrees via git.' }
];
```
The radio group, `setFeatureWorktreeMode` post, and state reflection are generic over the array —
no other webview change. (`radio.name = 'featureWorktreeAutoMode'` already handles selection.)

---

## Architecture overview

```
Auto Mode = per-feature (config: feature_worktree_mode) ──► DB config table
                                                             │
Feature created (createFeatureFromPlanIds) ──────────────────┤
   per-feature → _ensureFeatureIntegrationWorktree(feature_id)   [ONE worktree, off default branch]
                 subtask loop: (no provisioner — companion plan deleted it)
                                                             │
Subtask added later (assignPlansToFeature) ──────────────────┘  → NO worktree creation (read-at-creation only)
Mode toggled ON for existing features ───────────────────────►  inert (config write only; zero worktrees created)

Dispatch ► resolveWorktreePathForPlan(subtask) → feature integration WT → coder edits there
Prompt   ► resolveFeatureOrchestrationDirective(mode=per-feature) → base FEATURE_ORCHESTRATION_DIRECTIVE
           (says "activate worktree-per-plan isolation now" — agents can self-provision via git)
           GIT_SAFETY_DIRECTIVE_WORKTREE_MODE active (companion plan) — permits git worktree remove

Merge (mergeWorktree on the feature worktree): no subtask/tier children exist →
   plain merge-prompt path (target = base_branch || defaultBranch)  [reused none-mode path]
Abandon: plain abandon [reused]
```

---

## Acceptance criteria

- Selecting **Per Feature** persists across reloads; the value round-trips through
  `feature_worktree_mode`.
- Creating a feature in `per-feature` mode creates exactly **one** worktree, bound to the feature,
  visible under FEATURES → **Active Feature Worktrees**; **no** subtask worktrees are created.
- Dispatching any subtask of that feature routes the coder into the shared feature worktree path
  (worktree indicator shows it; coder prompt references it).
- Merging the feature worktree produces a merge prompt targeting the default branch and, after
  user confirmation, the worktree is removed (no orphaned children, no integration-branch hop).
- `none` provisioning behavior is unchanged.
- No "Unknown feature_worktree_mode" warning is logged for `per-feature`.
- (D3) A worktree created via any of the three manual buttons now branches off the repo's default
  branch, not current HEAD — verifiable via `git -C <worktree> log --oneline -1` sharing the
  default branch tip, and the `worktrees.base_branch` column recording the default branch.
- **Companion-plan dependency:** `per-subtask` and `high-low` do not appear in the Auto Mode
  selector (companion Plan A removed them).

---

## Risks & edge cases

- **Migration safety (~4k installs):** purely additive — a new enum value + one creation branch.
  Default stays `none`; existing features and worktree rows untouched. No schema change (reuses
  the existing `feature_id`-bound worktree shape; no new columns). See
  [[switchboard-dev-only-no-migrations]].
- **Shape collision with the manual button:** the manual "Create Feature Worktree" button and
  `_ensureFeatureIntegrationWorktree` produce the **same** row shape (`feature_id` set, no
  `tier`, no `subtask_plan_id`). `_ensureFeatureIntegrationWorktree`'s existing-check therefore
  reuses a manually-created feature worktree instead of creating a second — correct and
  idempotent.
- **Base-branch change (D3):** after this plan, both auto and manual creation branch off the
  default branch, so the divergence is gone. Behavior change to flag for users: someone who
  previously clicked "Create Worktree" *while on a feature branch* expecting it to fork from that
  branch will now get a worktree off the default branch. This is the intended, more-predictable
  behavior (worktrees converge back to main), and it matches the extension's work-on-main default
  [[work-on-main-never-branch-unless-asked]]; call it out in the changelog. Worktree rows created
  before this change keep their recorded `base_branch` (or NULL) — the merge path reads the branch
  name, not the base, so historical rows are unaffected.
- **Mid-lifecycle mode toggle — NO mass provisioning:** mode is read **only at feature creation**.
  Turning `per-feature` ON does not create worktrees for any existing feature —
  `setFeatureWorktreeMode` writes a config value and nothing else. Only features created *after*
  the toggle get one. This matches the `none` mode's read-at-creation invariant.
- **No confirm dialogs** introduced anywhere (per CLAUDE.md [[no-confirm-dialogs-ever]]).

---

## Verification Plan

### Manual / static (this session)
- Compilation SKIP per session directives (installed-VSIX flow; `dist/` not used — CLAUDE.md).
- Static cross-check the edit sites against current `src/` line numbers before editing (they
  drift): `setFeatureWorktreeMode` enum, `createFeatureFromPlanIds` snapshot branch,
  `AUTO_MODE_OPTIONS`, the `agentPromptBuilder` guard, and the three manual creation handlers
  (`createWorktree` / `createWorktreeForFeature` / `createWorktreeForProject`) for the D3
  base-branch threading. Confirm the `assignPlansToFeature` / `addSubtaskToFeature` path has **no**
  provisioner call (companion Plan A deleted it) and no `per-feature` branch is added there.
- Grep for any accidental `confirm(`/`window.confirm` in touched webview code — forbidden.

### Runtime (after install)
1. WORKTREES tab → confirm Auto Mode shows exactly two options: **None** and **Per Feature**. No
   Per Subtask or High/Low.
2. Set Auto Mode = **Per Feature**; reload; confirm it stays selected.
3. Create a feature with 2–3 subtasks → confirm exactly one worktree appears under Active Feature
   Worktrees and none per subtask.
4. Dispatch a subtask → confirm the worktree indicator and coder working dir point at the shared
   feature worktree.
5. Merge the feature worktree → confirm the merge prompt targets the default branch and, after
   user confirmation, the worktree is removed.
6. **Regression guard:** on a board with several pre-existing features, toggle Auto Mode to
   **Per Feature** → confirm **no** worktrees are created for any of them, then add a subtask to
   one → confirm **still no** worktree is created (only newly-*created* features provision).
7. Flip back to `none` and confirm its behavior is unchanged.
8. **(D3)** With a non-default branch checked out in the repo, click each manual creation button
   (unbound / feature / project) → confirm each new worktree is based on the **default** branch,
   not the checked-out one (`git -C <worktree> merge-base --is-ancestor <defaultTip> HEAD`), and
   `worktrees.base_branch` records the default branch.

### Automated Tests
*(Authored for the separate test run — SKIP executing in this session per session directives.)*
- `resolveFeatureOrchestrationDirective('per-feature', …)` returns the base directive and logs no
  warning.
- A feature created under `per-feature` yields one `feature_id`-bound worktree with `tier=null`,
  `subtask_plan_id=null`, and zero subtask worktrees.

---

## Recommendation

Complexity 4 → **Send to Coder.** Additive edits across two source files + one webview array
entry, plus a mechanical three-handler base-branch alignment (D3), every downstream path reusing
shipped code. No architecture, no schema, no new git logic — but the D3 base-branch change is a
real user-facing behavior change (manual buttons fork off the default branch instead of current
HEAD), which warrants a coder's judgment and a changelog note rather than an intern pass. Ship
together with companion Plan A (`remove-per-subtask-high-low-and-enable-agent-worktree-cleanup.md`)
for the coordinated release; execute Plan A first (deletion), then this plan (addition).

**Stage Complete:** PLAN REVIEWED

## Review Findings

Implementation matches the plan: `per-feature` added to `validModes` in both `setFeatureWorktreeMode` and the orchestration-restore path; `createFeatureFromPlanIds` branches to `_ensureFeatureIntegrationWorktree` **only** for `per-feature` (read-at-creation invariant preserved — no provisioner remains in `assignPlansToFeature`/`addSubtaskToFeature`); `AUTO_MODE_OPTIONS` = none+per-feature; the known-mode guard includes `per-feature`. D3 base-branch alignment verified across all three manual handlers — `defaultBranch` threaded to `_createSafetyWorktree` (4th positional param `baseBranch`) and `addWorktree` (6th positional param `baseBranch`), both positional contracts confirmed against their signatures. Regression: the orchestration fan-out (`TaskViewerProvider._orchestrationDispatchFeature`) is correctly rewired to dispatch all eligible subtasks as one batch into the single feature worktree; the new `'orchestration-kickoff'` instruction arg is inert for coder/lead (instruction only affects the planner workflow-name and is never injected into the prompt body). No code changes required for this plan — the single applied fix (stale orchestration UI text) is recorded under companion Plan A. Validation: static audits pass; compile/tests skipped per directive; the only residual risk is the intended, changelog-flagged D3 behavior change (manual buttons now fork off the default branch, not current HEAD).
