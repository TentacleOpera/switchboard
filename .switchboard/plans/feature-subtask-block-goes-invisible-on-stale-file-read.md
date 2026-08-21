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

**Scope note:** the second, worse symptom (DB unlink from a stale read) is already closed — see **Already Landed**. What remains for this plan is the first: a subtask correctly linked in the DB but absent from the file's block, which every agent reading that file sees as absent. The fix keeps the file→DB direction rather than deleting it; see **Approach** for why the original route was retired.

### Problem

The feature file's subtask block and the DB's `feature_id` assignments are kept in sync by two mechanisms that can race:

1. **DB → file** (`_regenerateFeatureFile`): reads subtasks from the DB, writes the feature file's subtask block. Called after every subtask mutation (assign, remove, column move).

2. **File → DB** (`_syncFeatureMarkdownSubtasks` → `syncFeatureSubtasksByPaths`): when the file watcher processes a feature file, it reads the subtask block and reconciles the DB to match. This does two things:
   - **Links** plans found in the file's block to the feature in the DB.
   - **Unlinks** plans that are in the DB as subtasks of this feature but NOT in the file's block.

(Both are described here under their pre-fix names; the unlink half is gone and the symbols are now `_linkFeatureMarkdownSubtasks` → `linkFeatureSubtasksByPaths` — see Already Landed.)

