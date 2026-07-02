# project.html Kanban tab — reposition Edit button, AutoFetch modal, and fix Chat Prompt formatting

**Plan ID:** b8d2a3f1-4c5e-4f6b-a0c7-8e9f0a1b3d4e

## Goal

### Problem
In project.html's Kanban tab, three layout/labeling issues need fixing:
1. The **Edit** button is currently next to the **Log** button (in the meta bar). It needs to be next to the **Chat Prompt** button (in the controls strip) instead.
2. The **AutoFetch** modal/button is currently next to the **Chat Prompt** button (in the controls strip). It needs to be next to the **Log** button (in the meta bar) instead.
3. The **Chat Prompt** button text is in ALL CAPS ("CHAT PROMPT"). It should have the same formatting as other buttons (mixed case: "Chat Prompt").

In other words: the Edit button and AutoFetch button need to **swap places** — Edit moves to the controls strip next to Chat Prompt, AutoFetch moves to the meta bar next to Log. And Chat Prompt loses its all-caps styling.

### Background
The project.html Kanban tab has two button areas:
- **Controls strip** (project.html:1478-1500): Contains workspace/project/column/complexity filters, Import, Create, Chat Prompt, AutoFetch, and search. This is the top toolbar.
- **Meta bar** (project.js:1710-1721): Dynamically rendered per selected plan. Contains Edit/Save/Cancel, Upload (conditional), Log, Delete. This is the preview header.

Currently:
- Controls strip order: `... Import | Create | CHAT PROMPT | ⚙ AutoFetch | [search]`
- Meta bar order: `... Edit | Save | Cancel | [Upload] | Log | Delete`

The user wants:
- Controls strip order: `... Import | Create | Edit | Chat Prompt | [search]` (AutoFetch removed, Edit added)
- Meta bar order: `... Save | Cancel | [Upload] | ⚙ AutoFetch | Log | Delete` (Edit removed, AutoFetch added)

### Root Cause
This is a layout/organization issue. The Edit button was placed in the meta bar because it's contextual to the selected plan. However, the user prefers it in the controls strip for easier access. The AutoFetch button is a configuration action (not plan-specific), so it makes more sense in the meta bar next to Log (which is also plan-specific config). The "CHAT PROMPT" all-caps text is inconsistent with other buttons in the controls strip which use mixed case ("Import", "Create", "AutoFetch"). The `strip-btn` CSS class (lines 177-194) does NOT apply `text-transform: uppercase` — the all-caps text was manually typed in the HTML at line 1497.

## Metadata
- **Tags:** frontend, ui, refactor
- **Complexity:** 4

## User Review Required

No — this is a straightforward layout fix with clear before/after states. The user explicitly specified the desired button positions.

## Complexity Audit

### Routine
- Moving HTML elements between two static areas (controls strip in project.html, meta bar template in project.js)
- Updating JS event listeners (removing dynamic listener, adding static listener; removing static listener, adding dynamic listener)
- Changing button text from "CHAT PROMPT" to "Chat Prompt"

### Complex / Risky
- **Edit button always-visible state management** — Moving Edit from the dynamic meta bar (only visible when a plan is selected) to the static controls strip (always visible) means the Edit button is now visible even when no plan is selected. The button must be `disabled` when no plan is selected to prevent `enterEditMode('kanban')` from running with stale `_kanbanSelectedPlan` state. The existing `enterEditMode` function (line 2728) checks `if (!previewPane || !textarea) return` but does NOT check whether a plan is actually selected — the preview pane and textarea are static elements that always exist. A null guard on `_kanbanSelectedPlan` is needed in the Edit button click handler.

## Edge-Case & Dependency Audit

