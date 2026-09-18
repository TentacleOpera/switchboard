# Delete-feature (and delete-plan) file-resurrect fix

**Plan ID:** 190dee2a-28f6-439b-950f-5d5c6fb7167e

## Goal

Stop a deleted feature/plan from being resurrected by its still-present `.md` file. Today
`deleteFeature` soft-deletes the DB row but leaves the file on disk, so the watcher re-imports it as
a fresh active feature on the next scan or clone. Deleting a card must also reap (or neutralize) its
authored file, or the deletion silently undoes itself.

### Core problem & root cause

`deleteFeature` (`KanbanProvider.ts:10019-10062`) captures subtasks, cleans up feature worktrees
(`_cleanupFeatureWorktrees`, `:9561-9568`), then either tombstones subtasks (`deleteSubtasks` path) or
clears their `feature_id` (`clearFeatureIdForFeature`, `KanbanDatabase.ts:1798-1803`), and always
`tombstonePlan(feature.planId)` (`:10048`). But `tombstonePlan` (`KanbanDatabase.ts:3929-3934`) only
sets `status='deleted'` — **it does not remove the file**. And `purgeOrphanedPlans`
(`KanbanDatabase.ts:3943-4003`) only tombstones plans whose *file is missing*. So the feature `.md`
survives, the watcher re-derives the same `plan_id` from the filename UUID
(`GlobalPlanWatcherService.ts:546-556`), re-stamps `is_feature=1` (`:648-661`), and the "deleted"
feature reappears active on the next scan/clone.

A second resurrection path opens once the `**Feature:**` frontmatter carrier lands
(`plan-authoring-frontmatter-facts.md`): a **kept** subtask whose file still carries
`**Feature:** <deletedId>` would re-link to the dead feature on re-import (apply-if-empty re-applies
the authored link). So the delete path must neutralize that line on kept subtasks too.

## Metadata

- **Project:** Switchboard
- **Tags:** bugfix, feature, reliability
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
- **`promoteToFeature`** (`KanbanProvider.ts:8963-9031`) moves files between `plans/` and `features/`
  via `fs.promises.rename` — ensure delete/resurrect logic keys on `plan_id`, not path alone. (Note:
  no demote function exists — promotion is one-directional.)
- **Migration: none.** The feature is unreleased/experimental — clean break, straight `git rm`, no
  `*.migrated.bak`, no install-base cleanup pass.

## Dependencies

- `plan-authoring-frontmatter-facts.md` — introduces the `**Feature:** <feature-plan-id>` carrier that
  this plan must strip from kept subtasks on delete. If this plan lands first, the strip step is a
  no-op until the carrier exists; if they ship together, the strip logic is exercised immediately.
- No dependency on the other two subtasks (`retire-file-based-git-control-plane.md`,
  `board-state-read-snapshot.md`) — the delete-resurrect fix is self-contained.

## Adversarial Synthesis

Key risks: (1) multi-branch resurrection — `_handlePlanDelete` keys on `plan_file` (relative path),
not `plan_id`, so a file returning via merge/clone at the *same path* re-creates the card; the import
guard must check `plan_id` against a tombstone set to block re-import of a deleted id. (2) The
strip-`**Feature:**` step must be a no-op when the carrier is absent (plan lands before
frontmatter-facts). (3) `fs.promises.unlink` failure (file locked by editor) must not block the DB
tombstone. Mitigations: unlink best-effort with warn-on-fail; register pending-delete so the
watcher's delete handler runs even if the file lingers; add a `plan_id`-keyed tombstone guard to the
import path.

## Proposed Changes

### `src/services/KanbanProvider.ts` — `_deleteFeature` (`:10019-10062`)

- **Context:** Today the method tombstones DB rows (`tombstonePlan`, `clearFeatureIdForFeature`) and
  cleans up worktrees (`_cleanupFeatureWorktrees`) but never touches the `.md` file on disk, so the
  watcher re-imports it.
- **Logic:** After `tombstonePlan(feature.planId)` (`:10048`), unlink the feature `.md` file
  (`fs.promises.unlink(absPath)`, reusing the pattern from `PlanningPanelProvider.ts:3566`).
  Best-effort: catch unlink failure (file locked / already gone) and warn, but do not block the DB
  tombstone. Register the path in the watcher's pending-delete set
  (`_globalPlanWatcher?.registerRename` / a new `registerPendingDelete`) so the watcher's
  `_handlePlanDelete` (`GlobalPlanWatcherService.ts:739-789`) fires and hard-deletes the DB row via
  `deletePlanByPlanFile` (`KanbanDatabase.ts:2319-2325`) rather than leaving a tombstone.