The **unlink** is the dangerous path. When the feature file is stale (missing a subtask that IS in the DB — due to a race between `_regenerateFeatureFile` and an agent's prose edit, a failed regeneration, or a watcher timing issue), the watcher fires on the stale file and `syncFeatureSubtasksByPaths` **clears the `featureId`** from the DB for the missing subtask. The plan becomes a loose plan — no longer in the feature, potentially lost among other loose cards on the board.

### Root Cause

The `rearrange-feature` skill creates a new plan via `POST /kanban/plans`, then assigns it via `assign-to-feature.js`. The assign sets the `featureId` in the DB and calls `_regenerateFeatureFile` to write the feature file with the new subtask in the block. But the skill also instructs the agent to "update the feature's prose" (step 6). If the agent reads the feature file before the regeneration landed and writes it back, the agent's write clobbers the regenerated subtask block. The watcher then fires on the agent's write, sees the stale block (missing the new plan), and `syncFeatureSubtasksByPaths` unlinks the new plan from the DB.

The startup self-heal (`regenerateAllFeatureFiles`) eventually fixes it on restart, but between restarts the plan is invisible.

### Background Context

- The skill documentation already says: "Never touch the auto-generated `<!-- BEGIN/END SUBTASKS -->` block — the extension regenerates it from the DB." The block is already intended to be DB-derived, not hand-edited.
- The board reads subtask membership from the DB (`partitionPlansByFeature` groups plans by their `featureId` from DB records), not from the feature file.
- `_applyFeatureLink` (the plan-file `**Feature:**` frontmatter → DB link path) skips regeneration if the subtask already has a `featureId` (lines 1031-1033 of `PlanIngestionEngine.ts`), so it can't self-heal a stale feature file block.
- `create-feature.js`'s `viaDirectFile()` fallback writes a feature markdown file directly with `<!-- BEGIN SUBTASKS -->` subtask links and relies on the file→DB ingestion path (now `_linkFeatureMarkdownSubtasks` → `linkFeatureSubtasksByPaths`) to link those subtasks in the DB. Its header comment states this explicitly. This is a reason to KEEP the file→DB direction, not to compensate for removing it — removal was the original route and has been retired (see Approach, Change 5).

## Approach

Make the two directions **compose** instead of compete, rather than deleting one of them.

The race is not caused by the file→DB direction existing. It is caused by that direction being **bidirectional** — deriving *removals* from a set difference against the file. A stale copy of the file is missing rows the DB legitimately has, and a difference-based reconcile reads that absence as "delete these".

So:
- **file→DB is link-only.** A path listed in the block sets `feature_id`. A path *absent* from the block means nothing. Removal is an explicit operation only.
- **DB→file stays authoritative for the block's contents.** After linking, regenerate, so a clobbered or stale block self-heals immediately instead of waiting for the next subtask mutation or a restart.

This keeps the invariant this plan exists to protect (a stale or partial read of a feature file must never remove membership) *and* the capability that `feature_plan_20260818094800_api-server-port-discovery-stale-cleanup-and-dual-host-health-fallback.md` exists to provide (feature membership declarable by writing files alone, with no running API server). Deleting the file→DB direction would satisfy the first and destroy the second.

> **Superseded:** "Make the DB the single source of truth for subtask membership. The feature file's subtask block becomes purely cosmetic — always derived from the DB, never used to mutate the DB." — plus the claim that this "matches the documented intent (the block is auto-generated, do-not-edit)".
> **Reason:** Removing file→DB was one implementation route to the invariant, not the invariant itself. It also removes offline/remote subtask linking, which is a wanted capability — the requester confirmed the *reason* the sibling plan was written is that the only pre-existing file-based mechanism (`**Feature:**` frontmatter on the subtask plan file) was undocumented and unintuitive, so the gap read as missing capability. The "documented intent" argument was self-referential: the docs said hand-edits were cosmetic *because* the code ignored them. Note also that this plan's own Verification Plan test 1 asserts the **invariant** ("the DB still has 3 subtasks linked"), not the removal — so the tests survive this change of route almost unaltered.
> **Replaced with:** link-only file→DB, followed by DB→file regeneration. See Proposed Changes.

## User Review Required

None. The open question — whether hand-authored feature files may stop ingesting subtask links — was answered **no**: that capability is wanted, and providing it discoverably is the point of the sibling plan. The approach was re-routed accordingly (see Approach), so no behaviour change needs sign-off.

> **Superseded:** "This change alters the behavior of hand-authored feature files: a feature file with subtask links written directly to disk (outside the API) will no longer have those links ingested into the DB on watcher processing ... Confirm this behavior change is acceptable before implementation."
> **Reason:** Asked and answered — the requester wants file-authored subtask linking to work. Leaving this as an open question would invite an implementer to re-adopt the rejected route.

## Complexity Audit

### Routine
- Adding one gated `this._regenerateFeatureFile?.(workspaceRoot, featurePlanId)` call inside `_linkFeatureMarkdownSubtasks`, after the link — the callback is already wired via `setFeatureFileRegenerator` (line 376).
- Threading `workspaceRoot` into `_linkFeatureMarkdownSubtasks` (both call sites already have it in scope).
- Returning the unresolved-path count from `linkFeatureSubtasksByPaths` (currently logged and discarded) so the caller can gate the regen.
- Keeping `regenerateAllFeatureFiles` (line 14374) as-is — already the startup safety net.

> **Superseded:** three bullets describing the removal route — "Replacing two call sites ... swap one method call for another", "Removing the now-unreferenced `_syncFeatureMarkdownSubtasks` method", "Removing the now-unreferenced `syncFeatureSubtasksByPaths` method (lines 2713-2747)".
> **Reason:** Nothing is being removed any more. Both methods are retained (renamed to `_linkFeatureMarkdownSubtasks` / `linkFeatureSubtasksByPaths`) and the line numbers cited no longer resolve.

### Complex / Risky
- **Change 3 — `_applyFeatureLink` always-regenerate:** moves the `_regenerateFeatureFile` call (line 1040) outside the `if (!subtaskRow.featureId)` guard (lines 1031-1033). Every re-import of a plan with `**Feature:**` frontmatter now triggers a feature-file regeneration attempt (mitigated by the no-op guard at line 14360, but the DB read + content build still runs). Performance cost on bulk re-imports of large features.
- **Change 1 — the regen gate is the whole risk.** An unconditional post-link regeneration rewrites the block from DB state, which erases any link the author listed for a plan that is not imported yet — and nothing relinks it, because the pull path only fires for subtasks carrying `**Feature:**` frontmatter. The gate (regen only when every listed link resolved and no link line was in an unsupported shape) is load-bearing, not defensive polish.

> **Superseded:** "Change 5 — `create-feature.js` fallback DB-aware ... Without this, offline feature creation produces features with no subtasks on the board" and "Behavior change — hand-authored feature files no longer ingest subtask links."
> **Reason:** Change 5 is retired and the behaviour change was rejected — hand-authored feature files DO ingest subtask links. Neither is a risk of this plan any more.

## Edge-Case & Dependency Audit

### Race Conditions
- **Infinite regen loop:** `_regenerateFeatureFile` writes the file → watcher fires → `_handlePlanFile` calls `_regenerateFeatureFile` again. Broken by TWO mechanisms: (1) `registerPendingCreation` (line 14363) suppresses watcher processing of the regen's own write for 10 seconds — the self-write never re-enters the refresh path within that window; (2) the no-op guard at line 14360 (`if (newContent === existingContent) return;`) skips the write entirely when generated content equals disk, so even outside the suppression window an identical rewrite does not re-fire the watcher. Convergence is one iteration for the regen's own write.
- **Prose edit race:** if an agent edits the feature file's prose at the same time `_regenerateFeatureFile` writes, one write can clobber the other. This is a general file-write race that already exists today. The fix doesn't make it worse — `_regenerateFeatureFile` preserves all content outside the subtask block, so a subsequent regeneration restores the correct block without losing prose. The `registerPendingCreation` guard gives a 10-second window where the watcher won't re-process the file.
- **Re-link race (residual, accepted):** with the file→DB direction removed, there is no path for a stale file to re-link a subtask that was explicitly removed from a feature. This is strictly better than the pre-fix state (where the unlink race caused invisibility). The only theoretical residual: an explicit removal (`_removeSubtaskFromFeature`) clears `featureId` and regens the file without the subtask; if a stale external write with the OLD block lands within the 10-second suppression window, the watcher would process it — but with no file→DB link direction, it cannot re-link the subtask. The race is eliminated, not merely mitigated.

### Security
- No new attack surface. All operations are internal DB writes and local file writes. `create-feature.js` fallback already opens the DB handle read-only; Change 5 adds write calls using the existing `updateFeatureStatus` method (no raw SQL, no new privileges).

### Side Effects
- **Hand-authored feature files:** subtask links written directly to disk ARE ingested (link-only), so this workflow is supported rather than broken. The block is then regenerated from the DB — but only once every listed link resolves, so an author's not-yet-imported links are never erased mid-flight (see Change 1, "Why gated"). `.agents/skills/manage-features/SKILL.md` documents both file-only linking mechanisms and the link-only contract.
- **`**Feature:**` frontmatter on plan files:** this path (`_applyFeatureLink`) is separate from the feature file subtask block sync. It reads the `**Feature:**` line from a PLAN file (not a feature file) and links the plan to the feature in the DB. This continues to work — Change 3 ensures it also regenerates the feature file afterward, even when the `featureId` was already set.
- **Performance:** `_regenerateFeatureFile` reads subtasks from the DB and writes the file. This is already called on every subtask mutation. Replacing `_syncFeatureMarkdownSubtasks` (which read the file and did DB queries) with `_regenerateFeatureFile` (which reads the DB and writes the file) is a net-neutral performance change at the two `_handlePlanFile` call sites. Change 3 adds a regen attempt on every re-import of a `**Feature:**`-frontmatter plan — the no-op guard (line 14360) skips the write when content is unchanged, but the DB read + content build still runs. On a 50-subtask feature touched 50 times during a bulk edit, that is 50 regen attempts (all no-op writes). Accepted as the cost of self-healing stale blocks.

### Dependencies & Conflicts
- **`create-feature.js` fallback:** no longer coupled to Change 1 — the ingestion path it relies on is retained (link-only), so Change 5 was retired and no must-ship-together constraint remains.
- **`regenerateAllFeatureFiles` (startup self-heal, line 14374):** unchanged. Remains the safety net for any drift that accumulated before the fix was deployed. No conflict.
- **`_retryPendingFeatureLinks` (line 1802):** unchanged. Handles deferred `**Feature:**` frontmatter links — a separate concern from the feature file subtask block. Stays at both call sites (lines 1991, 2040).

## Dependencies

None — this is a self-contained bugfix in the feature subtask sync path. No other plan or session is a prerequisite.

## Adversarial Synthesis

Key risks: (1) an unconditional post-link regeneration erases an author's not-yet-imported subtask links from the file, silently losing them — mitigated by gating the regen on a fully-resolved read (Change 1); (2) Change 3 triggers a regen attempt on every `**Feature:**`-frontmatter plan re-import — mitigated by the no-op write guard, with the DB-read/content-build cost accepted; (3) the regen callback (`_regenerateFeatureFile`) is optional (`?.`) and must be wired in tests or verification proves nothing; (4) a future reader sees a link-only reconcile and "completes" it by re-adding an unlink pass, reopening this exact bug — mitigated by the `link` in the method name, the docblock on `linkFeatureSubtasksByPaths`, and the rule under Change 2. Mitigations: gate the regen, wire the regen callback in every test, cite the 10-second `registerPendingCreation` suppression as the loop-break mechanism rather than relying on "convergence", and land the regression test the Verification Plan specifies — nothing in CI currently pins either the link-only contract or the parser fix.

## Already Landed

Delivered during review of `feature_plan_20260818094800_api-server-port-discovery-stale-cleanup-and-dual-host-health-fallback.md` (commits `c8798b9c`, `3c5d671d`). **Symptom (a) of this bug — a stale file read clearing `feature_id` — is closed.** Do not re-do:

- `syncFeatureSubtasksByPaths` → `linkFeatureSubtasksByPaths`: unlink pass deleted, `allowUnlink` option deleted. Omission from the block is no longer a removal instruction.
- Nested-feature guard: never writes `is_feature=0` onto a row that is itself a feature (reachable via the `./x.md` link shape).
- Cross-feature guard retained: never steals a plan owned by a different feature.
- Parser fix: the `## Subtasks` heading fallback carried `/m`, so `$` matched at every end-of-line and only the FIRST link was captured — every later link then read as removed. Re-anchored with `(?:^|\n)`.
- `create-feature.js`: an unresolvable planId is a hard error instead of a guessed `../plans/<planId>.md` that links nothing while reporting success.
- `_syncFeatureMarkdownSubtasks` → `_linkFeatureMarkdownSubtasks`.
- `.agents/skills/manage-features/SKILL.md`: documents both file-only linking mechanisms and the link-only contract; its false claim that offline linking "will need to be done when VS Code is next opened" is gone. `.claude` mirror regenerated.

**What remains for this plan: symptom (b)** — a subtask correctly linked in the DB but missing from the feature file's block, which anything reading the file (i.e. every agent) sees as absent. Changes 1 and 3 close that. No CI test pins any of the above, which is why the Verification Plan below is load-bearing rather than a formality.

## Proposed Changes

### `src/services/PlanIngestionEngine.ts`

**Change 1 — Regenerate the feature file AFTER linking, gated on a complete read.**

> **Superseded:** "Replace `_syncFeatureMarkdownSubtasks` with DB-authoritative regeneration at both watcher call sites ... Remove or dead-code the `_syncFeatureMarkdownSubtasks` method entirely once both callers are gone."
> **Reason:** Replacing the link with a regeneration deletes offline subtask linking. Sequencing the regeneration *after* the link delivers the same self-heal without giving up the capability. The unlink half — the actual race source — was already removed separately (see Already Landed).
> **Replaced with:** the logic below.

- **Context:** `_linkFeatureMarkdownSubtasks` (renamed from `_syncFeatureMarkdownSubtasks`) runs at two call sites in `_handlePlanFile` and calls `db.linkFeatureSubtasksByPaths`, which is now link-only. The DB can no longer be corrupted by a stale block — but the **file's block can still be stale** (an agent's prose pass clobbers it) until the next subtask mutation or the startup self-heal. That residual staleness is symptom (b) of this bug: the subtask is correctly linked in the DB but invisible to anything reading the file, which includes every agent driven off these files. The board is unaffected (`partitionPlansByFeature` reads the DB).
- **Logic:** After the `linkFeatureSubtasksByPaths` call, invoke `this._regenerateFeatureFile?.(workspaceRoot, featurePlanId)` — but **only when the block was read completely**: no link line in an unsupported shape, and every listed path resolved to a plan row. `_linkFeatureMarkdownSubtasks` already computes the unsupported-shape count; have `linkFeatureSubtasksByPaths` return its unresolved count (currently only logged) so the caller can gate on both. `_linkFeatureMarkdownSubtasks` needs `workspaceRoot` threaded in as a parameter; both call sites already have it in scope.
- **Why gated:** an author writing a feature file offline may list plans that are not imported yet (their watcher events are still debouncing, or the plan files land later). Regenerating unconditionally would rewrite the block from current DB state and **erase those pending links from the file**, and nothing would relink them — the pull path only fires for subtasks carrying `**Feature:**` frontmatter. Leaving the file untouched until the read is complete preserves the author's intent; the next ingest of that file, once the plans exist, both links and regenerates.
- **Implementation:** keep `_linkFeatureMarkdownSubtasks` and both call sites. `_retryPendingFeatureLinks` (which follows at each site) stays unchanged — deferred `**Feature:**` frontmatter links are a separate concern.
- **Edge Cases:** No regen loop — `_regenerateFeatureFile` calls `registerPendingCreation`, suppressing watcher processing of its own write for 10s (`PlanIngestionEngine.ts:194-201`), and it skips the write entirely when generated content is byte-identical to disk. If `_regenerateFeatureFile` is unwired (optional `?.`) the call is a no-op: the DB is still correct and the block refreshes on the next mutation or at startup. Tests MUST wire `setFeatureFileRegenerator` or the regen never runs and the test passes for the wrong reason.

