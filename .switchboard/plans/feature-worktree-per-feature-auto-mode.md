# Add a "Per Feature" Worktree Auto Mode

**Plan ID:** 3f2b9c17-6a4e-4d81-b0c5-8e2f1a7d4b93

## Metadata

**Complexity:** 4
**Tags:** feature, backend, frontend, ui

---

## Goal

Add a fourth **Feature Worktree Auto Mode** option — `per-feature` — that automatically
provisions **one shared worktree for the whole feature at feature-creation time**, with every
subtask routing into that single worktree. No per-subtask splitting, no manual button click.

### Core problems & background (root-cause analysis)

The WORKTREES tab's FEATURES → **Auto Mode** control today offers exactly three values
(`kanban.html` `AUTO_MODE_OPTIONS`, ~10124; backend enum in `setFeatureWorktreeMode`,
`KanbanProvider.ts:9178`):

- `none` — no automatic worktrees. The only way to get a feature-scoped worktree is the manual
  **"Create Feature Worktree"** button.
- `per-subtask` — auto-creates a *separate* worktree for **every** subtask (off a shared
  integration branch) so subagents work in parallel.
- `high-low` — auto-creates *two* tier worktrees (high/low complexity).

There is a real gap between `none` and `per-subtask`: **there is no automatic single-worktree
mode.** The plan that introduced Auto Mode
(`.switchboard/plans/epic-worktree-modes-and-directive-scoping.md`, decision **D1**) deliberately
folded "one shared worktree per feature" into `none` as a *manual-only* action — you can hand-create
one shared worktree, but you must click the button every time, for every feature. `per-subtask`
is the least-granular *automatic* tier, and for the common workflow — "I want this feature's work
isolated in its own worktree, but I don't want N worktrees fragmenting one feature across N working
copies" — `per-subtask` is actively wrong: it scatters a single feature's subtasks across separate
checkouts that must each be merged back, when the user wanted one branch, one working copy, one
merge.

**Root cause:** the automatic path jumps straight from "nothing" to "one-per-subtask," skipping the
most common isolation unit — the feature itself. Per the project memory
[[merge-prompt-pattern-is-plan-only]] and the feature-as-smallest-worktree-unit decision recorded in
[[expand-git-policy-granular-controls]], the *feature* is the intended default worktree granularity;
the missing mode simply automates what the manual button already does.

### Why this is small

The behavior is **already fully implemented** — it is just not reachable as an auto mode:

- **Creation:** `_ensureFeatureIntegrationWorktree` (`KanbanProvider.ts:9736`) already creates a
  single worktree bound to `feature_id` (no `tier`, no `subtask_plan_id`), off the resolved default
  branch, idempotently, opening agent terminals. This is exactly a per-feature worktree. It is
  already called at feature creation for `per-subtask` mode (`createFeatureFromPlanIds:10726`).
- **Routing:** the resolver precedence is subtask-worktree → **feature integration worktree** →
  project worktree → main. In per-feature mode subtasks have no own worktree, so they fall through
  to the shared feature worktree — precisely the desired behavior. No routing change.
- **Merge:** the `mergeWorktree` handler (`KanbanProvider.ts:9250`) only treats a feature worktree
  as an "integration" worktree needing child-convergence logic **when children actually exist**
  (`allWorktrees.some(w => (w.subtask_plan_id || w.tier) && …)`). A per-feature worktree has no
  children, so it falls through to the **plain `git merge <branch>` into main** path (9263–9271) —
  the same path a `none`-mode manual feature worktree uses. Correct as-is.
- **Abandon / cleanup:** same story — no children to walk, plain abandon applies.
- **Prompt directive:** with no tier or subtask worktrees, `resolveFeatureOrchestrationDirective`
  (`agentPromptBuilder.ts:678`) falls back to the base `FEATURE_ORCHESTRATION_DIRECTIVE`. Correct;
  the coder prompt still references the shared worktree path via the existing routing/indicator.

So the entire change is: **make `per-feature` a selectable value, and branch to
`_ensureFeatureIntegrationWorktree` at creation.** Everything downstream already works.

### Non-goals

- No new merge/abandon/routing/directive code — all reused unchanged (see above).
- No change to `none`, `per-subtask`, or `high-low` *provisioning* behavior. (The D3 base-branch fix
  does change the base of **manually** created worktrees across all kinds — see D3; that is
  intentional debt removal, not a mode behavior change.)
- No migration of existing features into the new topology — mode is read at creation time, as with
  the other modes.
