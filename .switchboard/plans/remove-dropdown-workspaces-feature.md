# Remove Dropdown Workspaces Feature

## Goal

Remove the dropdown workspaces feature from the Multi-Repo workspace mapping system. This feature is redundant with the new projects system and makes the workspace picker confusing. No migration is needed as this is an unreleased feature used only by the author.

## Metadata

- **Tags:** [backend, frontend]
- **Complexity:** 4
- **Created:** 2026-05-28
- **Priority:** Medium
- **Type:** Feature Removal
- **Status:** Pending

## User Review Required

None - this is an unreleased feature used only by the author.

## Complexity Audit

### Routine
- Remove UI field from setup.html (textarea + button + label, ~4 lines)
- Remove JS field references from setup.html (event handlers, DOM capture, ~15 lines)
- Remove TypeScript interface property from KanbanDatabase.ts (1 line)
- Remove backend logic from 5 service files (~80 lines total)
- Remove test case from KanbanProvider.test.ts (~25 lines)
- Delete entire dedicated test file kanban-dropdown-workspaces.test.ts (222 lines)
- Remove browseWorkspaceMappingDropdownFolder handler from SetupPanelProvider.ts (~15 lines)
- Remove dropdown block from switchboardLocationGuard.ts (~7 lines)
- Remove cleanupDropdownIdentityFiles function from extension.ts (~22 lines)

### Complex / Risky
- WorkspaceIdentityService.ts uses dropdown workspaces for identity resolution — must ensure this doesn't break the identity system. After removing `isDropdownWorkspace()`, the `ensureWorkspaceIdentity` function has 8 `!isDropdown` guards that become dead code and must be simplified.
- KanbanProvider.ts uses dropdown workspaces for workspace item construction AND uses `isDropdownWorkspace` for ghost plan filtering — must verify workspace picker still works and ghost plan filtering is simplified correctly.
- GlobalPlanWatcherService.ts uses dropdown workspaces for folder watching — must ensure plan watching still works.
- TaskViewerProvider.ts uses dropdown folders for workspace mapping detection at line 3212-3213 — must simplify the `.find()` predicate.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. All changes are synchronous removals.
- **Security:** No impact. Removing `switchboardLocationGuard.ts` dropdown check slightly widens the guard (dropdown folders are no longer blocked from `.switchboard` creation), but since the feature is unreleased and no user has dropdown folders configured, this is safe.
- **Side Effects:** The workspace picker will no longer show dropdown workspaces as separate identities. This is the intended behavior. The `cleanupDropdownIdentityFiles` function in extension.ts will be removed — this is safe since no dropdown identity files will exist after the feature is removed.
- **Dependencies & Conflicts:** No downstream dependencies — this is a dead-end feature that only affects the Multi-Repo tab UI and backend workspace resolution. The `isDropdownWorkspace` export from WorkspaceIdentityService.ts is imported by KanbanProvider.ts and extension.ts — both imports must be removed when the function is deleted.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) Removing `isDropdownWorkspace()` from WorkspaceIdentityService.ts leaves 8 dead-code `!isDropdown` guards in `ensureWorkspaceIdentity` and a dead `dropdownIndex` check in `resolveEffectiveWorkspaceRootFromMappings` — these must be cleaned up or they create confusing always-true conditions. (2) KanbanProvider.ts line 1721 uses `isDropdownWorkspace` for ghost plan filtering; after removal, the `effectiveRootForPaths` simplification must be verified. (3) Four files referenced by the original plan were missed (switchboardLocationGuard.ts, kanban-dropdown-workspaces.test.ts, extension.ts, and additional references in TaskViewerProvider/KanbanProvider/SetupPanelProvider), which would cause TypeScript compilation errors if not addressed.

Mitigations: The `!isDropdown` guards in `ensureWorkspaceIdentity` always evaluate to true after removal, so removing them is behavior-preserving. The ghost plan filtering simplification is trivial (always use `resolvedWorkspaceRoot`). The missed files are straightforward mechanical removals with no logic changes.

## Description

