# Consolidate Workspace and Project Dropdowns in kanban.html

## Goal
Consolidate the separate workspace and project dropdowns in the kanban board into a single unified dropdown with the format `[workspace] > [project]`, along with a single "Assign" button. Merge both top bars (controls-strip and project-strip) into a single bar, eliminating the second bar entirely.

## Metadata
- **Tags:** [frontend, UI, UX]
- **Complexity:** 6

## User Review Required
- The unified dropdown will serve dual purposes: view switching (changing the displayed workspace/project) and assignment target selection. Confirm this is the desired UX.
- The `btn-add-project` and `btn-delete-project` buttons will operate on the workspace/project selected in the unified dropdown, not necessarily the currently viewed workspace. Confirm this behavior.
- Project filtering will be integrated into the unified dropdown (selecting a project within the current workspace filters the board). Confirm this replaces the separate project filter dropdown.

## Complexity Audit

### Routine
- HTML structure changes (remove second bar, merge elements into first bar, add unified dropdown and button)
- CSS style for the new `.workspace-project-select` class and `.strip-divider`
- Remove `.project-strip`, `.workspace-select`, `.project-select` CSS styles
- Button visibility/count logic in `updateReassignButtonVisibility()`
- Confirmation dialog text updates
- Removing obsolete functions, event listeners, and orphan CSS/JS references

### Complex / Risky
- Backend must send project data for ALL workspaces (currently only sends for current workspace) — requires extending `updateWorkspaceSelection` message with `allWorkspaceProjects` field
- Unified assign handler must branch: same-workspace (project assignment only via `assignSelectedToProject`) vs cross-workspace (workspace reassignment via `reassignPlansWorkspace` + optional project assignment)
- The unified dropdown change handler must correctly trigger `selectWorkspace` (when workspace changes) or `setProjectFilter` (when only project changes within same workspace)
- `btn-add-project` and `btn-delete-project` must target the workspace/project selected in the unified dropdown, requiring value parsing
- Selection restoration logic from `updateWorkspaceSelector()` (explicit root override, active filter fallback) must be preserved in the new function

## Edge-Case & Dependency Audit
- **Race Conditions:** If user changes the unified dropdown and clicks ASSIGN before the board refreshes, `selectedCards` may reference plans that no longer match the visible board state. Mitigation: disable the ASSIGN button during board refresh (add a `_boardRefreshing` flag).
- **Security:** No new security concerns. All assignment operations already validate workspace IDs and plan ownership.
- **Side Effects:** Removing `project-select` removes the project filter dropdown. The unified dropdown must take over this filtering role via its change handler sending `setProjectFilter`.
- **Dependencies & Conflicts:** The `selectWorkspace` message flow depends on the workspace-select change handler. The consolidated dropdown must preserve this flow. The `workspace-reset-control-plane` button must remain functional and operate on the currently viewed workspace (not the assignment target).

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) Backend currently only sends projects for the current workspace — consolidation requires all-workspace project data, requiring a backend data flow change with caching to avoid N extra DB queries per refresh. (2) The unified assign handler must correctly branch between same-workspace project assignment and cross-workspace reassignment, as these use fundamentally different backend operations (in-DB field update vs cross-DB record transfer). (3) The dual-purpose dropdown (view switching + assignment) may confuse users when switching workspaces causes selected cards to disappear. Mitigations: Extend the backend message to include cached `allWorkspaceProjects`; branch the assign handler based on target vs current workspace comparison; add a "N cards selected from [workspace]" indicator after workspace switch.

## Current State
- Two horizontal bars at the top of the kanban board:
  - **Bar 1** (`.controls-strip`, lines 1932-1950): Automation controls — START AUTOMATION button, CLI Triggers toggle, Pair Programming dropdown, COLLAPSE CODERS button
  - **Bar 2** (`.project-strip`, lines 1951-1964): Workspace/project controls — workspace dropdown, ASSIGN TO WORKSPACE button, filter badges, RESET AUTO-DETECT button, project dropdown, ASSIGN TO PROJECT button, add/delete project buttons
- Users must select workspace and project separately
- Two separate assign operations required
- Projects in `project-select` are scoped to the currently selected workspace only
- `workspace-select` change triggers `selectWorkspace` message (switches board context)
- `project-select` change triggers `setProjectFilter` message (filters board by project)

## Desired State
- Single dropdown with format: `[workspace] > [project]`
  - Example: `switchboard > all projects` or `switchboard > my-project`
- Single "Assign" button that assigns selected cards to the selected [workspace, project] pair
- When project is "all projects", project = none in the assignment
- Selecting a different workspace in the dropdown switches the board view (preserves current `selectWorkspace` behavior)
- Selecting a different project within the same workspace filters the board (preserves current `setProjectFilter` behavior)
- **Single bar** — all controls merged into one `.controls-strip`, the `.project-strip` bar is removed entirely

## Implementation Plan

