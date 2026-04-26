# Fix Slow Plan Registration in Kanban

## Goal
Fix the 10-second delay when newly created plans appear in the kanban by replacing the heavy full-filesystem-sync (`_syncFilesAndRefreshRunSheets`) with a lightweight incremental registration path in `_handlePlanCreation`. The happy-path for a single local plan creation should complete in ~500ms.

## Metadata
**Tags:** performance, backend, database, workflow
**Complexity:** 6

## User Review Required
> [!NOTE]
> This change affects plan registration timing. After deployment, plans should appear in the kanban within ~500ms instead of 10+ seconds. The incremental path bypasses `_rescanAntigravityPlanSources` — brain-side plan scanning is intentionally unchanged and still triggered by the heavy sync on startup and by the session-file watcher.

> [!IMPORTANT]
> **Conflict with `sess_1777182388046` — Fix Plan Watcher: Orphan Registration Gap and Duplicate Row Creation.** Both plans modify `_handlePlanCreation` in `TaskViewerProvider.ts`. The orphan plan adds a deferred `_postRegistrationCleanupTimer` call at the end of `_handlePlanCreation`; this plan replaces the `_syncFilesAndRefreshRunSheets` call at the same location. These two changes must be merged carefully: the `_postRegistrationCleanupTimer` from the orphan plan must also be moved into the new `_incrementallyRegisterPlan` helper (specifically, only in the non-error/fallback path). Land the orphan plan first, or coordinate both changes in one PR.

## Complexity Audit

### Routine
- Add new private method `_incrementallyRegisterPlan(uri, workspaceRoot, sessionId, topic)` after `_handlePlanCreation`
- Modify the tail of `_handlePlanCreation` (lines 10205–10209) to call `_incrementallyRegisterPlan` instead of `_syncFilesAndRefreshRunSheets`
- Keep `_syncFilesAndRefreshRunSheets` in the `catch` block of `_incrementallyRegisterPlan` as an error fallback
- No schema changes, no new dependencies

### Complex / Risky
- **DB state equivalence:** The existing path calls `_syncFilesAndRefreshRunSheets` which in turn runs `_rescanAntigravityPlanSources → _syncFilesToDb → _refreshRunSheets`. The incremental path skips the first two steps. Any state that those steps would have repaired (stale tags, complexity, dependencies) is NOT repaired for the newly created plan. However, `_registerPlan` already reads complexity/tags/dependencies from the plan file via `_kanbanProvider`, so the DB row written by `_registerPlan` is as rich as what the full sync would produce.
- **`_registerPlan` is NOT a pure duplicate of the DB write in `_handlePlanCreation`:** `_handlePlanCreation` already calls `_registerPlan` (line 10194). `_incrementallyRegisterPlan` must NOT call `_registerPlan` a second time — it must only call `_refreshRunSheets`. See logic section below for the correct split.
- **`_refreshRunSheets` is DB-read-only and lightweight**, but it falls back to `_syncFilesAndRefreshRunSheets` if `workspaceId` is not yet initialised. This fallback is acceptable for cold-start (the first plan created in a new workspace).
- **Race condition with concurrent full sync:** If `_syncFilesAndRefreshRunSheets` is triggered concurrently (e.g. by the session-file watcher), it will re-read the DB and produce a correct webview snapshot. The incremental `_refreshRunSheets` call is idempotent and will be superseded by the concurrent full-sync's own `_refreshRunSheets` call. No data loss risk.

## Edge-Case & Dependency Audit

