# Fix Workspace Mappings Configuration Scope Mismatch

## Goal
Fix the configuration scope mismatch in SetupPanelProvider handlers that causes workspace mappings to be wiped when the enabled state is toggled or mappings are saved.

## Metadata
- **Tags:** [bugfix, reliability, configuration]
- **Complexity:** 3

## Problem
The `setWorkspaceMappingEnabled`, `saveWorkspaceMappings`, and `initializeWorkspaceDatabase` handlers in SetupPanelProvider.ts read the config with a `folderUri` (resource scope) but write to `ConfigurationTarget.Workspace` (workspace scope). This mismatch causes the workspace-level config to be overwritten with folder-level data, wiping the existing workspace mappings.

## Root Cause
The `workspaceDatabaseMappings` setting is declared with `"scope": "resource"` in package.json (line 412), meaning it's resource-scoped (per-folder). The handlers read with `folderUri` to get the resource-scoped value, but write to `ConfigurationTarget.Workspace` which targets the workspace-level config. This scope mismatch causes the write to overwrite a different config location than where it read from, potentially wiping existing mappings.

## User Review Required
- Confirm whether stale workspace-level configs (written by the buggy code prior to this fix) should be cleaned up, or if relying on VS Code's folder-over-workspace shadowing is sufficient.

## Complexity Audit

