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

The Constitution tab (`project.html` lines 1500-1542) and System tab (1544-1574)
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
**Tags:** [frontend, ui, ux, bugfix, refactor]
**Complexity:** 6

## User Review Required
Yes — this plan restructures a user-facing tab and changes the PRD authoring UX
from "write in a textarea" to "agent-driven Build via Planner + preview/edit
toggle." The user should confirm:
1. The PRD prompt template (Change 7) matches their expectations for what a PRD
   should contain.
2. The decision to reuse the shared `enterEditMode`/`exitEditMode` functions
   (requiring `projects-editor` / `btn-edit-projects` naming) is acceptable vs.
   writing projects-specific toggle logic.
3. Whether the pre-existing `#system-list-pane` CSS omission (point 8 of the
   adversarial review) should be fixed in this same change or tracked
   separately.

## Complexity Audit

### Routine
- Restructure the Projects tab HTML to use `.content-row` +
  `#projects-list-pane` + `.preview-panel-wrapper` with `.cyber-scanlines`.
- Add `#projects-list-pane` (and the pre-existing-missing `#system-list-pane`)
  to the shared CSS selectors.
- Replace the `<select>` project dropdown with a sidebar list of project items
  (clickable), reusing the existing `_kanbanAllWorkspaceProjects` cache.
- Add "Build via Planner" / "Copy Build Prompt" buttons to the controls strip.
- Add `projectsListCollapsed` to the state object, tab-switch handler,
  `toggleSidebarCollapsed`, and `vscode.setState` persistence.
- Add `projects` keys to `editMode`, `editOriginalContent`, `dirtyFlags`, and
  `externalChangePending` state objects.

### Complex / Risky
- **Sidebar population wiring.** The existing `updateProjectsPrdSelect()`
  (project.js lines 995-1037) populates the `<select>` dropdown. This must be
  refactored to render project items into `#projects-items-container` as
  clickable cards (mirroring `renderKanbanPlans` at line 1096). The selection
  state (`projectsPrdSelect.value`) must become a `_selectedProjectName`
  variable instead. All references to `projectsPrdSelect` must be updated,
  including the stale-response guard in the `projectPrdContent` message handler
  (line 349).
- **PRD preview vs edit mode — naming convention reconciliation.** Other tabs
  have a read-only preview (`#<tab>-preview-content`) and a separate edit mode
  (textarea toggled by an Edit button). The shared `enterEditMode(tab)` /
  `exitEditMode(tab)` functions (lines 2248-2282) look for `${tab}-editor`,
  `btn-edit-${tab}`, `btn-save-${tab}`, `btn-cancel-${tab}`. The Projects tab
  must use `projects-editor` (NOT `projects-prd-editor`), `btn-edit-projects`,
  `btn-save-projects`, `btn-cancel-projects` to reuse these functions
  unchanged. The current `projects-prd-editor` / `btn-save-project-prd` IDs
  will NOT work with the shared functions.
- **Markdown rendering for the preview pane.** The backend `getProjectPrd`
  handler (PlanningPanelProvider.ts line 3211) currently returns RAW markdown
  (`msg.content`). The preview pane needs HTML. The handler must be extended to
  call `vscode.commands.executeCommand('markdown.api.render', content)` and
  return both `content` (HTML) and `rawContent` (markdown) — mirroring the
  `kanbanPlanPreviewReady` message pattern (line 1247-1256). The
  `projectPrdContent` message handler in project.js (line 347) must set
  `projects-preview-content.innerHTML = msg.content` (HTML) and
  `state.editOriginalContent.projects = msg.rawContent` (markdown for the
  editor).
- **"Build via Planner" prompt.** The Constitution tab's "Build via Planner"
  dispatches a planner prompt to generate a constitution. The Projects tab
  equivalent must dispatch a planner prompt to generate a PRD for the selected
  project, passing the project name as context. This requires a new message
  type (`invokePrdBuilder`) and backend handler, plus a `copyPrdBuildPrompt`
  handler — both mirroring the Constitution handlers (`invokeConstitutionBuilder`
  at line 3349, `copyConstitutionPrompt` at line 3266).

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - **Stale PRD response.** The `projectPrdContent` handler (line 347) guards
    against stale responses by checking `projectsPrdSelect.value ===
    msg.projectName`. After the refactor, this must check `_selectedProjectName
    === msg.projectName` instead. Without this, a rapid project switch could
    load the wrong PRD into the editor.
  - **In-progress edit clobber.** The current `updateProjectsPrdSelect` (line
    1032) avoids clobbering an in-progress edit by checking `_prdDirty`. The
    refactored `renderProjectsList` must preserve this guard — only call
    `requestProjectPrd()` when the selection differs from `_prdLoadedProject` or
    `!_prdDirty`.

