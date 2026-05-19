# Fix Dropdown Workspaces Not Appearing in Kanban Dropdown

## Goal
Make dropdown workspaces (saved in setup.html) appear as selectable options in the kanban.html workspace dropdown, and ensure the mapped context is activated when a dropdown workspace is the currently-open folder.

## Metadata
- **Tags:** [bugfix, frontend]
- **Complexity:** 3

## User Review Required
- Confirm that dropdown workspaces should use the folder basename as their label (not the mapping name), since they are "independent board identities that share this database."

## Problem
Dropdown workspaces saved in setup.html do not appear as options in the kanban.html dropdown.

When a user adds a workspace path (e.g., `/Users/patrickvuleta/Documents/Gitlab/analytics-dashboard`) to the "Dropdown Workspaces" field in setup.html for a parent workspace mapping, the workspace is saved to the configuration but does not appear as a selectable option in the kanban board's workspace dropdown.

## Root Cause
The `_getWorkspaceItems` method in `src/services/KanbanProvider.ts` (lines 661-740) has two gaps:

1. **Items-building loop (lines 708-726):** Only processes the `parentFolder` from each workspace mapping when building the dropdown list. It completely ignores the `dropdownWorkspaces` array that is saved in the mapping configuration.

2. **Mapped-context guard (lines 679-706):** The `anyOpenFolderIsMapped` check only considers `parentFolder` and `workspaceFolders`. If ONLY a dropdown workspace is open (not the parent or any child), the method incorrectly falls into the "independent context" else branch (line 727) and shows standard open folders instead of mapped items.

Current code only adds parent folders:
```typescript
for (const m of mappings) {
    const parent = m.parentFolder || (m as any).parentWorkspaceFolder || (m.workspaceFolders && m.workspaceFolders[0]);
    if (parent) {
        // ... adds parent to items list
    }
}
```

The `dropdownWorkspaces` array is never iterated or added to the items list, even though it is properly saved in the configuration by setup.html.

## Complexity Audit

### Routine
- Adding a loop to process `dropdownWorkspaces` array in the items-building section
- Expanding `~` in dropdown workspace paths (same pattern as existing `parentFolder`/`workspaceFolders` expansion)
- Deduplicating dropdown workspaces against already-added paths using the existing Set
- Adding `dropdownWorkspaces` check to the `anyOpenFolderIsMapped` guard (same pattern as `workspaceFolders` check on lines 693-701)
- Renaming `addedParents` to `addedRoots` for clarity

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `_getWorkspaceItems` is synchronous and called during UI refresh.
- **Security:** No new attack surface. Paths come from VS Code settings (user-controlled configuration).
- **Side Effects:** None. The method only builds a list of `{ label, workspaceRoot }` items; it doesn't mutate state.
- **Dependencies & Conflicts:** The `WorkspaceDatabaseMapping` interface (KanbanDatabase.ts line 8-16) already defines `dropdownWorkspaces?: string[]`. `KanbanDatabase._redirectToParentIfMapped` and `KanbanDatabase.forWorkspace` already handle `dropdownWorkspaces` correctly. `TaskViewerProvider` (line 3084) also already checks `dropdownWorkspaces`. Only `_getWorkspaceItems` in `KanbanProvider.ts` is missing the check.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The `anyOpenFolderIsMapped` guard also misses `dropdownWorkspaces`, so fixing only the items loop leaves the bug partially unfixed when only a dropdown workspace is open. (2) The `addedParents` Set variable name becomes misleading when it also tracks dropdown workspaces. Mitigations: Fix both gaps in the same change; rename the variable to `addedRoots`.

## Solution
Modify the `_getWorkspaceItems` method in `src/services/KanbanProvider.ts` to (a) include `dropdownWorkspaces` in the `anyOpenFolderIsMapped` guard, (b) process the `dropdownWorkspaces` array in the items-building loop, and (c) rename `addedParents` to `addedRoots`.

### Implementation Steps

1. **Update `anyOpenFolderIsMapped` guard** (src/services/KanbanProvider.ts, lines 679-706):
   - After the existing `workspaceFolders` loop (lines 693-701), add a check for `dropdownWorkspaces`
   - For each mapping, check if `m.dropdownWorkspaces` exists and is an array
   - For each dropdown workspace path, expand `~` and resolve, then compare against `resolvedRoot`
   - If matched, set `anyOpenFolderIsMapped = true` and break
   - Pattern is identical to the existing `workspaceFolders` loop