- No per-feature *override* — Auto Mode remains a single global default (matches D1).

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
| D2 | Radio order | insert **between** `none` and `per-subtask` (least→most granular: none → per-feature → per-subtask → high-low) | append last |
| D3 | Base branch for the worktree | resolved **default branch** for **all** creation paths (auto AND the three manual buttons) — see below | leave the manual buttons on current HEAD (rejected — that's the drift we're fixing) |
| D4 | Orchestration directive | base `FEATURE_ORCHESTRATION_DIRECTIVE` (no tier/subtask paths to list) | a new per-feature directive variant that names the shared worktree path |

**D3 — no re-provisioning on toggle or subtask-add.** Mode is read **only at feature-creation
time**, identical to `per-subtask` and `high-low` ("pre-existing features keep their topology").
`setFeatureWorktreeMode` only writes a config value — flipping it is inert for every already-created
feature. A feature created *before* the mode was set to `per-feature` gets **no** automatic
worktree; the user clicks the manual "Create Feature Worktree" button if they want one. This is a
hard requirement, not a preference: an earlier draft of this plan proposed lazy-creating the
worktree when a subtask is later added to an existing feature — that was **rejected** as it would
spin up worktrees for old/code-reviewed features and break the read-at-creation invariant the other
modes hold.

**D3 — fix the base-branch drift, don't work around it.** Today the three manual creation handlers
(`createWorktree` unbound, `createWorktreeForFeature`, `createWorktreeForProject`) all call
`_createSafetyWorktree` with **no** base branch → they branch off whatever the repo's **current
HEAD** happens to be. Only the auto path (`_ensureFeatureIntegrationWorktree`) passes the resolved
**default branch**. That split is pure historical drift — the manual buttons predate the
integration-worktree helper — and it's exactly what made "why are these different?" a question at
all. A worktree exists to hold isolated work that merges back to main; it should start from the
default branch, not from a stray feature branch someone left checked out. So this plan **aligns all
four creation paths on the default branch** (`_resolveDefaultBranch`), removing the inconsistency
rather than adding a fourth mode on top of it. This is deliberately not scoped out as "separate
tech-debt" — it's a three-line change and leaving it would reintroduce the same confusion the next
time someone reads this code.

---

## Complexity Audit

### Routine
- Enum widening in `setFeatureWorktreeMode` (1 line).
- Creation branch in `createFeatureFromPlanIds` (reuses existing `_ensureFeatureIntegrationWorktree`).
- `AUTO_MODE_OPTIONS` array entry (webview, generic renderer — no new wiring).
- Known-mode guard update in `agentPromptBuilder` (silences a warning; base directive already the fallback).
- (D3) Thread `_resolveDefaultBranch` into the three manual creation handlers (mechanical; the
  `baseBranch` param and its validation already exist on `_createSafetyWorktree`).

### Complex / Risky
- **None.** No new git logic, no schema, no routing/merge/abandon changes — every downstream path is
  the already-shipped `none`-mode-feature-worktree / per-subtask-integration-worktree path. The only
  judgment call is D3 (base branch), which is a one-word choice between two existing helpers.

---

## Edge-Case & Dependency Audit

**Race Conditions**
- `_ensureFeatureIntegrationWorktree` already has a race fallback
  (`KanbanProvider.ts:9764-9766`): if a near-simultaneous call creates the worktree first, the catch
  re-reads `getWorktrees()` and returns the now-existing row. `per-feature` reuses this unchanged.
- `createFeatureFromPlanIds` snapshots `feature_worktree_mode` **once** (10717) and threads the
  snapshot through the subtask loop, so a mode toggle mid-creation cannot split one feature between
  two provisioning behaviors. `per-feature` is added to the same snapshot branch — no new race.

**Security**
- `baseBranch` is passed to `git` via `execFileAsync` args (no shell) and is already validated in
  `_createSafetyWorktree` (`KanbanProvider.ts:10016`) — rejects `..` and `\\`; `/` is intentionally
  allowed (legitimate in refs like `release/1.0`). D3 threads an already-sanitized value; no new
  injection surface.
- Enum widening: an invalid mode is still rejected by the existing `showWarningMessage` guard
  (`setFeatureWorktreeMode`, 9187). `per-feature` is added to the allow-list, so it passes.

**Side Effects**
- **D3 behavior change:** the three manual creation buttons now branch off the default branch
  instead of current HEAD. Worktree rows created before this change keep their recorded `base_branch`
  (or NULL); the merge path reads the branch *name*, not the base, so historical rows are unaffected.
  Call this out in the changelog (see User Review Required).
