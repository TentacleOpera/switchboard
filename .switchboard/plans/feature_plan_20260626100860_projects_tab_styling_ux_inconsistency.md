# Bug: Project Panel Projects Tab Missing Styling and Uses Wrong UX Pattern

## Goal

### Problem
The Projects tab in `project.html` is visually and structurally inconsistent with
every other tab in the Project panel. It renders as an unstyled grey box, uses
inline styles instead of the shared CSS classes, and asks the user to write a
PRD from scratch in a textarea instead of following the "ask agent" / "Build via
Planner" button pattern used by every other tab. It should follow the same
layout as the Kanban/Constitution/System tabs: a workspace picker + sidebar list
of projects + a doc preview area that shows a blank "not written yet" state when
the PRD doesn't exist, with a "Build via Planner" button.

### Background
Every tab in the Project panel (`project.html`) follows a shared layout pattern:
- A `.controls-strip` with a workspace filter and action buttons
- A `.content-row` containing a `#<tab>-list-pane` sidebar and a
  `.preview-panel-wrapper` with `.cyber-scanlines`
- Sidebar items rendered from a cache, with a toggle row
- "Build via Planner" / "Copy Build Prompt" buttons for agent-driven authoring

The Constitution tab (`project.html` lines ~1510) and System tab (~1547)
demonstrate the correct agent-driven pattern:
```html
<button id="btn-build-via-planner" class="strip-btn" disabled>Build via Planner</button>
<button id="btn-copy-build-prompt" class="strip-btn" disabled>Copy Build Prompt</button>
```

The Projects tab (lines 1435-1458) breaks this pattern entirely:
```html
<div id="projects-content" class="shared-tab-content">
    <div class="controls-strip">
        <select id="projects-workspace-filter"></select>
        <select id="projects-prd-select">
            <option value="">Select a project…</option>
        </select>
        <button class="strip-btn" id="btn-project-context" ...>PROJECT CONTEXT: OFF</button>
        <button class="strip-btn" id="btn-save-project-prd" ...>SAVE PRD</button>
        <span id="projects-prd-status" ...></span>
    </div>
    <div style="padding:10px 14px; overflow-y:auto; flex:1; display:flex; flex-direction:column;">
        <div style="font-size:11px; ...">A PRD is a loose set of product requirements...</div>
        <div id="projects-prd-path-hint" style="..."></div>
        <textarea id="projects-prd-editor" spellcheck="false"
            placeholder="Select a project, then write its product requirements here…"
            style="width:100%; flex:1; min-height:380px; ... background:var(--vscode-input-background, #1e1e1e); ..."
            disabled></textarea>
    </div>
</div>
```

### Root Cause
Three structural defects:

1. **No `.content-row` / sidebar / preview-panel-wrapper.** The Projects tab
   uses a bare `<div style="padding:10px 14px; ...">` with inline styles instead
   of the `.content-row` + `#projects-list-pane` + `.preview-panel-wrapper`
   layout. There is no `#projects-list-pane` sidebar element at all — projects
   are shown in a `<select>` dropdown instead of as clickable sidebar items.

2. **Missing from shared CSS selectors.** The CSS rules that style the sidebar
   list panes (e.g. `#kanban-list-pane, #epics-list-pane,
   #constitution-list-pane, #system-list-pane, #tuning-list-pane`) do NOT
   include `#projects-list-pane` because it doesn't exist. The tab therefore
   gets no shared styling and falls back to the default grey box.

3. **Textarea-from-scratch instead of agent-driven authoring.** The PRD editor
   is a plain `<textarea>` with a placeholder telling the user to "write its
   product requirements here." Every other tab uses a "Build via Planner" /
   "Copy Build Prompt" button pair to delegate authoring to an agent. The
   Projects tab should mirror this: show a blank "not written yet" preview when
   the PRD doesn't exist, and offer "Build via Planner" to generate it.

