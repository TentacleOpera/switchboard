# Unify Tickets Tab Layout with Local/Online Docs Tabs

## Goal

Restructure the **Tickets** tab in `planning.html` so it reuses the same 1:3 flex sidebar + preview layout and styling patterns established by the **Local Docs** and **Online Docs** tabs. Eliminate the custom `.tickets-panel` column layout and the view-toggle behavior between list and detail. Subtasks should be appended as a structured list at the end of the primary ticket description in the preview pane.

## Problem Analysis

The Tickets tab currently diverges from every other document-oriented tab in the Research panel:

- **Local / Online / Design / HTML Preview tabs**: Use a persistent `.content-row` with a 1:3 flex split. The left pane (`flex: 1`) contains a scrollable tree/sidebar with collapse support. The right pane (`flex: 3`) contains a preview surface wrapped in `.preview-panel-wrapper` and `.preview-content-wrapper`. A controls strip sits above the content row. Selecting an item in the sidebar loads its content into the right pane without destroying the sidebar.
- **Tickets tab**: Uses a bespoke `.tickets-panel` with `flex-direction: column`. It toggles between `.tickets-list-view` (a vertical feed of `.tickets-issue-card` elements) and `.tickets-task-view` (a full-screen detail view with back buttons). This breaks spatial stability: the user loses context of the list when drilling into a ticket, and the styling (gradients, card borders, custom hover effects) is inconsistent with the sidebar tree nodes used elsewhere.

This inconsistency creates cognitive overhead for users and maintenance overhead for developers: any layout fix (e.g., dark-theme improvements, collapse behavior, responsive tweaks) must be applied in two places.

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, ux, refactor

## User Review Required

- **Action button placement decision**: The plan recommends placing Import/Refine/Ask Agent buttons in a contextual banner inside the preview pane header (mirroring the `Active Design Doc` banner pattern), not in the global controls strip. If you prefer them in the controls strip instead, the implementation will need adjustment.
- **Sidebar item styling decision**: The plan recommends a `.ticket-node` class that shares CSS custom properties with `.tree-node` but uses a vertical card layout (title + meta + truncated description), rather than forcing tickets into the horizontal icon+label `.tree-node` structure. Confirm this approach.

## Complexity Audit

### Routine
- Replacing the `.tickets-panel` HTML with `.controls-strip` + `.content-row` structure (follows exact pattern from Local Docs tab at lines 2531-2568)
- Adding `#tickets-content` to the flex display rules block (one-line CSS addition at line ~207)
- Adding `#tree-pane-tickets` to the tree-pane CSS selector group (line 667-676)
- Adding `#tree-pane-tickets` to the collapse selector group (lines 308-311)
- Adding `#preview-pane-tickets` to the preview-pane CSS selector group (lines 898-907)
- Removing deprecated CSS rules (`.tickets-panel`, `.tickets-list-view`, `.tickets-task-view`, `.tickets-back-btn-group`, `.tickets-task-header`)
- Wiring `applySidebarState('tickets', ...)` in JS (follows existing pattern at lines 195-237)
- Persisting `ticketsPreviewCollapsed` state alongside existing collapsed states (lines 222-229)

### Complex / Risky
- Remapping `getTicketsTabElements()` DOM queries (line 120-146) — the function currently references `.tickets-list-view` parent and `.tickets-task-view` which will be removed; all queries must be retargeted to the new `#tree-pane-tickets` / `#preview-pane-tickets` structure
- Eliminating the `showTaskView` toggle logic in `renderTicketsLinearPanel()` (line 4777-4779) and `renderTicketsClickUpPanel()` (line 5072-5074) — must be replaced with "always show sidebar, populate preview pane" logic
- ClickUp hierarchy nav (Space → Folder → List drill-down) occupies more horizontal space than a typical controls strip; the controls strip may need `flex-wrap: wrap` or a two-row layout for ClickUp mode to avoid overflow
- Back-to-Parent navigation must work within the new layout without a full view toggle; the sidebar stays on the current list while the preview pane loads the parent task

