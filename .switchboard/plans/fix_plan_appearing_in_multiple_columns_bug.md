# Fix Plan Appearing in Multiple Columns Bug

## Goal
Fix the real duplication path that allows one local plan file to exist as multiple active Kanban rows at once. The repaired flow must guarantee that a single `.switchboard/plans/*.md` file maps to one active local session record, and it must also clean up already-duplicated rows so the board stops rendering the same plan in multiple columns.

## Metadata
**Tags:** backend, database, bugfix
**Complexity:** 6

## User Review Required
> [!NOTE]
> - **Clarification:** live DB inspection already disproves the draft’s primary diagnosis. The observed duplicate plan (`.switchboard/plans/fix_duplicate_switchboard_state_parsing_bug.md`) currently exists as **two active rows with the same `plan_file` and different `session_id`s**, so this is not just “one row whose `kanban_column` failed to update.”
> - **Clarification:** `src/services/KanbanDatabase.ts::UPSERT_PLAN_SQL` is intentionally documented as preserving lifecycle state for existing rows. Changing it to overwrite `kanban_column` / `status` would clobber manual moves and still would not explain two distinct active sessions for one `plan_file`.
> - **Clarification:** current code already contains duplicate cleanup for watcher-created `brain_*.md` / `ingested_*.md` mirror rows in `cleanupSpuriousMirrorPlans()`, but there is no equivalent cleanup for duplicate **local** plan rows under `.switchboard/plans/*.md`.
> - **Clarification:** the two observed duplicate rows share the same `created_at`, the same `plan_file`, and `sess_*` local session IDs. One row has `last_action = 'unknown'`, which strongly implicates the plan-creation/watcher path (`TaskViewerProvider.ts`) rather than a board-rendering bug.

## Complexity Audit
### Routine
- Add a regression that seeds two active local rows for the same `plan_file` and proves cleanup leaves exactly one canonical row.
- Keep the existing lifecycle-preserving semantics of `UPSERT_PLAN_SQL`; this fix should not repurpose generic metadata upserts into column/status mutation.
- Add targeted logging for duplicate-local-plan cleanup so recovery is visible during debugging instead of looking like silent board magic.

### Complex / Risky
- `src/services/TaskViewerProvider.ts` currently has two independent local-plan creation paths touching the same file lifecycle: `_createInitiatedPlan()` writes the plan and creates a session immediately, while `_handlePlanCreation()` can also create a `sess_*` row from watcher events. Same-file create races here are the most plausible root cause.
- `src/services/SessionActionLog.ts::getRunSheets()` is DB-first and hydrates from `db.getActivePlans(workspaceId)`, so once duplicate active local rows land in `plans`, the duplication becomes self-sustaining across refreshes until something explicitly deletes the stale row.
- Healing existing duplicates is not just a `DELETE FROM plans` problem; stale duplicate sessions may also have `plan_events` rows. Cleanup must remove or merge those stale artifacts deliberately so old duplicate sessions do not keep reappearing indirectly.

## Edge-Case & Dependency Audit
- **Race Conditions:** `TaskViewerProvider.ts` wires both `vscode.workspace.createFileSystemWatcher(...).onDidCreate(...)` and a native `fs.watch` fallback into `_handlePlanCreation()`. That means the same file can arrive through multiple asynchronous create paths. On top of that, `_createInitiatedPlan()` writes a new plan file and creates a runsheet immediately. The fix must therefore add a same-file creation lock, not just “check once and hope.”
- **Security:** No new trust boundary is needed. Keep all path resolution and workspace scoping behavior unchanged; this bugfix should only tighten same-file local-plan dedupe and DB cleanup.
- **Side Effects:** Duplicate cleanup must key on canonical `plan_file`, not `topic`, because multiple plans can legitimately share the same title. Cleanup must also stay scoped to local `.switchboard/plans/*.md` rows and not accidentally delete brain/import mirrors that already have a separate cleanup path.
- **Dependencies & Conflicts:** `switchboard-get_kanban_state` currently shows `Fix Duplicate Switchboard State Parsing Bug` duplicated across **New** and **Planned**, which is the concrete victim this plan must explain. Active **Planned** items are this plan, `Fix Duplicate Switchboard State Parsing Bug`, and `Add Kanban Column Management to Setup Panel`. The duplicate-state plan mostly touches `planStateUtils.ts` / `PlanFileImporter.ts` and is not a direct code dependency. `Add Kanban Column Management to Setup Panel` does overlap with `TaskViewerProvider.ts`, so coordinate merges there if both land.

