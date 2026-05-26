# Exclude Reviewed and Backlog Plans from Sidebar Dropdown

## Goal

Add a workflow setting option in setup.html to exclude plans in 'reviewed' and 'backlog' kanban columns from the sidebar dropdown, reducing clutter for plans that typically don't need immediate actioning.

## Metadata

- **Tags:** UI, UX, workflow
- **Complexity:** 3

## User Review Required

No — this is a straightforward UI setting addition with a simple filter in the existing plan refresh logic.

## Complexity Audit

### Routine

- Add checkbox UI element in setup.html under WORKFLOW SETTINGS section
- Add VSCode configuration setting in package.json with default value `false`
- Add getter/setter methods in TaskViewerProvider following existing pattern
- Add message handlers in SetupPanelProvider.ts to get/set the setting
- Add message handlers in setup.html to receive the setting value
- Add change event listener in setup.html for the new checkbox
- Add broadcast in `postSetupPanelState()` for initialization consistency
- Modify `_refreshRunSheets` to filter out plans with `kanbanColumn` matching 'reviewed' or 'backlog' when setting is enabled

### Complex / Risky

- None

## Edge-Case & Dependency Audit

**Race Conditions**
- Setting change while dropdown is open: The dropdown will refresh on next `_refreshRunSheets` call (triggered by `switchboard.refreshUI`). This is acceptable.
- Plan column change while setting is enabled: Plan will be filtered out on next refresh. Acceptable.

**Security**
- No user input sent to backend beyond boolean setting. Low risk.

**Side Effects**
- When enabled, plans in 'reviewed' or 'backlog' columns will not appear in dropdown. Users can still access these plans via the kanban board.
- If a user tries to select a plan that was just filtered out, the dropdown will default to the first available plan. Acceptable.
- Default is `false` (setting off) to preserve existing behavior — existing users will not see plans disappear unexpectedly.

**Dependencies & Conflicts**
- `_refreshRunSheets` (line 13456 in TaskViewerProvider.ts): Must add filter logic before mapping to sheets (around lines 13513-13518).
- setup.html WORKFLOW SETTINGS section (line 493): Must add new checkbox after line 516.
- setup.html tab switch handler (line 1341): Must add message to fetch the new setting.
- setup.html event listeners (line 3199): Must add change handler for the new checkbox.
- setup.html message handlers (line 3531): Must add handler to receive setting value.
- SetupPanelProvider.ts (line 507): Must add get/set case handlers.
- TaskViewerProvider.ts `postSetupPanelState()` (line 3404): Must add broadcast for initialization.
- package.json configuration section (line 436): Must add new setting declaration.
- No ClickUp/Linear integration touched.

## Dependencies

None — this is a self-contained workflow settings feature.

## Adversarial Synthesis

Key risks: (1) The filter must be case-insensitive since kanban column labels may vary in casing. (2) The message handlers must be placed in SetupPanelProvider.ts (not TaskViewerProvider.ts) to match the existing architecture. (3) Defaulting to `true` would surprise existing users whose plans vanish; default `false` preserves current behavior. Mitigations: Use case-insensitive comparison, place handlers in correct file, default to `false`.

## Proposed Changes

### `package.json`

**Context:** VS Code configuration declarations are in `contributes.configuration.properties` (lines 156-465). The `switchboard.preventAgentFileOpening` entry at lines 436-440 is the closest analog.

**Logic:** Declare the new boolean setting so it appears in VS Code Settings UI and `getConfiguration().get()` works correctly.

**Implementation:** Add after line 440 (after `preventAgentFileOpening` entry):

```json
"switchboard.excludeReviewedBacklogFromDropdown": {
  "type": "boolean",
  "default": false,
  "description": "Hide plans in 'reviewed' and 'backlog' kanban columns from the sidebar dropdown."
},
```

### `src/webview/setup.html`

