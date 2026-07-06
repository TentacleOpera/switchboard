# Reorganize Edit and Delete Layouts in Project Webview

## Metadata
**Complexity:** 2
**Tags:** ui, ux, frontend

## Goal
Improve layout usability and button placement consistency within the Kanban and Features tabs of the project webview interface.

### Core Problems & Analysis
- **Kanban Tab:** The general Edit button is located in the top nav bar / control strip. This requires the user to click a plan item in the sidebar list but then move their eyes and cursor to the top of the screen to start editing. Placing an "Edit" button directly inside the list item's action bar next to "Copy Prompt" matches the user's spatial focus.
- **Features Tab:** The "Edit" button is right-aligned (with Save/Cancel), while the destructive "Delete Feature" button is left-aligned with constructive actions ("Refine", "+ Subtask"). Destructive/high-risk actions should be isolated and placed to the far right, whereas editing/refinement controls should group naturally on the left.

## Proposed Changes

### 1. Style Changes
#### `src/webview/project.html`
- Remove the top-level Edit button `<button id="btn-edit-kanban" ...>Edit</button>` (around line 1153).
- Update the CSS selectors for plan action buttons (around line 394 and 402) to include `.kanban-plan-edit` so it is styled identically to `.kanban-plan-copy-prompt` and `.kanban-plan-copy-link` on hover and active states.

### 2. Logic Changes
#### `src/webview/project.js`
- **Kanban Tab:**
  - Inside `renderKanbanPlanItem` (around line 1565), add:
    ```html
    ${plan.planFile ? `<button class="kanban-plan-edit">Edit</button>` : ''}
    ```
    next to the Copy Prompt button.
  - Wire up a click listener for the `.kanban-plan-edit` button:
    ```javascript
    const editBtn = itemDiv.querySelector('.kanban-plan-edit');
    if (editBtn) {
        editBtn.addEventListener('click', e => {
            e.stopPropagation();
            const isSelected = _kanbanSelectedPlan && _kanbanSelectedPlan.planId === plan.planId;
            if (!isSelected) {
                if (state.dirtyFlags.kanban) exitEditMode('kanban');
                document.querySelectorAll('.kanban-plan-item').forEach(el => el.classList.remove('selected'));
                itemDiv.classList.add('selected');
                _pendingAutoEdit = true;
                loadKanbanPlanPreview(plan);
            } else {
                enterEditMode('kanban');
            }
        });
    }
    ```
- **Features Tab:**
  - In `renderFeatureMetaBar` (around lines 2301-2315), restructure the markup to:
    - Group Edit, Save, and Cancel alongside Refine and + Subtask on the left.
    - Position Delete Feature inside a `margin-left: auto;` container on the right.
    ```javascript
    const manageGroup = `
        <div class="kanban-meta-group" style="display:flex; gap:6px;">
            <button class="strip-btn" id="btn-edit-features" style="${state.editMode.features ? 'display:none;' : ''}">Edit</button>
            <button class="strip-btn" id="btn-save-features" style="${state.editMode.features ? '' : 'display:none;'}">Save</button>
            <button class="strip-btn" id="btn-cancel-features" style="${state.editMode.features ? '' : 'display:none;'}">Cancel</button>
            <button class="strip-btn" id="btn-feature-refine" title="Refine this feature's description and propose a subtask breakdown — copies a prompt to the clipboard">Refine</button>
            <button class="strip-btn" id="btn-feature-add-subtask" title="Add an existing plan to this feature as a subtask">+ Subtask</button>
        </div>
    `;
    metaBar.innerHTML = `
        ${manageGroup}
        <div class="kanban-meta-group" style="margin-left: auto;">
            <button class="strip-btn" id="btn-feature-delete" style="color:#ff6b6b;" title="Delete this feature (subtasks are detached)">Delete Feature</button>
        </div>
    `;
    ```

## Verification Plan
- **Kanban Tab:**
  - Verify "Edit" button is removed from the top bar.
  - Verify "Edit" button shows next to "Copy Prompt" on plan items with files.
  - Click "Edit" on an unselected plan: verify it selects the plan and goes into edit mode automatically.
  - Click "Edit" on an already selected plan: verify it goes into edit mode.
- **Features Tab:**
  - Verify "Edit", "Refine", and "+ Subtask" are left-aligned.
  - Verify "Delete Feature" is right-aligned.
  - Verify that Edit/Save/Cancel state toggling still works.