## Edge-Case & Dependency Audit

- **Race Conditions**: When `loadLinearTaskDetails()` or `loadClickUpTaskDetails()` is called, it sets `selectedXxxIssue = null` then re-renders then posts a message. In the new layout, the preview pane should show a loading state during this gap rather than the "Select a ticket" empty state. Currently the code already handles this via the `showTaskView` toggle hiding the list, but with a persistent preview pane the intermediate state is visible.
- **Security**: No new security concerns. Ticket data is already sanitized via `escapeHtml()`/`escapeAttr()` in rendering functions.
- **Side Effects**: Removing `.tickets-list-view` and `.tickets-task-view` will break `getTicketsTabElements()` (line 120-146) which references `listView: document.getElementById('tickets-issues-container')?.parentElement` and `taskView: document.querySelector('.tickets-task-view')`. These must be updated in tandem with the HTML changes.
- **Dependencies & Conflicts**: The `applySidebarState()` function (line 195) and `toggleSidebarCollapsed()` function (line 206) must be updated to handle the `tickets` tab. The `#tickets-content` element currently lacks the `display: flex` rules that other tabs have (lines 207-224), which is required for `.content-row` to render correctly.

## Dependencies

- sess_tickets_tab_refactor — This is the primary plan; no cross-session dependencies.

## Adversarial Synthesis

Key risks: (1) `getTicketsTabElements()` DOM queries will break if IDs/structure change without coordinated JS updates; (2) ClickUp hierarchy nav may overflow the controls strip; (3) `#tickets-content` is missing flex display rules needed for the new layout. Mitigations: enumerate all ID changes in the implementation steps; add `flex-wrap: wrap` to the tickets controls strip; add `#tickets-content` to the display rules block.

## Proposed Changes

### `src/webview/planning.html` — CSS (lines 207-224, 308-311, 667-676, 898-907, 2315-2507)

**Context**: The Tickets tab has no `#tickets-content` display rules, no tree-pane or preview-pane CSS entries, and a large block of bespoke layout CSS that must be removed/replaced.

**Logic**:
1. Add `#tickets-content` to the display rules block at lines 207-224 (alongside `#local-content`, `#online-content`, etc.) so it gets `display: none; flex-direction: column; height: calc(100vh - 40px);` and the `.active` variant gets `display: flex`.
2. Add `#tree-pane-tickets` to the tree-pane selector group at line 667-676 so it inherits `position: relative; background: var(--panel-bg2); border-right: 1px solid var(--border-color); overflow-y: auto; padding: 12px; min-height: 100%;`.
3. Add `#tree-pane-tickets` to the collapse selector group at lines 308-311 so it collapses to 40px when `.content-row.collapsed`.
4. Add `#preview-pane-tickets` to the preview-pane selector group at lines 898-907 so it inherits `display: flex; flex-direction: column; background: var(--panel-bg); overflow-y: auto; padding: 0 16px 16px 16px; height: 100%;`.
5. Remove the following CSS rule blocks (lines 2315-2507):
   - `.tickets-panel` (lines 2315-2322)
   - `.tickets-toolbar` (lines 2324-2356)
   - `.tickets-list-view` (lines 2358-2364)
   - `.tickets-task-view` (lines 2366-2372)
   - `.tickets-back-btn-group` (lines 2374-2377)
   - `.tickets-task-header` (lines 2379-2398)
   - `.tickets-detail-actions` (lines 2400-2404)
   - `.tickets-detail-description, .tickets-detail-subtasks, .tickets-detail-comments, .tickets-detail-attachments` (lines 2406-2413)
   - `.tickets-detail-description pre` (lines 2415-2418)
