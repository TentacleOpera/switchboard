# Plan: Rework ClickUp Subtask Display in implementation.html

## Goal

Filter subtasks out of the main ClickUp/Linear task list and render them as interactive, clickable items within the task detail view. Subtasks should be displayed with the format "Parent title: title" to provide context about which parent task they belong to.

## Metadata

**Tags:** frontend, UI, bugfix
**Complexity:** 4

## User Review Required

- [ ] Confirm that subtask statuses should NOT appear in the main list status filter dropdown (or confirm they should remain)
- [ ] Confirm subtask click behavior should load detail view inline (same as parent task cards)

## Problem

In the ClickUp tab of `implementation.html`, subtasks are currently displayed as part of the main task list (one huge unordered list alongside parent tasks). The task detail view renders subtasks as static, non-interactive `<div>` elements.

The desired behavior is:
1. **Main list**: Show only parent tasks. Hide subtasks entirely.
2. **Detail view**: Show subtasks under the "Subtasks" heading as clickable links that load the subtask detail when clicked.
3. **Display format**: Subtasks should be displayed as "Parent title: title" to provide context about the parent task.

## Root Cause

1. **CRITICAL BUG**: `_normalizeClickUpTask()` in `ClickUpSyncService.ts` was reading `parentId` from `raw?.parent` as a string, but the ClickUp API returns the parent as an object with an `id` field (e.g., `{ id: "12345" }`). This caused `parentId` to be set to the string "[object Object]" or empty, making the filter `!task.parentId` ineffective.
2. `getFilteredClickUpTasks()` returns every task in `clickUpProjectIssues` without filtering out items that have a `parentId`.
3. `renderSidebarClickUpTaskDetail()` renders subtasks as clickable `<button>` elements but without the "Parent title: title" format.
4. There is a click handler for ClickUp subtask items, but the display format needs updating.

## Complexity Audit

### Routine
- Step 1: Fix `parentId` population in `_normalizeClickUpTask()` to handle object structure (`ClickUpSyncService.ts` lines 712–722)
- Step 2: Filter subtasks out of the main task list (`implementation.html` lines 4084–4104)
- Step 3: Render subtasks as clickable `<button>` elements with "Parent title: title" format in the detail view (`implementation.html` lines 4036–4048)
- Step 4: Apply same format to Linear tab for consistency

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. This is a purely presentational change with no async logic.
- **Security:** `escapeAttr(st.id)` and `escapeHtml(st.title/status)` are already used consistently. No XSS vector introduced.
- **Side Effects:** The status filter dropdown (`renderSidebarClickUpStatusFilterOptions` at line 3962) builds its options from `clickUpProjectIssues`, which still contains subtasks. Subtask statuses will still appear in the filter dropdown. This is harmless and may even be useful.
- **Dependencies & Conflicts:** None in CREATED/BACKLOG. Adjacent PLAN REVIEWED items `fix_clickup_sidebar_autoload.md` and `fix_clickup_description_word_wrap.md` touch the same file but different functions. No logical conflicts.

## Dependencies

None

## Implementation Status

- **Step 1 (CRITICAL BUG FIX)**: ⏳ PENDING - Fix `parentId` population in `_normalizeClickUpTask()` to handle both string and object structures from ClickUp API
- **Step 2**: ✅ ALREADY IMPLEMENTED - Filter exists at line 4088
- **Step 3**: ⏳ PENDING - Need to update ClickUp subtask display format to "Parent title: title"
- **Step 4**: ⏳ PENDING - Need to update Linear subtask display format to "Parent title: title"

## Adversarial Synthesis

Key risks: (1) `parentId` may not be populated by `_normalizeClickUpTask` if the backend shape changes, causing the filter to silently fail, (2) ClickUp task IDs in HTML attributes are typically numeric strings but custom IDs could contain characters needing escaping. Mitigations: verify `parentId` field exists in the mapped task object before coding; `escapeAttr` handles standard attribute escaping.

## Proposed Changes

