# Reorganize Edit and Delete Layouts in Project Webview

**Plan ID:** d0f2159f-8fac-4db6-bd5c-5865eebb893b

## Metadata
**Complexity:** 3
**Tags:** ui, ux, frontend, refactor

## Goal
Improve layout usability and button placement consistency within the Kanban and Features tabs of the project webview interface.

### Core Problems & Analysis
- **Kanban Tab:** The general Edit button is located in the top nav bar / control strip. This requires the user to click a plan item in the sidebar list but then move their eyes and cursor to the top of the screen to start editing. Placing an "Edit" button directly inside the list item's action bar next to "Copy Prompt" matches the user's spatial focus.
- **Features Tab:** The "Edit" button is right-aligned (with Save/Cancel), while the destructive "Delete Feature" button is left-aligned with constructive actions ("Refine", "+ Subtask"). Destructive/high-risk actions should be isolated and placed to the far right, whereas editing/refinement controls should group naturally on the left.

## User Review Required
Yes — this is a visible UI layout change affecting two tabs. Confirm the proposed button groupings match the intended spatial model before coding:
- Kanban: per-item "Edit" next to "Copy Prompt" / "Copy Link" in the sidebar action row; top-bar Edit button removed entirely.
- Features: constructive cluster (Edit/Save/Cancel + Refine + Subtask) on the left; destructive "Delete Feature" isolated on the far right.

## Complexity Audit

### Routine
- CSS selector additions to style one new button class identically to existing action buttons.
- Inserting one `<button>` in an existing render loop next to sibling buttons that already use the same pattern.
- Reordering markup inside an existing `metaBar.innerHTML` template — no new elements, no new ids, no new wiring.
- Removing a single static button from the HTML controls strip.
- Removing now-dead `getElementById('btn-edit-kanban')` references (all already null-guarded, so behavior-safe).

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** The per-item Edit handler for an *unselected* plan sets `_pendingAutoEdit = true` then calls `loadKanbanPlanPreview(plan)`. Edit mode is entered only on the `kanbanPlanPreviewReady` callback (project.js ~611-613), after content has loaded — this reuses the existing auto-edit mechanism and avoids entering edit mode against stale/empty content. The handler calls `e.stopPropagation()` so the item-level click listener (which resets `_pendingAutoEdit = false`) does not fire and cancel the pending auto-edit. This matches the existing Copy Link / Copy Prompt stopPropagation pattern.
- **Security:** No new input handling, no eval, no message types added. No impact.
- **Side Effects:** Removing the top-level `btn-edit-kanban` removes its "disabled until preview ready" UX. This is **not a regression**: the gating is preserved because (a) for an unselected plan, edit mode is deferred until `kanbanPlanPreviewReady` via `_pendingAutoEdit`; (b) for an already-selected plan, the preview/content is already loaded so `enterEditMode('kanban')` is safe. Switching plans while the kanban editor is dirty calls `exitEditMode('kanban')` — this discards unsaved edits silently, but this is **inherited existing behavior** (the item click listener at project.js ~1573 does the same) and project policy forbids confirm dialogs.
- **Dependencies & Conflicts:** The Features restructure moves `btn-edit-features` into the left `manageGroup`. The hide-on-subtask logic at project.js ~312-313 (`getElementById('btn-edit-features')`) and the Save/Cancel/Edit wiring at ~2352-2357 are id-based and unaffected by which flex group the button lives in. The **subtask preview meta bar** (project.js ~2405-2414, the path that renders when a subtask is previewed) is a *separate* render path with its own Edit/Save/Cancel and its own Remove/Delete buttons — it is **out of scope** and must not be touched by this change. No backend, no message protocol, no state-shape changes.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) the original plan referenced a `renderKanbanPlanItem` function that does not exist in the codebase — following it verbatim would produce no edit; (2) removing the top-level Edit button leaves five dead `btn-edit-kanban` references that are behavior-safe (null-guarded) but must be cleaned up to avoid stale-code confusion; (3) the per-item Edit must rely on the existing `_pendingAutoEdit` + `kanbanPlanPreviewReady` flow rather than entering edit mode eagerly. Mitigations: corrected all insertion sites to the real `renderKanbanPlans()` forEach loop with exact line refs; listed every dead reference for removal; preserved the auto-edit gating so no content-race is introduced.

## Proposed Changes

> **Clarification (codebase drift):** The original plan referenced a function `renderKanbanPlanItem` at "around line 1565". That function does **not** exist. The real render site is the `filtered.forEach(plan => { ... })` loop inside `renderKanbanPlans()` (project.js ~1539-1577); line 1565 is the existing `Copy Prompt` button line inside that loop. The corrected locations below supersede the original references. All original code blocks and intent are preserved.

