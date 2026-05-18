# Plan: PERMANENT Fix for Child Repo .switchboard Pollution Bug

## Goal
Permanently eliminate the recurring bug where `.switchboard` directories are created in child workspace repositories. This bug has returned multiple times despite previous fix attempts.

## Root Cause

The bug recurs because of an **unguarded directory creation** in extension activation:

**File:** `src/extension.ts`, line 2088
```typescript
const switchboardDir = path.join(runtimeStateRoot, '.switchboard');
try {
    if (!fs.existsSync(switchboardDir)) {
        fs.mkdirSync(switchboardDir, { recursive: true });  // ← UNGUARDED
    }
```

**Why it creates `.switchboard` in child repos:**

1. `runtimeStateRoot = resolveEffectiveStateRoot(workspaceRoot) || workspaceRoot`
2. If `resolveEffectiveStateRoot()` returns `null` (no mapping configured, or mapping check fails), it falls back to `workspaceRoot`
3. In multi-root workspaces, `workspaceRoot` can be ANY open folder - including child repos
4. The mkdir creates `.switchboard` in whatever folder is passed, with NO validation

**Why previous fixes failed:**

- Previous plans focused on:
  - Filtering roots when writing `api-server-port.txt` (TaskViewerProvider)
  - Adding validation/cleanup logic (`_validateNoSwitchboardPollution()`)
  - Updating agent skills to walk up directory tree
- **BUT** they didn't address the root cause: the mkdir in extension.ts runs during extension activation BEFORE any validation can take effect
- The fallback logic `|| workspaceRoot` means child repos get polluted whenever mapping resolution fails

## Additional Unguarded mkdir Locations

1. **KanbanDatabase.ts line 687** - `migrateIfNeeded()` has unguarded mkdir:
   ```typescript
   await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
   ```
   Comment admits: "This mkdir is unguarded (no .switchboard boundary check)"

2. **ControlPlaneMigrationService.ts lines 658-660** - Creates `.switchboard` in whatever `parentDir` is passed:
   ```typescript
   fs.promises.mkdir(path.join(parentDir, '.switchboard', 'plans'), { recursive: true }),
   fs.promises.mkdir(path.join(parentDir, '.switchboard', 'inbox'), { recursive: true }),
   fs.promises.mkdir(path.join(parentDir, '.switchboard', 'archive'), { recursive: true }),
   ```

## Solution

### 1. Add Validation Guard Before mkdir in extension.ts

Create a helper function that validates a path is allowed to have `.switchboard`:

```typescript
private static _isAllowedSwitchboardLocation(candidatePath: string, workspaceRoot: string): boolean {
    // 1. Check if candidatePath is the workspace root itself (always allowed for single-workspace)
    if (path.resolve(candidatePath) === path.resolve(workspaceRoot)) {
        return true;
    }
    
    // 2. Check if there's a workspaceDatabaseMappings configuration
    try {
        const cfg = vscode.workspace.getConfiguration('switchboard')
                         .get('workspaceDatabaseMappings') as
            { enabled?: boolean; mappings?: Array<{ workspaceFolders: string[]; parentFolder?: string }> } | undefined;
        
        if (cfg?.enabled && Array.isArray(cfg.mappings)) {
            // 3. Check if candidatePath is a configured parentFolder
            for (const mapping of cfg.mappings) {
                if (mapping.parentFolder) {
                    const resolvedParent = path.resolve(expandHome(mapping.parentFolder));
                    if (path.resolve(candidatePath) === resolvedParent) {
                        return true;
                    }
                }
            }
            
            // 4. Check if candidatePath is a mapped child workspaceFolder
            // These should NEVER have .switchboard
            for (const mapping of cfg.mappings) {
                if (Array.isArray(mapping.workspaceFolders)) {
                    for (const wf of mapping.workspaceFolders) {
                        const resolvedWf = path.resolve(expandHome(wf));
                        if (path.resolve(candidatePath) === resolvedWf) {
                            return false; // Child workspace - NOT allowed
                        }
                    }
                }
            }
        }
    } catch {
        // Outside extension host - conservative: only allow workspace root
    }
    
    // 5. Default: only allow workspace root
    return path.resolve(candidatePath) === path.resolve(workspaceRoot);
}
```

Then guard the mkdir:

```typescript
// In extension.ts line 2085
const switchboardDir = path.join(runtimeStateRoot, '.switchboard');
try {
    if (!fs.existsSync(switchboardDir)) {
        // VALIDATION: Only create .switchboard in allowed locations
        if (!this._isAllowedSwitchboardLocation(runtimeStateRoot, workspaceRoot)) {
            mcpOutputChannel?.appendLine(`[Extension] Skipping .switchboard creation in ${runtimeStateRoot} - not an allowed location (may be a child workspace)`);
            console.warn(`[Extension] Blocked .switchboard creation in child workspace: ${runtimeStateRoot}`);
        } else {
            fs.mkdirSync(switchboardDir, { recursive: true });
        }
    }
```

### 2. Guard KanbanDatabase.migrateIfNeeded() mkdir

Add the same validation before the mkdir at line 687:

```typescript
// In KanbanDatabase.migrateIfNeeded()
// Before line 687:
if (!KanbanDatabase._isAllowedSwitchboardLocation(path.dirname(targetPath), sourcePath)) {
    console.warn(`[KanbanDatabase] Blocked migration to ${targetPath} - not an allowed location`);
    return { migrated: false, skipped: 'invalid_target_location' };
}
```

Reuse the validation logic (extract to shared utility or duplicate for now).

### 3. Guard ControlPlaneMigrationService._bootstrapControlPlaneLayout()

Add validation before mkdir calls:

```typescript
// In ControlPlaneMigrationService._bootstrapControlPlaneLayout()
// Before the mkdir calls at lines 656-661:
if (!this._isAllowedControlPlaneLocation(parentDir)) {
    console.warn(`[ControlPlaneMigrationService] Blocked .switchboard bootstrap in ${parentDir} - not a valid control plane location`);
    return;
}
```

The validation should check that `parentDir` is either:
- The workspace root (single-workspace mode)
- A configured parentFolder from workspaceDatabaseMappings
- NOT a child workspaceFolder from any mapping

### 4. Add Startup Validation and Cleanup

Enhance the existing `_validateNoSwitchboardPollution()` in TaskViewerProvider to:
- Run immediately on extension activation (before any mkdir logic)
- Log warnings for any existing `.switchboard` in child repos
- Offer to clean them up (with user consent)
- Add telemetry to track how often this happens

### 5. Add Tests

Create regression test in `src/test/child-switchboard-creation-regression.test.ts`:
- Test that extension activation does NOT create `.switchboard` in mapped child repos
- Test that mkdir calls are properly guarded
- Test with various mapping configurations

## Files to Change

1. `src/extension.ts` - Add validation guard around line 2088 mkdir
2. `src/services/KanbanDatabase.ts` - Add validation guard in migrateIfNeeded() line 687
3. `src/services/ControlPlaneMigrationService.ts` - Add validation guard in _bootstrapControlPlaneLayout()
4. `src/services/TaskViewerProvider.ts` - Enhance _validateNoSwitchboardPollution() to run on startup
5. `src/test/child-switchboard-creation-regression.test.ts` - New regression test

## Validation Steps

1. Create a multi-root workspace with workspaceDatabaseMappings configured
2. Ensure child repos have NO `.switchboard` directories
3. Reload VS Code extension
4. Verify NO `.switchboard` directories appear in child repos
5. Check output channel for any blocked creation logs
6. Test with NO mapping configured (single-workspace mode) - ensure `.switchboard` still created correctly
7. Test ControlPlaneMigrationService bootstrap - ensure it only creates in parent
8. Test KanbanDatabase migration - ensure it only migrates to allowed locations

## Why This Will Work

Previous fixes were **reactive** (cleanup after pollution) or **partial** (only certain code paths). This fix is **proactive** and **comprehensive**:

- **Proactive:** Guards mkdir at the source - prevents creation before it happens
- **Comprehensive:** Guards ALL mkdir locations (extension.ts, KanbanDatabase, ControlPlaneMigrationService)
- **Validation:** Uses the same mapping logic that determines where `.switchboard` should live
- **Fallback-safe:** Default is to only allow workspace root, preventing accidental pollution
- **Observable:** Logs when blocking occurs, making the issue visible and debuggable

## Metadata

- **Tags:** bugfix, permanent-fix, regression-prevention
- **Complexity:** 5 (multi-file changes, but uses existing patterns)
- **Related Plans:** 
  - `fix_child_directory_switchboard_pollution.md` (previous attempt)
  - `Fix Child Directory .switchboard Pollution` (previous attempt)
