# Move Tickets Tab Status Filter Next to Source Summary

## Goal

Move the three Tickets-tab filter `<select>` elements (project picker, state filter, status filter) to immediately after the source summary span in DOM order, so they sit visually next to the source they refine instead of being carried to the far right by the search input's `margin-left: auto`.

### Problem
In the Tickets tab of `planning.html`, the status filter dropdown (`#tickets-status-filter`) appears way over on the right side of the controls strip, far from the "Source" button and source summary label. Users repeatedly expect the filter to sit immediately next to the displayed source (i.e., right after the source summary span), because the filter is conceptually a refinement of the selected source — not a standalone action grouped with the right-side action buttons.

### Background Context
The Tickets tab controls strip is a single flex row (`.controls-strip-row`) containing, in DOM order:
1. Workspace picker (hidden)
2. **Source button** (`#tickets-source-btn`)
3. **Source summary** (`#tickets-source-summary`)
4. Search input (`#tickets-search`)
5. Project picker (`#tickets-project-picker`, Linear only, hidden by default)
6. State filter (`#tickets-state-filter`, Linear only, hidden by default)
7. **Status filter** (`#tickets-status-filter`, ClickUp only, hidden by default)
8. Action buttons: + New Ticket, Refetch, Sync changes, Agent API

### Root Cause
The `.sidebar-search-input` CSS class (line 1900 of `planning.html`) declares `margin-left: auto`. In a flex row, `margin-left: auto` on the search input pushes it — and every element after it in DOM order — to the right edge of the row. Because the three filter `<select>` elements (project picker, state filter, status filter) are placed **after** the search input in DOM order, they get carried to the far right alongside the action buttons. The user sees the status filter detached from the source it is meant to refine.

The fix is to move the three filter selects **before** the search input in DOM order so they remain anchored to the source summary on the left, while the `margin-left: auto` on the search input cleanly separates the filter group from the search/action group on the right.

## Metadata
- **Tags:** ui, ux
- **Complexity:** 2/10

## User Review Required
No user review required. This is a pure DOM-order reorder within a single file with no logic, data, or behavioral changes. The change is visually verifiable.

## Complexity Audit

### Routine
- Pure DOM-order reorder of three `<select>` elements within a single flex row in `planning.html`.
- No JS logic, event handlers, or data flow changes — elements keep their IDs and JS references them by `getElementById` (order-independent, confirmed at `planning.js` lines 1059–1062, 1091, 1205).
- No migration concerns (unreleased UI tweak).
- No new dependencies.
- No CSS class modifications — `.sidebar-search-input` and `.controls-strip-row` are untouched.

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None. This is a static HTML reorder with no asynchronous or concurrent behavior.
- **Security:** None. No user input handling, no data flow changes.
- **Side Effects:** None beyond the intended visual repositioning. No JS state, event listeners, or data bindings are affected.
- **Dependencies & Conflicts:**
  - **Linear vs ClickUp visibility:** The three filters are toggled independently by `renderTicketsLinearPanel()` (`planning.js` line 8190) and `renderTicketsClickUpPanel()` (`planning.js` line 8656) via `style.display`. Reordering the DOM does not affect this — `getElementById` is used everywhere. No JS changes needed.
  - **Hidden filters and flex layout:** When a filter is `display:none` it is removed from the flex flow, so hidden filters won't create stray gaps next to the source summary. The `gap: 8px` on `.controls-strip-row` (line 2715) only applies between visible flex items.
  - **`margin-left: auto` boundary:** After the reorder, the search input remains the first element with `margin-left: auto`, so it still pushes itself and the trailing action buttons to the right. The filters, now preceding the search input, stay left.
  - **`flex-wrap: wrap` on `.controls-strip-row` (line 2714):** If the row is too narrow, items wrap. After the reorder, the filter group (source summary + 3 selects) wraps as a left-anchored cluster and the search/action group wraps to the right — this is the desired behavior and an improvement over the current state where filters wrap with the action buttons.
  - **No position-based CSS:** Confirmed no `:nth-child` or `:nth-of-type` selectors target the tickets controls strip. The reorder cannot break positional CSS rules.
  - **Other tabs:** This change is scoped to `#controls-strip-tickets` only. The `.sidebar-search-input` class is shared, but we are not modifying the class — only the DOM order within the tickets strip.