## Adversarial Synthesis
### Grumpy Critique
This draft walked straight past the crime scene and started yelling at the wallpaper. Two rows with two different `session_id`s for the same `plan_file` is not an “upsert forgot to update `kanban_column`” bug; it is a duplicate-row creation bug. `UPSERT_PLAN_SQL` is not even on the hot path for that symptom unless the exact same `plan_id` collides, which it plainly did not. Changing the upsert to overwrite lifecycle state would be a lovely way to break legitimate manual moves while leaving the actual duplicate sessions alive and well.

The proposed cleanup was also dangerously naive. Deduping by `topic` is nonsense — titles are not unique. And “manually delete duplicates and monitor if they reappear” is not a fix; it is a confession that the system still has no invariant. The live evidence points at a same-file local plan race between creation paths, and the repo already contains a cleanup function for mirror duplicates only. If this plan does not target the watcher/create path and add a real local duplicate-healing pass, it is just more expensive hand-waving.

### Balanced Response
The corrected plan narrows the problem to the actual invariant that was broken: one local `plan_file` should have one active local session row. It keeps the intentional lifecycle semantics of `UPSERT_PLAN_SQL` intact and instead addresses the real failure modes: same-file create races in `TaskViewerProvider.ts`, self-sustaining duplicate hydration through `SessionActionLog.ts`, and the absence of any local-plan equivalent to `cleanupSpuriousMirrorPlans()`.

The implementation below therefore does two things in lockstep. First, it prevents new duplicates by adding a same-file in-flight guard around `_handlePlanCreation()`. Second, it heals existing duplicates by adding a DB cleanup pass keyed on active local `plan_file`s, then running that cleanup before the snapshot/hydration loop rebuilds board state. That solves both the immediate board symptom and the underlying persistence bug.

## Agent Recommendation

Send to Coder

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Do not “fix” this by updating generic upsert lifecycle semantics. The implementation should preserve the current explicit `updateColumn()` / `updateStatus()` design and instead eliminate duplicate local sessions for one `plan_file`.

### High Complexity

#### 1. Prevent same-file local plan creation races before a second `sess_*` row can be minted
##### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** `_createInitiatedPlan()` already pre-registers a path in `_pendingPlanCreations`, but `_handlePlanCreation()` only *reads* that set; it does not establish its own same-file in-flight lock. Because both `onDidCreate` and the native `fs.watch` fallback call `_handlePlanCreation()`, two concurrent callbacks can still pass the existing DB/runsheet checks before either has inserted a canonical row.
- **Logic:**
  1. Add a new `_planCreationInFlight` set keyed by normalized absolute path.
  2. In `_handlePlanCreation()`, treat `_pendingPlanCreations` as the “internal write suppression” guard and `_planCreationInFlight` as the “same-file mutual exclusion” guard.
  3. Add the stable path to `_planCreationInFlight` before any runsheet or DB lookup, and remove it in a `finally` block.
  4. Leave the existing plan-file DB lookup and anonymous `sess_${Date.now()}` fallback logic intact; the fix is to make that logic run once per file at a time, not to invent a new session ID scheme.
- **Implementation:**

