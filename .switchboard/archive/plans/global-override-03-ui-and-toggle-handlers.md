# Global Override 03: GLOBAL OVERRIDE UI Section & Toggle Handlers

## Goal

Add a GLOBAL OVERRIDE section as the first section of the Setup tab — two independent toggle switches (Workspace, Project) with an active-scope indicator — plus the `setWorkspaceOverride` / `setProjectOverride` backend handlers and the `overrideState` push that keeps the webview in sync.

### Problem

There is no UI for the user to turn on workspace or project scoping. The Setup tab has no override section. Users have no way to control whether their settings apply globally, per-workspace, or per-project.

### Background

The Setup tab (`#setup-tab-content` in `kanban.html`) currently starts with "Routing Configuration". The webview communicates with the backend via `postKanbanMessage`. The board already tracks `activeProjectFilter` (which can be `null`, `__unassigned__`, or a specific project name).

**Verified against code (2026-07-07):**
- `#setup-tab-content` at `kanban.html:2652`; first `db-subsection` opens at `:2654` ("Routing Configuration" header `:2655`). Section idiom: `db-subsection` > `subsection-header` + `setup-section` > `setup-field` > controls + `hint-text`.
- All CSS classes used below exist (`.db-subsection` `:1134`, `.subsection-header` `:1128`, `.setup-section` `:2012`, `.setup-field` `:2018`, `.hint-text` `:2037`, `.toggle-switch` `:1703`, `.toggle-slider` `:1717`, `.cli-toggle-inline` `:1777` with `.is-off` orange variant `:1791`). The canonical toggle idiom is the "Unknown → Auto" toggle at `:2669-2675`: outer `<label class="cli-toggle-inline" data-tooltip=...>` wrapping inner `<label class="toggle-switch">` (checkbox + slider) plus sibling `<span class="toggle-label">`.
- `postKanbanMessage` defined at `:4040` — auto-injects `workspaceRoot` if absent.
- Incoming message handler: `window.addEventListener('message', ...)` switch on `msg.type` at `:6309`. **Cases that declare `const`/`let` MUST be wrapped in `{ }`** (established pattern, e.g. `settingResult` at `:6534`) — a braceless `const` in the shared switch scope risks redeclaration/TDZ collisions.
- Initial toggle state arrives by push: webview sends `{type:'ready'}` (`:9696`) → extension `case 'ready'` (`KanbanProvider.ts:6088`) triggers full sync → `refreshWithData` (`:1300`) posts per-setting state messages (`cliTriggersState` `:1493`, `dynamicComplexityRoutingState` `:1496-1499`, etc.). `overrideState` joins this cluster.
- Webview tracks `activeProjectFilter` (declared `:3885`, updated at `:6403` and `:7235/:7251`).
- `data-tooltip` overlay tooltip system works globally (`:3762-3824`).
- There is **no existing disabled-toggle idiom** — setup toggles use `.is-off` recoloring only. Native `input.disabled` + reduced opacity on the label is net-new here and is the chosen approach.
- Backend db-write idiom inside a settings handler (verbatim from `setFeatureWorkflowMode`, `KanbanProvider.ts:6908-6913`): `const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot); const db = wsRoot ? this._getKanbanDb(wsRoot) : undefined; if (db && await db.ensureReady()) { await db.setConfig(...); }`
- Epoch invalidation goes through `_markConfigDirty()` (`:5653`) — never a manual `_configEpoch` bump.
- `setProjectFilter` method at `:5739`; its message-handler case at `:6440`.

### Root Cause

No UI exists for the override concept. The backend has no handlers for toggle events.

### Desired Outcome

A new GLOBAL OVERRIDE section as the **first** section in the Setup tab, with two independent toggle switches (Workspace, Project), an active scope indicator, and backend handlers for the toggle events. The Project switch is disabled when no specific project is selected.

**Depends on:** Plan 02 (scope-aware layer must exist for toggles to have effect).

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, feature
**Project:** switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- HTML section copies the verified toggle idiom verbatim; all CSS classes already exist.
- Toggle change → `postKanbanMessage` → backend handler → `overrideState` push-back is the exact round-trip every existing setup toggle uses.
- Tooltip and hint-text mechanics come for free.