**Change 3 — Make `_applyFeatureLink` always regenerate the feature file.**

- **Context:** `_applyFeatureLink` (lines 1003-1051) returns early at lines 1031-1033 if the subtask already has a `featureId`, skipping the `updateFeatureStatus` call (line 1034) AND the `_regenerateFeatureFile` call (line 1040). This means a subtask linked in the DB but missing from the feature file's block (due to a previous race) is never self-healed by `_applyFeatureLink`.
- **Logic:** Move the `_regenerateFeatureFile` call (line 1040) outside the `if (!subtaskRow.featureId)` guard so it always runs after the feature is resolved. The `updateFeatureStatus` call (line 1034) remains conditional — only set the `featureId` if it is not already set. The early returns for unresolved features (lines 1016-1028, feature row null → defer) and invalid inputs (lines 1011-1012) stay unchanged — regeneration is meaningless when the feature does not yet exist.
- **Implementation:** Restructure so the flow is: resolve feature → if null, defer/return → fetch subtask row → if `featureId` empty, call `updateFeatureStatus` → always call `_regenerateFeatureFile` (wrapped in the existing try/catch at lines 1039-1045) → delete pending link entry.
- **Edge Cases:** Every re-import of a plan with `**Feature:**` frontmatter now triggers a regen attempt. The no-op guard at line 14360 skips the write when content is unchanged. The DB read + content build cost is accepted (see Complexity Audit).

