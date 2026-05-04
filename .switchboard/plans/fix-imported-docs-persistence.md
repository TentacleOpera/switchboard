# Fix: Imported Documents Not Persisting Across IDE Reloads

## Goal
Ensure imported Planning Panel documents remain associated with the same database workspace ID across IDE reloads, and fail visibly when the database is unavailable instead of silently registering imports under a hash-derived workspace ID.

## Metadata
**Tags:** database, bugfix, reliability, UX, testing
**Complexity:** 6
**Repo:** switchboard

## User Review Required
- [ ] Resolve the existing plan contradiction: the section title says "Warn User, Don't Silently Fix", while Fix 1 proposes creating the DB when the path is valid. The implementation must choose the behavior already intended by the plan before coding.
- [ ] Confirm that "Reset Database" is the correct user-facing recovery action when imported document persistence fails because no workspace ID is available.

## Complexity Audit

### Routine
- **Remove hash fallback:** Update `PlanningPanelCacheService._getEffectiveWorkspaceId()` at `src/services/PlanningPanelCacheService.ts:54-61` so it throws when no DB workspace ID is available instead of returning `crypto.createHash(...).slice(0, 16)`.
- **Add import-flow warning:** Update `PlanningPanelCacheService.registerImport()` at `src/services/PlanningPanelCacheService.ts:344-372` to surface a clear user-facing error when `_kanbanDb` is unavailable or `ensureReady()` returns false.
- **Apply same workspace-ID behavior to read paths:** Review `getImportedDocs`, `getImportBySlugPrefix`, `updateLastSynced`, `removeImport`, `checkForDuplicate`, `getImportByDocName`, and `resolveImportedDocPath` at `src/services/PlanningPanelCacheService.ts:374-470` because they all call `_getEffectiveWorkspaceId()`.
- **Add cache-service tests:** Extend or add tests under `src/services/__tests__/PlanningPanelCacheService.*.test.ts` to cover missing DB, missing workspace ID, explicit workspace ID override, and normal DB workspace ID behavior.

### Complex / Risky
- **Behavior conflict with lazy DB creation:** `disable-eager-database-creation.md` intentionally changed `KanbanDatabase._initialize()` to not auto-create missing DB files. This plan's Fix 1 proposes reversing that behavior in `src/services/KanbanDatabase.ts:2164-2172`; that is a cross-plan conflict requiring explicit resolution before implementation.
- **Persistence mismatch:** Imports may already exist under old hash-derived workspace IDs. This plan does not include migration of old rows, so verification must distinguish "new imports persist" from "old hidden imports are recovered."
- **User notification from a service:** `PlanningPanelCacheService` is a service class and may be used outside the extension host; any `require('vscode')` usage must stay guarded as shown in the existing plan.
- **Read-path throwing:** Removing fallback means document lookup methods can now throw if callers do not pass an explicit `workspaceId` and DB config is missing.
- **Directory pollution interaction:** Any DB creation behavior in this plan must not reintroduce the arbitrary-directory creation bug covered by `fix_kanbandatabase_directory_pollution_bug.md`.

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
- `disable-eager-database-creation.md` is a completed related plan and directly conflicts with Fix 1 if Fix 1 auto-creates the DB from `_initialize()`.
- `fix_kanbandatabase_directory_pollution_bug.md` is a same-batch plan. Any path validation or DB creation changes here must be compatible with its `forWorkspace()` hardening.
- `fix_planning_panel_docs_multi_repo_search.md` is related but separate. It concerns finding docs across workspace folders, not persistence of imported-doc registry rows.

## Dependencies
- None

## Adversarial Synthesis
Key risks: The plan correctly identifies the hash fallback as the persistence bug, but its DB auto-creation proposal conflicts with the completed lazy-creation plan and could reintroduce directory pollution if implemented casually. Mitigations: treat removal of the hash fallback and user-facing warnings as the core fix, require explicit resolution of the Fix 1 contradiction before coding, and add tests for both normal persistence and missing-DB failure modes. Recommendation: Send to Coder.

## Problem

The list of imported documents in planning.html does not persist across IDE reloads. Documents imported from ClickUp, Linear, or Notion disappear after restarting the IDE.

## Root Cause

The bug is caused by **silent fallback to hash-based workspace IDs** when the DB is unavailable, combined with the "LAZY CHANGE" that prevents DB auto-creation:

1. `KanbanDatabase._initialize()` (lines 2164-2190) returns `false` and sets `_db = null` if the DB file doesn't exist
2. `PlanningPanelCacheService._getEffectiveWorkspaceId()` (lines 54-61) falls back to a hash-based ID when `getWorkspaceId()` returns null
3. Imports are registered with the hash ID, but queries after IDE reload use the actual DB workspace_id
4. **Result**: Imports appear to "disappear" because they're stored with the wrong workspace_id

## Correct Approach: Warn User, Don't Silently Fix

Since the DB should be created during plugin setup (user specifies location in setup menu), **missing DB is a configuration issue**, not something to silently handle.

### Fix 1: Remove "LAZY CHANGE" & Add Path Validation
**File**: `KanbanDatabase.ts` lines 2164-2190

