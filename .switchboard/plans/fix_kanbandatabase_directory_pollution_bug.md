# Fix KanbanDatabase Directory Pollution Bug

## Goal
Prevent `KanbanDatabase.forWorkspace()` and `createIfMissing()` from creating filesystem directories from invalid workspace-root strings such as ClickUp workspace IDs, while preserving intentional database creation for valid workspace roots.

## Metadata
**Tags:** database, bugfix, security, reliability, testing
**Complexity:** 7
**Repo:** switchboard

## User Review Required
- [ ] Confirm whether numeric directory names already created under the repo root (for example `9013262024/`) should be cleaned up manually after the code fix. This plan prevents future creation but does not include automatic deletion of existing directories.
- [ ] Confirm that callers should fail fast with clear errors when passed invalid workspace roots rather than silently falling back to another database.

## Complexity Audit

### Routine
- **Add workspace-root validation:** Implement a focused `isValidWorkspaceRoot()` helper in `src/services/KanbanDatabase.ts` near `forWorkspace()` (`src/services/KanbanDatabase.ts:287-369`).
- **Guard explicit creation:** Add directory-safety checks inside `createIfMissing()` before `fs.promises.mkdir(path.dirname(this._dbPath), { recursive: true })` at `src/services/KanbanDatabase.ts:670-713`.
- **Audit known call sites:** Review all current `KanbanDatabase.forWorkspace()` callers found in `src/services/*.ts` and `src/extension.ts` for invalid ID-vs-path inputs.
- **Add regression tests:** Add tests that call `KanbanDatabase.forWorkspace('9013262024')` and assert no `9013262024/.switchboard/kanban.db` directory is created.

### Complex / Risky
- **Factory behavior change:** `KanbanDatabase.forWorkspace()` currently accepts any string and caches instances by `path.resolve(workspaceRoot)` (`src/services/KanbanDatabase.ts:287-369`). Throwing for invalid roots can surface latent caller bugs in integration services.
- **Mapped database compatibility:** The fix must not reject legitimate mapped parent folders from `workspaceDatabaseMappings` or custom database paths configured via `switchboard.kanban.dbPath`.
- **Explicit creation semantics:** `createIfMissing()` is intentionally used by setup/scaffolding flows after `disable-eager-database-creation.md`; tightening directory creation must not break valid control-plane setup flows.
- **Test isolation:** Regression tests must use temporary directories and cleanup hooks so the test suite itself does not create persistent numeric directories.
- **Security boundary:** The guard must distinguish "valid workspace root path" from "valid database file path"; rejecting numeric basenames is useful but cannot be the only protection.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Two callers could call `createIfMissing()` concurrently for the same valid workspace root; preserve the existing idempotent early returns at `src/services/KanbanDatabase.ts:670-679`.
- If one caller invalidates a cached DB while another is creating it, cache updates in `_instances` and `_instancesByDbPath` must remain consistent.

**Security:**
- Primary security concern is arbitrary directory creation from non-path external identifiers. The validation must reject non-existent roots and numeric ID-like roots before any recursive `mkdir`.
- Do not rely only on `/^\d{8,}$/`; also require the resolved workspace root to already exist and be a directory before caching a database instance.

**Side Effects:**
- Some callers that previously "worked" by creating accidental directories will now throw or receive failure results.
- Setup/scaffolding flows that intentionally create a parent workspace directory must ensure the parent folder exists before calling `KanbanDatabase.forWorkspace()`.
- Existing polluted directories remain on disk until manually removed.

**Dependencies & Conflicts:**
- Active Kanban board query returned no cards in CREATED, BACKLOG, PLAN REVIEWED, CONTEXT GATHERER, LEAD CODED, CODER CODED, CODE REVIEWED, CODED, or COMPLETED columns, so no active-board dependency conflict was detected.
- `disable-eager-database-creation.md` is a completed related plan. This plan must preserve its lazy database behavior and only harden explicit creation paths.
- `fix_multi_root_plan_watcher_always_active.md` is a same-batch plan. Its proposed global watcher must pass actual filesystem roots into `KanbanDatabase.forWorkspace()`.
- `bug_20260430_kanban_shared_db_workspace_id_sync.md` is a completed related plan. Shared DB workspace IDs are database config values, not filesystem workspace roots.

## Dependencies
- None