- **Edit button visibility**: In the meta bar, Edit is shown/hidden based on `state.editMode.kanban` (project.js:1711: `style="${state.editMode.kanban ? 'display:none;' : ''}"`). In the controls strip, the Edit button should be disabled when no plan is selected. The Edit button should be disabled by default and enabled when a plan is loaded.
- **Save/Cancel buttons**: These remain in the meta bar. They are shown when `state.editMode.kanban` is true. The existing `enterEditMode` function (line 2767) does `const btnEdit = document.getElementById('btn-edit-${tab}')` and sets `btnEdit.style.display = 'none'`. Since `btn-edit-kanban` is now a static element, `getElementById` will find it and hide it during edit mode. The existing `exitEditMode` (line 2783) sets `btnEdit.style.display = ''` to show it again. **No modifications to `enterEditMode`/`exitEditMode` are needed** — they already handle the static element correctly via `getElementById('btn-edit-${tab}')`.
- **AutoFetch in meta bar**: The AutoFetch button opens a modal (`autofetch-modal`, project.html:1741). The modal is a global element, so it works from either location. The button just needs an event listener. In the meta bar, it's dynamically created, so the listener must be attached after each render. The existing `openAutofetchModal()` function (project.js:1839) is reused — it references the modal by ID and does not depend on the trigger button.
- **Chat Prompt formatting**: The button text "CHAT PROMPT" (project.html:1497) is manually uppercase in the HTML. The `strip-btn` class does NOT apply `text-transform: uppercase` (verified: lines 177-194, no such property). There is no inline `style="text-transform: uppercase"` on the button (verified: line 1497). Changing it to "Chat Prompt" in the HTML is sufficient.
- **Epics tab Edit button**: The epics tab also has an Edit button (project.js:2120, 2213) in its meta bar. This plan only addresses the Kanban tab Edit button. The epics Edit button should remain in the epics meta bar (the user only mentioned the Kanban tab).
- **`btn-edit-kanban` ID**: Currently dynamically created in the meta bar. If moved to the controls strip, it becomes a static element. The `getElementById('btn-edit-kanban')` calls in project.js (lines 588, 591, 679, 1725) must still find it. Since `getElementById` works on the whole document, this is fine — but the element must exist at the time of the calls. The calls at lines 588/591 are in the `kanbanPlanPreviewReady` handler which runs after plan load — the static element will exist. The call at line 679 is in the `kanbanPlanDeleted` handler — also fine.
- **⚠️ ID COLLISION WARNING**: The meta bar template at project.js:1711 currently includes `<button class="strip-btn" id="btn-edit-kanban" ...>Edit</button>`. This line MUST be removed from the template string. If it is not removed, there will be TWO elements with `id="btn-edit-kanban"` — `getElementById` returns the first (the static one), but the dynamic one in the meta bar is a ghost that captures no events. ENSURE the `btn-edit-kanban` line is removed from the meta bar template string at project.js:1711.

## Dependencies

- None — this is a self-contained layout fix with no cross-plan dependencies.

## Adversarial Synthesis

Key risks: (1) making Edit always-visible in the controls strip means it can be clicked when no plan is selected, calling `enterEditMode` with stale `_kanbanSelectedPlan` state — mitigated by adding a null guard in the click handler; (2) ID collision if the meta bar template line for `btn-edit-kanban` is not removed — mitigated by explicit warning in the plan. The proposed `enterEditMode`/`exitEditMode` modifications are redundant (the existing functions already handle the static element via `getElementById`) and have been removed to simplify.

## Proposed Changes

### 1. `src/webview/project.html` — move Edit to controls strip, remove AutoFetch from controls strip, fix Chat Prompt text

**File:** `src/webview/project.html` (lines 1495-1499)

```html
<!-- BEFORE (lines 1495-1499) -->
<button id="btn-import-kanban-plans" class="strip-btn" title="Scan configured AI IDE folders and pick unclaimed plans to add">Import</button>
<button id="btn-create-kanban-plan" class="strip-btn" title="Create a new plan">Create</button>
<button id="btn-chat-copy-prompt" class="strip-btn" title="Copy general chat planning prompt to clipboard">CHAT PROMPT</button>
<button id="btn-kanban-autofetch" class="strip-btn" title="Configure auto-fetch of plans from the default branch">⚙ AutoFetch</button>
<input type="text" id="kanban-search" class="sidebar-search-input" placeholder="Search plans..." />

<!-- AFTER -->
<button id="btn-import-kanban-plans" class="strip-btn" title="Scan configured AI IDE folders and pick unclaimed plans to add">Import</button>
<button id="btn-create-kanban-plan" class="strip-btn" title="Create a new plan">Create</button>
<button id="btn-edit-kanban" class="strip-btn" disabled title="Edit the selected plan">Edit</button>
<button id="btn-chat-copy-prompt" class="strip-btn" title="Copy general chat planning prompt to clipboard">Chat Prompt</button>
<input type="text" id="kanban-search" class="sidebar-search-input" placeholder="Search plans..." />
```

