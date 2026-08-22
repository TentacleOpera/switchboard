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
| `useWorktreesPerPlan` | one per plan | **agent** creates its own | per-role prompt add-on | live |
| `project` column | per project | host | strip button | live |
| `subtask_plan_id` | per subtask | — | — | **write-dead** — the code calls these "legacy per-subtask rows, now write-dead", and a resolution branch still reads them |

**The two problems this plan fixes:**

**1. One button means two things, and sometimes a third.** `kanban.html:2969` is `#btn-create-worktree`, tooltip: *"Create a worktree for the selected feature, or for the active project / workspace"*. Its scope is whatever happens to be selected. It also has a **merge mode** — the same control becomes a merge action when a worktree already exists for the context (`:8262`, `:8288`, `:8314`, guarded at `:10199-10203` on both the class and a worktree-id match). A control whose scope depends on selection and whose verb flips between create and merge is the "fiddly" this plan removes.

**2. Per-feature mode resolves at the wrong moment.** It is read **only at feature-creation time** — `KanbanProvider.ts:14654-14660` states it: *"Mode is read ONLY at feature-creation time; a later toggle is inert for already-created features."* So enabling the mode does nothing for work already planned, and the setting is invisible at the moment it matters. STAGING is that moment: `STAGEABLE_COLUMNS = ['CREATED', 'BACKLOG', 'PLAN REVIEWED', 'STAGING']` (`kanban.html:6152`), and STAGING is *"a queue, not a"* dispatch column (`:7122`) — work sits there immediately before going out.

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
- **Where does a feature worktree get merged?** Narrowing the strip button to projects removes the only UI entry point for feature-worktree merging (its merge mode). That has to land somewhere before the narrowing ships.

## Complexity Audit

### Routine

- A toggle in the STAGING column header writing the chosen config key.
- Narrowing `#btn-create-worktree`'s tooltip, handler and enablement to project/workspace scope.
- Moving feature-worktree provisioning from feature creation to staging.

### Complex / Risky

- **Do not add a third strategy mode.** The contract test states it directly: *"A third radio ahead of its provisioning is a dead control (PRD contract #6)."* The STAGING toggle is a **second surface for the existing two modes**, not a new one.
- **Do not let anything but the user write the strategy.** The same contract exists because `applyOversightWorktreeTopology` used to force `per-feature` on arm and restore it on disarm, and a crash left the forced value in place with the user's real one stashed under `orchestration_prior_feature_worktree_mode`. That machinery was deleted deliberately, and the stash key survives in exactly one place: a one-shot drain that consumes the key. **So the operator must never set worktree strategy** — it may detect and report a dependency violation, nothing more. Any design where the operator "ensures dependencies are respected" by changing configuration recreates the exact defect the contract was written to prevent.
- **Merge mode is live state the split must preserve.** Feature-worktree merging currently has no home other than the strip button's merge mode. Options: the STAGING surface, the lead's completion path, or the operator. This is also the same merge-back gap the per-feature-worktree queue design has, which today has no mechanism at all — worth solving once for both rather than twice.
- **Moving provisioning from creation to staging changes when a branch is cut.** A worktree cut at staging is based on the default branch as it is *then*, not as it was at feature creation — usually better, and a behaviour change to state explicitly. Features already created under the old timing have worktrees; the transition must not orphan or double-provision them.
- **`subtask_plan_id` is write-dead but still read.** A resolution branch consults it ("legacy per-subtask rows, now write-dead"). Retiring it is in scope only as a deletion of dead resolution; do not repurpose the column.
- **`branch TEXT NOT NULL UNIQUE` is workspace-unscoped in the current schema**, though the V24/V25 migrations used `UNIQUE(branch, workspace_id)`. Two workspaces cutting the same branch name collide. Owned by `scope-unscoped-tables-by-workspace-id.md`; noted because parallel worktrees make collisions more likely, not less.

## Edge-Case & Dependency Audit

**Dependencies and parallelism** are out of scope — see `staging-streams-parallel-dispatch-and-worktrees.md`.

**Migration.** Features with worktrees provisioned at creation time keep them. The toggle applies to work staged after it ships. No worktree is destroyed by this plan.

**Security.** None. No new path resolution, no new endpoint.

**Side effects.** Narrowing the strip button changes a shipped affordance. Users who create feature worktrees from it will find the toggle instead — worth a release note.

## Dependencies

- **Precondition for** the per-feature-worktree queue design (pop-time provisioning, team restart in the worktree), which needs one clear feature-worktree model to build on.
- **Shares the merge-back gap** with that design — solve once.
- **Noted against** `scope-unscoped-tables-by-workspace-id.md` for the `branch` uniqueness collision.
- Independent of the orders and endpoint work.

## Adversarial Synthesis

**"Four models is flexibility, not a problem."** Flexibility a user cannot see is not flexibility: two of the four are configured in places unrelated to each other (a board setting and a per-role prompt add-on), one is dead, and the button that exposes them guesses scope from selection. The reduction is to two the user can name.

**"Keep the strip button for features too — it works."** It works and it is ambiguous, and its merge mode makes the ambiguity consequential: the same click creates or merges depending on hidden state. Narrowing it to one scope makes merge mode unambiguous as a side effect.

**"Have the operator turn worktrees on when it detects parallel work."** This is the one option the codebase forbids by contract, for a reason it learned the hard way. Detection yes; configuration no.

**"Solve dependencies properly with a real dependency graph."** Possibly eventually, but `base_branch` already models ordering and costs nothing. A graph with no consumer is a schema change in search of a feature.

## Proposed Changes

1. **STAGING column toggle** — "worktrees on/off" for features, writing the existing strategy key (pending the User Review decision), reflecting broadcast state rather than a local click assumption.
2. **Provision at staging, not at feature creation** — the toggle's value is read when work is staged, so it applies to work as it goes out.
3. **Narrow `#btn-create-worktree`** to project/workspace scope: tooltip, handler, enablement. Merge mode narrows with it.
4. **Rehome feature-worktree merging** to whichever surface the User Review decision names, solved jointly with the queue design's merge-back gap.
5. **Delete the dead `subtask_plan_id` resolution branch**; leave the column.

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

### Manual Verification

- Toggle worktrees in STAGING, stage a feature, confirm the worktree is cut and the team lands in it.
- Confirm the strip button no longer offers a feature worktree, and still creates and merges a project one.

## Outstanding Questions

- **[user]** Which key does the STAGING toggle write?
- **[user]** Where does feature-worktree merging live after the narrowing?
- Is `useWorktreesPerPlan` still wanted? It is the fourth model, agent-owned, configured in a per-role prompt add-on rather than on the board — so it is invisible next to the other two and cannot be reconciled with them. Not touched by this plan, but it is the remaining overlap.