### `src/services/ClickUpSyncService.ts`

**Context 1:** `_normalizeClickUpTask()` (lines 712–722) was reading `parentId` from `raw?.parent` as a string, but the ClickUp API returns the parent as an object with an `id` field. This caused the filter to fail.

**Logic:** Update `parentId` extraction to handle both string and object structures.

**Implementation (lines 712–722):**
```typescript
parentId: (() => {
  // ClickUp API returns parent as either a string ID or an object with id field
  const parent = raw?.parent;
  if (typeof parent === 'string' && parent.trim()) {
    return parent.trim();
  }
  if (parent?.id) {
    return String(parent.id).trim();
  }
  return null;
})(),
```

**Status:** ⏳ PENDING

### `src/webview/implementation.html`

**Context 2:** `getFilteredClickUpTasks()` (lines 4084–4104) already has the filter to exclude subtasks from the main task list. This now works correctly with the fixed `parentId` population.

**Status:** ⏳ PENDING (requires Step 1 fix to function correctly)

**Context 2:** `renderSidebarClickUpTaskDetail()` (lines 4036–4048) renders subtasks as clickable `<button>` elements. The current display shows only the subtask title. The user wants the format "Parent title: title" to provide context.

**Logic:** Update the subtask title display to include the parent task title prefix.

**Implementation (lines 4038–4042):**
Change:
```js
const subtasksHtml = subtasks.length === 0
    ? '<p>No subtasks.</p>'
    : subtasks.map(st => `
        <button type="button" class="project-detail-item" data-clickup-subtask-id="${escapeAttr(st.id)}">
            <span class="project-detail-item-title">${escapeHtml(st.title)}</span>
            <span class="project-detail-item-status">${escapeHtml(st.status)}</span>
        </button>
    `).join('');
```
to:
```js
const subtasksHtml = subtasks.length === 0
    ? '<p>No subtasks.</p>'
    : subtasks.map(st => `
        <button type="button" class="project-detail-item" data-clickup-subtask-id="${escapeAttr(st.id)}">
            <span class="project-detail-item-title">${escapeHtml(task.title)}: ${escapeHtml(st.title)}</span>
            <span class="project-detail-item-status">${escapeHtml(st.status)}</span>
        </button>
    `).join('');
```

**Context 3:** Apply the same "Parent title: title" format to the Linear tab for consistency. Find the Linear subtask rendering function and update it similarly.

**Implementation:** Search for Linear subtask rendering (likely in `renderSidebarLinearTaskDetail()` or similar) and update the subtask title display to include the parent issue title prefix.

**Status:** ⏳ PENDING

**Context 3:** There is no click handler for ClickUp subtask items in the detail view. The Linear detail view uses a delegated listener on `detailSubtasksList` that calls `loadLinearTaskDetails()` when a `[data-linear-subtask-id]` button is clicked.

**Logic:** Attach a delegated click listener on `detailSubtasksList` in the same `DOMContentLoaded` listener block where Linear listeners are registered.

**Implementation (immediately after line 4354 in `DOMContentLoaded` listener):**
```js
detailSubtasksList?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-clickup-subtask-id]');
    if (!button) {
        return;
    }
    loadClickUpTaskDetails(button.dataset.clickupSubtaskId);
});
```

**Edge Cases:** If `detailSubtasksList` is null (e.g., tab not rendered yet), the optional chaining `?.` prevents an error. The `loadClickUpTaskDetails` function (line 3671) already handles arbitrary task IDs because ClickUp's `getTaskDetails` API works for any task, including subtasks.

**Clarification:** The `detailSubtasksList` element is shared between Linear and ClickUp views. The existing Linear listener at line 4348 checks `[data-linear-subtask-id]`, and the new ClickUp listener checks `[data-clickup-subtask-id]`. Since the two attribute names are different, the listeners do not interfere. Both listeners fire on a click inside `detailSubtasksList`, but each will correctly no-op if the wrong button type is clicked.

## Verification Plan

