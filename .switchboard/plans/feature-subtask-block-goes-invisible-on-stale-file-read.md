# Feature Subtask Block Goes Invisible on Stale Feature File Read

## Metadata

**Complexity:** 5
**Tags:** backend, bugfix, database, reliability
**Project:** Browser Switchboard

## Goal

Fix the bidirectional sync conflict that causes feature subtasks to go invisible — present in the DB but missing from the feature file's `<!-- BEGIN SUBTASKS -->` block, and in the worst case unlinked from the DB entirely by a stale file read.

### Problem

The feature file's subtask block and the DB's `feature_id` assignments are kept in sync by two mechanisms that can race:

1. **DB → file** (`_regenerateFeatureFile`): reads subtasks from the DB, writes the feature file's subtask block. Called after every subtask mutation (assign, remove, column move).

2. **File → DB** (`_syncFeatureMarkdownSubtasks` → `syncFeatureSubtasksByPaths`): when the file watcher processes a feature file, it reads the subtask block and reconciles the DB to match. This does two things:
   - **Links** plans found in the file's block to the feature in the DB.
   - **Unlinks** plans that are in the DB as subtasks of this feature but NOT in the file's block.

The **unlink** is the dangerous path. When the feature file is stale (missing a subtask that IS in the DB — due to a race between `_regenerateFeatureFile` and an agent's prose edit, a failed regeneration, or a watcher timing issue), the watcher fires on the stale file and `syncFeatureSubtasksByPaths` **clears the `featureId`** from the DB for the missing subtask. The plan becomes a loose plan — no longer in the feature, potentially lost among other loose cards on the board.

### Root Cause

The `rearrange-feature` skill creates a new plan via `POST /kanban/plans`, then assigns it via `assign-to-feature.js`. The assign sets the `featureId` in the DB and calls `_regenerateFeatureFile` to write the feature file with the new subtask in the block. But the skill also instructs the agent to "update the feature's prose" (step 6). If the agent reads the feature file before the regeneration landed and writes it back, the agent's write clobbers the regenerated subtask block. The watcher then fires on the agent's write, sees the stale block (missing the new plan), and `syncFeatureSubtasksByPaths` unlinks the new plan from the DB.

The startup self-heal (`regenerateAllFeatureFiles`) eventually fixes it on restart, but between restarts the plan is invisible.

### Background Context

- The skill documentation already says: "Never touch the auto-generated `<!-- BEGIN/END SUBTASKS -->` block — the extension regenerates it from the DB." The block is already intended to be DB-derived, not hand-edited.
- The board reads subtask membership from the DB (`partitionPlansByFeature` groups plans by their `featureId` from DB records), not from the feature file.
- `_applyFeatureLink` (the plan-file `**Feature:**` frontmatter → DB link path) skips regeneration if the subtask already has a `featureId` (line 1026-1028 of `PlanIngestionEngine.ts`), so it can't self-heal a stale feature file block.

## Approach

Make the DB the single source of truth for subtask membership. The feature file's subtask block becomes purely cosmetic — always derived from the DB, never used to mutate the DB. This eliminates the race entirely because there is no file→DB direction to clobber the DB→file direction.

## Changes

### 1. Replace `_syncFeatureMarkdownSubtasks` with DB-authoritative regeneration

**File:** `src/services/PlanIngestionEngine.ts` (lines ~1795-1828, ~1972-1974, ~2021-2023)

Currently, when the watcher processes a feature file (`_handlePlanFile`), it calls `_syncFeatureMarkdownSubtasks` which parses the subtask block and calls `db.syncFeatureSubtasksByPaths` to reconcile the DB to match the file.

Replace this with a call to `_regenerateFeatureFile` (the DB→file direction). When the watcher processes a feature file, regenerate the file from the DB instead of syncing the DB from the file. This ensures the file always matches the DB.

The `_regenerateFeatureFile` callback is already wired into `PlanIngestionEngine` via `setFeatureFileRegenerator` (line 371). The watcher already has access to it.

Concretely:
- In `_handlePlanFile`, at the two call sites where `_syncFeatureMarkdownSubtasks` is called (lines ~1974 and ~2023), replace the call with `this._regenerateFeatureFile?.(workspaceRoot, featurePlanId)`.
- Remove or dead-code the `_syncFeatureMarkdownSubtasks` method.
- The `_retryPendingFeatureLinks` call that follows (lines ~1975, ~2024) stays — it handles deferred `**Feature:**` frontmatter links, which is a separate concern.

### 2. Remove the unlink path from `syncFeatureSubtasksByPaths`

**File:** `src/services/KanbanDatabase.ts` (lines ~2713-2747)

Since the feature file's subtask block is no longer used to mutate the DB, `syncFeatureSubtasksByPaths` is no longer called from the watcher. However, it may be called from other paths — audit all call sites. If the only caller was `_syncFeatureMarkdownSubtasks` (being removed), the method can be removed entirely. If other callers exist, remove the unlink section (lines 2739-2746) and keep only the link section.

The unlink was the dangerous path: it cleared `feature_id` for plans in the DB but not in the file's block. With the DB-authoritative approach, unlinks only happen through explicit operations (`_removeSubtaskFromFeature`, `_deleteFeature`, `assignPlansToFeature` to a different feature).

### 3. Make `_applyFeatureLink` always regenerate the feature file

**File:** `src/services/PlanIngestionEngine.ts` (lines ~998-1046)

Currently, `_applyFeatureLink` returns early at line 1026-1028 if the subtask already has a `featureId`, skipping the `_regenerateFeatureFile` call. This means if a subtask is linked in the DB but missing from the feature file's block (due to a previous race), `_applyFeatureLink` won't fix it.

Change: move the `_regenerateFeatureFile` call outside the `if (!subtaskRow.featureId)` guard. Always regenerate the feature file after `_applyFeatureLink` resolves the feature, regardless of whether the `featureId` was already set. The `updateFeatureStatus` call remains conditional (only set the `featureId` if it's not already set), but the regeneration always happens.

### 4. Keep the startup self-heal as-is

**File:** `src/services/KanbanProvider.ts` (lines ~14312-14318)

`regenerateAllFeatureFiles` already runs on startup and regenerates every feature file from the DB. No changes needed. This remains the safety net for any drift that accumulated before the fix was deployed.

## Edge Cases & Risks

- **Infinite loop risk:** `_regenerateFeatureFile` writes the file, which triggers the watcher, which calls `_regenerateFeatureFile` again. The existing no-op guard at line 14298 (`if (newContent === existingContent) return;`) prevents this — once the file matches the DB, the regeneration is a no-op and doesn't write, so the watcher doesn't re-fire. The `registerPendingCreation` call (line 14301) also suppresses watcher processing for 10 seconds after a write. Convergence is one iteration.

- **Manual feature file creation:** If someone manually creates a feature file with subtask links in the block (without going through the API), the DB won't know about those subtasks. With the old code, `_syncFeatureMarkdownSubtasks` would link them. With the new code, `_regenerateFeatureFile` will overwrite the block with whatever the DB says (possibly empty). This is acceptable — the skill documentation already says the block is auto-generated and should not be hand-edited. The supported workflow is to create features via the API.

- **`**Feature:**` frontmatter on plan files:** This path (`_applyFeatureLink`) is separate from the feature file subtask block sync. It reads the `**Feature:**` line from a PLAN file (not a feature file) and links the plan to the feature in the DB. This continues to work — change 3 ensures it also regenerates the feature file afterward.

- **Prose edit race:** If an agent edits the feature file's prose at the same time `_regenerateFeatureFile` writes, one write can clobber the other. This is a general file-write race that already exists today. The fix doesn't make it worse — `_regenerateFeatureFile` preserves all content outside the subtask block, so a subsequent regeneration will restore the correct block without losing prose. The `registerPendingCreation` guard gives a 10-second window where the watcher won't re-process the file.

- **Performance:** `_regenerateFeatureFile` reads subtasks from the DB and writes the file. This is already called on every subtask mutation. Replacing `_syncFeatureMarkdownSubtasks` (which also reads the file and does DB queries) with `_regenerateFeatureFile` (which reads the DB and writes the file) is a net-neutral performance change.

## Verification Plan

1. **Unit test — stale file doesn't unlink:** Create a feature with 3 subtasks in the DB. Manually write a feature file with only 2 subtasks in the block. Trigger the watcher. Verify: (a) the DB still has 3 subtasks linked, (b) the feature file is regenerated with all 3 subtasks.

2. **Unit test — assign + prose edit race:** Create a plan, assign it to a feature (sets featureId in DB, regenerates feature file). Immediately write the feature file with a stale subtask block (simulating an agent's prose edit clobbering the regeneration). Trigger the watcher. Verify: (a) the DB still has the subtask linked, (b) the feature file is regenerated with the correct subtask block.

3. **Unit test — `_applyFeatureLink` regenerates even when featureId is set:** Create a plan with a `**Feature:**` frontmatter line. Import it (sets featureId via `_applyFeatureLink`). Manually remove the plan from the feature file's subtask block. Re-import the plan (triggers `_applyFeatureLink` again). Verify: (a) the feature file is regenerated with the plan in the subtask block.

4. **Integration test — rearrange-feature split flow:** Simulate the `rearrange-feature` split: create a plan via `POST /kanban/plans`, assign it via `POST /kanban/features/assign`, then immediately edit the feature file's prose (simulating step 6 of the skill). Trigger the watcher. Verify the new subtask appears in the feature file's block and remains linked in the DB.

5. **Existing tests:** Run the existing test suite (`src/test/headless-feature-management-*.test.js`) to verify no regressions in feature management operations.