The dropdown workspaces feature allows multiple workspace folders to share a single kanban database while appearing as separate "board identities" in the UI. This feature is redundant with the new projects system, which provides a cleaner way to organize and filter plans across workspaces. The dropdown workspaces feature also makes the workspace picker confusing because it adds multiple entries for the same database.

**Key reasons for removal:**
1. **Redundancy:** The new projects system (workspace/project dropdown) provides better plan organization
2. **UI confusion:** Dropdown workspaces create multiple entries in the workspace picker for the same database
3. **Complexity:** The feature requires complex backend logic across 5+ service files
4. **Unreleased:** This is an unreleased feature used only by the author, so no migration is needed

## Proposed Changes

### `src/webview/setup.html`

**Context:** The Multi-Repo tab contains a workspace mapping form with fields for database path, parent folder, child workspace folders, and dropdown workspaces.

**Logic:** Remove the dropdown workspaces field entirely from the mapping form.

**Implementation:**

**Lines 3121-3125:** Remove the dropdown workspaces field block:
```html
<!-- REMOVE this entire block -->
<div style="margin-bottom:8px;">
    <label style="display:block; font-size:10px; color:var(--text-secondary); margin-bottom:4px;">Dropdown Workspaces: <span style="font-weight:normal;">Folders that appear as independent board identities but share this database (one per line).</span></label>
    <textarea data-field="dropdownWorkspaces" placeholder="Dropdown folders that share this database (one per line)" style="width:100%; min-height:60px; background:var(--panel-bg); border:1px solid var(--border-color); color:var(--text-primary); padding:6px 8px; font-family:var(--font-mono); font-size:11px; resize:vertical;">${(mapping.dropdownWorkspaces || []).join('\n')}</textarea>
    <button data-action="browseDropdownFolders" class="secondary-btn" style="margin-top:4px; padding:4px 12px; font-size:10px;">Add Folder</button>
</div>
```

**Line 3157-3159:** Remove the browseDropdownFolders event listener:
```javascript
// REMOVE:
div.querySelector('button[data-action="browseDropdownFolders"]')?.addEventListener('click', () => {
    const mappingId = div.querySelector('[data-field="id"]')?.value || '';
    vscode.postMessage({ type: 'browseWorkspaceMappingDropdownFolder', mappingId });
});
```

**Lines 3167-3168:** Remove dropdown workspaces capture from initDb handler:
```javascript
// REMOVE:
const dropdownWorkspacesText = div.querySelector('[data-field="dropdownWorkspaces"]')?.value || '';
const dropdownWorkspaces = dropdownWorkspacesText.split('\n').map(f => f.trim()).filter(Boolean);
```

**Line 3183:** Remove dropdownWorkspaces from initDb message payload:
```javascript
// BEFORE:
vscode.postMessage({
    type: 'initWorkspaceMappingDb',
    mappingId,
    parentFolder,
    name,
    workspaceFolders,
    dropdownWorkspaces  // REMOVE THIS LINE
});

// AFTER:
vscode.postMessage({
    type: 'initWorkspaceMappingDb',
    mappingId,
    parentFolder,
    name,
    workspaceFolders
});
```

**Lines 3241-3246:** Remove dropdown workspaces from captureMappingsFromDom:
```javascript
// REMOVE:
const dropdownText = div.querySelector('[data-field="dropdownWorkspaces"]')?.value.trim() || '';
// ...
const dropdownWorkspaces = dropdownText.split('\n').map(f => f.trim()).filter(Boolean);
// ...
updatedMappings.push({ id, name, dbPath, parentFolder, workspaceFolders, dropdownWorkspaces, mode });

// REPLACE with:
updatedMappings.push({ id, name, dbPath, parentFolder, workspaceFolders, mode });
```

**Line 3258:** Remove dropdownWorkspaces from new mapping template:
```javascript
// BEFORE:
workspaceMappings.push({
    id: 'mapping-' + Date.now(),
    name: '',
    dbPath: '',
    parentFolder: '',
    workspaceFolders: [],
    dropdownWorkspaces: [],  // REMOVE THIS LINE
    mode: 'connect'
});

// AFTER:
workspaceMappings.push({
    id: 'mapping-' + Date.now(),
    name: '',
    dbPath: '',
    parentFolder: '',
    workspaceFolders: [],
    mode: 'connect'
});
```