**Context:** WORKFLOW SETTINGS section (lines 493-516) contains three existing checkboxes: `prevent-agent-file-opening-toggle` (line 497), `open-worktree-coder-agents-toggle` (line 504), `auto-commit-code-review-toggle` (line 511).

**Logic:** Add a new checkbox for excluding reviewed/backlog plans from the sidebar dropdown.

**Implementation:** Add the following after line 516 (after the `auto-commit-code-review-toggle` label):

```html
<label class="startup-row" style="display:flex; align-items:flex-start; gap:8px; margin-top:6px;">
    <input id="exclude-reviewed-backlog-toggle" type="checkbox" style="width:auto; margin:0; margin-top:2px;">
    <div style="display:flex; flex-direction:column; gap:4px;">
        <span style="font-size: 11px; color: var(--text-primary); font-weight: 600;">Exclude Reviewed & Backlog from Sidebar</span>
        <span style="font-size: 10px; color: var(--text-secondary); line-height: 1.4;">Hide plans in 'reviewed' and 'backlog' columns from the sidebar dropdown to reduce clutter.</span>
    </div>
</label>
```

**JavaScript Changes:**

1. Add message to fetch the setting in the 'setup' tab switch handler (line 1345, after `getAutoCommitOnCodeReviewSetting`):
```javascript
'setup': () => {
    vscode.postMessage({ type: 'getGitIgnoreConfig' });
    vscode.postMessage({ type: 'getPreventAgentFileOpeningSetting' });
    vscode.postMessage({ type: 'getOpenWorktreeForCoderAgentsSetting' });
    vscode.postMessage({ type: 'getAutoCommitOnCodeReviewSetting' });
    vscode.postMessage({ type: 'getExcludeReviewedBacklogSetting' });  // NEW
},
```

2. Add message handler to receive the setting value (after line 3550, after the existing setting handlers, using the `runSetupHydration()` wrapper pattern):
```javascript
case 'excludeReviewedBacklogSetting': {
    runSetupHydration(() => {
        const toggle = document.getElementById('exclude-reviewed-backlog-toggle');
        if (toggle) toggle.checked = message.enabled === true;
    });
    break;
}
```

3. Add change event listener (after line 3209, after the existing workflow setting listeners, following the `setPreventAgentFileOpeningSetting` pattern):
```javascript
document.getElementById('exclude-reviewed-backlog-toggle')?.addEventListener('change', (e) => {
    vscode.postMessage({ type: 'setExcludeReviewedBacklogSetting', enabled: e.target.checked });
});
```

### `src/services/TaskViewerProvider.ts`

**Context:** Workflow settings are stored in VSCode configuration and accessed via getter/setter methods. The `handleGetPreventAgentFileOpeningSetting` getter is at line 3055 and its setter at line 3059.

**Logic:** Add getter and setter methods for the new setting, following the existing pattern.

**Implementation:** Add the following methods after `handleSetPreventAgentFileOpeningSetting` (after line 3062):

```typescript
public handleGetExcludeReviewedBacklogSetting(): boolean {
    return vscode.workspace.getConfiguration('switchboard').get<boolean>('excludeReviewedBacklogFromDropdown', false);
}

public async handleSetExcludeReviewedBacklogSetting(enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('switchboard');
    await config.update('excludeReviewedBacklogFromDropdown', enabled, vscode.ConfigurationTarget.Workspace);
}
```

**Context:** `_refreshRunSheets` (line 13456) builds `visibleActiveRows` and `visibleCompletedRows` from the database. The filter logic is at lines 13513-13518.

**Logic:** Apply an additional filter to exclude plans with `kanbanColumn` matching 'reviewed' or 'backlog' when the setting is enabled.

**Implementation:** Modify the filter logic (around lines 13513-13518):