- Mid-lifecycle mode toggle is **inert** for all existing features — `setFeatureWorktreeMode` writes
  a config value only; zero worktrees created on toggle (matches `per-subtask`/`high-low`).
- Adding a subtask to a pre-existing feature via `assignPlansToFeature` / `addSubtaskToFeature`
  creates **zero** per-feature worktrees — `_provisionSubtaskWorktreeIfNeeded` early-returns for any
  mode other than `per-subtask` (9872). No `per-feature` branch is added to that path.
- No `confirm()` / `window.confirm` / modal confirmation introduced anywhere (per CLAUDE.md
  [[no-confirm-dialogs-ever]]). Verified: no confirm gates in the touched webview code.

**Dependencies & Conflicts**
- Depends on the already-shipped worktree auto-mode infrastructure from
  `epic-worktree-modes-and-directive-scoping.md` (decision D1) — all merged. No blocking dependency.
- **Migration safety (~4k installs):** purely additive — a new enum value + one creation branch.
  Default stays `none`; existing features and worktree rows untouched. **No schema change** — the
  `worktrees.base_branch` column already exists (`KanbanDatabase.ts:31`, `addWorktree` 6th param at
  3071) and is already written by the auto path. See [[switchboard-dev-only-no-migrations]].
- No conflict with `none` / `per-subtask` / `high-low` provisioning — their branches are untouched
  and remain byte-for-byte unchanged.

---

## Dependencies

- None blocking — builds on the already-shipped worktree auto-mode infrastructure
  (`.switchboard/plans/epic-worktree-modes-and-directive-scoping.md`, merged; decision D1).
  No prior session (`sess_…`) dependency; all referenced code is in `main`.

---

## Adversarial Synthesis

**Risk Summary:** Key risks are (1) the D3 base-branch alignment silently changing the base of the
three manual creation buttons — a real behavior change for users who forked off a checked-out
feature branch, and (2) the read-at-creation invariant must stay intact so a mid-lifecycle toggle or
subtask-add never mass-provisions worktrees for old features. Mitigations: D3 deliberately converges
all four creation paths on the default branch (matching the work-on-main convention) and is
changelog-flagged; the `per-feature` branch is added **only** to `createFeatureFromPlanIds`, never to
`assignPlansToFeature`, and `_provisionSubtaskWorktreeIfNeeded` already no-ops for non-`per-subtask`
modes — so the invariant is preserved by reuse, not by new guard code.

---

## Proposed Changes

### 1. `src/services/KanbanProvider.ts`

**a. Widen the mode enum** — `setFeatureWorktreeMode` handler (~9178):
```ts
const validModes = ['none', 'per-feature', 'per-subtask', 'high-low'];
```

**b. Provision at feature creation** — `createFeatureFromPlanIds` (~10724), extend the snapshot
branch:
```ts
const featureWorktreeModeSnapshot = (await db.getConfig('feature_worktree_mode')) || 'none';
if (featureWorktreeModeSnapshot === 'per-feature' || featureWorktreeModeSnapshot === 'per-subtask') {
    await this._ensureFeatureIntegrationWorktree(workspaceRoot, db, effectiveFeaturePlanId, featureName);
} else if (featureWorktreeModeSnapshot === 'high-low') {
    await this._provisionHighLowTierWorktrees(workspaceRoot, db, effectiveFeaturePlanId, featureName);
}
```
The subtask loop below is unchanged: `_provisionSubtaskWorktreeIfNeeded` already returns early
unless mode === `'per-subtask'` (`KanbanProvider.ts:9872`), so per-feature subtasks correctly get
**no** own worktree and share the feature worktree.

**c. Leave the `assignPlansToFeature` / `addSubtaskToFeature` path (~10803) untouched.** Mode is
read only at feature-creation. Adding subtasks to a pre-existing feature must **not** trigger any
per-feature worktree creation. The existing `_provisionSubtaskWorktreeIfNeeded` call in that path
already no-ops for any mode other than `per-subtask`, so no change — and importantly, no
`per-feature` branch — is added here.

**d. (D3) Align the three manual creation handlers on the default branch.** Each currently omits
the `baseBranch` arg to `_createSafetyWorktree` and so branches off current HEAD; pass the resolved
default branch and record it via `addWorktree`'s `base_branch` param, matching the auto helper. All
three sit adjacent in the message switch:
- `createWorktree` (unbound, ~9051)
- `createWorktreeForFeature` (~9090)
- `createWorktreeForProject` (~9125)

