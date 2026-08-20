# Feature Subtask Block Goes Invisible on Stale Feature File Read

## Metadata

**Complexity:** 6

> **Superseded:** Complexity: 5
> **Reason:** The original score counted three files (PlanIngestionEngine, KanbanDatabase, KanbanProvider read-only) and treated the change as extending existing patterns. The improve pass uncovered a fourth file — `create-feature.js` — whose `viaDirectFile()` fallback depends on the very file→DB ingestion path being removed, requiring an additional change to keep offline feature creation working. That plus the behavior change (hand-authored feature files no longer ingest subtask links) pushes this from "majority routine" into mixed territory with a moderate, well-scoped risk extending an existing pattern.
> **Replaced with:** Complexity: 6

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
- `_applyFeatureLink` (the plan-file `**Feature:**` frontmatter → DB link path) skips regeneration if the subtask already has a `featureId` (lines 1031-1033 of `PlanIngestionEngine.ts`), so it can't self-heal a stale feature file block.
- `create-feature.js`'s `viaDirectFile()` fallback (lines 152-205) writes a feature markdown file directly with `<!-- BEGIN SUBTASKS -->` subtask links and relies on the file→DB ingestion path (`_syncFeatureMarkdownSubtasks` → `syncFeatureSubtasksByPaths`) to link those subtasks in the DB. Its header comment (lines 21-22) states this explicitly. Removing the file→DB direction breaks this fallback unless it is made DB-aware (see Change 5).

## Approach

Make the DB the single source of truth for subtask membership. The feature file's subtask block becomes purely cosmetic — always derived from the DB, never used to mutate the DB. This eliminates the race entirely because there is no file→DB direction to clobber the DB→file direction.

This matches the documented intent (the block is auto-generated, do-not-edit) and the board's existing read path (DB-sourced `partitionPlansByFeature`). The one downstream consumer of the file→DB direction — `create-feature.js`'s offline fallback — is updated in Change 5 to write subtask links to the DB directly, so it no longer depends on ingestion.

## User Review Required

This change alters the behavior of hand-authored feature files: a feature file with subtask links written directly to disk (outside the API) will no longer have those links ingested into the DB on watcher processing — the block will be overwritten from DB state (possibly empty) on the first watcher tick. The supported workflow is feature creation via the API (`POST /kanban/feature`) or `create-feature.js` (which is updated in Change 5 to be DB-aware). Confirm this behavior change is acceptable before implementation.

## Complexity Audit

### Routine
- Replacing two call sites in `_handlePlanFile` (lines 1990, 2039) — swap one method call for another already wired via `setFeatureFileRegenerator` (line 376).
- Removing the now-unreferenced `_syncFeatureMarkdownSubtasks` method (lines 1811-1844) — dead-code removal after its callers are gone.
- Removing the now-unreferenced `syncFeatureSubtasksByPaths` method (lines 2713-2747) — confirmed single code caller at `PlanIngestionEngine.ts:1837`; all other matches are plan-file documentation.
- Keeping `regenerateAllFeatureFiles` (line 14374) as-is — already the startup safety net.

### Complex / Risky
- **Change 3 — `_applyFeatureLink` always-regenerate:** moves the `_regenerateFeatureFile` call (line 1040) outside the `if (!subtaskRow.featureId)` guard (lines 1031-1033). Every re-import of a plan with `**Feature:**` frontmatter now triggers a feature-file regeneration attempt (mitigated by the no-op guard at line 14360, but the DB read + content build still runs). Performance cost on bulk re-imports of large features.
- **Change 5 — `create-feature.js` fallback DB-aware:** the `viaDirectFile()` fallback must write `feature_id` links directly to `kanban.db` (via the `KanbanDatabase` handle it already opens at line 166) instead of relying on ingestion. Without this, offline feature creation produces features with no subtasks on the board — a regression that replaces the original invisibility bug.
- **Behavior change — hand-authored feature files no longer ingest subtask links.** Documented as accepted (block is auto-generated), but it is a breaking change for any workflow that writes feature files directly.

## Edge-Case & Dependency Audit

