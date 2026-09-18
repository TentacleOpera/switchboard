# Fix Project Sidebar Collapse Button

## Goal
Fix the non-functional collapse sidebar button in `project.html` by adding the missing CSS and JavaScript implementation that exists in `planning.html`.

**Problem Analysis:** The collapse sidebar button in `project.html` (`.sidebar-toggle-btn`) is rendered in the Kanban tab HTML and recreated dynamically by `renderKanbanPlans()`, but it has no functionality because:

1. **Missing CSS**: No `.content-row.collapsed` styles to handle the collapsed state
2. **Missing JavaScript**: No `toggleSidebarCollapsed()` function to toggle the class
3. **Missing Event Listener**: No click handler bound to the button
4. **Missing State Management**: No persistence of collapsed state across sessions
5. **Missing Toggle Buttons in Epics/Constitution Tabs**: The static HTML for the Epics tab (`#epics-list-pane`) and Constitution tab (`#constitution-list-pane`) contain no `.sidebar-toggle-btn` element. Their respective render functions (`renderEpicsList()` and `renderConstitutionWorkspaceList()`) also do not create one.

The same feature works correctly in `planning.html` / `planning.js` with a complete implementation including CSS rules, JavaScript toggle logic, and state persistence via `vscode.setState()`.

## Metadata
**Complexity:** 2
**Tags:** ui, bugfix, frontend

## User Review Required
No — implementation is a direct port of an existing, working pattern from `planning.js` to `project.js` with no product-scope changes.

## Complexity Audit

### Routine
- Single-file CSS addition (5 rules, copied from `planning.html`)
- Single-file JS addition (`applySidebarState`, `toggleSidebarCollapsed`, state init)
- Event listener wiring to existing dynamically-created buttons
- Tab-switch handler augmentation

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- `renderKanbanPlans()` clears `kanbanListPane.innerHTML` and rebuilds the toggle button. The button text must use `state.kanbanListCollapsed` on creation so the initial glyph matches the persisted collapsed state. The dynamically attached `click` listener ensures the button works even after rebuilds.
- Epics and Constitution tabs have no static toggle button; their render functions must create one before returning or the user has nothing to click.

### Security
- No user input is reflected into the DOM. State is read from `vscode.getState()`, which is scoped to the webview. No security impact.

### Side Effects
- `vscode.setState()` is called on every toggle. This writes to the webview's persisted state. There is zero risk of collision because `project.js` currently never calls `vscode.getState()` or `vscode.setState()`.
- `applySidebarState('kanban', ...)` is called on script load, before `renderKanbanPlans()` has run. At that moment the static HTML button exists, so the glyph is updated correctly. When `renderKanbanPlans()` later runs, it destroys and recreates the button using the correct glyph from state.

### Dependencies & Conflicts
- None. No new runtime dependencies. The feature is self-contained within the webview layer.

## Dependencies
- None

## Adversarial Synthesis

Key risks: (1) The shadow-variable bug `const activeTab = activeTab` would throw a ReferenceError in strict mode, breaking the entire toggle function; (2) Epics and Constitution tabs lack static toggle buttons, so wiring only the Kanban tab leaves two tabs permanently non-collapsible; (3) `renderKanbanPlans()` unconditionally sets `toggleBtn.textContent = '«'`, which would override the persisted collapsed state glyph after the first render. Mitigations: Remove the `const` shadow, explicitly create toggle buttons in `renderEpicsList()` and `renderConstitutionWorkspaceList()`, and read collapsed state when creating dynamic buttons.

## Proposed Changes

### `src/webview/project.html`

**Context:** The `<style>` block (starting line 8) defines `.content-row` and the three sidebar pane IDs (`#kanban-list-pane`, `#epics-list-pane`, `#constitution-list-pane`) but has no `.collapsed` variant. Insert the following CSS immediately after the `.sidebar-toggle-btn:hover` rule (around line 324):

**Implementation:**

