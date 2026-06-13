# Status Bar Quick Buttons Improvements

## Goal
Fix status bar quick button configuration, labeling, and ordering issues.

## Core Problems
1. **Missing Design checkbox**: The Setup panel's Status Bar tab lacks a checkbox to control the Design button visibility, even though `switchboard.statusBar.showDesignButton` configuration exists in package.json and the status bar item is created in extension.ts
2. **Checkbox persistence failure**: Users report that checkbox selections in the Setup panel don't persist - checkboxes appear unchecked but status bar buttons still show
3. **Label inconsistency**: The "Planning Panel" terminology is used in package.json descriptions and setup.html labels, but should be "Artifacts Panel" to match the intended terminology
4. **Wrong button order**: Status bar buttons appear in wrong order - Kanban, Artifacts, and Design should appear before Agents, Clear, and Reset for better UX

## Background Context
The status bar quick buttons are configured in `src/extension.ts` with priority numbers determining their left-to-right order (higher numbers appear first). Currently:
- Agents: priority 98
- Clear: priority 97  
- Reset: priority 96
- Kanban: priority 95
- Plans (Artifacts): priority 94
- Design: priority 93

The Setup panel (`src/webview/setup.html`) has a Status Bar tab with checkboxes that should control visibility, but:
- Missing checkbox for Design button
- Hydration logic may not be reading settings correctly
- Labels use "Planning Panel" instead of "Artifacts Panel"

## Requirements
1. Add Design button checkbox to Setup panel Status Bar tab
2. Fix checkbox persistence/hydration so settings are correctly read and displayed
3. Rename "Planning Panel" to "Artifacts Panel" in:
   - package.json description for `switchboard.statusBar.showArtifactsButton`
   - setup.html checkbox label and description
   - extension.ts button text (change "Plans" to "Artifacts")
   - extension.ts tooltip (change "Open Planning Panel" to "Open Artifacts Panel")
4. Reorder status bar buttons so Kanban, Artifacts, and Design appear before Agents, Clear, and Reset by adjusting priority numbers

## Implementation Plan

### 1. Add Design Button Checkbox to Setup Panel
**File**: `src/webview/setup.html`

In the Status Bar tab content (around line 1095), add a new checkbox after the Artifacts checkbox:

```html
<label class="startup-row" style="display:flex; align-items:flex-start; gap:8px; margin-top:6px;">
    <input id="status-show-design-toggle" type="checkbox" style="width:auto; margin:0; margin-top:2px;">
    <div style="display:flex; flex-direction:column; gap:4px;">
        <span style="font-size: 11px; color: var(--text-primary); font-weight: 600;">Show Design Panel Open Button</span>
        <span style="font-size: 10px; color: var(--text-secondary); line-height: 1.4;">Show the design button on the status bar to open the Design Panel.</span>
    </div>
</label>
```

### 2. Add Design Checkbox Event Handlers
**File**: `src/webview/setup.html`

Add event listener (around line 3450, after artifacts toggle):

```javascript
document.getElementById('status-show-design-toggle')?.addEventListener('change', (e) => {
    vscode.postMessage({ type: 'setStatusShowDesignSetting', enabled: e.target.checked });
});
```

Add hydration handler (around line 4024, after artifacts hydration):

```javascript
case 'statusShowDesignSetting': {
    runSetupHydration(() => {
        const toggle = document.getElementById('status-show-design-toggle');
        if (toggle) toggle.checked = message.enabled === true;
    });
    break;
}
```

### 3. Add Design Setting Handlers in SetupPanelProvider
**File**: `src/services/SetupPanelProvider.ts`

Add get handler (around line 596, after artifacts get):

```typescript
case 'getStatusShowDesignSetting':
    this._panel.webview.postMessage({
        type: 'statusShowDesignSetting',
        enabled: this._taskViewerProvider.handleGetStatusShowDesignSetting()
    });
    break;
```

Add set handler (around line 605, after artifacts set):

```typescript
case 'setStatusShowDesignSetting':
    await this._taskViewerProvider.handleSetStatusShowDesignSetting(message.enabled);
    await vscode.commands.executeCommand('switchboard.refreshUI');
    break;
```

### 4. Add Design Setting Handlers in TaskViewerProvider
**File**: `src/services/TaskViewerProvider.ts`

Add get method:

```typescript
handleGetStatusShowDesignSetting(): boolean {
    const config = vscode.workspace.getConfiguration('switchboard');
    return config.get<boolean>('statusBar.showDesignButton', false);
}
```

Add set method:

```typescript
async handleSetStatusShowDesignSetting(enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('switchboard');
    await config.update('statusBar.showDesignButton', enabled, vscode.ConfigurationTarget.Workspace);
}
```

### 5. Rename "Planning Panel" to "Artifacts Panel"
**File**: `package.json`

Update description (line 639):

```json
"switchboard.statusBar.showArtifactsButton": {
  "type": "boolean",
  "default": false,
  "description": "Controls visibility of the Open Artifacts Panel button on the status bar.",
  "scope": "window"
}
```

**File**: `src/webview/setup.html`