```typescript
} else {
    // OLD (broken): Don't create the DB file - just mark as unavailable
    // this._db = null;
    // return false;
    
    // NEW: Validate path, then create DB if valid
    if (!fs.existsSync(this._workspaceRoot) || !fs.statSync(this._workspaceRoot).isDirectory()) {
        throw new Error(`[KanbanDatabase] Invalid workspace root: ${this._workspaceRoot}`);
    }
    
    // Create the DB file - it should exist after plugin setup
    this._db = new SQL.Database();
    this._db.exec(SCHEMA_SQL);
    this._runMigrations();
    await this._persist();
    console.log(`[KanbanDatabase] Created new DB at ${this._dbPath}`);
}
```

### Execution Breakdown by Complexity

#### Low Complexity Steps

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
   - **Implementation:** Ensure callers either pass `workspaceId` explicitly or handle `_getEffectiveWorkspaceId()` errors. Preserve existing empty-array/null behavior only when `_kanbanDb` itself is absent and the method already explicitly returns that shape.

4. **Add focused tests**
   - **File:** `src/services/__tests__/PlanningPanelCacheService.persistence.test.ts`
   - **Implementation:** Test that registration uses DB workspace ID, explicit `options.workspaceId` overrides DB ID, missing DB does not silently write, and missing DB workspace ID throws/returns the documented failure.

#### High Complexity Steps

1. **Resolve DB creation contradiction before coding**
   - **Files:** `src/services/KanbanDatabase.ts`, `src/services/PlanningPanelCacheService.ts`
   - **Reference:** `KanbanDatabase._initialize()` currently returns false when DB is missing at `src/services/KanbanDatabase.ts:2164-2172`; `createIfMissing()` intentionally creates only in explicit flows at `src/services/KanbanDatabase.ts:670-713`.
   - **Clarification:** This is an existing requirement conflict inside the plan, not a new requirement. Do not both "warn user, don't silently fix" and auto-create from `_initialize()` without user confirmation.

2. **Preserve lazy database semantics if chosen**
   - **File:** `src/services/KanbanDatabase.ts`
   - **Implementation:** If the intended behavior is warning rather than silent auto-creation, do not modify `_initialize()` to create missing DBs. Instead, keep missing DB as unavailable and surface the reset/setup action through `PlanningPanelCacheService`.
   - **Risk:** Reverting lazy behavior can recreate unwanted `.switchboard/kanban.db` files on reload.

3. **If Fix 1 is retained, harden path validation first**
   - **File:** `src/services/KanbanDatabase.ts`
   - **Reference:** Same validation area as `fix_kanbandatabase_directory_pollution_bug.md`.
   - **Implementation:** Only create DBs for validated existing workspace roots and safe parent directories. Do not create directories for numeric IDs or non-existent roots.
   - **Risk:** Without this ordering, the imported-docs fix can reintroduce the directory pollution bug.

4. **Handle service-level VS Code dependency safely**
   - **File:** `src/services/PlanningPanelCacheService.ts`
   - **Implementation:** Keep `require('vscode')` inside a try/catch and avoid making `vscode` a hard import at module top level, because tests and non-extension contexts instantiate this service.
   - **Risk:** A top-level VS Code import can break Node-based unit tests.

5. **Verify reload persistence end-to-end**
   - **Files:** `src/services/PlanningPanelCacheService.ts`, `src/services/KanbanDatabase.ts`
   - **Manual flow:** Import a ClickUp/Linear/Notion document, reload IDE, reopen Planning Panel, verify `getImportedDocs()` resolves the same DB workspace ID and returns the imported row.

### Fix 2: Remove Hash Fallback in Cache Service
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

### Fix 3: Add User-Facing Warning in Import Flow
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
- `src/services/KanbanDatabase.ts` - Remove "LAZY CHANGE", validate paths, allow DB creation at valid paths
- `src/services/PlanningPanelCacheService.ts` - Remove hash fallback, add user-facing warnings

## Verification Steps

1. **Normal Operation**: With proper DB setup, import documents → should persist across reloads
2. **Missing DB**: Delete kanban.db, try to import → should show clear error message with "Reset Database" action
3. **Invalid Path Protection**: Verify calling `forWorkspace()` with ClickUp ID throws instead of creating spurious directory

### Automated Tests
- [ ] `PlanningPanelCacheService.persistence.test.ts`: register import with DB workspace ID, reload/recreate service, assert imported doc is returned with same workspace ID.
- [ ] `PlanningPanelCacheService.persistence.test.ts`: construct service without `KanbanDatabase`, call `registerImport()`, assert no hash-derived row is written and the method follows the documented warning/no-op path.
- [ ] `PlanningPanelCacheService.persistence.test.ts`: construct DB without `workspace_id`, call `_getEffectiveWorkspaceId()` through public methods, assert no hash fallback is used.
- [ ] `KanbanDatabase` validation test from `fix_kanbandatabase_directory_pollution_bug.md`: invalid numeric workspace roots do not create directories.

## Recommendation

**Send to Coder** — Complexity 6. The main fix is localized to `PlanningPanelCacheService`, but the coder must resolve the documented lazy-DB contradiction before touching `KanbanDatabase._initialize()`.

## Why This Approach

1. **Single source of truth**: DB is created once during setup, not ad-hoc
2. **Fail fast**: User knows immediately if setup is incomplete
3. **Self-healing path**: "Reset Database" command recreates from plan files
4. **No silent failures**: Hash fallbacks were masking the real issue
