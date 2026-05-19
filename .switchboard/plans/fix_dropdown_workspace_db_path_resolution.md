# Fix Dropdown Workspace DB Path Resolution

## Goal
Fix the runtime resolution failure when a workspace is added to `dropdownWorkspaces` — the `KanbanProvider.resolveEffectiveWorkspaceRoot()` method ignores dropdown entries, causing the DB path to resolve incorrectly. Add validation guards and fix a misleading log message as defense-in-depth.

## Metadata
- **Tags:** [backend, bugfix, database, reliability]
- **Complexity:** 5

## User Review Required
- Confirm that the primary fix (adding `dropdownWorkspaces` check to `resolveEffectiveWorkspaceRoot`) matches intended behavior
- Confirm the validation guard in `saveWorkspaceMappings` is desired even though `mode='connect'` already validates `dbPath`

## Complexity Audit

### Routine
- Add `dropdownWorkspaces` check to `resolveEffectiveWorkspaceRoot()` — mirrors existing `workspaceFolders` check pattern
- Fix misleading log message in `forWorkspace()` when mapping found but `dbPath` is empty
- Add validation in `saveWorkspaceMappings` for dropdown workspaces requiring `dbPath`

### Complex / Risky
- `resolveEffectiveWorkspaceRoot()` is called from ~15 sites across `TaskViewerProvider`, `KanbanProvider`, and `extension.ts` — changing its return value for dropdown workspaces affects all callers (identity resolution, orphan checks, workspace ID, DB caching). However, the change aligns it with `WorkspaceIdentityService.resolveEffectiveWorkspaceRootFromMappings()` which already handles dropdowns correctly, so the behavior becomes consistent rather than novel.

## Edge-Case & Dependency Audit

- **Race Conditions**: None — `resolveEffectiveWorkspaceRoot()` is synchronous and reads from VS Code config (immutable during a single call). The internal `KanbanDatabase` caches (`_instances`, `_instancesByDbPath`) are keyed by stable/dbPath and prevent duplicate instances regardless of outer cache keys.
- **Security**: No new attack surface. Path resolution uses existing `_expandHome`/`expandHome` helpers.
- **Side Effects**: After the fix, `resolveEffectiveWorkspaceRoot()` will return the parent path for dropdown workspaces instead of the original path. This changes the cache keys in `KanbanProvider._getKanbanDb()` and `TaskViewerProvider._getKanbanDb()` for dropdown workspaces — they will now cache by the parent path, which is correct and consistent with how child workspaces in `workspaceFolders` are already handled.
- **Dependencies & Conflicts**: `WorkspaceIdentityService.resolveEffectiveWorkspaceRootFromMappings()` already checks `dropdownWorkspaces` (lines 117-124). The fix brings `KanbanProvider.resolveEffectiveWorkspaceRoot()` into alignment. No conflict.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Changing `resolveEffectiveWorkspaceRoot()` return value for dropdown workspaces affects ~15 callers — but all already handle the parent-path case correctly for `workspaceFolders` children, so dropdown workspaces will behave identically. (2) The original plan misdiagnosed the root cause (the `forWorkspace()` lookup works fine; the gap is in `resolveEffectiveWorkspaceRoot()`). Mitigations: the fix mirrors the already-working `WorkspaceIdentityService` implementation; the validation guard is additive-only.

## Problem
When a workspace is added to `dropdownWorkspaces` in a workspace mapping, the extension shows an error on startup:
```
Kanban DB initialization failed: Database file does not exist (not auto-creating). DB-backed views may appear empty until the database is repaired or reset.
```

The parent database already exists at `/Users/patrickvuleta/Documents/Gitlab/.switchboard/kanban.db`. The UI correctly allows linking a child workspace to a parent database via dropdownWorkspaces, but the system fails to find the existing database.

## Root Cause
**Primary bug**: `KanbanProvider.resolveEffectiveWorkspaceRoot()` (lines 3160-3210 in `src/services/KanbanProvider.ts`) only checks `workspaceFolders` when resolving the effective root — it does NOT check `dropdownWorkspaces`. This means when a dropdown workspace is opened, the method returns the original (un-redirected) path instead of the parent path.

