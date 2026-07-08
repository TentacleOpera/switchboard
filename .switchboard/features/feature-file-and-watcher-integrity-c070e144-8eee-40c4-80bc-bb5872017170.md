# Feature-File and Watcher Integrity

**Complexity:** 7

## Goal

Make Switchboard feature .md files and kanban DB rows robust against the two ways they get corrupted today: (1) the file-watcher hard-deleting DB rows on transient git-checkout file disappearances, wiping column, feature-linkage, complexity, and plan_id, and (2) the feature-file regenerator splice appending a fresh Subtasks block instead of replacing the old one, so blocks accrete unboundedly on every regen. Both plans defend the same capability — feature-file and DB state integrity under watcher and git churn — and the watcher-guard plan explicitly names the regen-splice fix as a complement.

## How the Subtasks Achieve This

- **Guard the plan-watcher against git-churn board clobber**: Replaces the watcher's hard-delete-on-file-disappearance with a durable soft-delete + reconcile model (a `missing` status lifecycle, status-agnostic reactivation on reappearance preserving `plan_id`/`feature_id`/column/complexity, a bounded purge sweep), adds git-awareness so bulk changes are batched, and adds bulk-change DB backups. This stops git checkouts from clobbering DB-only state.
- **Fix `_regenerateFeatureFile` splice so it collapses to exactly one `## Subtasks` block**: Replaces the broken independent-`indexOf` splice with strip-all-then-insert-one (healing orphan/duplicate blocks in one pass), and applies the same fix to the WORKTREES block. This stops feature `.md` files from growing without bound on every regeneration.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix `_regenerateFeatureFile` splice so it collapses to exactly one `## Subtasks` block](../plans/fix-feature-md-subtask-block-accretion.md) — **LEAD CODED**
- [ ] [Guard the plan-watcher against git-churn board clobber](../plans/guard-watcher-against-git-churn-board-clobber.md) — **LEAD CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraint — the guard plan's Dependencies section states "No cross-plan ordering requirement" and calls the regen-splice fix a complement, not a prerequisite. Both can be executed in parallel; landing both gives correct watcher behavior *and* correct regenerator output.