6. Replace `.tickets-issue-card` (lines 2421-2438) with a new `.ticket-node` class that shares the same CSS custom properties as `.tree-node` (border-left accent, gradient background, hover glow) but uses a vertical card layout suitable for ticket items (title, meta, truncated description). Keep `.tickets-issue-title`, `.tickets-issue-meta`, `.tickets-issue-import-btn` as sub-selectors under `.ticket-node`.
7. Keep `.tickets-hierarchy-nav` (lines 2476-2507) but add `flex-wrap: wrap` to handle the wider ClickUp hierarchy nav within the controls strip.
8. Add `.ticket-node.selected` rule matching `.tree-node.selected` (lines 835-841) for selection state.
9. Add cyber-theme overrides for `.ticket-node.selected` and `.ticket-node:hover` matching the `.tree-node` overrides at lines 1862-1868.

**Edge Cases**:
- The `.tickets-toolbar input` and `.tickets-toolbar select` styles (lines 2331-2356) must be preserved — these will apply to elements now inside `.controls-strip`. Move them under a `.controls-strip` scoped selector or keep them as `.tickets-toolbar` class applied to a wrapper inside the controls strip.
- The `#tree-pane-design` is already in the tree-pane group but is NOT in the collapse selector group (lines 308-311 only list `#tree-pane`, `#tree-pane-online`, `#tree-pane-design`, `#tree-pane-html`). Verify that `#tree-pane-design` is actually present (it is at line 310) and add `#tree-pane-tickets` alongside it.

### `src/webview/planning.html` — HTML (lines 2813-2849)

**Context**: The current `#tickets-content` uses a flat `.tickets-panel` with `.tickets-list-view` and `.tickets-task-view` as siblings. This must be restructured to match the Local Docs pattern (lines 2523-2568).

**Logic**: Replace the inner markup of `#tickets-content` with:
```html
<div id="tickets-content" class="research-tab-content">
    <div class="controls-strip" id="controls-strip-tickets">
        <input id="tickets-search" type="text" placeholder="Search tickets..." />
        <select id="tickets-project-picker" style="display:none"></select>
        <select id="tickets-state-filter" style="display:none"></select>
        <select id="tickets-status-filter" style="display:none"></select>
        <button id="tickets-refresh" class="strip-btn">Refresh</button>
        <div id="tickets-hierarchy-nav" style="display:none"></div>
    </div>
    <div class="content-row">
        <div id="tree-pane-tickets">
            <div class="sidebar-toggle-row">
                <button class="sidebar-toggle-btn" title="Toggle sidebar">«</button>
            </div>
            <div id="tickets-empty-state" class="empty-state">No tickets loaded.</div>
            <div id="tickets-issues-container"></div>
            <button id="tickets-load-more" class="planning-button" style="display:none">Load More</button>
        </div>
        <div class="preview-panel-wrapper">
            <div id="preview-pane-tickets" style="flex: 1; width: 100%; box-sizing: border-box;">
                <div class="preview-content-wrapper">
                    <div class="tickets-detail-banner" id="tickets-detail-banner" style="display:none">
                        <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 12px; background:var(--accent-teal-dim); border-bottom:1px solid var(--accent-teal); flex-shrink:0;">
                            <div style="display:flex; flex-direction:column; gap:4px;">
                                <h3 id="tickets-detail-title" style="font-size:14px; font-weight:600; color:var(--text-primary); margin:0;"></h3>
                                <div style="display:flex; gap:8px; font-size:11px; color:var(--text-secondary); font-family:var(--font-mono);">
                                    <span id="tickets-detail-status"></span>
                                    <span id="tickets-detail-assignee"></span>
                                </div>
                            </div>
                            <div style="display:flex; gap:8px;">
                                <button id="tickets-detail-import" class="strip-btn" disabled>Import</button>
                                <button id="tickets-detail-refine" class="strip-btn" disabled>Refine</button>
                                <button id="tickets-detail-ask-agent" class="strip-btn" disabled>Ask Agent</button>
                                <button id="tickets-back-to-parent" class="strip-btn" style="display:none">Back to Parent</button>
                            </div>
                        </div>
                    </div>
                    <div id="tickets-detail-description"></div>
                    <div id="tickets-detail-subtasks"></div>
                    <div id="tickets-detail-comments"></div>
                    <div id="tickets-detail-attachments"></div>
                    <div id="tickets-empty-preview" class="empty-state">Select a ticket to preview</div>
                </div>
            </div>
            <div class="cyber-scanlines"></div>
        </div>
    </div>
</div>
```

