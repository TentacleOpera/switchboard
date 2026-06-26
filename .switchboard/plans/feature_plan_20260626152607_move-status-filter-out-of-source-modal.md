# Move Status/State Filter Out of the Tickets Source Modal

## Goal

### Problem
The status filter (`tickets-status-filter` for ClickUp) and the state filter (`tickets-state-filter` for Linear) on the Tickets tab of `planning.html` are currently buried **inside** the "Source" modal (`#tickets-source-modal`). The user has to open the Source modal every time they want to change the status/state filter, which is a high-frequency action that should be inline with the ticket list.

### Background
The Source modal (`#tickets-source-modal`, lines 3777–3808 of `planning.html`) contains three filter `<select>` elements in a single flex row:
- `tickets-project-picker` — Linear project filter
- `tickets-state-filter` — Linear state filter
- `tickets-status-filter` — ClickUp status filter

These are shown/hidden by `renderTicketsLinearPanel()` and `renderTicketsClickUpPanel()` in `planning.js` based on the active provider. The modal is only opened by clicking the "Source" button (`#tickets-source-btn`). The filters are the only elements in the modal that change **after** a source is already selected — the provider selector and hierarchy nav are setup-time controls that legitimately belong in the modal.

### Root Cause
The filters were placed inside the Source modal during an earlier refactor that consolidated all source-configuration UI into one modal. The status/state filter is a **runtime list-filtering** control, not a **source-configuration** control, so it was misplaced.

## Metadata
- **Tags:** `ui`, `tickets-tab`, `planning.html`, `filter`, `ux`
- **Complexity:** 3/10

## Complexity Audit
**Routine.** This is a DOM relocation: move three `<select>` elements from inside a modal to the controls strip, and ensure the existing JS show/hide logic still targets them by ID (it already uses `getElementById`, so element references resolve regardless of DOM location). No data flow, state, or backend changes are needed.

## Edge-Case & Dependency Audit
- **Element ID resolution:** `getTicketsTabElements()` (planning.js:1051) resolves all three filters via `document.getElementById(...)`. Moving them to a different container does not break lookup — IDs are global.
- **Show/hide logic:** `renderTicketsLinearPanel()` (line 7563) and `renderTicketsClickUpPanel()` (line 8035) toggle `style.display` on these elements. This logic is location-independent and will continue to work.
- **onchange handlers:** `renderTicketsClickUpStatusFilterOptions()` (line 8261) attaches `onchange` to `clickUpStatusFilter` only when the option HTML changes (guarded by `_lastTicketsClickUpStateFilterHtml`). The Linear state filter's `onchange` is attached at line 7053. Both are independent of DOM container.
- **Modal close behavior:** The Source modal closes on backdrop click and Close button. Removing the filters from the modal body does not affect modal open/close logic.
- **Collapsed sidebar:** CSS rule at planning.html:359 hides `#tree-pane-tickets .sidebar-toggle-row .strip-btn` when the content row is collapsed. The filters will live in `#controls-strip-tickets` (the top strip), which is not affected by this collapse rule.
- **Project picker:** The user specifically called out the status filter, but the project picker (`tickets-project-picker`) is also a runtime filter trapped in the modal. Moving all three together keeps the filter row cohesive and avoids a half-fix.

## Proposed Changes

### 1. `src/webview/planning.html` — Move filter selects to the controls strip

**Remove** the filter row from inside the Source modal (lines 3797–3802):

```html
<!-- REMOVE from inside #tickets-source-modal .modal-body -->
<div style="display: flex; gap: 8px; flex-wrap: wrap;">
    <select id="tickets-project-picker" class="planning-select" style="display:none"></select>
    <select id="tickets-state-filter" class="planning-select" style="display:none"></select>
    <select id="tickets-status-filter" class="planning-select" style="display:none"></select>
</div>
```

**Add** the filter selects to the controls strip row (after the search input, before the "+ New Ticket" button, around line 3523):

```html
<div class="controls-strip-row">
    <div class="tickets-workspace-picker">
        <select id="tickets-workspace-filter" class="workspace-filter-select" style="display:none;"></select>
        <span id="tickets-workspace-label" class="workspace-static-label" style="display:none;"></span>
    </div>
    <button id="tickets-source-btn" class="strip-btn" title="Choose provider and navigate the source hierarchy">Source</button>
    <span id="tickets-source-summary" class="workspace-static-label"></span>
    <input id="tickets-search" type="text" class="sidebar-search-input" placeholder="Search tickets..." />
    <!-- NEW: inline filters moved out of Source modal -->
    <select id="tickets-project-picker" class="planning-select" style="display:none"></select>
    <select id="tickets-state-filter" class="planning-select" style="display:none"></select>
    <select id="tickets-status-filter" class="planning-select" style="display:none"></select>
    <button id="tickets-create" class="strip-btn" disabled title="Configure an integration in Setup first">+ New Ticket</button>
    <button id="tickets-refresh" class="strip-btn" title="Re-fetch from source and save local copies">Refetch</button>
    <button id="tickets-sync-all" class="strip-btn" title="Push all local ticket changes back to the integration">Sync changes</button>
    <button id="tickets-agent-api" class="strip-btn" title="What agents can do with this ticket source without the MCP">Agent API</button>
</div>
```

### 2. `src/webview/planning.html` — Ensure filter selects fit in the controls strip

The controls strip uses `flex-wrap: wrap` (via `.controls-strip-row`). The `planning-select` class already has compact styling. No additional CSS is strictly required, but if the selects appear too tall in the strip, add a height override:

```css
#controls-strip-tickets .planning-select {
    height: 26px;
    font-size: 11px;
}
```

Add this near the existing `#controls-strip-tickets select` rule (around line 2654).

### 3. No JS changes required

All element references in `planning.js` use `document.getElementById('tickets-status-filter')`, `getElementById('tickets-state-filter')`, and `getElementById('tickets-project-picker')` — these resolve globally regardless of where the elements live in the DOM. The show/hide toggling in `renderTicketsLinearPanel()` and `renderTicketsClickUpPanel()` will continue to work as-is.

## Verification Plan
1. Open the Switchboard planning panel and switch to the Tickets tab.
2. Configure a ClickUp or Linear source via the Source button.
3. **Confirm:** The status/state filter `<select>` is visible inline in the top controls strip (not inside the Source modal).
4. **Confirm:** Changing the status filter immediately re-filters the sidebar ticket list without opening any modal.
5. **Confirm:** The Source modal still opens and shows the provider selector + hierarchy nav (filters removed from modal body).
6. **Confirm:** Switching between Linear and ClickUp correctly shows/hides the appropriate filter (`state-filter` for Linear, `status-filter` for ClickUp).
7. **Confirm:** Collapsing the sidebar (toggle button) does not hide the filters (they're in the top strip, not the tree pane).
8. Reload the webview and confirm filter state persists (existing `saveTicketsState`/`restoreTicketsState` logic is unaffected).
