# Consolidate Tickets Tab Provider + Hierarchy Pickers Into a "Source" Modal; One-Line Top Controls

## Goal

In the Tickets tab of `planning.html`, move the provider dropdown and the provider navigation-hierarchy dropdowns into a single modal opened by a **Source** button, and move the ticket search bar up to the first line — so the top controls occupy only one line.

### Problem Analysis

The tickets controls strip currently uses **two** rows ([planning.html:3334-3355](src/webview/planning.html#L3334)):

Row 1 (`controls-strip-row`):
- `#tickets-workspace-filter` / `#tickets-workspace-label`
- `#tickets-provider-selector` (ClickUp / Linear) ([3339](src/webview/planning.html#L3339))
- `#tickets-project-picker`, `#tickets-state-filter`, `#tickets-status-filter` ([3344-3346](src/webview/planning.html#L3344))
- `#tickets-create`, `#tickets-refresh`, `#tickets-sync-all`

Row 2 (`controls-strip-row`):
- `#tickets-hierarchy-nav` (the provider navigation hierarchy breadcrumb/dropdowns) ([3352](src/webview/planning.html#L3352))
- `#tickets-search` ([3353](src/webview/planning.html#L3353))

The provider selector + the hierarchy nav + the project/state/status filters create a crowded two-line strip. The user wants the **provider dropdown and the hierarchy navigation dropdowns** tucked behind a single **Source** button (opening a modal that contains them), and the **search bar promoted to the first line**, leaving a single-line top control strip.

### Root Cause

Source-selection controls (provider + hierarchy + project/state/status scoping) are laid out inline across two rows instead of being grouped behind one entry point, forcing a second line.

## Metadata

**Complexity:** 5
**Tags:** frontend, tickets, ux, layout, modal

## Complexity Audit

### Routine
- Adding a **Source** button to row 1 and a modal shell (reuse the `.folder-modal` pattern already used by `#convert-subtask-modal` at [planning.html:3538](src/webview/planning.html#L3538)).
- Moving `#tickets-search` into row 1.

### Complex / Risky
- The provider selector, project/state/status filters, and `#tickets-hierarchy-nav` have existing JS wiring (population, `change` handlers, visibility toggling). Moving them into a modal must preserve all element ids and listeners so behavior is unchanged — only their DOM location changes.
- `#tickets-hierarchy-nav` is dynamically populated; ensure it still renders correctly inside the modal container.

## Edge-Case & Dependency Audit

- **Race Conditions:** None new — same elements, relocated. Population code targets ids, which are preserved.
- **Security:** None.
- **Side Effects:** A "Source" summary on the button (e.g. "Source: ClickUp ▸ Team ▸ Project") improves clarity; optional but recommended. Collapsing controls into a modal means the current source is less glanceable — mitigate with that summary label.
- **Dependencies & Conflicts:** Coordinate with the slim-labels plan and the delete-confirmation-modal plan (same tab). Decide whether project/state/status filters move into the Source modal too (recommended, since they are scoping/source controls) or stay inline; moving them best achieves the one-line goal.

## Proposed Changes

### 1. `src/webview/planning.html` — restructure the controls strip
Collapse `#controls-strip-tickets` to a single `controls-strip-row`:
```html
<div class="controls-strip" id="controls-strip-tickets">
  <div class="controls-strip-row">
    <div class="tickets-workspace-picker">
      <select id="tickets-workspace-filter" class="workspace-filter-select" style="display:none;"></select>
      <span id="tickets-workspace-label" class="workspace-static-label" style="display:none;"></span>
    </div>
    <button id="tickets-source-btn" class="strip-btn" title="Choose provider and navigate the source hierarchy">Source</button>
    <span id="tickets-source-summary" class="workspace-static-label"></span>
    <input id="tickets-search" type="text" class="sidebar-search-input" placeholder="Search tickets..." />
    <button id="tickets-create" class="strip-btn" disabled>+ New Ticket</button>
    <button id="tickets-refresh" class="strip-btn">Refetch</button>
    <button id="tickets-sync-all" class="strip-btn">Sync changes</button>
  </div>
</div>
```

### 2. `src/webview/planning.html` — add the Source modal
Add a `.folder-modal` (modelled on `#convert-subtask-modal`) `#tickets-source-modal` whose body **contains the relocated elements**, keeping their exact ids:
- `#tickets-provider-selector`
- `#tickets-project-picker`, `#tickets-state-filter`, `#tickets-status-filter`
- `#tickets-hierarchy-nav`
Plus a Close button.

### 3. `src/webview/planning.js` — wire the modal open/close + summary
- `#tickets-source-btn` → show `#tickets-source-modal`; add close/overlay-click handlers.
- Keep all existing population and `change` handlers (they bind by id, unchanged).
- Update `#tickets-source-summary` whenever provider/hierarchy/project changes so the current source is visible on the one-line strip.
- Verify the element-reference cache (e.g. `linkAllButton` etc. captured around [planning.js:488](src/webview/planning.js#L488)) still resolves the moved ids.

## Verification Plan

1. Build; open Planning → Tickets → confirm the top controls occupy a single line (workspace, Source button + summary, search, Create/Refetch/Sync).
2. Click **Source** → confirm the modal shows the provider dropdown, project/state/status filters, and the hierarchy navigation.
3. Switch provider (ClickUp ↔ Linear) inside the modal → confirm tickets reload and the source summary updates.
4. Navigate the hierarchy in the modal → confirm the breadcrumb/dropdowns behave exactly as before and the list updates.
5. Type in the (now first-line) search → confirm filtering still works.
6. Confirm Create/Refetch/Sync still function and disabled states are preserved.
