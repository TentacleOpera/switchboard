# Plan: Fix Kanban Plan Display Bug

## Goal
Fix critical bug where plans that exist in the Kanban database are not displaying in the Kanban board UI. If a plan record exists in the database with valid data (session_id, plan_file, kanban_column, workspace_id), it MUST appear in the Kanban board.

## Metadata
**Tags:** bug, kanban, database, ui
**Complexity:** 4

## User Review Required
None.

## Current State
- Plan file exists: `/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/plans/brain_7641dce33d0aaf20b0c0623789fe2bb1d4703171fed18f847f952b89993e604c.md`
- Database record exists with:
  - session_id: `brain_7641dce33d0aaf20b0c0623789fe2bb1d4703171fed18f847f952b89993e604c`
  - topic: `Plan: Fix Kanban Prompt Dispatch & Contextual Accuracy`
  - plan_file: `/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/plans/brain_7641dce33d0aaf20b0c0623789fe2bb1d4703171fed18f847f952b89993e604c.md`
  - kanban_column: `CREATED`
  - workspace_id: `038bffef-9842-4574-96a1-69a43a280b3c`
- **BUT**: The plan does NOT appear in the Kanban board UI

## Root Cause Identified

### Issues Found
1. **Session_id mismatch**: Database had `antigravity_7641dce33d0aaf20b0c0623789fe2bb1d4703171fed18f847f952b89993e604c` but file was named `brain_7641dce33d0aaf20b0c0623789fe2bb1d4703171fed18f847f952b89993e604c.md`
2. **Relative plan_file path**: Database had `.switchboard/plans/brain_7641dce33d0aaf20b0c0623789fe2bb1d4703171fed18f847f952b89993e604c.md` (relative) but other plans use absolute paths like `/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/plans/...`

### Why This Caused the Bug
The Kanban board uses `db.getBoard(workspaceId)` which queries:
```sql
SELECT ${PLAN_COLUMNS} FROM plans
WHERE workspace_id = ? AND status = 'active'
ORDER BY updated_at DESC
```

The query would return the plan, but the session_id mismatch prevented proper lookup by session_id elsewhere in the code. The relative path may also cause issues with file resolution.

### Architectural Problem: Why session_id and plan_file Diverge

**The fundamental issue**: The system uses two different identifiers that are generated independently through different code paths:

- **session_id**: Intended as a stable identifier that survives file moves/renames
  - Generated from embedded "Session ID" metadata
  - Or from embedded "Plan ID" metadata  
  - Or from hash of file path (for imports): `'import_' + sha256(filePath).slice(0, 16)`
  - Or from brain source path basename

- **plan_file**: The actual file path on disk
  - Can be relative or absolute
  - Changes when files are moved/renamed

**Why they diverge**: Different code paths generate session_ids differently:
- `PlanFileImporter.ts`: Hash of file path → `'import_' + hash`
- Brain creation: Uses brain source path basename
- Manual creation: Uses embedded metadata
- But filenames are just whatever the file is named (e.g., `brain_<hash>.md`)

**The design flaw**: The system assumes session_id and filename are coupled, but they're generated independently. When `getPlanBySessionId()` is called, it fails if the session_id doesn't match what's stored, even though the file exists.

**Why have both?** 
- session_id allows tracking plans across file moves/renames
- plan_file allows finding the actual file on disk
- But the coupling is fragile - if they diverge, lookups fail