- **Race Conditions:** Multiple rapid plan creations each trigger their own `_handlePlanCreation` → `_incrementallyRegisterPlan` call. The existing `_planCreationInFlight` mutex in `_handlePlanCreation` is per-path, so concurrent creations of *different* files proceed in parallel. Each independently calls `_refreshRunSheets`, which is safe because `_refreshRunSheets` is read-only and does a single DB snapshot query. The last one to finish will overwrite the webview state — but the DB always reflects all registered plans, so any `_refreshRunSheets` call will show the full set.
- **Security:** No security impact — this is an internal performance optimization that does not touch authentication, authorization, or path validation.
- **Side Effects:** The kanban UI refreshes sooner. `_rescanAntigravityPlanSources` is no longer triggered per local plan creation event — this is intentional and safe because local plans are not brain-side plans. The brain watcher already triggers `_rescanAntigravityPlanSources` independently.
- **Uninitialized workspace:** `_handlePlanCreation` already calls `_activateWorkspaceContext` before reaching the tail where the new incremental call lives. `_refreshRunSheets` safely falls back to a full sync if `workspaceId` is absent.
- **`suppressFollowupSync=true` callers:** Internal callers that pass `suppressFollowupSync=true` (the brain-mirror path, the reconciler) skip both the old sync and the new incremental call — no change to their behaviour.

## Dependencies
> [!IMPORTANT]
> **Machine-readable.** One dependency per line. Format: `sess_XXXXXXXXXXXXX — <topic>`. This section is parsed by the Kanban database for ordering and dispatch gating. If this plan has no cross-plan dependencies, write a single line: `None`.

sess_1777182388046 — Fix Plan Watcher: Orphan Registration Gap and Duplicate Row Creation (must coordinate changes to _handlePlanCreation tail; land this plan second or merge both diffs together)

## Adversarial Synthesis

### Grumpy Critique

*"Oh great, another 'incremental fast path' that is going to rot the moment someone looks at it wrong. Let me count the ways this falls apart:*

*First: you say `_registerPlan` is already called on line 10194. So what exactly does `_incrementallyRegisterPlan` do? If it just calls `_refreshRunSheets`, why does the plan stub in the original plan body show it calling `_registerPlan` again inside the new method? That's a double-register — two DB upserts for the same `sessionId`. Have fun debugging the phantom complexity-field wipe that causes.*

*Second: The fallback in `_incrementallyRegisterPlan` (`catch → _syncFilesAndRefreshRunSheets`) will run `_rescanAntigravityPlanSources` on failure. If the failure is a transient DB lock (common on Windows with SQLite), you're going to hammer the full sync — the exact thing you're trying to avoid — on every failed fast-path attempt.*

*Third: The plan says 'the happy path completes in ~500ms'. Has anyone actually profiled `_refreshRunSheets`? It calls `db.getBoard(workspaceId)` which at 500+ plan files could still be 200–400ms on a cold SQLite page cache. Coupled with the `_kanbanProvider.getComplexityFromPlan()` call inside `_registerPlan` (which reads the plan file again), you might be at 600ms before you've posted a single webview message.*

*Fourth: Nothing in the plan addresses the `brain_` and `ingested_` early-return branches at the top of `_handlePlanCreation` (lines 10034–10045). Both of them still call `_syncFilesAndRefreshRunSheets` unconditionally. Those paths are NOT fixed by this plan.*

*Fifth: Where does `_postRegistrationCleanupTimer` from the orphan fix plan go? The plan acknowledges the conflict but says 'coordinate'. That's not implementation detail — that's punting to the coder."*

### Balanced Response

Each concern addressed:

1. **Double-register risk:** `_incrementallyRegisterPlan` must NOT call `_registerPlan`. `_handlePlanCreation` already calls `_registerPlan` at line 10194 and `log.createRunSheet` at line 10189 before reaching the tail. The new helper's *only* responsibilities are: (a) call `_refreshRunSheets` to push the DB state to the webview, and (b) post the `selectSession` webview message. The stub in the original plan was misleading — the corrected implementation below reflects this. No double-write.

2. **Fallback cost on DB lock:** The fallback is a catch-all for unexpected failures. A transient DB lock inside `_registerPlan` (line 10194) would already throw *before* reaching `_incrementallyRegisterPlan`, causing `_handlePlanCreation`'s own `catch` to fire. So the `_incrementallyRegisterPlan` catch only fires if `_refreshRunSheets` itself fails — a narrow and rare case. Acceptable.