Update checkbox label (line 1130):

```html
<span style="font-size: 11px; color: var(--text-primary); font-weight: 600;">Show Artifacts Panel Open Button</span>
```

Update checkbox description (line 1131):

```html
<span style="font-size: 10px; color: var(--text-secondary); line-height: 1.4;">Show the note button on the status bar to open the Artifacts Panel.</span>
```

**File**: `src/extension.ts`

Update button text (line 1770):

```typescript
artifactsStatusBarItem.text = '$(notebook) Artifacts';
```

Update tooltip (line 1771):

```typescript
artifactsStatusBarItem.tooltip = 'Open Artifacts Panel';
```

### 6. Reorder Status Bar Buttons
**File**: `src/extension.ts`

Adjust priority numbers (lines 1745-1779) so Kanban/Artifacts/Design appear before Agents/Clear/Reset. Also explicitly place the Guard item to avoid collisions:

```typescript
// Guard toggle (leftmost)
fileOpeningPreventionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
// ... existing text/tooltip/command setup ...

// Panel buttons
kanbanStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
kanbanStatusBarItem.text = '$(table) Kanban';
kanbanStatusBarItem.tooltip = 'Open Kanban Board';
kanbanStatusBarItem.command = 'switchboard.openKanban';
context.subscriptions.push(kanbanStatusBarItem);

artifactsStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
artifactsStatusBarItem.text = '$(notebook) Artifacts';
artifactsStatusBarItem.tooltip = 'Open Artifacts Panel';
artifactsStatusBarItem.command = 'switchboard.openPlanningPanel';
context.subscriptions.push(artifactsStatusBarItem);

designStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
designStatusBarItem.text = '$(paintcan) Design';
designStatusBarItem.tooltip = 'Open Design Panel';
designStatusBarItem.command = 'switchboard.openDesignPanel';
context.subscriptions.push(designStatusBarItem);

// Terminal controls (rightmost, lower priority)
terminalOpenStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
terminalOpenStatusBarItem.text = '$(hubot) Agents';
terminalOpenStatusBarItem.tooltip = 'Open Agent Terminals';
terminalOpenStatusBarItem.command = 'switchboard.createAgentGrid';
context.subscriptions.push(terminalOpenStatusBarItem);

terminalClearStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
terminalClearStatusBarItem.text = '$(paintcan) Clear';
terminalClearStatusBarItem.tooltip = 'Clear Agent Terminals';
terminalClearStatusBarItem.command = 'switchboard.clearAllTerminals';
context.subscriptions.push(terminalClearStatusBarItem);

terminalResetStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 96);
terminalResetStatusBarItem.text = '$(stop-circle) Reset';
terminalResetStatusBarItem.tooltip = 'Reset Agent Terminals';
terminalResetStatusBarItem.command = 'switchboard.deregisterAllTerminals';
context.subscriptions.push(terminalResetStatusBarItem);
```

### 7. Fix Checkbox Persistence/Hydration
**File**: `src/webview/setup.html`

No new GET requests are needed from the webview — `postSetupPanelState` in `TaskViewerProvider.ts` already pushes all status settings when the panel opens or receives the `ready` message. The real fix is:
1. Add the Design checkbox to the DOM so its hydration target exists.
2. Add the `case 'statusShowDesignSetting'` hydration handler so `postSetupPanelState` can set it.
3. (Optional but recommended) In `src/extension.ts`, update `onDidChangeConfiguration` to call `taskViewerProvider.postSetupPanelState()` after `updateStatusBarVisibility()` when any `switchboard.statusBar.*` setting changes, so the Setup panel stays in sync if the user edits `settings.json` while it is open.

## Edge Cases
- User may have manually edited settings.json - ensure migration is smooth
- Global vs workspace settings scope - confirm we're using the right scope (currently `window` for status bar settings)
- Design button may have been manually enabled via settings.json without checkbox - ensure checkbox reflects actual state

## Risks
- Priority number changes may affect other status bar items if they exist
- Hydration timing issues if DOM isn't ready when messages arrive
- User muscle memory for button locations may be disrupted by reordering

## Edge-Case & Dependency Audit

- **Race Conditions:** `runSetupHydration` in setup.html is synchronous; messages from `postSetupPanelState` arrive after DOM is loaded because the script is at the bottom of the body and `ready` is posted after listener attachment. No race.
- **Security:** No new secrets, network calls, or file I/O. All changes are local UI/config.
- **Side Effects:** Renaming the button text from "Plans" to "Artifacts" changes only the user-facing label; the command ID `switchboard.openPlanningPanel` remains unchanged to avoid breaking other webviews (implementation.html, kanban.html) that invoke it.
- **Dependencies & Conflicts:** `fileOpeningPreventionStatusBarItem` shares the current priority 99 slot with Design in the proposed code. Must be split out.

## Dependencies
- `sess_status_bar_guard_priority` — Guard item priority must be decided before reordering is applied