## Dependencies
- None

## Adversarial Synthesis
Key risks: virtually none for this change — it is a single-file DOM reorder with ID-based JS references. The only theoretical concern is `flex-wrap: wrap` causing unexpected wrapping on very narrow viewports, but this is an improvement over the current behavior, not a regression. Mitigation: visual verification at narrow widths during the manual test pass.

## Proposed Changes

### `src/webview/planning.html` — Reorder filter selects before the search input

Move the three filter `<select>` elements (and their comment) from **after** the search input to **immediately after** the source summary span, before the search input.

**Context:** The `.controls-strip-row` at line 3618 is a flex row. The search input (`#tickets-search`) carries `margin-left: auto` via `.sidebar-search-input` (line 1900), pushing itself and all trailing siblings to the right edge. Moving the filter selects ahead of the search input anchors them to the left cluster (source button + summary).

**Current (lines 3623–3629):**
```html
<button id="tickets-source-btn" class="strip-btn" title="Choose provider and navigate the source hierarchy">Source</button>
<span id="tickets-source-summary" class="workspace-static-label"></span>
<input id="tickets-search" type="text" class="sidebar-search-input" placeholder="Search tickets..." />
<!-- Inline filters moved out of Source modal -->
<select id="tickets-project-picker" class="planning-select" style="display:none" title="Filter by Linear project"></select>
<select id="tickets-state-filter" class="planning-select" style="display:none" title="Filter by Linear state"></select>
<select id="tickets-status-filter" class="planning-select" style="display:none" title="Filter by ClickUp status"></select>
```

**Proposed:**
```html
<button id="tickets-source-btn" class="strip-btn" title="Choose provider and navigate the source hierarchy">Source</button>
<span id="tickets-source-summary" class="workspace-static-label"></span>
<!-- Inline filters moved out of Source modal -->
<select id="tickets-project-picker" class="planning-select" style="display:none" title="Filter by Linear project"></select>
<select id="tickets-state-filter" class="planning-select" style="display:none" title="Filter by Linear state"></select>
<select id="tickets-status-filter" class="planning-select" style="display:none" title="Filter by ClickUp status"></select>
<input id="tickets-search" type="text" class="sidebar-search-input" placeholder="Search tickets..." />
```

**Logic:** No JS changes. The JS in `planning.js` references these elements by `getElementById` (lines 1059–1062, 1091, 1205) and is unaffected by DOM order. The visibility-toggling functions `renderTicketsLinearPanel()` (line 8190) and `renderTicketsClickUpPanel()` (line 8656) set `style.display` on these elements by reference, not by position.

**Edge Cases:** Hidden (`display:none`) filters are removed from flex flow and create no gaps. The `flex-wrap: wrap` on the row means narrow viewports wrap the filter cluster left and the search/action cluster right — the desired outcome.

No other files need changes.

## Verification Plan

### Automated Tests
None. This is a pure visual/DOM-order change with no logic to unit-test. Per session directives, automated tests are skipped and will be run separately by the user.

### Manual Verification
1. Build the VSIX and install it in VS Code (per project convention: testing is done via installed VSIX, not `dist/`).
2. Open the Switchboard planning panel and switch to the **Tickets** tab.
3. **ClickUp source:** Configure a ClickUp integration in Setup, select a list in the Tickets tab Source picker. Confirm the status filter dropdown appears immediately to the right of the source summary label, and the search input + action buttons remain on the far right.
4. **Linear source:** Configure a Linear integration, select a team/project. Confirm the project picker and state filter dropdowns appear next to the source summary, and the status filter remains hidden.
5. **No source selected:** Confirm no filter dropdowns are visible and the layout does not have stray gaps.
6. **Narrow viewport:** Resize the VS Code window or panel to a narrow width and confirm the filter cluster wraps cleanly to the left and the search/action cluster to the right (no overlapping or orphaned elements).
7. Confirm filtering still works: select a status/project/state and verify the ticket list updates correctly (no regression from the reorder).

## Recommendation
Complexity 2/10 → **Send to Intern**. This is a trivial, single-file DOM reorder with no logic changes and fully verified ID-based references.
