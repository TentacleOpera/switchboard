# Kill the sess_ Fallback ID Generator

## Goal

Remove the `sess_${Date.now()}` fallback ID generator in `TaskViewerProvider.ts` that fabricates garbage primary keys when no Claude session ID is found. This generator is the root cause of orphan-plan bugs, duplicate-row bugs, and phantom-card reintroduction. Replace it with proper UUID generation via `crypto.randomUUID()`, which is already used elsewhere in the codebase. Also remove the two deduplication helpers in `KanbanDatabase.ts` that exist solely to clean up the orphan rows this generator creates, and add a one-time DB migration to purge existing `sess_` rows from user databases.

**Root-Cause Analysis:** When a new plan file is detected, the code reads `state.json` to get Claude's process session ID. If none is found, it fabricates `sess_${Date.now()}` and uses that fabricated ID as the `plan_id` primary key in the DB, the runsheet key, and the plan registry. Because `Date.now()` changes every millisecond, the same plan file gets a different `plan_id` on every re-detection (e.g., after IDE restart, file watcher double-fire, or debounce race). This creates duplicate DB rows with garbage primary keys. Two band-aid helpers (`cleanupSpuriousMirrorPlans` and `cleanupDuplicateLocalPlans`) were added to periodically delete `sess_%`-prefixed rows, but they treat the symptom, not the disease. The fix is to always generate a proper UUID for `plan_id` — never use a fabricated timestamp-based ID.

---

## Metadata

**Tags:** [backend, bugfix, database]
**Complexity:** 4
**Latest Migration:** V37 (as of 2026-06-23) — this plan's migration will be **V38**

---

## User Review Required

No — this is a targeted bugfix that removes a broken code path and replaces it with a well-established pattern (`crypto.randomUUID()`, already used in `KanbanProvider.ts:7003` and `PlanningPanelProvider.ts:2889`). The DB migration is additive (deletes orphan rows only) and does not alter schema.

---

## Complexity Audit

### Routine
- Replacing `sess_${Date.now()}` with `crypto.randomUUID()` — one-line change at the fabrication site
- Removing the collision-check `else` block — UUIDs don't collide, so the check is unnecessary
- Removing the two dedup helper methods from `KanbanDatabase.ts` — mechanical deletion
- Removing the three callsites that invoke the dedup helpers
- Updating the one test file that tests the dedup helper

### Complex / Risky
- **One-time DB migration to purge existing `sess_` rows** — must not delete canonical rows that happen to have `sess_`-prefixed plan_ids but are legitimately active. The dedup helpers already have logic to distinguish spurious from canonical rows; the migration must replicate that logic. However, since no new `sess_` rows will be created after this fix, the migration only needs to run once.
- **Downstream `sessionId` variable usage** — the `sessionId` local variable is used in 5 places after the fabrication site (runsheet creation, `createRunSheet` call, `_registerPlan` call, `_incrementallyRegisterPlan` call, webview message). All must be updated to use the new UUID.

---

## Edge-Case & Dependency Audit

### Race Conditions
- **File watcher double-fire**: The current code has a `_planCreationInFlight` guard (line 13161) that prevents concurrent creation for the same file path. This guard remains unchanged and still protects against double-fire. The UUID change doesn't affect this.
- **Dedup helper removal timing**: The dedup helpers are called from a 1.5s deferred timer (line 13191–13208) and from sync refresh paths (lines 2276, 2318). After removing the helpers, the timer and calls become no-ops. No race condition — the timer just won't find duplicates to clean.

### Security
- No security implications — `crypto.randomUUID()` is cryptographically secure (better than `Date.now()`).