**Key structural changes**:
- `.tickets-panel` → removed entirely; `#tickets-content` becomes a direct flex container
- `.tickets-toolbar` → `.controls-strip#controls-strip-tickets`
- `.tickets-list-view` → `#tree-pane-tickets` (sidebar pane)
- `.tickets-task-view` → removed; detail content lives inside `.preview-panel-wrapper` > `#preview-pane-tickets`
- `.tickets-back-btn-group` + `BACK TO LIST` → removed (sidebar is always visible)
- `BACK TO PARENT` → moved to the detail banner as a `strip-btn`
- `.tickets-task-header` → absorbed into the `.tickets-detail-banner` header
- `.tickets-detail-actions` → absorbed into the banner's button row
- New `#tickets-empty-preview` empty state shown when no ticket is selected
- New `#tickets-detail-banner` shown/hidden based on ticket selection

**Edge Cases**:
- The `#tickets-refresh` button class changes from `planning-button` to `strip-btn` to match the controls strip pattern.
- The `#tickets-load-more` button moves inside `#tree-pane-tickets` (sidebar pane).
- All existing element IDs (`tickets-search`, `tickets-project-picker`, `tickets-state-filter`, `tickets-status-filter`, `tickets-refresh`, `tickets-hierarchy-nav`, `tickets-empty-state`, `tickets-issues-container`, `tickets-load-more`, `tickets-detail-title`, `tickets-detail-status`, `tickets-detail-assignee`, `tickets-detail-description`, `tickets-detail-subtasks`, `tickets-detail-comments`, `tickets-detail-attachments`, `tickets-detail-import`, `tickets-detail-refine`, `tickets-detail-ask-agent`, `tickets-back-to-parent`) are preserved so JS references continue to work.

### `src/webview/planning.js` — `getTicketsTabElements()` (lines 120-146)

**Context**: This function returns DOM element references used throughout the tickets rendering code. Several references point to elements that are being removed or restructured.

**Logic**: Update the function:
- `listView`: Change from `document.getElementById('tickets-issues-container')?.parentElement` to `document.getElementById('tree-pane-tickets')` — the sidebar pane is now the container.
- `taskView`: Remove this reference (`.tickets-task-view` no longer exists). Replace all usages with the preview pane.
- Add `previewPane: document.getElementById('preview-pane-tickets')` — the right-side preview container.
- Add `detailBanner: document.getElementById('tickets-detail-banner')` — the banner shown when a ticket is selected.
- Add `emptyPreview: document.getElementById('tickets-empty-preview')` — the empty state for the preview pane.
- `backToListButton`: Remove this reference (`BACK TO LIST` button is removed).
- All other references (`searchInput`, `projectPicker`, `stateFilter`, etc.) remain the same since their IDs are preserved.

**Edge Cases**: The `listView` reference is used in `renderTicketsLinearPanel()` (line 4764, 4778) and `renderTicketsClickUpPanel()` (line 5032, 5073) for the `showTaskView` toggle. These usages must be replaced (see next section).

### `src/webview/planning.js` — Rendering functions (lines 4761-5075)

**Context**: Both `renderTicketsLinearPanel()` and `renderTicketsClickUpPanel()` use a `showTaskView` toggle that hides the list and shows the detail view. This must be replaced with "always show sidebar, populate preview pane" logic.

