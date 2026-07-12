# Add Edit Button to Kanban Meta Bar in Project.html

## Goal

The Edit button for kanban plans only appears on the sidebar plan item, forcing the user to locate the plan in the sidebar to edit it. The Copy Link and Copy Prompt buttons were already promoted to the top meta bar (`renderKanbanMetaBar`), but Edit was not. The Edit button should be in the meta bar too, matching the pattern of the Features, Constitution, System, and Projects tabs which all have `btn-edit-<tab>` in their top bars.

### Problem Analysis & Root Cause

**Current state:**
- The kanban meta bar (`renderKanbanMetaBar` in project.js, line 1800) renders: Column, Complexity, Copy Link, Copy Prompt, Save, Cancel, Upload, AutoFetch, Log, Delete.
- There is **no Edit button** in the meta bar.
- The Edit button only exists on the sidebar plan item (line ~1574: `<button class="kanban-plan-edit">Edit</button>`).
- The `enterEditMode('kanban')` function (line 2939) already looks for `btn-edit-kanban` (line 2942) — it just doesn't exist in the DOM.
- The sidebar Edit button calls `enterEditMode('kanban')` directly, which works because `btnEdit` is null and the function proceeds without it (the `if (btnEdit) btnEdit.style.display = 'none'` is a no-op).

**Why it matters:** When the user selects a plan (card is selected, preview loaded), they should be able to click Edit from the meta bar without scrolling the sidebar to find the plan item. This is especially important given the sibling sidebar-scroll bug — if the user can't find the card in the sidebar, they can't edit it at all.

### Background Context

The Features tab has this pattern already (line ~2322):
```html
<button class="strip-btn" id="btn-edit-features" style="${state.editMode.features ? 'display:none;' : ''}">Edit</button>
<button class="strip-btn" id="btn-save-features" style="${state.editMode.features ? '' : 'display:none;'}">Save</button>
<button class="strip-btn" id="btn-cancel-features" style="${state.editMode.features ? '' : 'display:none;'}">Cancel</button>
```

The Constitution, System, and Projects tabs all follow the same pattern with `btn-edit-<tab>`, `btn-save-<tab>`, `btn-cancel-<tab>`.

The kanban meta bar already has `btn-save-kanban` and `btn-cancel-kanban` (lines 1831-1832) with the same show/hide logic, and `enterEditMode`/`exitEditMode` (lines 2939/2986) already toggle a `btn-edit-${tab}` element if present. Adding `btn-edit-kanban` completes the pattern with no changes to the edit/exit functions.

## Metadata
**Tags:** feature, ui, frontend
**Complexity:** 2
**Project:** switchboard

## User Review Required

Straightforward pattern completion. No behavioral surprises expected. Confirm the meta-bar placement (before Save/Cancel in the right-aligned group) reads well against the existing button order.

## Complexity Audit

### Routine
- Single-file frontend change (`src/webview/project.js`).
- Adds one button element and one click listener; reuses the existing `enterEditMode('kanban')` and the existing `btn-edit-${tab}` show/hide logic already present in `enterEditMode`/`exitEditMode`.
- Directly mirrors four existing tabs (Features, Constitution, System, Projects).

### Complex / Risky
- None.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The listener is re-attached on every `renderKanbanMetaBar` call (same lifecycle as the existing Copy Link / Copy Prompt / Save / Cancel listeners), so there is no stale-handler or double-fire risk.
- **Security:** None.
- **Side Effects:** None beyond the intended edit-mode toggle. The button is only rendered when a plan is selected and has a `planFile`, so it cannot fire without a valid edit target.
- **Dependencies & Conflicts:** Depends on `enterEditMode('kanban')` and the `kanban-editor` textarea existing (they do). No conflict with the sidebar Edit button — both call the same function and toggle the same `state.editMode.kanban`. When `enterEditMode` runs, it hides `btn-edit-kanban` and shows Save/Cancel; `exitEditMode` reverses it — so the two entry points stay visually consistent automatically.

## Dependencies

- None.

## Proposed Changes

### `src/webview/project.js` — `renderKanbanMetaBar` (button markup, line ~1831)

**Context:** The right-aligned meta group (line 1830 `<div class="kanban-meta-group" style="margin-left: auto;">`) currently starts with `btn-save-kanban` / `btn-cancel-kanban`. There is no Edit button.

**Logic:** Add an Edit button as the first control in that group, gated on `plan.planFile` (matching the sidebar Edit button and the meta-bar Copy Link button, which are both `plan.planFile`-gated), and hidden while already in edit mode (matching the Features-tab pattern).

**Implementation** (insert immediately before the `btn-save-kanban` button at line 1831):
```javascript
${plan.planFile ? `<button class="strip-btn" id="btn-edit-kanban" style="${state.editMode.kanban ? 'display:none;' : ''}">Edit</button>` : ''}
```

**Edge Cases:**
- No plan selected → meta bar hidden entirely (`renderKanbanMetaBar` only runs with a plan) → Edit button absent. Correct.
- Plan with no `planFile` (e.g. a brain-only entry) → Edit button omitted, matching the sidebar behavior. Correct.

### `src/webview/project.js` — `renderKanbanMetaBar` (listener wiring, line ~1844)

**Context:** Dynamic button listeners are attached right after `metaBar.innerHTML = ...` (line 1844 onward), the same place Copy Link / Copy Prompt / Save / Cancel are wired.

**Logic:** Attach a click listener that calls `enterEditMode('kanban')`.

**Implementation** (add alongside the other dynamic-button listeners):
```javascript
const dynamicEditBtn = document.getElementById('btn-edit-kanban');
if (dynamicEditBtn) {
    dynamicEditBtn.addEventListener('click', () => enterEditMode('kanban'));
}
```

**Edge Cases:**
- `getElementById` returns null when `plan.planFile` was falsy → the `if` guard no-ops. Correct.

### `enterEditMode` / `exitEditMode` — no change required

Both functions already query `btn-edit-${tab}` (lines 2942/2988) and toggle its `display` (lines 2978/2994). Adding the element to the DOM activates that existing logic automatically. **No edit to these functions.**

## Verification Plan

> Session directive: automated tests and compilation are **not** run as part of this planning pass. The steps below are for the implementer.

### Automated Tests
- No existing automated test targets `renderKanbanMetaBar` (DOM-coupled webview code). Manual verification below is the primary gate; add a DOM-harness assertion for "Edit button present when `plan.planFile` truthy, absent otherwise" only if a webview test harness already exists.

### Manual Verification
1. Select a plan in the project panel Kanban tab → Edit button appears in the meta bar.
2. Click Edit → editor textarea appears; Edit hides, Save/Cancel show.
3. Click Cancel → editor hides; Edit reappears.
4. Click Edit, make a change, click Save → content saves.
5. Select a plan with no `planFile` → Edit button does **not** appear.
6. Confirm the sidebar Edit button still works independently and leaves the meta bar in a consistent state.
7. When `autoEdit: true` fires (from plan creation), the meta-bar Edit button is hidden and Save/Cancel are shown (because `enterEditMode` runs).

## Recommendation

**Send to Intern** (complexity 2). Localized, single-file, pure pattern completion with no behavioral risk.

## Completion Report

Added `btn-edit-kanban` to the kanban meta bar in `src/webview/project.js`, placed before Save/Cancel in the right-aligned group. Wired a click listener that calls `enterEditMode('kanban')`. The existing `enterEditMode`/`exitEditMode` show/hide logic automatically toggles the new button. `eslint src/webview/project.js` passed. No compilation or tests were run per the session SKIP directives. No issues encountered.
