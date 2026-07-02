# Epics Tab — Add Project Filter Dropdown

## Goal

The Epics tab in `project.html` is missing a project filter dropdown. The Kanban Plans tab has `kanban-project-filter` which lets users narrow the plan list to a specific project (or "(No Project)"), but the Epics tab only offers workspace and column filters. When a workspace contains many projects, the epics list cannot be narrowed by project, making it hard to find epics belonging to a specific project.

### Problem Analysis & Root Cause

Epics are stored in the same DB-backed cache as regular plans (`_kanbanPlansCache`) and are distinguished by `plan.isEpic === true` (see `renderEpicsList` at `project.js:1916`). Each epic plan object carries a `project` field identical to regular plans, so the data needed to filter by project already exists.

The root cause is a simple omission: when the Epics tab was built, the controls strip (`project.html:1557-1564`) was given `epics-workspace-filter` and `epics-column-filter` but no `epics-project-filter`. Correspondingly:

- The `epicsFilters` state object (`project.js:375`) only has `{ workspaceRoot, column }` — no `project` key.
- `renderEpicsList` (`project.js:1910`) only applies workspace and column filters, never a project filter.
- No `updateEpicsProjectFilter` population function exists (the kanban equivalent is `updateKanbanProjectFilter` at `project.js:1177`).
- No change-event listener is wired for an epics project filter (the kanban equivalent is at `project.js:1884-1888`).

The fix is to mirror the existing, proven kanban project-filter pattern onto the epics tab. This is low-risk because the data model and rendering pipeline already support `plan.project`.

## Metadata

- **Tags**: `webview`, `epics`, `ui`, `filter`, `project-html`
- **Complexity**: 3/10

## Complexity Audit

**Routine.** This is a UI parity fix that replicates an already-working pattern (`kanban-project-filter`) onto a sibling tab. No new data sources, no backend/extension-host changes, no DB schema changes — epics already carry `plan.project` in the same cache used by the kanban tab. All changes are confined to two files (`project.html`, `project.js`) and follow established conventions verbatim.

The only mild risk is filter-state lifecycle: the new `epicsFilters.project` must be reset in the same places `epicsFilters.workspaceRoot` / `epicsFilters.column` are reset (e.g. `activateKanbanTabAndSelectPlan` epic intent at `project.js:617-618`), otherwise a stale project filter could hide an epic that a deep-link intends to select.

## Edge-Case & Dependency Audit

1. **Stale filter on deep-link selection** — `activateKanbanTabAndSelectPlan` with `isEpic: true` clears `epicsFilters.workspaceRoot` and `epicsFilters.column` (`project.js:617-620`) so a deep-linked epic is visible. The new `epicsFilters.project` MUST be cleared in the same block, and the new dropdown reset to `''`, or the pending epic selection may be filtered out and never resolve.
2. **Workspace change should reset project filter** — When `epics-workspace-filter` changes (`project.js:2361-2365`), the project filter options must be repopulated (the available projects differ per workspace) and `epicsFilters.project` reset to `''`, mirroring how `kanbanWorkspaceFilter` change resets `kanbanFilters.project` and calls `updateKanbanProjectFilter` (`project.js:1877-1881`).
3. **"(No Project)" option** — `updateKanbanProjectFilter` adds a `__none__` option when any plan in scope lacks a `project` (`project.js:1191-1201`). The epics equivalent must do the same but scoped to epic plans only (`plan.isEpic`), otherwise epics with no project become unfilterable/hidden when a real project is selected.
4. **Project set scoped to epics** — The kanban project filter builds its option set from `_kanbanAllWorkspaceProjects` plus a `hasNoProject` check over non-epic plans. The epics version must build its option set from the projects that actually appear on epic plans in `_kanbanPlansCache` (filtered by workspace), not from the kanban project set — otherwise the dropdown may list projects that have no epics, and miss projects that only epics use.
5. **No dependency on extension host** — `_kanbanPlansCache` and `_kanbanAllWorkspaceProjects` are already populated by the existing `kanbanPlansReady` / `kanbanWorkspaceProjects` messages; no new message types are needed.
6. **`populateKanbanFilters` hook** — The kanban project filter is refreshed inside `populateKanbanFilters` (`project.js:1150-1175`), which also refreshes `epicsColumnFilter`. The new epics project filter population should be called from here too so it stays in sync after plan/workspace data refreshes.

## Proposed Changes

### 1. `src/webview/project.html` — add the dropdown to the epics controls strip

Insert an `epics-project-filter` select between the workspace filter and the column filter, mirroring `kanban-project-filter` (`project.html:1482-1484`).

```html
<!-- project.html, inside #epics-content .controls-strip (currently lines 1557-1564) -->
<div class="controls-strip">
    <select id="epics-workspace-filter">
        <option value="">All Workspaces</option>
    </select>
    <select id="epics-project-filter">
        <option value="">All Projects</option>
    </select>
    <select id="epics-column-filter">
        <option value="">All Columns</option>
    </select>
    <button id="btn-new-epic" class="strip-btn">+ New Epic</button>
</div>
```

### 2. `src/webview/project.js` — add the filter element reference and state

```js
// project.js:227 — after epicsColumnFilter
const epicsProjectFilter = document.getElementById('epics-project-filter');

// project.js:375 — add project key
const epicsFilters = { workspaceRoot: '', column: '', project: '' };
```

### 3. `src/webview/project.js` — add `updateEpicsProjectFilter` population function

