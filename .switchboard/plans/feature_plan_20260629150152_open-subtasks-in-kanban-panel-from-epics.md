# Show Subtask Controls in Epics Panel Meta Bar When Subtask Is Previewed

## Goal

When a user clicks a subtask link in the project.html **Epics panel**, the subtask's content is previewed in the epics preview pane — but with no management controls. Instead of switching to the Kanban tab (which would be disorienting), render a **subtask-specific control strip** in the existing `#epic-preview-meta-bar` with just **Complexity, Edit, and Delete** controls. This keeps the user in context while giving them the essential subtask management actions.

### Core problem & background

The project.html Epics panel has a preview pane with a metadata bar (`#epic-preview-meta-bar`, `project.html:1497`) that is controlled by `renderEpicMetaBar(plan)` (`project.js:1794`). When an **epic** is selected, this bar shows epic-level controls: Orchestrate, + Subtask, Delete Epic, Edit/Save/Cancel.

When a **subtask** is clicked (`project.js:1878-1897`), the current code:
1. Loads the subtask's markdown into the epics preview pane
2. Hides the Edit button (`project.js:1895-1896`)
3. Does NOT update the meta bar — so the epic's controls (Orchestrate, + Subtask, Delete Epic) remain visible and act on the epic, not the subtask

This is confusing: the preview shows a subtask, but the controls above it still target the parent epic. The user sees a subtask with no relevant controls (Edit is hidden) and epic controls that don't apply to what they're viewing.

The Kanban panel solves this correctly: `renderKanbanMetaBar(plan)` (`project.js:1399-1507`) renders a full control bar with column dropdown, complexity, edit/save/cancel, log, and delete — all targeting the selected plan. The epics panel needs a similar but lighter approach: when a subtask is previewed, swap the meta bar to show subtask controls (complexity, edit, delete) that target the subtask, not the epic.

### Root cause

The subtask click handler (`project.js:1878-1897`) sets `_epicPreviewFilePath` and fetches the preview content, but never calls `renderEpicMetaBar` with the subtask's plan data. It only hides the Edit button, leaving the rest of the epic's meta bar intact. There is no concept of "subtask preview mode" in the meta bar — it always renders epic controls.

The fix is to:
1. Track when a subtask is being previewed (vs. an epic)
2. When a subtask is clicked, look up the subtask's plan in `_kanbanPlansCache` by `planFile`
3. Render a subtask-specific meta bar (complexity dropdown, edit, delete) targeting the subtask
4. When the user clicks back on the epic card, `selectEpic` already calls `renderEpicMetaBar` with the epic, restoring epic controls
5. Guard `selectEpic` to exit edit mode first — prevents data loss if the user was editing a subtask and switches back to an epic
6. Fix the `saveFileContentResult` handler so saving a subtask doesn't bounce the user back to the epic view

## Metadata

- **Tags:** [frontend, ui, feature]
- **Complexity:** 4

## User Review Required