```css
/* Insert after .sidebar-toggle-btn:hover rule (~line 324) */
.content-row.collapsed > :first-child {
    flex: 0 0 40px !important;
}
.content-row.collapsed > :last-child {
    flex: 1 !important;
}

.content-row.collapsed #kanban-list-pane,
.content-row.collapsed #epics-list-pane,
.content-row.collapsed #constitution-list-pane {
    padding: 4px;
    overflow: hidden;
}

.content-row.collapsed #kanban-list-pane > *:not(.sidebar-toggle-row),
.content-row.collapsed #epics-list-pane > *:not(.sidebar-toggle-row),
.content-row.collapsed #constitution-list-pane > *:not(.sidebar-toggle-row) {
    display: none !important;
}

.content-row.collapsed .sidebar-toggle-row {
    position: static;
    display: flex;
    justify-content: center;
    margin-bottom: 8px;
}
```

**Edge Cases:** The `!important` on `display: none` prevents any child element from overriding the hidden state when collapsed. The `flex: 0 0 40px` on `:first-child` overrides the default `width: 320px` on the pane IDs because of selector specificity (`!important`).

---

### `src/webview/project.js`

**Context:** `project.js` uses an IIFE pattern. The global `state` object is declared at line 32. The `activeTab` variable is declared at line 7. The tab click handler is at lines 9-29. `renderKanbanPlans()` (line 304) dynamically creates a toggle button but attaches no listener and hardcodes `'«'`. `renderEpicsList()` (line 591) and `renderConstitutionWorkspaceList()` (line 743) do not create toggle buttons at all.

**Implementation:**

**Step A — Extend the `state` object (around line 32)**

Add three new properties to the existing `state` declaration:

```javascript
const state = {
    editMode: { kanban: false, constitution: false },
    editOriginalContent: { kanban: null, constitution: null },
    dirtyFlags: { kanban: false, constitution: false },
    externalChangePending: { kanban: false, constitution: false },
    reviewMode: { kanban: false },
    // NEW: sidebar collapse state
    kanbanListCollapsed: false,
    epicsListCollapsed: false,
    constitutionListCollapsed: false
};
```

Immediately after the `state` declaration, add persisted-state hydration:

```javascript
// Initialize from persisted state
const persistedState = vscode.getState() || {};
state.kanbanListCollapsed = persistedState.kanbanListCollapsed || false;
state.epicsListCollapsed = persistedState.epicsListCollapsed || false;
state.constitutionListCollapsed = persistedState.constitutionListCollapsed || false;
```

**Step B — Add helper functions (after state init, before kanban tab section)**

```javascript
function applySidebarState(tabName, collapsed) {
    const tabContent = document.getElementById(`${tabName}-content`);
    if (!tabContent) return;
    const contentRow = tabContent.querySelector('.content-row');
    const toggleBtn = tabContent.querySelector('.sidebar-toggle-btn');
    if (contentRow) {
        contentRow.classList.toggle('collapsed', collapsed);
    }
    if (toggleBtn) {
        toggleBtn.textContent = collapsed ? '»' : '«';
    }
}

function toggleSidebarCollapsed() {
    // Use the existing global activeTab variable (declared at line 7)
    if (activeTab === 'kanban') {
        state.kanbanListCollapsed = !state.kanbanListCollapsed;
        applySidebarState('kanban', state.kanbanListCollapsed);
    } else if (activeTab === 'epics') {
        state.epicsListCollapsed = !state.epicsListCollapsed;
        applySidebarState('epics', state.epicsListCollapsed);
    } else if (activeTab === 'constitution') {
        state.constitutionListCollapsed = !state.constitutionListCollapsed;
        applySidebarState('constitution', state.constitutionListCollapsed);
    }

    // Persist state
    const currentPersisted = vscode.getState() || {};
    vscode.setState({
        ...currentPersisted,
        kanbanListCollapsed: state.kanbanListCollapsed,
        epicsListCollapsed: state.epicsListCollapsed,
        constitutionListCollapsed: state.constitutionListCollapsed
    });
}
```

