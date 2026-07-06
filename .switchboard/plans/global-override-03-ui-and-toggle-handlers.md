# Global Override 03: GLOBAL OVERRIDE UI Section & Toggle Handlers

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, feature
**Project:** switchboard

## Goal

### Problem

There is no UI for the user to turn on workspace or project scoping. The Setup tab has no override section. Users have no way to control whether their settings apply globally, per-workspace, or per-project.

### Background

The Setup tab (`#setup-tab-content` in `kanban.html`, starting line 2652) currently starts with "Routing Configuration". The webview communicates with the backend via `postKanbanMessage`. The board already tracks `activeProjectFilter` (which can be `null`, `__unassigned__`, or a specific project name).

### Root Cause

No UI exists for the override concept. The backend has no handlers for toggle events.

### Desired Outcome

A new GLOBAL OVERRIDE section as the **first** section in the Setup tab, with two independent toggle switches (Workspace, Project), an active scope indicator, and backend handlers for the toggle events. The Project switch is disabled when no specific project is selected.

**Depends on:** Plan 02 (scope-aware layer must exist for toggles to have effect).

## Implementation

### 1. HTML — new section in `kanban.html`

Insert as the first `<div class="db-subsection">` inside `#setup-tab-content` (before the existing "Routing Configuration" section at line 2654):

```html
<div class="db-subsection">
    <div class="subsection-header"><span>Global Override</span></div>
    <div class="setup-section">
        <div class="setup-field">
            <label class="cli-toggle-inline" data-tooltip="When ON, all tab settings apply to this workspace only">
                <label class="toggle-switch">
                    <input type="checkbox" id="workspace-override-toggle">
                    <span class="toggle-slider"></span>
                </label>
                <span class="toggle-label">Workspace</span>
            </label>
            <div class="hint-text">
                All settings in kanban.html tabs apply only to the current workspace
            </div>
            <label class="cli-toggle-inline" id="project-override-label" data-tooltip="When ON, all tab settings apply to the current project only, overriding workspace settings for this project">
                <label class="toggle-switch">
                    <input type="checkbox" id="project-override-toggle">
                    <span class="toggle-slider"></span>
                </label>
                <span class="toggle-label">Project</span>
            </label>
            <div class="hint-text" id="project-override-hint">
                All settings apply only to the current project, overriding workspace
            </div>
            <div id="active-scope-indicator" style="font-size:10px; color:var(--text-secondary); margin-top:6px;"></div>
        </div>
    </div>
</div>
```

### 2. Toggle event handlers — `kanban.html`

```javascript
document.getElementById('workspace-override-toggle')?.addEventListener('change', (e) => {
    postKanbanMessage({ type: 'setWorkspaceOverride', enabled: e.target.checked });
});

document.getElementById('project-override-toggle')?.addEventListener('change', (e) => {
    postKanbanMessage({ type: 'setProjectOverride', enabled: e.target.checked });
});
```

### 3. Override state receiver — `kanban.html`

New message handler for `overrideState`:

```javascript
case 'overrideState':
    const { workspaceOverride, projectOverride, projectSwitchEnabled, activeScope, activeProjectName } = msg;
    document.getElementById('workspace-override-toggle').checked = workspaceOverride;
    const projToggle = document.getElementById('project-override-toggle');
    projToggle.checked = projectOverride;
    projToggle.disabled = !projectSwitchEnabled;
    document.getElementById('project-override-label').style.opacity = projectSwitchEnabled ? '1' : '0.5';
    // Update hint text with project name if available
    const hintEl = document.getElementById('project-override-hint');
    hintEl.textContent = projectSwitchEnabled
        ? `All settings apply only to '${activeProjectName}', overriding workspace`
        : 'Select a project to enable project-scoped settings';
    // Update active scope indicator
    document.getElementById('active-scope-indicator').textContent = `Active scope: ${activeScope}`;
    break;
```

### 4. Backend handlers — `KanbanProvider.ts`

```
case 'setWorkspaceOverride': { enabled } →
    1. Set _workspaceOverrideEnabled = enabled
    2. Write to workspace config: db.setConfigJson('kanban.workspaceOverrideEnabled', enabled)
    3. Bump _configEpoch (triggers board refresh)
    4. Reload all settings from store (scope-aware, via _reloadSettingsFromStore)
    5. Push overrideState to webview
    6. Push refreshed settings to webview (existing settings refresh flow)

case 'setProjectOverride': { enabled } →
    1. Validate _projectFilter is a specific project (not __unassigned__, not null)
       — if not, reject and push overrideState with projectSwitchEnabled=false
    2. Set _projectOverrideEnabled = enabled
    3. Write to workspace config: db.setConfigJson('kanban.projectOverrideEnabled', enabled)
    4. Bump _configEpoch
    5. Reload all settings from store (scope-aware)
    6. Push overrideState to webview
    7. Push refreshed settings to webview
```

**Note:** The snapshot-on-first-toggle mechanism is handled in plan 04. In this plan, toggling ON simply changes the read/write resolution. The snapshot is a separate concern.

### 5. Push overrideState on project filter change

When `setProjectFilter` runs (existing flow, line 5732), after updating `_projectFilter`, also push an updated `overrideState` message so the webview can enable/disable the Project switch:

```typescript
const projectSwitchEnabled = (this._projectFilter !== null && this._projectFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
const activeProjectName = projectSwitchEnabled ? this._projectFilter : null;
const activeScope = this._projectOverrideEnabled && projectSwitchEnabled
    ? `Project '${this._projectFilter}'`
    : this._workspaceOverrideEnabled
        ? 'Workspace'
        : 'Global (default)';
this._panel?.webview.postMessage({
    type: 'overrideState',
    workspaceOverride: this._workspaceOverrideEnabled,
    projectOverride: this._projectOverrideEnabled,
    projectSwitchEnabled,
    activeScope,
    activeProjectName
});
```

### 6. Initial state push

On webview ready / panel restore, push the current `overrideState` so the toggles reflect stored state.

## Files to Modify

| File | Changes |
|------|---------|
| `src/webview/kanban.html` | New GLOBAL OVERRIDE section HTML, toggle event handlers, `overrideState` message receiver, project switch enablement logic, active scope indicator |
| `src/services/KanbanProvider.ts` | New `setWorkspaceOverride` / `setProjectOverride` message handlers, `overrideState` push on toggle + project filter change + initial load |

## Test Plan

- [ ] GLOBAL OVERRIDE section appears as the first section in Setup tab
- [ ] Both toggles render in OFF state by default
- [ ] Active scope indicator shows "Global (default)" when both OFF
- [ ] Toggling Workspace ON: indicator updates to "Workspace", backend persists state
- [ ] Toggling Project ON (with specific project selected): indicator updates to "Project 'X'"
- [ ] Project toggle is disabled/greyed when board is in unassigned/all-projects view
- [ ] Project toggle hint text updates: "Select a project..." when disabled, "All settings apply only to 'X'..." when enabled
- [ ] Switching projects: Project toggle enables/disables correctly, indicator updates
- [ ] Reloading webview: toggle states restored from stored config
- [ ] Toggling either switch triggers a board settings refresh