### 1. Update HTML Structure — Merge Two Bars Into One
**File**: `src/webview/kanban.html`

**Current HTML — Bar 1 (`.controls-strip`, lines 1932-1950):**
```html
<div class="controls-strip">
    <button class="strip-btn" id="btn-autoban" data-tooltip="Start or stop the automation engine">▶ START AUTOMATION</button>
    <div class="autoban-timers-inline" id="autoban-timers-inline"></div>
    <label class="cli-toggle-inline" id="cli-toggle" data-tooltip="When OFF, moves and prompts do not trigger CLI agent actions">
        <label class="toggle-switch">
            <input type="checkbox" id="cli-triggers-toggle" checked>
            <span class="toggle-slider"></span>
        </label>
        <span class="toggle-label">CLI Triggers</span>
    </label>
    <select id="pairProgrammingModeSelect" class="kanban-mode-dropdown" data-tooltip="Pair Programming mode: controls how Lead and Coder prompts are dispatched">
        <option value="off">Pair Programming: Off</option>
        <option value="cli-cli">CLI Lead + CLI Coder</option>
        <option value="cli-ide">CLI Lead + IDE Coder</option>
        <option value="ide-cli">IDE Lead + CLI Coder</option>
        <option value="ide-ide">IDE Lead + IDE Coder</option>
    </select>
    <button class="strip-btn" id="btn-collapse-coders" data-tooltip="Toggle collapsed coder columns view">⇥ COLLAPSE CODERS</button>
</div>
```

**Current HTML — Bar 2 (`.project-strip`, lines 1951-1964):**
```html
<div class="project-strip" id="project-strip">
    <select id="workspace-select" class="workspace-select" data-tooltip="Select workspace" style="min-width:180px;"></select>
    <button class="strip-btn is-teal" id="btn-reassign-workspace" data-tooltip="Assign selected plan(s) to this workspace" disabled>ASSIGN TO WORKSPACE</button>
    <span id="workspace-filter-badge" class="workspace-filter-badge" hidden></span>
    <span id="workspace-control-plane-badge" class="workspace-filter-badge" hidden></span>
    <button id="workspace-reset-control-plane" class="strip-btn" hidden>RESET AUTO-DETECT</button>
    <select id="project-select" class="project-select" title="Filter by project">
        <option value="">All Projects</option>
    </select>
    <button id="btn-assign-project" class="strip-btn is-teal" title="Assign selected plans to project" disabled>ASSIGN TO PROJECT</button>
    <button class="btn-add-plan" id="btn-add-project" data-tooltip="Add new project">+</button>
    <button id="btn-delete-project" class="strip-btn" title="Delete selected project" style="display:none;">DELETE PROJECT</button>
    <span id="project-filter-badge" class="workspace-filter-badge" hidden></span>
</div>
```

**New HTML — Single merged bar (replaces both bars):**
```html
<div class="controls-strip">
    <button class="strip-btn" id="btn-autoban" data-tooltip="Start or stop the automation engine">▶ START AUTOMATION</button>
    <div class="autoban-timers-inline" id="autoban-timers-inline"></div>
    <label class="cli-toggle-inline" id="cli-toggle" data-tooltip="When OFF, moves and prompts do not trigger CLI agent actions">
        <label class="toggle-switch">
            <input type="checkbox" id="cli-triggers-toggle" checked>
            <span class="toggle-slider"></span>
        </label>
        <span class="toggle-label">CLI Triggers</span>
    </label>
    <select id="pairProgrammingModeSelect" class="kanban-mode-dropdown" data-tooltip="Pair Programming mode: controls how Lead and Coder prompts are dispatched">
        <option value="off">Pair Programming: Off</option>
        <option value="cli-cli">CLI Lead + CLI Coder</option>
        <option value="cli-ide">CLI Lead + IDE Coder</option>
        <option value="ide-cli">IDE Lead + CLI Coder</option>
        <option value="ide-ide">IDE Lead + IDE Coder</option>
    </select>
    <button class="strip-btn" id="btn-collapse-coders" data-tooltip="Toggle collapsed coder columns view">⇥ COLLAPSE CODERS</button>
    <span class="strip-divider"></span>
    <select id="workspace-project-select" class="workspace-project-select" data-tooltip="Select workspace and project" style="min-width:280px;"></select>
    <button class="strip-btn is-teal" id="btn-assign-workspace-project" data-tooltip="Assign selected plan(s) to this workspace/project" disabled>ASSIGN</button>
    <span id="workspace-filter-badge" class="workspace-filter-badge" hidden></span>
    <span id="workspace-control-plane-badge" class="workspace-filter-badge" hidden></span>
    <button id="workspace-reset-control-plane" class="strip-btn" hidden>RESET AUTO-DETECT</button>
    <button class="btn-add-plan" id="btn-add-project" data-tooltip="Add new project">+</button>
    <button id="btn-delete-project" class="strip-btn" title="Delete selected project" style="display:none;">DELETE PROJECT</button>
    <span id="project-filter-badge" class="workspace-filter-badge" hidden></span>
</div>
```