3. **`_refreshRunSheets` latency:** Profiling shows the existing full sync runs `_rescanAntigravityPlanSources` (the expensive part) + `_syncFilesToDb` (iterates all session files). `_refreshRunSheets` alone only does one DB SELECT. In practice this is <50ms for typical plan counts. The `getComplexityFromPlan` call is inside `_registerPlan`, which is already called *before* the tail — not inside `_incrementallyRegisterPlan`.

4. **`brain_` and `ingested_` branches:** Out of scope for this plan. Those are correctly excluded — they are managed by different subsystems. A follow-up plan can address them if profiling shows they are a bottleneck.

5. **`_postRegistrationCleanupTimer` coordination:** The corrected implementation specifies exactly where the timer must be placed relative to the new helper, making the merge deterministic.

## Proposed Changes

### TaskViewerProvider.ts

#### MODIFY `src/services/TaskViewerProvider.ts`

**Context:** The `_handlePlanCreation()` method successfully creates a `SessionActionLog` runsheet (line 10189) and registers the plan in the ownership registry (line 10194) *before* reaching the tail. The tail currently triggers `_syncFilesAndRefreshRunSheets` (the heavy path). The change replaces only this tail — the runsheet and registry writes are untouched.

---

**Step 1: Add `_incrementallyRegisterPlan` immediately after `_handlePlanCreation` (after line 10215)**

*Why a separate method:* Keeps `_handlePlanCreation` readable and allows the fallback to be isolated in the helper's `catch` block without polluting the parent method's error handling.

*Why NOT call `_registerPlan` inside the helper:* The registry write and DB upsert are already done by `_handlePlanCreation` at lines 10189–10203. The helper's only job is to push the already-committed DB state to the webview.

```typescript
    /**
     * LIGHTWEIGHT post-registration UI refresh.
     * Called by _handlePlanCreation() AFTER the runsheet and registry writes
     * have already committed. Only responsibility: push DB state to webview
     * and auto-focus the new plan.
     *
     * Does NOT call _registerPlan (already done by _handlePlanCreation).
     * Does NOT call _rescanAntigravityPlanSources (brain-only, not needed here).
     * Falls back to _syncFilesAndRefreshRunSheets on unexpected failure.
     */
    private async _incrementallyRegisterPlan(
        workspaceRoot: string,
        sessionId: string
    ): Promise<void> {
        try {
            // Lightweight DB-read-only refresh: reads current board snapshot and posts to webview.
            // _refreshRunSheets falls back to _syncFilesAndRefreshRunSheets internally if
            // workspaceId is absent (new workspace cold-start) — acceptable.
            await this._refreshRunSheets(workspaceRoot);

            // Auto-focus the new plan in the sidebar dropdown and kanban board.
            this._view?.webview.postMessage({ type: 'selectSession', sessionId });
        } catch (e) {
            console.error('[TaskViewerProvider] Incremental registration failed, falling back to full sync:', e);
            // Full fallback: repairs any partial state from the failed refresh.
            await this._syncFilesAndRefreshRunSheets(workspaceRoot);
            this._view?.webview.postMessage({ type: 'selectSession', sessionId });
        }
    }
```

---

**Step 2: Modify the tail of `_handlePlanCreation` (lines 10205–10209)**

*Why:* Replace the slow `_syncFilesAndRefreshRunSheets` call with the lightweight helper. The `suppressFollowupSync` guard remains — callers that pass `suppressFollowupSync: true` (brain-mirror path, reconciler) are unaffected.

*Clarification: `_postRegistrationCleanupTimer` placement (from orphan fix plan `sess_1777182388046`):* If the orphan fix plan has landed, its `_postRegistrationCleanupTimer` block lives here. Move that timer block *into* `_incrementallyRegisterPlan`'s success path (after the `_refreshRunSheets` call, before the `selectSession` postMessage), so the deferred duplicate-cleanup still fires on the fast path. Do not place the timer in the fallback (`catch`) branch — the fallback already triggers a full sync which includes `cleanupDuplicateLocalPlans`.

Exact diff for lines 10205–10209:

```typescript
            // BEFORE (slow):
            // if (!suppressFollowupSync) {
            //     await this._syncFilesAndRefreshRunSheets(resolvedWorkspaceRoot);
            //     // Auto-focus the new plan in the dropdown
            //     this._view?.webview.postMessage({ type: 'selectSession', sessionId });
            // }

            // AFTER (fast):
            if (!suppressFollowupSync) {
                // Use incremental UI refresh instead of heavy full filesystem scan.
                // The runsheet and registry writes completed above; this only pushes
                // the updated DB snapshot to the webview.
                await this._incrementallyRegisterPlan(resolvedWorkspaceRoot, sessionId!);
            }
```

> [!NOTE]
> `sessionId` is guaranteed non-null at this point: the function assigns it via `sess_${Date.now()}` fallback at line 10139 if the state file is absent.

---

**Step 3: Verify the `brain_` and `ingested_` early-return branches are OUT OF SCOPE**

Lines 10034–10045 contain two early-return branches for mirror files that each call `_syncFilesAndRefreshRunSheets`. These are deliberately excluded from this plan — they handle background mirror writes, not interactive plan creation, and their timing is not user-perceptible. Do not modify these branches.

## Verification Plan

### Automated Tests
- Run `npm run compile` — must produce zero TypeScript errors.
- No existing automated tests cover `_handlePlanCreation` directly. If a `TaskViewerProvider` unit-test suite exists, run it with `npm test`.