**Lines 3414-3425:** Remove workspaceMappingDropdownFolderSelected message handler:
```javascript
// REMOVE this entire case block:
case 'workspaceMappingDropdownFolderSelected': {
    const container = document.getElementById('workspace-mappings-container');
    if (container && message.mappingId) {
        const idInput = container.querySelector('[data-field="id"][value="' + message.mappingId + '"]');
        const mappingDiv = idInput?.parentElement;
        const ta = mappingDiv?.querySelector('[data-field="dropdownWorkspaces"]');
        if (ta) {
            const current = ta.value.trim();
            ta.value = current ? current + '\n' + message.path : message.path;
        }
    }
    break;
}
```

### `src/services/KanbanDatabase.ts`

**Context:** The WorkspaceDatabaseMapping interface defines the structure for workspace-to-database mappings.

**Logic:** Remove the dropdownWorkspaces property from the interface.

**Implementation:**

**Line 14:** Remove dropdownWorkspaces property:
```typescript
// BEFORE:
export interface WorkspaceDatabaseMapping {
    id: string;
    name: string;
    dbPath: string;
    parentFolder?: string;
    workspaceFolders: string[];
    dropdownWorkspaces?: string[];  // REMOVE THIS LINE
    mode?: 'create' | 'connect';
}

// AFTER:
export interface WorkspaceDatabaseMapping {
    id: string;
    name: string;
    dbPath: string;
    parentFolder?: string;
    workspaceFolders: string[];
    mode?: 'create' | 'connect';
}
```

### `src/services/SetupPanelProvider.ts`

**Context:** SetupPanelProvider validates workspace mappings and handles saving/loading them.

**Logic:** Remove all dropdown workspaces validation and handling logic.

**Implementation:**

**Lines 738-744:** Remove dropdown workspaces existence validation:
```javascript
// REMOVE:
if (Array.isArray(m.dropdownWorkspaces)) {
    for (const dw of m.dropdownWorkspaces) {
        if (typeof dw === 'string' && !fs.existsSync(dw)) {
            warnings.push(`Mapping "${m.name}": dropdown workspace folder not found at ${dw}`);
        }
    }
}
```

**Lines 815-823:** Remove dropdown workspaces parent/child folder overlap validation:
```javascript
// REMOVE:
const dropdownFolders = (m.dropdownWorkspaces ?? []).map((f: string) => path.resolve(expandHome(f)));
if (dropdownFolders.includes(parentFolder)) {
    errors.push(`Mapping "${m.name}": parent folder cannot also be a dropdown workspace folder`);
}
for (const df of dropdownFolders) {
    if (childFolders.includes(df)) {
        errors.push(`Mapping "${m.name}": folder "${df}" cannot be both a child workspace folder and a dropdown workspace folder`);
    }
}
```

**Lines 839-860:** Remove dropdown workspaces dbPath validation block:
```javascript
// REMOVE this entire block (lines 839-860):
// Ensure dropdown workspaces have a valid dbPath (defense-in-depth)
// Skip checks already covered by mode-specific validation above to avoid
// duplicate error messages. Only adds dropdown-specific errors for modes
// that don't already validate dbPath (unexpected/unknown modes).
if (Array.isArray(m.dropdownWorkspaces) && m.dropdownWorkspaces.length > 0) {
    if (!m.dbPath?.trim()) {
        // mode='connect' and mode='create' already validate dbPath above;
        // only add dropdown-specific message for unexpected modes
        if (mode !== 'connect' && mode !== 'create') {
            errors.push(`Mapping "${m.name}": database path is required when dropdown workspaces are configured`);
        }
    } else if (mode !== 'create' && mode !== 'connect') {
        // mode='connect' already checks existence and .db extension above;
        // only add dropdown-specific checks for unexpected modes
        const resolvedDbPath = path.resolve(expandHome(m.dbPath.trim()));
        if (!fs.existsSync(resolvedDbPath)) {
            errors.push(`Mapping "${m.name}": database file does not exist for dropdown workspaces: ${resolvedDbPath}`);
        } else if (!resolvedDbPath.endsWith('.db')) {
            errors.push(`Mapping "${m.name}": database path must end with .db`);
        }
    }
}
```