This is inconsistent with:
- `WorkspaceIdentityService.resolveEffectiveWorkspaceRootFromMappings()` (lines 65-133 in `src/services/WorkspaceIdentityService.ts`) — DOES check `dropdownWorkspaces`
- `KanbanDatabase._redirectToParentIfMapped()` (lines 449-480 in `src/services/KanbanDatabase.ts`) — DOES check `dropdownWorkspaces`

The `resolveEffectiveWorkspaceRoot()` method is called from ~15 sites in `TaskViewerProvider`, `KanbanProvider`, and `extension.ts`. When it returns the wrong path for dropdown workspaces, downstream callers cache DB instances by the wrong key, resolve workspace IDs incorrectly, and perform orphan checks against the wrong root.

**Secondary issue**: In `KanbanDatabase.forWorkspace()` (line 519), when a mapping IS found but `dbPath` is empty/falsy, the log message says "not in any mapping" — this is misleading and hinders debugging.

**Tertiary gap**: `SetupPanelProvider.saveWorkspaceMappings` has no explicit validation that mappings with `dropdownWorkspaces` must have a valid `dbPath`. The `mode='connect'` path already validates `dbPath`, but an explicit check for dropdown workspaces provides defense-in-depth.

## Solution

### Proposed Changes

#### 1. `src/services/KanbanProvider.ts` — Add `dropdownWorkspaces` check to `resolveEffectiveWorkspaceRoot()`
**Location**: Lines 3160-3210 in `resolveEffectiveWorkspaceRoot()`

**Current code** (lines 3174-3203):
```typescript
if (cfg?.enabled && Array.isArray(cfg.mappings)) {
    for (const mapping of cfg.mappings) {
        if (!Array.isArray(mapping.workspaceFolders)) continue;

        const matchingIndex = mapping.workspaceFolders.findIndex((f: string) => {
            const expanded = f.startsWith('~')
                ? path.join(os.homedir(), f.slice(1))
                : f;
            return path.resolve(expanded) === resolvedRoot;
        });

        if (matchingIndex !== -1) {
            // This root is in a mapping - use explicit parentFolder if set,
            // otherwise fall back to first entry for backward compatibility
            let parentEntry: string | undefined;
            if (mapping.parentFolder) {
                parentEntry = mapping.parentFolder;
            } else if (mapping.workspaceFolders.length > 0) {
                parentEntry = mapping.workspaceFolders[0];
            }

            if (!parentEntry) continue;

            return path.resolve(
                parentEntry.startsWith('~')
                    ? path.join(os.homedir(), parentEntry.slice(1))
                    : parentEntry
            );
        }
    }
}
```

**Proposed change**: After the `workspaceFolders` check, add a `dropdownWorkspaces` check that follows the same pattern. Also update the type annotation on line 3172 to include `dropdownWorkspaces`:

```typescript
// Update type annotation (line 3172) to include dropdownWorkspaces:
{ enabled?: boolean; mappings?: Array<{ workspaceFolders: string[]; parentFolder?: string; dropdownWorkspaces?: string[] }> } | undefined;

// After the matchingIndex block (after line 3202), add dropdown check:
const dropdownIndex = Array.isArray(mapping.dropdownWorkspaces)
    ? mapping.dropdownWorkspaces.findIndex((f: string) => {
        const expanded = f.startsWith('~')
            ? path.join(os.homedir(), f.slice(1))
            : f;
        return path.resolve(expanded) === resolvedRoot;
    })
    : -1;

if (dropdownIndex !== -1) {
    let parentEntry: string | undefined;
    if (mapping.parentFolder) {
        parentEntry = mapping.parentFolder;
    } else if (mapping.workspaceFolders.length > 0) {
        parentEntry = mapping.workspaceFolders[0];
    }

    if (!parentEntry) continue;

    return path.resolve(
        parentEntry.startsWith('~')
            ? path.join(os.homedir(), parentEntry.slice(1))
            : parentEntry
    );
}
```