## Adversarial Synthesis
Key risks: A naive numeric-ID guard can miss other invalid roots, while an overly strict guard can break legitimate control-plane setup and mapped database flows. Mitigations: validate existence and directory status before caching, keep custom DB path handling intact for valid roots, audit every `forWorkspace()` call site, and add regression tests that assert no numeric directories are created. Recommendation: Send to Lead Coder.

## Problem Statement

**CRITICAL BUG:** ClickUp workspace IDs (e.g., `9013262024`, `90040187192`) are being passed to `KanbanDatabase.forWorkspace()` as if they were filesystem paths. Since `createIfMissing()` uses `mkdir -p`, it **creates these directories on the filesystem**.

This causes:
- **Filesystem pollution** - directories named after ClickUp workspace IDs appearing in the project root
- **Multiple spurious kanban.db files** - each "workspace" gets its own DB
- **Data fragmentation** - plans scattered across multiple databases
- **Security risk** - arbitrary directory creation from string inputs

The bug exists because:
1. Somewhere in the codebase, ClickUp workspace IDs are being passed as `workspaceRoot` to `KanbanDatabase.forWorkspace()`
2. `forWorkspace()` does NOT validate that the path exists before creating a database instance
3. `createIfMissing()` blindly creates directories with `mkdir -p`

## Root Cause Analysis

1. **`forWorkspace()` accepts any path** @ `KanbanDatabase.ts:287-369`
   - Does not validate `workspaceRoot` exists before creating database instance
   - Caches instances for non-existent paths

2. **`createIfMissing()` blindly creates directories** @ `KanbanDatabase.ts:683`
   - `await fs.promises.mkdir(path.dirname(this._dbPath), { recursive: true })` creates entire path chain
   - No validation that parent directory should exist

3. **Callers pass invalid paths**
   - ClickUp workspace IDs (e.g., `9013262024`) passed as `workspaceRoot`
   - Test code doesn't clean up temp directories
   - Migration/scaffolding code may resolve paths incorrectly

## Critical Investigation Required

Before implementing fixes, we must find WHERE ClickUp workspace IDs are being passed as filesystem paths:

### Suspected Call Sites

1. **Sync services** - `ClickUpSyncService.ts`, `ClickUpAutomationService.ts`
2. **Multi-repo scaffolding** - `MultiRepoScaffoldingService.ts`
3. **Migration services** - `ControlPlaneMigrationService.ts`
4. **Any code that calls `KanbanDatabase.forWorkspace()` with external IDs**

### Investigation Query

Search for code that might pass ClickUp IDs as paths:
```bash
grep -r "forWorkspace" src/ --include="*.ts" -A 2 -B 2 | grep -E "(workspace|getWorkspace|workspaceId|workspace_id)"
```

## Proposed Changes

### Execution Breakdown by Complexity

#### Low Complexity Steps

1. **Add root validation helper**
   - **File:** `src/services/KanbanDatabase.ts`
   - **Context:** Place near existing static helpers after `validatePath()` (`src/services/KanbanDatabase.ts:392-419`) or immediately before `forWorkspace()` (`src/services/KanbanDatabase.ts:287`).
   - **Implementation:** Add a private static `isValidWorkspaceRoot(workspaceRoot: string): { valid: boolean; error?: string; resolved?: string }` that trims input, resolves paths, checks existence, checks `stat.isDirectory()`, and rejects basename values matching `/^\d{8,}$/`.

2. **Call validation before cache lookup**
   - **File:** `src/services/KanbanDatabase.ts`
   - **Context:** Start of `forWorkspace()` at `src/services/KanbanDatabase.ts:287-289`.
   - **Implementation:** Validate `workspaceRoot` before using it as the `_instances` cache key. Throw an `Error` with the validation message if invalid.
   - **Clarification:** This is not a new product requirement; it is the minimum guard implied by the bug statement that `forWorkspace()` must not accept arbitrary ID strings as paths.

3. **Constrain `createIfMissing()` directory creation**
   - **File:** `src/services/KanbanDatabase.ts`
   - **Context:** Before `fs.promises.mkdir(path.dirname(this._dbPath), { recursive: true })` at `src/services/KanbanDatabase.ts:681-684`.
   - **Implementation:** Compute `parentDir = path.dirname(this._dbPath)` and verify it is either the workspace `.switchboard` directory or the configured DB path's existing parent directory. Return `false` with an error message if the parent would require creating arbitrary path segments outside the validated workspace root.

