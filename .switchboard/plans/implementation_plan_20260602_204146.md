# Restore IDE Settings Storage and Implement Manual Prompt Settings Export/Import

This plan restores VS Code's editor-level settings storage as the active source of truth for prompt role configurations, reverting the automatic usage of `.switchboard/state.json`. In its place, it implements manual **Export** and **Import** buttons within the Setup tab (`setup.html`), saving/loading settings directly to/from `.switchboard/settings.json`.

## Goal

Revert `saveRoleConfig`/`getRoleConfig` to IDE-storage-only (removing `state.json` as a read/write path for role configs), and add manual Export/Import buttons that write/read `.switchboard/settings.json` for cross-IDE and team sharing of prompt settings.

## Metadata

- **Tags:** [frontend, backend, UX, workflow]
- **Complexity:** 5
- **Workspace:** single-repo

## User Review Required

> [!NOTE]
> Setting configurations will remain stored within the VS Code workspace/global settings storage as they were originally. The manual Export/Import commands will write/read `.switchboard/settings.json` to allow sharing settings across IDEs and team members.

## Complexity Audit

### Routine
- Removing `updateState` call from `saveRoleConfig` (single line removal)
- Removing `state.json` read block from `getRoleConfig` (single block removal)
- Removing `roleConfigs` preservation from `cleanWorkspace.ts`
- Adding two `case` branches in `SetupPanelProvider._handleMessage`
- Adding two buttons and click handlers in `setup.html`

### Complex / Risky
- Export must dynamically discover all role keys (including custom agents) from IDE storage rather than hardcoding a list — requires iterating `globalState`/`workspaceState` keys matching `switchboard.prompts.roleConfig_*`
- Import must atomically write `settings.json` (temp file + rename) and then trigger a full UI refresh across both the kanban webview (Prompts tab) and the setup panel
- Schema for `settings.json` must include a version field for forward compatibility

## Edge-Case & Dependency Audit

- **Race Conditions:** Export is a manual user action (button click), not automated — concurrent writes are extremely unlikely. Use atomic write (write to `.switchboard/.settings.json.tmp` then `fs.renameSync`) as a lightweight guard.
- **Security:** `settings.json` is a local workspace file, not exposed externally. No sensitive data beyond prompt text configurations.
- **Side Effects:** Removing `roleConfigs` from `cleanWorkspace.ts` `readPersistedFields` means existing `roleConfigs` in `state.json` will be destroyed on next workspace activation reset. This is safe because IDE storage is the surviving source of truth and `saveRoleConfig` has always written to both paths simultaneously.
- **Dependencies & Conflicts:** The kanban webview (`kanban.html`) reads role configs via `getSetting` messages → `KanbanProvider._handleMessage` → `TaskViewerProvider.getRoleConfig`. Since `getRoleConfig` is being reverted to IDE-storage-only, the kanban webview automatically follows the new path with no changes needed in `kanban.html`. However, after import, the kanban webview's in-memory `roleConfigs` variable must be refreshed by calling `loadRoleConfigs()` via a postMessage broadcast.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) Export must discover custom agent roles dynamically, not via a hardcoded list — otherwise custom agent configs are silently lost on export. (2) After import, the kanban Prompts tab must explicitly reload its `roleConfigs` variable; a simple `switchboard.refreshUI` may not trigger `loadRoleConfigs()`. (3) Removing `roleConfigs` from `cleanWorkspace.ts` will destroy any `state.json`-only data on next activation, but this is acceptable since `saveRoleConfig` has always dual-written to IDE storage. Mitigations: dynamic key discovery for export, explicit kanban refresh after import, versioned schema for `settings.json`.

## Proposed Changes

### Configuration Core

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)

**Revert `saveRoleConfig` (lines 544–568)**
- Remove the `updateState` call (lines 546–551) that writes `state.roleConfigs[roleName] = value` to `state.json`.
- Keep the `updateSetting` call (line 553) that writes to IDE storage.
- Keep the cache invalidation block (lines 555–567) that refreshes `_cachedDefaultPromptOverrides`.

Resulting method:
```typescript
public async saveRoleConfig(key: string, value: unknown): Promise<void> {
    const roleName = key.replace('roleConfig_', '');
    await this.updateSetting(`switchboard.prompts.${key}`, value);

    // Invalidate and rebuild the cached prompt overrides when a role config changes.
    if (key.startsWith('roleConfig_')) {
        const workspaceRoot = this._getWorkspaceRoot();
        if (workspaceRoot) {
            try {
                this._cachedDefaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
            } catch {
                // Silently ignore — cache will be refreshed next time the Prompts Tab is opened
            }
        }
    }
}
```

**Revert `getRoleConfig` (lines 570–588)**
- Remove the `state.json` read block (lines 571–585) that reads `state.roleConfigs[roleName]` from disk.
- Keep the `getSetting` fallback (line 587) that reads from IDE storage.

Resulting method:
```typescript
public getRoleConfig(key: string): unknown {
    return this.getSetting(`switchboard.prompts.${key}`, undefined);
}
```

**Implement `exportPromptSettings` (new public method)**
- Discover all role config keys dynamically by iterating IDE storage keys matching `switchboard.prompts.roleConfig_*`. For `globalState`, use `this._context.globalState.keys()`; for `workspaceState`, use `this._context.workspaceState.keys()`. Filter to keys starting with `switchboard.prompts.roleConfig_`.
- For each key, read the value via `this.getSetting(key, undefined)`. Skip keys with `undefined` value.
- Build a settings object with schema:
  ```json
  {
    "version": 1,
    "exportedAt": "<ISO 8601 timestamp>",
    "roleConfigs": {
      "planner": { ... },
      "coder": { ... },
      "custom_agent_xyz": { ... }
    }
  }
  ```