**Logic**:
1. In `renderTicketsLinearPanel()` (lines 4761-4783):
   - Remove lines 4777-4779 (`showTaskView` toggle of `listView.style.display` / `taskView.style.display`).
   - Replace with: show/hide `#tickets-detail-banner` and `#tickets-empty-preview` based on whether `selectedLinearIssue` is set. When a ticket is selected, show the banner and hide the empty preview. When no ticket is selected, hide the banner and show the empty preview.
   - The sidebar (`#tree-pane-tickets`) is always visible; no display toggling needed.

2. In `renderTicketsClickUpPanel()` (lines 5029-5075):
   - Remove lines 5072-5074 (`showTaskView` toggle).
   - Replace with the same banner/empty-preview toggle as above, based on `selectedClickUpIssue`.

3. In `renderTicketsLinearTaskDetail()` (lines 4916-5025):
   - The "no selection" case (line 4922-4941) should hide `#tickets-detail-banner` and show `#tickets-empty-preview` instead of setting `detailTitle.textContent = 'Select a task'`.
   - The "selected" case should show `#tickets-detail-banner` and hide `#tickets-empty-preview`.

4. In `renderTicketsClickUpTaskDetail()` (lines 5329-5423):
   - Same changes as #3 above.

5. In the event handler for `BACK TO LIST` (line 4695-4699):
   - Remove the `backToListButton` event listener entirely (the button no longer exists).
   - The behavior of deselecting a ticket (setting `selectedLinearIssue = null` / `selectedClickUpIssue = null`) can be achieved by clicking the same ticket in the sidebar again, or by clicking a different ticket.

6. In the event handler for `BACK TO PARENT` (lines 4701-4706):
   - Keep this handler. The `#tickets-back-to-parent` button now lives in the detail banner. The handler calls `loadLinearTaskDetails(parentId)` which updates the preview pane.

7. In the delegated click handler for `.tickets-task-view` (line 4709):
   - Change the delegation root from `document.querySelector('.tickets-task-view')` to `document.getElementById('preview-pane-tickets')` since the task view container no longer exists.

8. In `renderTicketsLinearList()` (lines 4851-4914) and `renderTicketsClickUpList()` (lines 5286-5327):
   - Change `.tickets-issue-card` class to `.ticket-node` in the generated HTML.
   - Add a `.selected` class to the ticket node that matches the currently selected issue/task.

**Edge Cases**:
- When `loadLinearTaskDetails()` or `loadClickUpTaskDetails()` is called, it sets `selectedXxxIssue = null` then re-renders. During the null-to-loading gap, the preview pane will briefly show the empty state. This is acceptable — the same behavior occurs in the current layout (the list view is shown briefly before the task view appears).

### `src/webview/planning.js` — Sidebar collapse (lines 195-237)

**Context**: The `toggleSidebarCollapsed()` and `applySidebarState()` functions don't handle the tickets tab.

**Logic**:
1. Add a `ticketsPreviewCollapsed` property to the `state` object (default `false`).
2. In `toggleSidebarCollapsed()` (lines 206-230), add a case for `activeTab === 'tickets'`:
   ```js
   } else if (activeTab === 'tickets') {
       state.ticketsPreviewCollapsed = !state.ticketsPreviewCollapsed;
       applySidebarState('tickets', state.ticketsPreviewCollapsed);
   }
   ```
3. Add `ticketsPreviewCollapsed` to the `vscode.setState()` call (lines 222-229).
4. Add initialization call: `applySidebarState('tickets', state.ticketsPreviewCollapsed);` alongside the existing calls at lines 233-237.
5. The sidebar toggle button inside `#tree-pane-tickets` will automatically be bound by the existing `document.querySelectorAll('.sidebar-toggle-btn')` listener at line 240.

**Edge Cases**: The sidebar toggle button is now inside `#tree-pane-tickets`, which is a child of `#tickets-content`. The `applySidebarState('tickets', ...)` function will correctly find `.content-row` and `.sidebar-toggle-btn` within `#tickets-content` because it queries by `${tabName}-content` ID.

## Requirements

### Functional

