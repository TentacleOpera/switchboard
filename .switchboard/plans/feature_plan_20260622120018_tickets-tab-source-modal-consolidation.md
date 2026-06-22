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
**Tags:** frontend, ui, ux, feature

## User Review Required

No. This is a layout/DOM-restructuring change with no behavioral, data, or backend impact. All element ids and event listeners are preserved (verified: `getTicketsTabElements()` resolves by `document.getElementById` at [planning.js:470-509](src/webview/planning.js#L470); listeners are bound by id in `initTicketsTab()` at [planning.js:5795-6117](src/webview/planning.js#L5795)). No confirmation dialogs are involved (per project rules, none are ever added). The change relocates existing elements into a modal and adds a summary label — no new product behavior. The user should visually confirm the one-line layout and modal UX, but no architectural review is needed.

## Complexity Audit

### Routine
- Adding a **Source** button to row 1 and a modal shell (reuse the `.folder-modal` pattern already used by `#convert-subtask-modal` at [planning.html:3538](src/webview/planning.html#L3538)).
- Moving `#tickets-search` into row 1.
- Adding open/close handlers for the Source modal (copy the pattern from `#convert-subtask-modal` handlers at [planning.js:6405-6417](src/webview/planning.js#L6405)).
- Adding a `#tickets-source-summary` span to row 1 (uses existing `workspace-static-label` class, same as `#tickets-workspace-label` at [planning.html:3338](src/webview/planning.html#L3338)).

### Complex / Risky
- The provider selector, project/state/status filters, and `#tickets-hierarchy-nav` have existing JS wiring (population, `change` handlers, visibility toggling). Moving them into a modal must preserve all element ids, `style`, `class`, and `title` attributes so behavior is unchanged — only their DOM location changes.
- `#tickets-hierarchy-nav` is dynamically populated via `hierarchyNav.innerHTML = html` in `renderTicketsClickUpHierarchyNav()` ([planning.js:7120-7129](src/webview/planning.js#L7120)); ensure it still renders correctly inside the modal container. Verified: `getElementById('tickets-hierarchy-nav')` searches the whole document, so DOM location is irrelevant.
- **CSS styling gap (Clarification):** The three static selects (`#tickets-project-picker`, `#tickets-state-filter`, `#tickets-status-filter`) are currently styled by `#controls-strip-tickets select` at [design.html:2673-2680](src/webview/design.html#L2673). Moving them into the modal breaks this selector. They must receive a class (e.g. `planning-select` or a new `tickets-source-select`) or a new `#tickets-source-modal select` CSS rule must be added so they retain consistent padding, font-size, and border styling inside the modal.
- **Source summary update logic (Clarification):** A new `updateTicketsSourceSummary()` function must be called from both `renderTicketsClickUpPanel()` ([planning.js:7052](src/webview/planning.js#L7052)) and `renderTicketsLinearPanel()` ([planning.js:6586](src/webview/planning.js#L6586)) so the summary reflects the current source on every state change (provider switch, space/folder/list selection).

## Edge-Case & Dependency Audit

- **Race Conditions:** None new — same elements, relocated. Population code targets ids, which are preserved. The render functions (`renderTicketsClickUpPanel`, `renderTicketsLinearPanel`) toggle child `display` but never touch the Source modal's own `display`, so the modal stays open and updates live during an async provider switch.
- **Security:** None.
- **Side Effects:** A "Source" summary on the button (e.g. "Source: ClickUp ▸ Team ▸ Project") improves clarity; optional but recommended. Collapsing controls into a modal means the current source is less glanceable — mitigate with that summary label.
- **Dependencies & Conflicts:** Coordinate with the slim-labels plan (`feature_plan_20260622120017`) and the delete-confirmation-modal plan (`feature_plan_20260622120019`) — same tab, same file. Verified: the slim-labels plan edits `planning.html:3384`/`3386` (preview meta bar buttons) — no line overlap with this plan's edits at `planning.html:3334-3355` (controls strip). The delete-confirmation-modal plan adds a separate `#tickets-delete-modal` and modifies the delete handler at `planning.js:5963` — no overlap. All three plans can be merged independently; do a pre-merge diff to confirm no shifted-line collisions. Decide whether project/state/status filters move into the Source modal too (recommended, since they are scoping/source controls) or stay inline; moving them best achieves the one-line goal.
- **Layout overflow:** `.controls-strip` has no `flex-wrap` ([design.html:206-214](src/webview/design.html#L206)). Cramming workspace picker + Source button + summary + search (`min-width: 200px`) + 3 buttons into one row may overflow on narrow webview panels. Mitigation: add `flex-wrap: wrap` to `#controls-strip-tickets` so elements wrap gracefully at narrow widths while occupying one line at default width.

## Dependencies

None — no session IDs available for sibling plans. Coordinate by pre-merge diff against:
- `feature_plan_20260622120017` — slim button labels (same file, non-overlapping lines)
- `feature_plan_20260622120019` — delete confirmation modal (same file, non-overlapping sections)

## Adversarial Synthesis

Key risks: (1) relocated static selects lose `#controls-strip-tickets select` CSS styling inside the modal — mitigated by adding a shared class or modal-scoped CSS rule; (2) one-line strip may overflow on narrow panels since `.controls-strip` lacks `flex-wrap` — mitigated by adding `flex-wrap: wrap`; (3) source summary is underspecified — mitigated by an explicit `updateTicketsSourceSummary()` function hooked into both render functions. All fixes are additive CSS/JS details that don't change the id-based-relocation approach. Complexity remains 5.

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
    <button id="tickets-create" class="strip-btn" disabled title="Configure an integration in Setup first">+ New Ticket</button>
    <button id="tickets-refresh" class="strip-btn" title="Re-fetch from source and save local copies">Refetch</button>
    <button id="tickets-sync-all" class="strip-btn" title="Push all local ticket changes back to the integration">Sync changes</button>
  </div>
</div>
```
Note: `#tickets-workspace-filter` and `#tickets-workspace-label` are preserved (multi-root workspace support) with their existing `display:none` default.

### 2. `src/webview/planning.html` — add the Source modal
Add a `.folder-modal` (modelled on `#convert-subtask-modal` at [planning.html:3538](src/webview/planning.html#L3538)) `#tickets-source-modal` whose body **contains the relocated elements**, keeping their exact ids **and all existing attributes** (`style`, `class`, `title`):

```html
<div class="folder-modal" id="tickets-source-modal" style="display: none;" role="dialog" aria-modal="true" aria-labelledby="tickets-source-modal-title">
  <div class="modal-content">
    <div class="modal-header">
      <h3 id="tickets-source-modal-title">Source</h3>
      <button class="modal-close-btn" id="btn-close-tickets-source-modal" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body" style="display: flex; flex-direction: column; gap: 12px; margin-top: 10px;">
      <!-- Provider selector — preserve class="workspace-filter-select" and style -->
      <div>
        <label style="font-size: 11px; text-transform: uppercase; color: var(--text-secondary); display: block; margin-bottom: 4px;">Provider</label>
        <select id="tickets-provider-selector" class="workspace-filter-select" style="display:none; margin-left: 0;">
          <option value="clickup">ClickUp</option>
          <option value="linear">Linear</option>
        </select>
      </div>
      <!-- Hierarchy nav — preserve style="display:none; flex-wrap: wrap; gap: 8px; align-items: center;" -->
      <div>
        <label style="font-size: 11px; text-transform: uppercase; color: var(--text-secondary); display: block; margin-bottom: 4px;">Hierarchy</label>
        <div id="tickets-hierarchy-nav" style="display:none; flex-wrap: wrap; gap: 8px; align-items: center;"></div>
      </div>
      <!-- Filters — preserve style="display:none"; add class="planning-select" for modal styling -->
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <select id="tickets-project-picker" class="planning-select" style="display:none"></select>
        <select id="tickets-state-filter" class="planning-select" style="display:none"></select>
        <select id="tickets-status-filter" class="planning-select" style="display:none"></select>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px;">
        <button id="btn-close-tickets-source-modal-action" class="strip-btn">Close</button>
      </div>
    </div>
  </div>
</div>
```

**Critical:** The Source modal is **static HTML in `planning.html`**, present at page load — NOT dynamically injected. This ensures `initTicketsTab()` resolves all ids via `getElementById` at init time ([planning.js:5795](src/webview/planning.js#L5795)) and binds listeners before any user interaction.

**Attribute preservation checklist:**
- `#tickets-provider-selector`: keep `class="workspace-filter-select"` and `style="display:none"` (the `margin-left: 8px` can be dropped since it's no longer adjacent to the workspace filter).
- `#tickets-hierarchy-nav`: keep `style="display:none; flex-wrap: wrap; gap: 8px; align-items: center;"` — the render function toggles `display` ([planning.js:7065](src/webview/planning.js#L7065)); the rest of the inline style controls layout.
- `#tickets-project-picker`, `#tickets-state-filter`, `#tickets-status-filter`: keep `style="display:none"`; **add `class="planning-select"`** so they retain styled appearance inside the modal (compensates for losing `#controls-strip-tickets select` CSS scope).

### 3. `src/webview/design.html` — add `flex-wrap` to tickets controls strip
At the `#controls-strip-tickets` CSS block ([design.html:2657](src/webview/design.html#L2657)), add `flex-wrap` to the base `.controls-strip` rule or add a scoped override:
```css
#controls-strip-tickets {
    flex-wrap: wrap;
}
```
This prevents overflow/clipping on narrow webview panels while keeping one line at default width.

### 4. `src/webview/planning.js` — wire the modal open/close + summary
- `#tickets-source-btn` → show `#tickets-source-modal` (set `style.display = 'block'`); add close button (`#btn-close-tickets-source-modal`, `#btn-close-tickets-source-modal-action`) and overlay-click handlers — copy the pattern from `#convert-subtask-modal` handlers at [planning.js:6405-6417](src/webview/planning.js#L6405).
- Keep all existing population and `change` handlers (they bind by id, unchanged). Verified: `initTicketsTab()` binds `tickets-provider-selector` change at [planning.js:5804](src/webview/planning.js#L5804), `projectPicker` change at [planning.js:6099](src/webview/planning.js#L6099), `stateFilter` change at [planning.js:6106](src/webview/planning.js#L6106), `clickUpStatusFilter` change at [planning.js:6113](src/webview/planning.js#L6113). All use `getElementById` or cached refs from `getTicketsTabElements()` — DOM relocation does not break these.
- Add `updateTicketsSourceSummary()` function and call it from:
  - `renderTicketsClickUpPanel()` ([planning.js:7052](src/webview/planning.js#L7052)) — after hierarchy render.
  - `renderTicketsLinearPanel()` ([planning.js:6586](src/webview/planning.js#L6586)) — after filter render.
  - The `tickets-provider-selector` change handler ([planning.js:5804](src/webview/planning.js#L5804)) — immediately on switch (before backend response).
- **Summary format (Clarification):**
  - ClickUp: `"ClickUp"` + ` ▸ {spaceName}` + ` ▸ {folderName}` (if folder selected) + ` ▸ {listName}` (if list selected). Omit empty levels. Use `clickUpAvailableSpaces`/`clickUpAvailableFolders`/`clickUpAvailableListsInFolder`/`clickUpAvailableDirectLists` to resolve names from `clickUpSelectedSpaceId`/`clickUpSelectedFolderId`/`clickUpSelectedListId`.
  - Linear: `"Linear"` (no hierarchy nav; project picker is a filter, not source navigation).
  - No provider configured: empty string.
- Verify the element-reference cache (`getTicketsTabElements()` at [planning.js:470-509](src/webview/planning.js#L470)) still resolves the moved ids — confirmed: it uses `document.getElementById` which is DOM-location-agnostic.

## Verification Plan

### Automated Tests
Skipped per session directive. The test suite will be run separately by the user. No unit/integration/e2e tests are added or modified — this is a DOM-restructuring and CSS change with no new behavioral surface (all ids, listeners, and message types are preserved).

### Manual Verification
1. Build; open Planning → Tickets → confirm the top controls occupy a single line (workspace, Source button + summary, search, Create/Refetch/Sync).
2. Narrow the webview panel → confirm controls wrap gracefully (no clipping or horizontal scrollbar) due to `flex-wrap`.
3. Click **Source** → confirm the modal shows the provider dropdown, project/state/status filters, and the hierarchy navigation. Confirm the selects are styled consistently (not unstyled native dropdowns).
4. Switch provider (ClickUp ↔ Linear) inside the modal → confirm tickets reload, the source summary updates, and the modal remains open (does not close during the async reload).
5. Navigate the hierarchy in the modal (ClickUp: Space → Folder → List) → confirm the breadcrumb/dropdowns behave exactly as before, the list updates, and the source summary updates to reflect the selected path.
6. For Linear: confirm the project picker and state filter appear in the modal and function correctly; confirm the hierarchy nav section is hidden.
7. Type in the (now first-line) search → confirm filtering still works.
8. Confirm Create/Refetch/Sync still function and disabled states are preserved (`#tickets-create` disabled until a list is selected for ClickUp).
9. Close the modal via ×, Close button, and overlay click → confirm each closes the modal without side effects.
10. Pre-merge: diff against the slim-labels plan (`feature_plan_20260622120017`) and delete-confirmation-modal plan (`feature_plan_20260622120019`) to confirm no overlapping line edits in `planning.html` or `planning.js`.

## Recommendation

Complexity 5 → **Send to Coder**.
