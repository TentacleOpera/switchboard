# Surface Agent File Opening Prevention in Setup Panel

## Goal
Add the "Agent File Opening Prevention" toggle to the Switchboard Setup panel (Setup tab) instead of requiring users to find it in VS Code Settings.

## Metadata
**Tags:** UI, UX
**Complexity:** 4

## User Review Required
- Confirm the desired placement and label text for the toggle within the Setup tab.

## Context
The `switchboard.preventAgentFileOpening` setting currently exists in `package.json` but is only accessible via VS Code Settings (`Cmd+,`). Users expect to find this in the Switchboard Setup panel alongside other workflow settings like "Accurate Coding" and "Advanced Reviewer".

## Requirements

### Core Requirements
1. **Add toggle to Setup panel**: Add a toggle switch in the Setup tab UI for "Agent File Opening Prevention"
2. **Message handlers**: Add message handlers in SetupPanelProvider.ts to get/set the setting
3. **Backend method**: Add a method in TaskViewerProvider.ts to handle getting/setting the setting
4. **Keep package.json setting**: The VS Code configuration property remains as the backing store

## Complexity Audit
### Routine
- Add one message handler case in SetupPanelProvider.ts — follows existing pattern from 10+ other settings
- Add getter method in TaskViewerProvider.ts — follows existing pattern from 10+ other settings
- Add UI checkbox in setup.html — requires creating new section since "Agent Workflow Settings" section does not exist
- Add message listener case and event listener in setup.html — follows existing patterns

### Complex / Risky
- No existing setter pattern in TaskViewerProvider.ts or SetupPanelProvider.ts for workflow settings; must invent a simple `config.update` pattern.
- The underlying auto-close functionality (`switchboard.forceOpenFile` command + tab listener) exists in `package.json` but is NOT implemented in source code. The toggle will control a setting with no effect until the feature implementation plan is executed.

## Edge-Case & Dependency Audit
- **Configuration Scope**: Uses `vscode.ConfigurationTarget.Workspace` to save at workspace level (consistent with other settings).
- **UI Placement**: The Setup tab currently has no "Agent Workflow Settings" section. The toggle should be added as a new "Workflow Settings" subsection in the Setup tab, following the `global-settings-toggle` pattern at line 759.
- **Missing implementation**: The `switchboard.forceOpenFile` command is declared in `package.json` but never registered in `extension.ts`. The `preventAgentFileOpening` setting is declared but never read in source code.
- **Dependencies**: Hard dependency on the `agent_file_opening_prevention_feature.md` plan which implements the actual auto-close behavior. Without that implementation, the toggle controls a dead setting.

## Dependencies
- `agent_file_opening_prevention_feature.md` — Implements the actual auto-close behavior and `forceOpenFile` command registration. Without this, the toggle has no effect.

## Adversarial Synthesis
Key risks: The plan hallucinates an "Agent Workflow Settings" section and setter patterns that do not exist in the codebase. The underlying auto-close feature is not implemented in source code, making this a UI-only change that controls a dead setting until the dependency plan is completed. Mitigations: Add the toggle to the actual Setup tab HTML using the `global-settings-toggle` pattern, create a simple `config.update` setter, and clearly document the hard dependency on the feature implementation plan.

## Proposed Changes

### Architecture

#### 1. Add message handler to SetupPanelProvider.ts
File: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/SetupPanelProvider.ts`

Add to the `_handleMessage` switch statement (after `getAggressivePairSetting` at line 478):

```typescript
case 'getPreventAgentFileOpeningSetting':
    this._panel.webview.postMessage({
        type: 'preventAgentFileOpeningSetting',
        enabled: this._taskViewerProvider.handleGetPreventAgentFileOpeningSetting()
    });
    break;
case 'setPreventAgentFileOpeningSetting':
    await this._taskViewerProvider.handleSetPreventAgentFileOpeningSetting(message.enabled);
    await vscode.commands.executeCommand('switchboard.refreshUI');
    break;
```

#### 2. Add handler methods to TaskViewerProvider.ts
File: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts`

Add two new methods (after `handleGetAggressivePairSetting()` at line 2765):