1. **Persistent 1:3 split**: The Tickets tab must render a `.content-row` with a left sidebar (`flex: 1`) and a right preview pane (`flex: 3`), identical to the Local Docs tab.
2. **Sidebar contents**: The left pane displays the list of tickets. It must support the existing sidebar collapse toggle (`«`) and collapse-related CSS classes (`.content-row.collapsed`).
3. **Preview pane contents**: The right pane displays the selected ticket's title, status, assignee, description, and subtasks. It should use the same `.preview-panel-wrapper` / `.preview-content-wrapper` structure as other tabs so that chrome, scrollbars, and padding are uniform.
4. **Subtasks**: Subtasks must appear as a structured list appended to the end of the primary ticket description inside the right pane, rather than in a separate isolated section.
5. **Controls strip**: The search input, project/state/status filters, refresh button, and hierarchy nav must move into a `.controls-strip` directly above the `.content-row`, matching the position and behavior of the Local Docs controls strip.
6. **Action buttons**: The **Import**, **Refine**, and **Ask Agent** buttons must move out of the detail body and into a contextual banner inside the preview pane (matching the `Active Design Doc` banner pattern). This keeps them contextual to the selected ticket without cluttering the global controls strip.

### Styling

1. **Remove bespoke ticket layout CSS**: Delete or deprecate `.tickets-panel`, `.tickets-list-view`, `.tickets-task-view`, `.tickets-back-btn-group`, and `.tickets-task-header` layout rules.
2. **Unify ticket list items**: Ticket items in the sidebar must use a new `.ticket-node` class that shares CSS custom properties with `.tree-node` (border-left accent, gradient background, hover glow, selection state) but uses a vertical card layout suitable for ticket items. This avoids conflating the horizontal icon+label file tree structure with the card-like ticket items.
3. **Unify preview styling**: The right pane must inherit the same background, padding, and typography as `#preview-pane` / `#preview-pane-online`. Remove `.tickets-detail-description`, `.tickets-detail-subtasks`, etc., as standalone style blocks if they only duplicate existing preview styles.

### Behavioral / JS

1. **Eliminate view toggle**: Remove the logic that hides `.tickets-list-view` and shows `.tickets-task-view`. Instead, clicking a ticket in the sidebar populates the right preview pane.
2. **Empty state**: When no ticket is selected, the right pane shows an `.empty-state` message ("Select a ticket to preview").
3. **Hierarchy navigation**: The "Back to Parent" behavior must be preserved as a button in the preview pane banner. The sidebar stays on the current list; the preview pane loads the parent task.
4. **Load More**: The "Load More" button remains at the bottom of the sidebar list.

## Edge Cases & Risks

- **Hierarchy depth**: If the ticket source supports parent/child relationships (e.g., Jira epics → stories → subtasks), the flat sidebar list may become hard to navigate. The current hierarchy nav (`#tickets-hierarchy-nav`) must be adapted to work within the controls strip. The ClickUp hierarchy nav (Space → Folder → List) takes more horizontal space than typical controls strip items; `flex-wrap: wrap` on the tickets controls strip mitigates overflow.
- **Narrow viewports**: The 1:3 split assumes adequate horizontal space. On very narrow panels, the collapse mechanism is the primary mitigation; ensure it is wired up for the Tickets tab.
- **State management**: The external JS (`planning.js`) references IDs like `tickets-detail-title`, `tickets-detail-description`, etc. The refactor preserves these IDs so the JS continues to work. The `getTicketsTabElements()` function must be updated to reference the new container elements.
- **Theme compatibility**: The Tickets tab has theme-specific overrides (e.g., `.tickets-issue-card` gradients). These must be mapped to `.ticket-node` using the same CSS custom property tokens so they continue to work across Kanban Dark, Claude Terracotta, and Slightly Darker Black themes.
- **Missing display rules**: `#tickets-content` currently lacks the `display: flex` rules that other tabs have at lines 207-224. This must be added for the `.content-row` layout to work.
- **Loading state gap**: When `loadLinearTaskDetails()` or `loadClickUpTaskDetails()` is called, the preview pane briefly shows the empty state before the task details arrive. This is acceptable and consistent with the current behavior.

