# Kanban Automation Layout and Terminal Clearing Settings Alignment

Align single-column and multi-column automation layouts, fix justified-right element styling to make them inline, add pool explanation banners, add the clear terminal before prompt checkbox to multi-column mode, and default the terminal clear behavior to `true` globally.

## Proposed Changes

### Webview Interface

#### [MODIFY] [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html)

- **Default State**:
  - Set `let clearTerminalBeforePrompt = true;` (line 3325).
- **UI Update Function (`updateClearTerminalBeforePromptUi`)**:
  - Add logic to sync the checked state of the new `mc-clear-terminal-before-prompt-toggle` element:
    ```javascript
    const mcToggle = document.getElementById('mc-clear-terminal-before-prompt-toggle');
    if (mcToggle) {
        mcToggle.checked = !!clearTerminalBeforePrompt;
    }
    ```
- **Single Column UI (`createAutobanPanel`)**:
  - **Inline Timer**: Remove `flex:1;` from `ruleLblSc.style.cssText` so it flows inline with the timer input and min label.
  - **Inline Checkbox**: In `scClearRow.style.cssText`, change `justify-content:space-between;` to `gap:8px;` so the checkbox aligns directly next to its label.
  - **Pool Banner**: Directly under `ruleRowSc`, add a container `poolBannerSc` styled like `safetyNote` that reads:
    `💡 <strong>Terminal Pools:</strong> Using terminal pools allows you to lower this value, since instructions will be rotated among terminals.`
- **Multi Column UI (`createAutobanPanel`)**:
  - **Layout/Section Reordering**: Change the append order of `multiColumnContainer` so `columnRulesSection` is added *before* `automationRulesSection` to match the single column tab order.
  - **Inline Timers**: Remove `flex:1;` from `ruleLbl.style.cssText` in the columnTransitions loop.
  - **Pool Banner**: Directly under the column rules transition loop, append a container `poolBannerMc` styled like `safetyNote` with the pool rotation explanation text.
  - **Clear Checkbox**: Add the `CLEAR TERMINAL BEFORE PROMPT:` row `mcClearRow` (styled inline with `gap:8px`) to `automationRulesSection`, using input ID `mc-clear-terminal-before-prompt-toggle`, matching the event listener logic of `sc-clear-terminal-before-prompt-toggle`.

---

### Backend Logic & Configuration

#### [MODIFY] [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts)

- Change the default fallback for `terminal.clearBeforePrompt` from `false` to `true`:
  ```typescript
  this._clearTerminalBeforePrompt = vscode.workspace.getConfiguration('switchboard').get<boolean>('terminal.clearBeforePrompt', true);
  ```

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)

- Change the default fallback for `terminal.clearBeforePrompt` from `false` to `true`:
  ```typescript
  const clearBeforePrompt = vscode.workspace.getConfiguration('switchboard').get<boolean>('terminal.clearBeforePrompt', true);
  ```

#### [MODIFY] [package.json](file:///Users/patrickvuleta/Documents/GitHub/switchboard/package.json)

- Change the default value of `"switchboard.terminal.clearBeforePrompt"` to `true` (line 239).

---

## Verification Plan

### Manual Verification
1. Launch the VS Code extension in developer host mode.
2. Open the Kanban board and navigate to the **Automation** tab.
3. Verify that single-column mode:
   - Displays the column rules (source column select and timer setting) inline.
   - Shows the new info banner under the timer settings.
   - Displays the "Clear terminal before prompt" checkbox inline.
   - The checkbox is default to `on` (checked).
4. Switch to multi-column mode and verify:
   - The order of sections is: Column Rules, Kanban Automation Rules, Terminal Pools.
   - All timer checkboxes/inputs in Column Rules are inline.
   - The pool info banner is present under the transitions list.
   - The "Clear terminal before prompt" checkbox is present in the automation rules section, aligned inline, and synchronized with the state.
5. Check the **Setup** tab and verify the "Clear before prompt" setting is checked by default.
