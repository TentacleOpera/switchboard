# Kill the sess_ Fallback ID Generator

## Goal

Remove the `sess_${Date.now()}` fallback ID generator in `TaskViewerProvider.ts` that fabricates garbage primary keys when no Claude session ID is found. This generator is the root cause of orphan-plan bugs, duplicate-row bugs, and phantom-card reintroduction. Replace it with proper UUID generation via `crypto.randomUUID()`, which is already used elsewhere in the codebase. Also remove the `cleanupDuplicateLocalPlans` deduplication helper in `KanbanDatabase.ts` that exists solely to clean up the orphan rows this generator creates, trim the `sess_%`-specific block from `cleanupSpuriousMirrorPlans` (keeping its other data-hygiene cleanup paths), and add a one-time DB migration to purge existing `sess_` rows from user databases.

**Root-Cause Analysis:** When a new plan file is detected, the code reads `state.json` to get Claude's process session ID. If none is found, it fabricates `sess_${Date.now()}` and uses that fabricated ID as the `plan_id` primary key in the DB, the runsheet key, and the plan registry. Because `Date.now()` changes every millisecond, the same plan file gets a different `plan_id` on every re-detection (e.g., after IDE restart, file watcher double-fire, or debounce race). This creates duplicate DB rows with garbage primary keys. Two band-aid helpers (`cleanupSpuriousMirrorPlans` and `cleanupDuplicateLocalPlans`) were added to periodically delete `sess_%`-prefixed rows, but they treat the symptom, not the disease. The fix is to always generate a proper UUID for `plan_id` — never use a fabricated timestamp-based ID.

> **Clarification (from adversarial review):** The fix also removes the `else` block (lines 13079–13100) that handled the case where a REAL Claude session ID IS found. This means real session IDs are no longer used as `planId` either — every plan gets its own fresh UUID regardless of whether `state.json` has a session ID. This is correct because the Claude session ID changes on every Claude restart, making it an unstable plan identifier. The `activeWorkflow` value from `state.json` is still read and preserved.

---

## Metadata

**Tags:** [backend, bugfix, database]
**Complexity:** 5
**Latest Migration:** V37 (as of 2026-06-23) — this plan's migration will be **V38**

---

## User Review Required

No — this is a targeted bugfix that removes a broken code path and replaces it with a well-established pattern (`crypto.randomUUID()`, already used in `KanbanProvider.ts:7003` and `PlanningPanelProvider.ts:2889`). The DB migration is additive (deletes orphan rows only) and does not alter schema.

---

## Complexity Audit

### Routine
- Replacing `sess_${Date.now()}` with `crypto.randomUUID()` — one-line change at the fabrication site
- Removing the collision-check `else` block — UUIDs don't collide, so the check is unnecessary
- Removing the `cleanupDuplicateLocalPlans` method from `KanbanDatabase.ts` — mechanical deletion (this method is solely `sess_%`-focused)
- Removing the two `cleanupDuplicateLocalPlans` callsites in `TaskViewerProvider.ts`
- Trimming the `sess_%`-specific block from `cleanupSpuriousMirrorPlans` (keeping the other 3 cleanup paths)
- Updating the one test file that tests the dedup helper
- Adding the V38 migration constant and runner block