- Resolve the workspace root via `this._getWorkspaceRoot()`. If no workspace root, show a warning and return.
- Ensure `.switchboard/` directory exists (`fs.promises.mkdir(dir, { recursive: true })`).
- Write atomically: serialize to JSON, write to `.switchboard/.settings.json.tmp`, then `fs.renameSync` to `.switchboard/settings.json`.
- Show `vscode.window.showInformationMessage('Prompt settings exported to .switchboard/settings.json')` on success.
- On error, show `vscode.window.showErrorMessage('Failed to export prompt settings: ...')`.

**Implement `importPromptSettings` (new public method)**
- Resolve the workspace root via `this._getWorkspaceRoot()`. If no workspace root, show a warning and return.
- Read `.switchboard/settings.json` from the workspace root. If the file doesn't exist, show `vscode.window.showWarningMessage('No settings file found at .switchboard/settings.json')` and return.
- Parse the JSON. If parsing fails, show `vscode.window.showErrorMessage('Failed to parse .switchboard/settings.json: ...')` and return.
- Validate the `version` field. If version is unsupported, show an error and return.
- For each entry in `roleConfigs`, call `this.saveRoleConfig(roleConfigKey, value)` where `roleConfigKey` is `roleConfig_${roleName}`.
- After all imports, trigger UI refresh:
  - Call `vscode.commands.executeCommand('switchboard.refreshUI')`.
  - Broadcast a message to the kanban webview to reload role configs: `this._kanbanProvider?.postMessage({ type: 'reloadRoleConfigs' })` (or equivalent mechanism that triggers `loadRoleConfigs()` in the kanban webview).
- Show `vscode.window.showInformationMessage('Prompt settings imported from .switchboard/settings.json')` on success.

#### [MODIFY] [SetupPanelProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/SetupPanelProvider.ts)

**Add message handlers in `_handleMessage` (around line 122, inside the `switch` block)**
- Add case `'exportPromptSettings'`: Call `this._taskViewerProvider.exportPromptSettings()`. Post result back to webview: `this._panel.webview.postMessage({ type: 'exportPromptSettingsResult', success: true/false })`.
- Add case `'importPromptSettings'`: Call `this._taskViewerProvider.importPromptSettings()`. Post result back to webview: `this._panel.webview.postMessage({ type: 'importPromptSettingsResult', success: true/false })`.

#### [MODIFY] [cleanWorkspace.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/lifecycle/cleanWorkspace.ts)

**Remove `roleConfigs` preservation from `readPersistedFields` (lines 79–82)**
- Remove the block:
  ```typescript
  // Preserve role configurations
  if (state.roleConfigs && typeof state.roleConfigs === 'object') {
      persisted.roleConfigs = state.roleConfigs;
  }
  ```
- This is safe because role configs are now stored exclusively in IDE storage, not in `state.json`. The `saveRoleConfig` method no longer writes to `state.json`, so `state.json` will not contain `roleConfigs` going forward. Existing `roleConfigs` in `state.json` will be discarded on next workspace activation reset — this is acceptable since the data also exists in IDE storage (dual-write was always in effect).

---

### User Interface

#### [MODIFY] [setup.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html)

**Add Export/Import Prompt Settings section (inside the `#startup-fields` tab content, after the Workflow Settings section, before the "REINITIALISE PLUGIN" button)**
- Insert after the `exclude-reviewed-backlog-toggle` label (around line 521) and before the reinitialise section (line 523).
- Add a section header: `PROMPT SETTINGS EXPORT / IMPORT`.
- Add two buttons side-by-side:
  - `Export Settings to File` — sends `{ type: 'exportPromptSettings' }` via `vscode.postMessage`.
  - `Import Settings from File` — sends `{ type: 'importPromptSettings' }` via `vscode.postMessage`.
- Add a hint: `Export writes current prompt configurations to .switchboard/settings.json. Import reads from that file and updates your VS Code settings.`
- Add a status display element (`id="prompt-settings-status"`) that shows success/error feedback from the backend.
- Add a `message` event listener for `exportPromptSettingsResult` and `importPromptSettingsResult` that updates the status display with success/failure text.

---

## Verification Plan

### Automated Tests
* None. (UI and manual workflows).

### Manual Verification
1. Open the Setup tab in the Switchboard panel.
2. Locate the new **Prompt Settings Export / Import** section.
3. Click **Export Settings to File**. Verify that `.switchboard/settings.json` is created with the current prompt settings, including a `version` field and `exportedAt` timestamp.
4. Verify that custom agent role configs are included in the exported file (not just built-in roles).
5. Modify a prompt checkbox or text override in the Prompts tab (e.g., toggle "Safeguards" off).
6. Click **Import Settings from File** in the Setup tab. Verify that the settings restore back to the exported configuration.
7. Open the Kanban panel's Prompts tab and verify that the imported settings are reflected there as well.
8. Delete `.switchboard/settings.json` and click **Import Settings from File**. Verify a warning message appears.
9. Verify that `saveRoleConfig` no longer writes to `state.json` by checking that `state.json` does not contain a `roleConfigs` key after making a prompt change.
10. Verify that `getRoleConfig` still returns correct values by reading a role config and confirming it matches the IDE storage value.

### Recommendation
Complexity 5 → **Send to Coder**
