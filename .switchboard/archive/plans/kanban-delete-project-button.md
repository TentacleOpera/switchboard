# Plan: Add Delete Project Button to Kanban Function Bar

## Goal
Make the existing hidden delete-project button permanently visible in the kanban function bar, using `disabled` state (not `display:none`) to indicate when deletion is unavailable, and add a confirmation dialog to prevent accidental data loss.

## Metadata
- **Tags:** [frontend, UI, UX]
- **Complexity:** 3

## User Review Required
- None

## Complexity Audit

### Routine
- Remove `style="display:none;"` from HTML button and add `disabled` attribute
- Change existing `style.display` toggle in dropdown change handler to `disabled` toggle
- Add `window.confirm()` to click handler (matches existing pattern used for assign, autoban reset, kanban defaults)
- Add button state update at end of `updateWorkspaceProjectDropdown()`

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The delete button state is derived synchronously from the dropdown's current selection. The backend `deleteProject` handler (KanbanProvider.ts:4188-4202) clears `_projectFilter` if it matches, invalidates cache, and refreshes the board — all sequential.
- **Security:** The backend already guards: `if (workspaceRoot && typeof msg.projectName === 'string')` (line 4190). The click handler already guards: `if (!selectedProject) return;` (line 3063). Adding `disabled` is a UX guard, not a security boundary.
- **Side Effects:** Deleting a project clears the `project` field on all associated plans (KanbanDatabase.ts:2046: `UPDATE plans SET project = '' WHERE workspace_id = ? AND project = ?`). This is irreversible — hence the confirmation dialog.
- **Dependencies & Conflicts:** The `updateWorkspaceProjectDropdown()` function rebuilds `select.innerHTML` (line 3265), which can change the selected option without firing a `change` event. The button state must be updated at the end of this function, not only in the change handler.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The existing change handler uses `style.display` to show/hide the button — switching to `disabled` requires updating both the change handler and the dropdown rebuild function to avoid stale state. (2) No confirmation dialog exists for delete, but every other destructive action in the kanban uses `window.confirm()` — omitting it would be inconsistent and risky. Mitigations: Modify existing handlers in-place rather than adding parallel logic; add confirmation dialog matching existing patterns.

## Proposed Changes

### `src/webview/kanban.html` — HTML (line 1945)

**Context:** The delete button exists in the function bar but is hidden via inline `style="display:none;"`. It sits immediately after the add-project button.

**Current (line 1945):**
```html
<button id="btn-delete-project" class="strip-btn" title="Delete selected project" style="display:none;">DELETE PROJECT</button>
```

**Target:**
```html
<button id="btn-delete-project" class="strip-btn" data-tooltip="Select a project to delete" disabled>🗑</button>
```

**Implementation:**
- Remove `style="display:none;"` — button is always visible
- Add `disabled` attribute — button starts disabled (no project selected on load)
- Change `title` to `data-tooltip` for consistency with adjacent buttons
- Change text from "DELETE PROJECT" to 🗑 icon — pairs visually with the `+` add-project button (class `btn-add-plan`) next to it
- Set initial tooltip to "Select a project to delete" (disabled state)

### `src/webview/kanban.html` — Dropdown change handler (lines 5557-5588)

**Context:** The `workspace-project-select` change handler already detects whether a project is selected via `selectedOption.dataset.project`. It currently toggles `style.display` on the delete button.

**Current (lines 5583-5587):**
```javascript
// Update delete button visibility
const btnDeleteProject = document.getElementById('btn-delete-project');
if (btnDeleteProject) {
    btnDeleteProject.style.display = selectedProject ? '' : 'none';
}
```

**Target:**
```javascript
// Update delete button state
const btnDeleteProject = document.getElementById('btn-delete-project');
if (btnDeleteProject) {
    btnDeleteProject.disabled = !selectedProject;
    btnDeleteProject.setAttribute('data-tooltip', selectedProject ? 'Delete selected project' : 'Select a project to delete');
}
```

**Implementation:**
- Replace `style.display` toggle with `disabled` toggle
- Update tooltip based on state (enabled: "Delete selected project", disabled: "Select a project to delete")

### `src/webview/kanban.html` — Delete click handler (lines 3058-3065)

**Context:** The click handler sends a `deleteProject` message. It already guards against no project (`if (!selectedProject) return;`). No confirmation dialog exists.

**Current (lines 3058-3065):**
```javascript
btnDeleteProject?.addEventListener('click', () => {
    const select = document.getElementById('workspace-project-select');
    const selectedOption = select?.selectedOptions?.[0];
    const selectedProject = selectedOption?.dataset?.project;
    const workspaceRoot = selectedOption?.dataset?.workspaceRoot || currentWorkspaceRoot;
    if (!selectedProject) return;
    postKanbanMessage({ type: 'deleteProject', projectName: selectedProject, workspaceRoot });
});
```

