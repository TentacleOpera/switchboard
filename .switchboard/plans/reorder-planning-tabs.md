# Reorder Planning Panel Tabs

## Metadata
- **Complexity:** 1
- **Tags:** frontend, ui

## Goal
Reorganize the top tab row in `planning.html` to the following order:
1. Local docs
2. Online docs
3. Kanban plans
4. HTML previews
5. Tickets
6. Research
7. Design system
8. NotebookLM

## Background
The current tab order in `src/webview/planning.html` is:
1. Local docs
2. Online docs
3. Kanban plans
4. Research
5. NotebookLM
6. Design system
7. HTML previews
8. Tickets

The user wants HTML previews and Tickets moved earlier, and Research, Design system, and NotebookLM moved later.

## Root Cause / Why
This is a UX/layout preference. The user likely wants more frequently used tabs (HTML previews, Tickets) positioned earlier in the tab bar for quicker access.

## Implementation

### Step 1: Reorder tab buttons
In the `.research-tab-bar` div (`<div id="research-tab-bar" class="research-tab-bar">`), reorder the eight `<button class="research-tab-btn">` elements so their `data-tab` attributes appear in this sequence:
- `local` (keep `active` class since it's the default first tab)
- `online`
- `kanban`
- `html-preview`
- `tickets`
- `research`
- `design`
- `notebook`

### Step 2: Reorder content divs (optional but recommended for maintainability)
Reorder the corresponding `.research-tab-content` `<div>` elements inside `.container` to match the new tab order. This is not strictly required for functionality because the JavaScript tab switcher uses `document.getElementById(\`${tabName}-content\`)` (ID-based lookup, not positional), but keeping DOM order in sync with visual order reduces future confusion.

### Step 3: No JavaScript changes required
`src/webview/planning.js` uses `dataset.tab` and element IDs to switch tabs. It does not depend on DOM position or index. No changes needed in the JS file.

## Validation
- Open the Planning panel in VS Code
- Verify the tab bar displays the 8 tabs in the new order
- Click each tab and confirm the correct content pane activates
- Confirm the default active tab on load remains "Local docs"

## Risks
- **None identified.** This is a pure DOM reordering with no logic dependencies on tab position.

## Status
**Completed.**
- Tab buttons reordered in `src/webview/planning.html` (lines 2855–2864)
- No JavaScript changes required
- No content `<div>` reordering needed (ID-based tab switching)
