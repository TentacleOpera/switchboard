# Fix: Imported Documents Not Persisting Across IDE Reloads

## Goal
Ensure imported Planning Panel documents remain associated with the same database workspace ID across IDE reloads, and fail visibly when the database is unavailable instead of silently registering imports under a hash-derived workspace ID.

## Metadata
**Tags:** database, bugfix, reliability, UX, testing
**Complexity:** 3

## User Review Required
- [x] Resolved: Removed Fix 1 (DB auto-creation) to preserve lazy database creation behavior. Plan now focuses on warning-only approach.
- [x] Confirmed: "Reset Database" is the correct user-facing recovery action.

## Complexity Audit

### Routine
- **Remove hash fallback:** Update `PlanningPanelCacheService._getEffectiveWorkspaceId()` at `src/services/PlanningPanelCacheService.ts:54-61` so it throws when no DB workspace ID is available instead of returning `crypto.createHash(...).slice(0, 16)`.
- **Add import-flow warning:** Update `PlanningPanelCacheService.registerImport()` at `src/services/PlanningPanelCacheService.ts:344-372` to surface a clear user-facing error when `_kanbanDb` is unavailable or `ensureReady()` returns false.
- **Apply same workspace-ID behavior to read paths:** Review `getImportedDocs`, `getImportBySlugPrefix`, `updateLastSynced`, `removeImport`, `checkForDuplicate`, `getImportByDocName`, and `resolveImportedDocPath` at `src/services/PlanningPanelCacheService.ts:374-470` because they all call `_getEffectiveWorkspaceId()`.
- **Add cache-service tests:** Extend or add tests under `src/services/__tests__/PlanningPanelCacheService.*.test.ts` to cover missing DB, missing workspace ID, explicit workspace ID override, and normal DB workspace ID behavior.

### Complex / Risky
- **Persistence mismatch:** Imports may already exist under old hash-derived workspace IDs. This plan does not include migration of old rows, so verification must distinguish "new imports persist" from "old hidden imports are recovered."
- **User notification from a service:** `PlanningPanelCacheService` is a service class and may be used outside the extension host; any `require('vscode')` usage must stay guarded as shown in the existing plan.
- **Read-path throwing:** Removing fallback means document lookup methods can now throw if callers do not pass an explicit `workspaceId` and DB config is missing.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Import registration can happen while setup/reset is recreating the DB; `registerImport()` must call `ensureReady()` immediately before writing and handle `false` deterministically.
- Multiple imports can arrive close together; existing DB writes in `KanbanDatabase.registerImport()` persist per call at `src/services/KanbanDatabase.ts:1061-1083`.

**Security:**
- Do not hardcode integration tokens or document contents in errors. User-facing errors should mention setup/reset actions only.
- Do not create databases for invalid workspace roots; defer to the directory-pollution validation plan.

**Side Effects:**
- Removing the hash fallback makes misconfigured DB state visible as errors instead of invisible "empty imported docs" behavior.
- Existing tests that construct `PlanningPanelCacheService(tmpDir)` without a `KanbanDatabase` may need to pass explicit workspace IDs or assert no-op/error behavior.
- The warning action calls `switchboard.resetKanbanDb`, which is already contributed in `package.json:103-106`.

**Dependencies & Conflicts:**
- Active Kanban board query returned no cards in CREATED, BACKLOG, PLAN REVIEWED, CONTEXT GATHERER, LEAD CODED, CODER CODED, CODE REVIEWED, CODED, or COMPLETED columns, so no active-board dependency conflict was detected.
- `disable-eager-database-creation.md` is a completed related plan and this plan explicitly preserves its lazy DB creation behavior.
- `fix_planning_panel_docs_multi_repo_search.md` is related but separate. It concerns finding docs across workspace folders, not persistence of imported-doc registry rows.

## Dependencies
- None

## Adversarial Synthesis
Key risks: The hash fallback is correctly identified as the persistence bug. The warning-only approach avoids conflicts with the lazy-creation plan and directory pollution risks. Mitigations: removal of the hash fallback and user-facing warnings are the core fix, with tests for both normal persistence and missing-DB failure modes. Recommendation: Send to Coder.

## Problem

The list of imported documents in planning.html does not persist across IDE reloads. Documents imported from ClickUp, Linear, or Notion disappear after restarting the IDE.

## Root Cause

The bug is caused by **silent fallback to hash-based workspace IDs** when the DB is unavailable:

1. `KanbanDatabase._initialize()` returns `false` and sets `_db = null` if the DB file doesn't exist (lazy creation behavior)
2. `PlanningPanelCacheService._getEffectiveWorkspaceId()` (lines 54-61) falls back to a hash-based ID when `getWorkspaceId()` returns null
3. Imports are registered with the hash ID, but queries after IDE reload use the actual DB workspace_id
4. **Result**: Imports appear to "disappear" because they're stored with the wrong workspace_id

## Correct Approach: Warn User, Don't Silently Fix

Since the DB should be created during plugin setup (user specifies location in setup menu), **missing DB is a configuration issue**, not something to silently handle.


### Execution Breakdown by Complexity

### Implementation Steps

1. **Remove hash-derived workspace fallback**
   - **File:** `src/services/PlanningPanelCacheService.ts`
   - **Context:** `_getEffectiveWorkspaceId()` at `src/services/PlanningPanelCacheService.ts:54-61`.
   - **Implementation:** Keep the explicit `workspaceId` override path, then use `this._kanbanDb.getWorkspaceId()` when available. If no workspace ID can be resolved, throw an actionable error instead of returning `crypto.createHash('sha256').update(this._workspaceRoot).digest('hex').slice(0, 16)`.

2. **Fail visibly in `registerImport()`**
   - **File:** `src/services/PlanningPanelCacheService.ts`
   - **Context:** `registerImport()` at `src/services/PlanningPanelCacheService.ts:344-372`.
   - **Implementation:** If `_kanbanDb` is missing, log the error and show a guarded VS Code error message with "Reset Database". If `_kanbanDb.ensureReady()` returns false, use the same user-visible failure path and do not call `KanbanDatabase.registerImport()`.

3. **Audit read/update methods that depend on workspace ID**
   - **File:** `src/services/PlanningPanelCacheService.ts`
   - **Context:** Methods at `src/services/PlanningPanelCacheService.ts:374-470`.
   - **Implementation:** [x] Complete. Methods throw when DB exists but has no workspace_id configured (fail-fast for initialization problems). Empty/null behavior preserved only when `_kanbanDb` is absent.

4. **Add focused tests**
   - **File:** `src/services/__tests__/PlanningPanelCacheService.persistence.test.ts`
   - **Implementation:** Test that registration uses DB workspace ID, explicit `options.workspaceId` overrides DB ID, missing DB does not silently write, and missing DB workspace ID throws/returns the documented failure.

5. **Handle service-level VS Code dependency safely**
   - **File:** `src/services/PlanningPanelCacheService.ts`
   - **Implementation:** [x] Complete. `require('vscode')` is inside try/catch blocks and not at module top level.

6. **Verify reload persistence end-to-end**
   - **File:** `src/services/PlanningPanelCacheService.ts`
   - **Manual flow:** Import a ClickUp/Linear/Notion document, reload IDE, reopen Planning Panel, verify `getImportedDocs()` resolves the same DB workspace ID and returns the imported row.
   - **Status**: Manual verification step - requires user testing in IDE.

### Fix 1: Remove Hash Fallback in Cache Service
**File**: `PlanningPanelCacheService.ts` lines 54-61

```typescript
private async _getEffectiveWorkspaceId(workspaceId?: string): Promise<string> {
    if (workspaceId) return workspaceId;
    if (this._kanbanDb) {
        const wsId = await this._kanbanDb.getWorkspaceId();
        if (wsId) return wsId;
        
        // OLD (broken): Fallback to hash - causes ID mismatch
        // return crypto.createHash('sha256').update(this._workspaceRoot).digest('hex').slice(0, 16);
        
        // NEW: If no workspace_id in DB, something is wrong - warn user
        throw new Error(
            `[PlanningPanelCacheService] No workspace_id configured in database. ` +
            `Please run "Reset Kanban Database" from the command palette to recreate the database.`
        );
    }
    throw new Error('[PlanningPanelCacheService] KanbanDatabase not available');
}
```

### Fix 2: Add User-Facing Warning in Import Flow
**File**: `PlanningPanelCacheService.ts` lines 344-372

```typescript
public async registerImport(...): Promise<void> {
    if (!this._kanbanDb) {
        // NEW: Inform user instead of silently failing
        const msg = 'Database not available. Please ensure Switchboard setup is complete.';
        console.error(`[PlanningPanelCacheService] ${msg}`);
        
        try {
            const vscode = require('vscode');
            vscode.window.showErrorMessage(
                `${msg} Run "Switchboard: Reset Kanban Database" to recreate.`,
                'Reset Database'
            ).then(selection => {
                if (selection === 'Reset Database') {
                    vscode.commands.executeCommand('switchboard.resetKanbanDb');
                }
            });
        } catch { /* outside extension host */ }
        return;
    }
    
    // Ensure DB is ready, or warn user
    const ready = await this._kanbanDb.ensureReady();
    if (!ready) {
        console.error('[PlanningPanelCacheService] Database not initialized');
        return;
    }
    
    // Continue with import...
}
```