### Complex / Risky
- **One-time DB migration to purge existing `sess_` rows** — must not delete canonical rows that happen to have `sess_`-prefixed plan_ids but are legitimately active. The dedup helpers already have logic to distinguish spurious from canonical rows; the migration must replicate that logic. However, since no new `sess_` rows will be created after this fix, the migration only needs to run once.
- **`cleanupSpuriousMirrorPlans` is multi-purpose** — This method does FOUR things: (1) remove `sess_%` spurious mirror rows, (2) remove brain plans with empty `plan_file`, (3) remove rows with malformed `plan_file` paths, (4) remove rows with malformed `mirror_path`. Only (1) is `sess_`-related. The plan must preserve (2)–(4) by keeping the method and removing only the `sess_%` block, NOT deleting the entire method.
- **V38 migration SQL must use correct column names** — `plan_events` had its `session_id` column replaced with `plan_id` in V20. The migration must use `plan_id LIKE 'sess_%'` for `plan_events`, not `session_id LIKE 'sess_%'`. The `activity_log` table still has `session_id` (unchanged by any migration).
- **Downstream `sessionId` variable usage** — the `sessionId` local variable is used in 6 places after the fabrication site (runsheet creation, `createRunSheet` call, console.log, `_registerPlan` call, `_incrementallyRegisterPlan` call, and inside `_incrementallyRegisterPlan` via its parameter). All must be updated to use the new UUID.
- **`_incrementallyRegisterPlan` parameter scope** — The parameter is named `sessionId` (line 13177). It must be renamed to `planId` and both webview message lines (13211, 13216) updated accordingly.

---

## Edge-Case & Dependency Audit

### Race Conditions
- **File watcher double-fire**: The current code has a `_planCreationInFlight` guard (line 13161) that prevents concurrent creation for the same file path. This guard remains unchanged and still protects against double-fire. The UUID change doesn't affect this.
- **Dedup helper removal timing**: The `cleanupDuplicateLocalPlans` callsites are at a 1.5s deferred timer (line 13191–13208) and sync refresh paths (lines 2276, 2318). After removing the `cleanupDuplicateLocalPlans` calls, the timer and calls become no-ops. No race condition — the timer just won't find duplicates to clean. The `cleanupSpuriousMirrorPlans` callsite at line 2318 remains (for its non-`sess_` cleanup paths).

### Security
- No security implications — `crypto.randomUUID()` is cryptographically secure (better than `Date.now()`).

### Side Effects
- **Existing `sess_` rows in user DBs**: After this fix, no new `sess_` rows are created, but existing ones remain. The V38 migration purges them. Users with `sess_`-prefixed plans will see those plans disappear from the kanban board (they were orphans/duplicates anyway — the canonical plan identified by `(plan_file, workspace_id)` remains).
- **Runsheet files on disk**: Existing runsheets created with `sess_` keys will become orphaned on disk (the DB row is deleted, so the runsheet won't be looked up). This is harmless — they're small JSON files in `.switchboard/runsheets/` and can be ignored. A future cleanup could delete them, but it's not required.
- **Pre-existing latent bug in `cleanupDuplicateLocalPlans`**: Line 3647 does `DELETE FROM plan_events WHERE session_id = ?` but `plan_events` uses `plan_id` (not `session_id`) after V20. This statement throws on every invocation, but is caught by surrounding try/catch wrappers, so the event cleanup silently never runs. This further justifies removing the helper — the coder should not be surprised that the old code "worked" despite this bug.

### Dependencies & Conflicts
- **`crypto.randomUUID()`** requires Node.js 14.17+ (or browser crypto API). VS Code extensions run on Node.js 16+ (VS Code 1.75+), so this is safe. Already imported in `TaskViewerProvider.ts` at line 7 (`import * as crypto from 'crypto';`).
- **Migration V38 must run after V37** — V37 is the latest verified migration (line 4805–4808 of `KanbanDatabase.ts`). No V36/V37 migration constants exist as SQL arrays; they use dedicated `_runMigrationV36()` and `_runMigrationV37()` methods. V38 can follow either pattern.
- **No dependency on the full sessionId eradication plan** — this fix is self-contained. The `sessionId` column and old DB methods remain untouched.

---

## Dependencies

- None — this plan is self-contained.

---

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) `cleanupSpuriousMirrorPlans` does more than `sess_%` cleanup — it also removes brain plans with empty `plan_file`, malformed paths, and malformed `mirror_path`; the plan must keep these paths and remove only the `sess_%` block; (2) the V38 migration SQL must use `plan_id LIKE 'sess_%'` for `plan_events` (not `session_id`, which was removed in V20) while `activity_log` still uses `session_id`; (3) the `sessionId` variable/parameter is used in 6 places across two function scopes (`_handlePlanCreation` and `_incrementallyRegisterPlan`) that must all be updated consistently. Mitigations: keep `cleanupSpuriousMirrorPlans` with only its `sess_%` block removed; fix the migration SQL column references; rename the `_incrementallyRegisterPlan` parameter to `planId`. The fix is low-risk: it replaces a broken pattern with an established one and adds a one-time cleanup.