### Complex / Risky
- State-echo loop: the `overrideState` push sets `checkbox.checked`, which must NOT re-fire a `change` post (setting `.checked` programmatically does not fire `change` — safe — but any future `dispatchEvent` refactor would loop; keep the update function write-only).
- Project-toggle enablement must track project-filter changes from BOTH directions (backend push and webview-local select changes) without drifting.
- The `setProjectOverride` handler must re-validate the filter server-side — the webview's disabled state is advisory, not a guarantee (stale webview, race with filter change).

## Edge-Case & Dependency Audit

- **Race Conditions:** user toggles Project ON in the same instant the filter switches to All Projects — backend validation (step 1 of the handler) rejects and pushes corrective `overrideState`; webview reverts the checkbox. No user-facing error UI needed for this sub-second race.
- **Security:** none — boolean toggles, no free-text input.
- **Side Effects:** each toggle triggers a settings reload + board refresh (`_markConfigDirty` + refresh); with plan 04 landed, first-ON also runs the snapshot. Toggle OFF never deletes data.
- **Dependencies & Conflicts:** depends on plan 02's fields/methods; plan 04 inserts the snapshot call into these handlers (coordinate: handlers are written here with a clearly marked snapshot insertion point). Multi-workspace: override flags live in the per-workspace kanban.db, and handlers resolve `msg.workspaceRoot` via `_resolveWorkspaceRoot` — switching workspaces in the board naturally switches override state with the rest of the config.

## Dependencies

- Plan 01 + Plan 02 must land first. No cross-feature dependencies.

## Adversarial Synthesis

Key risks: webview/backend state drift on the Project toggle enablement (mitigated: backend is authoritative, pushes `overrideState` on every toggle, filter change, and full refresh); stale toggle state after reload (mitigated: `overrideState` rides the existing `refreshWithData` push cluster fired by the `ready` flow); invalid project-toggle requests (mitigated: server-side validation with corrective push).

## Proposed Changes

### src/webview/kanban.html

**Context:** Setup tab opens `:2652`; insert the new section as the first `db-subsection` (before `:2654`). Message-handler switch `:6309`; setup-tab listeners wired inline around `:7330-7362`; UI-update-function idiom at `:4415` (`updateUnknownComplexityToggleUi`).

**1. HTML — new first section** (idiom-matched; original design preserved):

```html
<div class="db-subsection">
    <div class="subsection-header"><span>Global Override</span></div>
    <div class="setup-section">
        <div class="setup-field">
            <label class="cli-toggle-inline" id="workspace-override-label" data-tooltip="When ON, all tab settings apply to this workspace only">
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

**2. Toggle event handlers** — wire in the setup-listener block (~`:7330`), matching the existing change-listener idiom:

```javascript
document.getElementById('workspace-override-toggle')?.addEventListener('change', (e) => {
    postKanbanMessage({ type: 'setWorkspaceOverride', enabled: !!e.target?.checked });
});

document.getElementById('project-override-toggle')?.addEventListener('change', (e) => {
    postKanbanMessage({ type: 'setProjectOverride', enabled: !!e.target?.checked });
});
```

**3. `overrideState` receiver** — new case in the `:6309` switch. **Braces required** (declares consts):

```javascript
case 'overrideState': {
    const { workspaceOverride, projectOverride, projectSwitchEnabled, activeScope, activeProjectName } = msg;
    const wsToggle = document.getElementById('workspace-override-toggle');
    if (wsToggle) { wsToggle.checked = !!workspaceOverride; }
    const projToggle = document.getElementById('project-override-toggle');
    if (projToggle) {
        projToggle.checked = !!projectOverride;
        projToggle.disabled = !projectSwitchEnabled;
    }
    const projLabel = document.getElementById('project-override-label');
    if (projLabel) { projLabel.style.opacity = projectSwitchEnabled ? '1' : '0.5'; }
    const hintEl = document.getElementById('project-override-hint');
    if (hintEl) {
        hintEl.textContent = projectSwitchEnabled
            ? `All settings apply only to '${activeProjectName}', overriding workspace`
            : 'Select a project to enable project-scoped settings';
    }
    const indicator = document.getElementById('active-scope-indicator');
    if (indicator) { indicator.textContent = `Active scope: ${activeScope}`; }
    break;
}
```

Setting `.checked` programmatically does not fire `change` — the corrective push after a rejected `setProjectOverride` safely reverts the checkbox without looping.

### src/services/KanbanProvider.ts

**4. Backend handlers** — new cases in the message switch, using the verified `_resolveWorkspaceRoot` + `_getKanbanDb` idiom (`:6908-6913`):

```
case 'setWorkspaceOverride': { enabled } →
    1. [Plan 04 insertion point: snapshot-before-activate when enabling]
    2. Set _workspaceOverrideEnabled = enabled
    3. Persist: db.setConfigJson('kanban.workspaceOverrideEnabled', enabled)
    4. _loadOverrideFlags() + _reloadSettingsFromStore() (scope-aware, plan 02)
    5. _markConfigDirty()
    6. Push overrideState to webview (§5 payload)
    7. Refresh board (existing refresh flow re-pushes all *State settings messages)