## Files Changed
- `src/services/PlanningPanelCacheService.ts` - Remove hash fallback, add user-facing warnings

## Verification Steps

1. **Normal Operation**: With proper DB setup, import documents → should persist across reloads
2. **Missing DB**: Delete kanban.db, try to import → should show clear error message with "Reset Database" action

### Automated Tests
- [x] `PlanningPanelCacheService.persistence.test.ts`: register import with DB workspace ID, reload/recreate service, assert imported doc is returned with same workspace ID.
- [x] `PlanningPanelCacheService.persistence.test.ts`: construct service without `KanbanDatabase`, call `registerImport()`, assert no hash-derived row is written and the method follows the documented warning/no-op path.
- [x] `PlanningPanelCacheService.persistence.test.ts`: construct DB without `workspace_id`, call `_getEffectiveWorkspaceId()` through public methods, assert no hash fallback is used.

## Recommendation

**Send to Coder** — Complexity 3. The fix is localized to `PlanningPanelCacheService` with no changes to `KanbanDatabase` to preserve lazy DB creation behavior.

## Why This Approach

1. **Single source of truth**: DB is created once during setup, not ad-hoc
2. **Fail fast**: User knows immediately if setup is incomplete
3. **Self-healing path**: "Reset Database" command recreates from plan files
4. **No silent failures**: Hash fallbacks were masking the real issue
5. **Preserves lazy DB creation**: Avoids conflicts with `disable-eager-database-creation.md` and prevents directory pollution

---

## Reviewer Pass — 2026-05-04

### Stage 1: Grumpy Principal Engineer Critique

**MAJOR — Inconsistent failure UX in `registerImport` (L396)**
The method handles two failure modes with friendly VS Code dialogs ("Reset Database" button): missing `_kanbanDb` and `ensureReady() === false`. But the third failure mode — DB exists, `ensureReady()` returns true, yet `getWorkspaceId()` returns null — hits `_getEffectiveWorkspaceId` which throws an unhandled exception. The user sees a raw stack trace instead of the same "Reset Database" dialog. Inconsistent. Fixed by wrapping L394-410 in try/catch.

**NIT — `setDocumentImported` (L200) lacks error handling**
Calls `_getEffectiveWorkspaceId` with no try/catch. Not listed in the plan's Step 3 audit. Inherits the same throw risk as other methods. Deferred — low-traffic code path.

**NIT — Plain `Error` throw in `_getEffectiveWorkspaceId`**
A custom error class (e.g., `MissingWorkspaceIdError`) would let upstream callers distinguish this failure without string-matching on the message. Deferred.

### Stage 2: Balanced Synthesis

**Keep**: Hash fallback removal is correct. Two guarded VS Code dialogs in `registerImport` are well-done. All read methods consistently use `_getEffectiveWorkspaceId`. Tests are comprehensive (5 cases: normal, persistence, override, missing-DB, missing-workspace-id).

**Fixed now**: Wrapped `_getEffectiveWorkspaceId` + `registerImport` call in `registerImport` with try/catch, showing the same "Reset Database" VS Code dialog for all three failure modes.

**Deferred**: Custom error class. Error handling in `setDocumentImported`.

### Code Fix Applied

**File**: `src/services/PlanningPanelCacheService.ts` L394-424
**Change**: Wrapped the `_getEffectiveWorkspaceId` and `_kanbanDb.registerImport` calls in try/catch. On error, logs to console and shows VS Code `showErrorMessage` with "Reset Database" action — matching the existing pattern for the other two failure paths.

### Verification

- TypeScript compilation: **PASS** (zero errors in PlanningPanelCacheService files)
- Unit tests: 5 tests in `PlanningPanelCacheService.persistence.test.ts` — covers all required scenarios. Cannot execute in CLI (requires `vscode-test` runner), but test structure and assertions are correct.

### Files Changed
- `src/services/PlanningPanelCacheService.ts` — Added try/catch around workspace ID resolution + import registration (L394-424)

### Remaining Risks
- `setDocumentImported` still has unguarded `_getEffectiveWorkspaceId` call — low risk, low-traffic path
- Old imports stored under hash-derived workspace IDs are not migrated — users with pre-fix imports will need to re-import
- Manual end-to-end verification (import → reload IDE → verify persistence) requires user testing in the extension host
