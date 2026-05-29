# Fix Kanban DB Error for Unmapped Workspaces

## Goal
Fix the extension showing "Kanban DB initialization failed" error for workspaces that are not configured in workspace mappings. Workspaces outside the mapping configuration should be skipped silently instead of showing an error.

## Metadata
- **Tags:** [bugfix, ux, reliability]
- **Complexity:** 5

## User Review Required
Yes — the fix touches startup initialization logic in both `KanbanProvider` and `TaskViewerProvider`. Verify that the proposed filtering in `initializeKanbanDbOnStartup()` and `_getAllowedRoots()` does not accidentally exclude a workspace the user intends to use with kanban.

## Problem
When workspace mappings are configured (e.g., Gitlab parent workspace with child workspaces), but a workspace is NOT included in those mappings (e.g., `patrickwork`), the extension still attempts to initialize a database for it during startup. This results in:

1. The unmapped workspace root is included in VS Code's `workspaceFolders`
2. During startup, `TaskViewerProvider.initializeKanbanDbOnStartup()` iterates ALL workspace folders and calls `_getKanbanDb()` for each
3. `KanbanProvider._getAllowedRoots()` includes ALL VS Code workspace folders, so `_resolveWorkspaceRoot()` returns the unmapped workspace
4. `KanbanProvider._resolveWorkspaceRoot()` → line 823 calls `_getKanbanDb(workspaceRoot).ensureReady()` for the unmapped workspace
5. If no `kanban.db` file exists at the workspace root (or it's 0-byte/corrupted), initialization fails
6. A warning message is shown to the user: "Kanban DB initialization failed: Database file does not exist (not auto-creating). DB-backed views may appear empty until the database is repaired or reset."

This is confusing because the user has no intention of using the kanban system for that workspace - it's simply not configured in their workspace mappings.

## Root Cause
**Primary bug**: Multiple code paths attempt DB initialization for unmapped workspaces. The original plan identified only `_getWatchFolders()`, but code tracing reveals three distinct paths:

### Path 1 — `TaskViewerProvider.initializeKanbanDbOnStartup()` (PRIMARY TRIGGER)
**File**: `src/services/TaskViewerProvider.ts`, lines 1904-1919

```typescript
public async initializeKanbanDbOnStartup(): Promise<void> {
    const workspaceRoots = this._getWorkspaceRoots();  // ALL VS Code workspace folders
    const rootsToBootstrap = new Set<string>();
    for (const workspaceRoot of workspaceRoots) {
        // ...
        rootsToBootstrap.add(this._resolveStateWorkspaceRoot(workspaceRoot) || workspaceRoot);
    }
    for (const workspaceRoot of rootsToBootstrap) {
        // ...
        const db = await this._getKanbanDb(workspaceRoot);  // ← Shows warning on failure
    }
}
```

This iterates ALL VS Code workspace folders without checking if they're in a mapping. For an unmapped workspace, `_resolveStateWorkspaceRoot()` calls `resolveEffectiveWorkspaceRoot()` which returns the workspace itself (it's not in any mapping). Then `_getKanbanDb()` (line 4558) tries to initialize the DB and shows the warning on failure.

### Path 2 — `KanbanProvider._resolveWorkspaceRoot()` → panel setup
**File**: `src/services/KanbanProvider.ts`, lines 821-823

```typescript
const workspaceRoot = this._resolveWorkspaceRoot();
if (workspaceRoot) {
    void this._getKanbanDb(workspaceRoot).ensureReady();  // ← Attempts DB init for unmapped workspace
}
```

`_resolveWorkspaceRoot()` (line 524) checks `_getAllowedRoots()` which includes ALL VS Code workspace folders (line 471: `const allowedRoots = new Set<string>(roots)`). An unmapped workspace is in `allowedRoots`, so it's returned and its DB is initialized.

### Path 3 — `KanbanProvider._getWatchFolders()` fallback (EDGE CASE)
**File**: `src/services/KanbanProvider.ts`, lines 885-888

```typescript
// Fallback: if no mappings configured, watch the current workspace root
if (folders.length === 0) {
    folders.push(workspaceRoot);
}
```

This fallback fires when `folders.length === 0`, which happens when no mappings have a valid `parentFolder`. In the typical scenario (mappings enabled with valid parentFolders), `folders.length > 0` and the fallback does NOT fire. This path is only relevant as a defense-in-depth measure for edge cases (e.g., mappings with no `parentFolder` strings).

**Note**: The original plan incorrectly identified Path 3 as the primary trigger. Path 1 is the actual primary trigger for the error message the user sees.

## Complexity Audit