```typescript
public handleGetPreventAgentFileOpeningSetting(): boolean {
    return vscode.workspace.getConfiguration('switchboard').get<boolean>('preventAgentFileOpening', false);
}

public async handleSetPreventAgentFileOpeningSetting(enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('switchboard');
    await config.update('preventAgentFileOpening', enabled, vscode.ConfigurationTarget.Workspace);
}
```

#### 3. Update postSetupPanelState in TaskViewerProvider.ts
File: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts`

Add to the `postSetupPanelState` method (after `aggressivePairSetting` at line 3046):

```typescript
this._setupPanelProvider.postMessage({
    type: 'preventAgentFileOpeningSetting',
    enabled: this.handleGetPreventAgentFileOpeningSetting()
});
```

#### 4. Add UI to setup.html
File: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html`

Insert into the "setup" tab content, after the git-ignore warning and before the OPEN DOCS button (around line 573):

```html
<div style="font-size: 10px; color: var(--text-secondary); margin: 12px 0 4px; font-family: var(--font-mono); letter-spacing: 1px;">
    WORKFLOW SETTINGS
</div>
<label class="startup-row" style="display:flex; align-items:flex-start; gap:8px; margin-top:6px;">
    <input id="prevent-agent-file-opening-toggle" type="checkbox" style="width:auto; margin:0; margin-top:2px;">
    <div style="display:flex; flex-direction:column; gap:4px;">
        <span style="font-size: 11px; color: var(--text-primary); font-weight: 600;">Agent File Opening Prevention</span>
        <span style="font-size: 10px; color: var(--text-secondary); line-height: 1.4;">Auto-close any file that gets opened in the editor. Use "Override Open" right-click to bypass.</span>
    </div>
</label>
```

Add the event listener near other toggle listeners (around line 3853):

```javascript
document.getElementById('prevent-agent-file-opening-toggle')?.addEventListener('change', (e) => {
    vscode.postMessage({ type: 'setPreventAgentFileOpeningSetting', enabled: e.target.checked });
});
```

Add the request when the Setup tab loads (in the `setup` tab callback at line 1498):

```javascript
'setup': () => {
    vscode.postMessage({ type: 'getGitIgnoreConfig' });
    vscode.postMessage({ type: 'getPreventAgentFileOpeningSetting' });
},
```

Add the message handler in the message listener section (near `julesAutoSyncSetting` or `globalSettingsEnabled`, around line 4175):

```javascript
case 'preventAgentFileOpeningSetting': {
    runSetupHydration(() => {
        const toggle = document.getElementById('prevent-agent-file-opening-toggle');
        if (toggle) toggle.checked = message.enabled === true;
    });
    break;
}
```

## Verification Plan
### Manual Tests
1. **Open Setup panel**: Open Switchboard Setup → Setup tab
2. **Verify toggle visible**: "Agent File Opening Prevention" checkbox should appear in a new "Workflow Settings" subsection
3. **Toggle ON**: Enable the toggle → verify VS Code setting `switchboard.preventAgentFileOpening` is set to `true`
4. **Toggle OFF**: Disable the toggle → verify VS Code setting is set to `false`
5. **Persist across reloads**: Set toggle, close and reopen Setup panel → verify toggle state matches saved setting
6. **Verify context menu**: With toggle ON, right-click in editor/explorer → "Override Open" should be visible (requires `forceOpenFile` command registration from dependency plan)

## Recommendation
**Send to Coder.**

---

## Execution Status
**Status:** Completed  
**Date:** 2026-05-11

### Files Changed
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/SetupPanelProvider.ts` — Added `getPreventAgentFileOpeningSetting` and `setPreventAgentFileOpeningSetting` message handlers
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts` — Added `handleGetPreventAgentFileOpeningSetting()` and `handleSetPreventAgentFileOpeningSetting()` methods; added `preventAgentFileOpeningSetting` post message in `postSetupPanelState()`
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html` — Added "Workflow Settings" section with toggle UI, event listener, tab load callback, and message handler

### Validation
- TypeScript compilation passes (`tsc --noEmit` exits 0)
- All changes follow existing patterns for settings like `aggressivePairSetting`, `leadChallengeSetting`, etc.

### Remaining Risks
- The toggle controls `switchboard.preventAgentFileOpening`, but the underlying auto-close behavior (`switchboard.forceOpenFile` command + tab listener) is **not yet implemented** in source code. The toggle has no effect until the dependency plan `agent_file_opening_prevention_feature.md` is executed.
