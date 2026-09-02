---
description: 'Retire the state two removals left behind'
---

# Retire the state two removals left behind

**Complexity:** 4

## Goal

Delete two pieces of residue from behaviour that was removed deliberately: a config key that
provisions nothing and can only be read, and a retirement prune whose scope never grew to cover the
directory that arrived after it.

Both are the failure this repo has already diagnosed in
`retire-queue-sequencing-auto-orchestrator.md`: *"The removal took the behaviour and left the flag,
the dep, the constant, and the prose. The docblocks then became the most authoritative-looking
description of a design that no longer exists."* One of them has already cost something — a sibling
plan was drafted scoping its readiness predicate by the dead key, on the reasonable inference that a
live, normalized, broadcast config value describes live behaviour.

## How the Subtasks Achieve This

- **`feature_worktree_mode` provisions nothing and can only be read**: `stageForQueue` deleted the
  per-feature worktree provisioning and says why — two features staged gives two sibling branches
  that cannot see each other, with the dependency edges that would have said so sitting unread in
  `plan_dependencies`. Opt-in provisioning belongs on a mission, bounded by `maxExtraWorktrees`. The
  key, its normalizer, its read, its broadcast field and its one-time migration drain all survived
  the removal and are deleted here.
- **A retired protocol is never deleted from a workspace**: `.agents/` is copied into workspaces
  via two paths — `bootstrapControlPlaneLayout` (standalone init / migration) copies the full tree
  including `protocols/`, but extension activation only seeds `skills/` and `workflows/` via
  `seedBundleSurface`. The prune's scope is `['skills', 'workflows']` — so no protocol file is
  ever a prune candidate and a retired one lives in every workspace forever. The same plan wires the
  prune into the standalone composition root (which has never called it for any surface) and widens
  `seedBundleSurface` to seed `protocols/` in the extension activation, so the ledger tracks files
  that actually exist on disk.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [`feature_worktree_mode` provisions nothing and can only be read — retire the flag the removal left behind](../plans/retire-the-dead-feature-worktree-mode-config.md) — **PLAN REVIEWED** — ID: 3e5d6c44-ad76-4211-a0ee-7382dc8d6c67
- [ ] [A retired protocol is never deleted from a workspace, and the standalone host never prunes at all](../plans/retired-protocol-files-are-never-pruned-from-a-workspace.md) — **PLAN REVIEWED** — ID: 99db03be-bf64-4f08-861c-0c3d50a6920f
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Independent of each other; both are prerequisites for work already on the board.**

`retired-protocol-files-are-never-pruned-from-a-workspace` blocks
`protocols-as-db-rows-not-scaffolded-files.md`, and the ordering is not optional: the release that
adds `protocols/` to the ledger only *seeds* it, deleting nothing, so orphan removal lands a release
later. Ship them together and 29 protocols strand in every workspace while the extension serves the
row versions.

`retire-the-dead-feature-worktree-mode-config` deletes a migration, which `CLAUDE.md` normally
forbids. The exemption is stated in the plan and belongs in its commit message: the drain restores a
value into a key that stops being read in the same commit, so its output is inert and there is
nothing left to preserve.

## Team Dispatch Instructions

### `feature_worktree_mode` provisions nothing and can only be read — retire the flag the removal left behind

- **Seat:** Intern (complexity 3)
- **Acceptance:**
  - No source file outside a migration or comment references `feature_worktree_mode` (grep gate)
  - A config row carrying `'per-feature'` is inert — no worktree is provisioned when staging
  - `normalizeFeatureWorktreeMode` has no callers after removal
  - `feature-worktree-guardrail-contract.test.js` passes with only its comments edited, no `assert` changes
  - No `_prior_` key remains in the source tree (grep gate)
- **Must not touch:** `worktrees`, `plans.worktree_id`, mission provisioning (`maxExtraWorktrees`), `group.worktreeMode` (`agent-groups-worktree-mode`), `useWorktreesPerPlan` — all live, different axis/owner

### A retired protocol is never deleted from a workspace, and the standalone host never prunes at all

- **Seat:** Coder (complexity 4)
- **Acceptance:**
  - A protocol retired from the bundle is deleted from the workspace on the next run (with a prior ledger that contains it)
  - First run with no prior ledger deletes nothing, seeds the ledger, and counts drift
  - Both roots call the same crawl function — neither contains its own `skills/`/`workflows/` prefix construction
  - `improve-plan` and `improve-feature` are in `currentBundlePaths` on every run
  - `seedBundleSurface` accepts `'protocols'` and seeds them in the extension activation
- **Must not touch:** `personas/`, `rules/`, `scripts/` (deliberately out of scope), the `bootstrapControlPlaneLayout` copy path (already reaches protocols correctly), the copy path's `overwrite`/`overwriteIfDiffers` semantics