## Adversarial Synthesis
Key risks: priority collision with the Guard item if omitted from reordering; stale setup-panel state when settings.json is edited externally because `onDidChangeConfiguration` lacks a `postSetupPanelState` refresh. Mitigations: explicitly assign Guard a distinct priority (e.g., 102) and add a `postSetupPanelState` call inside the status-bar configuration-change branch in extension.ts.

## Proposed Changes

### `src/webview/setup.html`
- **Context:** Status Bar tab needs a Design checkbox and label rename.
- **Logic:** Add Design checkbox after Artifacts checkbox. Add event listener and hydration case. Rename "Planning Panel" to "Artifacts Panel" in label and description.
- **Implementation:** Insert checkbox HTML, `change` listener, and `case 'statusShowDesignSetting'` hydration handler at the locations specified in the original Implementation Plan steps 1 and 2.
- **Edge Cases:** Design checkbox hydration arrives via `postSetupPanelState`; no additional GET requests are required from the webview because no handlers exist for them in `SetupPanelProvider.ts`.

### `src/services/SetupPanelProvider.ts`
- **Context:** Message bridge needs Design get/set cases.
- **Logic:** Mirror the existing Artifacts get/set pattern for Design.
- **Implementation:** Insert `case 'getStatusShowDesignSetting'` and `case 'setStatusShowDesignSetting'` after the Artifacts handlers.
- **Edge Cases:** `setStatusShowDesignSetting` must trigger `switchboard.refreshUI` so `updateStatusBarVisibility` runs.

### `src/services/TaskViewerProvider.ts`
- **Context:** Config read/write methods for Design.
- **Logic:** Add `handleGetStatusShowDesignSetting` and `handleSetStatusShowDesignSetting`. Setter must use `ConfigurationTarget.Workspace` to match siblings.
- **Implementation:** Insert methods after `handleSetStatusShowArtifactsSetting`.
- **Edge Cases:** `postSetupPanelState` must also push `statusShowDesignSetting` to the setup panel (add the `postMessage` call in `postSetupPanelState`).

### `package.json`
- **Context:** Description still says "Planning Panel".
- **Logic:** Update `switchboard.statusBar.showArtifactsButton` description to "Controls visibility of the Open Artifacts Panel button on the status bar."
- **Implementation:** Single-line JSON edit.

### `src/extension.ts`
- **Context:** Reorder status bar items and rename labels.
- **Logic:** Assign distinct priorities so panel buttons (Kanban/Artifacts/Design) appear left of terminal controls (Agents/Clear/Reset) and the Guard item is explicitly placed. Rename artifacts text/title. Update `onDidChangeConfiguration` to refresh setup panel state for status-bar keys.
- **Implementation:**
  - Proposed priority layout (left-to-right): Guard 102 → Kanban 101 → Artifacts 100 → Design 99 → Agents 98 → Clear 97 → Reset 96.
  - Change `artifactsStatusBarItem.text` to `'$(notebook) Artifacts'` and `tooltip` to `'Open Artifacts Panel'`.
  - In `onDidChangeConfiguration`, after `updateStatusBarVisibility()`, also call `taskViewerProvider.postSetupPanelState()` when any status-bar setting changes, so the Setup panel stays in sync.
- **Edge Cases:** Guard item is controlled by `showAgentOpenToggle`; keeping it in the same priority neighborhood preserves its relationship while making room for the panel buttons.

## Verification Plan

### Automated Tests
- N/A — no test files cover status bar setup UI. Manual validation only per checklist below.

### Manual Validation
1. Open Setup panel → Status Bar tab, verify all 5 checkboxes exist (Agent Open, Terminals, Kanban, Artifacts, Design).
2. Check/uncheck each checkbox, verify status bar buttons show/hide correctly.
3. Edit `settings.json` directly while the Setup panel is open; verify checkboxes update within a few seconds.
4. Close and reopen VS Code, verify checkbox states persist.
5. Verify button order is: Guard (if enabled) | Kanban | Artifacts | Design | Agents | Clear | Reset.
6. Verify button text shows "Artifacts" not "Plans".
7. Verify tooltips show "Artifacts Panel" not "Planning Panel".

## Recommendation
**Send to Intern** — routine UI/config changes with a single coordination risk (Guard priority).

## Metadata
- **Tags:** ui, ux, refactor
- **Complexity:** 3

## User Review Required
- Confirm desired button order: Kanban | Artifacts | Design | Guard | Agents | Clear | Reset
- Confirm "Artifacts Panel" is the final terminology vs "Planning Panel"

## Complexity Audit

### Routine
- Adding a single checkbox and event handler to setup.html
- Adding get/set handlers in SetupPanelProvider.ts and TaskViewerProvider.ts
- Renaming labels in package.json, setup.html, and extension.ts
- Adjusting status bar priority numbers

### Complex / Risky
- Priority reordering affects the Guard item (`fileOpeningPreventionStatusBarItem`) which is currently interleaved at priority 99. It must be explicitly repositioned to avoid layout ambiguity.
- `onDidChangeConfiguration` in extension.ts does not push updated state to the Setup panel, so external edits (e.g., settings.json) leave checkboxes stale until the panel is reopened.
