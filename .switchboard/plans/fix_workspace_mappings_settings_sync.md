# Fix Workspace Database Mappings Settings Sync

## Goal
Fix the discrepancy between the setup panel UI showing workspaceDatabaseMappings as enabled while the persisted settings.json file has `"enabled": false`, causing dropdown workspace initialization to fail.

## Metadata
- **Tags:** [bugfix, reliability]
- **Complexity:** 4

## Problem
The setup panel shows workspaceDatabaseMappings as enabled/active, but the actual persisted settings in `.vscode/settings.json` has `"enabled": false`. This causes the dropdown workspace feature to fail because the mapping is not actually enabled at runtime, leading to "Kanban DB initialization failed: Database file does not exist (not auto-creating)" errors when switching workspaces.

## Root Cause
**Primary: Missing folder URI in `getConfiguration()` calls for a resource-scoped setting.** The `workspaceDatabaseMappings` setting is declared with `"scope": "resource"` in `package.json` (line 412), but all four `getConfiguration('switchboard')` calls for this setting omit the folder URI argument. Other resource-scoped settings in the same file (`integrations.preferredProvider`, `planning.enabledSources`, `kanban.controlPlaneRoot`) correctly pass `folderUri` — see `SetupPanelProvider.ts` lines 549, 578, 679, 998, 1029, 1060. Without a folder URI, VS Code returns a potentially incorrect merged value for resource-scoped settings, and writes may not be read back correctly.

**Secondary: Stale mapping cache never invalidated.** `WorkspaceIdentityService` exports `clearMappingCache()` (line 24) but it is never called anywhere in the codebase. The `onDidChangeConfiguration` handler in `extension.ts` (line 1179) invalidates `KanbanDatabase` instances when `workspaceDatabaseMappings` changes, but does not clear the mapping cache, so stale resolution results can persist indefinitely.

**Note:** The plan's original proposed fix (adding `ConfigurationTarget.Workspace` to `setWorkspaceMappingEnabled`) is already present in the code at `SetupPanelProvider.ts` line 708. The bug persists because the root cause is the missing folder URI, not the configuration target.

## User Review Required
- Confirm whether `workspaceDatabaseMappings` should be written at `Workspace` level (workspace-wide) or `WorkspaceFolder` level (per-folder) in multi-root workspaces. Current behavior uses `Workspace`, which is defensible since the mapping is conceptually workspace-wide.

## Complexity Audit

### Routine
- Adding `folderUri` argument to four `getConfiguration('switchboard')` calls in `SetupPanelProvider.ts`
- Adding `clearMappingCache()` call to the `onDidChangeConfiguration` handler in `extension.ts`
- Adding `clearMappingCache` import to `extension.ts`

### Complex / Risky
- Determining correct write target (`WorkspaceFolder` vs `Workspace`) for multi-root workspaces — may require user input

## Edge-Case & Dependency Audit

- **Race Conditions:** The `setWorkspaceMappingEnabled` handler writes and then immediately posts a message back to the webview confirming the new state. If the `config.update()` silently fails (e.g., workspace is not trusted), the UI will show the wrong state. No error handling on the `config.update()` call.
- **Security:** No security implications — this is a settings persistence bug.
- **Side Effects:** Changing the write target from `Workspace` to `WorkspaceFolder` could cause existing workspace-level settings to stop being read in multi-root setups. The read-side fix (adding folder URI) is safe; the write-side change needs caution.
- **Dependencies & Conflicts:** The `WorkspaceIdentityService._mappingCache` is a module-level singleton. If `clearMappingCache()` is not called after a settings change, `KanbanDatabase.forWorkspace()` and `resolveEffectiveWorkspaceRootFromMappings()` will return stale results. The `KanbanDatabase._instances` cache is already invalidated by the existing handler, but the mapping cache is not.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The original proposed fix is already in the code and doesn't address the actual root cause — missing folder URI for resource-scoped reads/writes. (2) The `clearMappingCache()` function exists but is never called, creating a hidden cache invalidation gap. Mitigations: Add folder URI to all `getConfiguration()` calls for this setting (consistent with existing patterns in the same file), and call `clearMappingCache()` on configuration changes.

## Proposed Changes

### `src/services/SetupPanelProvider.ts`

**Context:** All four `getConfiguration('switchboard')` calls for `workspaceDatabaseMappings` need a folder URI, consistent with how other resource-scoped settings are handled in this file.