### Routine
- Replace `ConfigurationTarget.Workspace` with the conditional `folderUri ? ConfigurationTarget.WorkspaceFolder : ConfigurationTarget.Workspace` pattern in three handlers
- The conditional pattern already exists in 4 other handlers in the same file (lines 553, 582, 1037, 1068), so this is pattern-matching, not invention
- Preserve `...current` spread in `initializeWorkspaceDatabase` handler (already present in actual code, just ensure it's not dropped)

### Complex / Risky
- None — all changes are localized to three `config.update()` call sites in a single file, following an existing pattern

## Edge-Case & Dependency Audit

### Race Conditions
- No concurrent write risk: VS Code serializes `config.update()` calls within the same extension host. Multiple rapid toggles of the enabled checkbox could interleave reads and writes, but each handler reads the current value before writing, so the last write wins (acceptable behavior).

### Security
- No security implications — configuration scope is an internal VS Code API concern, not exposed to external input.

### Side Effects
- After this fix, new writes go to `.vscode/settings.json` (folder-level) instead of the `.code-workspace` file (workspace-level). Any workspace-level configs previously written by the buggy code will remain but be shadowed by the new folder-level writes. If the folder-level config is later removed, the old workspace-level config would resurface. This is a minor operational concern, not a functional bug.

### Dependencies & Conflicts
- Depends on `workspaceDatabaseMappings` remaining `"scope": "resource"` in package.json. If the scope is ever changed to `"window"` or `"application"`, the conditional pattern would need revisiting.
- No conflicts with other handlers — the 4 handlers that already use the conditional pattern prove the approach is stable.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Hardcoding `WorkspaceFolder` without the `folderUri` fallback would introduce a new bug when no workspace folder is resolved. (2) Dropping the `...current` spread in `initializeWorkspaceDatabase` could lose future schema properties. Mitigations: Use the existing conditional pattern from 4 other handlers; preserve the spread operator.

## Proposed Changes

### `src/services/SetupPanelProvider.ts`

**Change 1 — `setWorkspaceMappingEnabled` handler (lines 702-718)**

Replace the hardcoded `ConfigurationTarget.Workspace` with the conditional pattern that matches the scope used for reading. This mirrors the pattern already used in `saveIntegrationProviderPreference` (line 553) and `savePlanningSourcePreference` (line 582):

```typescript
case 'setWorkspaceMappingEnabled': {
    const folderUri = this._getWorkspaceFolderUri(this._getCurrentWorkspaceRoot() ?? undefined);
    const config = vscode.workspace.getConfiguration('switchboard', folderUri);
    const current = config.get<any>('workspaceDatabaseMappings', { enabled: false, mappings: [] });
    const enabled = typeof message.enabled === 'boolean' ? message.enabled : false;
    await config.update(
        'workspaceDatabaseMappings',
        { ...current, enabled },
        folderUri ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace  // Changed from hardcoded Workspace
    );
    this._panel?.webview.postMessage({
        type: 'workspaceMappingEnabled',
        enabled
    });
    await vscode.commands.executeCommand('switchboard.refreshUI');
    break;
}
```

**Change 2 — `saveWorkspaceMappings` handler (lines 801-807)**

Replace the hardcoded `ConfigurationTarget.Workspace` with the conditional pattern:

```typescript
const folderUri = this._getWorkspaceFolderUri(this._getCurrentWorkspaceRoot() ?? undefined);
const config = vscode.workspace.getConfiguration('switchboard', folderUri);
await config.update(
    'workspaceDatabaseMappings',
    incoming,
    folderUri ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace  // Changed from hardcoded Workspace
);
```

**Change 3 — `initializeWorkspaceDatabase` handler (lines 874-894)**

Replace the hardcoded `ConfigurationTarget.Workspace` with the conditional pattern. Preserve the `...current` spread (already present in actual code):

```typescript
// Save the mapping config with dbPath pre-filled
const folderUri = this._getWorkspaceFolderUri(this._getCurrentWorkspaceRoot() ?? undefined);
const config = vscode.workspace.getConfiguration('switchboard', folderUri);
const current = config.get<any>('workspaceDatabaseMappings', { enabled: false, mappings: [] });
const newMapping = {
    id: message.mappingId || ('mapping-' + Date.now()),
    name: message.name || path.basename(resolvedParent),
    dbPath: derivedDbPath,
    parentFolder: resolvedParent,
    workspaceFolders,
    dropdownWorkspaces,
    mode: 'create'
};
const existingIndex = (current.mappings || []).findIndex((m: any) => m.id === newMapping.id);
const updatedMappings = existingIndex >= 0
    ? current.mappings.map((m: any) => m.id === newMapping.id ? newMapping : m)
    : [...(current.mappings || []), newMapping];
await config.update(
    'workspaceDatabaseMappings',
    { ...current, enabled: true, mappings: updatedMappings },
    folderUri ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace  // Changed from hardcoded Workspace
);
```

## Verification Plan

### Manual Verification
1. Configure workspace mappings with multiple workspaces in the setup panel
2. Save the mappings
3. Verify `.vscode/settings.json` shows all configured workspaces
4. Toggle the enabled checkbox
5. Verify `.vscode/settings.json` still shows all configured workspaces (only enabled flag changed)
6. Reload window
7. Verify the workspace dropdown in kanban.html shows the configured workspaces
8. Verify the setup panel still shows all configured workspaces
9. Test with a multi-root workspace: verify mappings are written to the correct folder-level settings
10. Test with a single-folder workspace (no `.code-workspace` file): verify `folderUri` resolves and writes go to `.vscode/settings.json`

### Automated Tests
- **Test: toggling enabled state preserves existing mappings** — Mock `vscode.workspace.getConfiguration` to return a config with `{ enabled: false, mappings: [{ id: 'test', name: 'Test', dbPath: '/tmp/test.db', workspaceFolders: [] }] }`. Call the `setWorkspaceMappingEnabled` handler with `enabled: true`. Assert the update call receives the full mappings array unchanged alongside `enabled: true`.
- **Test: saving mappings preserves all configured workspaces** — Mock config with 3 existing mappings. Call `saveWorkspaceMappings` with 2 modified mappings + 1 unchanged. Assert the update call receives all 3 mappings.
- **Test: folderUri undefined falls back to Workspace target** — Mock `_getWorkspaceFolderUri` to return `undefined`. Assert `config.update` is called with `ConfigurationTarget.Workspace` (not `WorkspaceFolder`).
- **Test: folderUri defined uses WorkspaceFolder target** — Mock `_getWorkspaceFolderUri` to return a valid URI. Assert `config.update` is called with `ConfigurationTarget.WorkspaceFolder`.

## Recommendation
Complexity 3 → **Send to Coder**