### Race Conditions
- **Infinite regen loop:** `_regenerateFeatureFile` writes the file → watcher fires → `_handlePlanFile` calls `_regenerateFeatureFile` again. Broken by TWO mechanisms: (1) `registerPendingCreation` (line 14363) suppresses watcher processing of the regen's own write for 10 seconds — the self-write never re-enters the refresh path within that window; (2) the no-op guard at line 14360 (`if (newContent === existingContent) return;`) skips the write entirely when generated content equals disk, so even outside the suppression window an identical rewrite does not re-fire the watcher. Convergence is one iteration for the regen's own write.
- **Prose edit race:** if an agent edits the feature file's prose at the same time `_regenerateFeatureFile` writes, one write can clobber the other. This is a general file-write race that already exists today. The fix doesn't make it worse — `_regenerateFeatureFile` preserves all content outside the subtask block, so a subsequent regeneration restores the correct block without losing prose. The `registerPendingCreation` guard gives a 10-second window where the watcher won't re-process the file.
- **Re-link race (residual, accepted):** with the file→DB direction removed, there is no path for a stale file to re-link a subtask that was explicitly removed from a feature. This is strictly better than the pre-fix state (where the unlink race caused invisibility). The only theoretical residual: an explicit removal (`_removeSubtaskFromFeature`) clears `featureId` and regens the file without the subtask; if a stale external write with the OLD block lands within the 10-second suppression window, the watcher would process it — but with no file→DB link direction, it cannot re-link the subtask. The race is eliminated, not merely mitigated.

### Security
- No new attack surface. All operations are internal DB writes and local file writes. `create-feature.js` fallback already opens the DB handle read-only; Change 5 adds write calls using the existing `updateFeatureStatus` method (no raw SQL, no new privileges).

### Side Effects
- **Hand-authored feature files:** a feature file with subtask links written directly to disk (outside the API) will have its subtask block overwritten from DB state on the first watcher tick. Acceptable — the block is documented as auto-generated and should not be hand-edited. The supported workflow is API-based creation.
- **`**Feature:**` frontmatter on plan files:** this path (`_applyFeatureLink`) is separate from the feature file subtask block sync. It reads the `**Feature:**` line from a PLAN file (not a feature file) and links the plan to the feature in the DB. This continues to work — Change 3 ensures it also regenerates the feature file afterward, even when the `featureId` was already set.
- **Performance:** `_regenerateFeatureFile` reads subtasks from the DB and writes the file. This is already called on every subtask mutation. Replacing `_syncFeatureMarkdownSubtasks` (which read the file and did DB queries) with `_regenerateFeatureFile` (which reads the DB and writes the file) is a net-neutral performance change at the two `_handlePlanFile` call sites. Change 3 adds a regen attempt on every re-import of a `**Feature:**`-frontmatter plan — the no-op guard (line 14360) skips the write when content is unchanged, but the DB read + content build still runs. On a 50-subtask feature touched 50 times during a bulk edit, that is 50 regen attempts (all no-op writes). Accepted as the cost of self-healing stale blocks.

### Dependencies & Conflicts
- **`create-feature.js` fallback (Change 5):** the fallback must be updated in the same change set as Change 1. If Change 1 lands without Change 5, offline feature creation (extension unreachable) produces features with empty subtask blocks on the board — a regression. These two changes are coupled and must ship together.
- **`regenerateAllFeatureFiles` (startup self-heal, line 14374):** unchanged. Remains the safety net for any drift that accumulated before the fix was deployed. No conflict.
- **`_retryPendingFeatureLinks` (line 1802):** unchanged. Handles deferred `**Feature:**` frontmatter links — a separate concern from the feature file subtask block. Stays at both call sites (lines 1991, 2040).

## Dependencies

None — this is a self-contained bugfix in the feature subtask sync path. No other plan or session is a prerequisite.

## Adversarial Synthesis

Key risks: (1) removing the file→DB ingestion path breaks `create-feature.js`'s offline fallback, which relies on ingestion to link subtasks — mitigated by Change 5 making the fallback DB-aware; (2) Change 3 triggers a feature-file regen attempt on every `**Feature:**`-frontmatter plan re-import — mitigated by the no-op write guard, with the DB-read/content-build cost accepted; (3) the regen callback (`_regenerateFeatureFile`) is optional (`?.`) and must be wired in tests or verification proves nothing. Mitigations: ship Changes 1 and 5 together, wire the regen callback in every test, and state the 10-second `registerPendingCreation` suppression as the loop-break mechanism rather than relying on "convergence."

## Proposed Changes

### `src/services/PlanIngestionEngine.ts`

**Change 1 — Replace `_syncFeatureMarkdownSubtasks` with DB-authoritative regeneration at both watcher call sites.**