## Open Questions

1. ~~**Action button placement**: Should **Import / Refine / Ask Agent** live in the controls strip (mirroring `Set as Active Planning Context`) or in a header banner inside the preview pane (mirroring the `Active Design Doc` banner)?~~ **Resolved**: Place in a contextual banner inside the preview pane header, matching the `Active Design Doc` banner pattern.
2. ~~**Sidebar item styling**: Should ticket items strictly reuse `.tree-node` markup/classes, or is a new `.ticket-node` class (that shares the same CSS custom properties) preferable to avoid conflating document trees with ticket lists?~~ **Resolved**: Use a new `.ticket-node` class that shares CSS custom properties with `.tree-node` but uses a vertical card layout.

## Implementation Sketch

1. **HTML** (`src/webview/planning.html`, lines 2813-2849):
   - Replace the `#tickets-content` inner markup:
     - Add a `.controls-strip` containing the search, filters, refresh, and hierarchy nav.
     - Add a `.content-row` containing:
       - Left: `<div id="tree-pane-tickets">` with sidebar toggle + ticket list container + Load More.
       - Right: `<div id="preview-pane-tickets">` wrapped in `.preview-panel-wrapper` and `.preview-content-wrapper`, containing the detail banner + detail sections.
   - Remove `.tickets-panel`, `.tickets-list-view`, `.tickets-task-view`, and back-button markup.
   - Preserve all existing element IDs for JS compatibility.

2. **CSS** (`src/webview/planning.html` `<style>` block):
   - Add `#tickets-content` to the display rules block (lines 207-224).
   - Add `#tree-pane-tickets` to the tree-pane selector group (lines 667-676).
   - Add `#tree-pane-tickets` to the collapse selector group (lines 308-311).
   - Add `#preview-pane-tickets` to the preview-pane selector group (lines 898-907).
   - Remove `.tickets-panel`, `.tickets-list-view`, `.tickets-task-view`, `.tickets-back-btn-group`, `.tickets-task-header` layout rules (lines 2315-2418).
   - Replace `.tickets-issue-card` with `.ticket-node` using the same CSS custom property tokens as `.tree-node` but with vertical card layout (lines 2421-2438).
   - Add `.ticket-node.selected` matching `.tree-node.selected` (lines 835-841).
   - Add cyber-theme overrides for `.ticket-node` matching `.tree-node` overrides (lines 1862-1868).
   - Add `flex-wrap: wrap` to the tickets controls strip for ClickUp hierarchy nav overflow.
   - Keep `.tickets-hierarchy-nav` styles (lines 2476-2507).
   - Keep `.tickets-issue-title`, `.tickets-issue-meta`, `.tickets-issue-import-btn` as sub-selectors under `.ticket-node`.

3. **JS** (`src/webview/planning.js`):
   - Update `getTicketsTabElements()` (lines 120-146): replace `listView`/`taskView` with `previewPane`/`detailBanner`/`emptyPreview`; remove `backToListButton`.
   - Replace `showTaskView()` / `showListView()` toggles in `renderTicketsLinearPanel()` (lines 4777-4779) and `renderTicketsClickUpPanel()` (lines 5072-5074) with banner/empty-preview visibility toggles.
   - Update `renderTicketsLinearTaskDetail()` (lines 4916-5025) and `renderTicketsClickUpTaskDetail()` (lines 5329-5423) to show/hide the detail banner and empty preview instead of setting title to "Select a task".
   - Remove `BACK TO LIST` event handler (lines 4695-4699).
   - Keep `BACK TO PARENT` event handler (lines 4701-4706); the button now lives in the detail banner.
   - Change delegated click root from `.tickets-task-view` to `#preview-pane-tickets` (line 4709).
   - Change `.tickets-issue-card` to `.ticket-node` in `renderTicketsLinearList()` (line 4897) and `renderTicketsClickUpList()` (line 5308).
   - Add `.selected` class to the currently selected ticket node in the sidebar.
   - Wire sidebar collapse toggle for tickets tab in `toggleSidebarCollapsed()` (lines 206-230) and `applySidebarState()` (lines 195-206).
   - Add `ticketsPreviewCollapsed` to state persistence (lines 222-229).

