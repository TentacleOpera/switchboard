# project.html Kanban tab — reposition Edit button, AutoFetch modal, and fix Chat Prompt formatting

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
This is a layout/organization issue. The Edit button was placed in the meta bar because it's contextual to the selected plan. However, the user prefers it in the controls strip for easier access. The AutoFetch button is a configuration action (not plan-specific), so it makes more sense in the meta bar next to Log (which is also plan-specific config). The "CHAT PROMPT" all-caps text is inconsistent with other buttons in the controls strip which use mixed case ("Import", "Create", "AutoFetch").

## Metadata
- **Tags**: `project.html`, `project.js`, `kanban-tab`, `layout`, `edit-button`, `autofetch`, `chat-prompt`, `ui`
- **Complexity**: 4/10

## Complexity Audit
**Routine with moderate care.** The changes involve moving HTML elements between two areas and updating JS event listeners. The Edit button is currently dynamically created in the meta bar (project.js:1711) with event listeners attached after creation (project.js:1725-1729). Moving it to the static controls strip means it becomes a static element with a listener attached once at init. The AutoFetch button is already a static element in the controls strip (project.html:1498) with a listener at project.js:1835. Moving it to the meta bar means it becomes dynamically created. The edit-mode state management (`state.editMode.kanban`, `enterEditMode`, `exitEditMode`) must still work correctly from the new location.

## Edge-Case & Dependency Audit
- **Edit button visibility**: In the meta bar, Edit is shown/hidden based on `state.editMode.kanban` (project.js:1711: `style="${state.editMode.kanban ? 'display:none;' : ''}"`). In the controls strip, the Edit button should be disabled when no plan is selected (like the Create button is always enabled, but Edit needs a selected plan). The Edit button should be disabled by default and enabled when a plan is loaded.
- **Save/Cancel buttons**: These remain in the meta bar. They are shown when `state.editMode.kanban` is true. The Edit button in the controls strip should be hidden/disabled when in edit mode (since Save/Cancel are visible). This requires the meta bar render to communicate edit state to the controls strip Edit button.
- **AutoFetch in meta bar**: The AutoFetch button opens a modal (`autofetch-modal`, project.html:1741). The modal is a global element, so it works from either location. The button just needs an event listener. In the meta bar, it's dynamically created, so the listener must be attached after each render.
- **Chat Prompt formatting**: The button text "CHAT PROMPT" (project.html:1497) uses `text-transform` from the `strip-btn` class. Other buttons in the same strip ("Import", "Create") use mixed case. The `strip-btn` class may or may not apply `text-transform: uppercase`. Need to check the CSS.
- **Epics tab Edit button**: The epics tab also has an Edit button (project.js:2120, 2213) in its meta bar. This plan only addresses the Kanban tab Edit button. The epics Edit button should remain in the epics meta bar (the user only mentioned the Kanban tab).
- **`btn-edit-kanban` ID**: Currently dynamically created in the meta bar. If moved to the controls strip, it becomes a static element. The `getElementById('btn-edit-kanban')` calls in project.js (lines 588, 591, 679, 1725) must still find it. Since `getElementById` works on the whole document, this is fine — but the element must exist at the time of the calls. The calls at lines 588/591 are in the `kanbanPlanPreviewReady` handler which runs after plan load — the static element will exist. The call at line 679 is in the `activateKanbanTabAndSelectPlan` handler — also fine.

## Proposed Changes

### 1. `src/webview/project.html` — move Edit to controls strip, remove AutoFetch from controls strip, fix Chat Prompt text

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

// Add a static listener near the other controls-strip listeners (around line 1813):
const btnEditKanban = document.getElementById('btn-edit-kanban');
if (btnEditKanban) {
    btnEditKanban.addEventListener('click', () => enterEditMode('kanban'));
}
```

**Edit button enable/disable state:**
The static Edit button must be disabled when no plan is selected and enabled when a plan is loaded. Update the plan-load and meta-bar render logic:

```js
// In the kanbanPlanPreviewReady handler (project.js:588-589), update the static Edit button:
const dynamicEditBtn = document.getElementById('btn-edit-kanban');
if (dynamicEditBtn) dynamicEditBtn.disabled = false;