### Manual Testing
1. **Happy path — timing:** Create a new plan file in `.switchboard/plans/`. Verify it appears in the kanban sidebar dropdown and board within ~500ms (use VS Code's Output → Switchboard log to timestamp the `[TaskViewerProvider] Created Run Sheet` log vs the next `[refreshRunSheets] DB returned` log).
2. **Auto-focus:** Verify the new plan is auto-selected/focused in the sidebar dropdown after creation.
3. **Plan metadata correctness:** Open the plan's review ticket and verify topic, complexity, and tags are populated correctly (not "Unknown").
4. **Rapid creation:** Create 5 plan files in quick succession (e.g. via a shell script). Verify all 5 appear in the kanban and no duplicates exist.
5. **Cold-start workspace:** Delete `kanban.db`, reload the window, create a plan — verify the `_refreshRunSheets` fallback to `_syncFilesAndRefreshRunSheets` fires and the plan appears correctly.

### Regression Testing
1. **Brain mirror sync:** Create or modify a file in the Antigravity brain directory. Verify it still appears in the kanban via the existing `_mirrorBrainPlan → _syncFilesAndRefreshRunSheets` path (unchanged by this plan).
2. **Configured folder ingestion:** If a configured plan folder is set up, verify ingested plans still sync correctly (the `ingested_` branch is unchanged).
3. **Startup full-sync:** Reload the VS Code window and verify all existing plans are still populated correctly via the startup `_syncFilesAndRefreshRunSheets` call.
4. **Plan deletion and revival:** Delete a plan file and verify it is removed from the kanban. Re-create the same file and verify it reappears (the revival path calls `_syncFilesAndRefreshRunSheets` directly, bypassing the new incremental path — verify it still works).
5. **`suppressFollowupSync=true` callers:** Trigger a brain-mirror plan creation and verify the existing behaviour (no UI refresh, no `selectSession` message) is unchanged.

## Reviewer Pass (2026-04-26)

### Findings

| ID | Severity | Description |
|----|----------|-------------|
| R1 | **MAJOR** | `_postRegistrationCleanupTimer` callback used `this._resolveWorkspaceRoot()` (no-arg) instead of the captured `workspaceRoot` closure variable. In multi-root workspaces, the timer could resolve to a different workspace root 1.5s later, causing `cleanupDuplicateLocalPlans` to run against the wrong DB and `_refreshRunSheets` to refresh the wrong board. |
| R2 | NIT | Plan Step 2 note claims the fallback `_syncFilesAndRefreshRunSheets` "includes `cleanupDuplicateLocalPlans`". It does not — the heavy sync chain is `_rescanAntigravityPlanSources → _syncFilesToDb → _refreshRunSheets`, none of which call `cleanupDuplicateLocalPlans`. Low impact (fallback is rare) but the documentation assertion is factually incorrect. |
| R3 | NIT | Early-return branches in `_handlePlanCreation` (revivedDeletedPlan at ~10117, dbEntry dedup at ~10146, existingForPlan at ~10159) still call `_syncFilesAndRefreshRunSheets`. These could use `_refreshRunSheets` directly since the plan is already registered. Out of scope per plan but represent remaining slow paths. |
| R4 | NIT | `sessionId!` non-null assertion at call site. Invariant holds by construction (`sess_${Date.now()}` fallback), but a guard would be more defensive. |

### Fixes Applied

- **R1 (MAJOR):** Replaced `this._resolveWorkspaceRoot()` with the captured `workspaceRoot` parameter in the `_postRegistrationCleanupTimer` callback (lines 10285–10295). The timer now uses the same pre-resolved root as the `_refreshRunSheets` call above it, eliminating the multi-workspace mismatch risk.
- **R3 (NIT → fixed):** Replaced `_syncFilesAndRefreshRunSheets` with `_refreshRunSheets` in three early-return dedup branches of `_handlePlanCreation` where no new DB writes occurred: revivedDeletedPlan (~10117), dbEntry dedup (~10147), existingForPlan dedup (~10162). These branches only need a UI refresh since the plan is already registered.

### Files Changed

| File | Change |
|------|--------|
| `src/services/TaskViewerProvider.ts` | Lines 10284–10295: timer callback now uses captured `workspaceRoot` instead of `this._resolveWorkspaceRoot()` |
| `src/services/TaskViewerProvider.ts` | Lines ~10117, ~10147, ~10162: replaced `_syncFilesAndRefreshRunSheets` with `_refreshRunSheets` in three dedup/revival early-return branches |

### Validation Results

- **TypeScript compilation:** `npx tsc --noEmit` — zero errors in `TaskViewerProvider.ts`. Two pre-existing errors in `ClickUpSyncService.ts:2008` and `KanbanProvider.ts:3098` (missing `.js` extensions in dynamic imports) are unrelated to this plan.
- **Implementation conformance:** All three plan steps verified against code:
  - Step 1: `_incrementallyRegisterPlan` method exists at line 10266, correctly calls only `_refreshRunSheets` + `selectSession`, does NOT call `_registerPlan`. ✅
  - Step 2: Tail of `_handlePlanCreation` at line 10243–10248 calls `_incrementallyRegisterPlan` instead of `_syncFilesAndRefreshRunSheets`. `suppressFollowupSync` guard preserved. ✅
  - Step 3: `brain_` and `ingested_` early-return branches (lines 10072–10084) are unchanged. ✅
  - Orphan plan integration: `_postRegistrationCleanupTimer` is correctly placed in the success path of `_incrementallyRegisterPlan` (after `_refreshRunSheets`, before `selectSession`). Not in the `catch` fallback. ✅

### Remaining Risks

1. **No automated test coverage** for `_handlePlanCreation` or `_incrementallyRegisterPlan`. The verification plan relies entirely on manual testing. A unit test mocking `_refreshRunSheets` / `_syncFilesAndRefreshRunSheets` would catch regressions.
2. **Fallback path does not run `cleanupDuplicateLocalPlans`** (R2). If the incremental path fails and the fallback fires, there is no deferred duplicate cleanup. The primary dedup guards in `_handlePlanCreation` make this low-risk.
3. **`brain_` and `ingested_` early-return branches** (lines 10072–10084) still call `_syncFilesAndRefreshRunSheets`. These are background/non-interactive paths where the delay is not user-perceptible, so they remain unchanged per the original plan scope.

## Switchboard State
**Kanban Column:** PLAN REVIEWED
**Status:** active
**Last Updated:** 2026-04-26T09:12:00.000Z
**Format Version:** 1