### 1. Style Changes
#### `src/webview/project.html`
- Remove the top-level Edit button `<button id="btn-edit-kanban" ...>Edit</button>` (around line 1153).
- Update the CSS selectors for plan action buttons (around line 394 and 402) to include `.kanban-plan-edit` so it is styled identically to `.kanban-plan-copy-prompt` and `.kanban-plan-copy-link` on hover and active states.

  Concrete edits:
  - Line ~394: change `.kanban-plan-copy-link, .kanban-plan-copy-prompt, .feature-card-action {` → `.kanban-plan-copy-link, .kanban-plan-copy-prompt, .kanban-plan-edit, .feature-card-action {`
  - Line ~402: change `.kanban-plan-copy-link:hover, .kanban-plan-copy-prompt:hover, .feature-card-action:hover {` → `.kanban-plan-copy-link:hover, .kanban-plan-copy-prompt:hover, .kanban-plan-edit:hover, .feature-card-action:hover {`

### 2. Logic Changes — Kanban Tab
#### `src/webview/project.js` (inside `renderKanbanPlans()`, the `filtered.forEach` loop ~1539-1577)
- Inside the loop that builds each `kanban-plan-item` (around line 1565), add:
  ```html
  ${plan.planFile ? `<button class="kanban-plan-edit">Edit</button>` : ''}
  ```
  next to the Copy Prompt button. (Edit is gated on `plan.planFile` — the file to edit — matching the existing `Copy Link` guard, not the `Copy Prompt` guard which uses `plan.sessionId`.)
- Wire up a click listener for the `.kanban-plan-edit` button in the same loop (alongside the `copyLinkBtn` / `copyPromptBtn` wiring at ~1580-1608):
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

### 3. Dead-Code Cleanup — Kanban Tab (required, since the top-level Edit button is removed)
#### `src/webview/project.js`
After removing `<button id="btn-edit-kanban">` from the HTML, the following references become dead (all are null-guarded, so they are behavior-safe, but must be removed to avoid stale-code confusion):
- Line ~219: remove `const btnEditKanban = document.getElementById('btn-edit-kanban');`
- Lines ~1949-1954: remove the `if (btnEditKanban) { btnEditKanban.addEventListener('click', () => { if (!_kanbanSelectedPlan) return; enterEditMode('kanban'); }); }` block.
- Lines ~609-610 (inside `kanbanPlanPreviewReady` handler): remove `const dynamicEditBtn = document.getElementById('btn-edit-kanban');` and `if (dynamicEditBtn) dynamicEditBtn.disabled = false;`. **Keep** the `if (_pendingAutoEdit) { _pendingAutoEdit = false; enterEditMode('kanban'); }` block immediately below — the new per-item Edit button depends on it.
- Lines ~702-703 (inside `kanbanPlanDeleted` handler): remove `const dynamicEditBtn = document.getElementById('btn-edit-kanban');` and `if (dynamicEditBtn) dynamicEditBtn.disabled = true;`.
- Line ~1847: remove/update the stale comment `// Edit button listener removed — btn-edit-kanban is now a static element in the controls strip`.

### 4. Logic Changes — Features Tab
#### `src/webview/project.js` — `renderFeatureMetaBar(plan)` (around lines 2295-2315)
- Restructure the markup so Edit/Save/Cancel join Refine and + Subtask on the left, and Delete Feature moves into a `margin-left: auto;` container on the right:
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
- **No wiring changes required.** The `isManageable` block (~2317-2350) wires Refine / + Subtask / Delete by id, and the Edit/Save/Cancel wiring (~2352-2357) is also id-based — all continue to resolve regardless of which flex group the buttons occupy.

## Verification Plan

### Automated Tests
None — per session directive, no automated tests and no project compilation are run. Verification is by manual UI inspection in the installed VSIX webview (the repo's `dist/` is not the source of truth for testing).

### Manual UI Checks
- **Kanban Tab:**
  - Verify "Edit" button is removed from the top controls strip.
  - Verify "Edit" button shows next to "Copy Prompt" on plan items that have a `planFile`.
  - Verify "Edit" does NOT show on plans without a `planFile`.
  - Click "Edit" on an unselected plan: verify it selects the plan and goes into edit mode automatically (after preview loads).
  - Click "Edit" on an already-selected plan: verify it goes into edit mode.
  - Confirm clicking "Edit" does not also trigger the item's plain-click handler (no double-select / no `_pendingAutoEdit` reset).
  - Confirm no console errors from dead `btn-edit-kanban` references (they should all be removed).
- **Features Tab:**
  - Verify "Edit", "Save"/"Cancel", "Refine", and "+ Subtask" are left-aligned.
  - Verify "Delete Feature" is right-aligned and isolated.
  - Verify that Edit/Save/Cancel state toggling still works (enter edit mode, save, cancel).
  - Verify Refine, + Subtask, and Delete Feature still fire their actions.
  - Verify the hide-`btn-edit-features` behavior when a subtask is previewed still works.
  - Confirm the **subtask preview** meta bar (separate render path) is unchanged.

## Recommendation
Complexity 3 → **Send to Intern**. All routine UI/CSS/markup work reusing existing patterns. The implementer must follow the **corrected** locations in this plan (the `renderKanbanPlans()` forEach loop, not the nonexistent `renderKanbanPlanItem`) and perform the dead-code cleanup in §3 alongside the button removal.
