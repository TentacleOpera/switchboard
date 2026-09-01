---
description: 'Retire the state two removals left behind'
---

# Retire the state two removals left behind

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
- **A retired protocol is never deleted from a workspace**: `.agents/` is copied into every
  workspace in full, but the prune's scope is `['skills', 'workflows']` — so no protocol file is
  ever a prune candidate and a retired one lives in every workspace forever. The same plan wires the
  prune into the standalone composition root, which has never called it for any surface.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] (no subtasks)
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