**Context**: This mirrors the existing logic in `WorkspaceIdentityService.resolveEffectiveWorkspaceRootFromMappings()` (lines 117-133) which already handles `dropdownWorkspaces` correctly.

**Logic**: When a workspace root matches a `dropdownWorkspaces` entry, resolve to the parent folder (explicit `parentFolder` or `workspaceFolders[0]` fallback), exactly as child workspaces in `workspaceFolders` are already handled.

**Edge Cases**: If a folder appears in both `workspaceFolders` and `dropdownWorkspaces`, the `workspaceFolders` check runs first and returns before reaching the dropdown check — consistent with existing priority. The `saveWorkspaceMappings` validation already prevents this overlap (line 746-750).

#### 2. `src/services/KanbanDatabase.ts` — Fix misleading log message
**Location**: Line 519 in `forWorkspace()`

**Current code**:
```typescript
} else {
    console.log(`[KanbanDatabase] Workspace '${stable}' not in any mapping; using default database location`);
}
```

**Proposed change**:
```typescript
} else {
    console.log(`[KanbanDatabase] Workspace '${stable}' found in mapping '${mapping.name}' but no dbPath configured; using default database location`);
}
```

**Context**: When `mapping` is found but `mapping.dbPath` is falsy, the current message says "not in any mapping" which is incorrect and misleading during debugging.

**Logic**: Distinguish between "no mapping found" and "mapping found but no dbPath" to aid future debugging.

**Edge Cases**: If `mapping` is undefined (no mapping found at all), the else branch is not reached because the `if (mapping?.dbPath)` check short-circuits on the optional chain. Actually, looking at the code more carefully — when `mapping` is undefined, `mapping?.dbPath` is undefined, so we DO enter the else branch. The fix should handle both cases:

```typescript
} else if (mapping) {
    console.log(`[KanbanDatabase] Workspace '${stable}' found in mapping '${mapping.name}' but no dbPath configured; using default database location`);
} else {
    console.log(`[KanbanDatabase] Workspace '${stable}' not in any mapping; using default database location`);
}
```

#### 3. `src/services/SetupPanelProvider.ts` — Add validation for dropdown workspaces requiring dbPath
**Location**: After line 764 (after the `mode === 'connect'` validation block) in `saveWorkspaceMappings` handler

**Current behavior**: The `mode === 'connect'` validation (lines 753-763) already requires `dbPath` and checks that the file exists. The `mode === 'create'` validation (lines 734-750) requires clicking "Initialize Database". But there's no explicit check that mappings with `dropdownWorkspaces` have a valid `dbPath` regardless of mode.

**Proposed change**: Add after line 764:
```typescript
// Ensure dropdown workspaces have a valid dbPath (defense-in-depth)
if (Array.isArray(m.dropdownWorkspaces) && m.dropdownWorkspaces.length > 0) {
    if (!m.dbPath?.trim()) {
        errors.push(`Mapping "${m.name}": database path is required when dropdown workspaces are configured`);
    } else {
        const resolvedDbPath = path.resolve(expandHome(m.dbPath.trim()));
        if (!fs.existsSync(resolvedDbPath)) {
            errors.push(`Mapping "${m.name}": database file does not exist for dropdown workspaces: ${resolvedDbPath}`);
        } else if (!resolvedDbPath.endsWith('.db')) {
            errors.push(`Mapping "${m.name}": database path must end with .db`);
        }
    }
}
```

**Context**: This is defense-in-depth. Since `mode` defaults to `'connect'` (line 731), the existing connect-mode validation will catch most cases. This explicit check catches edge cases where mode is unset or non-standard.

**Logic**: If a mapping has `dropdownWorkspaces` entries, it MUST have a `dbPath` pointing to an existing `.db` file. This ensures the dropdown workspace can resolve to a valid database at runtime.

