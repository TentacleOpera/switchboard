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
    await config.update('statusBar.showDesignButton', enabled, vscode.ConfigurationTarget.Global);
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

Adjust priority numbers (lines 1745-1779) so Kanban/Artifacts/Design appear before Agents/Clear/Reset:

```typescript
// Panel buttons (leftmost, higher priority)
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

Ensure the setup panel requests initial status values on load. Add to the initialization section (around line 3950+ where other getStatus calls are made):

```javascript
// Request initial status bar settings
vscode.postMessage({ type: 'getStatusShowAgentOpenSetting' });
vscode.postMessage({ type: 'getStatusShowTerminalsSetting' });
vscode.postMessage({ type: 'getStatusShowKanbanSetting' });
vscode.postMessage({ type: 'getStatusShowArtifactsSetting' });
vscode.postMessage({ type: 'getStatusShowDesignSetting' });
```

Verify that the `runSetupHydration` function properly handles the case where the message arrives before the DOM is ready, and that checkbox elements exist before attempting to set their checked state.

## Edge Cases
- User may have manually edited settings.json - ensure migration is smooth
- Global vs workspace settings scope - confirm we're using the right scope (currently `window` for status bar settings)
- Design button may have been manually enabled via settings.json without checkbox - ensure checkbox reflects actual state

## Risks
- Priority number changes may affect other status bar items if they exist
- Hydration timing issues if DOM isn't ready when messages arrive
- User muscle memory for button locations may be disrupted by reordering

## Validation
1. Open Setup panel → Status Bar tab, verify all 5 checkboxes exist (Agent Open, Terminals, Kanban, Artifacts, Design)
2. Check/uncheck each checkbox, verify status bar buttons show/hide correctly
3. Close and reopen VS Code, verify checkbox states persist
4. Verify button order is: Kanban | Artifacts | Design | Agents | Clear | Reset
5. Verify button text shows "Artifacts" not "Plans"
6. Verify tooltips show "Artifacts Panel" not "Planning Panel"

## Metadata
**Complexity:** 3
**Tags:** ui, ux, refactor