- **Context:** When the watcher processes a feature file (`_handlePlanFile`), it currently calls `_syncFeatureMarkdownSubtasks` (lines 1811-1844) at two sites — line 1990 (new-record import path) and line 2039 (updated-record import path) — which parses the subtask block and calls `db.syncFeatureSubtasksByPaths` to reconcile the DB to match the file. This file→DB direction is the race source.
- **Logic:** At both call sites (lines 1990 and 2039), replace `await this._syncFeatureMarkdownSubtasks(db, <planId>, content, workspaceId)` with `await this._regenerateFeatureFile?.(workspaceRoot, <planId>)`. The `_regenerateFeatureFile` callback is already wired via `setFeatureFileRegenerator` (line 376). The `_retryPendingFeatureLinks` call that follows (lines 1991, 2040) stays — it handles deferred `**Feature:**` frontmatter links, a separate concern.
- **Implementation:** Remove or dead-code the `_syncFeatureMarkdownSubtasks` method (lines 1811-1844) entirely once both callers are gone.
- **Edge Cases:** If `_regenerateFeatureFile` is not wired (optional `?.`), the call is a no-op and the file block is not refreshed — but the DB is also not mutated, so no invisibility occurs. The file block will be refreshed on the next subtask mutation or on startup self-heal. Tests MUST wire `setFeatureFileRegenerator` or the regen never runs (see Verification Plan).

**Change 3 — Make `_applyFeatureLink` always regenerate the feature file.**

- **Context:** `_applyFeatureLink` (lines 1003-1051) returns early at lines 1031-1033 if the subtask already has a `featureId`, skipping the `updateFeatureStatus` call (line 1034) AND the `_regenerateFeatureFile` call (line 1040). This means a subtask linked in the DB but missing from the feature file's block (due to a previous race) is never self-healed by `_applyFeatureLink`.
- **Logic:** Move the `_regenerateFeatureFile` call (line 1040) outside the `if (!subtaskRow.featureId)` guard so it always runs after the feature is resolved. The `updateFeatureStatus` call (line 1034) remains conditional — only set the `featureId` if it is not already set. The early returns for unresolved features (lines 1016-1028, feature row null → defer) and invalid inputs (lines 1011-1012) stay unchanged — regeneration is meaningless when the feature does not yet exist.
- **Implementation:** Restructure so the flow is: resolve feature → if null, defer/return → fetch subtask row → if `featureId` empty, call `updateFeatureStatus` → always call `_regenerateFeatureFile` (wrapped in the existing try/catch at lines 1039-1045) → delete pending link entry.
- **Edge Cases:** Every re-import of a plan with `**Feature:**` frontmatter now triggers a regen attempt. The no-op guard at line 14360 skips the write when content is unchanged. The DB read + content build cost is accepted (see Complexity Audit).

### `src/services/KanbanDatabase.ts`

**Change 2 — Remove `syncFeatureSubtasksByPaths` (unlink path eliminated).**

- **Context:** `syncFeatureSubtasksByPaths` (lines 2713-2747) is the DB method that reconciled subtask membership from the feature file's block. Its unlink section (lines 2739-2746) is the dangerous path that cleared `feature_id` for plans in the DB but not in the file's block — the direct cause of invisibility.
- **Logic:** Audit confirmed `syncFeatureSubtasksByPaths` has exactly ONE code caller: `PlanIngestionEngine.ts:1837` (inside `_syncFeatureMarkdownSubtasks`, being removed in Change 1). All other matches across the repo are plan-file documentation, not code. With the sole caller removed, the method has no callers — remove it entirely.
- **Implementation:** Delete lines 2706-2747 (the method and its docblock). Unlinks now only happen through explicit operations: `_removeSubtaskFromFeature`, `_deleteFeature`, and `assignPlansToFeature` to a different feature.
- **Edge Cases:** If a future caller needs file→DB link ingestion, it must use explicit `updateFeatureStatus` calls — never re-introduce an unlink-from-file path.

### `.agents/skills/kanban_operations/create-feature.js`

**Change 5 — Make the `viaDirectFile()` fallback DB-aware (do not rely on file→DB ingestion).**