case 'setProjectOverride': { enabled } →
    1. Validate _projectFilter is a specific project (truthy, not __unassigned__)
       — if not, do NOT change state; push corrective overrideState with projectSwitchEnabled=false and return
    2. [Plan 04 insertion point: snapshot-before-activate when enabling]
    3. Set _projectOverrideEnabled = enabled
    4. Persist: db.setConfigJson('kanban.projectOverrideEnabled', enabled)
    5. _loadOverrideFlags() + _reloadSettingsFromStore()
    6. _markConfigDirty()
    7. Push overrideState
    8. Refresh board
```

**Note:** The snapshot-on-first-toggle mechanism is plan 04's concern — these handlers ship with the marked insertion points; toggling ON in this plan simply changes read/write resolution.

**5. `overrideState` push helper** — one private method `_postOverrideState()`, called from: the toggle handlers above, `setProjectFilter` (`:5739`, after `_projectFilter` updates), and `refreshWithData` (`:1300`, alongside the `cliTriggersState` cluster at `:1493-1509` — this covers initial load/restore, since the `ready` flow (`:6088`) funnels through `refreshWithData`):

```typescript
private _postOverrideState(): void {
    const projectSwitchEnabled = !!this._projectFilter && this._projectFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER;
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
}
```

**Edge Cases:** project override left ON while filter moves to All Projects — flag stays persisted but the tier goes dormant (plan 02 resolution skips it) and the indicator falls back to Workspace/Global; toggling in one VS Code window while another window has the same workspace open — the other window catches up on its next refresh (accepted, same as every other setting today).

## Files to Modify

| File | Changes |
|------|---------|
| `src/webview/kanban.html` | New GLOBAL OVERRIDE section HTML (first `db-subsection`), toggle change listeners, braced `overrideState` receiver case, project-toggle disable/opacity handling |
| `src/services/KanbanProvider.ts` | `setWorkspaceOverride` / `setProjectOverride` handler cases, `_postOverrideState()` helper, push calls in `setProjectFilter` and `refreshWithData` |

## Verification Plan

### Automated Tests

Session directive: no compilation or automated test runs in this pass. Acceptance checklist for manual/UAT verification after coding:

- [ ] GLOBAL OVERRIDE section appears as the first section in Setup tab
- [ ] Both toggles render in OFF state by default
- [ ] Active scope indicator shows "Global (default)" when both OFF
- [ ] Toggling Workspace ON: indicator updates to "Workspace", backend persists state
- [ ] Toggling Project ON (with specific project selected): indicator updates to "Project 'X'"
- [ ] Project toggle is disabled/greyed when board is in unassigned/all-projects view
- [ ] Project toggle hint text updates: "Select a project..." when disabled, "All settings apply only to 'X'..." when enabled
- [ ] Attempting setProjectOverride with no project (stale webview): backend rejects, checkbox reverts, no loop
- [ ] Switching projects: Project toggle enables/disables correctly, indicator updates
- [ ] Reloading webview: toggle states restored from stored config (overrideState rides the refresh push cluster)
- [ ] Toggling either switch triggers a board settings refresh
- [ ] Tooltips appear on both toggle labels

---

**Recommendation: Send to Coder**

## Review Findings

The GLOBAL OVERRIDE section renders as the first Setup `db-subsection` using the verified toggle idiom, the `overrideState` switch case is brace-wrapped, `.checked` is set programmatically (no `change` re-fire/loop), and `setProjectOverride` re-validates the project filter server-side with a corrective push on rejection. NIT fixed: the project hint used to read "All settings apply only to 'X', overriding workspace" whenever a project was merely selected; it now branches on `projectOverride` to show a distinct "Toggle ON to apply…" message in the selected-but-OFF state. Files changed: `src/webview/kanban.html` (`overrideState` hint text). Deferred NIT: `overrideState` is pushed twice per toggle (handler + `refreshWithData`, idempotent). Remaining risk: none material.
