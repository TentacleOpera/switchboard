# Fix Kanban DB Error for Unmapped Workspaces

## Goal
Fix the extension showing "Kanban DB initialization failed" error for workspaces that are not configured in workspace mappings. Workspaces outside the mapping configuration should be skipped silently instead of showing an error.

## Metadata
- **Tags:** [bugfix, ux, reliability]
- **Complexity:** 3

## Problem
When workspace mappings are configured (e.g., Gitlab parent workspace with child workspaces), but a workspace is NOT included in those mappings (e.g., `patrickwork`), the extension still attempts to initialize a database for it during startup. This results in:

1. The workspace is added to the watch list via the fallback logic in `_getWatchFolders()`
2. During initial scan, `_getKanbanDb()` is called for this workspace
3. If a 0-byte or corrupted `kanban.db` file exists at the workspace root, initialization fails
4. A warning message is shown to the user: "Kanban DB initialization failed: Database file does not exist (not auto-creating). DB-backed views may appear empty until the database is repaired or reset."

This is confusing because the user has no intention of using the kanban system for that workspace - it's simply not configured in their workspace mappings.

## Root Cause
**Primary bug**: In `KanbanProvider._getWatchFolders()` (lines 852-891), the fallback logic at lines 885-888 unconditionally adds the current workspace root to the watch list if no folders were found from mappings:

```typescript
// Fallback: if no mappings configured, watch the current workspace root
if (folders.length === 0) {
    folders.push(workspaceRoot);
}
```

This fallback is appropriate when:
- No workspace mappings exist at all (user wants kanban for the current workspace)

But it's incorrect when:
- Workspace mappings exist but the current workspace is not part of any mapping (user explicitly does NOT want kanban for this workspace)

The code doesn't distinguish between these two cases, so it always falls back to watching the current workspace, leading to unnecessary database initialization attempts for unmapped workspaces.

## Solution

### Proposed Changes

#### `src/services/KanbanProvider.ts` — Improve `_getWatchFolders()` fallback logic
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
    // No mappings configured at all - watch current workspace
    folders.push(workspaceRoot);
} else {
    // Mappings exist - only add current workspace if it's a parent in a mapping
    const currentResolved = path.resolve(workspaceRoot);
    const isInMapping = cfg?.mappings?.some((m: any) => {
        if (!m.parentFolder) return false;
        const parentExpanded = m.parentFolder.startsWith('~')
            ? path.join(os.homedir(), m.parentFolder.slice(1))
            : m.parentFolder;
        const parentResolved = path.resolve(parentExpanded);
        return currentResolved === parentResolved;
    });
    if (isInMapping && !folders.includes(currentResolved)) {
        folders.push(currentResolved);
    }
}
```

**Context**: This ensures that workspaces outside the mapping configuration are not added to the watch list, preventing unnecessary database initialization attempts.

**Logic**:
- If `folders.length === 0` (no mappings found): fall back to current workspace (existing behavior)
- If `folders.length > 0` (mappings exist): only add current workspace if it's explicitly a parent folder in one of the mappings
- If current workspace is not in any mapping: don't add it to the watch list (new behavior - silent skip)

**Edge Cases**:
- If `cfg` is undefined or `cfg.mappings` is not an array: the existing try-catch handles this, and `folders.length === 0` will be true, triggering the fallback
- If `m.parentFolder` is undefined: the check returns false, so that mapping is skipped
- If the same parent appears in multiple mappings: `!folders.includes(currentResolved)` prevents duplicates

## Edge Cases & Dependencies

- **Backward compatibility**: Existing behavior is preserved for workspaces with no mappings configured. The change only affects the case where mappings exist but the current workspace is not in them.
- **Multi-root workspaces**: The logic uses `this._currentWorkspaceRoot` which is the currently active workspace root in multi-root setups. This is correct - we only want to watch the active workspace if it's in a mapping.
- **Child workspaces**: Child workspaces in `workspaceFolders` are already excluded from the watch list (only parent folders are added at line 873-878). This change doesn't affect that logic.
- **Dropdown workspaces**: If dropdown workspaces were still supported, they would need similar handling. However, they were deliberately removed, so this is not a concern.

## Verification Plan

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
2. Test with mappings but current workspace as a parent → verify it's watched
3. Test with mappings but current workspace as a child → verify it's NOT watched (only parent is watched)
4. Test with mappings but current workspace not in any mapping → verify it's NOT watched (new behavior)

## Acceptance Criteria
- [ ] Workspaces not in workspace mappings are not added to the watch list
- [ ] No "Kanban DB initialization failed" error appears for unmapped workspaces on extension startup
- [ ] Kanban board continues to work correctly for mapped workspaces
- [ ] Fallback behavior preserved when no workspace mappings exist at all
- [ ] No regression in multi-root workspace handling

## Recommendation
Complexity 3 → **Send to Coder**