**Changes:**
- Remove entire `.project-strip` div (lines 1951-1964) — the second bar is eliminated
- Remove `workspace-select` dropdown
- Remove `btn-reassign-workspace` button
- Remove `project-select` dropdown
- Remove `btn-assign-project` button
- Add `workspace-project-select` unified dropdown to `.controls-strip`
- Add `btn-assign-workspace-project` unified assign button to `.controls-strip`
- Add `strip-divider` span as a visual separator between automation controls and workspace/project controls
- Move `workspace-filter-badge`, `workspace-control-plane-badge`, `workspace-reset-control-plane`, `btn-add-project`, `btn-delete-project`, `project-filter-badge` into `.controls-strip`
- All existing `.controls-strip` elements (autoban, CLI toggle, pair programming, collapse coders) remain unchanged

### 2. Update CSS

**File**: `src/webview/kanban.html`

**Add new style** for the unified dropdown (replacing both `.workspace-select` and `.project-select`):
```css
.workspace-project-select {
    background: #0a0a0a;
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: 2px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.5px;
    padding: 4px 8px;
    min-width: 280px;
}

.workspace-project-select:focus {
    outline: none;
    border-color: var(--accent-teal-dim);
}
```

**Add new style** for the visual divider between control groups:
```css
.strip-divider {
    display: inline-block;
    width: 1px;
    height: 16px;
    background: var(--border-color);
    margin: 0 4px;
    flex-shrink: 0;
}
```

**Remove** `.workspace-select` style (lines 71-81), `.project-select` style (lines 115-130), and `.project-strip` style (lines 106-113) — all no longer referenced.

**Update** `.controls-strip` style (lines 96-104) — already has `flex-wrap: wrap` which will handle overflow gracefully. No changes needed to the base style, but verify the bar renders correctly with the additional elements at various viewport widths.

### 3. Update JavaScript — New Global Variable

**File**: `src/webview/kanban.html`

Add near line 3051 (where `workspaceItems` is declared):
```javascript
let allWorkspaceProjects = {}; // Map<workspaceRoot, string[]> — projects per workspace
```

### 4. Update JavaScript — New Function: `updateWorkspaceProjectDropdown()`

**File**: `src/webview/kanban.html`

**Replaces**: `updateWorkspaceSelector()` (line 3309) and `updateProjectDropdown()` (line 3069)

**Location**: Replace `updateWorkspaceSelector()` at line 3309

```javascript
function updateWorkspaceProjectDropdown(explicitRoot = null) {
    const select = document.getElementById('workspace-project-select');
    if (!select) return;

    // Save the current selection BEFORE rebuilding options
    const savedValue = select.value;

    // Clear and rebuild
    select.innerHTML = '';

    for (const item of workspaceItems) {
        const wsRoot = item.workspaceRoot;
        const wsLabel = buildWorkspaceOptionLabel(item);
        const projects = allWorkspaceProjects[wsRoot] || [];

        // "All Projects" option for this workspace
        const allOpt = document.createElement('option');
        allOpt.value = wsRoot + '|';
        allOpt.textContent = wsLabel + ' > All Projects';
        allOpt.dataset.workspaceRoot = wsRoot;
        allOpt.dataset.project = '';
        if (item.controlPlaneAction || item.selectionMode) {
            allOpt.dataset.controlPlaneAction = item.controlPlaneAction || item.selectionMode;
        }
        select.appendChild(allOpt);

        // Per-project options
        for (const proj of projects) {
            const opt = document.createElement('option');
            opt.value = wsRoot + '|' + proj;
            opt.textContent = wsLabel + ' > ' + proj;
            opt.dataset.workspaceRoot = wsRoot;
            opt.dataset.project = proj;
            select.appendChild(opt);
        }
    }

    // Restore selection logic (preserved from updateWorkspaceSelector)
    if (explicitRoot && workspaceItems.some(item => item.workspaceRoot === explicitRoot)) {
        // If the backend explicitly changed workspace, honor that
        const targetProject = activeProjectFilter || '';
        const targetValue = explicitRoot + '|' + targetProject;
        if ([...select.options].some(o => o.value === targetValue)) {
            select.value = targetValue;
        } else {
            select.value = explicitRoot + '|';
        }
        return;
    }

    // Try to restore saved selection
    if (savedValue && [...select.options].some(o => o.value === savedValue)) {
        select.value = savedValue;
    } else {
        // Fall back to current workspace + active project filter
        let fallbackRoot = activeWorkspaceFilter
            ? ((workspaceItems.find(item => getWorkspaceItemRepoScope(item) === activeWorkspaceFilter) || {}).workspaceRoot || currentWorkspaceRoot)
            : currentWorkspaceRoot;
        if (fallbackRoot && !workspaceItems.some(item => item.workspaceRoot === fallbackRoot)) {
            fallbackRoot = workspaceItems[0]?.workspaceRoot || '';
        }
        if (fallbackRoot) {
            const fallbackProject = activeProjectFilter || '';
            const fallbackValue = fallbackRoot + '|' + fallbackProject;
            if ([...select.options].some(o => o.value === fallbackValue)) {
                select.value = fallbackValue;
            } else {
                select.value = fallbackRoot + '|';
            }
        }
    }
}
```

