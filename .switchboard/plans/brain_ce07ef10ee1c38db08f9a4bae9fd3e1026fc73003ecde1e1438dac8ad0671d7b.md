# Restore IDE Settings Storage and Implement Manual Prompt Settings Export/Import

This plan restores VS Code's editor-level settings storage as the active source of truth for prompt role configurations, reverting the automatic usage of `.switchboard/state.json`. In its place, it implements manual **Export** and **Import** buttons within the Setup tab (`setup.html`), saving/loading settings directly to/from `.switchboard/settings.json`.

## User Review Required

> [!NOTE]
> Setting configurations will remain stored within the VS Code workspace/global settings storage as they were originally. The manual Export/Import commands will write/read `.switchboard/settings.json` to allow sharing settings across IDEs and team members.

## Proposed Changes

### Configuration Core

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)
* Revert `saveRoleConfig` to only write to IDE storage (`updateSetting`) and skip writing to `state.json`.
* Revert `getRoleConfig` to only check the IDE storage (`getSetting`) and skip parsing `state.json`.
* Implement message handlers or helpers to export and import prompt settings to/from `.switchboard/settings.json`:
  * `exportPromptSettings`: Reads the role configurations for all known roles (e.g. `planner`, `coder`, `lead`, `reviewer`, `tester`, `intern`, `analyst`, `researcher`, `splitter`, `ticket_updater`) from VS Code settings and writes them formatted to `.switchboard/settings.json` in the current workspace root. Shows an info message on success.
  * `importPromptSettings`: Reads `.switchboard/settings.json` from the workspace root. If it doesn't exist, displays a warning. If it exists, updates each role configuration in the VS Code settings and triggers a UI update to refresh the view with the imported settings. Shows an info message on success.

#### [MODIFY] [SetupPanelProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/SetupPanelProvider.ts)
* Add message handling inside `_handleMessage` for the new webview message types:
  * `exportPromptSettings`: Call the export helper on `TaskViewerProvider`.
  * `importPromptSettings`: Call the import helper on `TaskViewerProvider`.

#### [MODIFY] [cleanWorkspace.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/lifecycle/cleanWorkspace.ts)
* Remove the `roleConfigs` preservation block from `readPersistedFields` since prompt settings are no longer automatically written to `state.json`.

---

### User Interface

#### [MODIFY] [setup.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html)
* Add an **Export/Import Prompt Settings** section in the **Setup** tab layout, below the *Workflow Settings* section.
* Provide two distinct buttons: `Export Settings to File` and `Import Settings from File`.
* Implement click event listeners that send `exportPromptSettings` and `importPromptSettings` messages via `vscode.postMessage`.

---

## Verification Plan

### Automated Tests
* None. (UI and manual workflows).

### Manual Verification
1. Open the Setup tab in the Switchboard panel.
2. Locate the new **Export/Import Prompt Settings** section.
3. Click **Export Settings to File**. Verify that `.switchboard/settings.json` is created with the current prompt settings.
4. Modify a prompt checkbox or text override in the Prompts tab (e.g., toggle "Safeguards" off).
5. Click **Import Settings from File** in the Setup tab. Verify that the settings restore back to the exported configuration.