---

## Proposed Changes

### Step 1 — Replace the `sess_` Fabrication with UUID Generation

File: `src/services/TaskViewerProvider.ts`

Search for `sess_${Date.now()}` to find the block (approximately lines 13066–13100).

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

> **Note:** The `sessionId` local variable is removed entirely. The `activeWorkflow` read from `state.json` is preserved. The collision-check `else` block is removed because UUIDs are unique by construction. This also means real Claude session IDs are no longer used as `planId` — every plan gets its own UUID.

### Step 2 — Update All Downstream Usages of `sessionId` in the Same Function

File: `src/services/TaskViewerProvider.ts`

The `sessionId` variable was used in **6 places** after the fabrication site (not 5 as originally stated — the console.log was missed). Update each to use `planId`:

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

**2c. Console.log** (line ~13135):
```ts
// Before:
console.log(`[TaskViewerProvider] Created Run Sheet for session ${sessionId}: ${topic}`);

// After:
console.log(`[TaskViewerProvider] Created Run Sheet for session ${planId}: ${topic}`);
```

**2d. `_registerPlan` call** (line ~13140):
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

**2e. `_incrementallyRegisterPlan` call** (line ~13156):
```ts
// Before:
await this._incrementallyRegisterPlan(resolvedWorkspaceRoot, sessionId!);

// After:
await this._incrementallyRegisterPlan(resolvedWorkspaceRoot, planId);
```

> **Note:** The `!` non-null assertion is no longer needed because `planId` is always a string (from `crypto.randomUUID()`).

**2f. Rename `_incrementallyRegisterPlan` parameter and update webview messages** (lines ~13177, 13211, 13216):

The `_incrementallyRegisterPlan` function has its own `sessionId` parameter (line 13177). This is a DIFFERENT scope from the `sessionId` local variable in `_handlePlanCreation`. Rename the parameter to `planId` and update both webview message calls:

```ts
// Before (line ~13175-13178):
private async _incrementallyRegisterPlan(
    workspaceRoot: string,
    sessionId: string
): Promise<void> {

// After:
private async _incrementallyRegisterPlan(
    workspaceRoot: string,
    planId: string
): Promise<void> {
```

```ts
// Before (line ~13211):
this._view?.webview.postMessage({ type: 'selectSession', sessionId });

// After:
this._view?.webview.postMessage({ type: 'selectSession', sessionId: planId });
```

```ts
// Before (line ~13216):
this._view?.webview.postMessage({ type: 'selectSession', sessionId });

// After:
this._view?.webview.postMessage({ type: 'selectSession', sessionId: planId });
```

> **Note:** The webview message type `selectSession` and its `sessionId` field are not renamed here — that's part of the full eradication plan. We just pass the UUID as the value.

### Step 3 — Remove the Dedup Helper Calls from TaskViewerProvider

File: `src/services/TaskViewerProvider.ts`

Remove the `cleanupDuplicateLocalPlans` callsites. **Keep** the `cleanupSpuriousMirrorPlans` callsite at line 2318 (it still performs non-`sess_` cleanup).

**3a.** Line ~2276 — remove:
```ts
const removed = await db.cleanupDuplicateLocalPlans(workspaceId);
```
Also remove the surrounding `if (removed > 0) { ... }` console.log block (lines 2276–2279).

**3b.** Line ~2318 — **KEEP** this callsite. `cleanupSpuriousMirrorPlans` is retained (with only its `sess_%` block removed in Step 4a). Do NOT remove this call.

**3c.** Lines ~13188–13208 — remove the entire deferred cleanup timer block inside `_incrementallyRegisterPlan`:
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