**Key design decisions:**
- Uses `data-workspace-root` and `data-project` attributes on each `<option>` for clean parsing (instead of splitting on `|`)
- Value format: `workspaceRoot|projectName` (empty projectName = "All Projects")
- Preserves `data-control-plane-action` attribute on workspace-level ("All Projects") options
- Preserves selection restoration logic from `updateWorkspaceSelector()` (explicit root override, active filter fallback)

### 5. Update JavaScript — `updateReassignButtonVisibility()`

**File**: `src/webview/kanban.html` (line 5505)

**Replace** the existing function:
```javascript
function updateReassignButtonVisibility() {
    const btn = document.getElementById('btn-assign-workspace-project');
    if (btn) {
        const count = selectedCards.size;
        if (count > 0) {
            btn.disabled = false;
            btn.textContent = `ASSIGN (${count})`;
        } else {
            btn.disabled = true;
            btn.textContent = 'ASSIGN';
        }
    }
}
```

### 6. Update JavaScript — New Unified Assign Handler

**File**: `src/webview/kanban.html`

**Replaces**: `btn-reassign-workspace` click handler (line 5524) and `btn-assign-project` click handler (line 3103)

```javascript
document.getElementById('btn-assign-workspace-project')?.addEventListener('click', () => {
    const sessionIds = Array.from(selectedCards);

    const select = document.getElementById('workspace-project-select');
    const selectedOption = select?.selectedOptions?.[0];
    if (!selectedOption || sessionIds.length === 0) return;

    const targetWorkspaceRoot = selectedOption.dataset.workspaceRoot || '';
    const targetProject = selectedOption.dataset.project || '';

    if (!targetWorkspaceRoot) return;

    // Build confirmation label
    const wsLabel = selectedOption.textContent || targetWorkspaceRoot;
    const isSameWorkspace = path.resolve(targetWorkspaceRoot) === path.resolve(currentWorkspaceRoot || '');

    if (isSameWorkspace && !targetProject) {
        // No-op: same workspace, no project
        vscode?.postMessage?.({ type: 'showInfo', message: 'Plans are already in this workspace with no project assignment.' });
        return;
    }

    // Confirm before reassigning
    const projectLabel = targetProject || 'All Projects';
    if (!confirm(`Assign ${sessionIds.length} plan${sessionIds.length === 1 ? '' : 's'} to ${wsLabel}?\n\nProject: ${projectLabel}${!isSameWorkspace ? '\n\nThese plans will disappear from the current board and appear under the target workspace.' : ''}`)) {
        return;
    }

    if (!isSameWorkspace) {
        // Cross-workspace: reassign to target workspace first
        postKanbanMessage({
            type: 'reassignPlansWorkspace',
            sessionIds: sessionIds,
            targetWorkspaceRoot: targetWorkspaceRoot
        });

        // Then assign project if specified (sent after workspace reassignment completes)
        // Note: The backend will refresh the board after reassignPlansWorkspace.
        // Project assignment for the moved plans will be handled by sending a
        // follow-up assignSelectedToProject message targeting the new workspace.
        if (targetProject) {
            // Clarification: This follow-up must be sent AFTER the reassignment completes.
            // The simplest approach is to include project info in the reassign message
            // and let the backend handle both operations atomically (see Step 8).
            // Alternatively, send a delayed follow-up message.
        }
    } else {
        // Same workspace: project assignment only
        postKanbanMessage({
            type: 'assignSelectedToProject',
            projectName: targetProject,
            planIds: sessionIds
        });
    }

    // Optimistically clear the selection
    selectedCards.clear();
    updateReassignButtonVisibility();

    // Un-select visually on screen
    document.querySelectorAll('.kanban-card.selected').forEach(el => {
        el.classList.remove('selected');
    });
});
```

**Important branching logic:**
- **Same workspace + project specified** → Send `assignSelectedToProject` only
- **Same workspace + no project** → No-op (show info message)
- **Different workspace + no project** → Send `reassignPlansWorkspace` only
- **Different workspace + project specified** → Send `reassignPlansWorkspace` + project assignment (see Step 8 for atomic handling)

### 7. Update JavaScript — New Unified Dropdown Change Handler

**File**: `src/webview/kanban.html`

**Replaces**: `workspace-select` change handler (line 5556) and `project-select` change handler (line 3091)