**Lines 868-872:** Remove dropdown workspaces duplicate folder validation:
```javascript
// REMOVE:
for (const f of m.dropdownWorkspaces ?? []) {
    const norm = path.resolve(expandHome(f));
    if (seenFolders.has(norm)) errors.push(`Folder ${norm} listed in multiple mappings`);
    seenFolders.add(norm);
}
```

**Lines 897-903:** Remove dropdown workspaces identity provisioning:
```javascript
// REMOVE:
if (Array.isArray(m.dropdownWorkspaces)) {
    for (const dw of m.dropdownWorkspaces) {
        try {
            const resolvedPath = path.resolve(expandHome(dw));
            if (fs.existsSync(resolvedPath)) {
                await ensureWorkspaceIdentity(resolvedPath);
            }
        } catch (e) {
            // Silently fail on identity provisioning errors
        }
    }
}
```

**Lines 944-949:** Remove dropdown workspaces parent folder overlap validation in init handler:
```javascript
// REMOVE:
const dropdownWorkspaces = Array.isArray(message.dropdownWorkspaces) ? message.dropdownWorkspaces : [];
const dropdownFolders = dropdownWorkspaces.map((f: string) => path.resolve(expandHome(f)));
if (dropdownFolders.includes(resolvedParent)) {
    this._panel?.webview.postMessage({ type: 'workspaceMappingInitResult', ok: false, error: 'Parent folder cannot also be a dropdown workspace folder.' });
    break;
}
```

**Line 973:** Remove dropdownWorkspaces from new mapping object:
```javascript
// BEFORE:
const newMapping: WorkspaceMapping = {
    id: message.mappingId || ('mapping-' + Date.now()),
    name: message.name || path.basename(resolvedParent),
    dbPath: derivedDbPath,
    parentFolder: resolvedParent,
    workspaceFolders,
    dropdownWorkspaces,  // REMOVE THIS LINE
    mode: 'create'
};

// AFTER:
const newMapping: WorkspaceMapping = {
    id: message.mappingId || ('mapping-' + Date.now()),
    name: message.name || path.basename(resolvedParent),
    dbPath: derivedDbPath,
    parentFolder: resolvedParent,
    workspaceFolders,
    mode: 'create'
};
```

**Lines 999-1005:** Remove dropdown workspaces identity provisioning in init handler:
```javascript
// REMOVE:
for (const dw of dropdownWorkspaces) {
    try {
        const resolvedPath = path.resolve(expandHome(dw));
        if (fs.existsSync(resolvedPath)) {
            await ensureWorkspaceIdentity(resolvedPath);
        }
    } catch (e) {
        // Silently fail
    }
}
```

**Lines 1053-1068:** Remove browseWorkspaceMappingDropdownFolder message handler:
```javascript
// REMOVE this entire case block:
case 'browseWorkspaceMappingDropdownFolder': {
    const folderUri = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: 'Select dropdown workspace folder'
    });
    if (folderUri?.[0]) {
        this._panel?.webview.postMessage({
            type: 'workspaceMappingDropdownFolderSelected',
            path: folderUri[0].fsPath,
            mappingId: message.mappingId
        });
    }
    break;
}
```

### `src/services/KanbanProvider.ts`

**Context:** KanbanProvider constructs workspace items for the workspace picker and determines which workspaces are mapped.

**Logic:** Remove dropdown workspaces from workspace item construction, mapped context detection, and ghost plan filtering. Remove the `isDropdownWorkspace` import.

**Implementation:**

**Line 34:** Remove `isDropdownWorkspace` from import:
```typescript
// BEFORE:
import { isDropdownWorkspace, resolveEffectiveWorkspaceRootFromMappings } from './WorkspaceIdentityService';

// AFTER:
import { resolveEffectiveWorkspaceRootFromMappings } from './WorkspaceIdentityService';
```