```diff
--- a/src/services/TaskViewerProvider.ts
+++ b/src/services/TaskViewerProvider.ts
@@
     private _recentActionDispatches = new Map<string, NodeJS.Timeout>(); // short TTL dedupe for sidebar actions
     private _julesSyncInFlight = false; // re-entrancy guard for auto-sync-before-Jules
     private _selfStateWriteUntil = 0; // timestamp until which state watcher events are suppressed (self-write guard)
     private _pendingPlanCreations = new Set<string>(); // suppress watcher for internally created plans
+    private _planCreationInFlight = new Set<string>(); // same-file mutex for watcher/direct create races
     private _planFsDebounceTimers = new Map<string, NodeJS.Timeout>(); // debounce native plan watcher events
@@
     private async _handlePlanCreation(uri: vscode.Uri, workspaceRoot?: string, _internal: boolean = false) {
         const basename = path.basename(uri.fsPath);
 
         // Brain mirror files (brain_<64-hex>.md) are managed exclusively by _mirrorBrainPlan.
         // The plan watcher must never create an independent local runsheet for them — doing so
@@
         }
 
         const stablePath = this._normalizePendingPlanPath(uri.fsPath);
-        if (this._pendingPlanCreations.has(stablePath)) {
+        if (this._pendingPlanCreations.has(stablePath) || this._planCreationInFlight.has(stablePath)) {
             console.log(`[TaskViewerProvider] Ignoring internal plan creation: ${uri.fsPath}`);
             this._logEvent('plan_management', { operation: 'watcher_suppressed', file: uri.fsPath });
             return;
         }
+        this._planCreationInFlight.add(stablePath);
         const resolvedWorkspaceRoot = this._resolveWorkspaceRootForPath(uri.fsPath, workspaceRoot);
-        if (!resolvedWorkspaceRoot) return;
-        await this._activateWorkspaceContext(resolvedWorkspaceRoot);
-        const statePath = path.join(resolvedWorkspaceRoot, '.switchboard', 'state.json');
-        const planFileRelative = path.relative(resolvedWorkspaceRoot, uri.fsPath);
-        const normalizedPlanFileRelative = planFileRelative.replace(/\\/g, '/');
-        const absolutePlanFile = path.join(resolvedWorkspaceRoot, normalizedPlanFileRelative).replace(/\\/g, '/');
-        const log = this._getSessionLog(resolvedWorkspaceRoot);
+        if (!resolvedWorkspaceRoot) {
+            this._planCreationInFlight.delete(stablePath);
+            return;
+        }
+        await this._activateWorkspaceContext(resolvedWorkspaceRoot);
+        const statePath = path.join(resolvedWorkspaceRoot, '.switchboard', 'state.json');
+        const planFileRelative = path.relative(resolvedWorkspaceRoot, uri.fsPath);
+        const normalizedPlanFileRelative = planFileRelative.replace(/\\/g, '/');
+        const absolutePlanFile = path.join(resolvedWorkspaceRoot, normalizedPlanFileRelative).replace(/\\/g, '/');
+        const log = this._getSessionLog(resolvedWorkspaceRoot);
 
         try {
             // Deduplicate: if any runsheet (active or completed) already points at this exact
             // plan file, do not auto-create a new runsheet from watcher events.
             const existingForPlan = await log.findRunSheetByPlanFile(normalizedPlanFileRelative, {
@@
             await this._syncFilesAndRefreshRunSheets(resolvedWorkspaceRoot);
             // Auto-focus the new plan in the dropdown
             this._view?.webview.postMessage({ type: 'selectSession', sessionId });
         } catch (e) {
             console.error('[TaskViewerProvider] Failed to handle plan creation:', e);
+        } finally {
+            this._planCreationInFlight.delete(stablePath);
         }
     }
```
- **Edge Cases Handled:** This guard blocks duplicate sessions from same-process races between `onDidCreate`, native `fs.watch`, and any rapid follow-up create notifications for the same local plan file, without changing the existing session-ID collision behavior for genuinely different files.

#### 2. Heal already-duplicated local plan rows before DB-backed run-sheet hydration reintroduces them
##### [MODIFY] `src/services/KanbanDatabase.ts`
- **Context:** `cleanupSpuriousMirrorPlans()` already acknowledges watcher-created duplicate rows, but it only targets `brain_*.md` and `ingested_*.md` mirrors. The live bug shows the same failure mode for ordinary local `.switchboard/plans/*.md` files, and `SessionActionLog.getRunSheets()` will keep hydrating those duplicates as long as they stay active in `plans`.
- **Logic:**
  1. Add `cleanupDuplicateLocalPlans(workspaceId)` that finds active duplicate local rows by exact `plan_file`, not by topic.
  2. Restrict the query to rows whose `source_type = 'local'`, `status = 'active'`, `plan_file` points into `.switchboard/plans/`, and `session_id LIKE 'sess_%'`.
  3. For each duplicate group, select the canonical row by `updated_at DESC`, then `created_at DESC`, then `session_id DESC`. This keeps the most recently authoritative row, which matches the observed stale-created / newer-planned duplicate pattern.
  4. Delete `plan_events` and `activity_log` rows for the stale duplicate sessions before deleting their `plans` rows so old duplicate sessions do not linger in hydrated histories.
  5. Persist once at the end if anything changed.
- **Implementation:**