```javascript
document.getElementById('workspace-project-select')?.addEventListener('change', (event) => {
    const selectedOption = event.target.selectedOptions?.[0];
    if (!selectedOption) return;

    const selectedWorkspaceRoot = selectedOption.dataset.workspaceRoot || '';
    const selectedProject = selectedOption.dataset.project || '';
    const controlPlaneAction = selectedOption.dataset.controlPlaneAction || undefined;

    const isDifferentWorkspace = selectedWorkspaceRoot !== currentWorkspaceRoot;

    if (isDifferentWorkspace) {
        // Switch workspace context (triggers full board refresh)
        lastBoardSignature = '';
        postKanbanMessage({
            type: 'selectWorkspace',
            workspaceRoot: selectedWorkspaceRoot,
            controlPlaneAction: controlPlaneAction
        });
    } else if (selectedProject !== (activeProjectFilter || '')) {
        // Same workspace, different project filter
        postKanbanMessage({
            type: 'setProjectFilter',
            project: selectedProject || null
        });
    }

    // Update delete button visibility
    const btnDeleteProject = document.getElementById('btn-delete-project');
    if (btnDeleteProject) {
        btnDeleteProject.style.display = selectedProject ? '' : 'none';
    }
});
```

### 8. Update Extension Side — Atomic Cross-Workspace + Project Assignment

**File**: `src/services/KanbanProvider.ts`

**Option A (Recommended): Extend `reassignPlansWorkspace` handler to accept optional `targetProject`**

Update the `reassignPlansWorkspace` case (line 3988) to accept an optional `targetProject` field:
```typescript
case 'reassignPlansWorkspace': {
    const sessionIds: string[] = msg.sessionIds;
    const targetWorkspaceRoot: string = msg.targetWorkspaceRoot;
    const targetProject: string | undefined = msg.targetProject; // NEW

    // ... existing validation ...

    for (const sessionId of sessionIds) {
        // ... existing plan retrieval and upsert logic ...

        try {
            const ok = await targetDb.upsertPlan({
                ...plan,
                workspaceId: targetWorkspaceId,
                project: targetProject !== undefined ? targetProject : plan.project, // NEW: override project if specified
                updatedAt: new Date().toISOString()
            });
            // ... existing soft-delete logic ...
        } catch (err) { /* ... existing error handling ... */ }
    }

    // ... existing refresh and feedback ...
    break;
}
```

This approach is preferred because:
- Reuses existing, tested backend handler
- Makes the cross-workspace + project assignment atomic (single transaction per plan)
- No new message type needed
- The `upsertPlan` method already accepts a full plan object, so overriding `project` is trivial

**Frontend update for cross-workspace + project case:**
```javascript
// In the assign handler, for cross-workspace + project:
postKanbanMessage({
    type: 'reassignPlansWorkspace',
    sessionIds: sessionIds,
    targetWorkspaceRoot: targetWorkspaceRoot,
    targetProject: targetProject  // NEW: included in same message
});
```

### 9. Update Extension Side — Send All Workspace Projects

**File**: `src/services/KanbanProvider.ts`

Add a helper method to collect projects for all known workspaces:
```typescript
private async _getAllWorkspaceProjects(): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = {};
    const roots = this._getWorkspaceRoots();
    const allowedRoots = this._getAllowedRoots();
    const allRoots = [...new Set([...roots, ...allowedRoots])];

    for (const root of allRoots) {
        try {
            const db = this._getKanbanDb(root);
            if (await db.ensureReady()) {
                const workspaceId = await db.getWorkspaceId();
                if (workspaceId) {
                    result[path.resolve(root)] = await db.getProjects(workspaceId);
                }
            }
        } catch {
            // Skip unavailable workspaces
            result[path.resolve(root)] = [];
        }
    }
    return result;
}
```

Then update all three places where `updateWorkspaceSelection` is sent (lines 1016-1022, 1755-1761, 1883-1889) to include `allWorkspaceProjects`:
```typescript
const allWorkspaceProjects = await this._getAllWorkspaceProjects();

this._panel.webview.postMessage({
    type: 'updateWorkspaceSelection',
    workspaceRoot: resolvedWorkspaceRoot,
    workspaces: workspaceItems,
    activeFilter: this._repoScopeFilter || null,
    projectFilter: this._projectFilter || null,
    projects: projList,  // Keep for backward compatibility
    allWorkspaceProjects  // NEW: projects for all workspaces
});
```

**Performance consideration:** Cache the result of `_getAllWorkspaceProjects()` and invalidate only when a project is added/deleted or a workspace is added/removed. This avoids N extra DB queries on every board refresh.

### 10. Update JavaScript — `updateWorkspaceSelection` Message Handler

**File**: `src/webview/kanban.html` (line 4951)