Place it right after `updateKanbanProjectFilter` (ends at `project.js:1210`). It builds the option set from epic plans only, scoped to the selected workspace, and includes the `__none__` option when an epic has no project.

```js
function updateEpicsProjectFilter() {
    if (!epicsProjectFilter) return;
    const selectedRoot = epicsFilters.workspaceRoot;
    const epicPlans = _kanbanPlansCache.filter(p =>
        p.isEpic && (!selectedRoot || normalizeRoot(p.workspaceRoot) === normalizeRoot(selectedRoot))
    );
    const projectSet = new Set();
    epicPlans.forEach(p => { if (p.project) projectSet.add(p.project); });
    const hasNoProject = epicPlans.some(p => !p.project);

    epicsProjectFilter.innerHTML = '<option value="">All Projects</option>';
    if (hasNoProject) {
        const optNone = document.createElement('option');
        optNone.value = '__none__';
        optNone.textContent = '(No Project)';
        epicsProjectFilter.appendChild(optNone);
    }
    Array.from(projectSet).sort().forEach(proj => {
        const opt = document.createElement('option');
        opt.value = proj;
        opt.textContent = proj;
        epicsProjectFilter.appendChild(opt);
    });
    // If the current selection is no longer valid for the new option set, reset.
    if (epicsFilters.project && epicsFilters.project !== '__none__' && !projectSet.has(epicsFilters.project)) {
        epicsFilters.project = '';
    }
    epicsProjectFilter.value = epicsFilters.project;
}
```

### 4. `src/webview/project.js` — call the populator from `populateKanbanFilters`

Inside `populateKanbanFilters` (`project.js:1150-1175`), alongside the existing `epicsColumnFilter` refresh block, add a call so the epics project filter stays in sync after data refreshes.

```js
// project.js:1164 — after the epicsColumnFilter block
if (epicsProjectFilter) {
    updateEpicsProjectFilter();
}
```

### 5. `src/webview/project.js` — apply the project filter in `renderEpicsList`

Add the project filter check in `renderEpicsList` (`project.js:1916-1922`), mirroring `getFilteredKanbanPlans` (`project.js:1409-1415`).

```js
// project.js:1920 — after the column filter block, before epicsListPane.innerHTML = '';
if (epicsFilters.project) {
    if (epicsFilters.project === '__none__') {
        filtered = filtered.filter(plan => !plan.project);
    } else if (plan.project !== epicsFilters.project) {
        // (handled below via re-filter)
    }
}
```

Concretely, insert this block right after the `epicsFilters.column` check:

```js
if (epicsFilters.project) {
    if (epicsFilters.project === '__none__') {
        filtered = filtered.filter(plan => !plan.project);
    } else {
        filtered = filtered.filter(plan => plan.project === epicsFilters.project);
    }
}
```

### 6. `src/webview/project.js` — wire the change listener and reset on workspace change

Add the change listener near the other epics filter listeners (`project.js:2361-2373`), and reset the project filter when the workspace filter changes.

```js
// project.js:2361 — modify the epicsWorkspaceFilter change handler
if (epicsWorkspaceFilter) {
    epicsWorkspaceFilter.addEventListener('change', () => {
        epicsFilters.workspaceRoot = epicsWorkspaceFilter.value;
        epicsFilters.project = '';          // reset project when workspace changes
        updateEpicsProjectFilter();         // repopulate options for the new workspace
        renderEpicsList();
    });
}

if (epicsColumnFilter) {
    epicsColumnFilter.addEventListener('change', () => {
        epicsFilters.column = epicsColumnFilter.value;
        renderEpicsList();
    });
}

// New listener
if (epicsProjectFilter) {
    epicsProjectFilter.addEventListener('change', () => {
        epicsFilters.project = epicsProjectFilter.value;
        renderEpicsList();
    });
}
```

### 7. `src/webview/project.js` — reset the new filter in the epic deep-link path

In the `activateKanbanTabAndSelectPlan` / `isEpic` block (`project.js:617-620`), clear the new filter so a deep-linked epic is never hidden by a stale project selection.

```js
// project.js:617-620 — add project reset
epicsFilters.workspaceRoot = '';
epicsFilters.column = '';
epicsFilters.project = '';
if (epicsWorkspaceFilter) epicsWorkspaceFilter.value = '';
if (epicsColumnFilter) epicsColumnFilter.value = '';
if (epicsProjectFilter) epicsProjectFilter.value = '';
```

## Verification Plan

1. **Build**: Run `npm run compile` (webpack) and confirm no errors. (Note: per project rules, `dist/` is not used during dev/testing — all verification is via an installed VSIX. The compile step is only to catch syntax/typing errors.)
2. **Manual — dropdown appears**: Open the Switchboard Project panel, switch to the Epics tab, and confirm a project filter dropdown is present between the workspace and column filters, defaulting to "All Projects".
3. **Manual — filtering works**: With epics spanning multiple projects, select a specific project and confirm only epics with that `project` appear; select "(No Project)" and confirm only epics with no project appear; reset to "All Projects" and confirm all epics return.
4. **Manual — workspace interaction**: Change the workspace filter and confirm the project filter resets to "All Projects" and its options update to reflect projects that have epics in the selected workspace only.
5. **Manual — deep-link**: Trigger an `activateKanbanTabAndSelectPlan` for an epic (e.g. from a kanban Review click) and confirm the Epics tab opens with the target epic selected and visible, with all filters cleared.
6. **Regression — kanban tab unaffected**: Switch to the Kanban Plans tab and confirm its project filter still behaves exactly as before (no shared state bleed).