```diff
--- a/src/services/KanbanDatabase.ts
+++ b/src/services/KanbanDatabase.ts
@@
     public async cleanupSpuriousMirrorPlans(workspaceId: string): Promise<number> {
         if (!(await this.ensureReady()) || !this._db) return 0;
@@
         return removed > 0 ? (await this._persist(), removed) : 0;
     }
+
+    /**
+     * Remove duplicate active local plan rows for the same .switchboard/plans/*.md file.
+     * Keeps the most recently updated row and drops stale duplicate sess_* rows plus
+     * their event/activity history so SessionActionLog DB-first hydration stops
+     * reintroducing phantom cards on refresh.
+     */
+    public async cleanupDuplicateLocalPlans(workspaceId: string): Promise<number> {
+        if (!(await this.ensureReady()) || !this._db) return 0;
+
+        const dupStmt = this._db.prepare(
+            `SELECT plan_file, COUNT(*) as cnt FROM plans
+             WHERE workspace_id = ? AND status = 'active' AND source_type = 'local'
+               AND plan_file IS NOT NULL AND plan_file != ''
+               AND plan_file LIKE '%.switchboard/plans/%.md'
+               AND session_id LIKE 'sess_%'
+             GROUP BY plan_file
+             HAVING cnt > 1`,
+            [workspaceId]
+        );
+        const duplicatePlanFiles: string[] = [];
+        try {
+            while (dupStmt.step()) {
+                duplicatePlanFiles.push(String((dupStmt.getAsObject() as any).plan_file));
+            }
+        } finally {
+            dupStmt.free();
+        }
+
+        let removed = 0;
+
+        for (const planFile of duplicatePlanFiles) {
+            const rowsStmt = this._db.prepare(
+                `SELECT session_id, updated_at, created_at FROM plans
+                 WHERE workspace_id = ? AND status = 'active' AND source_type = 'local'
+                   AND plan_file = ? AND session_id LIKE 'sess_%'
+                 ORDER BY updated_at DESC, created_at DESC, session_id DESC`,
+                [workspaceId, planFile]
+            );
+            const sessionIds: string[] = [];
+            try {
+                while (rowsStmt.step()) {
+                    sessionIds.push(String((rowsStmt.getAsObject() as any).session_id));
+                }
+            } finally {
+                rowsStmt.free();
+            }
+
+            if (sessionIds.length <= 1) {
+                continue;
+            }
+
+            const canonicalSessionId = sessionIds[0];
+            const staleSessionIds = sessionIds.slice(1);
+            for (const staleSessionId of staleSessionIds) {
+                this._db.run('DELETE FROM plan_events WHERE session_id = ?', [staleSessionId]);
+                this._db.run('DELETE FROM activity_log WHERE session_id = ?', [staleSessionId]);
+                this._db.run('DELETE FROM plans WHERE session_id = ? AND workspace_id = ?', [staleSessionId, workspaceId]);
+                removed += 1;
+                console.log(
+                    `[KanbanDatabase] Removed stale duplicate local plan session ${staleSessionId} for ${planFile}; kept ${canonicalSessionId}`
+                );
+            }
+        }
+
+        return removed > 0 ? (await this._persist(), removed) : 0;
+    }
 ```
- **Edge Cases Handled:** This cleanup is deliberately scoped away from brain/import mirrors, ignores legitimate completed/deleted history, and keys on exact `plan_file` instead of `topic` so two different plans with the same title are never merged.

#### 3. Run local duplicate cleanup before the DB-backed snapshot loop rehydrates phantom cards
##### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** `_collectAndSyncKanbanSnapshot()` currently calls `_reconcileLocalPlansFromRunSheets()` and `getRunSheets()` before any local duplicate cleanup exists. Because `SessionActionLog.getRunSheets()` is DB-first, duplicate active rows in `plans` get fed straight back into the snapshot builder.
- **Logic:**
  1. Resolve the Kanban DB and workspace ID at the top of `_collectAndSyncKanbanSnapshot()`.
  2. Call `db.cleanupDuplicateLocalPlans(workspaceId)` before `_reconcileLocalPlansFromRunSheets()` and before `getRunSheets()`.
  3. Log only when rows were actually removed.
  4. Leave the existing Antigravity cleanup and snapshot sync flow intact.
- **Implementation:**