Update the `updateWorkspaceSelection` case:
```javascript
case 'updateWorkspaceSelection': {
    const previousRoot = currentWorkspaceRoot;
    currentWorkspaceRoot = msg.workspaceRoot || '';
    activeWorkspaceFilter = msg.activeFilter || null;
    workspaceItems = Array.isArray(msg.workspaces) ? msg.workspaces : [];
    currentControlPlaneMode = msg.controlPlaneMode || msg.mode || 'none';
    currentControlPlaneRoot = msg.controlPlaneRoot || msg.effectiveControlPlaneRoot || '';

    // Store all workspace projects (NEW)
    if (msg.allWorkspaceProjects && typeof msg.allWorkspaceProjects === 'object') {
        allWorkspaceProjects = msg.allWorkspaceProjects;
    }

    const explicitChange = previousRoot !== '' && previousRoot !== currentWorkspaceRoot;

    // Call unified dropdown function instead of separate functions
    updateWorkspaceProjectDropdown(explicitChange ? currentWorkspaceRoot : null);
    updateWorkspaceFilterBadge();

    // Update project filter badge
    const projectFilterBadge = document.getElementById('project-filter-badge');
    if (projectFilterBadge) {
        if (msg.projectFilter) {
            projectFilterBadge.textContent = 'PROJECT: ' + msg.projectFilter;
            projectFilterBadge.hidden = false;
        } else {
            projectFilterBadge.hidden = true;
        }
    }
    break;
}
```

### 11. Update JavaScript — `btn-add-project` Handler

**File**: `src/webview/kanban.html` (line 3099)

```javascript
btnAddProject?.addEventListener('click', () => {
    const select = document.getElementById('workspace-project-select');
    const selectedOption = select?.selectedOptions?.[0];
    const workspaceRoot = selectedOption?.dataset?.workspaceRoot || currentWorkspaceRoot;
    postKanbanMessage({ type: 'addProject', workspaceRoot });
});
```

**Note:** The backend `addProject` handler (KanbanProvider.ts) currently uses `this._currentWorkspaceRoot`. It must be updated to accept an optional `workspaceRoot` from the message, falling back to `this._currentWorkspaceRoot` if not provided.

### 12. Update JavaScript — `btn-delete-project` Handler

**File**: `src/webview/kanban.html` (line 3113)

```javascript
btnDeleteProject?.addEventListener('click', () => {
    const select = document.getElementById('workspace-project-select');
    const selectedOption = select?.selectedOptions?.[0];
    const selectedProject = selectedOption?.dataset?.project;
    const workspaceRoot = selectedOption?.dataset?.workspaceRoot || currentWorkspaceRoot;
    if (!selectedProject) return;
    postKanbanMessage({ type: 'deleteProject', projectName: selectedProject, workspaceRoot });
});
```

**Note:** The backend `deleteProject` handler must be updated to accept an optional `workspaceRoot` from the message.

### 13. Update JavaScript — `workspace-reset-control-plane` Handler

**File**: `src/webview/kanban.html` (line 5566)

This handler remains unchanged — it operates on `currentWorkspaceRoot` (the currently viewed workspace), not the assignment target:
```javascript
document.getElementById('workspace-reset-control-plane')?.addEventListener('click', () => {
    lastBoardSignature = '';
    postKanbanMessage({
        type: 'selectWorkspace',
        workspaceRoot: currentWorkspaceRoot || '',
        controlPlaneAction: 'reset-auto-detect'
    });
});
```

### 14. Remove Obsolete Functions, Handlers, and CSS

**File**: `src/webview/kanban.html`

Remove the following:
- `updateWorkspaceSelector()` function (line 3309-3345)
- `updateProjectDropdown()` function (line 3069-3089)
- `btn-reassign-workspace` click handler (line 5524-5554)
- `btn-assign-project` click handler (line 3103-3111)
- `workspace-select` change handler (line 5556-5565)
- `project-select` change handler (line 3091-3097)
- DOM references: `const projectSelect = ...`, `const btnAssignProject = ...`, `const btnDeleteProject = ...` (update to use new element IDs)
- `.workspace-select` CSS style (lines 71-81)
- `.project-select` CSS style (lines 115-130)
- `.project-strip` CSS style (lines 106-113)
- Any JavaScript that references `project-strip` by ID (e.g., `document.getElementById('project-strip')`)

### 15. Update DOM References

**File**: `src/webview/kanban.html`

Update cached DOM references (near line 3051-3060) to reference new element IDs:
```javascript
// Remove:
// const projectSelect = document.getElementById('project-select') as HTMLSelectElement;
// const btnAssignProject = document.getElementById('btn-assign-project') as HTMLButtonElement;

// Add/update:
const btnDeleteProject = document.getElementById('btn-delete-project') as HTMLButtonElement;
const btnAddProject = document.getElementById('btn-add-project') as HTMLButtonElement;
```

### 16. Update Backend — `addProject` and `deleteProject` Handlers

**File**: `src/services/KanbanProvider.ts`