**Lines 473-478:** Remove dropdown workspaces from allowedRoots construction:
```javascript
// REMOVE:
for (const dw of m.dropdownWorkspaces ?? []) {
    const expanded = dw.startsWith('~')
        ? path.join(os.homedir(), dw.slice(1))
        : dw;
    allowedRoots.add(path.resolve(expanded));
}
```

**Lines 705-710:** Remove dropdown workspaces from mapped context detection:
```javascript
// REMOVE:
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

**Lines 738-744:** Remove dropdown workspaces from workspace item construction:
```javascript
// REMOVE:
for (const dw of m.dropdownWorkspaces || []) {
    const expandedDw = dw.startsWith('~')
        ? path.join(os.homedir(), dw.slice(1))
        : dw;
    const resolvedDw = path.resolve(expandedDw);
    if (!addedRoots.has(resolvedDw)) {
        addedRoots.add(resolvedDw);
        workspaceItems.push({
            label: m.name || path.basename(resolvedParent),
            workspaceRoot: resolvedDw
        });
    }
}
```

**Lines 1721-1724:** Simplify ghost plan filtering (remove `isDropdownWorkspace` usage):
```javascript
// BEFORE:
const isDropdown = isDropdownWorkspace(resolvedWorkspaceRoot);
const effectiveRootForPaths = isDropdown
    ? resolveEffectiveWorkspaceRootFromMappings(resolvedWorkspaceRoot)  // parent root
    : resolvedWorkspaceRoot;

// AFTER:
const effectiveRootForPaths = resolvedWorkspaceRoot;
```

**Clarification:** Since `isDropdownWorkspace` will always return `false` after the property is removed, `effectiveRootForPaths` always equals `resolvedWorkspaceRoot`. The `resolveEffectiveWorkspaceRootFromMappings` call is unnecessary here because non-dropdown mapped workspaces already resolve correctly through the standard mapping logic.

### `src/services/WorkspaceIdentityService.ts`

**Context:** WorkspaceIdentityService resolves workspace identity and determines if a workspace is a dropdown workspace.

**Logic:** Remove dropdown workspaces from identity resolution, remove the `isDropdownWorkspace` function entirely, and simplify `ensureWorkspaceIdentity` and `resolveEffectiveWorkspaceRootFromMappings` by removing dead-code `isDropdown` guards.

**Implementation:**

**Lines 73-79:** Remove dropdown workspaces from identity index construction:
```javascript
// REMOVE:
// Dropdowns map to parent
if (Array.isArray(mapping.dropdownWorkspaces)) {
    for (const dropdown of mapping.dropdownWorkspaces) {
        const resolvedDropdown = path.resolve(dropdown.startsWith('~') ? path.join(os.homedir(), dropdown.slice(1)) : dropdown);
        index.set(resolvedDropdown, resolvedParent);
    }
}
```

**Lines 104-128:** Remove the entire `isDropdownWorkspace` function:
```javascript
// REMOVE this entire function:
export function isDropdownWorkspace(workspaceRoot: string): boolean {
    try {
        const cfg = getMappingsFromIndex();
        if (!cfg?.enabled || !Array.isArray(cfg.mappings)) {
            return false;
        }
        const resolvedRoot = path.resolve(workspaceRoot);
        for (const mapping of cfg.mappings) {
            if (!Array.isArray(mapping.dropdownWorkspaces)) continue;
            for (const f of mapping.dropdownWorkspaces) {
                const expanded = f.startsWith('~')
                    ? path.join(os.homedir(), f.slice(1))
                    : f;
                if (path.resolve(expanded) === resolvedRoot) {
                    return true;
                }
            }
        }
    } catch {
        // Outside extension host
    }
    return false;
}
```

**Lines 175-183:** Remove dropdown workspaces from `resolveEffectiveWorkspaceRootFromMappings`:
```javascript
// REMOVE:
const dropdownIndex = Array.isArray(mapping.dropdownWorkspaces)
    ? mapping.dropdownWorkspaces.findIndex((f: string) => {
        const expanded = f.startsWith('~')
            ? path.join(os.homedir(), f.slice(1))
            : f;
        return path.resolve(expanded) === workspaceRoot;
    })
    : -1;