// When no plan is selected or on initial load, ensure Edit is disabled:
// Add to the meta bar render or a plan-deselection handler:
const editBtn = document.getElementById('btn-edit-kanban');
if (editBtn) editBtn.disabled = true;  // when no plan selected
```

**Edit button visibility in edit mode:**
When `state.editMode.kanban` is true, the Edit button should be hidden (Save/Cancel are visible). Update `enterEditMode` and `exitEditMode`:

```js
// In enterEditMode('kanban') — hide the static Edit button:
function enterEditMode(tab) {
    // ... existing logic ...
    if (tab === 'kanban') {
        const editBtn = document.getElementById('btn-edit-kanban');
        if (editBtn) editBtn.style.display = 'none';
    }
}

// In exitEditMode('kanban') — show the static Edit button:
function exitEditMode(tab) {
    // ... existing logic ...
    if (tab === 'kanban') {
        const editBtn = document.getElementById('btn-edit-kanban');
        if (editBtn) editBtn.style.display = '';
    }
}
```

**AutoFetch button (now dynamic in meta bar):**
```js
// Remove the static listener (project.js:1835-1841):
// const btnKanbanAutofetch = document.getElementById('btn-kanban-autofetch');
// if (btnKanbanAutofetch) { ... }

// Add a dynamic listener after meta bar render (near project.js:1784):
const dynamicAutofetchBtn = document.getElementById('kanban-meta-autofetch-btn');
if (dynamicAutofetchBtn) {
    dynamicAutofetchBtn.addEventListener('click', () => {
        const autofetchModal = document.getElementById('autofetch-modal');
        if (autofetchModal) autofetchModal.style.display = 'flex';
    });
}
```

### 4. `src/webview/project.html` — check/fix `strip-btn` text-transform for Chat Prompt

Check if `strip-btn` class applies `text-transform: uppercase`. If it does, the other buttons ("Import", "Create") would also be uppercase — but they appear as mixed case, so `strip-btn` likely does NOT force uppercase. The "CHAT PROMPT" text was likely manually uppercase. Changing it to "Chat Prompt" in the HTML (change #1) should be sufficient. If there's a specific CSS rule forcing uppercase on `#btn-chat-copy-prompt`, remove it.

```css
/* Check for and remove any rule like: */
/* #btn-chat-copy-prompt { text-transform: uppercase; } */
```

## Verification Plan
1. **Controls strip layout**: Open project.html, go to Kanban tab. Verify the controls strip shows: `... Import | Create | Edit | Chat Prompt | [search]`. Verify "Chat Prompt" is mixed case (not ALL CAPS). Verify no AutoFetch button in the controls strip.
2. **Edit button disabled state**: With no plan selected, verify the Edit button is disabled (greyed out). Select a plan. Verify Edit becomes enabled.
3. **Edit button enters edit mode**: Click Edit. Verify the editor enters edit mode (textarea visible, Save/Cancel buttons appear in meta bar). Verify the Edit button itself hides during edit mode.
4. **Exit edit mode**: Click Cancel or Save. Verify the Edit button reappears in the controls strip.
5. **AutoFetch in meta bar**: Select a plan. Verify the meta bar shows `⚙ AutoFetch` next to Log. Click it. Verify the AutoFetch modal opens.
6. **AutoFetch modal functionality**: In the modal, toggle the enable checkbox, click "Fetch now". Verify it works as before.
7. **Chat Prompt button**: Click "Chat Prompt". Verify the planning prompt is copied to clipboard (same behavior as before, just different label).
8. **Epics tab unaffected**: Switch to the Epics tab. Verify the Epics Edit button is still in the epics meta bar (unchanged).
9. **No console errors**: Open DevTools. Verify no errors about missing `btn-kanban-autofetch` or duplicate `btn-edit-kanban` IDs.
