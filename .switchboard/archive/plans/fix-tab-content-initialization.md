# Fix Tab Content Initialization on Page Load

## Goal
Ensure the initially active tab in `planning.html`, `design.html`, and `kanban.html` renders its content immediately on page load without requiring a user click. The active tab's CSS is already correct, but the JavaScript data-fetching path is gated behind click-only handlers.

## Background & Root Cause
The tabs use lazy loading where data fetching logic is encapsulated in tab switching functions (`switchToTab` in planning.js, `switchTab` in design.js, and inline handlers in kanban.html). These functions are only triggered by click event listeners on tab buttons.

When the page loads:
1. HTML marks one tab as `active` (e.g., "LOCAL DOCS" in planning.html)
2. CSS displays that tab's content div via `.shared-tab-content.active { display: flex; }`
3. The JavaScript that fetches actual data never runs because the tab switching functions are only called on click events

**Example from planning.js (lines 456-477):**
```javascript
// 5. Tab-specific initialization
if (tabName === 'kanban') {
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
}
if (tabName === 'tickets') {
    if (!ticketsInitialized) {
        initTicketsTab();
        restoreTicketsState();
        ticketsInitialized = true;
    }
    // ... more data fetching
}
```

This code only executes when you click a tab, leaving the initially active tab empty until interaction.

## Affected Files
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js`
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`

## Affected Tabs

### planning.html
- LOCAL DOCS (initial active)
- ONLINE DOCS
- KANBAN PLANS (has data fetching)
- TICKETS (has data fetching)
- RESEARCH
- NotebookLM

### design.html
- STITCH (initial active)
- BRIEFS
- HTML PREVIEWS
- IMAGES
- DESIGN SYSTEM

### kanban.html
- KANBAN (initial active)
- AGENTS (has data fetching)
- PROMPTS
- AUTOMATION (has data fetching)
- WORKTREES
- UAT
- SETUP (has data fetching)

### setup.html (NOT affected)
- Setup tab properly calls `activateTab` during `initTabs()` on page load, so it works correctly.

## Metadata
**Tags:** ui, bugfix, frontend
**Complexity:** 3

## User Review Required
None

## Complexity Audit

### Routine
- Add a single initialization call immediately after the tab button event listener setup in `planning.js`.
- Add a single initialization call immediately after the tab button event listener setup in `design.js`.
- Add a single initialization call immediately after the tab button event listener setup in `kanban.html`.
- All changes reuse existing tab switching functions; no new patterns introduced.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- **Ordering risk:** The initialization call must appear **after** the `forEach` that attaches click listeners. If placed earlier, the synthetic click or direct function call may interact with listeners that are not yet bound (particularly relevant for `kanban.html` where side effects like `captureBoardViewState` depend on the click handler being fully registered).

### Security
- None. No user input is evaluated; the selector reads a statically rendered `active` class or a hardcoded fallback string.

### Side Effects
- **Duplicate state in TICKETS tab:** `planning.js` guards ticket initialization with `ticketsInitialized` inside `switchToTab`, so calling it on load is safe. The guard prevents `initTicketsTab()` and `restoreTicketsState()` from running twice.
- **Duplicate message posts:** `design.js` posts a `stitchListProjects` message on every `switchTab('stitch')`. Calling it on initial load is the desired behavior (the STITCH tab is empty until this message is sent). No deduplication is required because the first call is the first valid request.
- **kanban.html inline click:** Using `.click()` will re-trigger the same handler that just finished binding. This is acceptable because the handler updates classes and conditionally fetches data. There is no cumulative state mutation beyond class toggling and conditional fetches.

### Dependencies & Conflicts
- None. No external dependencies. Does not conflict with `setup.html`, which uses a separate `activateTab`-style initialization already.

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) ordering the init call before listener attachment in `kanban.html` could cause state capture to miss the active tab, and (2) calling `switchTab` on load for design's STITCH tab will unconditionally post a `stitchListProjects` message that may be redundant if the extension host already pushed data. Mitigations: place init calls strictly after the `forEach` blocks, and accept the STITCH message as harmless idempotent load behavior.

