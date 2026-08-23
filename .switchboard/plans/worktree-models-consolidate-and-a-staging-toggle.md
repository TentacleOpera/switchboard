# Consolidate the worktree models: a STAGING toggle for features, the strip button for projects

## Goal

Reduce four overlapping worktree models to two the user actually wants — **per project**, driven by the existing strip button, and **per feature**, driven by a new "worktrees on" toggle in the STAGING column — and record the dependency problem that blocks parallel feature worktrees as an explicit decision rather than an assumption.

### Problem Analysis

Four models exist, on three different axes, and the `worktrees` table already carries scoping columns for all of them:

```
worktrees(id, branch NOT NULL UNIQUE, path, feature_id, created_at,
          status, project, agents_open_with_grid, subtask_plan_id,
          base_branch, tier)
```

| Model | Scope | Owner | Configured where | State |
|---|---|---|---|---|
| `feature_worktree_mode: 'none'` | none | — | board setting | live |
| `feature_worktree_mode: 'per-feature'` | one per feature, shared by all subtasks | **host** provisions and removes | board setting | live |
| `useWorktreesPerPlan` | one per plan | **agent** creates its own | per-role prompt add-on (PROMPTS tab, `sharedDefaults.js:145`) | live |
| `project` column | per project | host | strip button | live |
| `subtask_plan_id` | per subtask | — | — | **write-dead** — the code calls these "legacy per-subtask rows, now write-dead" (`KanbanProvider.ts:14360-14361`), and a resolution branch still reads them (`KanbanProvider.ts:13374-13392`) |

**The two problems this plan fixes:**

**1. One button means two things, and sometimes a third.** `kanban.html:2979` is `#btn-create-worktree`, tooltip: *"Create a worktree for the selected feature, or for the active project / workspace"*. Its scope is whatever happens to be selected. It also has a **merge mode** — the same control becomes a merge action when a worktree already exists for the context (`updateCreateWorktreeButton` at `:8609`, feature merge mode at `:8636-8657`, project merge mode at `:8666-8677`, guarded at `:10541-10574` on both the class and a worktree-id match). A control whose scope depends on selection and whose verb flips between create and merge is the "fiddly" this plan removes.

**2. Per-feature mode resolves at the wrong moment.** It is read **only at feature-creation time** — `KanbanProvider.ts:14865-14871` states it: *"Mode is read ONLY at feature-creation time; a later toggle is inert for already-created features."* So enabling the mode does nothing for work already planned, and the setting is invisible at the moment it matters. STAGING is that moment: `STAGEABLE_COLUMNS = ['CREATED', 'BACKLOG', 'PLAN REVIEWED', 'STAGING']` (`kanban.html:6227`), and STAGING is *"a queue, not a"* dispatch column (`kanban.html:7479`) — work sits there immediately before going out.

**3. Manual per-feature worktrees ignore dependencies.** Two features worked in parallel worktrees off the same base branch cannot see each other's changes, and nothing in the system knows one depends on the other. That is the actual danger, and it is why "turn on worktrees" is safe for one feature at a time and unsafe as a parallel default.

### Scope: this plan is the model consolidation only

Parallel feature worktrees, dependency ordering and the operator's role in it have moved to `staging-streams-parallel-dispatch-and-worktrees.md`. That split happened because the STAGING queue turns out to already support parallel consumers — the in-flight refusal is per *team*, not per queue, so N leads drain one ordered list concurrently — which makes parallelism a dispatch-and-ordering problem rather than a worktree-model one. What remains here:

- Narrow `#btn-create-worktree` to project/workspace scope.
- Add the feature toggle in STAGING, replacing the button's feature scope.
- Retire the dead per-subtask resolution.

**And the toggle's justification is checkout isolation, not parallelism.** An earlier revision framed it as a step toward parallel worktrees; that was wrong. For one feature at a time the value is that your main checkout stays usable while a team works (the case `worktree_suppress_main_terminals` exists for), and that abandoning a bad feature is `git worktree remove --force` rather than untangling their changes from yours. Framed as a parallelism enabler it invites turning it on for a benefit it does not deliver while paying costs it does — a merge step, a second directory, and the absent-from-a-fresh-checkout class (`api-server-port.txt`, `kanban.db`) that `teams-reach-state-through-endpoints-not-host-files.md` addresses. For a user who supervises rather than works alongside, `'none'` remains the better default.

### Root Cause

Each model was added for a real case — per-plan for an agent that wanted isolation, per-feature for a shared integration branch, per-project for a long-lived tree — and none was ever reconciled against the others. The strip button then accumulated scopes because it was the only worktree control on the board.