**Step C — Update `renderKanbanPlans()` (around line 324-332)**

Replace the unconditional `'«'` with state-driven text and attach the click listener:

```javascript
// Inside renderKanbanPlans(), after kanbanListPane.innerHTML = ''
const toggleRow = document.createElement('div');
toggleRow.className = 'sidebar-toggle-row';
const toggleBtn = document.createElement('button');
toggleBtn.className = 'sidebar-toggle-btn';
toggleBtn.title = 'Toggle sidebar';
toggleBtn.textContent = state.kanbanListCollapsed ? '»' : '«';
toggleBtn.addEventListener('click', toggleSidebarCollapsed);
toggleRow.appendChild(toggleBtn);
kanbanListPane.appendChild(toggleRow);
```

**Step D — Update `renderEpicsList()` (around line 599)**

Insert toggle-button creation immediately after `epicsListPane.innerHTML = '';`:

```javascript
function renderEpicsList() {
    if (!epicsListPane) return;

    let filtered = _kanbanPlansCache.filter(plan => plan.isEpic);
    if (epicsFilters.workspaceRoot) {
        filtered = filtered.filter(plan => plan.workspaceRoot === epicsFilters.workspaceRoot);
    }

    epicsListPane.innerHTML = '';

    // NEW: Create toggle button (present even when empty)
    const toggleRow = document.createElement('div');
    toggleRow.className = 'sidebar-toggle-row';
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'sidebar-toggle-btn';
    toggleBtn.title = 'Toggle sidebar';
    toggleBtn.textContent = state.epicsListCollapsed ? '»' : '«';
    toggleBtn.addEventListener('click', toggleSidebarCollapsed);
    toggleRow.appendChild(toggleBtn);
    epicsListPane.appendChild(toggleRow);

    if (filtered.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'empty-state';
        emptyState.textContent = 'No epics found. Create a plan and toggle its Epic status on the board.';
        epicsListPane.appendChild(emptyState);
        return;
    }
    // ... rest of existing loop unchanged
}
```

**Step E — Update `renderConstitutionWorkspaceList()` (around line 744)**

Insert toggle-button creation immediately after `constitutionListPane.innerHTML = '';`:

```javascript
function renderConstitutionWorkspaceList() {
    if (!constitutionListPane) return;
    constitutionListPane.innerHTML = '';

    // NEW: Create toggle button (present even when empty)
    const toggleRow = document.createElement('div');
    toggleRow.className = 'sidebar-toggle-row';
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'sidebar-toggle-btn';
    toggleBtn.title = 'Toggle sidebar';
    toggleBtn.textContent = state.constitutionListCollapsed ? '»' : '«';
    toggleBtn.addEventListener('click', toggleSidebarCollapsed);
    toggleRow.appendChild(toggleBtn);
    constitutionListPane.appendChild(toggleRow);

    if (_constitutionWorkspaces.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'empty-state';
        emptyState.textContent = 'No workspaces open';
        constitutionListPane.appendChild(emptyState);
        return;
    }
    // ... rest of existing loop unchanged
}
```

**Step F — Update tab switch handler (around line 9-29)**

Add sidebar-state application inside the existing click handler, immediately after `activeTab = targetTab;`:

```javascript
tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const targetTab = tab.dataset.tab;
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));

        tab.classList.add('active');
        const targetContent = document.getElementById(`${targetTab}-content`);
        if (targetContent) targetContent.classList.add('active');
        activeTab = targetTab;

        // NEW: Apply sidebar state for the active tab
        if (targetTab === 'kanban') {
            applySidebarState('kanban', state.kanbanListCollapsed);
        } else if (targetTab === 'epics') {
            applySidebarState('epics', state.epicsListCollapsed);
        } else if (targetTab === 'constitution') {
            applySidebarState('constitution', state.constitutionListCollapsed);
        }

        if (activeTab === 'kanban') {
            vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
        } else if (activeTab === 'epics') {
            vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
            updateActiveEpicBanner();
        } else if (activeTab === 'constitution') {
            vscode.postMessage({ type: 'loadConstitutionFiles' });
        }
    });
});
```