### Routine
- Adding a helper method `_isWorkspaceInMapping()` to check if a workspace root appears in any mapping (parent or child)
- Filtering `rootsToBootstrap` in `initializeKanbanDbOnStartup()` before the bootstrap loop
- Filtering `allowedRoots` in `_getAllowedRoots()` to exclude unmapped workspaces when mappings are enabled
- Adjusting `_getWatchFolders()` fallback logic to distinguish "no mappings" from "mappings exist but workspace not in them"

### Complex / Risky
- `_getAllowedRoots()` is used by `_resolveWorkspaceRoot()` which is called from ~15+ places. Removing an unmapped workspace from `allowedRoots` could cause `_resolveWorkspaceRoot()` to return `null` in scenarios where it previously returned a valid root. Callers must handle `null` gracefully (most already do, but needs verification).
- `initializeKanbanDbOnStartup()` bootstraps workspace context and runs DB cleanup. Skipping an unmapped workspace here means it won't get `_activateWorkspaceContext()` called for it, which is correct (we don't want to activate context for unmapped workspaces) but should be verified that no downstream code assumes all workspace folders were activated.

## Edge-Case & Dependency Audit

- **Race Conditions**: None. The filtering happens synchronously before any async DB operations.
- **Security**: No security implications. Filtering is based on user-configured workspace mappings.
- **Side Effects**: Removing unmapped workspaces from `_getAllowedRoots()` means they won't appear in the kanban workspace picker dropdown. This is the desired behavior — if a workspace isn't mapped, it shouldn't be selectable.
- **Dependencies & Conflicts**: The `_filterMappedRoots()` method in `TaskViewerProvider` (line 677) already filters out mapped children. The new filtering should be consistent with this pattern. No conflicts with other open plans.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The original plan misdiagnosed the root cause — the error comes from `TaskViewerProvider.initializeKanbanDbOnStartup()`, not `_getWatchFolders()`. The proposed single-point fix is insufficient. (2) Filtering `_getAllowedRoots()` affects ~15 callers of `_resolveWorkspaceRoot()`, though most already handle `null` returns. Mitigations: apply filtering at three targeted entry points rather than changing `resolveEffectiveWorkspaceRoot()` (which has ~60 callers); reuse the existing `_filterMappedRoots()` pattern for consistency.

## Solution

### Proposed Changes

#### `src/services/KanbanProvider.ts` — Add `_isWorkspaceInMapping()` helper
**Location**: New private method, add near `_getWatchFolders()` (around line 891)

**Proposed code**:
```typescript
/**
 * Check if a workspace root is part of any workspace mapping (as parent or child).
 * Returns true if mappings are not enabled (conservative: assume workspace is relevant).
 */
private _isWorkspaceInMapping(workspaceRoot: string): boolean {
    try {
        const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
        const cfg = getMappingsFromIndex();
        if (!cfg?.enabled || !Array.isArray(cfg.mappings) || cfg.mappings.length === 0) {
            return true; // No mappings configured — assume workspace is relevant (preserves fallback)
        }
        const currentResolved = path.resolve(workspaceRoot);
        for (const m of cfg.mappings) {
            // Check if workspace is the parent folder
            if (typeof m.parentFolder === 'string') {
                const expanded = m.parentFolder.startsWith('~')
                    ? path.join(os.homedir(), m.parentFolder.slice(1))
                    : m.parentFolder;
                if (path.resolve(expanded) === currentResolved) return true;
            }
            // Check if workspace is a child folder
            if (Array.isArray(m.workspaceFolders)) {
                for (const wf of m.workspaceFolders) {
                    if (typeof wf === 'string') {
                        const expanded = wf.startsWith('~')
                            ? path.join(os.homedir(), wf.slice(1))
                            : wf;
                        if (path.resolve(expanded) === currentResolved) return true;
                    }
                }
            }
        }
        return false; // Workspace not found in any mapping
    } catch {
        return true; // Conservative: assume relevant if we can't check
    }
}
```

**Context**: Centralizes the "is this workspace in a mapping?" check. Returns `true` when mappings are not configured (preserving existing fallback behavior) or when the check fails (conservative). Returns `false` only when mappings ARE configured and the workspace is NOT in any of them.

#### `src/services/KanbanProvider.ts` — Filter unmapped workspaces from `_getAllowedRoots()`
**Location**: Lines 469-495 in `_getAllowedRoots()`

**Current code** (line 471):
```typescript
const allowedRoots = new Set<string>(roots);
```

