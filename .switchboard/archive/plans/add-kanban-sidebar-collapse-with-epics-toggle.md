# Add Collapse-Sidebar Button to Kanban Plans Tab with Co-located Epics/Plans Toggle

## Goal

The Kanban Plans tab in `planning.html` lacks the collapse-sidebar button («/») that every other tab (Local Docs, Online Docs, Tickets) already has. Additionally, the user wants the existing **Epics/Plans view toggle** to move out of the top controls strip and into that same sidebar-toggle row, with its label dynamically reflecting the current mode.

### Problem Analysis

- **Missing collapse button:** `#kanban-content` has no `.sidebar-toggle-row`, so users cannot collapse the plan-list sidebar to widen the preview pane.
- **Epics toggle is orphaned in the controls strip:** The `#kanban-view-epics` button currently sits in `.kanban-controls-strip` alongside workspace/project filters. The user wants it visually paired with the collapse control inside the left pane.
- **Static label:** The button always reads "Epics" regardless of whether the list is currently showing all plans or filtered to epics only.
- **No collapse state persistence:** The `kanban` tab is absent from `toggleSidebarCollapsed()`, `applySidebarState()`, and persisted VS Code webview state.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, ux

## User Review Required

- Confirm the mode-toggle button should be hidden when the sidebar is collapsed (existing `.sidebar-folders-btn` CSS hides it in collapsed state, matching the "Manage Folders" behavior in other tabs).

## Complexity Audit

### Routine
- Relocating a button between DOM containers
- Adding CSS selectors that follow an existing collapse pattern
- Adding a single boolean field to persisted state
- Reusing `applySidebarState()` and `toggleSidebarCollapsed()` mechanics already proven in three other tabs

### Complex / Risky
- `renderKanbanPlans()` dynamically rebuilds the toggle row on every render; the empty-list early-return path must not destroy the toggle row and strand the user in a collapsed state with no way to expand
- Event listeners on dynamically created buttons must be explicitly re-attached each render, unlike the global init-time binding used for static toggle rows

## Edge-Case & Dependency Audit

- **Race Conditions:** None. All changes are synchronous DOM mutations inside a single event handler or render function.
- **Security:** None. No new untrusted input surfaces are introduced.
- **Side Effects:** `vscode.setState()` gains a new `kanbanListCollapsed` key; this is backward-compatible because the state merge spreads the old object. `innerHTML = ''` destroys descendant event listeners; the plan explicitly rebuilds and re-binds listeners for the toggle row.
- **Dependencies & Conflicts:** No external dependencies. No conflicts with concurrent plans.

## Dependencies

None.

## Adversarial Synthesis

Key risks: label logic inconsistency in the original draft (step 1 vs step 2f), empty-state toggle row omission causing a collapsed trap, and missing explicit event listener re-attachment for dynamically built buttons. Mitigations: unify on "label = current mode", always render the toggle row before the empty message or plan items, and manually bind `toggleSidebarCollapsed` inside `renderKanbanPlans` just as `renderLocalDocs` does.

## Proposed Changes

### 1. HTML — Restructure `#kanban-list-pane`

In `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html`:

- Remove `id="kanban-view-epics"` from `.kanban-controls-strip` (line ~3100).
- Inside `#kanban-list-pane`, add a static `.sidebar-toggle-row` as the first child:
  - Left element: a new button `id="kanban-view-epics-toggle"` class `sidebar-folders-btn` (reuses existing `.sidebar-folders-btn` styling for visual consistency). Initial text should reflect the current mode. Since the default `_kanbanViewMode` is `all`, the button initially reads **"Plans"**.
  - Right element: a `.sidebar-toggle-btn` with text `«` and title "Toggle sidebar".

> **Clarification:** Existing CSS `.content-row.collapsed .sidebar-folders-btn { display: none !important; }` will hide the mode-toggle button when collapsed. This is acceptable and consistent with the "Manage Folders" button in other tabs.

### 2. CSS — Extend collapse selectors to Kanban pane

In `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html` styles:

- Add `#kanban-list-pane` to the `.content-row.collapsed` selector block that currently targets `#tree-pane`, `#tree-pane-online`, `#tree-pane-tickets`.
- Add `.content-row.collapsed #kanban-list-pane > *:not(.sidebar-toggle-row)` with `display: none !important`.
- Add `.content-row.collapsed #kanban-list-pane` with `padding: 4px; overflow: hidden;`.

> **Note:** Line numbers are approximate. Locate selectors by searching for the existing `#tree-pane` collapse rules rather than relying on exact offsets.

### 3. JS — State, persistence, and rendering wiring

In `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`:

**a. Add `kanbanListCollapsed` to persisted state (line ~27):**
```js
kanbanListCollapsed: persistedState.kanbanListCollapsed || false,
```