For each, resolve once and thread it through, e.g. for the feature handler:
```ts
const defaultBranch = await this._resolveDefaultBranch(workspaceRoot);
const { branch, path: wtPath } = await this._createSafetyWorktree(workspaceRoot, msg.featureTopic, msg.repoName, defaultBranch);
await db.addWorktree(branch, wtPath, msg.featureId ? String(msg.featureId) : undefined, undefined, undefined, defaultBranch);
```
(unbound passes `msg.project` to `addWorktree` as today; project handler passes `msg.project` and no
feature id — only the trailing `base_branch` arg is added). `_createSafetyWorktree` already
validates `baseBranch` (rejects `..`/`\\`) and falls back cleanly, so this is purely passing a value
that was already plumbed through for the auto path. No behavior change beyond the base branch.

### 2. `src/services/agentPromptBuilder.ts`

Add `'per-feature'` to the known-mode guard in `resolveFeatureOrchestrationDirective` (~694) so it
does **not** log the "Unknown feature_worktree_mode" warning and cleanly falls back to the base
directive:
```ts
if (mode !== undefined && !['none', 'per-feature', 'per-subtask', 'high-low'].includes(mode)) {
    console.warn(`[agentPromptBuilder] Unknown feature_worktree_mode "${mode}" …`);
}
```
No new directive variant (D4).

### 3. `src/webview/kanban.html`

Add the option to `AUTO_MODE_OPTIONS` in `createWorktreesPanel` (~10124), inserted per D2:
```js
const AUTO_MODE_OPTIONS = [
    { value: 'none', label: 'None', desc: 'No automatic worktrees — use the manual creation buttons below to create an individual worktree for a single project or feature to keep work isolated.' },
    { value: 'per-feature', label: 'Per Feature', desc: 'Automatically create ONE shared worktree for the whole feature at creation. Every subtask runs inside it — one branch, one working copy, one merge back to main. The isolation of a worktree without fragmenting the feature across many checkouts.' },
    { value: 'per-subtask', label: 'Per Subtask', desc: 'Provision a dedicated worktree for every subtask so that subagents can work in parallel.' },
    { value: 'high-low', label: 'High/Low Complexity Split', desc: 'Provision two tier worktrees (high & low complexity) off the feature integration branch; the planner consolidates subtasks into two plans run in parallel.' }
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
                 subtask loop: _provisionSubtaskWorktreeIfNeeded → no-op (mode != per-subtask)
                                                             │
Subtask added later (assignPlansToFeature) ──────────────────┘  → NO worktree creation (read-at-creation only)
Mode toggled ON for existing features ───────────────────────►  inert (config write only; zero worktrees created)

Dispatch ► resolveWorktreePathForPlan(subtask) → no own WT → feature integration WT → coder edits there
Prompt   ► resolveFeatureOrchestrationDirective(mode=per-feature) → base FEATURE_ORCHESTRATION_DIRECTIVE

Merge (mergeWorktree on the feature worktree): no subtask/tier children exist →
   plain `git -C workspaceRoot merge <branch>` into main + `worktree remove`  [reused none-mode path]
Abandon: plain abandon [reused]
```

---

## Acceptance criteria

- Selecting **Per Feature** persists across reloads; the value round-trips through
  `feature_worktree_mode`.
- Creating a feature in `per-feature` mode creates exactly **one** worktree, bound to the feature,
  visible under FEATURES → **Active Feature Worktrees**; **no** per-subtask worktrees are created.
- Dispatching any subtask of that feature routes the coder into the shared feature worktree path
  (worktree indicator shows it; coder prompt references it).
- Merging the feature worktree merges its branch straight into main and removes the worktree (no
  orphaned children, no integration-branch hop).
- `none` / `per-subtask` / `high-low` *provisioning* behavior is byte-for-byte unchanged.
- No "Unknown feature_worktree_mode" warning is logged for `per-feature`.
- (D3) A worktree created via any of the three manual buttons now branches off the repo's default
  branch, not current HEAD — verifiable via `git -C <worktree> log --oneline -1` sharing the default
  branch tip, and the `worktrees.base_branch` column recording the default branch.

---

## Risks & edge cases

- **Migration safety (~4k installs):** purely additive — a new enum value + one creation branch.
  Default stays `none`; existing features and worktree rows untouched. No schema change (reuses the
  existing `feature_id`-bound worktree shape; no new columns). See [[switchboard-dev-only-no-migrations]].