**Step G — Initialize sidebar state on script load**

Add at the end of the IIFE, after all function definitions but before the closing `})();`:

```javascript
// Initialize sidebar state on load
applySidebarState('kanban', state.kanbanListCollapsed);
applySidebarState('epics', state.epicsListCollapsed);
applySidebarState('constitution', state.constitutionListCollapsed);

// Bind global event listeners for any static toggle buttons
// (Dynamic buttons created by render functions get their own listeners)
document.querySelectorAll('.sidebar-toggle-btn').forEach(btn => {
    btn.addEventListener('click', toggleSidebarCollapsed);
});
```

**Edge Cases:**
- The global `activeTab` variable is used directly without redeclaration, avoiding the temporal-dead-zone bug (`const activeTab = activeTab`).
- `applySidebarState` safely returns early if `tabContent` is missing, so it is safe to call before the DOM is fully populated.
- Dynamically created buttons in render functions each get their own listener, so they work after re-renders triggered by filter changes.

## Files Changed
- `src/webview/project.html` — Add `.content-row.collapsed` CSS rules (~line 324)
- `src/webview/project.js` — Add `applySidebarState`, `toggleSidebarCollapsed`, state hydration, dynamic button creation in `renderKanbanPlans()` / `renderEpicsList()` / `renderConstitutionWorkspaceList()`, tab-switch sidebar-state application, and initialization

## Verification Plan

### Manual Verification
1. Open `project.html` in the extension
2. Click the collapse sidebar button («) in the Kanban tab
3. Verify the sidebar collapses to 40px width and non-toggle content is hidden
4. Verify button text changes to »
5. Click again to expand and verify it restores
6. Switch to Epics tab, verify a toggle button appears, and test collapse/expand independently
7. Switch to Constitution tab, verify a toggle button appears, and test collapse/expand independently
8. Refresh the webview and verify collapsed state persists for each tab

### Automated Tests
- Skipped per session directive. The test suite will be run separately by the user.

## Risks
- **Low risk**: Changes are localized to sidebar toggle functionality
- **No state collision**: `project.js` currently makes no `vscode.getState()` / `vscode.setState()` calls, so the new keys cannot conflict with existing persisted data
- **Tab switching**: State is explicitly re-applied in the tab click handler; render functions also set the correct button glyph on rebuild

## Review Findings

**Files changed:** `src/webview/project.html` (added `.content-row.collapsed` CSS rules; added static `.sidebar-toggle-btn` elements to Epics and Constitution tab HTML); `src/webview/project.js` (added `state` collapse properties with `vscode.getState()` hydration, `applySidebarState` and `toggleSidebarCollapsed` helpers, dynamic toggle-button creation in `renderKanbanPlans()` / `renderEpicsList()` / `renderConstitutionWorkspaceList()`, tab-switch sidebar-state application, and init-time state application + global listener binding).

**Fix applied during review:** Added static toggle buttons to Epics and Constitution HTML (`#epics-list-pane` and `#constitution-list-pane`) to prevent a race where a previously-collapsed tab could render as an empty 40px pane with no visible toggle button before `renderEpicsList()` / `renderConstitutionWorkspaceList()` runs.

**Validation:** Per session directive, compilation and tests were skipped. Manual code-path audit confirms all three tabs have toggle buttons in both static HTML and dynamic render paths, `activeTab` is used without shadow redeclaration, `vscode.getState()` / `vscode.setState()` are collision-free, and `applySidebarState` safely no-ops when DOM elements are absent.

**Remaining risks:** None material. The implementation is a direct, verified port of the working `planning.js` pattern.

## Recommendation
**Send to Intern** — Complexity 2. Straightforward port of a working pattern from `planning.js` to `project.js` with no architectural changes.