### `src/services/KanbanDatabase.ts`

**Change 2 — RETIRED. Already delivered as link-only, not removal.**

> **Superseded:** "Remove `syncFeatureSubtasksByPaths` (unlink path eliminated) ... With the sole caller removed, the method has no callers — remove it entirely. Delete lines 2706-2747."
> **Reason:** Only the *unlink pass* was the race source, not the method. It is now `linkFeatureSubtasksByPaths` — link-only, with a cross-feature guard (never steal a plan owned by another feature) and a nested-feature guard (never write `is_feature=0` onto a row that is itself a feature, which the `./x.md` link shape made reachable). Deleting the method would have taken offline linking with it.
> **Replaced with:** nothing to do — see Already Landed. The original edge-case note stands and is promoted to a rule: **never re-introduce an unlink-from-file path.** The method name says `link` precisely so its absence is not mistaken for an unfinished feature.

### `.agents/skills/kanban_operations/create-feature.js`

**Change 5 — RETIRED. No longer needed.**

> **Superseded:** "Make the `viaDirectFile()` fallback DB-aware (do not rely on file→DB ingestion) ... add `await db.updateFeatureStatus(pid, 0, featurePlanId)`."
> **Reason:** This existed only to compensate for Change 1 deleting the ingestion path the fallback depends on. Change 1 no longer deletes it, so the fallback keeps working as designed and this becomes a second, redundant writer of the same link. Its stated degraded case ("if `KanbanDatabase` is unavailable ... the feature will show empty on the board") was independently closed while reviewing the sibling plan: an unresolvable planId is now a hard error instead of a guessed `../plans/<planId>.md` path that links nothing while reporting success.
> **Replaced with:** nothing to do. The Changes 1+5 shipping coupling described under Dependencies & Conflicts is void.