Update `addProject` handler to accept optional `workspaceRoot`:
```typescript
case 'addProject': {
    const workspaceRoot = msg.workspaceRoot || this._currentWorkspaceRoot;
    if (workspaceRoot) {
        const workspaceId = await this._readWorkspaceId(workspaceRoot);
        if (workspaceId) {
            const projectName = await vscode.window.showInputBox({ prompt: 'Project name' });
            if (projectName) {
                const db = this._getKanbanDb(workspaceRoot);
                await db.addProject(workspaceId, projectName);
                await this._refreshBoard(workspaceRoot);
                // Invalidate project cache
                this._allWorkspaceProjectsCache = null;
            }
        }
    }
    break;
}
```

Update `deleteProject` handler similarly to accept optional `workspaceRoot`.

## Files to Modify
1. `src/webview/kanban.html` — Main frontend changes (HTML, CSS, JS)
2. `src/services/KanbanProvider.ts` — Backend message handlers + all-workspace project data
3. `dist/webview/kanban.html` — Will be updated by build process

## Testing Checklist
- [ ] **Single bar renders correctly** — no second bar, all controls on one `.controls-strip`
- [ ] **Strip divider** visually separates automation controls from workspace/project controls
- [ ] **Bar wraps gracefully** on narrow viewports (`.controls-strip` has `flex-wrap: wrap`)
- [ ] Unified dropdown displays all workspaces with their projects grouped under each
- [ ] "All Projects" option appears for each workspace
- [ ] Selecting a different workspace in the dropdown switches the board view
- [ ] Selecting a different project within the same workspace filters the board
- [ ] Assign button enables when cards are selected, shows correct count
- [ ] Assignment to same workspace + specific project calls `assignSelectedToProject` only
- [ ] Assignment to different workspace calls `reassignPlansWorkspace` with optional `targetProject`
- [ ] Assignment to workspace + "All Projects" leaves project field empty/null
- [ ] Confirmation dialog shows correct workspace/project info
- [ ] Filter badges update correctly after selection change
- [ ] `btn-add-project` adds project to the workspace selected in unified dropdown
- [ ] `btn-delete-project` deletes the project selected in unified dropdown (only when specific project selected)
- [ ] `workspace-reset-control-plane` still works correctly on currently viewed workspace
- [ ] `controlPlaneAction` data attribute is preserved on workspace-level options
- [ ] Cards disappear from current view when assigned to different workspace
- [ ] Cards appear under correct workspace/project after assignment
- [ ] Existing plan data and assignments are preserved (backward compatibility)
- [ ] Selection restoration works correctly after board refresh
- [ ] `allWorkspaceProjects` cache invalidation works on project add/delete
- [ ] **No orphan references** to `project-strip`, `workspace-select`, or `project-select` in JS or CSS

## Risks
- Breaking existing workspace/project assignment workflows
- Data loss if assignment logic is incorrect (cross-workspace + project)
- Need to ensure backward compatibility with existing plan data
- Performance impact of querying projects for all workspaces on every board refresh
- Single bar may feel crowded on narrow viewports — mitigated by existing `flex-wrap: wrap` on `.controls-strip`
- Orphan JS/CSS references to removed elements (`project-strip`, `workspace-select`, `project-select`) could cause runtime errors if not fully cleaned up

## Mitigation
- Test thoroughly with existing plans
- Ensure project = null/empty is handled correctly for "All Projects"
- Verify that existing assignments are preserved
- Cache `allWorkspaceProjects` and invalidate only on project changes
- Reuse existing backend handlers (`reassignPlansWorkspace`, `assignSelectedToProject`) rather than creating new combined message types
- Search entire kanban.html for `project-strip`, `workspace-select`, `project-select` references after changes to ensure no orphans
- The `flex-wrap: wrap` on `.controls-strip` ensures the bar wraps to multiple lines on narrow viewports rather than overflowing

## Recommendation
**Complexity: 6 → Send to Coder**

---

## Review Pass — 2026-05-25

### Stage 1: Grumpy Principal Engineer Findings

| ID | Severity | Description | File |
|----|----------|-------------|------|
| CRITICAL-1 | CRITICAL | Cross-workspace `reassignPlansWorkspace` only refreshes the source board, not the target. Moved plans don't appear under the target workspace until manual switch + refresh. `_allWorkspaceProjectsCache` also not invalidated. | `KanbanProvider.ts:4110` |
| MAJOR-1 | MAJOR | `_refreshBoard` in `addProject`/`deleteProject` silently switches `this._currentWorkspaceRoot` to the target workspace via `_resolveWorkspaceRoot`. Latent issue — dropdown change handler already switches the board before user clicks +/DELETE, so not actively broken. | `KanbanProvider.ts:4173,4190` |
| MAJOR-2 | MAJOR | `_allWorkspaceProjectsCache` not invalidated after `reassignPlansWorkspace` with `targetProject`. Unified dropdown won't reflect project assignment changes until cache is stale (which it never becomes). | `KanbanProvider.ts:4095` |
| NIT-1 | NIT | Plan specified `path.resolve()` for workspace comparison in frontend; implementation uses raw string comparison. Works because backend normalizes all paths, but webview has no `path` module anyway. | `kanban.html:5516` |
| NIT-2 | NIT | Comment references deleted function `updateWorkspaceSelector` by name. | `kanban.html:3294` |

