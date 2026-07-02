# implementation.html plan select panel layout improvements

**Plan ID:** ffc11205-23c8-499a-8e4f-d4b0f5dce6cb

## Goal

### Problem
The plan select panel in implementation.html needs several layout refinements to save space and improve clarity:
1. The section label "PLAN SELECT" should be renamed to "PLANS" to save horizontal space.
2. The "COMPLETE" button should be removed entirely.
3. The "COPY" button should be renamed to "COPY PROMPT".
4. The "CREATE" button should be renamed to "NEW".
5. The "NEW" button should be positioned to the LEFT of the "COPY PROMPT" button (currently it's to the right).

### Background
The plan select panel is defined in implementation.html (lines 1520-1546). It contains a section header with label "PLAN SELECT", a dropdown (`#run-sheet-select`), and a row of action buttons: COMPLETE, RECOVER (hidden), COPY, and CREATE. The buttons use the `secondary-btn w-full` class which makes them flex-grow to equal width.

### Root Cause
This is a layout/labeling issue, not a bug. The current layout was designed before the project panel's Kanban tab became the primary plan management surface. The "COMPLETE" button is now redundant — plan completion is handled via kanban column drag or the project panel. The button labels are verbose for the compact sidebar. The button ordering doesn't match the natural workflow (create first, then copy prompt).

## Metadata
- **Tags:** ui, ux, refactor
- **Complexity:** 2/10

## User Review Required
No. Pure UI label/layout cleanup with no data-flow or backend changes. The removed buttons (COMPLETE/RECOVER) have equivalent actions on the kanban board. Safe to proceed.

## Complexity Audit

### Routine
- Renaming the section label `PLAN SELECT` → `PLANS` (single text node, line 1523).
- Renaming button labels `COPY` → `COPY PROMPT` and `CREATE` → `NEW` (HTML text + JS reset strings).
- Reordering the two remaining buttons so `NEW` precedes `COPY PROMPT` in the flex row.
- Removing the `COMPLETE` and `RECOVER` button elements and their now-dead event listeners.

### Complex / Risky
- None. All changes are localized to `src/webview/implementation.html`. No backend, no data consistency, no new patterns.

## Edge-Case & Dependency Audit
- **COMPLETE button removal**: The `completePlan` message handler in TaskViewerProvider.ts is reached via the `btnComplete` click listener (implementation.html:1864-1871) which sends `{ type: 'completePlan', sessionId }`. Removing the button element means the listener attaches to nothing (guarded by `if (btnComplete)`). The backend handler can remain as dead code — it may be used by other surfaces. The `btn-recover-plan` button (RECOVER) is currently `hidden` by default and shown when plan mode is toggled to `completed` via the `btnModeToggle` handler (lines 1909-1910). With COMPLETE removed, RECOVER becomes unreachable from the sidebar. This is acceptable: recovery is available via the kanban board. Both buttons should be removed for consistency.
- **CORRECTION — RECOVER show/hide location**: The original draft claimed `updatePlanActionStates()` shows/hides the RECOVER button. This is **incorrect**. `updatePlanActionStates()` (line 1653-1658) only toggles `copyPlanLinkBtn.disabled`. The COMPLETE/RECOVER show/hide logic lives in the `btnModeToggle` click handler (lines 1908-1910): `btnCompletePlan.classList.toggle('hidden', ...)` and `btnRecoverPlan.classList.toggle('hidden', ...)`. When removing the buttons, these two lines in the mode-toggle handler must also be removed (they reference now-null elements; the `if (btn...)` guards make them no-ops, but they are dead code).
- **Two complete-button references**: There are two separate `getElementById('btn-complete-plan')` lookups — `btnComplete` (line 1864, the click listener) and `btnCompletePlan` (line 1898, used by the mode-toggle show/hide). Both become dead once the element is removed. Remove both listener blocks and the show/hide lines for cleanliness.
- **Button text in JS**: The `planCreated` handler (implementation.html:2316-2320) resets `btnCreatePlan.innerText = 'CREATE'`. This must change to `'NEW'`. The click handler (implementation.html:1685) resets `btnCreatePlan.innerText = 'CREATE'` inside a 3s timeout fallback — this must also change to `'NEW'`. The interim `'Creating...'` text (line 1680) can stay as-is (still descriptive).
- **Button width**: With COMPLETE/RECOVER removed, the remaining buttons (NEW, COPY PROMPT) share the row. Using `w-full` on both gives them equal width. This is fine. If "COPY PROMPT" is too long for half-width, consider `flex: 2` on COPY PROMPT and `flex: 1` on NEW, but equal width is the simplest approach.

## Dependencies
- `sess_sidebar_plan_select_ux` — sibling subtask "Create plan button should not open VS Code dialogue" (`feature_plan_20260702083642_create-plan-button-no-vscode-dialogue.md`). This plan renames the implementation.html CREATE→NEW reset text; the sibling plan's verification references that rename. Apply both as one unit.

## Adversarial Synthesis
Key risks: (1) leaving dangling references to removed button IDs in the mode-toggle handler causing silent no-ops; (2) missing one of the two `btn-complete-plan` lookups so dead code lingers; (3) forgetting the JS reset-string rename so the button flips back to "CREATE" after creation. Mitigations: remove both listener blocks AND the two show/hide lines in the mode-toggle handler; update both `innerText = 'CREATE'` sites to `'NEW'`; visual verification confirms final state.

## Proposed Changes

### 1. `src/webview/implementation.html` — rename section label

```html
<!-- BEFORE (line 1523) -->
<div class="section-label">PLAN SELECT</div>

<!-- AFTER -->
<div class="section-label">PLANS</div>
```

### 2. `src/webview/implementation.html` — remove COMPLETE and RECOVER buttons, reorder and rename

```html
<!-- BEFORE (lines 1539-1545) -->
<div class="flex gap-2" style="margin-top: 6px;">
    <button id="btn-complete-plan" class="secondary-btn w-full">COMPLETE</button>
    <button id="btn-recover-plan" class="secondary-btn w-full hidden">RECOVER</button>
    <button id="btn-copy-plan-link" class="secondary-btn w-full" title="Copy Markdown link for active plan"
        aria-label="Copy plan link">COPY</button>
    <button id="btn-create-plan" class="secondary-btn w-full">CREATE</button>
</div>

<!-- AFTER -->
<div class="flex gap-2" style="margin-top: 6px;">
    <button id="btn-create-plan" class="secondary-btn w-full">NEW</button>
    <button id="btn-copy-plan-link" class="secondary-btn w-full" title="Copy Markdown link for active plan"
        aria-label="Copy plan link">COPY PROMPT</button>
</div>
```

### 3. `src/webview/implementation.html` — update JS button text references

```js
// BEFORE (line 1685, in btnCreatePlan click handler timeout fallback)
btnCreatePlan.innerText = 'CREATE';

// AFTER
btnCreatePlan.innerText = 'NEW';
```

```js
// BEFORE (line 2319, in planCreated message handler)
btnCreatePlan.innerText = 'CREATE';

// AFTER
btnCreatePlan.innerText = 'NEW';
```

### 4. `src/webview/implementation.html` — remove COMPLETE/RECOVER event listeners and show/hide logic

Remove the following dead code blocks now that the button elements no longer exist:

- **`btnComplete` click listener** (lines 1864-1871) — sends `completePlan`. Remove the entire `if (btnComplete) { ... }` block.
- **`btnRecoverPlan` click listener** (lines 1918-1923) — sends `recoverPlanFromSidebar`. Remove the entire `if (btnRecoverPlan) { ... }` block.
- **`btnCompletePlan` / `btnRecoverPlan` lookups** (lines 1898-1899) — `const btnCompletePlan = ...` and `const btnRecoverPlan = ...`. Remove both declarations.
- **Mode-toggle show/hide lines** (lines 1909-1910) — `if (btnCompletePlan) btnCompletePlan.classList.toggle(...)` and `if (btnRecoverPlan) btnRecoverPlan.classList.toggle(...)`. Remove both lines from the `btnModeToggle` click handler. The rest of the handler (toggle label/style, re-render dropdown) stays.

Note: `updatePlanActionStates()` (line 1653-1658) requires **no changes** — it only references `copyPlanLinkBtn`, which remains.

## Verification Plan

### Automated Tests
Skipped per session directive. The test suite will be run separately by the user. No compilation step required.

### Manual Verification
1. **Visual check**: Open the sidebar (implementation.html). Verify the section label reads "PLANS" (not "PLAN SELECT"). Verify the button row shows only "NEW" and "COPY PROMPT" (no COMPLETE, no RECOVER). Verify "NEW" is to the LEFT of "COPY PROMPT".
2. **NEW button**: Click "NEW". Verify it changes to "Creating..." and triggers plan creation. After creation completes, verify it resets to "NEW" (not "CREATE").
3. **COPY PROMPT button**: Select a plan, click "COPY PROMPT". Verify the copy feedback (success/error styling) works and the prompt is copied to clipboard.
4. **No console errors**: Open DevTools on the webview. Verify no errors about missing `btn-complete-plan` or `btn-recover-plan` elements.
5. **Plan mode toggle**: Toggle between ACTIVE and COMPLETED mode. Verify the dropdown updates and no errors occur from the removed COMPLETE/RECOVER button logic.

---

**Recommendation:** Complexity 2/10 → Send to Intern.

## Review Findings

Implementation verified correct: section label is PLANS, button row contains only NEW (left) and COPY PROMPT (right), COMPLETE/RECOVER buttons and all associated JS listeners/show-hide logic removed, both `innerText='CREATE'` reset sites updated to `'NEW'`. One MAJOR issue fixed: airlock guidance text at `implementation.html:3182` still referenced the old "CREATE" button name — updated to "NEW" along with the corresponding assertion in `direct-create-ticket-regression.test.js:32`. Two NIT-level dead backend handlers (`recoverPlanFromSidebar`, `completePlan` in TaskViewerProvider.ts) remain as approved by the plan. No compilation or tests run per session directives. Remaining risk: the two dead handlers are harmless but could confuse future readers.