**Bug status: STILL PRESENT** (verified in source).

## Metadata
**Tags:** bug, project-panel, projects-tab, styling, ux, consistency
**Complexity:** 5
**Repo:** switchboard (source at `/Users/patrickvuleta/Documents/GitHub/switchboard`)

## Complexity Audit

### Routine
1. Restructure the Projects tab HTML to use `.content-row` +
   `#projects-list-pane` + `.preview-panel-wrapper` with `.cyber-scanlines`.
2. Add `#projects-list-pane` to the shared CSS selectors that list the other
   list panes.
3. Replace the `<select>` project dropdown with a sidebar list of project items
   (clickable), reusing the existing `_kanbanAllWorkspaceProjects` cache.
4. Add "Build via Planner" / "Copy Build Prompt" buttons to the controls strip.

### Complex / Risky
1. **Sidebar population wiring.** The existing `updateProjectsPrdSelect()`
   (project.js lines 981-1019) populates the `<select>` dropdown. This must be
   refactored to render project items into `#projects-list-pane` as clickable
   cards (mirroring `renderKanbanPlans`). The selection state (`projectsPrdSelect.value`)
   must become a `_selectedProjectName` variable instead.
2. **PRD preview vs edit mode.** Other tabs have a read-only preview
   (`#<tab>-preview-content`) and a separate edit mode (textarea toggled by an
   Edit button). The Projects tab currently is always a textarea. The restructure
   should add a preview pane that renders the PRD markdown, with an Edit button
   to switch to the textarea (matching the Kanban/Constitution pattern).
3. **Sidebar collapse state.** The tab-switch handler (project.js lines 21-31)
   applies sidebar collapse state per tab but has no `projects` branch. Must add
   `projectsListCollapsed` to the state object and an `applySidebarState`
   call for the projects tab.
4. **"Build via Planner" prompt.** The Constitution tab's "Build via Planner"
   dispatches a planner prompt to generate a constitution. The Projects tab
   equivalent must dispatch a planner prompt to generate a PRD for the selected
   project, passing the project name as context. This requires a new message
   type (e.g. `buildPrdViaPlanner`) and backend handler, OR reuse the existing
   `copyKanbanPlanPrompt`-style dispatch with a PRD-specific prompt template.

## Edge-Case & Dependency Audit

- **Existing PRD content:** PRDs are stored at
  `.switchboard/projects/<project>/prd.md`. The restructure must not lose
  existing PRD content — the preview/edit flow must load and save to the same
  path.