Note: `btn-edit-kanban` is now a static element (moved from dynamic meta bar). `btn-kanban-autofetch` is removed from the controls strip (it will be dynamically created in the meta bar instead). "CHAT PROMPT" → "Chat Prompt".

### 2. `src/webview/project.js` — remove Edit button from meta bar, add AutoFetch to meta bar

**File:** `src/webview/project.js` (lines 1710-1721)

⚠️ **ID COLLISION WARNING**: The `btn-edit-kanban` line MUST be removed from this template string. If left in, there will be two elements with the same ID.

```js
// BEFORE (project.js:1710-1721)
<div class="kanban-meta-group" style="margin-left: auto;">
    <button class="strip-btn" id="btn-edit-kanban" style="${state.editMode.kanban ? 'display:none;' : ''}">Edit</button>
    <button class="strip-btn" id="btn-save-kanban" style="${state.editMode.kanban ? '' : 'display:none;'}">Save</button>
    <button class="strip-btn" id="btn-cancel-kanban" style="${state.editMode.kanban ? '' : 'display:none;'}">Cancel</button>
    ${plan.clickupTaskId || plan.linearIssueId ? `
        <button class="strip-btn" id="kanban-meta-upload-btn" ${uploadingPlanAttachment ? 'disabled' : ''}>
            ${uploadingPlanAttachment ? 'Uploading...' : 'Upload'}
        </button>
    ` : ''}
    <button class="strip-btn" id="kanban-meta-log-btn">Log</button>
    <button class="strip-btn" id="kanban-meta-delete-btn">Delete</button>
</div>

// AFTER
<div class="kanban-meta-group" style="margin-left: auto;">
    <button class="strip-btn" id="btn-save-kanban" style="${state.editMode.kanban ? '' : 'display:none;'}">Save</button>
    <button class="strip-btn" id="btn-cancel-kanban" style="${state.editMode.kanban ? '' : 'display:none;'}">Cancel</button>
    ${plan.clickupTaskId || plan.linearIssueId ? `
        <button class="strip-btn" id="kanban-meta-upload-btn" ${uploadingPlanAttachment ? 'disabled' : ''}>
            ${uploadingPlanAttachment ? 'Uploading...' : 'Upload'}
        </button>
    ` : ''}
    <button class="strip-btn" id="kanban-meta-autofetch-btn" title="Configure auto-fetch of plans from the default branch">⚙ AutoFetch</button>
    <button class="strip-btn" id="kanban-meta-log-btn">Log</button>
    <button class="strip-btn" id="kanban-meta-delete-btn">Delete</button>
</div>
```

### 3. `src/webview/project.js` — update event listeners for moved buttons

**Edit button (now static in controls strip):**
```js
// Remove the dynamic listener attachment (project.js:1725-1729):
// const dynamicEditBtn = document.getElementById('btn-edit-kanban');
// if (dynamicEditBtn) dynamicEditBtn.addEventListener('click', () => enterEditMode('kanban'));

// Add a static listener near the other controls-strip listeners (around line 1813, after btnCreateKanbanPlan listener):
const btnEditKanban = document.getElementById('btn-edit-kanban');
if (btnEditKanban) {
    btnEditKanban.addEventListener('click', () => {
        // Guard: don't enter edit mode if no plan is selected (the button is always
        // visible in the controls strip, unlike the old meta bar placement).
        if (!_kanbanSelectedPlan) return;
        enterEditMode('kanban');
    });
}
```

**Edit button enable/disable state:**
The static Edit button must be disabled when no plan is selected and enabled when a plan is loaded. The existing handlers already do this — they just need to find the static element:

```js
// In the kanbanPlanPreviewReady handler (project.js:588-589), the existing code already does:
const dynamicEditBtn = document.getElementById('btn-edit-kanban');
if (dynamicEditBtn) dynamicEditBtn.disabled = false;
// This now finds the static controls-strip button. No change needed — the variable name
// is misleading but the behavior is correct.

// In the kanbanPlanDeleted handler (project.js:679-680), the existing code already does:
const dynamicEditBtn = document.getElementById('btn-edit-kanban');
if (dynamicEditBtn) dynamicEditBtn.disabled = true;
// This now finds the static controls-strip button. No change needed.
```

**Edit button visibility in edit mode:**
The existing `enterEditMode` (line 2767) does `const btnEdit = document.getElementById('btn-edit-${tab}')` and `if (btnEdit) btnEdit.style.display = 'none'`. When `tab === 'kanban'`, this finds the static controls-strip button and hides it. The existing `exitEditMode` (line 2783) sets `btnEdit.style.display = ''` to show it again. **No modifications to `enterEditMode`/`exitEditMode` are needed** — they already handle the static element correctly.

**AutoFetch button (now dynamic in meta bar):**
```js
// Remove the static listener (project.js:1835-1848):
// const btnKanbanAutofetch = document.getElementById('btn-kanban-autofetch');
// ...
// if (btnKanbanAutofetch) {
//     btnKanbanAutofetch.addEventListener('click', openAutofetchModal);
// }

// NOTE: The openAutofetchModal() function (line 1839) and closeAutofetchModal() (line 1842)
// are standalone functions that reference the modal by ID. They are REUSED — not redefined.
// The btn-close-autofetch-modal listener (line 1849) also stays as-is.

// Add a dynamic listener after meta bar render (near project.js:1784, after the upload button listener):
const dynamicAutofetchBtn = document.getElementById('kanban-meta-autofetch-btn');
if (dynamicAutofetchBtn) {
    dynamicAutofetchBtn.addEventListener('click', openAutofetchModal);
}
```

### 4. `src/webview/project.html` — Chat Prompt text fix (no CSS change needed)

The `strip-btn` class (lines 177-194) does NOT apply `text-transform: uppercase`. There is no inline `style="text-transform: uppercase"` on the button (line 1497). There is no CSS rule targeting `#btn-chat-copy-prompt` with `text-transform`. The "CHAT PROMPT" text was manually uppercase in the HTML. Changing it to "Chat Prompt" in the HTML (change #1) is the only fix needed.

## Verification Plan

### Automated Tests
- No automated tests required (per session directives — test suite run separately by user).

### Manual Verification
1. **Controls strip layout**: Open project.html, go to Kanban tab. Verify the controls strip shows: `... Import | Create | Edit | Chat Prompt | [search]`. Verify "Chat Prompt" is mixed case (not ALL CAPS). Verify no AutoFetch button in the controls strip.
2. **Edit button disabled state**: With no plan selected, verify the Edit button is disabled (greyed out). Select a plan. Verify Edit becomes enabled.
3. **Edit button enters edit mode**: Click Edit. Verify the editor enters edit mode (textarea visible, Save/Cancel buttons appear in meta bar). Verify the Edit button itself hides during edit mode.
4. **Exit edit mode**: Click Cancel or Save. Verify the Edit button reappears in the controls strip.
5. **Edit button null guard**: With no plan selected (Edit disabled), verify clicking Edit does nothing (button is disabled, click handler bails on null `_kanbanSelectedPlan`).
6. **AutoFetch in meta bar**: Select a plan. Verify the meta bar shows `⚙ AutoFetch` next to Log. Click it. Verify the AutoFetch modal opens.
7. **AutoFetch modal functionality**: In the modal, toggle the enable checkbox, click "Fetch now". Verify it works as before.
8. **Chat Prompt button**: Click "Chat Prompt". Verify the planning prompt is copied to clipboard (same behavior as before, just different label).
9. **Epics tab unaffected**: Switch to the Epics tab. Verify the Epics Edit button is still in the epics meta bar (unchanged).
10. **No console errors**: Open DevTools. Verify no errors about missing `btn-kanban-autofetch` or duplicate `btn-edit-kanban` IDs.

## Recommendation

Complexity 4 → **Send to Coder**. Single-file-pair layout fix with clear before/after states. The only moderate risk is the always-visible Edit button state management, which is handled by the null guard.