## Proposed Changes

### planning.js
- **Context:** `switchToTab` is defined at line 427. The tab button click listeners are bound at lines 480–484. The function already contains guards (e.g., `ticketsInitialized`) that make it safe to invoke on load.
- **Logic:** After the `tabButtons.forEach` block, read the currently active tab button's `data-tab` attribute and call `switchToTab` with it. Fallback to `'local'` if no active button is found.
- **Implementation:** Insert after line 484:
```javascript
// Initialize the initially active tab
const initialTab = document.querySelector('.shared-tab-btn.active')?.dataset.tab || 'local';
switchToTab(initialTab);
```
- **Edge Cases:**
  - If no tab has the `active` class, fallback to `'local'`.
  - `ticketsInitialized` prevents duplicate ticket tab setup.
  - The `else` branch inside `switchToTab` (save state when leaving tickets) only runs when `tabName !== 'tickets'`, so the initial load call with `tabName === 'tickets'` does not prematurely trigger `saveTicketsState()`.

### design.js
- **Context:** `switchTab` is defined at line 132. The tab button click listeners are bound at lines 159–163.
- **Logic:** After the `tabBtns.forEach` block, read the currently active tab button's `data-tab` attribute and call `switchTab` with it. Fallback to `'stitch'` if no active button is found.
- **Implementation:** Insert after line 163:
```javascript
// Initialize the initially active tab
const initialTab = document.querySelector('.shared-tab-btn.active')?.dataset.tab || 'stitch';
switchTab(initialTab);
```
- **Edge Cases:**
  - If no tab has the `active` class, fallback to `'stitch'`.
  - The `stitchListProjects` postMessage on every `switchTab('stitch')` is the intended load path; it is not deduplicated because the first request is the correct one.

### kanban.html
- **Context:** The tab switching logic is inline inside a `kanbanTabButtons.forEach` block that ends at line 3489. The handler captures board state on exit, toggles active classes, and hydrates tabs (AGENTS, UAT, PROMPTS, WORKTREES) with conditional `postKanbanMessage` calls.
- **Logic:** After the `forEach` block (line 3489), detect the active tab button and programmatically click it to trigger the existing inline handler. Alternatively, extract the inline logic into a named function and call it directly.
- **Implementation (direct click approach):** Insert after line 3489:
```javascript
// Initialize the initially active tab
const initialTabBtn = document.querySelector('.shared-tab-btn.active');
if (initialTabBtn) {
    initialTabBtn.click();
}
```
- **Edge Cases:**
  - The `.click()` must occur after listener registration (i.e., after the closing `});` of the `forEach`). Placing it earlier would execute with unbound handlers.
  - If no tab is marked active, nothing happens. No fallback is strictly necessary because the HTML always marks one tab as active, but a fallback could be added if desired.

## Verification Plan

### Automated Tests
Skip per session directive. The test suite will be run separately by the user.

### Manual Tests
1. Open planning.html - verify LOCAL DOCS content loads immediately
2. Click to KANBAN PLANS tab - verify plans load
3. Click to TICKETS tab - verify tickets load
4. Refresh page - verify initially active tab loads content
5. Repeat for design.html with STITCH tab
6. Repeat for kanban.html with KANBAN tab
7. Test tab switching still works correctly after the fix
8. Verify no console errors on page load

## Risks
- Low risk: The change simply calls existing functions that already work on click.
- Potential issue: If the switch function has side effects that shouldn't run on initial load, but code inspection shows it only handles state cleanup and data fetching which is appropriate for initial load.

## Recommendation
**Send to Intern**

## Review Findings

- **Files changed:** `design.js` — removed redundant `stitchListProjects` postMessage block (lines 3283-3288) that duplicated the message now sent by `switchTab(initialTab)`; `planning.js` — removed extra blank lines after init call.
- **Validation:** Verified no stale comments remain, no duplicate init paths exist across all three files, and all init calls are positioned strictly after listener attachment.
- **Remaining risks:** Low. The only material fix was removing a now-redundant workaround in `design.js` that would have caused a double `stitchListProjects` message on page load.