- **Security:**
  - PRD content is injected verbatim into every dispatched prompt (same trust
    boundary as the constitution). The `sanitizeProjectSlug` function
    (prdUtils.ts line 16) already prevents path traversal via `../../etc`-style
    project names. No new security surface is introduced.
  - The `projects-preview-content.innerHTML = msg.content` assignment relies on
    the backend's `markdown.api.render` output, which is VS Code's built-in
    markdown renderer (same as Kanban plan previews). No additional XSS risk
    beyond the existing Kanban preview path.

- **Side Effects:**
  - **PROJECT CONTEXT toggle.** The existing `btn-project-context` toggle
    (injects the selected project's PRD into every dispatched prompt) must be
    preserved in the new controls strip. It's a per-workspace setting backed by
    `KanbanProvider.getProjectContextEnabled` / `setProjectContextEnabled`. The
    toggle reads `_selectedProjectName` (was `projectsPrdSelect.value`) to
    determine which project's PRD to inject.
  - **`hydrateProjectsTab` / `updateProjectsPrdSelect` callers.** These are
    called from the tab-switch handler (line 38) and `kanbanPlansReady` (line
    335). The refactor must keep these call sites working — `hydrateProjectsTab`
    (line 1056) calls `populateWorkspaceDropdowns`, `updateProjectsPrdSelect`
    (→ renamed `renderProjectsList`), and `requestProjectContextEnabled`.

- **Dependencies & Conflicts:**
  - The `getProjectPrdPath` function (prdUtils.ts line 33) is unchanged — PRDs
    remain at `.switchboard/projects/<slug>/prd.md`.
  - The `markdown.api.render` VS Code command is already used by
    `_handleFetchKanbanPlanPreview` (line 1247). No new dependency.
  - The `dispatchCustomPromptToRole` method on `_taskViewerProvider` is already
    used by `invokeConstitutionBuilder` (line 3358) and `invokeSystemBuilder`
    (line 3398). No new dependency.

## Dependencies
- None — this is a self-contained bugfix with no prerequisite plans.

## Adversarial Synthesis
Key risks: (1) the `enterEditMode`/`exitEditMode` naming convention mismatch
would cause silent dead-clicks if the Projects tab uses non-conforming IDs;
(2) the backend `getProjectPrd` returns raw markdown, so the preview pane would
show literal `# heading` text unless the handler is extended to render HTML via
`markdown.api.render`; (3) `toggleSidebarCollapsed` and `vscode.setState` have
no `projects` branch, making the sidebar toggle a dead click with no
persistence. Mitigations: follow the `${tab}-editor` / `btn-edit-${tab}` naming
convention exactly, extend `getProjectPrd` to return both HTML and raw
markdown, and add `projects` branches to all three sidebar-state code paths.

## Proposed Changes

### File: `src/webview/project.html`

**Change 1 — Restructure the Projects tab (replace lines 1435-1458).**

> **Clarification:** The IDs follow the shared `enterEditMode`/`exitEditMode`
> naming convention (`${tab}-editor`, `btn-edit-${tab}`, `btn-save-${tab}`,
> `btn-cancel-${tab}`) so the existing functions work unchanged. The old
> `projects-prd-editor` and `btn-save-project-prd` IDs are retired.

```html
<!-- Projects tab (per-project PRDs) -->
<div id="projects-content" class="shared-tab-content">
    <div class="controls-strip">
        <select id="projects-workspace-filter">
            <option value="">All Workspaces</option>
        </select>
        <button id="btn-build-prd-via-planner" class="strip-btn" disabled>Build via Planner</button>
        <button id="btn-copy-prd-prompt" class="strip-btn" disabled>Copy Build Prompt</button>
        <button id="btn-edit-projects" class="strip-btn" disabled>Edit</button>
        <button id="btn-save-projects" class="strip-btn" style="display:none;">Save</button>
        <button id="btn-cancel-projects" class="strip-btn" style="display:none;">Cancel</button>
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
                <textarea id="projects-editor" class="markdown-editor" spellcheck="false"
                    placeholder="Select a project, then write its product requirements here…"
                    style="display:none;"></textarea>
            </div>
        </div>
    </div>
</div>
```

**Change 2 — Add `#projects-list-pane` and `#system-list-pane` to the shared CSS
selectors (4 locations).**

> **Clarification:** `#system-list-pane` is already missing from 3 of the 4
> rule groups (a pre-existing bug). Add BOTH `#projects-list-pane` and
> `#system-list-pane` to all 4 groups.

1. **Base width/border/flex rule (line 197):** Already includes
   `#system-list-pane`. Append `#projects-list-pane`:
   ```css
   #kanban-list-pane, #epics-list-pane, #constitution-list-pane, #system-list-pane, #tuning-list-pane, #projects-list-pane {
   ```

2. **Collapsed-state padding (lines 500-503):** Currently MISSING
   `#system-list-pane`. Add both:
   ```css
   .content-row.collapsed #kanban-list-pane,
   .content-row.collapsed #epics-list-pane,
   .content-row.collapsed #constitution-list-pane,
   .content-row.collapsed #system-list-pane,
   .content-row.collapsed #tuning-list-pane,
   .content-row.collapsed #projects-list-pane {
       padding: 4px;
       overflow: hidden;
   }
   ```

3. **Collapsed-state child hiding (lines 508-511):** Currently MISSING
   `#system-list-pane`. Add both:
   ```css
   .content-row.collapsed #kanban-list-pane > *:not(.sidebar-toggle-row),
   .content-row.collapsed #epics-list-pane > *:not(.sidebar-toggle-row),
   .content-row.collapsed #constitution-list-pane > *:not(.sidebar-toggle-row),
   .content-row.collapsed #system-list-pane > *:not(.sidebar-toggle-row),
   .content-row.collapsed #tuning-list-pane > *:not(.sidebar-toggle-row),
   .content-row.collapsed #projects-list-pane > *:not(.sidebar-toggle-row) {
       display: none !important;
   }
   ```

4. **Cyber-theme background (lines 727-730):** Currently MISSING
   `#system-list-pane`. Add both:
   ```css
   .cyber-theme-enabled #kanban-list-pane,
   .cyber-theme-enabled #epics-list-pane,
   .cyber-theme-enabled #constitution-list-pane,
   .cyber-theme-enabled #system-list-pane,
   .cyber-theme-enabled #tuning-list-pane,
   .cyber-theme-enabled #projects-list-pane {
       background: rgba(10, 10, 10, 0.70);
       backdrop-filter: blur(8px);
       -webkit-backdrop-filter: blur(8px);
       border-right-color: color-mix(in srgb, var(--accent-primary) 20%, transparent);
   }
   ```

**Change 2b — Add `#projects-preview-content` to the empty-state CSS selector
(lines 1159-1163).**

```css
#kanban-preview-content .empty-state,
#epics-preview-content .empty-state,
#constitution-preview-content .empty-state,
#system-preview-content .empty-state,
#tuning-preview-content .empty-state,
#projects-preview-content .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--vscode-editor-foreground, var(--text-secondary));
    font-size: inherit;
}
```

**Change 2c — Add `#projects-preview-content` to the edit-mode hiding rule
(lines 250-255).**

```css
.edit-mode #kanban-preview-content,
.edit-mode #epics-preview-content,
.edit-mode #constitution-preview-content,
.edit-mode #system-preview-content,
.edit-mode #tuning-preview-content,
.edit-mode #projects-preview-content {
    display: none;
}
```

### File: `src/webview/project.js`

**Change 3 — Add `projectsListCollapsed` to state, persistence, and the
tab-switch / toggle handlers.**

In the state object (line 60-66), add:
```javascript
projectsListCollapsed: false,
```

In the persisted-state init (lines 68-74), add:
```javascript
state.projectsListCollapsed = persistedState.projectsListCollapsed || false;
```

In the tab-switch handler (lines 21-31), add a `projects` branch:
```javascript
} else if (targetTab === 'projects') {
    applySidebarState('projects', state.projectsListCollapsed);
}
```

In `toggleSidebarCollapsed` (lines 103-119), add a `projects` branch:
```javascript
} else if (activeTab === 'projects') {
    state.projectsListCollapsed = !state.projectsListCollapsed;
    applySidebarState('projects', state.projectsListCollapsed);
}
```

In the `vscode.setState` call (lines 123-130), add:
```javascript
projectsListCollapsed: state.projectsListCollapsed,
```

**Change 3b — Add `projects` keys to the edit-mode state objects (lines 55-58).**

```javascript
editMode: { kanban: false, constitution: false, epics: false, system: false, projects: false },
editOriginalContent: { kanban: null, constitution: null, epics: null, system: null, projects: null },
dirtyFlags: { kanban: false, constitution: false, epics: false, system: false, projects: false },
externalChangePending: { kanban: false, constitution: false, epics: false, system: false, projects: false },
```

**Change 4 — Refactor `updateProjectsPrdSelect` into `renderProjectsList`.**

Replace the `<select>`-populating logic (lines 995-1037) with a
sidebar-render function that creates clickable project items in
`#projects-items-container`, mirroring `renderKanbanPlans` (line 1096):

```javascript
let _selectedProjectName = null;

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
        if (projectsPrdPathHint) projectsPrdPathHint.textContent = '';
        if (projectsPrdStatus) projectsPrdStatus.textContent = '';
        _prdLoadedProject = null;
        _prdDirty = false;
        _selectedProjectName = null;
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
    // Preserve prior selection, else the board's active project filter, else the first.
    // Use dataset iteration instead of cssEscape (cssEscape does not exist in this file).
    let toSelect = null;
    if (_selectedProjectName && projects.includes(_selectedProjectName)) {
        toSelect = _selectedProjectName;
    } else if (kanbanFilters.project && kanbanFilters.project !== '__none__' && projects.includes(kanbanFilters.project)) {
        toSelect = kanbanFilters.project;
    } else {
        toSelect = projects[0];
    }
    _selectedProjectName = toSelect;
    const items = container.querySelectorAll('.kanban-plan-item');
    for (const el of items) {
        if (el.dataset.project === toSelect) {
            el.classList.add('selected');
            break;
        }
    }
    // Don't clobber an in-progress edit: reload only when the selection differs from
    // what's loaded, or the current selection has no unsaved changes.
    if (_selectedProjectName !== _prdLoadedProject || !_prdDirty) {
        requestProjectPrd();
    } else {
        setProjectsPrdEditorEnabled(true);
    }
}
```

Replace ALL `projectsPrdSelect.value` references with `_selectedProjectName` in:
- `requestProjectPrd` (line 1041) — `const projectName = _selectedProjectName;`
- The `projectPrdContent` message handler stale-response guard (line 349) —
  `if (_selectedProjectName === msg.projectName) {`
- The save handler (line 1085) — `const projectName = _selectedProjectName;`
- The PROJECT CONTEXT toggle (line 1079) — uses `getProjectsTabWorkspaceRoot()`
  already, no `projectsPrdSelect` reference; but verify the backend
  `getProjectContextEnabled`/`setProjectContextEnabled` path still resolves the
  selected project correctly.

Remove the `projectsPrdSelect` element reference (line 279) and its
`change` listener (lines 1069-1071).

Rename `hydrateProjectsTab` (line 1056) to call `renderProjectsList` instead of
`updateProjectsPrdSelect`:
```javascript
function hydrateProjectsTab() {
    populateWorkspaceDropdowns();
    renderProjectsList();
    requestProjectContextEnabled();
}
```

Update the `projectsWorkspaceFilter` change listener (lines 1062-1067) to call
`renderProjectsList` instead of `updateProjectsPrdSelect`.

Update the `kanbanPlansReady` handler (line 335) to call `renderProjectsList`
instead of `updateProjectsPrdSelect`.

**Change 5 — Add a preview/edit mode toggle (mirroring Constitution tab).**

Because the HTML now uses `projects-editor`, `btn-edit-projects`,
`btn-save-projects`, `btn-cancel-projects`, `projects-preview-pane`, and
`projects-preview-content`, the shared `enterEditMode('projects')` and
`exitEditMode('projects')` functions (lines 2248-2282) work unchanged.

Wire the buttons:
```javascript
const btnEditProjects = document.getElementById('btn-edit-projects');
const btnSaveProjects = document.getElementById('btn-save-projects');
const btnCancelProjects = document.getElementById('btn-cancel-projects');
const projectsEditor = document.getElementById('projects-editor');
const projectsPreviewContent = document.getElementById('projects-preview-content');

if (btnEditProjects) {
    btnEditProjects.addEventListener('click', () => {
        if (!_selectedProjectName) return;
        enterEditMode('projects');
    });
}
if (btnSaveProjects) {
    btnSaveProjects.addEventListener('click', () => {
        if (!_selectedProjectName) return;
        const wsRoot = getProjectsTabWorkspaceRoot();
        if (!wsRoot) return;
        if (projectsPrdStatus) projectsPrdStatus.textContent = 'Saving…';
        vscode.postMessage({
            type: 'saveProjectPrd',
            projectName: _selectedProjectName,
            content: projectsEditor ? projectsEditor.value : '',
            workspaceRoot: wsRoot
        });
        exitEditMode('projects');
    });
}
if (btnCancelProjects) {
    btnCancelProjects.addEventListener('click', () => {
        exitEditMode('projects');
    });
}
if (projectsEditor) {
    projectsEditor.addEventListener('input', () => {
        state.dirtyFlags.projects = true;
        _prdDirty = true;
    });
}
```

Update the `projectPrdContent` message handler (line 347) to populate the
preview pane with rendered HTML and the editor with raw markdown:
```javascript
case 'projectPrdContent': {
    if (_selectedProjectName === msg.projectName) {
        if (projectsPreviewContent) {
            projectsPreviewContent.innerHTML = msg.content || '';  // HTML from markdown.api.render
        }
        if (projectsEditor) projectsEditor.value = msg.rawContent || '';  // raw markdown for editing
        state.editOriginalContent.projects = msg.rawContent || '';
        setProjectsPrdEditorEnabled(true);
        if (projectsPrdStatus) projectsPrdStatus.textContent = msg.exists ? '' : 'New PRD — not yet saved';
        if (projectsPrdPathHint) projectsPrdPathHint.textContent = msg.path || '';
        _prdLoadedProject = msg.projectName;
        _prdDirty = false;
        state.dirtyFlags.projects = false;
        // Show "not written yet" onboarding when no PRD exists.
        if (!msg.exists && projectsPreviewContent) {
            projectsPreviewContent.innerHTML = `
                <div class="constitution-onboarding">
                    <p class="constitution-onboarding-title">No PRD found for this project.</p>
                    <p>A PRD (Product Requirements Document) is a loose set of product requirements respected across all plans in a project — independent of epics. When <strong>PROJECT CONTEXT</strong> is on, this PRD is injected into <em>every</em> dispatched prompt.</p>
                    <p>Use <strong>Build via Planner</strong> above to generate one, or <strong>Edit</strong> to write it yourself.</p>
                </div>
            `;
        }
        // Enable Edit button only when a project is selected.
        if (btnEditProjects) btnEditProjects.disabled = false;
    }
    break;
}
```

Update `setProjectsPrdEditorEnabled` (line 977) to also toggle the Edit button:
```javascript
function setProjectsPrdEditorEnabled(enabled) {
    if (btnEditProjects) btnEditProjects.disabled = !enabled;
    // btnSaveProjects / btnCancelProjects visibility is controlled by enterEditMode/exitEditMode.
}
```

**Change 6 — Wire "Build via Planner" and "Copy Build Prompt".**

```javascript
const btnBuildPrd = document.getElementById('btn-build-prd-via-planner');
const btnCopyPrdPrompt = document.getElementById('btn-copy-prd-prompt');
if (btnBuildPrd) {
    btnBuildPrd.addEventListener('click', () => {
        if (!_selectedProjectName) return;
        vscode.postMessage({
            type: 'invokePrdBuilder',
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

Enable `btnBuildPrd` and `btnCopyPrdPrompt` when a project is selected (in
`renderProjectsList` / `requestProjectPrd`):
```javascript
if (btnBuildPrd) btnBuildPrd.disabled = !_selectedProjectName;
if (btnCopyPrdPrompt) btnCopyPrdPrompt.disabled = !_selectedProjectName;
```

### File: `src/services/PlanningPanelProvider.ts`

**Change 7 — Add backend handlers for `invokePrdBuilder` and
`copyPrdBuildPrompt`.**

Mirror the Constitution tab's `invokeConstitutionBuilder` handler (line 3349)
and `copyConstitutionPrompt` handler (line 3266). Add these two cases near the
existing `getProjectPrd` / `saveProjectPrd` handlers (after line 3254):

```typescript
case 'invokePrdBuilder': {
    const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!wsRoot || typeof msg.projectName !== 'string') { break; }
    const projectName = msg.projectName;
    const promptText =
        `Please act as a product manager. I want to build a Product Requirements Document (PRD) for the project "${projectName}" in the workspace at ${wsRoot}.\n` +
        `A PRD is a loose set of product requirements respected across all plans in this project — independent of epics. It is NOT a technical spec or a constitution; it captures WHAT the product should do and for whom, not HOW it is built.\n\n` +
        `Please ask me the following questions one by one or help me draft it:\n` +
        `1. Vision: In one sentence, what is this project's primary purpose?\n` +
        `2. Target Users: Who are the primary users, and what is their main pain point?\n` +
        `3. Key Features: What are the 3-7 core features or capabilities? Give each a short name and one sentence.\n` +
        `4. Success Criteria: How will we know this project is working? List 2-4 measurable outcomes.\n` +
        `5. Non-Goals: What are specific things this project will NOT do in its current scope?\n` +
        `6. Open Questions: What are the top 2-3 unresolved decisions or risks?\n\n` +
        `Please format the output document strictly as follows:\n` +
        `# ${projectName} — PRD\n\n` +
        `> **Vision:** [one sentence]\n\n` +
        `## Target Users\n[Who they are and their main pain point]\n\n` +
        `## Key Features\n- **[Name]:** [one sentence]\n\n` +
        `## Success Criteria\n- [measurable outcome]\n\n` +
        `## Non-Goals\n- [explicit exclusion]\n\n` +
        `## Open Questions\n- [unresolved decision or risk]\n\n` +
        `Save the result to .switchboard/projects/${projectName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}/prd.md\n`;
    if (this._taskViewerProvider) {
        const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole('planner', promptText, wsRoot);
        if (dispatched) { break; }
    }
    const terminal = vscode.window.terminals.find(t => t.name.toLowerCase().includes('planner') || t.name.toLowerCase().includes('lead'))
        || vscode.window.createTerminal({ name: 'PRD Builder', cwd: wsRoot });
    terminal.show();
    const { sendRobustText } = require('./terminalUtils');
    await sendRobustText(terminal, promptText);
    break;
}
case 'copyPrdBuildPrompt': {
    const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!wsRoot || typeof msg.projectName !== 'string') { break; }
    const projectName = msg.projectName;
    const promptText =
        `Please act as a product manager. I want to build a Product Requirements Document (PRD) for the project "${projectName}" in the workspace at ${wsRoot}.\n` +
        `A PRD is a loose set of product requirements respected across all plans in this project — independent of epics. It is NOT a technical spec or a constitution; it captures WHAT the product should do and for whom, not HOW it is built.\n\n` +
        `Please ask me the following questions one by one or help me draft it:\n` +
        `1. Vision: In one sentence, what is this project's primary purpose?\n` +
        `2. Target Users: Who are the primary users, and what is their main pain point?\n` +
        `3. Key Features: What are the 3-7 core features or capabilities? Give each a short name and one sentence.\n` +
        `4. Success Criteria: How will we know this project is working? List 2-4 measurable outcomes.\n` +
        `5. Non-Goals: What are specific things this project will NOT do in its current scope?\n` +
        `6. Open Questions: What are the top 2-3 unresolved decisions or risks?\n\n` +
        `Please format the output document strictly as follows:\n` +
        `# ${projectName} — PRD\n\n` +
        `> **Vision:** [one sentence]\n\n` +
        `## Target Users\n[Who they are and their main pain point]\n\n` +
        `## Key Features\n- **[Name]:** [one sentence]\n\n` +
        `## Success Criteria\n- [measurable outcome]\n\n` +
        `## Non-Goals\n- [explicit exclusion]\n\n` +
        `## Open Questions\n- [unresolved decision or risk]\n`;
    await vscode.env.clipboard.writeText(promptText);
    this._projectPanel?.webview.postMessage({ type: 'prdPromptCopied' });
    break;
}
```

**Change 7b — Extend `getProjectPrd` to render markdown to HTML (line 3211).**

The current handler returns raw markdown. The preview pane needs HTML. Mirror
the `kanbanPlanPreviewReady` pattern (line 1247):

```typescript
case 'getProjectPrd': {
    const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (wsRoot && typeof msg.projectName === 'string') {
        const filePath = getProjectPrdPath(wsRoot, msg.projectName);
        let rawContent = '';
        let exists = false;
        try {
            if (fs.existsSync(filePath)) {
                rawContent = await fs.promises.readFile(filePath, 'utf8');
                exists = true;
            }
        } catch { /* non-fatal */ }
        // Render markdown to HTML for the preview pane (mirrors kanbanPlanPreviewReady).
        let renderedHtml = '';
        try {
            renderedHtml = await vscode.commands.executeCommand<string>('markdown.api.render', rawContent);
        } catch { renderedHtml = ''; }
        this._projectPanel?.webview.postMessage({
            type: 'projectPrdContent',
            projectName: msg.projectName,
            workspaceRoot: wsRoot,
            content: renderedHtml,    // HTML for preview pane
            rawContent,               // raw markdown for editor
            exists,
            path: filePath
        });
    }
    break;
}
```

## Verification Plan

### Automated Tests
> Per session directives, automated tests are NOT run as part of this plan.
> The test suite will be run separately by the user. The following manual
> verification steps are for the implementer's self-check.

1. **Visual parity test:** Open the Projects tab. Confirm it uses the same
   layout, sidebar width, cyber-scanlines, and themed background as the Kanban
   and Constitution tabs — no grey box.
2. **Sidebar list test:** With projects on the kanban board, confirm the
   projects appear as clickable items in the sidebar (not a dropdown). Click
   each and confirm the PRD loads in the preview pane (rendered as HTML, not
   literal markdown).
3. **Empty state test:** Select a workspace with no projects. Confirm the
   sidebar shows "No projects — add one on the Kanban board (+)."
4. **Not-written-yet test:** Select a project with no PRD. Confirm the preview
   shows the "No PRD found for this project" onboarding message with Build via
   Planner / Edit guidance (not an empty textarea).
5. **Build via Planner test:** Click "Build via Planner" for a project with no
   PRD. Confirm a planner dispatch fires (or a build prompt is copied for the
   Copy variant). Confirm the generated PRD loads into the preview/editor after
   saving.
6. **Edit/Save/Cancel test:** Click Edit, confirm the textarea appears with the
   raw markdown and the preview hides. Modify the PRD, click Save. Confirm the
   PRD is written to `.switchboard/projects/<project>/prd.md` and the preview
   updates with rendered HTML. Click Cancel instead of Save — confirm edits are
   discarded and the original preview restores.
7. **PROJECT CONTEXT toggle test:** Toggle PROJECT CONTEXT on. Confirm the
   selected project's PRD is injected into a subsequent dispatch (verify via a
   test dispatch or the existing context-injection path).
8. **Sidebar collapse test:** Collapse the projects sidebar via the toggle.
   Confirm it collapses and restores correctly, and the collapse state
   persists on tab switch (verify `vscode.getState()` includes
   `projectsListCollapsed`).
9. **Existing PRD migration test:** For a project with an existing `prd.md`,
   confirm the content loads into the preview as rendered HTML on selection
   (no data loss). Confirm the Edit button loads the raw markdown into the
   textarea.
10. **Tab-switch regression test:** Switch between Kanban, Projects, Epics,
    Constitution, System tabs. Confirm each renders correctly with no styling
    bleed. Specifically verify the System tab's sidebar now collapses correctly
    (pre-existing CSS bug fix).
11. **Stale-response guard test:** Rapidly click two different projects in the
    sidebar. Confirm the preview ends up showing the second project's PRD (not
    a stale first-project response).