```diff
--- a/src/services/TaskViewerProvider.ts
+++ b/src/services/TaskViewerProvider.ts
@@
     private async _collectAndSyncKanbanSnapshot(workspaceRoot: string, archiveMissing: boolean = true): Promise<any[]> {
         await this._ensureOwnershipRegistryInitialized();
         await this._ensureTombstonesLoaded(workspaceRoot);
+        const db = await this._getKanbanDb(workspaceRoot);
+        const workspaceId = this._workspaceId || await this._getOrCreateWorkspaceId(workspaceRoot);
+        if (db && workspaceId) {
+            const removed = await db.cleanupDuplicateLocalPlans(workspaceId);
+            if (removed > 0) {
+                console.log(`[TaskViewerProvider] Cleaned up ${removed} duplicate local plan row(s) before snapshot sync`);
+            }
+        }
         await this._reconcileLocalPlansFromRunSheets(workspaceRoot);
         await this._cleanupDuplicateAntigravityPlans(workspaceRoot);
         const allSheets = await this._getSessionLog(workspaceRoot).getRunSheets();
         const customAgents = await this.getCustomAgents(workspaceRoot);
         await this._syncKanbanDbFromSheetsSnapshot(workspaceRoot, allSheets, customAgents, archiveMissing);
         return allSheets;
     }
```
- **Edge Cases Handled:** Running cleanup before `getRunSheets()` prevents DB-first hydration from turning one stale duplicate row into another full snapshot cycle of duplicate cards.

### Low Complexity

#### 4. Lock the fix with a regression that exercises duplicate local rows directly
##### [CREATE] `src/test/local-plan-duplicate-regression.test.js`
- **Context:** No current regression covers duplicate active local sessions for the same `plan_file`. `plan-creation-status-regression.test.js` already validates nearby watcher and orphan behavior, but it does not seed same-file local duplicates or assert a same-file in-flight creation lock.
- **Logic:**
  1. Use the compiled `out/services/KanbanDatabase.js` module so the test can call the real cleanup method.
  2. Seed two active local rows with the same `plan_file` and different `session_id`s, with the newer row in `PLAN REVIEWED` and the stale row in `CREATED`.
  3. Seed `plan_events` and `activity_log` rows for the stale duplicate so cleanup has to remove associated history.
  4. Run `cleanupDuplicateLocalPlans(workspaceId)` and assert only the newer canonical row remains.
  5. Add source assertions proving `TaskViewerProvider.ts` now has the same-file `_planCreationInFlight` guard and that `_collectAndSyncKanbanSnapshot()` runs local duplicate cleanup before `getRunSheets()`.
- **Implementation:**