### Automated Tests

No existing automated tests cover ClickUp/Linear subtask rendering. Add manual verification:

1. Open the ClickUp tab in the Switchboard sidebar.
2. Select a Space → Folder → List that contains tasks with subtasks.
3. Confirm the main card list shows **only parent tasks** (no subtask rows).
4. Click a parent task to open its detail view.
5. Confirm the **Subtasks** section lists each subtask as a clickable row.
6. Confirm the subtask display format is "Parent title: subtask title".
7. Click a subtask row — the detail view should reload to show that subtask's details.
8. Use the **BACK TO LIST** button to return to the parent task list.
9. Repeat steps 1-8 for the Linear tab to ensure consistency.

### Regression Tests

- Confirm the Linear tab subtask display and click behavior remain unaffected.
- Confirm status filter and search still work correctly on the parent task list.
- Confirm ClickUp task detail view renders correctly for tasks with no subtasks.
- Confirm the "Parent title: title" format displays correctly for both ClickUp and Linear tabs.

## Risks & Notes

- **CRITICAL BUG IDENTIFIED:** The `parentId` field is not being populated correctly in `_normalizeClickUpTask()` because ClickUp API returns the parent as an object with an `id` field (e.g., `{ id: "12345" }`), but the code treats it as a string. This causes the filter `!task.parentId` to fail, which is why subtasks still appear in the main list despite the filter being in place.
- The filter `tasks.filter(task => !task.parentId)` at line 4088 exists but is ineffective until the `parentId` population bug is fixed.
- **API parameter `subtasks=true`** in `getListTasks()` could optionally be removed to reduce payload size, but that is out of scope for this UI-only fix. Leaving it as-is is safe because the frontend filters subtasks out once the bug is fixed.
- The Linear tab already uses this exact pattern (`data-linear-subtask-id` + delegated click handler), so the ClickUp tab should follow it for consistency.
- **Parent title availability:** The parent task title is available in the `task` variable within `renderSidebarClickUpTaskDetail()`, so no additional API calls are needed to construct the "Parent title: title" format.

**Recommendation:** Execute Step 1 first (fix `parentId` population) to make the filter functional, then proceed with display format updates

---

## Review & Validation (Grumpy/Balanced)

### Stage 1: Grumpy Review (Adversarial)
* "Oh, look at you, adding a 'Parent title: title' format requirement after the fact. The original plan was fine—filter subtasks, make them clickable. Now you want to prefix the parent title too? Sure, the `task` variable is right there in scope, so it's trivial. But did you consider that the parent title might be very long, making the subtask list unreadable? Did you consider that the user might already know which parent they clicked into? No, you just want more context everywhere. Fine, it's harmless, but let's not pretend this is some groundbreaking UX insight.

BUT WAIT—you actually found the real bug. The `parentId` wasn't being populated because ClickUp returns an object, not a string. That's actually a legitimate bug to fix first, otherwise the filter is useless. Good catch. Now execute the plan in order." [NIT]

### Stage 2: Balanced Synthesis
* **What's good:** Identified the critical bug in `_normalizeClickUpTask()` where `parentId` isn't being populated correctly due to ClickUp API's object structure. The plan now prioritizes fixing this bug first (Step 1) before the display format changes. The filter at line 4088 exists but is ineffective until Step 1 is completed.
* **What needs fixing:** Execute Step 1 (fix `parentId` population) to make the filter functional, then implement the "Parent title: title" format for ClickUp subtask display (lines 4038–4042) and locate/update Linear subtask rendering for consistency.
* **Risks:** Long parent titles could make the subtask list harder to read. Consider truncating or styling the parent title differently if this becomes an issue.

### Validation Results
* **Files Changed:** None yet (plan only)
* **Status:** Plan updated to document the critical bug and prioritize the fix. No code changes applied.
* **Code Fixes Applied:** None (plan only)
* **Remaining Risks:** Need to execute Step 1 first to make the filter functional, then proceed with display format updates.