```

**Line 185:** Simplify the condition in `resolveEffectiveWorkspaceRootFromMappings`:
```javascript
// BEFORE:
if (isParent || matchingIndex !== -1 || dropdownIndex !== -1) {

// AFTER:
if (isParent || matchingIndex !== -1) {
```

**Lines 271-347:** Simplify `ensureWorkspaceIdentity` by removing `isDropdown` variable and all `!isDropdown` guards:
```javascript
// REMOVE line 271:
const isDropdown = isDropdownWorkspace(resolvedRoot);

// SIMPLIFY: Remove all "!isDropdown &&" guards. After removing isDropdownWorkspace(),
// isDropdown is always false, so !isDropdown is always true.
// The following lines should have their "!isDropdown &&" / "if (!isDropdown)" removed:

// Line 274: BEFORE: if (!isDropdown) {        AFTER: {
// Line 284: BEFORE: if (!isDropdown && dbReady) {  AFTER: if (dbReady) {
// Line 298: BEFORE: if (!isDropdown && dbReady) {  AFTER: if (dbReady) {
// Line 301: BEFORE: if (!isDropdown) {        AFTER: (remove guard, keep body)
// Line 311: BEFORE: if (!isDropdown && dbReady) {  AFTER: if (dbReady) {
// Line 321: BEFORE: if (!isDropdown) {        AFTER: {
// Line 341: BEFORE: if (!isDropdown && dbReady) {  AFTER: if (dbReady) {
// Line 344: BEFORE: if (!isDropdown) {        AFTER: (remove guard, keep body)

// Also update comments that say "(skip if dropdown)" — remove those qualifiers.
```

### `src/services/TaskViewerProvider.ts`

**Context:** TaskViewerProvider uses workspace mappings to determine mapped child roots for plan execution and workspace mapping detection.

**Logic:** Remove dropdown workspaces from mapped child root construction and mapping detection.

**Implementation:**

**Lines 700-707:** Remove dropdown workspaces from mapped child roots (first occurrence):
```javascript
// REMOVE:
if (Array.isArray(m.dropdownWorkspaces)) {
    for (const f of m.dropdownWorkspaces) {
        if (typeof f === 'string') {
            const trimmed = f.trim();
            const expanded = trimmed.startsWith('~')
                ? path.join(os.homedir(), trimmed.slice(1))
                : trimmed;
            if (fs.existsSync(expanded)) {
                mappedChildRoots.add(path.resolve(expanded));
            }
        }
    }
}
```

**Lines 748-755:** Remove dropdown workspaces from mapped child roots (second occurrence):
```javascript
// REMOVE:
if (Array.isArray(m.dropdownWorkspaces)) {
    for (const f of m.dropdownWorkspaces) {
        if (typeof f === 'string') {
            const trimmed = f.trim();
            const expanded = trimmed.startsWith('~')
                ? path.join(os.homedir(), trimmed.slice(1))
                : trimmed;
            if (fs.existsSync(expanded)) {
                mappedChildRoots.add(path.resolve(expanded));
            }
        }
    }
}
```

**Lines 885-891:** Remove dropdown workspaces from allowedRoots construction:
```javascript
// REMOVE:
if (Array.isArray(m.dropdownWorkspaces)) {
    for (const dw of m.dropdownWorkspaces) {
        if (typeof dw === 'string') {
            const p = dw.trim();
            const expanded = p.startsWith('~')
                ? path.join(os.homedir(), p.slice(1))
                : p;
            allowedRoots.add(path.resolve(expanded));
        }
    }
}
```

**Lines 3212-3213:** Remove dropdown folders from workspace mapping detection:
```javascript
// BEFORE:
const dropdownFolders = Array.isArray(m.dropdownWorkspaces) ? m.dropdownWorkspaces.map((f: string) => path.resolve(f)) : [];
return childFolders.includes(path.resolve(root)) || dropdownFolders.includes(path.resolve(root));

// AFTER:
return childFolders.includes(path.resolve(root));
```

### `src/services/GlobalPlanWatcherService.ts`

**Context:** GlobalPlanWatcherService watches folders for plan changes using workspace mappings.

**Logic:** Remove dropdown workspaces from folder watching.

**Implementation:**

**Lines 232-238:** Remove dropdown workspaces from folder watching:
```javascript
// REMOVE:
if (Array.isArray(mapping.dropdownWorkspaces)) {
    for (const dw of mapping.dropdownWorkspaces) {
        const resolved = path.resolve(this._expandHome(dw));
        if (fs.existsSync(resolved) && !folders.includes(resolved)) {
            folders.push(resolved);
        }
    }
}
```

### `src/utils/switchboardLocationGuard.ts`

**Context:** switchboardLocationGuard blocks `.switchboard` creation in child and dropdown workspace folders.

**Logic:** Remove the dropdown workspace check from the guard function.

**Implementation:**

**Line 40:** Update comment:
```javascript
// BEFORE:
// 1a. Is candidate a mapped child workspaceFolder or dropdownWorkspace? → BLOCK

// AFTER:
// 1a. Is candidate a mapped child workspaceFolder? → BLOCK
```

**Lines 49-55:** Remove dropdown workspace block:
```javascript
// REMOVE:
if (Array.isArray(mapping.dropdownWorkspaces)) {
    for (const dw of mapping.dropdownWorkspaces) {
        if (path.resolve(expandHome(dw)) === resolvedCandidate) {
            return false; // Dropdown workspace — NOT allowed (shares parent DB)
        }
    }
}
```

### `src/extension.ts`

**Context:** extension.ts contains a `cleanupDropdownIdentityFiles` function that removes stale identity files from dropdown workspaces on activation.

**Logic:** Remove the `cleanupDropdownIdentityFiles` function, its call site, and the `isDropdownWorkspace` import.

**Implementation:**

**Line 1:** Remove `isDropdownWorkspace` from import:
```javascript
// BEFORE:
import { isDropdownWorkspace } from './services/WorkspaceIdentityService';

// AFTER:
(remove the entire import line if isDropdownWorkspace is the only import from this module)
```

**Lines 391-406:** Remove the `cleanupDropdownIdentityFiles` function:
```javascript
// REMOVE this entire function:
async function cleanupDropdownIdentityFiles(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const resolved = path.resolve(folder.uri.fsPath);
        if (isDropdownWorkspace(resolved)) {
            const idFile = path.join(resolved, '.switchboard', 'workspace-id');
            if (fs.existsSync(idFile)) {
                try {
                    await fs.promises.unlink(idFile);
                    console.log(`[Switchboard] Removed dead identity file in dropdown workspace: ${idFile}`);
                } catch (err) {
                    console.warn(`[Switchboard] Failed to remove dead identity file: ${idFile}`, err);
                }
            }
        }
    }
}
```

**Line 412:** Remove the call to `cleanupDropdownIdentityFiles`:
```javascript
// REMOVE:
cleanupDropdownIdentityFiles().catch(err => console.error('[Switchboard] Cleanup failed:', err));
```

### `src/services/__tests__/KanbanProvider.test.ts`

**Context:** Unit tests for KanbanProvider include a test for dropdown workspaces functionality.

**Logic:** Remove the dropdown workspaces test case.

**Implementation:**

**Lines 460-480:** Remove the dropdown workspaces test:
```javascript
// REMOVE this entire test:
test('dropdownWorkspaces appear and are deduplicated with correct ~, and trigger mapped context', () => {
    const os = require('os');
    const homeDir = os.homedir();
    
    // Mock open roots: only a dropdown workspace is open
    getWorkspaceRootsStub.returns([path.join(homeDir, 'dd-workspace-1')]);
    
    getConfigurationStub.returns({
        get: (key: string) => {
            if (key === 'workspaceMappings') {
                return {
                    enabled: true,
                    mappings: [
                        {
                            parentFolder: '/test/parent',
                            workspaceFolders: ['/test/child'],
                            dropdownWorkspaces: ['~/dd-workspace-1', '/test/parent', '/test/dd-workspace-2', '~/dd-workspace-1']
                        }
                    ]
                }
            }
            return undefined;
        }
    } as any);
    
    // ... rest of test
});
```

### `src/test/kanban-dropdown-workspaces.test.ts`

**Context:** Dedicated test file (222 lines) for dropdown workspaces functionality in the KanbanProvider.

**Logic:** Delete the entire file. All 8 tests in this suite test dropdown workspace behavior that is being removed.

**Implementation:**

Delete the file `src/test/kanban-dropdown-workspaces.test.ts` entirely.

## Verification Plan

### Automated Tests

- Run existing unit tests: `npm test -- src/services/__tests__/KanbanProvider.test.ts` (should pass after removing the dropdown workspaces test)
- Run integration tests: `npm test` (should pass, no integration tests depend on dropdown workspaces)
- Verify the deleted test file is not referenced elsewhere: `grep -r "kanban-dropdown-workspaces" src/`

### Manual Verification

1. Open the Multi-Repo tab in setup.html
2. Verify the dropdown workspaces field is no longer visible
3. Create a new workspace mapping (should work without dropdown workspaces)
4. Save the mapping
5. Open the kanban view
6. Verify the workspace picker shows only parent and child workspace folders
7. Verify plan watching still works for mapped workspaces
8. Verify workspace identity resolution still works
9. Verify `.switchboard` creation guard still blocks child workspace folders (but no longer checks dropdown folders)

## Recommendation

**Send to Coder** — Complexity 4. The changes are routine removals across 10 files, but the cascading simplification in WorkspaceIdentityService.ts (removing `isDropdownWorkspace` and cleaning up 8 dead-code guards) and the ghost plan filtering simplification in KanbanProvider.ts require careful attention to ensure no logic is accidentally broken.

---

## Review Results (2026-05-28)

### Stage 1: Grumpy Principal Engineer Findings

| # | Finding | Severity | File | Line(s) |
|---|---------|----------|------|---------|
| 1 | Stale comment "OR as dropdown" in `resolveEffectiveWorkspaceRootFromMappings` | NIT | `src/services/WorkspaceIdentityService.ts` | 118 |
| 2 | Misleading variable name `isDropdown` and comments referencing "dropdown (sub-workspace)" in workspace scope filter logic — this variable checks if a workspace is a mapped child vs parent, has nothing to do with the removed dropdown workspaces feature | MAJOR | `src/services/KanbanProvider.ts` | 4119-4127 |
| 3 | All feature-specific code properly removed | PASS | All 10 files + test file | — |

### Stage 2: Balanced Synthesis

| Finding | Action | Rationale |
|---------|--------|-----------|
| NIT: Stale comment | **Fix now** | One-line edit, prevents future confusion |
| MAJOR: Misleading `isDropdown` variable | **Fix now** | Variable name references removed feature; rename to `isChildWorkspace` and update comments |

### Stage 3: Code Fixes Applied

1. **`src/services/WorkspaceIdentityService.ts` line 118:** Changed comment from `"as child OR as parent OR as dropdown"` to `"as child OR as parent"`
2. **`src/services/KanbanProvider.ts` lines 4119-4127:** Renamed `isDropdown` → `isChildWorkspace`, updated comments from "dropdown (sub-workspace)" → "child workspace", "Only dropdown workspaces should trigger filtering" → "Only child workspaces should trigger filtering", "Dropdown workspace: set repo scope filter" → "Child workspace: set repo scope filter"

### Stage 4: Verification Results

- `grep` for `dropdownWorkspaces|isDropdownWorkspace|browseDropdownFolders|browseWorkspaceMappingDropdownFolder|workspaceMappingDropdownFolderSelected|cleanupDropdownIdentityFiles` across `src/`: **0 matches** ✅
- `grep` for `isDropdown` in `src/services/KanbanProvider.ts`: **0 matches** ✅
- `grep` for `dropdown` in `src/services/WorkspaceIdentityService.ts`: **0 matches** ✅
- `grep` for `isDropdown[^W]` across `src/`: **0 matches** ✅
- `kanban-dropdown-workspaces.test.ts` file: **Deleted** ✅
- `isChildWorkspace` variable in `src/services/KanbanProvider.ts`: **2 matches** (declaration + usage) ✅

### Remaining Risks

- None. All feature-specific code, imports, tests, and misleading naming have been cleaned up. The feature removal is complete.