Yes — review the `saveFileContentResult` handler change (Proposed Change #6) and the `selectEpic` edit-mode guard (Proposed Change #4). Both address data-loss risks discovered during adversarial review that were not in the original plan.

## Complexity Audit

### Routine
- Adding a `_epicSubtaskPreview` flag (or reusing `_epicPreviewFilePath !== _epicSelectedPlan?.planFile` as the discriminator) to track subtask preview mode.
- Modifying the subtask click handler (`project.js:1878-1897`) to look up the subtask plan in `_kanbanPlansCache` and call a new `renderEpicSubtaskMetaBar(plan)` function.
- Writing `renderEpicSubtaskMetaBar(plan)` — a slimmed-down version of `renderKanbanMetaBar` that renders only complexity, edit, and delete, but into `#epic-preview-meta-bar` and wired to the epics editor (`epicsEditor`).
- Mirroring the complexity dropdown toggle pattern from `renderKanbanMetaBar` (`project.js:1485-1498`).
- Mirroring the delete button pattern from `renderKanbanMetaBar` (`project.js:1504-1506`).
- Adding `exitEditMode('epics')` guard at the top of `selectEpic` to prevent data loss when switching from subtask edit mode to an epic.

### Complex / Risky
- **Edit/Save targeting the subtask file, not the epic file:** The existing `renderEpicMetaBar` save handler (`project.js:1846-1859`) saves to `_epicSelectedPlan.planFile`. When a subtask is being previewed, save must target `_epicPreviewFilePath` instead. The new `renderEpicSubtaskMetaBar` must wire its Save button to use `_epicPreviewFilePath`.
- **Save result handler bounces back to epic view:** The `saveFileContentResult` handler for `tab === 'epics'` (`project.js:860-867`) calls `selectEpic(_epicSelectedPlan)` after a successful save. When saving a subtask, this would replace the subtask preview with the epic's preview and swap the subtask meta bar for epic controls — disorienting the user. The handler must check `_epicSubtaskPreview` and re-fetch the subtask preview instead of calling `selectEpic`.
- **Data loss when switching epics during subtask edit mode:** If the user clicks Edit on a subtask (entering edit mode with subtask content in the editor), then clicks an epic card, `selectEpic` re-renders the meta bar with epic controls (Save targeting the epic file) but the editor still contains subtask content. Clicking Save would overwrite the epic file with subtask content. The `exitEditMode('epics')` guard in `selectEpic` prevents this.
- **Preview content routing:** The `kanbanPlanPreviewReady` handler (`project.js:459-468`) already routes content to the epics pane when `_epicPreviewFilePath === msg.filePath`. This works for both epic and subtask previews — no change needed.
- **Restoring epic controls:** When the user clicks back on the epic card in the list, `selectEpic(plan)` (`project.js:1776-1792`) already calls `renderEpicMetaBar(plan)`, which will overwrite the subtask meta bar with epic controls. With the added `exitEditMode` guard, this also safely discards any in-progress subtask edit.
- **Subtask not in kanban cache:** If the subtask's plan file isn't in `_kanbanPlansCache` (e.g., it was never imported into kanban), we can't look up its `planId` or `complexity`. In this case, render the meta bar with Edit only (complexity and delete require a planId). The preview content still loads correctly from the file path.

## Edge-Case & Dependency Audit

- **Subtask has no plan file:** The current handler already checks for this (`project.js:1882-1885`) and shows a toast. This check must be preserved.
- **Subtask plan not in cache:** Fall back to showing Edit only (no complexity dropdown, no delete button). The preview content still renders from the file. This is a graceful degradation — the user can still read and edit the subtask.
- **Edit mode active when subtask is clicked:** The current handler exits edit mode before previewing (`project.js:1886`). This must be preserved — entering subtask preview should exit epic edit mode first.
- **Save while subtask is being previewed:** Save must target `_epicPreviewFilePath` (the subtask file), not `_epicSelectedPlan.planFile` (the epic file). The new `renderEpicSubtaskMetaBar` wires its own Save handler to use `_epicPreviewFilePath`. After save, the `saveFileContentResult` handler must detect `_epicSubtaskPreview` is non-null and re-fetch the subtask preview (not bounce to the epic).
- **Switching to an epic while editing a subtask:** `selectEpic` must call `exitEditMode('epics')` first to discard the subtask edit and prevent the editor content (subtask) from being saved to the epic file via the epic's Save button.
- **Delete subtask from epics panel:** Delete sends `deleteKanbanPlan` (same message type as the kanban panel, `project.js:1504-1506`). After delete, clear the preview pane and reset the meta bar. The epic's subtask list should refresh — the backend's `deleteKanbanPlan` handler already triggers a kanban refresh, which sends `kanbanPlansReady`, which calls `renderEpicsList()` (`project.js:407`), which re-renders the subtask list without the deleted subtask.
- **Complexity change does not live-refresh the subtask meta bar:** After changing complexity via the dropdown, the backend triggers a kanban refresh (`kanbanPlansReady` → `renderEpicsList()`), but the subtask meta bar is not re-rendered. The complexity dot/label in the meta bar will be stale until the user clicks the subtask again. This is a minor cosmetic issue — the actual complexity is updated in the DB and will be correct on next render. No fix needed for this plan; a follow-up could re-render the meta bar on `kanbanPlansReady` if `_epicSubtaskPreview` is non-null.
- **Markdown link interceptor in epic content:** There is a second click handler at `project.js:234-306` that intercepts `<a>` clicks within `epicsPreviewContent` (cross-references inside the epic's markdown body). This handler also previews in the epics pane but is for inline links, not subtask list links. The scope of this plan is limited to the **subtask list links** (`.epic-subtask-link`). The markdown body links should continue to preview in-place without the subtask meta bar — they are content cross-references, not managed subtasks. If desired, a follow-up plan can extend the subtask meta bar to markdown body links that resolve to known plan files.
- **No confirmation dialogs** (house rule, `CLAUDE.md`): Delete executes immediately, same as the kanban panel's delete button. No `confirm()` gate.
- **Dependencies:** None. No other plan blocks or is blocked by this.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) the `saveFileContentResult` handler for `tab: 'epics'` calls `selectEpic()` after save, which would bounce the user from subtask view back to the epic — fixed by checking `_epicSubtaskPreview`; (2) switching to an epic while editing a subtask leaves the editor with subtask content but the Save button targeting the epic file — fixed by adding `exitEditMode('epics')` guard in `selectEpic`. Both are data-loss/UX risks that the original plan missed. Mitigations are frontend-only, single-file changes following existing patterns.

## Proposed Changes

### 1. `src/webview/project.js` — add `_epicSubtaskPreview` state variable

Near the existing epic state variables (`project.js:167-169`), add:

```javascript
let _epicSubtaskPreview = null; // holds the subtask plan object when a subtask is previewed in the epics pane
```

### 2. `src/webview/project.js` — add `renderEpicSubtaskMetaBar(plan)` function

Add a new function after `renderEpicMetaBar` (after line 1861). This is a slimmed-down version of `renderKanbanMetaBar` that renders into `#epic-preview-meta-bar` with only complexity, edit, and delete:

```javascript
function renderEpicSubtaskMetaBar(plan) {
    const metaBar = document.getElementById('epic-preview-meta-bar');
    if (!metaBar) return;
    metaBar.style.display = 'flex';

    const complexityClass = _complexityToCssClass(plan ? plan.complexity : null);
    const complexityLabel = escapeHtml((plan && plan.complexity) || 'Unknown');
    const hasPlanId = plan && plan.planId;

    const complexityGroup = hasPlanId ? `
        <div class="kanban-meta-group">
            <span class="kanban-meta-label">Complexity:</span>
            <span class="complexity-dot ${complexityClass}"></span>
            <span class="kanban-meta-value" id="epic-subtask-meta-complexity">${complexityLabel}</span>
            <select class="kanban-meta-dropdown" id="epic-subtask-meta-complexity-select" style="display:none;" data-plan-id="${escapeHtml(plan.planId)}" data-workspace-root="${escapeHtml(plan.workspaceRoot || '')}">
                ${['Unknown', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map(v => `<option value="${v}" ${v === (plan.complexity || 'Unknown') ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
        </div>
    ` : '';

    const deleteBtn = hasPlanId ? `<button class="strip-btn" id="epic-subtask-meta-delete-btn" style="color:#ff6b6b;">Delete</button>` : '';

    metaBar.innerHTML = `
        <div class="kanban-meta-group">
            <span class="kanban-meta-label" style="color: var(--text-secondary); font-style: italic;">Subtask</span>
        </div>
        ${complexityGroup}
        <div class="kanban-meta-group" style="margin-left: auto;">
            <button class="strip-btn" id="btn-edit-epics" style="${state.editMode.epics ? 'display:none;' : ''}">Edit</button>
            <button class="strip-btn" id="btn-save-epics" style="${state.editMode.epics ? '' : 'display:none;'}">Save</button>
            <button class="strip-btn" id="btn-cancel-epics" style="${state.editMode.epics ? '' : 'display:none;'}">Cancel</button>
            ${deleteBtn}
        </div>
    `;

    // Edit / Save / Cancel — target _epicPreviewFilePath (the subtask file), not the epic
    const btnEdit = document.getElementById('btn-edit-epics');
    const btnCancel = document.getElementById('btn-cancel-epics');
    const btnSave = document.getElementById('btn-save-epics');
    if (btnEdit) btnEdit.addEventListener('click', () => enterEditMode('epics'));
    if (btnCancel) btnCancel.addEventListener('click', () => exitEditMode('epics'));
    if (btnSave) btnSave.addEventListener('click', () => {
        const filePath = _epicPreviewFilePath;
        const content = epicsEditor ? epicsEditor.value : '';
        const originalContent = state.editOriginalContent.epics;
        if (filePath) {
            vscode.postMessage({
                type: 'saveFileContent',
                filePath,
                content,
                originalContent,
                tab: 'epics'
            });
        }
    });

    // Complexity dropdown toggle (mirror kanban pattern, project.js:1485-1498)
    if (hasPlanId) {
        const compToggle = document.getElementById('epic-subtask-meta-complexity');
        const compSelect = document.getElementById('epic-subtask-meta-complexity-select');
        if (compToggle && compSelect) {
            compToggle.addEventListener('click', e => {
                e.stopPropagation();
                compSelect.style.display = 'block';
                compSelect.focus();
            });
            compSelect.addEventListener('change', () => {
                compSelect.style.display = 'none';
                vscode.postMessage({ type: 'setKanbanPlanComplexity', planId: compSelect.dataset.planId, complexity: compSelect.value, workspaceRoot: compSelect.dataset.workspaceRoot });
            });
            compSelect.addEventListener('blur', () => setTimeout(() => compSelect.style.display = 'none', 200));
        }

        // Delete (mirror kanban pattern, project.js:1504-1506)
        const delBtn = document.getElementById('epic-subtask-meta-delete-btn');
        if (delBtn) delBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'deleteKanbanPlan', planId: plan.planId, planFile: plan.planFile, workspaceRoot: plan.workspaceRoot });
            _epicSubtaskPreview = null;
            _epicPreviewFilePath = _epicSelectedPlan ? _epicSelectedPlan.planFile : null;
            if (epicsPreviewContent) epicsPreviewContent.innerHTML = '<div class="kanban-empty-state">Select an epic to preview</div>';
            if (_epicSelectedPlan) renderEpicMetaBar(_epicSelectedPlan);
            else metaBar.style.display = 'none';
        });
    }
}
```

### 3. `src/webview/project.js` — modify subtask click handler to render subtask meta bar

In `renderEpicSubtasks`, replace the subtask link click handler (lines 1878-1897):

**Current code** (`project.js:1878-1897`):
```javascript
subtasksDiv.querySelectorAll('.epic-subtask-link').forEach(link => {
    link.addEventListener('click', e => {
        e.stopPropagation();
        const planFile = link.dataset.planFile;
        if (!planFile) {
            showToast('This subtask has no plan file to preview.', 'error');
            return;
        }
        if (state.editMode.epics) exitEditMode('epics');
        _epicPreviewFilePath = planFile;
        if (epicsPreviewContent) epicsPreviewContent.innerHTML = '<div class="kanban-empty-state">Loading preview...</div>';
        vscode.postMessage({
            type: 'fetchKanbanPlanPreview',
            filePath: planFile,
            requestId: ++_kanbanPreviewRequestId
        });
        // Hide the Edit button while a subtask is previewed
        const btnEdit = document.getElementById('btn-edit-epics');
        if (btnEdit) btnEdit.style.display = 'none';
    });
});
```

**Replace with:**
```javascript
subtasksDiv.querySelectorAll('.epic-subtask-link').forEach(link => {
    link.addEventListener('click', e => {
        e.stopPropagation();
        const planFile = link.dataset.planFile;
        if (!planFile) {
            showToast('This subtask has no plan file to preview.', 'error');
            return;
        }
        if (state.editMode.epics) exitEditMode('epics');
        _epicPreviewFilePath = planFile;
        // Look up the subtask plan in the kanban cache for metadata (complexity, planId)
        _epicSubtaskPreview = _kanbanPlansCache.find(p => p.planFile === planFile) || { planFile, planId: '', workspaceRoot: '', complexity: 'Unknown' };
        renderEpicSubtaskMetaBar(_epicSubtaskPreview);
        if (epicsPreviewContent) epicsPreviewContent.innerHTML = '<div class="kanban-empty-state">Loading preview...</div>';
        vscode.postMessage({
            type: 'fetchKanbanPlanPreview',
            filePath: planFile,
            requestId: ++_kanbanPreviewRequestId
        });
    });
});
```

### 4. `src/webview/project.js` — reset subtask preview and exit edit mode when epic is reselected

In `selectEpic` (`project.js:1776-1792`), add an edit-mode guard and clear the subtask preview state. The `exitEditMode` guard prevents data loss: if the user was editing a subtask (editor contains subtask content) and clicks an epic, the epic's Save button would otherwise save subtask content to the epic file.

**Current code** (`project.js:1776-1778`):
```javascript
function selectEpic(plan) {
    _epicSelectedPlan = plan;
    _epicPreviewFilePath = plan.planFile || null;
```

**Replace with:**
```javascript
function selectEpic(plan) {
    if (state.editMode.epics) exitEditMode('epics');
    _epicSelectedPlan = plan;
    _epicPreviewFilePath = plan.planFile || null;
    _epicSubtaskPreview = null;
```

### 5. No backend changes required

All message types used by the new subtask meta bar (`fetchKanbanPlanPreview`, `saveFileContent`, `setKanbanPlanComplexity`, `deleteKanbanPlan`) already exist and are handled by `PlanningPanelProvider.ts` (`src/services/PlanningPanelProvider.ts:2975`, `:3066`, `:3113`, `:3928`). The backend doesn't know or care whether the request originates from the kanban tab or the epics tab — it operates on `planId` / `planFile` / `workspaceRoot`.

### 6. `src/webview/project.js` — fix `saveFileContentResult` handler for subtask saves

The existing `saveFileContentResult` handler for `tab === 'epics'` (`project.js:860-867`) calls `selectEpic(_epicSelectedPlan)` after a successful save. When the user saved a **subtask** (not the epic), this bounces them back to the epic view — replacing the subtask preview with the epic's preview and swapping the subtask meta bar for epic controls. The handler must check `_epicSubtaskPreview` and re-fetch the subtask preview instead.

**Current code** (`project.js:860-867`):
```javascript
} else if (msg.tab === 'epics') {
    exitEditMode('epics');
    if (msg.renamedFilePath && _epicSelectedPlan) {
        _epicSelectedPlan.planFile = msg.renamedFilePath;
    }
    if (_epicSelectedPlan) selectEpic(_epicSelectedPlan);
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    vscode.postMessage({ type: 'fetchEpicDocuments' });
}
```

**Replace with:**
```javascript
} else if (msg.tab === 'epics') {
    exitEditMode('epics');
    if (msg.renamedFilePath && _epicSelectedPlan) {
        _epicSelectedPlan.planFile = msg.renamedFilePath;
    }
    if (_epicSubtaskPreview) {
        // Saved a subtask from the epics panel — re-fetch the subtask preview,
        // don't bounce back to the epic view.
        if (msg.renamedFilePath) {
            _epicPreviewFilePath = msg.renamedFilePath;
            _epicSubtaskPreview.planFile = msg.renamedFilePath;
        }
        if (epicsPreviewContent) epicsPreviewContent.innerHTML = '<div class="kanban-empty-state">Loading preview...</div>';
        vscode.postMessage({
            type: 'fetchKanbanPlanPreview',
            filePath: _epicPreviewFilePath,
            requestId: ++_kanbanPreviewRequestId
        });
        renderEpicSubtaskMetaBar(_epicSubtaskPreview);
    } else {
        if (_epicSelectedPlan) selectEpic(_epicSelectedPlan);
    }
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    vscode.postMessage({ type: 'fetchEpicDocuments' });
}
```

## Verification Plan

### Automated Tests

Automated tests are skipped per session directive. The test suite will be run separately by the user.

### Manual Verification

1. Open the project panel in VS Code (Switchboard extension).
2. Navigate to the Epics tab.
3. Select an epic that has subtasks.
4. **Verify:** The epic meta bar shows epic controls (Orchestrate, + Subtask, Delete Epic, Edit).
5. Click a subtask link in the subtask list.
6. **Verify:** The subtask's markdown content loads in the preview pane.
7. **Verify:** The meta bar updates to show "Subtask" label, Complexity dropdown, Edit, and Delete — not the epic controls.
8. Click the complexity value, change it in the dropdown.
9. **Verify:** The complexity change is sent (the complexity dot/label updates after the next kanban refresh; the meta bar may show stale value until re-click — see Edge-Case note).
10. Click Edit, modify the content, click Save.
11. **Verify:** The save targets the subtask file (not the epic file). The preview reloads with the updated subtask content (not the epic). The subtask meta bar remains visible (not replaced by epic controls).
12. Click Delete.
13. **Verify:** The subtask is deleted, the preview pane clears, and the epic's subtask list refreshes without the deleted subtask.
14. Click back on the epic card in the list.
15. **Verify:** The meta bar restores epic controls (Orchestrate, + Subtask, Delete Epic, Edit).
16. Click a subtask that has no plan file (if one exists).
17. **Verify:** A toast error appears and no preview/meta-bar change occurs.
18. Click a subtask whose plan is not in the kanban DB (planFile exists but no planId).
19. **Verify:** The meta bar shows Edit only (no complexity dropdown, no delete button). The preview content still loads.
20. **Data loss guard:** Click a subtask, click Edit, modify content, then click back on the epic card (without saving).
21. **Verify:** Edit mode is exited, the epic loads cleanly, and the editor does NOT contain subtask content. The epic's Save button targets the epic file (not the subtask file).

## Code Review Results (Reviewer Pass)

### Stage 1: Adversarial Findings

| # | Severity | File:Line | Finding |
|---|----------|-----------|---------|
| 1 | **CRITICAL** | `src/webview/project.js:1874` | `renderEpicMetaBar` missing closing brace. The original code had two `}` after the `if (btnSaveEpics)` block — one for the `if`, one for the function. The implementation kept only one, causing `renderEpicSubtaskMetaBar` and every subsequent function to be **nested inside** `renderEpicMetaBar` as a closure. The entire file failed to parse (`node -c` → `SyntaxError: Unexpected token ')'` at the IIFE close, line 2771). The webview would load as a blank pane. |
| 2 | **MAJOR** | `src/webview/project.js:876` | `vscode.postMessage({ type: 'fetchEpicDocuments' });` was silently dropped from the `saveFileContentResult` epics handler. The original code had it; the plan's replacement code explicitly includes it (plan lines 301-302). Without it, the epic documents list goes stale after saving an epic or subtask. |
| 3 | NIT | `src/webview/project.js:1953` | Delete button handler wrapped in an extra `if (delBtn) { ... }` guard not present in the plan. Harmless defensive null-check; deviates from plan but not worth changing. |

### Stage 2: Balanced Synthesis

- **Fix #1 (CRITICAL):** Added the missing `}` to close `renderEpicMetaBar` before `renderEpicSubtaskMetaBar`. This restores the function as a sibling at the IIFE level, not a nested closure. Without this fix, the feature is completely non-functional and the entire webview is broken.
- **Fix #2 (MAJOR):** Restored the `vscode.postMessage({ type: 'fetchEpicDocuments' });` call at the end of the epics save handler. This prevents the epic documents list from going stale after a save.
- **Finding #3 (NIT):** Deferred — the extra null guard is harmless.

### Fixes Applied

1. `src/webview/project.js:1875` — Added missing `}` to close `renderEpicMetaBar` function.
2. `src/webview/project.js:877` — Restored `vscode.postMessage({ type: 'fetchEpicDocuments' });` to the epics `saveFileContentResult` handler.

### Validation Results

- **Syntax check (`node -c src/webview/project.js`):** PASS (exit code 0). Before fixes: FAIL (`SyntaxError: Unexpected token ')'` at line 2771).
- **Brace structure verification:** `renderEpicSubtaskMetaBar` is now a sibling of `renderEpicMetaBar` at the IIFE scope level (depth=1), not nested inside it (depth=2).
- **Compilation:** Skipped per session directive.
- **Automated tests:** Skipped per session directive.

### Remaining Risks

- **Complexity staleness after change:** As noted in the Edge-Case audit (plan line 67), changing complexity via the dropdown does not live-refresh the subtask meta bar. The complexity value in the DB is correct; the meta bar shows stale value until the subtask is re-clicked. This is a known cosmetic limitation, not a regression.
- **Markdown body links:** Cross-reference links inside the epic's markdown body (intercepted by the handler at `project.js:234-306`) still preview in-place without the subtask meta bar. This is by design (plan line 68) — they are content cross-references, not managed subtasks.
- **Manual verification steps 1-21 not yet executed:** The syntax is verified, but the full manual UX flow (clicking subtasks, editing, saving, deleting) should be run by the user in a live VS Code instance.