- **PROJECT CONTEXT toggle:** The existing `btn-project-context` toggle
  (injects the selected project's PRD into every dispatched prompt) must be
  preserved in the new controls strip. It's a per-workspace setting.
- **No projects in workspace:** The sidebar should show an empty state ("No
  projects — add one on the Kanban board") rather than a disabled dropdown.
- **Project selection persistence:** When switching workspace filter, the
  sidebar should repopulate and preserve the selected project if it still
  exists.
- **`hydrateProjectsTab` / `updateProjectsPrdSelect` callers:** These are called
  from the tab-switch handler and `kanbanPlansReady`. The refactor must keep
  these call sites working (rename/repurpose as needed).

## Proposed Changes

### File: `src/webview/project.html`

**Change 1 — Restructure the Projects tab (replace lines 1435-1458).**

```html
<!-- Projects tab (per-project PRDs) -->
<div id="projects-content" class="shared-tab-content">
    <div class="controls-strip">
        <select id="projects-workspace-filter">
            <option value="">All Workspaces</option>
        </select>
        <button id="btn-build-prd-via-planner" class="strip-btn" disabled>Build via Planner</button>
        <button id="btn-copy-prd-prompt" class="strip-btn" disabled>Copy Build Prompt</button>
        <button id="btn-edit-prd" class="strip-btn" disabled>Edit</button>
        <button id="btn-save-project-prd" class="strip-btn" title="Save this project's PRD" style="display:none;">Save PRD</button>
        <button class="strip-btn" id="btn-project-context" data-tooltip="When on, the selected project's PRD is injected into every dispatched prompt">PROJECT CONTEXT: OFF</button>
        <span id="projects-prd-status" style="font-size:11px; color:var(--text-secondary);"></span>
    </div>
    <div class="content-row">
        <div id="projects-list-pane">
            <div class="sidebar-toggle-row">
                <button class="sidebar-toggle-btn" title="Toggle sidebar">«</button>
            </div>
            <div id="projects-empty-state" class="empty-state">No projects — add one on the Kanban board (+).</div>
            <div id="projects-items-container"></div>
        </div>
        <div class="preview-panel-wrapper">
            <div class="cyber-scanlines"></div>
            <div id="projects-prd-path-hint" style="font-size:10px; font-family:monospace; color:var(--text-secondary); opacity:0.7; margin-bottom:6px;"></div>
            <div id="projects-preview-pane" class="constitution-preview-pane">
                <div id="projects-preview-content">
                    <div class="empty-state">Select a project to view its PRD</div>
                </div>
                <textarea id="projects-prd-editor" class="markdown-editor" spellcheck="false"
                    placeholder="Select a project, then write its product requirements here…"
                    style="display:none;"></textarea>
            </div>
        </div>
    </div>
</div>
```

**Change 2 — Add `#projects-list-pane` to the shared CSS selectors.**

In every CSS selector that lists the other list panes (the `#kanban-list-pane,
#epics-list-pane, ...` groups for width/border/flex, the collapsed-state rules,
and the cyber-theme background rules), append `#projects-list-pane`. This gives
the projects sidebar the same width, border, scroll, and themed background as
the other tabs.

### File: `src/webview/project.js`

**Change 3 — Add `projectsListCollapsed` to state and the tab-switch handler.**

In the state object (around line 60), add:
```javascript
projectsListCollapsed: false,
```
In the tab-switch handler (lines 21-31), add a `projects` branch:
```javascript
} else if (targetTab === 'projects') {
    applySidebarState('projects', state.projectsListCollapsed);
}
```

**Change 4 — Refactor `updateProjectsPrdSelect` into `renderProjectsList`.**

Replace the `<select>`-populating logic with a sidebar-render function that
creates clickable project items in `#projects-items-container`, mirroring
`renderKanbanPlans`:

```javascript
function renderProjectsList() {
    const container = document.getElementById('projects-items-container');
    const emptyState = document.getElementById('projects-empty-state');
    if (!container) return;
    const wsRoot = getProjectsTabWorkspaceRoot();
    const projects = (_kanbanAllWorkspaceProjects && _kanbanAllWorkspaceProjects[wsRoot]) || [];
    container.innerHTML = '';
    if (!projects.length) {
        if (emptyState) emptyState.style.display = '';
        container.style.display = 'none';
        setProjectsPrdEditorEnabled(false);
        return;
    }
    if (emptyState) emptyState.style.display = 'none';
    container.style.display = '';
    projects.forEach(proj => {
        const item = document.createElement('div');
        item.className = 'kanban-plan-item'; // reuse shared item styling
        item.dataset.project = proj;
        item.textContent = proj;
        item.addEventListener('click', () => {
            _selectedProjectName = proj;
            document.querySelectorAll('#projects-items-container .kanban-plan-item')
                .forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');
            requestProjectPrd();
        });
        container.appendChild(item);
    });
    // Preserve prior selection if still present.
    if (_selectedProjectName && projects.includes(_selectedProjectName)) {
        const sel = container.querySelector(`[data-project="${cssEscape(_selectedProjectName)}"]`);
        if (sel) sel.classList.add('selected');
    } else {
        _selectedProjectName = projects[0];
        const first = container.firstChild;
        if (first) first.classList.add('selected');
        requestProjectPrd();
    }
}
```

Replace `projectsPrdSelect.value` references with `_selectedProjectName` in
`requestProjectPrd`, the save handler, and the PROJECT CONTEXT toggle.

**Change 5 — Add a preview/edit mode toggle (mirroring Constitution tab).**

Add an `Edit` button that shows the textarea and hides the preview; a `Save`
button that writes the PRD and switches back to preview. When no PRD exists,
the preview shows "Not written yet — click Build via Planner to generate."

**Change 6 — Wire "Build via Planner" and "Copy Build Prompt".**

```javascript
const btnBuildPrd = document.getElementById('btn-build-prd-via-planner');
const btnCopyPrdPrompt = document.getElementById('btn-copy-prd-prompt');
if (btnBuildPrd) {
    btnBuildPrd.addEventListener('click', () => {
        if (!_selectedProjectName) return;
        vscode.postMessage({
            type: 'buildPrdViaPlanner',
            projectName: _selectedProjectName,
            workspaceRoot: getProjectsTabWorkspaceRoot()
        });
    });
}
if (btnCopyPrdPrompt) {
    btnCopyPrdPrompt.addEventListener('click', () => {
        if (!_selectedProjectName) return;
        vscode.postMessage({
            type: 'copyPrdBuildPrompt',
            projectName: _selectedProjectName,
            workspaceRoot: getProjectsTabWorkspaceRoot()
        });
    });
}
```

Enable these buttons when a project is selected (in `renderProjectsList` /
`requestProjectPrd`).

### File: `src/services/PlanningPanelProvider.ts`

**Change 7 — Add backend handlers for `buildPrdViaPlanner` and
`copyPrdBuildPrompt`.**

Mirror the Constitution tab's `buildConstitutionViaPlanner` handler: assemble a
PRD-generation prompt with the project name as context, dispatch to the planner
role (for `buildPrdViaPlanner`) or copy to clipboard (for
`copyPrdBuildPrompt`). The PRD is saved to
`.switchboard/projects/<project>/prd.md` on planner completion (or the planner
output is placed in the editor for review before saving, matching the
Constitution flow).

## Verification Plan

1. **Visual parity test:** Open the Projects tab. Confirm it uses the same
   layout, sidebar width, cyber-scanlines, and themed background as the Kanban
   and Constitution tabs — no grey box.
2. **Sidebar list test:** With projects on the kanban board, confirm the
   projects appear as clickable items in the sidebar (not a dropdown). Click
   each and confirm the PRD loads in the preview pane.
3. **Empty state test:** Select a workspace with no projects. Confirm the
   sidebar shows "No projects — add one on the Kanban board (+)."
4. **Not-written-yet test:** Select a project with no PRD. Confirm the preview
   shows "Not written yet — click Build via Planner to generate" (not an empty
   textarea).
5. **Build via Planner test:** Click "Build via Planner" for a project with no
   PRD. Confirm a planner dispatch fires (or a build prompt is copied). Confirm
   the generated PRD loads into the preview/editor.
6. **Edit/Save test:** Click Edit, modify the PRD, click Save. Confirm the PRD
   is written to `.switchboard/projects/<project>/prd.md` and the preview
   updates.
7. **PROJECT CONTEXT toggle test:** Toggle PROJECT CONTEXT on. Confirm the
   selected project's PRD is injected into a subsequent dispatch (verify via a
   test dispatch or the existing context-injection path).
8. **Sidebar collapse test:** Collapse the projects sidebar via the toggle.
   Confirm it collapses and restores correctly, and the collapse state
   persists on tab switch.
9. **Existing PRD migration test:** For a project with an existing `prd.md`,
   confirm the content loads into the preview on selection (no data loss).
10. **Tab-switch regression test:** Switch between Kanban, Projects, Epics,
    Constitution tabs. Confirm each renders correctly with no styling bleed.