**Better architecture**: Either:
1. Derive session_id deterministically from plan_file (so they can't diverge)
2. Or make lookups resilient to session_id/filename mismatches

## Fix Applied

### Manual Database Fix
```sql
-- Fixed session_id to match filename
UPDATE plans SET session_id = 'brain_7641dce33d0aaf20b0c0623789fe2bb1d4703171fed18f847f952b89993e604c'
WHERE session_id = 'antigravity_7641dce33d0aaf20b0c0623789fe2bb1d4703171fed18f847f952b89993e604c';

-- Fixed plan_file to use absolute path (consistent with other plans)
UPDATE plans SET plan_file = '/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/plans/brain_7641dce33d0aaf20b0c0623789fe2bb1d4703171fed18f847f952b89993e604c.md'
WHERE session_id = 'brain_7641dce33d0aaf20b0c0623789fe2bb1d4703171fed18f847f952b89993e604c';
```

### Verification
After fix, database record shows:
- session_id: `brain_7641dce33d0aaf20b0c0623789fe2bb1d4703171fed18f847f952b89993e604c` ✓
- plan_file: `/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/plans/brain_7641dce33d0aaf20b0c0623789fe2bb1d4703171fed18f847f952b89993e604c.md` ✓
- kanban_column: `CREATED` ✓
- workspace_id: `038bffef-9842-4574-96a1-69a43a280b3c` ✓
- status: `active` ✓

## Systemic Fix Implementation

### Root Cause
The session_id and plan_file fields can become inconsistent when plans are created or moved through different code paths. The system needs to ensure:
1. Session_id always matches the filename (without .md extension)
2. Plan_file always uses absolute paths for consistency

### Code Changes Required

#### 1. `src/services/KanbanDatabase.ts` - Add Path Normalization

**Location**: In the `UPSERT_PLAN_SQL` usage and any plan insertion methods

**Change**: Add a helper method to normalize plan_file paths and validate session_id consistency

```typescript
/**
 * Normalize plan_file to absolute path and derive session_id from filename if needed
 */
private _normalizePlanRecord(sessionId: string, planFile: string, workspaceRoot: string): { sessionId: string; planFile: string } {
    // Always use absolute path for plan_file
    let normalizedPlanFile = planFile;
    if (!path.isAbsolute(planFile)) {
        normalizedPlanFile = path.resolve(workspaceRoot, planFile);
    }

    // If session_id doesn't match filename, derive it from planFile
    const filename = path.basename(normalizedPlanFile, '.md');
    if (!sessionId || sessionId.startsWith('antigravity_') || sessionId.startsWith('brain_')) {
        // Extract hash from filename if it looks like a hash-based ID
        const hashMatch = filename.match(/[a-f0-9]{64}/);
        if (hashMatch) {
            sessionId = filename; // Use full filename as session_id
        }
    }

    return { sessionId, planFile: normalizedPlanFile };
}
```

**Apply this normalization in upsert methods**:
- `upsertPlan()` - Call `_normalizePlanRecord()` before UPSERT_PLAN_SQL
- Any other plan insertion methods

#### 2. Add Migration to Fix Existing Inconsistent Records

**Location**: Add to migration sequence in `KanbanDatabase.ts`

```typescript
const MIGRATION_V17_SQL = [
    // Fix relative paths to absolute
    `UPDATE plans SET plan_file = 
     CASE 
       WHEN plan_file LIKE '/%' THEN plan_file
       ELSE '/Users/patrickvuleta/Documents/GitHub/switchboard/' || plan_file
     END
     WHERE plan_file NOT LIKE '/%'`,
    
    // Fix session_id to match filename (for hash-based IDs)
    `UPDATE plans SET session_id = 
     substr(plan_file, instr(plan_file, '/', -1) + 1, length(plan_file) - instr(plan_file, '/', -1) - 4)
     WHERE session_id LIKE 'antigravity_%' OR session_id LIKE 'brain_%'`
];
```

**Note**: The migration needs to be workspace-aware since absolute paths differ per workspace. A better approach:

```typescript
const MIGRATION_V17_SQL = [
    // Mark records needing fix - will be fixed per-workspace during initialization
    `ALTER TABLE plans ADD COLUMN needs_path_fix INTEGER DEFAULT 0`
];

// Then add runtime fix in ensureReady() that checks workspace root and fixes paths
```

#### 3. Runtime Path Fix in `ensureReady()`

**Location**: In `KanbanDatabase.ensureReady()` after migrations

```typescript
// After running migrations, fix any relative paths for this workspace
await this._fixRelativePaths();
```

```typescript
private async _fixRelativePaths(): Promise<void> {
    if (!this._db) return;
    
    // Find plans with relative paths
    const stmt = this._db.prepare(
        `SELECT session_id, plan_file FROM plans 
         WHERE plan_file NOT LIKE '/%' AND workspace_id = ?`,
        [await this.getWorkspaceId()]
    );
    
    const toFix: Array<{sessionId: string, planFile: string}> = [];
    while (stmt.step()) {
        const row = stmt.getAsObject();
        toFix.push({
            sessionId: String(row.session_id),
            planFile: String(row.planFile)
        });
    }
    stmt.free();
    
    if (toFix.length === 0) return;
    
    // Fix each relative path to absolute
    for (const {sessionId, planFile} of toFix) {
        const absolutePath = path.resolve(this._workspaceRoot, planFile);
        this._db.run(
            'UPDATE plans SET plan_file = ? WHERE session_id = ?',
            [absolutePath, sessionId]
        );
    }
    
    await this._persist();
    console.log(`[KanbanDatabase] Fixed ${toFix.length} relative paths to absolute`);
}
```

### Implementation Steps

1. **Add `_normalizePlanRecord()` helper method** to `KanbanDatabase.ts`
2. **Update all plan upsert/insert methods** to call normalization helper
3. **Add migration V17** to flag records needing path fix
4. **Add `_fixRelativePaths()` method** and call it in `ensureReady()`
5. **Test with new plan creation** to ensure paths are absolute from now on
6. **Test migration** on existing database to verify relative paths are fixed

### Verification

1. Create a new plan and verify:
   - session_id matches filename
   - plan_file is absolute path
2. Reload Kanban board and verify all plans display correctly
3. Check database after migration to verify all plan_file paths are absolute
4. Test with different workspace roots to ensure path resolution works correctly