- **Context:** `viaDirectFile()` (lines 152-205) is the offline fallback when the extension's API server is unreachable. It writes a feature markdown file with `<!-- BEGIN SUBTASKS -->` links and currently relies on the watcher's file→DB ingestion (`_syncFeatureMarkdownSubtasks` → `syncFeatureSubtasksByPaths`) to link those subtasks in the DB. Its header comment (lines 21-22) states this dependency explicitly. Change 1 removes that ingestion path, so the fallback must write the subtask links to the DB itself.
- **Logic:** The fallback already opens `KanbanDatabase.forWorkspace(workspaceRoot)` (line 166) and queries each plan (line 169). After resolving each plan, call `await db.updateFeatureStatus(plan.planId, 0, featurePlanId)` to set the `feature_id` link directly in the DB. The feature row itself is still created by the watcher when it imports the feature file (`_handlePlanFile` → `insertFileDerivedPlan` + `updateFeatureStatus(planId, 1, '')`), so the fallback does not need to insert the feature row — only the subtask links. Update the header comment (lines 17-22) to reflect that the fallback now writes subtask links to the DB directly and no longer relies on file→DB ingestion.
- **Implementation:** Inside the existing `for (const pid of planIds)` loop (line 168), after `const plan = await db.getPlanByPlanId(pid)`, add `await db.updateFeatureStatus(pid, 0, featurePlanId)` (guard with the same try/catch that already wraps the DB access, lines 164-182). Close the DB handle (line 178) as today.
- **Edge Cases:** If `KanbanDatabase` module is unavailable (the `catch` at line 179), the fallback writes only markdown and the subtask links will NOT be in the DB — the feature will show empty on the board until the extension starts and a subtask mutation or startup self-heal regenerates the file. This is the same degraded state as today when the module is unavailable, and strictly better than the post-change-1-without-change-5 regression. The `updateFeatureStatus` call respects `is_feature` stickiness and will not steal a subtask already linked to a different feature (the cross-feature guard is inherent in the explicit-assignment model — `assignPlansToFeature` already checks this).

### `src/services/KanbanProvider.ts`

**Change 4 — Keep the startup self-heal as-is.**

- **Context:** `regenerateAllFeatureFiles` (line 14374) already runs on startup and regenerates every feature file from the DB.
- **Logic:** No changes needed. This remains the safety net for any drift that accumulated before the fix was deployed, and for the degraded `create-feature.js` fallback case when the `KanbanDatabase` module is unavailable.
- **Implementation:** None.
- **Edge Cases:** None.

## Verification Plan

> Note: For this run, compilation and automated tests are not executed — the checks below remain the written verification plan for implementation.

### Automated Tests

1. **Unit test — stale file doesn't unlink:** Create a feature with 3 subtasks in the DB. Manually write a feature file with only 2 subtasks in the block. Trigger the watcher. Verify: (a) the DB still has 3 subtasks linked, (b) the feature file is regenerated with all 3 subtasks. **Test setup requirement:** wire `setFeatureFileRegenerator` on the `PlanIngestionEngine` under test, or the regen is a no-op and the test passes for the wrong reason.

2. **Unit test — assign + prose edit race:** Create a plan, assign it to a feature (sets featureId in DB, regenerates feature file). Immediately write the feature file with a stale subtask block (simulating an agent's prose edit clobbering the regeneration). Trigger the watcher. Verify: (a) the DB still has the subtask linked, (b) the feature file is regenerated with the correct subtask block.

3. **Unit test — `_applyFeatureLink` regenerates even when featureId is set:** Create a plan with a `**Feature:**` frontmatter line. Import it (sets featureId via `_applyFeatureLink`). Manually remove the plan from the feature file's subtask block. Re-import the plan (triggers `_applyFeatureLink` again). Verify: (a) the feature file is regenerated with the plan in the subtask block.

4. **Integration test — rearrange-feature split flow:** Simulate the `rearrange-feature` split: create a plan via `POST /kanban/plans`, assign it via `POST /kanban/features/assign`, then immediately edit the feature file's prose (simulating step 6 of the skill). Trigger the watcher. Verify the new subtask appears in the feature file's block and remains linked in the DB.

5. **Integration test — `create-feature.js` offline fallback:** With the extension API unreachable, run `create-feature.js` with a set of plan IDs. Verify: (a) the feature markdown file is written with the subtask block, (b) each subtask's `feature_id` is set to the new feature's plan ID in `kanban.db` directly (not via ingestion), (c) when the watcher processes the feature file, the block is regenerated from the DB and matches (no empty-block regression).

6. **Existing tests:** Run the existing test suite (`src/test/headless-feature-management-*.test.js`) to verify no regressions in feature management operations. Ensure these tests wire `setFeatureFileRegenerator` if they exercise the feature-file watcher path.