- **Shape collision with the manual button:** the manual "Create Feature Worktree" button and
  `_ensureFeatureIntegrationWorktree` produce the **same** row shape (`feature_id` set, no `tier`, no
  `subtask_plan_id`). `_ensureFeatureIntegrationWorktree`'s existing-check therefore reuses a
  manually-created feature worktree instead of creating a second — correct and idempotent.
- **Base-branch change (D3):** after this plan, both auto and manual creation branch off the default
  branch, so the divergence is gone. Behavior change to flag for users: someone who previously
  clicked "Create Worktree" *while on a feature branch* expecting it to fork from that branch will now
  get a worktree off the default branch. This is the intended, more-predictable behavior (worktrees
  converge back to main), and it matches the extension's work-on-main default
  [[work-on-main-never-branch-unless-asked]]; call it out in the changelog. Worktree rows created
  before this change keep their recorded `base_branch` (or NULL) — the merge path reads the branch
  name, not the base, so historical rows are unaffected.
- **Mid-lifecycle mode toggle — NO mass provisioning (the reviewed concern):** mode is read **only
  at feature creation**. Turning `per-feature` ON does not create worktrees for any existing
  feature — `setFeatureWorktreeMode` writes a config value and nothing else. A board with 100
  features (95 in code review) gets **zero** new worktrees on toggle, and adding a subtask to any of
  them creates **zero** per-feature worktrees. Only features created *after* the toggle get one.
  This matches `per-subtask`/`high-low` exactly ("pre-existing features keep their topology") and is
  the reason the earlier lazy-create-on-subtask-add idea was cut.
- **No confirm dialogs** introduced anywhere (per CLAUDE.md [[no-confirm-dialogs-ever]]).

---

## Verification Plan

### Manual / static (this session)
- Compilation SKIP per session directives (installed-VSIX flow; `dist/` not used — CLAUDE.md).
- Static cross-check the edit sites against current `src/` line numbers before editing (they
  drift): `setFeatureWorktreeMode` enum, `createFeatureFromPlanIds` snapshot branch,
  `AUTO_MODE_OPTIONS`, the `agentPromptBuilder` guard, and the three manual creation handlers
  (`createWorktree` / `createWorktreeForFeature` / `createWorktreeForProject`) for the D3 base-branch
  threading. Confirm the `assignPlansToFeature` / `addSubtaskToFeature` path is left **unmodified**
  (no `per-feature` branch added there).
- Grep for any accidental `confirm(`/`window.confirm` in touched webview code — forbidden.

### Runtime (after install)
1. WORKTREES tab → set Auto Mode = **Per Feature**; reload; confirm it stays selected.
2. Create a feature with 2–3 subtasks → confirm exactly one worktree appears under Active Feature
   Worktrees and none per subtask.
3. Dispatch a subtask → confirm the worktree indicator and coder working dir point at the shared
   feature worktree.
4. Merge the feature worktree → confirm branch lands on main and the worktree is removed.
5. **Regression guard:** on a board with several pre-existing features, toggle Auto Mode to
   **Per Feature** → confirm **no** worktrees are created for any of them, then add a subtask to one
   → confirm **still no** worktree is created (only newly-*created* features provision).
6. Flip back to `per-subtask` / `high-low` and confirm their behavior is unchanged.
7. **(D3)** With a non-default branch checked out in the repo, click each manual creation button
   (unbound / feature / project) → confirm each new worktree is based on the **default** branch, not
   the checked-out one (`git -C <worktree> merge-base --is-ancestor <defaultTip> HEAD`), and
   `worktrees.base_branch` records the default branch.

### Automated Tests
*(Authored for the separate test run — SKIP executing in this session per session directives.)*
- `resolveFeatureOrchestrationDirective('per-feature', …)` returns the base directive and logs no
  warning.
- A feature created under `per-feature` yields one `feature_id`-bound worktree with `tier=null`,
  `subtask_plan_id=null`, and zero subtask worktrees.

---

## Recommendation

Complexity 4 → **Send to Coder.** Additive edits across two source files + one webview array entry,
plus a mechanical three-handler base-branch alignment (D3), every downstream path reusing shipped
code. No architecture, no schema, no new git logic — but the D3 base-branch change is a real
user-facing behavior change (manual buttons fork off the default branch instead of current HEAD),
which warrants a coder's judgment and a changelog note rather than an intern pass.

**Stage Complete:** PLAN REVIEWED