**3d.** Remove the `_postRegistrationCleanupTimer` field declaration (line 284):
```ts
private _postRegistrationCleanupTimer: NodeJS.Timeout | undefined;      // deferred duplicate-row cleanup after watcher-triggered registrations
```

**3e.** Remove the `_postRegistrationCleanupTimer` cleanup in the `dispose()` method (lines 17894–17897):
```ts
// Remove these lines from dispose():
if (this._postRegistrationCleanupTimer) {
    clearTimeout(this._postRegistrationCleanupTimer);
    this._postRegistrationCleanupTimer = undefined;
}
```

### Step 4 — Modify the Dedup Helper Methods in KanbanDatabase

File: `src/services/KanbanDatabase.ts`

**4a. `cleanupSpuriousMirrorPlans` — PARTIAL removal (lines 3437–3591):**

This method does FOUR things. Remove ONLY the first (`sess_%` block, lines 3437–3493). Keep the other three cleanup paths:

- **REMOVE** (lines 3437–3493): The `sess_%`-prefixed spurious mirror plan cleanup (the `dupStmt` query, the `for (const planFile of dupFiles)` loop, and the `countStmt`/`DELETE` block). This is the block that queries for `session_id LIKE 'sess_%'` and deletes spurious mirror rows.
- **KEEP** (lines 3496–3523): Brain-source plans with empty `plan_file` cleanup.
- **KEEP** (lines 3525–3556): Malformed `plan_file` path cleanup.
- **KEEP** (lines 3559–3585): Malformed `mirror_path` cleanup.
- **KEEP** (lines 3587–3591): The `_persist()` call and `return removed` at the end.

> **Important:** After removing the `sess_%` block, the `removed` variable initialization (`let removed = 0;` at line 3462) and the final `if (removed > 0) { await this._persist(); } return removed;` block (lines 3587–3591) must remain. The `dupFiles` array and its population loop (lines 3441–3460) should be removed along with the `sess_%` block since they only serve that block.

**4b. `cleanupDuplicateLocalPlans` — FULL deletion (lines 3599–3658):**

Delete this method entirely. It is solely `sess_%`-focused and has a latent V20 bug (line 3647: `DELETE FROM plan_events WHERE session_id = ?` — `plan_events` uses `plan_id` after V20, so this statement throws silently). No longer needed since no new `sess_` rows are created.

### Step 5 — Add One-Time DB Migration (V38) to Purge Existing `sess_` Rows

File: `src/services/KanbanDatabase.ts`

Add a new migration step after the V37 block (line 4808). The version number is **V38** (V37 is the latest verified migration at lines 4805–4808; confirmed no V36/V37 SQL array constants exist — they use dedicated `_runMigrationV36()` and `_runMigrationV37()` methods).

The migration deletes all `sess_%`-prefixed rows from the `plans` table. These are orphan rows created by the now-removed generator. Canonical rows (brain plans with `antigravity_*` IDs, ingested plans with hash IDs, local plans with UUID IDs) are untouched.

```sql
-- Delete orphaned sess_ rows from plans.
-- These were created by the now-removed sess_${Date.now()} fallback generator.
-- Canonical rows use UUIDs, antigravity_* IDs, or plain hashes — never sess_*.
DELETE FROM plans WHERE session_id LIKE 'sess_%';

-- Clean up orphaned events for deleted sess_ rows.
-- IMPORTANT: plan_events uses plan_id (NOT session_id) after V20 migration.
-- The plan_id was set to the same value as session_id when these rows were created,
-- so we filter on plan_id LIKE 'sess_%'.
DELETE FROM plan_events WHERE plan_id LIKE 'sess_%';

-- Clean up orphaned activity_log entries for deleted sess_ rows.
-- activity_log still has session_id (unchanged by any migration).
DELETE FROM activity_log WHERE session_id LIKE 'sess_%';
```

> **Critical Fix (from adversarial review):** The original plan had `DELETE FROM plan_events WHERE session_id LIKE 'sess_%'` which would fail because `plan_events` had its `session_id` column replaced with `plan_id` in V20 (lines 395–419). The corrected SQL above uses `plan_id LIKE 'sess_%'` for `plan_events`. The `activity_log` table still has `session_id` (no migration altered it), so that statement is correct as-is.