## Metadata

**Complexity:** 3
**Tags:** ui, frontend, backend, devops, reliability

## User Review Required

- **What does the STAGING toggle write?** Either `feature_worktree_mode` (reusing the existing key, so board setting and toggle are one state) or a new staging-scoped key. **This is a contract question, not a preference:** `worktree-strategy-control-contract.test.js` pins that the control "offers exactly the two modes the verb arm accepts" and that *nothing but the user writes the strategy*. Reusing the key keeps one source of truth; a second key needs its own reason.
- **Settled: worktree management has two existing homes, plus one API route to build.**
  1. **The kanban WORKTREES tab** — the canonical surface, and it already exists: tab button at `kanban.html:2954` (`data-tab="worktrees"`), pane at `:3935`, hydrated on activation at `:6604-6608` (`renderWorktreesTab` at `:13052`). **A per-worktree "Merge prompt" button already exists here** (`kanban.html:13166-13174`), calling the same `copyWorktreeMergePrompt` helper the strip button uses. Merging is already rehomed to this surface — the strip button's merge mode is a *second* caller of the same endpoint, not the only one. Narrowing the strip button is therefore safe: the capability already has a home that lists worktrees rather than inferring one from selection.
  2. **The controller agent**, which can merge as an action like any other. This is what covers the unattended path: a stream that completes with nobody watching still gets merged. **This route does not yet exist** — `LocalApiServer.ts` has `/worktree/cleanup` (line 6413) but no `/worktree/merge` endpoint. The `copyWorktreeMergePrompt` verb is in the allowlist (`generated/verbAllowlist.ts`) and handled by `KanbanProvider.ts:13360`, but it is not exposed as an HTTP route. Building this route is in scope.

  > **Superseded:** Three homes: the WORKTREES tab, the Mission Control panel, and the controller agent.
  > **Reason:** "Mission Control panel" does not exist in this codebase — zero matches across all `.ts` and `.html` files. The plan built an architectural decision on a phantom surface. The WORKTREES tab already has the merge button; the controller-agent route needs to be built.
  > **Replaced with:** Two existing callers (WORKTREES tab + strip button) over one endpoint (`copyWorktreeMergePrompt`), plus one new HTTP route (`/worktree/merge` in `LocalApiServer.ts`) for the controller agent. The strip button's merge mode is removed by the narrowing, leaving the WORKTREES tab and the API route as the two remaining callers.

  Note the two are not alternatives — the same operation reached two ways, which is the existing pattern (`/kanban/move` is the API path a human's click takes). One endpoint, two callers after narrowing.

## Complexity Audit

### Routine

- A toggle in the STAGING column header writing the chosen config key, reflecting broadcast state.
- Narrowing `#btn-create-worktree`'s tooltip, handler and enablement to project/workspace scope.
- Moving feature-worktree provisioning from feature creation to staging.

### Complex / Risky

- **Do not add a third strategy mode.** The contract test states it directly: *"A third radio ahead of its provisioning is a dead control (PRD contract #6)."* The STAGING toggle is a **second surface for the existing two modes**, not a new one.
- **Do not let anything but the user write the strategy.** The same contract exists because `applyOversightWorktreeTopology` used to force `per-feature` on arm and restore it on disarm, and a crash left the forced value in place with the user's real one stashed under `orchestration_prior_feature_worktree_mode`. That machinery was deleted deliberately, and the stash key survives in exactly one place: a one-shot drain that consumes the key (`KanbanProvider.ts:2507-2516`). **So the operator must never set worktree strategy** — it may detect and report a dependency violation, nothing more. Any design where the operator "ensures dependencies are respected" by changing configuration recreates the exact defect the contract was written to prevent.
- **Merge mode is live state the split must preserve.** Feature-worktree merging currently has two callers: the strip button's merge mode (`kanban.html:8645-8650`) and the WORKTREES tab's per-worktree "Merge prompt" button (`kanban.html:13166-13174`), both calling `copyWorktreeMergePrompt`. The narrowing removes the strip-button caller. The WORKTREES tab caller already exists and survives, so the capability does not disappear between commits. The controller-agent API route (`/worktree/merge` in `LocalApiServer.ts`) is new work that extends the same endpoint to an HTTP caller.
- **Moving provisioning from creation to staging changes when a branch is cut.** A worktree cut at staging is based on the default branch as it is *then*, not as it was at feature creation — usually better, and a behaviour change to state explicitly. Features already created under the old timing have worktrees; the transition must not orphan or double-provision them. **The provisioning move is the load-bearing change:** `_ensureFeatureIntegrationWorktree` (`KanbanProvider.ts:13947`) must be called from `stageForQueue` (`KanbanProvider.ts:8236`) instead of `createFeatureFromPlanIds` (`KanbanProvider.ts:14871`). Without this move, the toggle is a dead control that appears to work — the UI invariant passes but no worktree is cut at staging time.
- **The contract test count assertion must be updated.** `worktree-strategy-control-contract.test.js:160-166` asserts `normalizeFeatureWorktreeMode` is called in exactly 2 places (the `_sendWorktreeConfig` broadcast at `KanbanProvider.ts:14153` and the creation-time snapshot at `:14871`). Adding a STAGING-time read in `stageForQueue` adds a third call. The test's `normalized === 2` assertion must change to `3`, and the test's comment must document the third read site. Failing to update this test blocks the build.
- **`subtask_plan_id` is write-dead but still read — and the read affects merge routing.** The resolution branch at `KanbanProvider.ts:13374-13392` consults `subtask_plan_id` to route a subtask worktree's merge into its feature integration branch instead of main. Retiring the resolution branch means legacy rows with `subtask_plan_id` set (possible across ~4,000 installs) fall through to the default merge path — merge into main directly. The plan must state this behaviour change explicitly: legacy subtask worktrees merge into main, not their (possibly gone) integration branch. Do not repurpose the column.
- **`branch TEXT NOT NULL UNIQUE` is workspace-unscoped in the current schema** (`KanbanDatabase.ts:253`), though the V24/V25 migrations used `UNIQUE(branch, workspace_id)` (`:753`, `:767`). Two workspaces cutting the same branch name collide. Owned by `scope-unscoped-tables-by-workspace-id.md`; noted because parallel worktrees make collisions more likely, not less.

## Edge-Case & Dependency Audit

**Dependencies and parallelism** are out of scope — see `staging-streams-parallel-dispatch-and-worktrees.md`.

**Migration.** Features with worktrees provisioned at creation time keep them. The toggle applies to work staged after it ships. No worktree is destroyed by this plan.

**Security.** None. No new path resolution. The new `/worktree/merge` HTTP route reuses the existing `copyWorktreeMergePrompt` verb handler — no new auth surface beyond what `LocalApiServer` already enforces.

**Side effects.** Narrowing the strip button changes a shipped affordance. Users who create feature worktrees from it will find the toggle instead — worth a release note.

## Dependencies

- **Precondition for** the per-feature-worktree queue design (pop-time provisioning, team restart in the worktree), which needs one clear feature-worktree model to build on.
- **Shares the merge-back gap** with that design — solve once.
- **Noted against** `scope-unscoped-tables-by-workspace-id.md` for the `branch` uniqueness collision.
- Independent of the orders and endpoint work.

## Adversarial Synthesis

Key risks: (1) the provisioning move is underspecified — without naming `stageForQueue` as the target and `_ensureFeatureIntegrationWorktree` as the function that moves, the toggle is a dead control that passes UI invariants but cuts no branch; (2) "Mission Control panel" was a phantom surface — the merge rehoming has two existing callers, not three, and the controller-agent route must be built; (3) the contract test's `normalizeFeatureWorktreeMode` count assertion (currently 2) will break when a third read site is added; (4) deleting the `subtask_plan_id` resolution branch changes merge routing for legacy rows from integration-branch to main. Mitigations: name the exact code paths in Proposed Changes, correct the phantom-surface decision, update the test count, and state the legacy merge behaviour change explicitly.

## Proposed Changes

### 1. STAGING column toggle — `src/webview/kanban.html`

**Context:** The STAGING column header already renders custom controls (`kanban.html:8057-8060`: staging view info, add-coder-terminal, Run queue). The toggle is a fourth control in that area.

**Logic:** A radio or checkbox labeled "Worktrees" in the `stagingViewControls` block (`:8057`), writing the existing `feature_worktree_mode` key (pending the User Review decision). Checked state derives from the `worktreeConfig` broadcast (`config.featureWorktreeMode`), never from a local click assumption — the same property the existing WORKTREES tab radio pins (`:13352`). On change, posts `setFeatureWorktreeMode` with `mode` and `workspaceRoot`, the same verb the WORKTREES tab radio uses (`:13372-13376`).

**Implementation:**
- Add the toggle HTML to the `stagingViewControls` template string at `:8057`.
- Read `config.featureWorktreeMode` from `lastWorktreeConfig` (the broadcast variable, set by the `worktreeConfig` handler at `:10500`).
- Post `setFeatureWorktreeMode` on change — reuse the existing verb arm at `KanbanProvider.ts:13320`.

**Edge Cases:** The toggle and the WORKTREES tab radio write the same key. Both must reflect broadcast state on every render so a rejected write settles back. No confirm gate (project rule + `confirm()` is a no-op in webviews).

### 2. Provision at staging, not at feature creation — `src/services/KanbanProvider.ts`

**Context:** Currently `_ensureFeatureIntegrationWorktree` (`:13947`) is called from `createFeatureFromPlanIds` (`:14871`) when `featureWorktreeModeSnapshot === 'per-feature'`. The staging entry point is `stageForQueue` (`:8236`), which currently does queue-position assignment, board refresh, and queue-watch arming — no worktree provisioning.

**Logic:** Move the provisioning read from `createFeatureFromPlanIds` to `stageForQueue`. When a feature is staged, read `feature_worktree_mode` (via `normalizeFeatureWorktreeMode`); if `'per-feature'`, call `_ensureFeatureIntegrationWorktree` for the feature. Remove the provisioning call from `createFeatureFromPlanIds` (keep the mode snapshot read removal clean — the snapshot was there to prevent mid-creation mode-toggle splits, which is no longer relevant when provisioning doesn't happen at creation).

**Implementation:**
- In `stageForQueue` (`:8236`), after `appendQueuePositions` and before the board refresh: resolve which staged plans are feature cards, read `feature_worktree_mode`, and call `_ensureFeatureIntegrationWorktree` for each feature that doesn't already have a worktree.
- In `createFeatureFromPlanIds` (`:14865-14874`): remove the `featureWorktreeModeSnapshot` read and the `_ensureFeatureIntegrationWorktree` call. Features are created without worktrees; worktrees are cut when they're staged.
- **Contract test update:** `worktree-strategy-control-contract.test.js:160-166` asserts `normalizeFeatureWorktreeMode` appears exactly 2 times in `KanbanProvider.ts`. The staging-time read adds a third. Update the assertion from `2` to `3` and add a comment documenting the third site (`stageForQueue` provisioning read).

**Edge Cases:** Features already created under the old timing have worktrees provisioned at creation. `stageForQueue` must check for an existing worktree before provisioning (the `_ensureFeatureIntegrationWorktree` function is already idempotent — it checks `getWorktrees()` first at `:13958`). No double-provisioning. A feature created before the toggle existed is neither orphaned nor double-provisioned — it keeps its existing worktree, and staging is a no-op for it.

### 3. Narrow `#btn-create-worktree` — `src/webview/kanban.html`

**Context:** The button at `:2979` currently handles three scopes: nothing selected → project/workspace (`:6456-6472`), one feature selected → feature (`:6473-6484`), one project selected → project. The `updateCreateWorktreeButton` function (`:8609`) sets merge mode for both feature (`:8636-8657`) and project (`:8666-8677`) worktrees.

**Logic:** Remove the feature scope from both the click handler and `updateCreateWorktreeButton`. When a feature is selected, the button is disabled with a tooltip pointing to the STAGING toggle. Merge mode narrows to project/workspace only.

**Implementation:**
- Click handler (`:6433-6490`): remove the `size === 1 && val.isFeature` branch (`:6473-6484`). When a feature is selected, fall through to the disabled state.
- `updateCreateWorktreeButton` (`:8609`): remove the feature merge-mode branch (`:8636-8657`). When a feature is selected, set disabled with tooltip "Feature worktrees are controlled by the STAGING toggle".
- Tooltip on the button element (`:2979`): change to "Create a worktree for the active project / workspace".
- `mergePromptReady` handler (`:10567-10594`): the strip-button path is now project-only. No change needed — it's guarded by `merge-mode` class + worktree-id match, which only project worktrees will set.

**Edge Cases:** The `createWorktreeForFeature` verb arm (`KanbanProvider.ts:13217`) remains in the allowlist and handler — it's the API path for programmatic feature worktree creation. The narrowing is UI-only; the verb is not deleted (the controller agent or future code may still call it).

### 4. Controller-agent merge route — `src/services/LocalApiServer.ts`

**Context:** `LocalApiServer.ts` has `/worktree/cleanup` (`:6413`) but no merge endpoint. The `copyWorktreeMergePrompt` verb (`KanbanProvider.ts:13360`) generates a merge prompt for a worktree but is only callable from the webview.

**Logic:** Add a `POST /worktree/merge` route that accepts `{ worktreeId, workspaceRoot }` and delegates to the same `copyWorktreeMergePrompt` handler. The response is the merge prompt string, which the controller agent can execute or relay.

**Implementation:**
- Add the route handler in `LocalApiServer.ts`, modeled on `/worktree/cleanup` (`:6413`).
- The route calls through to `KanbanProvider`'s `copyWorktreeMergePrompt` verb arm (or a shared helper extracted from it).
- Auth: reuse the existing `LocalApiServer` token validation.

**Edge Cases:** The merge prompt is a text instruction, not an automatic merge — the agent must execute it. This matches the existing pattern: the WORKTREES tab button copies the prompt to clipboard; the API route returns it as a string.

### 5. Delete the dead `subtask_plan_id` resolution branch — `src/services/KanbanProvider.ts`

**Context:** The resolution branch at `:13374-13392` reads `subtask_plan_id` to route subtask worktree merges into the feature integration branch. The branch is "write-dead" — no new rows carry `subtask_plan_id` (the comment at `:14360-14361` confirms: "per-subtask/high-low modes were removed; legacy rows are harmless").

**Logic:** Delete the `if ((wtRow.subtask_plan_id && wtRow.feature_id) || (wtRow.tier && wtRow.feature_id))` branch (`:13374-13385`) and the `else if (wtRow.feature_id && !wtRow.subtask_plan_id && !wtRow.tier)` branch (`:13386-13392`) from `copyWorktreeMergePrompt`. All worktree merges fall through to the default path: merge into the main checkout at the default branch. Leave the column in the schema — existing rows are harmless NULL or legacy values.

**Edge Cases:** Legacy rows with `subtask_plan_id` set (possible across ~4,000 installs) will now merge into main instead of their (possibly gone) integration branch. This is a stated behaviour change: the integration branch for per-subtask worktrees no longer exists as a concept, so merging into main is the correct fallback. The `_cleanupWorktree` function (`:14042-14068`) has a similar resolution branch — delete it too, so cleanup also falls through to the plain/project path.

### Migration

Existing feature worktrees are untouched. The toggle governs newly staged work. No destructive step.

## Verification Plan

### Goal Invariants

- Exactly two worktree scopes are reachable from the UI: project (strip button) and feature (STAGING toggle).
- Nothing but the user writes the worktree strategy key.
- `#btn-create-worktree` never provisions a feature worktree.
- A dependent feature's worktree is based on its predecessor, not the default branch.

### Automated Tests

- **Strategy is user-written only:** assert no code path other than the two user controls writes the strategy key, and that `orchestration_prior_feature_worktree_mode` is still referenced in exactly one place — the one-shot consuming drain. This is the contract that already has a test; extend it rather than writing a parallel one, so a second writer cannot be added by either surface.
- **No third mode:** assert the STAGING toggle offers only the two modes the verb arm accepts.
- **Toggle reflects broadcast, not click:** assert the control's state comes from the broadcast, the property the existing contract pins for the board control and the reason it was written.
- **Button scope narrowed:** assert `#btn-create-worktree` provisions only project/workspace worktrees, and that a selected feature does not change its behaviour.
- **Provisioning moment:** stage work with the toggle on and assert a worktree is cut then; stage with it off and assert none is. Then assert a feature created *before* the toggle existed is neither orphaned nor double-provisioned.
- **Operator cannot configure:** assert no operator path writes the strategy key or creates a worktree — the negative test that keeps the deleted forcing machinery from returning by another route.
- **Merge path exists:** assert feature-worktree merging is reachable from its new home. The narrowing must not leave merging with no entry point.
- **Normaliser count updated:** assert `normalizeFeatureWorktreeMode` is called from exactly 3 sites in `KanbanProvider.ts` (broadcast, staging-time provisioning read, and the drain). Update the existing `normalized === 2` assertion to `3`.

### Manual Verification

- Toggle worktrees in STAGING, stage a feature, confirm the worktree is cut and the team lands in it.
- Confirm the strip button no longer offers a feature worktree, and still creates and merges a project one.
- Confirm a feature worktree can be merged from the WORKTREES tab and by the controller via the API route — both reaching the same endpoint, so a fix to one is a fix to all.

## Outstanding Questions

- **[user]** Which key does the STAGING toggle write? — proceeding on the assumption that it reuses `feature_worktree_mode` (one source of truth, both surfaces stay in sync via broadcast).
- Is `useWorktreesPerPlan` still wanted? It is the fourth model, agent-owned, configured in a per-role prompt add-on rather than on the board — so it is invisible next to the other two and cannot be reconciled with them. Not touched by this plan, but it is the remaining overlap.