4. **Add tests for invalid inputs**
   - **File:** `src/services/__tests__/KanbanDatabase.directoryPollution.test.ts`
   - **Implementation:** Use `assert.throws()` for numeric roots, non-existent roots, and file paths. Verify `fs.existsSync(path.join(process.cwd(), '9013262024'))` remains false after the attempted call.

5. **Add cleanup to tests that create temp roots**
   - **Files:** Existing tests under `src/services/__tests__/`, especially tests using `fs.promises.mkdtemp`.
   - **Reference:** `src/services/__tests__/ControlPlaneMigrationService.test.ts:7-18` already uses teardown cleanup.
   - **Implementation:** Match the teardown pattern from `ControlPlaneMigrationService.test.ts` in new tests.

#### High Complexity Steps

1. **Audit all `forWorkspace()` call sites**
   - **Files:**
     - `src/extension.ts`
     - `src/services/KanbanProvider.ts`
     - `src/services/TaskViewerProvider.ts`
     - `src/services/PlanFileImporter.ts`
     - `src/services/SessionActionLog.ts`
     - `src/services/WorkspaceIdentityService.ts`
     - `src/services/ClickUpSyncService.ts`
     - `src/services/ClickUpAutomationService.ts`
     - `src/services/LinearSyncService.ts`
     - `src/services/LinearAutomationService.ts`
     - `src/services/ControlPlaneMigrationService.ts`
     - `src/services/MultiRepoScaffoldingService.ts`
     - `src/services/PlannerPromptWriter.ts`
   - **Implementation:** For each caller, confirm the argument is a resolved filesystem root. If the value may come from an integration workspace ID, resolve it to the effective workspace root first or fail with a clear message.
   - **Risk:** The pollution bug likely originates at one of these boundaries, not inside the database class alone.

2. **Preserve mapped DB behavior**
   - **File:** `src/services/KanbanDatabase.ts`
   - **Reference:** Mapping resolution at `src/services/KanbanDatabase.ts:304-329`.
   - **Implementation:** Ensure validation checks the `workspaceRoot` path itself, not the mapped `dbPath`. A valid workspace root may map to a DB file outside the workspace via `mapping.dbPath` or `switchboard.kanban.dbPath`.
   - **Risk:** Confusing workspace-root validation with DB-path validation could break cloud-synced DB locations.

3. **Handle setup/scaffold creation order**
   - **Files:** `src/services/ControlPlaneMigrationService.ts`, `src/services/MultiRepoScaffoldingService.ts`
   - **Reference:** `ControlPlaneMigrationService.executeFreshSetup()` creates layout before `KanbanDatabase.forWorkspace(normalizedParent)` at `src/services/ControlPlaneMigrationService.ts:316-319`; `MultiRepoScaffoldingService._doScaffold()` creates `options.parentDir` before `forWorkspace()` at `src/services/MultiRepoScaffoldingService.ts:261-266`.
   - **Implementation:** Keep these flows valid by ensuring the parent directory is created before `forWorkspace()` and by testing both flows against the stricter validation.

4. **Define failure behavior for callers**
   - **Files:** All audited call sites above.
   - **Implementation:** Callers in user-facing flows should catch validation errors and surface actionable messages; background sync paths should log and skip without creating fallback DBs.
   - **Risk:** Throwing from `forWorkspace()` without call-site handling can break activation or background polling.

5. **Verify no filesystem pollution**
   - **File:** `package.json`
   - **Command:** `npm run compile-tests && npm run compile`
   - **Manual check:** After tests, inspect the repository root for numeric directories matching `/^\d{8,}$/` and verify no new `.switchboard/kanban.db` was created under such directories.

## Proposed Fixes

### Fix 1: Validate workspaceRoot in `forWorkspace()`

**File:** `src/services/KanbanDatabase.ts`
**Location:** `forWorkspace()` method, lines 287-369

Add validation at the start of `forWorkspace()`:

```typescript
public static forWorkspace(workspaceRoot: string, customDbPath?: string): KanbanDatabase {
    const stable = path.resolve(workspaceRoot);
    
    // CRITICAL: Validate workspaceRoot exists and is a directory
    if (!fs.existsSync(stable)) {
        throw new Error(`Workspace root does not exist: ${stable}`);
    }
    if (!fs.statSync(stable).isDirectory()) {
        throw new Error(`Workspace root is not a directory: ${stable}`);
    }
    
    // Check if it's a suspicious path (looks like a ClickUp ID or other ID)
    const basename = path.basename(stable);
    if (/^\d{8,}$/.test(basename)) {
        console.warn(`[KanbanDatabase] Suspicious workspace root looks like an ID: ${stable}`);
        throw new Error(`Invalid workspace root (looks like an ID): ${stable}`);
    }
    
    const existing = KanbanDatabase._instances.get(stable);
    // ... rest of method
}
```