2. **Update items-building loop** (src/services/KanbanProvider.ts, lines 708-726):
   - Rename `addedParents` to `addedRoots` (lines 710, 718, 719)
   - After the existing loop that adds parent folders, add a second loop to process `dropdownWorkspaces`
   - For each mapping, check if `m.dropdownWorkspaces` exists and is an array
   - For each dropdown workspace path:
     - Expand `~` to home directory if present (same inline pattern as lines 714-716)
     - Resolve the path to an absolute path
     - Check if the path is not already in `addedRoots` set to avoid duplicates
     - Add to items list with label as the basename of the path (dropdown workspaces are independent board identities, so they use basename, not the mapping name)
   - Ensure dropdown workspaces are deduplicated against parent folders and other dropdown workspaces

3. **Test the fix**:
   - Open setup.html
   - Enable workspace-to-database mapping
   - Add a parent workspace mapping
   - Add a workspace path to the "Dropdown Workspaces" field
   - Save the mappings
   - Open kanban.html
   - Verify the dropdown workspace appears in the workspace dropdown
   - Verify selecting the dropdown workspace loads the correct shared database

4. **Edge cases to handle**:
   - Dropdown workspace path doesn't exist (should still appear in dropdown — the kanban board already handles missing databases gracefully)
   - Dropdown workspace path is the same as parent folder (should be deduplicated via `addedRoots` set)
   - Dropdown workspace path is already in `workspaceFolders` (should be deduplicated via `addedRoots` set)
   - Multiple dropdown workspaces with the same path (should be deduplicated via `addedRoots` set)
   - Dropdown workspace path contains `~` (should be expanded to home directory)
   - Only a dropdown workspace is open (not parent or child) — the `anyOpenFolderIsMapped` guard fix ensures the mapped context is used

## Files to Modify
- `src/services/KanbanProvider.ts` - Update `_getWorkspaceItems` method (lines 661-740)

## Proposed Changes

### src/services/KanbanProvider.ts

**Context:** The `_getWorkspaceItems` method builds the list of workspace items shown in the kanban dropdown. It has two branches: a mapped context (when workspace mappings are enabled and an open folder is mapped) and an independent context (fallback). The mapped context branch only adds parent folders to the items list.

**Logic:** Add `dropdownWorkspaces` processing to both the guard check and the items-building loop, using the same expansion and resolution patterns already present for `parentFolder` and `workspaceFolders`.

**Implementation:**

In the `anyOpenFolderIsMapped` guard (after line 701, before `if (anyOpenFolderIsMapped) break;`), add:
```typescript
for (const dw of m.dropdownWorkspaces || []) {
    const expandedDw = dw.startsWith('~')
        ? path.join(os.homedir(), dw.slice(1))
        : dw;
    if (path.resolve(expandedDw) === resolvedRoot) {
        anyOpenFolderIsMapped = true;
        break;
    }
}
```

In the items-building section (after line 726, inside the `if (enabled && ...)` block), add:
```typescript
for (const dw of m.dropdownWorkspaces || []) {
    const expandedDw = dw.startsWith('~')
        ? path.join(os.homedir(), dw.slice(1))
        : dw;
    const resolvedDw = path.resolve(expandedDw);
    if (!addedRoots.has(resolvedDw)) {
        addedRoots.add(resolvedDw);
        items.push({
            label: path.basename(resolvedDw),
            workspaceRoot: resolvedDw
        });
    }
}
```

Also rename `addedParents` → `addedRoots` on lines 710, 718, 719.

**Edge Cases:** Covered by the `addedRoots` deduplication set and the `~` expansion. Non-existent paths still appear in the dropdown; the kanban board's existing error handling covers selection of invalid paths.

## Verification Plan

### Automated Tests
- Add a unit test in `src/services/__tests__/KanbanProvider.test.ts` for `_getWorkspaceItems` that verifies:
  - When a mapping has `dropdownWorkspaces`, those workspaces appear in the returned items
  - Dropdown workspaces are deduplicated against parent folders
  - `~` paths are expanded correctly
  - When only a dropdown workspace is open, `anyOpenFolderIsMapped` evaluates to true (mapped context is used)

### Manual Verification
1. Add a dropdown workspace in setup.html
2. Save the mappings
3. Refresh kanban.html
4. Confirm the dropdown workspace appears in the workspace selection dropdown
5. Select the dropdown workspace
6. Verify it loads the correct shared database and shows plans from that database
7. Test with only the dropdown workspace open (no parent/child folder open) — verify mapped context is used

## Recommendation
Complexity 3 → **Send to Intern**