**Target:**
```javascript
btnDeleteProject?.addEventListener('click', () => {
    const select = document.getElementById('workspace-project-select');
    const selectedOption = select?.selectedOptions?.[0];
    const selectedProject = selectedOption?.dataset?.project;
    const workspaceRoot = selectedOption?.dataset?.workspaceRoot || currentWorkspaceRoot;
    if (!selectedProject) return;
    if (!confirm(`Delete project "${selectedProject}"?\n\nAll plans in this project will have their project assignment cleared.`)) return;
    postKanbanMessage({ type: 'deleteProject', projectName: selectedProject, workspaceRoot });
});
```

**Implementation:**
- Add `window.confirm()` before sending the message, matching the pattern used for assign (line 5526), autoban reset (line 6392), and kanban defaults (line 6648)
- Message includes the project name and explains the side effect (plans lose their project assignment)

### `src/webview/kanban.html` — `updateWorkspaceProjectDropdown()` (lines 3257-3328)

**Context:** This function rebuilds the dropdown options from scratch. It can change the selected option without firing a `change` event, which means the delete button state could become stale.

**Implementation:**
Add the following block at the end of `updateWorkspaceProjectDropdown()`, after the selection-restore logic (after line 3327, before the closing `}`):

```javascript
// Sync delete button state after dropdown rebuild
const delBtn = document.getElementById('btn-delete-project');
if (delBtn) {
    const currentOption = select.selectedOptions?.[0];
    const hasProject = !!(currentOption?.dataset?.project);
    delBtn.disabled = !hasProject;
    delBtn.setAttribute('data-tooltip', hasProject ? 'Delete selected project' : 'Select a project to delete');
}
```

**Edge Cases:**
- If `select` has no options (empty workspaceItems), `select.selectedOptions[0]` is undefined → `hasProject = false` → button stays disabled. Correct.
- If `explicitRoot` path returns early (line 3304), the button state won't be updated. Fix: add the same block before that `return` statement as well (after line 3303).

### CSS — No changes needed

The existing `.strip-btn:disabled` rule at line 192-195 already provides:
```css
.strip-btn:disabled,
.strip-btn.is-teal:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}
```
This is sufficient for the disabled visual state.

## Verification Plan

### Automated Tests
- N/A (webview UI change, no automated test infrastructure for webview)

### Manual Verification Checklist
- [ ] Delete button appears next to add-project button on page load
- [ ] Button is disabled (greyed out, cursor: not-allowed) when dropdown shows "All Projects"
- [ ] Button is enabled when a specific project is selected
- [ ] Button tooltip updates: "Select a project to delete" (disabled) / "Delete selected project" (enabled)
- [ ] Clicking enabled button shows confirmation dialog with project name
- [ ] Confirming dialog deletes the project and refreshes the board
- [ ] Canceling dialog does nothing
- [ ] After deletion, button returns to disabled state (dropdown resets to "All Projects")
- [ ] Button state is correct after workspace switch (which rebuilds dropdown)
- [ ] Clicking disabled button does nothing (no dialog, no action)

## Recommendation
Complexity 3 → **Send to Intern**

## Overview
Add a dedicated delete project button next to the add project button in the kanban function bar. The button should be disabled (greyed out) when no specific project is selected (e.g., when dropdown shows "Switchboard > All Projects").

## Current State
The delete project button already exists in the HTML but is hidden:
```html
<button id="btn-delete-project" class="strip-btn" title="Delete selected project" style="display:none;">DELETE PROJECT</button>
```

## Target State
- Show the delete project button permanently (remove `style="display:none;"`)
- Position it immediately after the add project button
- Disable the button when no project is selected (dropdown shows "All Projects" or similar)
- Enable the button when a specific project is selected
- Add confirmation dialog before deletion

## Implementation Details

### 1. HTML Structure Changes
File: `src/webview/kanban.html` (line 1945)

**Current:**
```html
<button class="btn-add-plan" id="btn-add-project" data-tooltip="Add new project">+</button>
<button id="btn-delete-project" class="strip-btn" title="Delete selected project" style="display:none;">DELETE PROJECT</button>
```

**Target:**
```html
<button class="btn-add-plan" id="btn-add-project" data-tooltip="Add new project">+</button>
<button id="btn-delete-project" class="strip-btn" data-tooltip="Select a project to delete" disabled>🗑</button>
```

**Changes:**
- Remove `style="display:none;"` to show the button
- Change button text from "DELETE PROJECT" to 🗑 icon — pairs visually with the `+` add-project button
- Add `disabled` attribute initially (will be toggled via JavaScript)
- Update `title` to `data-tooltip` for consistency
- Set initial tooltip to disabled-state message