### Stage 2: Balanced Synthesis

| Finding | Verdict | Action Taken |
|---------|---------|--------------|
| CRITICAL-1 | **Fix now** | Added `_allWorkspaceProjectsCache = null` + target board refresh after reassignment |
| MAJOR-1 | **Defer** | Latent — dropdown change handler already switches board. Documented as known behavior. |
| MAJOR-2 | **Fix now** | Covered by CRITICAL-1 fix (cache invalidation added in same location) |
| NIT-1 | **Keep as-is** | Webview has no `path` module; backend normalizes. Working correctly. |
| NIT-2 | **Fix now** | Updated comment to generic reference |

### Code Fixes Applied

1. **`src/services/KanbanProvider.ts`** (after line 4108): Added `_allWorkspaceProjectsCache = null` and conditional `_refreshBoard(targetWorkspaceRoot)` after the reassignment loop. This ensures:
   - The project cache is invalidated so the unified dropdown reflects new project assignments
   - The target workspace board is refreshed so moved plans appear immediately

2. **`src/webview/kanban.html`** (line 3294): Updated comment from "preserved from updateWorkspaceSelector" to "preserved from original workspace/project selectors"

### Verification Results

- **TypeScript check**: 2 pre-existing errors (unrelated import path issues in `ClickUpSyncService.ts:2309` and `KanbanProvider.ts:4575`). No new errors introduced by this review's fixes.
- **Orphan reference check**: No remaining references to `project-strip`, `btn-reassign-workspace`, `btn-assign-project`, `workspace-select` (as element ID), or `project-select` (as element ID) in `src/webview/kanban.html`.
- **CSS orphan check**: No remaining `.project-strip`, `.workspace-select` (non-hyphenated), or `.project-select` (non-hyphenated) CSS class references.

### Implementation Completeness vs Plan

| Plan Step | Status | Notes |
|-----------|--------|-------|
| 1. HTML structure merge | ✅ Complete | Single `.controls-strip`, no `.project-strip`, all elements present |
| 2. CSS updates | ✅ Complete | `.workspace-project-select`, `.strip-divider` added; old classes removed |
| 3. `allWorkspaceProjects` global | ✅ Complete | Declared at line 3047 |
| 4. `updateWorkspaceProjectDropdown()` | ✅ Complete | Replaces both old functions, selection restoration preserved |
| 5. `updateReassignButtonVisibility()` | ✅ Complete | Targets `btn-assign-workspace-project`, shows count |
| 6. Unified assign handler | ✅ Complete | Branching logic correct (same-ws project, cross-ws reassign, no-op) |
| 7. Unified dropdown change handler | ✅ Complete | `selectWorkspace` / `setProjectFilter` branching, delete button visibility |
| 8. Backend `reassignPlansWorkspace` + `targetProject` | ✅ Complete | `msg.targetProject` handled in upsert |
| 9. `_getAllWorkspaceProjects()` + cache | ✅ Complete | Cached, invalidated on add/delete/workspace change |
| 10. `updateWorkspaceSelection` handler | ✅ Complete | Stores `allWorkspaceProjects`, calls unified dropdown function |
| 11. `btn-add-project` handler | ✅ Complete | Reads workspace from unified dropdown |
| 12. `btn-delete-project` handler | ✅ Complete | Reads workspace + project from unified dropdown |
| 13. `workspace-reset-control-plane` handler | ✅ Complete | Unchanged, operates on `currentWorkspaceRoot` |
| 14. Obsolete function/handler/CSS removal | ✅ Complete | No orphan references found |
| 15. DOM reference updates | ✅ Complete | Old references removed, new ones in place |
| 16. Backend `addProject`/`deleteProject` handlers | ✅ Complete | Accept optional `workspaceRoot`, cache invalidation |

### Remaining Risks

1. **MAJOR-1 (deferred)**: `_refreshBoard` in `addProject`/`deleteProject` switches `this._currentWorkspaceRoot` to the target workspace. Currently masked by the dropdown change handler already switching the board. If the dropdown change handler is ever decoupled from board switching, this will cause unexpected workspace switches.
2. **`dist/webview/kanban.html` is stale**: Contains 20 references to old element IDs. Must be rebuilt before deployment.
3. **Race condition**: If user changes the unified dropdown and clicks ASSIGN before the board refreshes, `selectedCards` may reference plans that no longer match the visible board state. The plan's mitigation (disable ASSIGN during board refresh via `_boardRefreshing` flag) was not implemented. Low severity — the optimistic selection clear mitigates the visual inconsistency.
