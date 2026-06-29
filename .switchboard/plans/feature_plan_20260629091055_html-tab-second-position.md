# Reposition HTML Tab to Second Position in Planning Panel

## Goal

Move the HTML tab button in the Planning panel tab bar from its current last position (5th) to the second position, immediately after the DOCS tab, so the two most frequently used tabs are adjacent.

### Problem
The HTML tab in `planning.html` is currently positioned last (5th) in the tab bar, after DOCS, TICKETS, RESEARCH, and NotebookLM. The user wants it positioned second, immediately after the DOCS tab, so that the two most frequently used tabs (Docs and HTML previews) are adjacent.

### Root Cause
The tab buttons in `planning.html` are defined in DOM order inside the `#research-tab-bar` element. The HTML tab button was appended at the end of the bar when the HTML tab was added, rather than being inserted in the desired position.

### Background
The tab bar is a simple flex container of `<button class="shared-tab-btn">` elements. Their visual order is determined entirely by DOM order — there is no CSS ordering or JS reordering logic. Moving the HTML tab button to the second position in the DOM is sufficient.

## Metadata
- **Tags**: ui, ux
- **Complexity**: 2/10

## User Review Required
No user review required. This is a trivial DOM reorder with no logic, state, or migration implications. The change is fully reversible and has no user-data impact.

## Complexity Audit

### Routine
- Single-line DOM reorder of one `<button>` element within a static HTML tab bar
- No JS logic changes — `switchToTab(tabName)` in `planning.js` (line 1275) selects tabs via `document.querySelector('.shared-tab-btn[data-tab="${tabName}"]')`, which is position-independent
- No CSS changes — the tab bar is a flex container; visual order follows DOM order
- No state management changes — `applySidebarState()` is called per-tab-name, not per-index (line 1264)
- No persisted user data affected — tab order is static HTML, not saved to settings or workspace state

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions**: None. The `tabButtons` NodeList (line 1272) and `tabContents` NodeList (line 1273) are captured once at init and reused. Reordering DOM position of existing buttons does not invalidate either NodeList. No buttons are added or removed.
- **Security**: No security implications. No user input, no external data, no privilege changes.
- **Side Effects**: None. The `id="tickets-tab-btn"` attribute on the TICKETS button is preserved in the new position — it is an ID selector, not positional, so no CSS or JS that references it is affected.
- **Dependencies & Conflicts**: No dependencies on other plans or external state. This change is fully independent.

## Dependencies
- None

## Adversarial Synthesis
Key risks: accidental loss of the `id="tickets-tab-btn"` attribute during the reorder, or misplacing the HTML button into the wrong slot. Mitigations: the "After" snippet in the plan explicitly preserves all existing attributes; the edit is a single contiguous block replacement. The `switchToTab` function's `data-tab` attribute lookup makes DOM position irrelevant to functionality.

## Proposed Changes

### File: `src/webview/planning.html` (lines 3359–3365)

Move the HTML tab button from position 5 to position 2.

**Before (lines 3359–3365):**
```html
<div id="research-tab-bar" class="shared-tab-bar">
    <button class="shared-tab-btn active" data-tab="docs">DOCS</button>
    <button class="shared-tab-btn" data-tab="tickets" id="tickets-tab-btn">TICKETS</button>
    <button class="shared-tab-btn" data-tab="research">RESEARCH</button>
    <button class="shared-tab-btn" data-tab="notebook">NotebookLM</button>
    <button class="shared-tab-btn" data-tab="html">HTML</button>
</div>
```

**After:**
```html
<div id="research-tab-bar" class="shared-tab-bar">
    <button class="shared-tab-btn active" data-tab="docs">DOCS</button>
    <button class="shared-tab-btn" data-tab="html">HTML</button>
    <button class="shared-tab-btn" data-tab="tickets" id="tickets-tab-btn">TICKETS</button>
    <button class="shared-tab-btn" data-tab="research">RESEARCH</button>
    <button class="shared-tab-btn" data-tab="notebook">NotebookLM</button>
</div>
```

**Implementation detail**: The edit replaces the entire `<div id="research-tab-bar">...</div>` block (lines 3359–3365) with the reordered version. This ensures the `id="tickets-tab-btn"` attribute is preserved on the TICKETS button.

No other files need changes.

## Verification Plan

### Automated Tests
No automated tests required. This is a static HTML reorder with no logic change. The test suite will be run separately by the user.

### Manual Verification
1. Open the Switchboard Planning panel.
2. Confirm the tab bar reads: `DOCS | HTML | TICKETS | RESEARCH | NotebookLM`.
3. Click each tab and verify the correct content panel activates.
4. Switch to HTML tab, confirm sidebar and preview load correctly.
5. Reload the webview and confirm the tab order persists (it is static HTML, so it should).

**Recommendation**: Complexity 2/10 → Send to Intern.

---

## Code Review (Reviewer Pass)

### Stage 1 — Grumpy Principal Engineer

> *"You moved a button. One button. In a flex container. And you somehow managed to not screw it up. Congratulations, here's your participation trophy."*

**NIT — Line numbers drifted**: The plan references lines 3359–3365. The actual file has the tab bar at lines 3359–3365 — matches exactly. No issue, just noting the plan author got lucky with line stability.

**NIT — No `data-tab` ordering assertion in JS**: `switchToTab()` uses `querySelector('[data-tab="..."]')` which is position-independent. The plan correctly identifies this. No issue.

No CRITICAL, MAJOR, or NIT findings. The implementation is a verbatim match of the plan's "After" snippet.

### Stage 2 — Balanced Synthesis

**Keep**: Everything. The DOM reorder is exactly as specified — DOCS, HTML, TICKETS, RESEARCH, NotebookLM. The `id="tickets-tab-btn"` attribute is preserved on the TICKETS button.

**Fix now**: Nothing.

**Defer**: Nothing.

### Code Fixes Applied
None required.

### Verification Results
- **Syntax check**: N/A (static HTML, no JS).
- **DOM order confirmed**: `planning.html` lines 3359–3365 show `DOCS → HTML → TICKETS → RESEARCH → NotebookLM`. ✓
- **`id="tickets-tab-btn"` preserved**: Confirmed on line 3362. ✓
- **No scanline or sidebar changes**: This plan touches only the tab bar. ✓

### Files Changed
- `src/webview/planning.html` — tab bar reordered (lines 3359–3365)

### Remaining Risks
None. This is a static HTML reorder with no logic, state, or migration implications.
