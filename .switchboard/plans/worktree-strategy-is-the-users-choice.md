# Worktree Strategy Is the User's Choice, and the Agent Obeys It

## Goal

You pick how work is isolated. The default is **no worktrees** — everyone works in the main checkout, one team at a time. Nothing else in the system may change that setting; agents read it and follow it.

### Why

**Today the agent sets the topology and hides your choice.** `KanbanProvider.applyOversightWorktreeTopology` (`:2258`) is documented as applying *"the per-feature worktree topology that an oversight session requires."* Arming the orchestrator stashes your `feature_worktree_mode` under `orchestration_prior_feature_worktree_mode`, forces `per-feature`, and restores it on disarm. There is a double-enter guard, a stale-mode reconciler, and a liveness check to stop the reconciler firing mid-session — a small machine whose entire job is to take a setting away from you and give it back.

**That forcing is what invented `Miscellaneous`.** In `per-feature` mode worktrees are provisioned in exactly one place — inside `createFeatureFromPlanIds` (`:13592`), at feature-creation time. No path gives a featureless plan a worktree. So a plan not in a feature has nowhere to be coded, and the orchestrator's kickoff has to sweep every loose plan into a `Miscellaneous` feature "so nothing is left ungrouped." That feature groups by *everything else*, which carries no information, and it is the direct cause of column-mixed features.

**Worktrees are the right answer sometimes and overkill often.** Their job is to stop parallel workers colliding in one checkout. If one team works at a time, there is nothing to collide with, and the whole apparatus — provisioning, branch-per-feature, merge-back, cleanup — is cost with no benefit.

## What changes

**The setting is user-owned and has three values:**

| Value | Meaning |
| :--- | :--- |
| `none` **(default)** | One checkout, one team working at a time. No worktrees, no merge-back, no cleanup. |
| `per-feature` | As today — one shared worktree per feature, provisioned at feature creation. |
| `per-team` | One worktree per team, whatever that team is currently assigned. |

**Nothing but the user writes it.** Delete `applyOversightWorktreeTopology`, the `orchestration_prior_feature_worktree_mode` stash key, and the oversight-liveness guard inside `_reconcileStaleWorktreeMode` that exists only to protect the forced value. Agents read the setting; no agent, mode, or automation path sets it.

**`none` means serialise.** With no isolation, two teams coding at once corrupt each other. Whoever dispatches — a human dragging a card, or the orchestrator's tick — dispatches one team at a time and waits for it to finish. This is a real constraint of the mode, not a bug in it, and it must be stated wherever work is dispatched.

**Keep the DB key `feature_worktree_mode` as it is.** The name is now slightly wrong, but renaming a shipped config key buys a migration for nothing. Rename it in the UI only.

## Scope call — `per-team` is deferred

`none` and `per-feature` both exist in the tree today; this plan makes the choice yours and deletes the machinery that overrode it. `per-team` is new provisioning work for an option you said *could* exist rather than one you plan to use. Ship the two that exist, then add `per-team` when you actually want it. Say so and it goes in this plan instead.

## Order — land this first

This is **1 of 4** in the orchestration set. It has no prerequisites, and the other three assume the `none` default it establishes:

1. **this plan** — worktree strategy becomes the user's, `none` is the default
2. `automation-tab-three-exclusive-modes.md` — agent-managed mode exists
3. `orchestration-starts-as-a-conversation.md` — Start opens a pre-flight
4. `orchestrator-persona-becomes-a-tick.md` — the persona consumes all of the above

Landing this second or later means the persona describes a `none` default that does not exist, and the automation tab deletes `orchestrationConfig.enabled` while `applyOversightWorktreeTopology` is still firing on its transitions.

## Metadata

**Complexity:** 4
**Tags:** refactor, backend, ui

## Verification Plan

1. A fresh workspace defaults to `none` — no worktree is created for a new feature.
2. Start the orchestrator: your setting is unchanged before, during and after. No stashed prior key is written.
3. Set `per-feature`, create a feature: one shared worktree is provisioned, as today.
4. Set `per-feature`, start and stop the orchestrator, check the setting: still `per-feature`, never stashed or restored.
5. In `none`, dispatch two teams' worth of work: the second waits rather than starting in the same checkout.
6. Grep the tree: nothing outside the settings UI writes `feature_worktree_mode`.
7. An install carrying a stale `orchestration_prior_feature_worktree_mode` from the old machinery opens on its real current mode and the dead key is ignored.
