# Delete-feature (and delete-plan) file-resurrect fix

## Goal

Stop a deleted feature/plan from being resurrected by its still-present `.md` file. Today
`deleteFeature` soft-deletes the DB row but leaves the file on disk, so the watcher re-imports it as
a fresh active feature on the next scan or clone. Deleting a card must also reap (or neutralize) its
authored file, or the deletion silently undoes itself.

### Core problem & root cause

`deleteFeature` (`KanbanProvider.ts:8984-9021`) captures subtasks, cleans up feature worktrees, then
either tombstones subtasks (`deleteSubtasks`) or clears their `feature_id` (`clearFeatureIdForFeature`,
`:9005`), and always `tombstonePlan(feature.planId)` (`:9007`). But `tombstonePlan`
(`KanbanDatabase.ts:3759`) only sets `status='deleted'` — **it does not remove the file**. And
`purgeOrphanedPlans` (`:3773`) only tombstones plans whose *file is missing*. So the feature `.md`
survives, the watcher re-derives the same `plan_id` from the filename UUID, re-stamps
`is_feature=1`, and the "deleted" feature reappears active on the next scan/clone.

A second resurrection path opens once the `**Feature:**` frontmatter carrier lands
(`plan-authoring-frontmatter-facts.md`): a **kept** subtask whose file still carries
`**Feature:** <deletedId>` would re-link to the dead feature on re-import (apply-if-empty re-applies
the authored link). So the delete path must neutralize that line on kept subtasks too.

## Metadata

- **Project:** Switchboard
- **Tags:** kanban, features, delete, watcher, correctness
- **Complexity:** 6

## Implementation

On `deleteFeature` / delete-plan:

1. **Reap the file.** `git rm` the feature/plan `.md` (a straight delete — the feature is unreleased,
   so no `*.migrated.bak` archival is needed) and register the path in the watcher's pending-delete
   set so its delete handler (`_handlePlanDelete`) runs cleanly and hard-deletes the DB row rather
   than leaving a `status='deleted'` tombstone the surviving file can revive.
2. **Neutralize kept subtasks.** For a keep-subtasks delete (`deleteSubtasks=false`), strip the
   `**Feature:** <deletedId>` line from each kept subtask's file so it doesn't re-link to the dead
   feature on the next import. Stripping is sufficient — the carrier is apply-if-empty, so an absent
   line leaves the subtask standalone.

This keeps deletion consistent with the rest of the design: git carries durable authored files,
removing the card removes its file, and live control lives in the API providers (Notion/Linear).

## User Review Required

- **None.** Contract: reap the file on delete (git-native), and strip the `**Feature:**` carrier line
  from kept subtasks.

## Complexity Audit

### Routine
- `git rm` / removing the file in the delete path; registering the pending-delete so the watcher's
  delete handler hard-deletes the row.
- Stripping the `**Feature:**` line from kept subtasks.

### Complex / Risky
- **Kept-subtask coherence:** on keep-subtasks delete, files still carrying `**Feature:** <deletedId>`
  must be stripped or they re-link to a dead feature on re-import. This is the one interaction with
  `plan-authoring-frontmatter-facts.md` (the carrier).
- **Worktree cleanup already handled** (`_cleanupFeatureWorktrees`, `:8999`); don't regress it.
- **Multi-branch:** a delete on one branch doesn't remove the file on another, so the file can return
  on merge/clone. Keying the watcher's delete handling on `plan_id` (not path alone) keeps a
  returning file from re-creating a card the user deleted.

## Edge-Case & Dependency Audit

- **Depends on / pairs with:** `plan-authoring-frontmatter-facts.md` — it introduces the `**Feature:**`
  carrier this plan must strip on delete. Otherwise independent within the feature.
- **`promoteToFeature`/demote** move files between `plans/` and `features/` — ensure delete/resurrect
  logic keys on `plan_id`, not path alone.
- **Migration: none.** The feature is unreleased/experimental — clean break, straight `git rm`, no
  `*.migrated.bak`, no install-base cleanup pass.