> **Important:** This migration is destructive (deletes rows), but only targets rows with `session_id LIKE 'sess_%'` in plans and activity_log, and `plan_id LIKE 'sess_%'` in plan_events — the fabricated garbage IDs. No user-created plan has a `sess_`-prefixed session_id/plan_id unless it was created by the bug. The `(plan_file, workspace_id)` unique index ensures the canonical plan for each file remains.

> **Implementation note:** Follow the existing migration pattern — either add a `MIGRATION_V38_SQL` constant array and a `v38 < 38` check block (like V35 at lines 4778–4797), or add a dedicated `_runMigrationV38()` method (like V36/V37). Wrap in a transaction with rollback on error. Stamp version 38 on success.

### Step 6 — Update the Test File

File: `src/test/local-plan-duplicate-regression.test.js`

This test file tests `cleanupDuplicateLocalPlans` (line 92) and references the dedup call pattern (line 121). Since the method is being deleted:

- Remove or rewrite the test to verify that duplicate `sess_` rows are no longer created (i.e., test the fix, not the band-aid).
- The test should create a plan file, trigger plan creation twice, and verify that only one DB row exists with a UUID `plan_id` (not two rows with `sess_` IDs).
- Remove the regex assertion at line 121 that checks for `cleanupDuplicateLocalPlans` in the provider source.
- Keep the `_planCreationInFlight` guard assertions (lines 104–118) — those guards remain in the code.

> **Note:** The test currently requires compiled output from `out/services/KanbanDatabase.js` (line 8). If the test is rewritten to test plan creation behavior end-to-end, it may need to require `TaskViewerProvider` as well, or test the DB layer directly by verifying that `upsertPlans` with a UUID `planId` doesn't create duplicates.

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
- Verify `grep -r "cleanupDuplicateLocalPlans" src/` returns zero hits in non-test source code
- Verify `cleanupSpuriousMirrorPlans` still exists and still performs empty-plan_file, malformed-path, and malformed-mirror cleanup
- Verify the V38 migration uses `plan_id LIKE 'sess_%'` for `plan_events` (not `session_id`)

---

## Order of Execution

1. Step 1 (replace fabrication with UUID) — the core fix
2. Step 2 (update downstream usages, including `_incrementallyRegisterPlan` parameter rename) — must be done atomically with Step 1
3. Step 3 (remove `cleanupDuplicateLocalPlans` calls from TaskViewerProvider, remove timer field + dispose block) — after Steps 1–2 compile
4. Step 4 (trim `cleanupSpuriousMirrorPlans` `sess_%` block, delete `cleanupDuplicateLocalPlans` method) — after Step 3 compiles
5. Step 5 (add V38 migration) — after Step 4 compiles
6. Step 6 (update test) — last

## Completion Criteria

- `grep -r "sess_\${Date.now()}" src/` returns zero hits
- `grep -r "cleanupDuplicateLocalPlans" src/` returns zero hits in non-test source code
- `cleanupSpuriousMirrorPlans` still exists with its non-`sess_%` cleanup paths intact
- New plans created without a Claude session get a UUID `plan_id`, not a `sess_` ID
- Restarting VS Code does not create duplicate DB rows for the same plan file
- The V38 migration successfully purges existing `sess_` rows from the database
- The V38 migration uses `plan_id LIKE 'sess_%'` for `plan_events` (not `session_id`)
- Extension compiles with `tsc --noEmit` with zero errors

## Recommendation

**Complexity: 5 → Send to Coder.** The core change is ~20 lines in one function. The complexity rose from 4 to 5 due to two factors: (1) `cleanupSpuriousMirrorPlans` is multi-purpose and requires partial removal (not wholesale deletion), and (2) the V38 migration SQL required a column-name correction for `plan_events`. Both are well-scoped and documented above. A coder can handle this with the corrected instructions; no lead-level review needed beyond the migration SQL.