## Acceptance Criteria

- [ ] The Tickets tab renders a persistent left sidebar and right preview pane in a 1:3 flex ratio.
- [ ] The sidebar collapse button (`«`) collapses the ticket list to 40px, identical to Local Docs.
- [ ] Selecting a ticket in the sidebar loads its details into the right pane without hiding the sidebar.
- [ ] Subtasks appear as a list at the bottom of the description in the right pane.
- [ ] No `.tickets-panel`, `.tickets-list-view`, or `.tickets-task-view` layout CSS remains in the file.
- [ ] Ticket sidebar items use `.ticket-node` class with visual styling matching `.tree-node` (hover, selection, left-border accent).
- [ ] The existing "Back to Parent" hierarchy navigation still functions in the new layout.
- [ ] The `#tickets-content` element has proper `display: flex` rules matching other tabs.
- [ ] The sidebar collapse toggle works for the Tickets tab.
- [ ] Action buttons (Import, Refine, Ask Agent) appear in a contextual banner in the preview pane when a ticket is selected.
- [ ] An empty state message is shown in the preview pane when no ticket is selected.
- [ ] The ClickUp hierarchy nav does not overflow the controls strip.

## Verification Plan

### Automated Tests

(No automated tests to run — per session directive, skip automated test execution.)

### Manual Verification

1. Switch to the Tickets tab — confirm 1:3 split layout with sidebar on left and preview on right.
2. Click the sidebar collapse button (`«`) — confirm sidebar collapses to 40px and preview expands.
3. Click a ticket in the sidebar — confirm details appear in the right preview pane without hiding the sidebar.
4. Confirm the selected ticket in the sidebar has a `.selected` visual state (accent border, glow).
5. Click a different ticket — confirm the preview pane updates and the sidebar selection moves.
6. Confirm subtasks appear as a structured list at the bottom of the description.
7. Click "Back to Parent" (if the ticket has a parent) — confirm the preview pane loads the parent task while the sidebar stays on the current list.
8. Confirm the empty state ("Select a ticket to preview") appears when no ticket is selected.
9. Switch between Linear and ClickUp providers — confirm the controls strip adapts (Linear shows search/project/state filters; ClickUp shows hierarchy nav + status filter).
10. Confirm the ClickUp hierarchy nav (Space → Folder → List) wraps properly within the controls strip.
11. Switch between Kanban Dark, Claude Terracotta, and Slightly Darker Black themes — confirm ticket sidebar items and preview pane styling adapt correctly.
12. Confirm no `.tickets-panel`, `.tickets-list-view`, or `.tickets-task-view` CSS rules remain in the stylesheet.

---

**Recommendation**: Complexity 5 → **Send to Coder**

## Review Findings

Implementation matches plan spec closely. One MAJOR bug fixed: `renderTicketsClickUpTaskDetail()` was missing `backToParentButton` management — ClickUp tasks with parents would never show the "Back to Parent" button, and the event handler only called `loadLinearTaskDetails()`. Fixed by adding `backToParentButton` destructuring + show/hide logic to the ClickUp detail function, adding `dataset.parentProvider` ('linear'|'clickup') to both providers, and updating the event handler to dispatch to the correct loader. Files changed: `planning.js` (lines 4704-4714, 4949-4953, 4961-4972, 5356, 5383-5387, 5471-5482). All CSS/HTML requirements verified present and correct. Remaining risks: `listView` property name in `getTicketsTabElements()` is misleading but functional (deferred); `#tree-pane-design` missing from base tree-pane CSS group is pre-existing and out of scope.
