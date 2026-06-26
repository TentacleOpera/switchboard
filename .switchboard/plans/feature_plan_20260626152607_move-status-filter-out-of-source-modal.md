# Move Status/State Filter Out of the Tickets Source Modal

## Goal

Move the status filter (`tickets-status-filter` for ClickUp), state filter (`tickets-state-filter` for Linear), and project picker (`tickets-project-picker` for Linear) out of the "Source" modal (`#tickets-source-modal`) and into the inline controls strip (`#controls-strip-tickets`) on the Tickets tab of `planning.html`, so users can change runtime list-filtering without opening a modal every time.

### Problem
The status filter (`tickets-status-filter` for ClickUp) and the state filter (`tickets-state-filter` for Linear) on the Tickets tab of `planning.html` are currently buried **inside** the "Source" modal (`#tickets-source-modal`). The user has to open the Source modal every time they want to change the status/state filter, which is a high-frequency action that should be inline with the ticket list.

### Background
The Source modal (`#tickets-source-modal`, lines 3847–3878 of `planning.html`) contains three filter `<select>` elements in a single flex row (lines 3868–3872):
- `tickets-project-picker` — Linear project filter
- `tickets-state-filter` — Linear state filter
- `tickets-status-filter` — ClickUp status filter

These are shown/hidden by `renderTicketsLinearPanel()` (planning.js:7835) and `renderTicketsClickUpPanel()` (planning.js:8304) based on the active provider. The modal is only opened by clicking the "Source" button (`#tickets-source-btn`). The filters are the only elements in the modal that change **after** a source is already selected — the provider selector and hierarchy nav are setup-time controls that legitimately belong in the modal.

### Root Cause
The filters were placed inside the Source modal during an earlier refactor that consolidated all source-configuration UI into one modal. The status/state filter is a **runtime list-filtering** control, not a **source-configuration** control, so it was misplaced.

## Metadata
- **Tags:** `ui`, `ux`, `feature`, `refactor`
- **Complexity:** 3/10

## User Review Required
No user review required. This is a self-contained DOM relocation with no data flow, state, or backend changes. The user explicitly requested this UX improvement.

## Complexity Audit

### Routine
- DOM relocation: move three `<select>` elements from inside `#tickets-source-modal` to the `#controls-strip-tickets` controls strip row.
- All element references in `planning.js` use `document.getElementById(...)` via `getTicketsTabElements()` (planning.js:1051), which resolves globally regardless of DOM container.
- Show/hide logic in `renderTicketsLinearPanel()` (planning.js:7835) and `renderTicketsClickUpPanel()` (planning.js:8304) toggles `style.display` on these elements — location-independent.
- Event listeners are attached via `addEventListener('change', ...)` inside `initTicketsTab()` (planning.js:7333, 7340, 7347) — attached once during init, independent of DOM container.
- `saveTicketsState()` / `restoreTicketsStateForRoot()` (planning.js:9066, 9083) persist JS variable values, not DOM location — unaffected by the move.
- No backend, data flow, or state changes needed.

### Complex / Risky
- CSS `flex: 1` on `.planning-select` (planning.html:590) will cause the three filter selects to expand and fill available space in the controls strip row, potentially pushing other buttons onto a wrapped second row. Must be overridden with `flex: none` and a `max-width`. See Proposed Changes §2.

## Edge-Case & Dependency Audit
- **Element ID resolution:** `getTicketsTabElements()` (planning.js:1051) resolves all three filters via `document.getElementById(...)`. Moving them to a different container does not break lookup — IDs are global.
- **Show/hide logic:** `renderTicketsLinearPanel()` (planning.js:7835) and `renderTicketsClickUpPanel()` (planning.js:8304) toggle `style.display` on these elements. This logic is location-independent and will continue to work.
- **Event listener attachment:** All three filters get `addEventListener('change', ...)` inside `initTicketsTab()` (planning.js:7333 for project picker, 7340 for state filter, 7347 for status filter). These are attached once during initialization and are independent of DOM container. No re-attachment needed after the move.
  - **Pre-existing double-handler note:** The ClickUp status filter has BOTH `addEventListener('change')` at planning.js:7347 AND `.onchange =` assignment at planning.js:8566 (inside `renderTicketsClickUpStatusFilterOptions()`). Both do the same thing (set filter value, re-render, save state) so the double-fire is idempotent. This is pre-existing and not introduced by this plan.
- **Modal close behavior:** The Source modal closes on backdrop click and Close button. Removing the filters from the modal body does not affect modal open/close logic.
- **Collapsed sidebar:** CSS rule at planning.html:360 hides `#tree-pane-tickets .sidebar-toggle-row .strip-btn` when the content row is collapsed. The filters will live in `#controls-strip-tickets` (the top strip), which is not affected by this collapse rule.
- **Project picker:** The user specifically called out the status filter, but the project picker (`tickets-project-picker`) is also a runtime filter trapped in the modal. Moving all three together keeps the filter row cohesive and avoids a half-fix.
- **CSS flex growth:** `.planning-select` has `flex: 1` (planning.html:590). Without an override, the three selects will expand to fill the controls strip row alongside the search input (which also has `flex: 1` via `#controls-strip-tickets input` at planning.html:2641). Must add `flex: none` and `max-width` to prevent layout breakage. See Proposed Changes §2.
- **Visual context:** Inside the modal, the filters had implicit context from the "Source" dialog. In the controls strip, they should have `title` attributes for accessibility and user clarity.

