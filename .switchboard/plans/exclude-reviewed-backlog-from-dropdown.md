# Exclude Reviewed and Backlog Plans from Sidebar Dropdown

## Goal

Add a workflow setting option in setup.html to exclude plans in 'reviewed' and 'backlog' kanban columns from the sidebar dropdown, reducing clutter for plans that typically don't need immediate actioning.

## Metadata

- **Tags:** UI, UX, workflow-settings
- **Complexity:** 3

## User Review Required

No — this is a straightforward UI setting addition with a simple filter in the existing plan refresh logic.

## Complexity Audit

### Routine

- Add checkbox UI element in setup.html under WORKFLOW SETTINGS section
- Add VSCode configuration setting with default value `true`
- Add getter/setter methods in TaskViewerProvider following existing pattern
- Add message handlers in setup.html to get/set the setting
- Modify `_refreshRunSheets` to filter out plans with `kanbanColumn` matching 'reviewed' or 'backlog' when setting is enabled

### Complex / Risky

- None

## Edge-Case & Dependency Audit

**Race Conditions**
- Setting change while dropdown is open: The dropdown will refresh on next `_refreshRunSheets` call (triggered by plan mutations or manual refresh). This is acceptable.
- Plan column change while setting is enabled: Plan will be filtered out on next refresh. Acceptable.

**Security**
- No user input sent to backend beyond boolean setting. Low risk.

**Side Effects**
- When enabled, plans in 'reviewed' or 'backlog' columns will not appear in dropdown. Users can still access these plans via the kanban board.
- If a user tries to select a plan that was just filtered out, the dropdown will default to the first available plan. Acceptable.

**Dependencies & Conflicts**
- `_refreshRunSheets` (line 13556 in TaskViewerProvider.ts): Must add filter logic before mapping to sheets.
- setup.html WORKFLOW SETTINGS section (line 493): Must add new checkbox.
- setup.html tab switch handler (line 1342): Must add message to fetch the new setting.
- setup.html event listeners (line 3199): Must add change handler for the new checkbox.
- No ClickUp/Linear integration touched.

## Dependencies

None — this is a self-contained workflow settings feature.

## Adversarial Synthesis

Key risks: (1) The filter must be case-insensitive since kanban column labels may vary in casing. (2) The filter should apply to both active and completed sheets. (3) If all plans are filtered out, the dropdown should show an appropriate empty state message. Mitigations: Use case-insensitive comparison, apply filter to both arrays, rely on existing empty state handling in `renderRunSheetDropdown`.

## Proposed Changes

### `src/webview/setup.html`

**Context:** WORKFLOW SETTINGS section (lines 493-516) contains checkboxes for workflow-related settings.

**Logic:** Add a new checkbox for excluding reviewed/backlog plans from the sidebar dropdown.

**Implementation:** Add the following after the existing workflow settings checkboxes (after line 516):

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

1. Add message to fetch the setting in the 'setup' tab switch handler (around line 1342):
```javascript
'setup': () => {
    vscode.postMessage({ type: 'getGitIgnoreConfig' });
    vscode.postMessage({ type: 'getPreventAgentFileOpeningSetting' });
    vscode.postMessage({ type: 'getOpenWorktreeForCoderAgentsSetting' });
    vscode.postMessage({ type: 'getAutoCommitOnCodeReviewSetting' });
    vscode.postMessage({ type: 'getExcludeReviewedBacklogSetting' });  // NEW
},
```

2. Add message handler to receive the setting value (around line 3406, after the existing setting handlers):
```javascript
case 'excludeReviewedBacklogSetting':
    const excludeToggle = document.getElementById('exclude-reviewed-backlog-toggle');
    if (excludeToggle) {
        excludeToggle.checked = message.enabled;
    }
    break;
```

3. Add change event listener (around line 3209, after the existing workflow setting listeners):
```javascript
document.getElementById('exclude-reviewed-backlog-toggle')?.addEventListener('change', (e) => {
    vscode.postMessage({ type: 'setExcludeReviewedBacklogSetting', enabled: e.target.checked });
});
```

### `src/services/TaskViewerProvider.ts`

**Context:** Workflow settings are stored in VSCode configuration and accessed via getter/setter methods (e.g., `handleGetPreventAgentFileOpeningSetting` at line 3055).

**Logic:** Add getter and setter methods for the new setting, following the existing pattern.

**Implementation:** Add the following methods after `handleSetPreventAgentFileOpeningSetting` (around line 3062):

```typescript
public handleGetExcludeReviewedBacklogSetting(): boolean {
    return vscode.workspace.getConfiguration('switchboard').get<boolean>('excludeReviewedBacklogFromDropdown', true);
}

public async handleSetExcludeReviewedBacklogSetting(enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('switchboard');
    await config.update('excludeReviewedBacklogFromDropdown', enabled, vscode.ConfigurationTarget.Workspace);
}
```

**Context:** `_refreshRunSheets` (line 13556) builds `visibleActiveRows` and `visibleCompletedRows` from the database.

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

**Context:** Webview message handler for setup panel messages (around line 3406).

**Logic:** Add handler for the new get/set messages.

**Implementation:** Add the following cases in the message handler:

```typescript
case 'getExcludeReviewedBacklogSetting':
    this._setupPanelProvider.postMessage({
        type: 'excludeReviewedBacklogSetting',
        enabled: this.handleGetExcludeReviewedBacklogSetting()
    });
    break;

case 'setExcludeReviewedBacklogSetting':
    if (typeof data.enabled === 'boolean') {
        await this.handleSetExcludeReviewedBacklogSetting(data.enabled);
        await this._refreshRunSheets();  // Refresh dropdown to apply filter
    }
    break;
```

## Verification Plan

### Manual Testing

1. Open setup.html → Setup tab → verify new checkbox "Exclude Reviewed & Backlog from Sidebar" is visible and checked by default.
2. Create plans in different kanban columns: 'Created', 'In Progress', 'Reviewed', 'Backlog', 'Completed'.
3. With checkbox checked (default):
   - Open sidebar dropdown → verify plans in 'reviewed' and 'backlog' columns do NOT appear.
   - Verify plans in other columns appear normally.
4. Uncheck the checkbox:
   - Open sidebar dropdown → verify ALL plans appear including 'reviewed' and 'backlog'.
5. Re-check the checkbox:
   - Verify 'reviewed' and 'backlog' plans are again hidden.
6. Move a plan from 'reviewed' to 'in progress':
   - Verify it appears in dropdown after refresh.
7. Test case-insensitivity: ensure column labels 'REVIEWED', 'Reviewed', 'reviewed' are all filtered.

### Automated Tests

- None applicable (UI setting with simple filter logic, no unit-testable new code paths).

---

**Send to Intern** (Complexity: 3 — straightforward UI setting addition with simple filter logic)