### `src/services/KanbanProvider.ts`

**Change 4 — Keep the startup self-heal as-is.**

- **Context:** `regenerateAllFeatureFiles` (line 14374) already runs on startup and regenerates every feature file from the DB.
- **Logic:** No changes needed. This remains the safety net for any drift that accumulated before the fix was deployed, and for the degraded `create-feature.js` fallback case when the `KanbanDatabase` module is unavailable.
- **Implementation:** None.
- **Edge Cases:** None.

## Verification Plan

> Note: For this run, compilation and automated tests are not executed — the checks below remain the written verification plan for implementation.

### Automated Tests

1. **Unit test — stale file doesn't unlink:** Create a feature with 3 subtasks in the DB. Manually write a feature file with only 2 subtasks in the block. Trigger the watcher. Verify: (a) the DB still has 3 subtasks linked — this is the invariant, and it holds already via link-only, so land it as a **regression pin** so nothing re-adds an unlink pass; (b) the feature file is regenerated with all 3 subtasks — this is what Change 1 adds. **Test setup requirement:** wire `setFeatureFileRegenerator` on the `PlanIngestionEngine` under test, or the regen is a no-op and the test passes for the wrong reason. Add two more pins alongside: an **empty** subtask block must wipe nothing, and a block listing a plan owned by another feature must not steal it.