### 2. JavaScript Changes

**A. Modify existing dropdown change handler (lines 5583-5587)**

Replace `style.display` toggle with `disabled` toggle:

```javascript
// Update delete button state
const btnDeleteProject = document.getElementById('btn-delete-project');
if (btnDeleteProject) {
    btnDeleteProject.disabled = !selectedProject;
    btnDeleteProject.setAttribute('data-tooltip', selectedProject ? 'Delete selected project' : 'Select a project to delete');
}
```

**B. Add button state sync to `updateWorkspaceProjectDropdown()` (after line 3327)**

```javascript
// Sync delete button state after dropdown rebuild
const delBtn = document.getElementById('btn-delete-project');
if (delBtn) {
    const currentOption = select.selectedOptions?.[0];
    const hasProject = !!(currentOption?.dataset?.project);
    delBtn.disabled = !hasProject;
    delBtn.setAttribute('data-tooltip', hasProject ? 'Delete selected project' : 'Select a project to delete');
}
```

Also add the same block before the early `return` at line 3304.

**C. Add confirmation dialog to click handler (lines 3058-3065)**

```javascript
btnDeleteProject?.addEventListener('click', () => {
    const select = document.getElementById('workspace-project-select');
    const selectedOption = select?.selectedOptions?.[0];
    const selectedProject = selectedOption?.dataset?.project;
    const workspaceRoot = selectedOption?.dataset?.workspaceRoot || currentWorkspaceRoot;
    if (!selectedProject) return;
    if (!confirm(`Delete project "${selectedProject}"?\n\nAll plans in this project will have their project assignment cleared.`)) return;
    postKanbanMessage({ type: 'deleteProject', projectName: selectedProject, workspaceRoot });
});
```

### 3. CSS Changes
No changes needed — `.strip-btn:disabled` already provides `opacity: 0.4; cursor: not-allowed;` (line 192-195).

## Files to Modify
1. `src/webview/kanban.html` — HTML structure (line 1945: remove `display:none`, add `disabled`, update attributes)
2. `src/webview/kanban.html` — JavaScript (lines 3058-3065: add confirmation dialog; lines 5583-5587: switch to `disabled` toggle; lines 3303-3304 and 3327: add button state sync)

## Testing Checklist
- [ ] Verify delete button appears next to add project button
- [ ] Verify button is disabled when dropdown shows "All Projects" or similar
- [ ] Verify button is enabled when a specific project is selected
- [ ] Verify button tooltip updates based on state
- [ ] Verify confirmation dialog appears when clicking enabled button
- [ ] Verify delete functionality works when confirmed
- [ ] Verify delete is blocked when button is disabled
- [ ] Verify visual feedback (opacity, cursor) on disabled state
- [ ] Verify button state is correct after workspace switch rebuilds dropdown


## Execution & Review

### Stage 1: Grumpy Principal Engineer Review
- **[NIT] Semantic HTML / Native Controls:** The `🗑` emoji is fine for a quick visual fix, but it is raw text inside a `<button>`. Given we have established SVG icons or dedicated classes for other controls, this might feel a bit unpolished, though acceptable in a pinch. The `disabled` state handles the safety natively which is good.
- **[NIT] Boilerplate Repetition:** The button state sync logic in `updateWorkspaceProjectDropdown` is duplicated twice—once before the early return and once at the end. It is only 5 lines of code, but the repetition is slightly annoying.
- **[NIT] Synchronous Confirm:** Using `window.confirm()` halts the webview execution. While we do this everywhere else in this app (as the plan correctly notes), it is still technically a bad pattern for modern UI. But consistency wins here.

### Stage 2: Balanced Synthesis
- **What to keep:** The logic is rock-solid. Disabling the button when there is no project selected and enabling it when one is present handles the primary safety constraint cleanly.
- **What to fix now:** Nothing. The plan has already been perfectly implemented in the target repository (`src/webview/kanban.html`).
- **What to defer:** Extracting the delete button toggle into a helper function to avoid repeating it. Replacing `window.confirm()` with a custom modal. These are out of scope for a Complexity 3 task and would break consistency with the current codebase.

### Validation Results
- Verified that `src/webview/kanban.html` contains the correct target HTML (`<button id="btn-delete-project" ... disabled>🗑</button>`).
- Verified that the `change` handler and `updateWorkspaceProjectDropdown` function contain the correct disabled-toggling logic.
- Verified that the `btnDeleteProject` click handler contains the `window.confirm()` call to prevent accidental deletion.
- Code fixes applied: None required (already fully implemented in the file).
- Tests/Typechecks: Skipped per instructions.