```javascript
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

const providerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'),
    'utf8'
);

async function run() {
    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-local-duplicate-'));
    const db = KanbanDatabase.forWorkspace(workspaceRoot);
    const workspaceId = 'ws-local-duplicate';

    try {
        const ready = await db.ensureReady();
        assert.strictEqual(ready, true, 'Expected kanban DB to initialize for local duplicate regression.');

        const duplicatePlanFile = '.switchboard/plans/fix_duplicate_switchboard_state_parsing_bug.md';
        const originalCreatedAt = '2026-04-12T21:24:57.683Z';

        const seeded = await db.upsertPlans([
            {
                planId: 'sess_original',
                sessionId: 'sess_original',
                topic: 'Fix Duplicate Switchboard State Parsing Bug',
                planFile: duplicatePlanFile,
                kanbanColumn: 'CREATED',
                status: 'active',
                complexity: '6',
                tags: ',backend,bugfix,',
                dependencies: '',
                workspaceId,
                createdAt: originalCreatedAt,
                updatedAt: '2026-04-12T21:24:57.786Z',
                lastAction: 'unknown',
                sourceType: 'local',
                brainSourcePath: '',
                mirrorPath: '',
                routedTo: '',
                dispatchedAgent: '',
                dispatchedIde: ''
            },
            {
                planId: 'sess_canonical',
                sessionId: 'sess_canonical',
                topic: 'Fix Duplicate Switchboard State Parsing Bug',
                planFile: duplicatePlanFile,
                kanbanColumn: 'PLAN REVIEWED',
                status: 'active',
                complexity: '6',
                tags: ',backend,bugfix,',
                dependencies: '',
                workspaceId,
                createdAt: originalCreatedAt,
                updatedAt: '2026-04-12T21:25:20.093Z',
                lastAction: '',
                sourceType: 'local',
                brainSourcePath: '',
                mirrorPath: '',
                routedTo: '',
                dispatchedAgent: '',
                dispatchedIde: ''
            }
        ]);
        assert.strictEqual(seeded, true, 'Expected duplicate local plan seed rows to upsert successfully.');

        await db.logPlanEvent('sess_original', 'workflow', 'unknown', 'start', { reason: 'stale duplicate watcher session' });
        const rawDb = db._db;
        rawDb.run(
            `INSERT INTO activity_log (timestamp, event_type, payload, correlation_id, session_id)
             VALUES (?, ?, ?, ?, ?)`,
            [
                '2026-04-12T21:24:57.800Z',
                'plan_management',
                JSON.stringify({ operation: 'duplicate_plan_created', sessionId: 'sess_original' }),
                '',
                'sess_original'
            ]
        );

        const removed = await db.cleanupDuplicateLocalPlans(workspaceId);
        assert.strictEqual(removed, 1, 'Expected exactly one stale duplicate local plan row to be removed.');

        const board = await db.getBoard(workspaceId);
        const matching = board.filter((row) => row.planFile === duplicatePlanFile);
        assert.strictEqual(matching.length, 1, 'Expected only one active row to remain for the duplicated local plan file.');
        assert.strictEqual(matching[0].sessionId, 'sess_canonical', 'Expected cleanup to keep the most recently updated local plan row.');
        assert.strictEqual(matching[0].kanbanColumn, 'PLAN REVIEWED', 'Expected cleanup to preserve the canonical row column.');

        const staleEvents = await db.getPlanEvents('sess_original');
        assert.strictEqual(staleEvents.length, 0, 'Expected stale duplicate plan events to be removed with the stale session.');

        assert.match(
            providerSource,
            /private _planCreationInFlight = new Set<string>\(\);/,
            'Expected TaskViewerProvider to track same-file in-flight plan creations.'
        );
        assert.match(
            providerSource,
            /if \(this\._pendingPlanCreations\.has\(stablePath\) \|\| this\._planCreationInFlight\.has\(stablePath\)\)/,
            'Expected _handlePlanCreation to suppress duplicate same-file creation work while another create is in flight.'
        );
        assert.match(
            providerSource,
            /this\._planCreationInFlight\.add\(stablePath\);[\s\S]*finally \{[\s\S]*this\._planCreationInFlight\.delete\(stablePath\);/s,
            'Expected _handlePlanCreation to release the same-file in-flight guard in a finally block.'
        );
        assert.match(
            providerSource,
            /await db\.cleanupDuplicateLocalPlans\(workspaceId\);[\s\S]*const allSheets = await this\._getSessionLog\(workspaceRoot\)\.getRunSheets\(\);/s,
            'Expected snapshot collection to clean duplicate local plan rows before DB-backed run-sheet hydration.'
        );

        console.log('local plan duplicate regression test passed');
    } finally {
        await KanbanDatabase.invalidateWorkspace(workspaceRoot);
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('local plan duplicate regression test failed:', error);
    process.exit(1);
});
```
- **Edge Cases Handled:** This test locks the actual invariant that was broken — one active local `plan_file`, one active row — and verifies both prevention wiring and cleanup behavior, not just a generic SQL shape.

## Verification Plan
### Automated Tests
- `npm run compile`
- `npm run compile-tests`
- `node src/test/local-plan-duplicate-regression.test.js`
- `node src/test/plan-creation-status-regression.test.js`
- **Clarification:** `npm run lint` currently fails at repo baseline because ESLint 9 cannot find an `eslint.config.*` file. Do not treat that existing repo issue as a regression from this fix.

### Manual Verification Steps
1. Reproduce the current duplicate-state case and confirm the DB no longer holds two active `sess_*` rows for `.switchboard/plans/fix_duplicate_switchboard_state_parsing_bug.md`.
2. Create a brand-new plan through the normal initiated-plan flow and verify only one active row is created for the new `plan_file`.
3. Repeat with a file creation path that exercises the watcher fallback (for example, create a new local plan file while the extension is already running) and verify the board still shows only one card.
4. Move the plan from `CREATED` to `PLAN REVIEWED` and confirm the original row transitions instead of leaving a stale `CREATED` duplicate behind.
5. Refresh or restart the extension and confirm the duplicate does not reappear after `SessionActionLog.getRunSheets()` rehydrates from the DB.