2. **Unit test — assign + prose edit race:** Create a plan, assign it to a feature (sets featureId in DB, regenerates feature file). Immediately write the feature file with a stale subtask block (simulating an agent's prose edit clobbering the regeneration). Trigger the watcher. Verify: (a) the DB still has the subtask linked, (b) the feature file is regenerated with the correct subtask block.

3. **Unit test — `_applyFeatureLink` regenerates even when featureId is set:** Create a plan with a `**Feature:**` frontmatter line. Import it (sets featureId via `_applyFeatureLink`). Manually remove the plan from the feature file's subtask block. Re-import the plan (triggers `_applyFeatureLink` again). Verify: (a) the feature file is regenerated with the plan in the subtask block.

4. **Integration test — rearrange-feature split flow:** Simulate the `rearrange-feature` split: create a plan via `POST /kanban/plans`, assign it via `POST /kanban/features/assign`, then immediately edit the feature file's prose (simulating step 6 of the skill). Trigger the watcher. Verify the new subtask appears in the feature file's block and remains linked in the DB.

5. **Integration test — `create-feature.js` offline fallback:** With the extension API unreachable, run `create-feature.js` with a set of plan IDs. Verify: (a) the feature markdown file is written with the subtask block; (b) when the watcher ingests that file, each subtask's `feature_id` is set to the new feature's plan ID — **via ingestion**, which is the supported path now that Change 5 is retired; (c) the block is then regenerated from the DB and matches (no empty-block regression); (d) an unresolvable planId aborts with a non-zero exit and writes NO feature file, rather than emitting guessed links and reporting success.

> **Superseded:** assertion (b) previously read "set ... in `kanban.db` directly (not via ingestion)".
> **Reason:** That wording encoded Change 5, which was retired — asserting "not via ingestion" would now fail against correct behaviour.

6. **Existing tests:** Run the existing test suite (`src/test/headless-feature-management-*.test.js`) to verify no regressions in feature management operations. Ensure these tests wire `setFeatureFileRegenerator` if they exercise the feature-file watcher path.