**Proposed change**: After the try/catch block that adds mapped roots (line 493), add filtering:
```typescript
private _getAllowedRoots(): Set<string> {
    const roots = this._getWorkspaceRoots();
    const allowedRoots = new Set<string>(roots);
    try {
        const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
        const cfg = getMappingsFromIndex();
        if (cfg?.enabled && Array.isArray(cfg.mappings)) {
            for (const m of cfg.mappings) {
                const parent = m.parentFolder || (m as any).parentWorkspaceFolder;
                if (typeof parent === 'string') {
                    const p = parent.trim();
                    const expanded = p.startsWith('~')
                        ? path.join(os.homedir(), p.slice(1))
                        : p;
                    allowedRoots.add(path.resolve(expanded));
                }
                for (const wf of m.workspaceFolders ?? []) {
                    const expanded = wf.startsWith('~')
                        ? path.join(os.homedir(), wf.slice(1))
                        : wf;
                    allowedRoots.add(path.resolve(expanded));
                }
            }
            // NEW: Remove unmapped workspace roots when mappings are enabled
            for (const root of roots) {
                if (!this._isWorkspaceInMapping(root)) {
                    allowedRoots.delete(path.resolve(root));
                }
            }
        }
    } catch { /* fall through */ }
    return allowedRoots;
}
```

**Context**: When mappings are enabled, VS Code workspace folders that are NOT in any mapping are removed from `allowedRoots`. This prevents `_resolveWorkspaceRoot()` from returning them, which in turn prevents line 823 from attempting DB initialization.

**Edge Cases**:
- If no mappings are enabled: `_isWorkspaceInMapping()` returns `true`, no roots are removed (preserves existing behavior)
- If a workspace is both a VS Code folder AND in a mapping: it stays in `allowedRoots` (correct)
- If `allowedRoots` becomes empty after filtering: `_resolveWorkspaceRoot()` returns `null`, which is handled by callers

#### `src/services/KanbanProvider.ts` — Fix `_getWatchFolders()` fallback logic
**Location**: Lines 885-888 in `_getWatchFolders()`

**Current code**:
```typescript
// Fallback: if no mappings configured, watch the current workspace root
if (folders.length === 0) {
    folders.push(workspaceRoot);
}
```

**Proposed change**:
```typescript
// Fallback: if no mappings configured, watch the current workspace root
// If mappings exist but current workspace is not in any mapping, skip it silently
if (folders.length === 0) {
    // No mappings found any parent folders — check if mappings exist at all
    const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
    const cfg = getMappingsFromIndex();
    if (!cfg?.enabled || !Array.isArray(cfg.mappings) || cfg.mappings.length === 0) {
        // No mappings configured at all — fall back to current workspace (existing behavior)
        folders.push(workspaceRoot);
    }
    // else: mappings exist but produced no watch folders — skip silently
}
```

**Context**: This handles the edge case where mappings are configured but none have a valid `parentFolder` string. In that case, `folders.length === 0` but mappings DO exist, so the current workspace should NOT be added as a fallback.

**Logic**:
- If `folders.length === 0` AND no mappings configured: fall back to current workspace (existing behavior preserved)
- If `folders.length === 0` AND mappings exist: skip silently (new behavior — prevents watching unmapped workspace)
- If `folders.length > 0`: no change needed (already correct)

**Edge Cases**:
- The `require('./WorkspaceIdentityService')` is already used in the try/catch above (line 866), so it's safe to call again. The module is cached after first require.
- If `getMappingsFromIndex()` returns `{ enabled: false, mappings: [] }` (default when index not built yet), the fallback triggers as before — this is correct because without a built index, we can't determine mapping status.

#### `src/services/TaskViewerProvider.ts` — Filter unmapped workspaces in `initializeKanbanDbOnStartup()`
**Location**: Lines 1904-1914 in `initializeKanbanDbOnStartup()`

**Current code**:
```typescript
public async initializeKanbanDbOnStartup(): Promise<void> {
    const workspaceRoots = this._getWorkspaceRoots();
    const rootsToBootstrap = new Set<string>();
    for (const workspaceRoot of workspaceRoots) {
        try {
            await this._kanbanProvider?.ensureControlPlaneSelection(workspaceRoot);
        } catch (error) {
            console.error(`[TaskViewerProvider] Failed to resolve control plane on startup for ${workspaceRoot}:`, error);
        }
        rootsToBootstrap.add(this._resolveStateWorkspaceRoot(workspaceRoot) || workspaceRoot);
    }
```

**Proposed change**:
```typescript
public async initializeKanbanDbOnStartup(): Promise<void> {
    const workspaceRoots = this._getWorkspaceRoots();
    const rootsToBootstrap = new Set<string>();
    for (const workspaceRoot of workspaceRoots) {
        try {
            await this._kanbanProvider?.ensureControlPlaneSelection(workspaceRoot);
        } catch (error) {
            console.error(`[TaskViewerProvider] Failed to resolve control plane on startup for ${workspaceRoot}:`, error);
        }
        const effectiveRoot = this._resolveStateWorkspaceRoot(workspaceRoot) || workspaceRoot;
        // Skip workspaces not in any mapping when mappings are enabled
        if (this._kanbanProvider && !this._kanbanProvider.isWorkspaceInMapping(effectiveRoot)) {
            console.log(`[TaskViewerProvider] Skipping unmapped workspace: ${effectiveRoot}`);
            continue;
        }
        rootsToBootstrap.add(effectiveRoot);
    }
```