## Dependencies
- None — this is a self-contained UI change with no cross-plan dependencies.

## Adversarial Synthesis
Key risks: (1) all line numbers in the original plan were wrong (off by ~70–280 lines), which would have led an implementer to edit the wrong modal; (2) `.planning-select`'s `flex: 1` would cause the inline selects to expand and break the controls strip layout. Mitigations: line numbers corrected to actual locations; CSS override adds `flex: none` and `max-width` to constrain select width. The core approach (DOM relocation, no JS changes) is sound — all element references use `getElementById` and event listeners are attached once during init.

## Proposed Changes

### 1. `src/webview/planning.html` — Move filter selects to the controls strip

**Remove** the filter row from inside the Source modal (lines 3867–3872):

```html
<!-- REMOVE from inside #tickets-source-modal .modal-body -->
<!-- Filters — preserve style="display:none"; add class="planning-select" for modal styling -->
<div style="display: flex; gap: 8px; flex-wrap: wrap;">
    <select id="tickets-project-picker" class="planning-select" style="display:none"></select>
    <select id="tickets-state-filter" class="planning-select" style="display:none"></select>
    <select id="tickets-status-filter" class="planning-select" style="display:none"></select>
</div>
```

**Add** the filter selects to the controls strip row (after the search input at line 3573, before the "+ New Ticket" button at line 3574). Add `title` attributes for accessibility:

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
    <select id="tickets-project-picker" class="planning-select" style="display:none" title="Filter by Linear project"></select>
    <select id="tickets-state-filter" class="planning-select" style="display:none" title="Filter by Linear state"></select>
    <select id="tickets-status-filter" class="planning-select" style="display:none" title="Filter by ClickUp status"></select>
    <button id="tickets-create" class="strip-btn" disabled title="Configure an integration in Setup first">+ New Ticket</button>
    <button id="tickets-refresh" class="strip-btn" title="Re-fetch from source and save local copies">Refetch</button>
    <button id="tickets-sync-all" class="strip-btn" title="Push all local ticket changes back to the integration">Sync changes</button>
    <button id="tickets-agent-api" class="strip-btn" title="What agents can do with this ticket source without the MCP">Agent API</button>
</div>
```

### 2. `src/webview/planning.html` — Constrain filter select width in the controls strip

The controls strip uses `flex-wrap: wrap` (via `.controls-strip-row` at planning.html:2671). The `planning-select` class has `flex: 1` (planning.html:590), which would cause the three filter selects to expand and fill the row, pushing other buttons onto a wrapped line. Add a CSS override near the existing `#controls-strip-tickets select` rule (after planning.html:2664):

```css
/* Inline filter selects — override .planning-select flex:1 to prevent layout expansion */
#controls-strip-tickets .planning-select {
    flex: none;
    max-width: 140px;
    height: 26px;
    font-size: 11px;
}
```

The `flex: none` prevents the selects from growing to fill available space. The `max-width: 140px` keeps them compact. The `height` and `font-size` match the existing `#controls-strip-tickets select` styling (planning.html:2657–2664).

### 3. No JS changes required

All element references in `planning.js` use `document.getElementById('tickets-status-filter')`, `getElementById('tickets-state-filter')`, and `getElementById('tickets-project-picker')` via `getTicketsTabElements()` (planning.js:1051–1059) — these resolve globally regardless of where the elements live in the DOM. The show/hide toggling in `renderTicketsLinearPanel()` (planning.js:7835) and `renderTicketsClickUpPanel()` (planning.js:8304) will continue to work as-is. Event listeners are attached via `addEventListener('change', ...)` inside `initTicketsTab()` (planning.js:7333, 7340, 7347) during initialization — no re-attachment needed after the DOM move.

## Verification Plan

### Automated Tests
No automated tests required — this is a pure DOM relocation with no logic changes. The test suite will be run separately by the user.

### Manual Verification
1. Open the Switchboard planning panel and switch to the Tickets tab.
2. Configure a ClickUp or Linear source via the Source button.
3. **Confirm:** The status/state filter `<select>` is visible inline in the top controls strip (not inside the Source modal).
4. **Confirm:** Changing the status filter immediately re-filters the sidebar ticket list without opening any modal.
5. **Confirm:** The Source modal still opens and shows the provider selector + hierarchy nav (filters removed from modal body).
6. **Confirm:** Switching between Linear and ClickUp correctly shows/hides the appropriate filter (`state-filter` for Linear, `status-filter` for ClickUp).
7. **Confirm:** Collapsing the sidebar (toggle button) does not hide the filters (they're in the top strip, not the tree pane).
8. **Confirm:** The filter selects do NOT expand to fill the entire controls strip row — they stay compact (max 140px) and the other buttons (New Ticket, Refetch, Sync, Agent API) remain on the same row or wrap cleanly.
9. Reload the webview and confirm filter state persists (existing `saveTicketsState`/`restoreTicketsStateForRoot` logic is unaffected).

---

**Recommendation:** Complexity is 3/10 → **Send to Intern**. This is a localized single-file DOM relocation with a CSS override. No JS changes, no data flow changes, no backend involvement. The only technical risk (CSS flex expansion) is addressed by the `flex: none` override.