## Preserved Original Draft (Verbatim)
```markdown
# Fix Plan Appearing in Multiple Columns Bug

## Goal

Fix the critical bug where the same plan appears simultaneously in multiple Kanban columns (e.g., both NEW and PLANNED). Each plan should exist in exactly one column at any given time.

## Problem Description

The plan "Fix Duplicate Switchboard State Parsing Bug" is visibly rendered in both the NEW column and the PLANNED column simultaneously. This indicates:
1. The Kanban database has duplicate entries for the same plan, OR
2. The ingestion logic is creating multiple records for the same file, OR
3. The query logic for different columns is returning overlapping results, OR
4. A race condition between file watcher and manual column moves is creating inconsistency

## Metadata
**Tags:** backend, kanban, database, bugfix
**Complexity:** 5
**Priority:** critical

## Root Cause Analysis (COMPLETED)

### Primary Issue: `kanban_column` NOT Updated During Upsert Conflicts

**Location:** `src/services/KanbanDatabase.ts` lines 150-176

The `UPSERT_PLAN_SQL` has a critical omission:

```sql
ON CONFLICT(plan_id) DO UPDATE SET
    session_id = excluded.session_id,
    topic = excluded.topic,
    plan_file = excluded.plan_file,
    complexity = excluded.complexity,
    tags = excluded.tags,
    dependencies = excluded.dependencies,
    workspace_id = excluded.workspace_id,
    updated_at = excluded.updated_at,
    last_action = excluded.last_action,
    source_type = excluded.source_type,
    brain_source_path = excluded.brain_source_path,
    mirror_path = excluded.mirror_path,
    routed_to = excluded.routed_to,
    dispatched_agent = excluded.dispatched_agent,
    dispatched_ide = excluded.dispatched_ide,
    pipeline_id = excluded.pipeline_id,
    is_internal = excluded.is_internal,
    clickup_task_id = excluded.clickup_task_id
    -- MISSING: kanban_column and status are NOT updated!
```

**Impact:** When `PlanFileImporter` re-ingests a plan file with a new `kanban_column` value (e.g., after moving from CREATED to PLANNED), the upsert inserts the new value but the conflict resolution **does not update the column**. The database retains the stale value.

### Secondary Issue: Multiple Database Records for Same File

**Location:** `src/services/PlanFileImporter.ts` lines 100-101

```typescript
const planId = extractEmbeddedMetadata(content, 'Plan ID') || defaultSessionId;
```

The `planId` falls back to `defaultSessionId` (a hash of the file path) when no `**Plan ID:**` metadata exists. This creates two possible scenarios for duplicates:
1. A plan was initially imported without metadata (uses path hash), then later has metadata added (uses explicit ID) → two records
2. Path normalization differences between platforms could cause hash mismatches

### Query Analysis

`KanbanDatabase.getBoard()` (lines 785-794) returns ALL active plans:
```sql
SELECT ... FROM plans 
WHERE workspace_id = ? AND status = 'active' AND COALESCE(is_internal, 0) = 0
```

This query returns **all active records regardless of column**. If duplicate records exist with different `kanban_column` values, the same logical plan appears in multiple columns.

## Investigation Findings Summary

| Finding | Location | Impact |
|---------|----------|--------|
| `kanban_column` missing from upsert conflict resolution | `KanbanDatabase.ts:150-176` | Column changes via file edits don't persist to database |
| `status` also missing from upsert conflict resolution | `KanbanDatabase.ts:150-176` | Status transitions during import may not update |
| `planId` extraction uses fallback hash | `PlanFileImporter.ts:100` | Potential for duplicate records if metadata added later |
| `sessionId` has different fallback logic | `PlanFileImporter.ts:101` | May diverge from `planId` causing unique constraint issues |

## Proposed Changes

### Fix 1: Add Missing Columns to Upsert Conflict Resolution
**File:** `src/services/KanbanDatabase.ts`

Update `UPSERT_PLAN_SQL` to include `kanban_column` and `status`:

```sql
ON CONFLICT(plan_id) DO UPDATE SET
    session_id = excluded.session_id,
    topic = excluded.topic,
    plan_file = excluded.plan_file,
    kanban_column = excluded.kanban_column,  -- ADD
    status = excluded.status,                  -- ADD
    complexity = excluded.complexity,
    tags = excluded.tags,
    dependencies = excluded.dependencies,
    workspace_id = excluded.workspace_id,
    updated_at = excluded.updated_at,
    last_action = excluded.last_action,
    source_type = excluded.source_type,
    brain_source_path = excluded.brain_source_path,
    mirror_path = excluded.mirror_path,
    routed_to = excluded.routed_to,
    dispatched_agent = excluded.dispatched_agent,
    dispatched_ide = excluded.dispatched_ide,
    pipeline_id = excluded.pipeline_id,
    is_internal = excluded.is_internal,
    clickup_task_id = excluded.clickup_task_id