**Context**: This is the PRIMARY fix. Before attempting DB initialization for each workspace root, check if it's in a mapping. If mappings are enabled and the workspace is not in any mapping, skip it silently.

**Note**: This requires making `_isWorkspaceInMapping()` public on `KanbanProvider` (or adding a public wrapper). Alternatively, the check can be done inline using `getMappingsFromIndex()` directly (matching the pattern used elsewhere in `TaskViewerProvider`).

**Alternative inline implementation** (avoids adding public method to KanbanProvider):
```typescript
// Skip workspaces not in any mapping when mappings are enabled
try {
    const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
    const cfg = getMappingsFromIndex();
    if (cfg?.enabled && Array.isArray(cfg.mappings) && cfg.mappings.length > 0) {
        const resolvedRoot = path.resolve(effectiveRoot);
        const isInMapping = cfg.mappings.some((m: any) => {
            if (typeof m.parentFolder === 'string') {
                const expanded = m.parentFolder.startsWith('~')
                    ? path.join(os.homedir(), m.parentFolder.slice(1))
                    : m.parentFolder;
                if (path.resolve(expanded) === resolvedRoot) return true;
            }
            if (Array.isArray(m.workspaceFolders)) {
                for (const wf of m.workspaceFolders) {
                    if (typeof wf === 'string') {
                        const expanded = wf.startsWith('~')
                            ? path.join(os.homedir(), wf.slice(1))
                            : wf;
                        if (path.resolve(expanded) === resolvedRoot) return true;
                    }
                }
            }
            return false;
        });
        if (!isInMapping) {
            console.log(`[TaskViewerProvider] Skipping unmapped workspace: ${effectiveRoot}`);
            continue;
        }
    }
} catch { /* if check fails, proceed with bootstrap (conservative) */ }
```

**Edge Cases**:
- If `getMappingsFromIndex()` returns default (not built yet): `cfg.enabled` is `false`, so no filtering occurs — all workspaces are bootstrapped (conservative, correct)
- If the check throws: catch block allows bootstrap to proceed (conservative)
- Mapped children that resolve to a parent via `_resolveStateWorkspaceRoot()`: the parent IS in a mapping, so it passes the check (correct)

## Verification Plan

### Automated Tests
- No automated tests added (test suite to be run separately by user).

### Manual Verification
1. Configure workspace mappings for Gitlab parent workspace with child workspaces
2. Open a workspace that is NOT in the mappings (e.g., `patrickwork`)
3. Ensure no `kanban.db` file exists at the workspace root (or delete it if present)
4. Reload the VS Code window
5. Verify no "Kanban DB initialization failed" warning appears
6. Verify the kanban board still works correctly for the mapped Gitlab workspaces
7. Open a mapped workspace (e.g., one of the Gitlab child workspaces)
8. Verify the kanban board works correctly and shows plans

### Edge Case Testing
1. Test with no workspace mappings configured → verify current workspace is still watched (fallback works)
2. Test with mappings but current workspace as a parent → verify it's watched and DB initializes
3. Test with mappings but current workspace as a child → verify it's NOT watched independently (only parent is watched)
4. Test with mappings but current workspace not in any mapping → verify it's NOT watched (new behavior)
5. Test with mappings that have no `parentFolder` strings → verify no fallback to current workspace
6. Test multi-root workspace with one mapped and one unmapped folder → verify mapped works, unmapped is skipped silently

## Acceptance Criteria
- [ ] Workspaces not in workspace mappings are not added to the watch list
- [ ] No "Kanban DB initialization failed" error appears for unmapped workspaces on extension startup
- [ ] Kanban board continues to work correctly for mapped workspaces
- [ ] Fallback behavior preserved when no workspace mappings exist at all
- [ ] No regression in multi-root workspace handling
- [ ] `_getAllowedRoots()` excludes unmapped workspaces when mappings are enabled
- [ ] `initializeKanbanDbOnStartup()` skips unmapped workspaces before DB init attempts

## Recommendation
Complexity 5 → **Send to Coder**


## Worktree Context
This work was done in a git worktree.
- Worktree path: /Users/patrickvuleta/Documents/GitHub/switchboard-Fix-Kanban-DB-Error-for-Unmapped-Workspa-1780017545405
- Branch: Fix-Kanban-DB-Error-for-Unmapped-Workspa-1780017545405
- To merge: cd /Users/patrickvuleta/Documents/GitHub/switchboard-Fix-Kanban-DB-Error-for-Unmapped-Workspa-1780017545405 && git checkout main && git merge Fix-Kanban-DB-Error-for-Unmapped-Workspa-1780017545405