**b. Update `applySidebarState()` (line ~248):**
The function already looks up the tab's `.content-row` and `.sidebar-toggle-btn`. Since the kanban tab now has a `.sidebar-toggle-btn` inside `#kanban-list-pane`, it will work automatically once the other wiring is in place.

**c. Update `toggleSidebarCollapsed()` (line ~259):**
Add a `kanban` branch:
```js
if (activeTab === 'kanban') {
    state.kanbanListCollapsed = !state.kanbanListCollapsed;
    applySidebarState('kanban', state.kanbanListCollapsed);
} else if (activeTab === 'tickets') { ... }
```
And persist `kanbanListCollapsed` in the `vscode.setState()` call:
```js
vscode.setState({
    ...currentPersisted,
    docsListCollapsed: state.docsListCollapsed,
    ticketsPreviewCollapsed: state.ticketsPreviewCollapsed,
    kanbanListCollapsed: state.kanbanListCollapsed
});
```

**d. Update initialization block (line ~281):**
Add:
```js
applySidebarState('kanban', state.kanbanListCollapsed);
```

**e. Update tab-switch logic (line ~317):**
Add:
```js
else if (tabName === 'kanban') { applySidebarState('kanban', state.kanbanListCollapsed); }
```

**f. Update `renderKanbanPlans()` (line ~3535):**
The function currently does `kanbanListPane.innerHTML = ''` then rebuilds plan items. This would destroy any static toggle row. Change the clear logic to always rebuild the toggle row dynamically before appending plan items or the empty message (consistent with how `renderLocalDocs()` re-adds its toggle row).

The exact sequence should be:
1. `kanbanListPane.innerHTML = ''`
2. Build the toggle row (`document.createElement('div')`, class `sidebar-toggle-row`).
3. Create the mode-toggle button (`id="kanban-view-epics-toggle"`, class `sidebar-folders-btn`).
   - Text = `_kanbanViewMode === 'epics' ? 'Epics' : 'Plans'` (label reflects the **current** mode, as the user specified).
   - Attach a click listener that flips `_kanbanViewMode`, updates the button text, and re-invokes `renderKanbanPlans()`.
4. Create the collapse button (class `sidebar-toggle-btn`).
   - Text = `state.kanbanListCollapsed ? '»' : '«'`.
   - Attach `addEventListener('click', toggleSidebarCollapsed)` — **required because `innerHTML = ''` destroys the init-time listener**.
5. Append toggle row to `kanbanListPane`.
6. If `filtered.length === 0`, append the empty-state div and return.
7. Otherwise, append plan items as before.

**g. Update epics-mode toggle handler (line ~3364):**
The existing `kanbanViewEpicsBtn` click listener should be removed or redirected to the new button in the sidebar toggle row. Because the old `#kanban-view-epics` element is removed from the DOM, the existing `if (kanbanViewEpicsBtn) { ... }` block will simply not attach; no crash. The `_kanbanViewMode` flip logic moves into the new button's click listener created inside `renderKanbanPlans()`.

## Files Changed

- `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html` — HTML structure + CSS
- `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js` — State, persistence, collapse wiring, dynamic label

## Verification Plan

### Automated Tests

No automated tests required per session directives. The test suite will be run separately by the user.

### Manual Validation

1. Open the Planning panel and switch to the **Kanban Plans** tab.
2. Verify the left pane shows a top row with two buttons: the left one labeled **"Plans"** (initially, since default mode is `all`), and the right one labeled **«**.
3. Click **«** — the left pane collapses to 40px, the preview pane expands, and the button changes to **»**.
4. Click **»** — the pane expands back.
5. Switch to another tab and back to Kanban — collapse state should persist.
6. Reload the VS Code window — collapse state should persist (via `vscode.setState()` / `vscode.getState()`).
7. Click the mode-toggle button — label should immediately flip between "Epics" and "Plans" to reflect the new current mode.
8. Verify the controls strip no longer contains the old standalone "Epics" button.
9. **Edge case:** Filter to a combination that yields zero plans (e.g., an unused project). Ensure the collapsed toggle row still renders with the collapse button visible, even when the empty-state message is shown.

## Review Findings

Extracted `buildKanbanToggleRow()` in `planning.js` and used it in both `renderKanbanPlans` and `handleKanbanPlansReady`'s error path, fixing a CRITICAL bug where a plan-load error destroyed the sidebar toggle row and stranded the user. All plan requirements (HTML structure, CSS collapse selectors, state persistence, dynamic label, and empty-state safety) were already correctly implemented. Per session directives, compilation and tests were skipped; verification was by targeted code-path audit. No remaining material risks.

**Files changed:**
- `src/webview/planning.js`

**Recommendation:** Send to Intern