```

### Fix 2: Deduplicate Existing Records
**File:** `src/services/KanbanDatabase.ts`

Add a migration or cleanup function to merge duplicate records:
- Find records with the same `topic` and `plan_file`
- Keep the most recent `updated_at` record
- Delete duplicates
- Update the surviving record to the correct `kanban_column`

### Fix 3: Prevent Future Duplicates (Optional)
**File:** `src/services/PlanFileImporter.ts`

Consider making `planId` generation more deterministic:
- Always use file path hash as the canonical ID (ignore embedded metadata for ID)
- Use embedded metadata only for display/reference purposes
- Or: validate that embedded `Plan ID` matches the file path hash to detect mismatches

## Verification Plan

### Immediate Test
1. Query database for duplicate topic names
2. If found, manually delete duplicates and verify board renders correctly
3. Monitor if duplicates reappear after file edits or moves

### Regression Test
1. Create a test plan
2. Move it between columns multiple times
3. Verify at each step that it appears in exactly one column
4. Check database has exactly one record per plan at all times

## Success Criteria

- No plan appears in more than one Kanban column simultaneously
- Database maintains exactly one active record per plan file
- Moving plans between columns is atomic and consistent

## References

- Observed bug: "Fix Duplicate Switchboard State Parsing Bug" plan visible in both NEW and PLANNED columns
- Related systems: `KanbanDatabase.ts`, `PlanFileImporter.ts`, Kanban UI queries

## Switchboard State

**Kanban Column:** CREATED
**Status:** active
```

## Switchboard State

**Kanban Column:** PLAN REVIEWED
**Status:** active

---

## Verification Results (2026-04-13)

### Automated Tests
- `npm run compile` - **PASSED**
- `npm run compile-tests` - **PASSED**
- `node src/test/local-plan-duplicate-regression.test.js` - **PASSED**
- `node src/test/plan-creation-status-regression.test.js` - **PASSED**

### Files Changed
1. `src/services/TaskViewerProvider.ts`:
   - Added `_planCreationInFlight` Set for same-file mutex (line 174)
   - Modified `_handlePlanCreation()` to check and set in-flight guard (lines 7640-7645, 7776-7778)
   - Modified `_collectAndSyncKanbanSnapshot()` to call cleanup before getRunSheets (lines 1210-1217)

2. `src/services/KanbanDatabase.ts`:
   - Added `cleanupDuplicateLocalPlans()` method (lines 1272-1337)

3. `src/test/local-plan-duplicate-regression.test.js`:
   - Created regression test (new file)

### Remaining Risks
- The fix relies on the `_planCreationInFlight` guard being set before any async operations in `_handlePlanCreation()`. If a different code path creates local plans without going through this method, duplicates could still occur.
- Manual column moves via `updateColumn()` are not affected by this fix (by design, per the plan requirements).

## Direct Reviewer Pass (2026-04-12)

### Stage 1 - Grumpy Principal Engineer
- [MAJOR] The production fix finally locks the one-file/one-active-row invariant, but the shiny new regression was faking part of its testimony. It tried to seed `appendPlanEvent()` with an object payload into an API that persists strings, so the test's speech about deleting stale `plan_events` was only half true.
- [NIT] The duplicate circus is much better fenced now, but the invariant still depends on every local plan creation path marching through the same mutex/snapshot-cleanup corridor. One rogue future code path can still try to reopen the tent.

### Stage 2 - Balanced Synthesis
- **Keep:** `_planCreationInFlight`, `cleanupDuplicateLocalPlans()`, and the pre-hydration cleanup call are the right production fix and match the plan's actual diagnosis.
- **Fix now:** Correct the regression fixture so stale `plan_events` are seeded with the payload shape the real API stores, which makes the cleanup proof honest instead of theatrical.
- **Defer:** If stale local session files on disk become operational noise, add filesystem-level cleanup separately; it is not required for the DB-first board fix delivered here.

### Fixed Items
- Updated `src/test/local-plan-duplicate-regression.test.js` to serialize the seeded stale `appendPlanEvent()` payload so the test now exercises `plan_events` cleanup instead of logging a bind warning.

### Files Changed
- `src/test/local-plan-duplicate-regression.test.js`

### Validation Results
- `npm run compile` - **PASSED**
- `node src/test/local-plan-duplicate-regression.test.js` - **PASSED**
- `node src/test/plan-creation-status-regression.test.js` - **PASSED**

### Remaining Risks
- The invariant still relies on `_handlePlanCreation()` and snapshot cleanup remaining the only local plan creation paths.
- Stale duplicate session files on disk are not scrubbed here, although DB-first hydration now prevents them from reappearing as active board rows.