### Fix 2: Add `createIfMissing()` validation

**File:** `src/services/KanbanDatabase.ts`
**Location:** `createIfMissing()` method, lines 670-713

Add guard before creating directories:

```typescript
public async createIfMissing(): Promise<boolean> {
    // Idempotent: already initialized
    if (this._db) {
        return true;
    }

    // If file exists, just load it normally
    if (fs.existsSync(this._dbPath)) {
        return await this.ensureReady();
    }

    // CRITICAL: Validate parent directory exists before creating DB
    const parentDir = path.dirname(this._dbPath);
    if (!fs.existsSync(parentDir)) {
        // Only create .switchboard subdirectory, not arbitrary paths
        const switchboardDir = path.join(this._workspaceRoot, '.switchboard');
        if (parentDir !== switchboardDir && !parentDir.startsWith(switchboardDir + path.sep)) {
            console.error(`[KanbanDatabase] Refusing to create database outside .switchboard: ${this._dbPath}`);
            return false;
        }
    }

    try {
        // Create parent directory (only .switchboard)
        await fs.promises.mkdir(parentDir, { recursive: true });
        // ... rest of method
```

### Fix 3: Add `isValidWorkspaceRoot()` helper

**File:** `src/services/KanbanDatabase.ts`

Add static validation method:

```typescript
private static isValidWorkspaceRoot(workspaceRoot: string): { valid: boolean; error?: string } {
    try {
        const resolved = path.resolve(workspaceRoot);
        
        if (!fs.existsSync(resolved)) {
            return { valid: false, error: `Path does not exist: ${resolved}` };
        }
        
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
            return { valid: false, error: `Path is not a directory: ${resolved}` };
        }
        
        // Reject paths that look like IDs
        const basename = path.basename(resolved);
        if (/^\d{8,}$/.test(basename)) {
            return { valid: false, error: `Path looks like an ID: ${resolved}` };
        }
        
        return { valid: true };
    } catch (e: any) {
        return { valid: false, error: e.message };
    }
}
```

### Fix 4: Audit callers of `forWorkspace()`

**Files to audit:**
- `src/extension.ts` - Check all `KanbanDatabase.forWorkspace()` calls
- `src/services/ControlPlaneMigrationService.ts` - Migration flows
- `src/services/MultiRepoScaffoldingService.ts` - Scaffolding flows
- `src/services/KanbanProvider.ts` - Provider initialization
- `src/services/TaskViewerProvider.ts` - Task viewer

For each caller, ensure:
1. Path is validated before passing to `forWorkspace()`
2. ClickUp/Linear workspace IDs are never passed as filesystem paths
3. Proper error handling exists

### Fix 5: Test cleanup

**File:** All test files using `mkdtemp`

Ensure tests clean up temp directories:

```typescript
// After tests complete
afterAll(async () => {
    if (tempDir && fs.existsSync(tempDir)) {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
});
```

## Acceptance Criteria

- [ ] `KanbanDatabase.forWorkspace()` throws error for non-existent paths
- [ ] `KanbanDatabase.forWorkspace()` throws error for paths that look like IDs (`/^/d{8,}$/`)
- [ ] `createIfMissing()` refuses to create directories outside `.switchboard/`
- [ ] All existing tests pass
- [ ] New tests verify directory pollution prevention
- [ ] No spurious directories are created during normal operation

## Files to Modify

1. `src/services/KanbanDatabase.ts` - Core validation logic
2. `src/services/ControlPlaneMigrationService.ts` - Fix migration path resolution
3. Test files - Add cleanup and validation

## Risk Assessment

**Low Risk** - These are defensive validations that prevent bad behavior. Should not affect normal operation where valid workspace roots are passed.

## Validation Plan

1. Run full test suite
2. Verify no new directories created in switchboard folder after test run
3. Manual test: Try to trigger the bug with invalid paths, confirm they're rejected

## Recommendation

**Send to Lead Coder** — Complexity 7. The core validation is straightforward, but safely changing `KanbanDatabase.forWorkspace()` requires call-site auditing, setup/scaffolding compatibility checks, and regression tests that prove the filesystem is not polluted.