```typescript
// Existing code:
const visibleActiveRows = repoScope
    ? filterGhostPlans(activeRows).filter((row) => !row.repoScope || row.repoScope === repoScope)
    : filterGhostPlans(activeRows);
const visibleCompletedRows = repoScope
    ? filterGhostPlans(completedRows).filter((row) => !row.repoScope || row.repoScope === repoScope)
    : filterGhostPlans(completedRows);

// Replace with:
const excludeReviewedBacklog = this.handleGetExcludeReviewedBacklogSetting();
const filterByColumn = (row: any) => {
    if (!excludeReviewedBacklog) return true;
    const col = (row.kanbanColumn || '').toLowerCase();
    return col !== 'reviewed' && col !== 'backlog';
};

const visibleActiveRows = repoScope
    ? filterGhostPlans(activeRows).filter(filterByColumn).filter((row) => !row.repoScope || row.repoScope === repoScope)
    : filterGhostPlans(activeRows).filter(filterByColumn);
const visibleCompletedRows = repoScope
    ? filterGhostPlans(completedRows).filter(filterByColumn).filter((row) => !row.repoScope || row.repoScope === repoScope)
    : filterGhostPlans(completedRows).filter(filterByColumn);
```

**Context:** `postSetupPanelState()` (line 3350) broadcasts setting values to the setup panel. The `preventAgentFileOpeningSetting` broadcast is at lines 3404-3407.

**Logic:** Add broadcast for the new setting so the checkbox initializes correctly when the setup panel opens.

**Implementation:** Add after line 3407 (after the `preventAgentFileOpeningSetting` broadcast):

```typescript
this._setupPanelProvider.postMessage({
    type: 'excludeReviewedBacklogSetting',
    enabled: this.handleGetExcludeReviewedBacklogSetting()
});
```

### `src/services/SetupPanelProvider.ts`

**Context:** Message handlers for setup panel settings are in SetupPanelProvider.ts, NOT TaskViewerProvider.ts. The getter handlers are at lines 507-528 and the setter handler at lines 529-532.

**Logic:** Add get and set case handlers for the new setting, following the existing pattern.

**Implementation:** Add getter case after `getAutoCommitOnCodeReviewSetting` handler (after line 528):

```typescript
case 'getExcludeReviewedBacklogSetting':
    this._panel.webview.postMessage({
        type: 'excludeReviewedBacklogSetting',
        enabled: this._taskViewerProvider.handleGetExcludeReviewedBacklogSetting()
    });
    break;
```

Add setter case after `setPreventAgentFileOpeningSetting` handler (after line 532):

```typescript
case 'setExcludeReviewedBacklogSetting':
    await this._taskViewerProvider.handleSetExcludeReviewedBacklogSetting(message.enabled);
    await vscode.commands.executeCommand('switchboard.refreshUI');
    break;
```

## Verification Plan

### Manual Testing

1. Open setup.html → Setup tab → verify new checkbox "Exclude Reviewed & Backlog from Sidebar" is visible and unchecked by default.
2. Create plans in different kanban columns: 'Created', 'In Progress', 'Reviewed', 'Backlog', 'Completed'.
3. With checkbox unchecked (default):
   - Open sidebar dropdown → verify ALL plans appear including 'reviewed' and 'backlog'.
4. Check the checkbox:
   - Open sidebar dropdown → verify plans in 'reviewed' and 'backlog' columns do NOT appear.
   - Verify plans in other columns appear normally.
5. Uncheck the checkbox:
   - Open sidebar dropdown → verify ALL plans appear including 'reviewed' and 'backlog'.
6. Move a plan from 'reviewed' to 'in progress':
   - Verify it appears in dropdown after refresh.
7. Test case-insensitivity: ensure column labels 'REVIEWED', 'Reviewed', 'reviewed' are all filtered.
8. Verify the setting persists across VS Code restarts (stored in workspace settings).
9. Verify the setting appears in VS Code Settings UI under "Switchboard" section.

### Automated Tests

- None applicable (UI setting with simple filter logic, no unit-testable new code paths).

---

**Send to Intern** (Complexity: 3 — straightforward UI setting addition with simple filter logic, changes across 4 files following well-established patterns)