**Change 1 — `getWorkspaceMappings` handler (line 692-699)**
Add folder URI to `getConfiguration()`:
```typescript
case 'getWorkspaceMappings': {
    const folderUri = this._getWorkspaceFolderUri(this._getCurrentWorkspaceRoot() ?? undefined);
    const config = vscode.workspace.getConfiguration('switchboard', folderUri);
    const mappings = config.get<any>('workspaceDatabaseMappings', { enabled: false, mappings: [] });
    this._panel?.webview.postMessage({
        type: 'workspaceMappings',
        ...mappings
    });
    break;
}
```

**Change 2 — `setWorkspaceMappingEnabled` handler (line 701-715)**
Add folder URI to `getConfiguration()`:
```typescript
case 'setWorkspaceMappingEnabled': {
    const folderUri = this._getWorkspaceFolderUri(this._getCurrentWorkspaceRoot() ?? undefined);
    const config = vscode.workspace.getConfiguration('switchboard', folderUri);
    const current = config.get<any>('workspaceDatabaseMappings', { enabled: false, mappings: [] });
    const enabled = typeof message.enabled === 'boolean' ? message.enabled : false;
    await config.update(
        'workspaceDatabaseMappings',
        { ...current, enabled },
        vscode.ConfigurationTarget.Workspace
    );
    this._panel?.webview.postMessage({
        type: 'workspaceMappingEnabled',
        enabled
    });
    await vscode.commands.executeCommand('switchboard.refreshUI');
    break;
}
```

**Change 3 — `saveWorkspaceMappings` handler (line 799-804)**
Add folder URI to `getConfiguration()`:
```typescript
const folderUri = this._getWorkspaceFolderUri(this._getCurrentWorkspaceRoot() ?? undefined);
const config = vscode.workspace.getConfiguration('switchboard', folderUri);
await config.update(
    'workspaceDatabaseMappings',
    incoming,
    vscode.ConfigurationTarget.Workspace
);
```

**Change 4 — `initializeWorkspaceDatabase` handler (line 871-890)**
Add folder URI to `getConfiguration()`:
```typescript
const folderUri = this._getWorkspaceFolderUri(this._getCurrentWorkspaceRoot() ?? undefined);
const config = vscode.workspace.getConfiguration('switchboard', folderUri);
const current = config.get<any>('workspaceDatabaseMappings', { enabled: false, mappings: [] });
```

**Edge Cases:** If `_getCurrentWorkspaceRoot()` returns `undefined`, `_getWorkspaceFolderUri(undefined)` should return `undefined`, and `getConfiguration('switchboard', undefined)` falls back to the current behavior — safe degradation.

### `src/extension.ts`

**Context:** The `onDidChangeConfiguration` handler (line 1179-1188) invalidates `KanbanDatabase` instances when `workspaceDatabaseMappings` changes, but does not clear the `WorkspaceIdentityService` mapping cache.

**Change — Add `clearMappingCache()` call (after line 1187)**
```typescript
if (e.affectsConfiguration('switchboard.workspaceDatabaseMappings')) {
    // Invalidate cached database instances for all workspace folders
    (vscode.workspace.workspaceFolders || []).forEach(folder => {
        KanbanDatabase.invalidateWorkspace(folder.uri.fsPath).catch(err => {
            console.error(`[Switchboard] Failed to invalidate workspace ${folder.uri.fsPath}:`, err);
        });
    });
    // Clear the mapping resolution cache so subsequent lookups use fresh config
    clearMappingCache();
    // Refresh the Kanban UI
    kanbanProvider!._scheduleBoardRefresh();
}
```

Also add the import at the top of `extension.ts`:
```typescript
import { clearMappingCache } from './services/WorkspaceIdentityService';
```

### Manual Workaround
Until the fix is implemented, manually edit `.vscode/settings.json` and change:
```json
"switchboard.workspaceDatabaseMappings": {
    "enabled": false,  // Change to true
    ...
}
```

## Verification Plan

### Automated Tests
- Add a test that verifies `getConfiguration('switchboard', folderUri)` returns the correct `enabled` value when the workspace settings file has `enabled: true`
- Add a test that verifies `setWorkspaceMappingEnabled` with a folder URI correctly persists the `enabled` state to the workspace settings
- Add a test that verifies `clearMappingCache()` is called when `workspaceDatabaseMappings` configuration changes

### Manual Verification
1. Enable workspace mapping in setup panel
2. Verify `.vscode/settings.json` shows `"enabled": true`
3. Reload window
4. Verify no "Kanban DB initialization failed" error when switching workspaces
5. Disable workspace mapping in setup panel
6. Verify `.vscode/settings.json` shows `"enabled": false`
7. Reload window — verify the mapping is truly disabled

## Recommendation
Complexity 4 → **Send to Coder**