### Side Effects
- **Existing `sess_` rows in user DBs**: After this fix, no new `sess_` rows are created, but existing ones remain. The V38 migration purges them. Users with `sess_`-prefixed plans will see those plans disappear from the kanban board (they were orphans/duplicates anyway — the canonical plan identified by `(plan_file, workspace_id)` remains).
- **Runsheet files on disk**: Existing runsheets created with `sess_` keys will become orphaned on disk (the DB row is deleted, so the runsheet won't be looked up). This is harmless — they're small JSON files in `.switchboard/runsheets/` and can be ignored. A future cleanup could delete them, but it's not required.

### Dependencies & Conflicts
- **`crypto.randomUUID()`** requires Node.js 14.17+ (or browser crypto API). VS Code extensions run on Node.js 16+ (VS Code 1.75+), so this is safe. Already used in `KanbanProvider.ts:7003` and `PlanningPanelProvider.ts:2889`.
- **Migration V38 must run after V37** — V37 is the latest verified migration. Check for any other queued migrations before assigning V38.
- **No dependency on the full sessionId eradication plan** — this fix is self-contained. The `sessionId` column and old DB methods remain untouched.

---

## Dependencies

- None — this plan is self-contained.

---

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the DB migration must correctly distinguish spurious `sess_` rows (orphan duplicates) from any legitimate rows that might have `sess_`-prefixed plan_ids — mitigated by replicating the existing dedup logic that checks for `session_id LIKE 'sess_%'` with duplicate `plan_file` entries; (2) the `sessionId` local variable is used in 5 downstream callsites that must all be updated — mitigated by the fact that all 5 are in the same function within 40 lines of each other. The fix is low-risk: it replaces a broken pattern with an established one and adds a one-time cleanup.

---

## Proposed Changes

### Step 1 — Replace the `sess_` Fabrication with UUID Generation

File: `src/services/TaskViewerProvider.ts`

Search for `sess_${Date.now()}` to find the block (approximately lines 13076–13100).

**Current code** (lines ~13066–13100):

```ts
let sessionId: string | undefined;
let activeWorkflow = 'unknown';
if (fs.existsSync(statePath)) {
    try {
        const stateContent = await fs.promises.readFile(statePath, 'utf8');
        const state = JSON.parse(stateContent);
        sessionId = state.session?.id;
        activeWorkflow = state.session?.activeWorkflow || 'unknown';
    } catch { }
}
// Fall back to anonymous session ID so orphaned plans still get a runsheet
if (!sessionId) {
    sessionId = `sess_${Date.now()}`;
} else {
    // Prevent collision/overwrite: if this session id is already bound to a different plan,
    // allocate a new plan session id.
    const existingSheet = await log.getRunSheet(sessionId);
    const existingSheetPlanFile = typeof existingSheet?.planFile === 'string'
        ? existingSheet.planFile.replace(/\\/g, '/')
        : '';
    const existingDbRow = db ? await db.getPlanBySessionId(sessionId) : null;
    const existingDbPlanFile = typeof existingDbRow?.planFile === 'string'
        ? existingDbRow.planFile.replace(/\\/g, '/')
        : '';
    const runsheetCollision = !!existingSheet && existingSheetPlanFile !== normalizedPlanFileRelative;
    const dbCollision = !!existingDbRow
        && !!existingDbPlanFile
        && existingDbPlanFile !== normalizedPlanFileRelative
        && existingDbPlanFile !== absolutePlanFile;
    if (runsheetCollision || dbCollision) {
        sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
}
```

**Replace with:**

```ts
let activeWorkflow = 'unknown';
if (fs.existsSync(statePath)) {
    try {
        const stateContent = await fs.promises.readFile(statePath, 'utf8');
        const state = JSON.parse(stateContent);
        activeWorkflow = state.session?.activeWorkflow || 'unknown';
    } catch { }
}
// Always generate a proper UUID for planId — never fabricate timestamp-based IDs.
// The Claude session ID from state.json is not a stable plan identifier (it changes
// on every Claude restart), so we don't use it as the planId regardless.
const planId = crypto.randomUUID();
```

> **Note:** The `sessionId` local variable is removed entirely. The `activeWorkflow` read from `state.json` is preserved. The collision-check `else` block is removed because UUIDs are unique by construction.

### Step 2 — Update All Downstream Usages of `sessionId` in the Same Function

File: `src/services/TaskViewerProvider.ts`

The `sessionId` variable was used in 5 places after the fabrication site. Update each to use `planId`:

**2a. Runsheet creation** (line ~13117):
```ts
// Before:
const runSheet: any = {
    sessionId,
    planFile: planFileRelative,
    ...
};

// After:
const runSheet: any = {
    sessionId: planId,  // Keep field for backward compat with existing runsheet readers
    planFile: planFileRelative,
    ...
};
```

> **Clarification:** The `sessionId` field in the runsheet object is kept for now (the full eradication plan will remove it later). The value is set to `planId` so the runsheet is keyed by the stable UUID, not a fabricated timestamp.

**2b. `createRunSheet` call** (line ~13134):
```ts
// Before:
await log.createRunSheet(sessionId, runSheet);

// After:
await log.createRunSheet(planId, runSheet);
```

**2c. `_registerPlan` call** (line ~13140):
```ts
// Before:
await this._registerPlan(resolvedWorkspaceRoot, {
    planId: sessionId,
    ...
});

// After:
await this._registerPlan(resolvedWorkspaceRoot, {
    planId,
    ...
});
```

**2d. `_incrementallyRegisterPlan` call** (line ~13156):
```ts
// Before:
await this._incrementallyRegisterPlan(resolvedWorkspaceRoot, sessionId!);

// After:
await this._incrementallyRegisterPlan(resolvedWorkspaceRoot, planId);
```

**2e. Webview `selectSession` message** (line ~13211):
```ts
// Before:
this._view?.webview.postMessage({ type: 'selectSession', sessionId });

// After:
this._view?.webview.postMessage({ type: 'selectSession', sessionId: planId });
```

> **Note:** The webview message type `selectSession` and its `sessionId` field are not renamed here — that's part of the full eradication plan. We just pass the UUID as the value.

### Step 3 — Remove the Dedup Helper Calls from TaskViewerProvider

File: `src/services/TaskViewerProvider.ts`

Remove the three callsites that invoke the dedup helpers:

**3a.** Line ~2276 — remove:
```ts
const removed = await db.cleanupDuplicateLocalPlans(workspaceId);
```

**3b.** Line ~2318 — remove:
```ts
const removed = await db.cleanupSpuriousMirrorPlans(wsId);
```

**3c.** Lines ~13191–13208 — remove the entire deferred cleanup timer block inside `_incrementallyRegisterPlan`:
```ts
// Remove this entire block:
if (this._postRegistrationCleanupTimer) {
    clearTimeout(this._postRegistrationCleanupTimer);
}
this._postRegistrationCleanupTimer = setTimeout(async () => {
    this._postRegistrationCleanupTimer = undefined;
    try {
        const db = await this._getKanbanDb(workspaceRoot);
        const wsId = await this._getWorkspaceIdForRoot(workspaceRoot);
        if (db && wsId) {
            const removed = await db.cleanupDuplicateLocalPlans(wsId);
            if (removed > 0) {
                console.log(`[TaskViewerProvider] Post-registration cleanup removed ${removed} duplicate plan row(s)`);
            }
        }
        await this._refreshRunSheets(workspaceRoot);
    } catch (e) {
        console.error('[TaskViewerProvider] Post-registration cleanup failed:', e);
    }
}, 1500);
```

Also remove the `_postRegistrationCleanupTimer` field declaration (search for `_postRegistrationCleanupTimer`).

### Step 4 — Delete the Dedup Helper Methods from KanbanDatabase

File: `src/services/KanbanDatabase.ts`

Delete these two methods entirely:

**4a.** `cleanupSpuriousMirrorPlans` (lines 3437–3591) — removes spurious mirror plan rows with `session_id LIKE 'sess_%'`. No longer needed since no new `sess_` rows are created.

**4b.** `cleanupDuplicateLocalPlans` (lines 3599–3658) — removes duplicate local plan rows with `session_id LIKE 'sess_%'`. No longer needed since no new `sess_` rows are created.

### Step 5 — Add One-Time DB Migration (V38) to Purge Existing `sess_` Rows

File: `src/services/KanbanDatabase.ts`

Add a new migration constant `MIGRATION_V38` and register it in the migration runner. The version number is **V38** (V37 is the latest verified migration as of 2026-06-23; verify before writing the constant).

The migration deletes all `sess_%`-prefixed rows from the `plans` table. These are orphan rows created by the now-removed generator. Canonical rows (brain plans with `antigravity_*` IDs, ingested plans with hash IDs, local plans with UUID IDs) are untouched.

```sql
-- Delete orphaned sess_ rows from plans.
-- These were created by the now-removed sess_${Date.now()} fallback generator.
-- Canonical rows use UUIDs, antigravity_* IDs, or plain hashes — never sess_*.
DELETE FROM plans WHERE session_id LIKE 'sess_%';

-- Clean up orphaned events for deleted sess_ rows.
DELETE FROM plan_events WHERE session_id LIKE 'sess_%';

-- Clean up orphaned activity_log entries for deleted sess_ rows.
DELETE FROM activity_log WHERE session_id LIKE 'sess_%';
```

> **Important:** This migration is destructive (deletes rows), but only targets rows with `session_id LIKE 'sess_%'` — the fabricated garbage IDs. No user-created plan has a `sess_`-prefixed session_id unless it was created by the bug. The `(plan_file, workspace_id)` unique index ensures the canonical plan for each file remains.

> **Note:** `plan_events` had its `session_id` column removed in V20 and replaced with `plan_id` FK. If the V20 migration already ran on the user's DB, the `DELETE FROM plan_events WHERE session_id LIKE 'sess_%'` statement will fail because the column doesn't exist. Wrap it in a try/catch or check for column existence before executing. Alternatively, use `plan_id LIKE 'sess_%'` since the `plan_id` was set to the same value as `session_id` when these rows were created.

### Step 6 — Update the Test File

File: `src/test/local-plan-duplicate-regression.test.js`

This test file tests `cleanupDuplicateLocalPlans` (line 92) and references the dedup call pattern (line 121). Since the method is being deleted:

- Remove or rewrite the test to verify that duplicate `sess_` rows are no longer created (i.e., test the fix, not the band-aid).
- The test should create a plan file, trigger plan creation twice, and verify that only one DB row exists with a UUID `plan_id` (not two rows with `sess_` IDs).

---

## Verification Plan

### Automated Tests
- Update `src/test/local-plan-duplicate-regression.test.js` to test the new behavior (no duplicate rows created)
- Run existing test suite to verify no regressions from the dedup helper removal

### Manual Verification
- Create a new plan file when no Claude session is active (no `state.json`)
- Verify the plan appears in the kanban board with a UUID `plan_id` (not `sess_*`)
- Restart VS Code and verify the same plan is still tracked (no duplicate row created)
- Verify existing plans with real UUIDs are unaffected by the V38 migration
- Verify `grep -r "sess_\${Date.now()}" src/` returns zero hits

---

## Order of Execution

1. Step 1 (replace fabrication with UUID) — the core fix
2. Step 2 (update downstream usages) — must be done atomically with Step 1
3. Step 3 (remove dedup calls from TaskViewerProvider) — after Steps 1–2 compile
4. Step 4 (delete dedup methods from KanbanDatabase) — after Step 3 compiles
5. Step 5 (add V38 migration) — after Step 4 compiles
6. Step 6 (update test) — last

## Completion Criteria

- `grep -r "sess_\${Date.now()}" src/` returns zero hits
- `grep -r "cleanupSpuriousMirrorPlans\|cleanupDuplicateLocalPlans" src/` returns zero hits in non-test source code
- New plans created without a Claude session get a UUID `plan_id`, not a `sess_` ID
- Restarting VS Code does not create duplicate DB rows for the same plan file
- The V38 migration successfully purges existing `sess_` rows from the database
- Extension compiles with `tsc --noEmit` with zero errors

## Recommendation

**Complexity: 4 → Send to Coder.** This is a focused bugfix with a clear before/after. The core change is ~20 lines in one function. The dedup removal and migration are mechanical. A coder can handle this; no lead-level review needed beyond the migration SQL.