**Edge Cases**: For `mode='create'`, the database might not exist yet (user hasn't clicked "Initialize Database"). The validation should only check `fs.existsSync` when the file is expected to exist. Clarification: For `mode='create'` with dropdown workspaces, the user must initialize the database first (same as existing create-mode validation on line 735-736). The dropdown validation should respect the mode — skip the `existsSync` check for `mode='create'` since the DB is created by the init button:

```typescript
if (Array.isArray(m.dropdownWorkspaces) && m.dropdownWorkspaces.length > 0) {
    if (!m.dbPath?.trim()) {
        errors.push(`Mapping "${m.name}": database path is required when dropdown workspaces are configured`);
    } else if (mode !== 'create') {
        // For connect mode (default), verify the database file exists
        const resolvedDbPath = path.resolve(expandHome(m.dbPath.trim()));
        if (!fs.existsSync(resolvedDbPath)) {
            errors.push(`Mapping "${m.name}": database file does not exist for dropdown workspaces: ${resolvedDbPath}`);
        } else if (!resolvedDbPath.endsWith('.db')) {
            errors.push(`Mapping "${m.name}": database path must end with .db`);
        }
    }
}
```

## Edge Cases & Dependencies
- **Backward compatibility**: Existing mappings without `dropdownWorkspaces` are unaffected — the new check in `resolveEffectiveWorkspaceRoot()` only fires when `dropdownWorkspaces` is a non-empty array.
- **Mode='create'**: The existing validation for mode='create' still requires clicking "Initialize Database". The dropdown validation skips `existsSync` for create mode.
- **Mode='connect'**: The existing validation for mode='connect' already requires a valid `dbPath`. The dropdown validation adds an explicit check for the dropdown-specific case.
- **Cache key change**: After the fix, `resolveEffectiveWorkspaceRoot()` returns the parent path for dropdown workspaces. This changes cache keys in `KanbanProvider._kanbanDbs` and `TaskViewerProvider._kanbanDbs` for dropdown workspaces — they will now cache by the parent path, which is correct and consistent with how `workspaceFolders` children are already cached.
- **Consistency with WorkspaceIdentityService**: The fix brings `KanbanProvider.resolveEffectiveWorkspaceRoot()` into alignment with `WorkspaceIdentityService.resolveEffectiveWorkspaceRootFromMappings()`, which already checks `dropdownWorkspaces`.

## Verification Plan

### Automated Tests
- No existing automated tests found for `resolveEffectiveWorkspaceRoot()`. Manual verification is required.

### Manual Verification
1. Open setup.html workspace mapping tab
2. Create a mapping with a parent folder and add dropdown workspaces
3. Set `dbPath` to an existing database file
4. Save the mapping — verify no validation errors
5. Restart extension with the dropdown workspace open
6. Verify no "Kanban DB initialization failed" error appears
7. Verify the dropdown workspace appears and functions correctly in kanban.html
8. Test validation: Remove `dbPath` from a mapping with dropdown workspaces and attempt to save
9. Verify error message: "database path is required when dropdown workspaces are configured"
10. Test with `mode='create'` and dropdown workspaces — verify the dbPath is required but file existence is not checked until initialization

## Acceptance Criteria
- [ ] `KanbanProvider.resolveEffectiveWorkspaceRoot()` returns the parent path for dropdown workspaces (not the original path)
- [ ] No "Kanban DB initialization failed" error on extension startup when dropdown workspace mapping has valid dbPath
- [ ] Dropdown workspaces appear and function correctly in the kanban picker
- [ ] Log message correctly distinguishes "mapping found but no dbPath" from "not in any mapping"
- [ ] Validation error appears if saving a mapping with dropdownWorkspaces but no dbPath
- [ ] Validation for dropdown workspaces respects mode='create' (doesn't require file to exist yet)
- [ ] `resolveEffectiveWorkspaceRoot()` behavior is consistent with `WorkspaceIdentityService.resolveEffectiveWorkspaceRootFromMappings()`

## Recommendation
Complexity 5 → **Send to Coder**
