# implementation.html plan select panel layout improvements

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
- **Tags**: `implementation.html`, `plan-select`, `layout`, `ui`, `labels`, `buttons`
- **Complexity**: 2/10

## Complexity Audit
**Routine.** Pure HTML/CSS changes in a single file. No backend logic, no data flow changes. The only care needed is ensuring the `COMPLETE` button's event listener and backend handler (`completePlan` message) are not referenced elsewhere — if they are, the handler can remain as dead code but the button element is removed. The button text changes require updating the JS that resets button text (e.g., `btnCreatePlan.innerText = 'CREATE'` in the `planCreated` handler).

## Edge-Case & Dependency Audit
- **COMPLETE button removal**: The `completePlan` message handler (TaskViewerProvider.ts:9759-9763) calls `_handleCompletePlan`. The button's event listener is in implementation.html. Removing the button element means the listener attaches to nothing (guarded by `if (btnCompletePlan)`). The backend handler can remain as dead code — it may be used by other surfaces. The `btn-recover-plan` button (RECOVER) is currently hidden and shown when a plan is completed — with COMPLETE removed, RECOVER becomes unreachable from the sidebar. This is acceptable: recovery is available via the kanban board. Both buttons should be removed for consistency.
- **Button text in JS**: The `planCreated` handler (implementation.html:2316-2320) resets `btnCreatePlan.innerText = 'CREATE'`. This must change to `'NEW'`. Similarly, the click handler (implementation.html:1680) sets `btnCreatePlan.innerText = 'Creating...'` — this can stay as-is or change to `'Creating...'` (still descriptive).
- **Button width**: With COMPLETE removed, the remaining buttons (NEW, COPY PROMPT) share the row. Using `w-full` on both gives them equal width. This is fine. If "COPY PROMPT" is too long for half-width, consider `flex: 2` on COPY PROMPT and `flex: 1` on NEW, but equal width is the simplest approach.
- **RECOVER button**: The `btn-recover-plan` button (implementation.html:1541) is `hidden` by default and shown via `updatePlanActionStates()`. With COMPLETE gone, RECOVER should also be removed since there's no way to complete a plan from the sidebar to trigger the recover state.

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
// BEFORE (line 1685, in btnCreatePlan click handler timeout)
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

### 4. `src/webview/implementation.html` — remove or guard COMPLETE/RECOVER event listeners

Search for `btn-complete-plan` and `btn-recover-plan` event listeners and `updatePlanActionStates` references to the complete/recover buttons. Remove the listeners (the `if (btn)` guards mean they're no-ops once the elements are gone, but cleaner to remove the dead code blocks). Specifically:
- Remove the `btnCompletePlan` click listener that sends `completePlan`.
- Remove the `btnRecoverPlan` click listener that sends `recoverPlanFromSidebar`.
- In `updatePlanActionStates()`, remove logic that shows/hides the RECOVER button based on plan mode.

## Verification Plan
1. **Visual check**: Open the sidebar (implementation.html). Verify the section label reads "PLANS" (not "PLAN SELECT"). Verify the button row shows only "NEW" and "COPY PROMPT" (no COMPLETE, no RECOVER). Verify "NEW" is to the LEFT of "COPY PROMPT".
2. **NEW button**: Click "NEW". Verify it changes to "Creating..." and triggers plan creation. After creation completes, verify it resets to "NEW" (not "CREATE").
3. **COPY PROMPT button**: Select a plan, click "COPY PROMPT". Verify the copy feedback (success/error styling) works and the prompt is copied to clipboard.
4. **No console errors**: Open DevTools on the webview. Verify no errors about missing `btn-complete-plan` or `btn-recover-plan` elements.
5. **Plan mode toggle**: Toggle between ACTIVE and COMPLETED mode. Verify the dropdown updates and no errors occur from the removed COMPLETE/RECOVER button logic.