- **Implementation:** For each subtask in the `deleteSubtasks=true` branch, also unlink the subtask
  `.md`. For the `deleteSubtasks=false` (keep-subtasks) branch, do NOT unlink subtask files —
  instead strip the `**Feature:** <deletedId>` line from each kept subtask's file content (read,
  regex-remove `/^\*\*Feature:\*\*\s*.+$/m`, write back). Stripping is sufficient because the carrier
  is apply-if-empty — an absent line leaves the subtask standalone.
- **Edge Cases:** (a) Editor has the file open (locked) — unlink fails; warn + rely on
  pending-delete + next watcher cycle. (b) File already deleted manually — unlink ENOENT; treat as
  success. (c) `promoteToFeature` moved a plan into `features/` then user deletes it — the path is
  now under `features/`, not `plans/`; unlink by the DB `plan_file` column, not a hardcoded dir.

### `src/services/GlobalPlanWatcherService.ts` — import guard (`_handlePlanFile`, `:445-707`)

- **Context:** Today re-import of a file at the same path re-creates the card regardless of whether
  the user previously deleted it. `_handlePlanDelete` (`:739-789`) keys on `plan_file` (relative
  path) and hard-deletes via `deletePlanByPlanFile` (`:2319-2325`) — but a file returning on another
  branch via merge/clone re-triggers import at the same path.
- **Logic:** Add a `plan_id`-keyed tombstone guard: before `insertFileDerivedPlan`, check whether a
  row with this `plan_id` exists with `status='deleted'`; if so, skip import (the user deleted this
  card; a returning file must not undo that). This closes the multi-branch resurrection path that
  path-keying alone cannot catch.
- **Edge Cases:** A `status='deleted'` row that the user *wants* to restore (un-delete) — this is a
  future feature; for now, deletion is final, and re-import of a deleted id is always a resurrection
  bug, not a user intent.

### `src/services/KanbanProvider.ts` — delete-plan path (single plan, not feature)

- **Context:** The same resurrect bug affects single-plan delete (tombstone leaves the file). Find
  the single-plan delete path (search for `tombstonePlan` call sites outside `_deleteFeature`) and
  apply the same unlink + pending-delete pattern.
- **Edge Cases:** Completed/archived plans (`status='completed'`) — `_handlePlanDelete` already
  skips these (`:778-781`), so unlinking a completed plan's file would orphan its archive entry. Do
  NOT unlink completed plans; only unlink on active-plan delete.

## Verification Plan

### Automated Tests

> Per session directive: automated tests skipped. Verification is manual code-review only.

### Manual Verification

1. **Resurrect guard (happy path):** Delete a feature with subtasks → confirm the feature `.md` is
   unlinked from disk; confirm the DB row is hard-deleted (not just tombstoned) after the watcher's
   delete handler fires; confirm the feature does NOT reappear on a manual "rescan" trigger.
2. **Keep-subtasks strip:** Delete a feature with `deleteSubtasks=false` → confirm kept subtask
   files remain on disk; confirm each has its `**Feature:** <deletedId>` line stripped; confirm the
   subtasks appear standalone (no feature link) on the board.
3. **Multi-branch return:** Delete a feature on branch A; switch to branch B where the file still
   exists; trigger a watcher scan → confirm the feature does NOT reappear (plan_id tombstone guard
   blocks re-import).
4. **Locked file:** Open the feature `.md` in the editor; delete the feature → confirm unlink fails
   gracefully (warn, no throw); confirm the DB tombstone still lands; confirm the pending-delete
   registration means the file is cleaned up on the next watcher cycle once the editor releases it.
5. **Completed-plan safety:** Attempt to delete a completed/archived plan → confirm its file is NOT
   unlinked (archive entry preserved).

## Recommendation

Complexity 6 → **Send to Coder**.

## Review Findings

Reviewed `_deleteFeature` (`KanbanProvider.ts:10417-10475`), `_reapPlanFile` (`:10483-10501`), `_stripFeatureLineFromPlanFile` (`:10509-10540`), the plan_id tombstone guard (`GlobalPlanWatcherService.ts:601-621`), and `_handlePlanDelete` (`:893-959`). All three plan requirements are implemented: file reap on delete (best-effort unlink + ENOENT-as-success), `**Feature:**` strip on kept subtasks (id-scoped regex, apply-if-empty-safe), and the plan_id-keyed tombstone guard for multi-branch resurrection. The single-plan delete path (`PlanningPanelProvider.ts:3670-3710` `deleteKanbanPlan`) already hard-deletes via `deletePlanByPlanId` and unlinks the file — no change needed there. `_handlePlanDelete` correctly skips completed plans (`:925`), satisfying the completed-plan safety edge case. No CRITICAL/MAJOR findings; the strip regex is correctly scoped to the deleted feature id so it won't strip an unrelated `**Feature:**` line. No code fixes applied. Remaining risk: a locked feature file (editor open) defers cleanup to the next watcher cycle via the pending-delete path — acceptable per plan.

**Stage Complete:** CODE REVIEWED
