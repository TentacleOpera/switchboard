# Fix Subtask Card Styling to Match Parent Cards

## Goal
Make subtask cards in the ClickUp/Linear sidebar visually and functionally identical to parent task cards — white text, title/status structure, and REFINE/IMPORT buttons.

## Metadata
**Tags:** [frontend, UI, bugfix]
**Complexity:** 4

## User Review Required
- Confirm that subtask REFINE/IMPORT should use `includeSubtasks: false` (import only the subtask itself, not its nested subtasks)
- Confirm that clicking subtask card body (outside buttons) should still navigate to subtask detail view

## Complexity Audit

### Routine
- CSS text color change (split `.project-detail-item` out of shared selector)
- Adding `.project-detail-item-title` and `.project-detail-item-status` CSS rules
- Restructuring Linear subtask HTML from `<button>` to `<div>` with title/status divs
- Restructuring ClickUp subtask HTML from `<button>` to `<div>` with title/status divs (already has `<span>` classes, just changing element type)
- Adding REFINE/IMPORT button HTML matching existing parent card pattern

### Complex / Risky
- Event handler rewrite: must use single listener + `lastIntegrationProvider` branching to avoid double-fire bug (two separate listeners on same element both fire for same click)
- Correct field name mapping: extension expects `issueId` for Linear, `taskId` for ClickUp — mismatch causes silent failure
- Must preserve `data-linear-subtask-id` / `data-clickup-subtask-id` on outer `<div>` for "click to view details" navigation

## Edge-Case & Dependency Audit

- **Race Conditions**: Original plan's two separate `click` listeners on `detailSubtasksList` would both fire for the same click event. `event.stopPropagation()` prevents propagation to *parent* elements but does NOT prevent other listeners on the *same* element from firing. A single listener with `lastIntegrationProvider` branching (matching the parent card pattern at line 4500) eliminates this.
- **Security**: All user-supplied data (subtask titles, descriptions, IDs) are already escaped via `escapeHtml()` and `escapeAttr()` — no new XSS surface.
- **Side Effects**: Changing `<button>` to `<div>` removes native button semantics (keyboard focus, Enter/Space activation). Subtask cards are primarily mouse-driven in this webview, but adding `role="button"` and `tabindex="0"` preserves accessibility if desired. Low priority given existing patterns.
- **Dependencies & Conflicts**: The extension-side handler in `TaskViewerProvider.ts` (lines 7400-7403, 7789-7795) expects specific field names — `issueId` for Linear, `taskId` for ClickUp. The `workspaceRoot` parameter is required for both import and refine operations. The `includeSubtasks` parameter defaults to `true` in the extension; for subtask-level imports, `false` is more appropriate.

## Dependencies
- None — this is a self-contained single-file change

## Adversarial Synthesis
Key risks: (1) Double-fire from two listeners on same element sending conflicting messages — mitigated by using single listener + `lastIntegrationProvider` pattern. (2) Wrong field names (`taskId` vs `issueId`) causing silent Linear refine/import failure — mitigated by matching extension-side handler signatures. (3) Lost subtask navigation from missing `data-*-subtask-id` attributes on outer `<div>` — mitigated by preserving these attributes.

## Proposed Changes

### File: `src/webview/implementation.html`

#### Change 1: Fix CSS for subtask card text color
**Location**: Line 453-461
**Context**: `.project-detail-item` is grouped with other selectors using `var(--text-secondary)`. Splitting it out allows subtask cards to use white text while keeping other elements grey.
**Current**:
```css
.project-issue-meta,
.project-task-meta,
.project-task-description,
.project-detail-item {
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.5;
    font-family: var(--font-mono);
}
```

**New**:
```css
.project-issue-meta,
.project-task-meta,
.project-task-description {
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.5;
    font-family: var(--font-mono);
}

.project-detail-item {
    font-size: 11px;
    color: var(--text-primary);
    line-height: 1.5;
    font-family: var(--font-mono);
}
```
**Edge Cases**: The `.project-detail-item` class is also used for attachments (line 3658) and comments (line 4275). Comments already have their own color overrides via `.project-detail-item-author`, `.project-detail-item-date`, `.project-detail-item-body`. Attachments use `.project-detail-item-link` which has its own color. The base `var(--text-primary)` change is safe for all uses.

#### Change 2: Add CSS for subtask card title and status spans
**Location**: After line 476 (after `.project-task-description pre` block)
**Context**: New CSS classes for the structured title/status layout inside subtask cards.
**Add**:
```css
.project-detail-item-title {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-primary);
}

.project-detail-item-status {
    font-size: 10px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
}
```
**Edge Cases**: ClickUp subtasks already use `<span class="project-detail-item-title">` and `<span class="project-detail-item-status">` (line 4262-4263). Changing from `<span>` to `<div>` in Change 4 means these CSS rules will apply as block elements, which is the desired layout. Linear subtasks currently have no such structure.

#### Change 3: Update Linear subtask HTML to include REFINE and IMPORT buttons
**Location**: Lines 3626-3631
**Context**: Linear subtasks currently render as a single `<button>` with plain text. Must restructure to `<div>` with title/status divs and REFINE/IMPORT buttons, matching the parent card pattern at lines 3533-3542.
**Current**:
```javascript
if (detailSubtasksList) {
    const newSubtasksHtml = selectedLinearIssue.subtasks.length > 0
        ? selectedLinearIssue.subtasks.map((subtask) => `
            <button type="button" class="project-detail-item" data-linear-subtask-id="${escapeAttr(subtask.id)}">
                ${escapeHtml(subtask.title || subtask.identifier || subtask.id)} · ${escapeHtml(subtask.state?.name || 'Unknown state')}
            </button>
        `).join('')
        : '<div class="project-empty-state">No subtasks attached to this issue.</div>';
```

**New**:
```javascript
if (detailSubtasksList) {
    const newSubtasksHtml = selectedLinearIssue.subtasks.length > 0
        ? selectedLinearIssue.subtasks.map((subtask) => `
            <div class="project-detail-item" data-linear-subtask-id="${escapeAttr(subtask.id)}">
                <div class="project-detail-item-title">${escapeHtml(subtask.title || subtask.identifier || subtask.id)}</div>
                <div class="project-detail-item-status">${escapeHtml(subtask.state?.name || 'Unknown state')}</div>
                <div style="display:flex; justify-content:flex-end; margin-top:8px; gap:4px;">
                    <button type="button" class="project-issue-import-btn" data-refine-issue-id="${escapeAttr(subtask.id)}" data-issue-title="${escapeAttr(subtask.title || '')}" data-issue-description="${escapeAttr(subtask.description || '')}" aria-label="Refine ${escapeAttr(subtask.identifier || subtask.id)}">REFINE</button>
                    <button type="button" class="project-issue-import-btn" data-import-issue-id="${escapeAttr(subtask.id)}" aria-label="Import ${escapeAttr(subtask.identifier || subtask.id)}">IMPORT</button>
                </div>
            </div>
        `).join('')
        : '<div class="project-empty-state">No subtasks attached to this issue.</div>';
```
**Implementation Note**: `data-linear-subtask-id` is preserved on the outer `<div>` so the "click to view details" handler can still navigate to the subtask.

#### Change 4: Update ClickUp subtask HTML to include REFINE and IMPORT buttons
**Location**: Lines 4258-4265
**Context**: ClickUp subtasks already have `<span>` elements for title/status but lack REFINE/IMPORT buttons. Must restructure to `<div>` and add buttons, matching the parent card pattern at lines 4170-4182.
**Current**:
```javascript
const subtasksHtml = subtasks.length === 0
    ? '<p>No subtasks.</p>'
    : subtasks.map(st => `
        <button type="button" class="project-detail-item" data-clickup-subtask-id="${escapeAttr(st.id)}">
            <span class="project-detail-item-title">${escapeHtml(st.title)}</span>
            <span class="project-detail-item-status">${escapeHtml(st.status)}</span>
        </button>
    `).join('');
```

**New**:
```javascript
const subtasksHtml = subtasks.length === 0
    ? '<p>No subtasks.</p>'
    : subtasks.map(st => `
        <div class="project-detail-item" data-clickup-subtask-id="${escapeAttr(st.id)}">
            <div class="project-detail-item-title">${escapeHtml(st.title)}</div>
            <div class="project-detail-item-status">${escapeHtml(st.status)}</div>
            <div style="display:flex; justify-content:flex-end; margin-top:8px; gap:4px;">
                <button type="button" class="project-issue-import-btn" data-refine-issue-id="${escapeAttr(st.id)}" data-issue-title="${escapeAttr(st.title || '')}" data-issue-description="${escapeAttr(st.markdownDescription || st.description || '')}" aria-label="Refine ${escapeAttr(st.id)}">REFINE</button>
                <button type="button" class="project-issue-import-btn" data-import-issue-id="${escapeAttr(st.id)}" aria-label="Import ${escapeAttr(st.id)}">IMPORT</button>
            </div>
        </div>
    `).join('');
```
**Implementation Note**: `data-clickup-subtask-id` is preserved on the outer `<div>` so the "click to view details" handler can still navigate to the subtask.

#### Change 5: Replace event handlers with single listener using `lastIntegrationProvider`
**Location**: Lines 4568-4581 (two existing `detailSubtasksList` click listeners)
**Context**: The original plan proposed two separate listeners (one for Linear, one for ClickUp), but this causes a **double-fire bug** — both listeners fire for every click because `stopPropagation()` doesn't prevent same-element listeners. The correct pattern is a single listener with `lastIntegrationProvider` branching, matching the parent card handler at lines 4500-4551. Also, the extension-side handler expects `issueId` (not `taskId`) for Linear messages — see `TaskViewerProvider.ts` lines 7402 and 7791.
**Current**:
```javascript
detailSubtasksList?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-linear-subtask-id]');
    if (!button) {
        return;
    }
    loadLinearTaskDetails(button.dataset.linearSubtaskId);
});
detailSubtasksList?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-clickup-subtask-id]');
    if (!button) {
        return;
    }
    loadClickUpTaskDetails(button.dataset.clickupSubtaskId);
});
```

**New** (single listener, replaces both existing listeners):
```javascript
detailSubtasksList?.addEventListener('click', (event) => {
    // 1. Handle REFINE button click
    const refineBtn = event.target.closest('[data-refine-issue-id]');
    if (refineBtn) {
        event.stopPropagation();
        const id = refineBtn.getAttribute('data-refine-issue-id');
        const title = refineBtn.getAttribute('data-issue-title');
        const description = refineBtn.getAttribute('data-issue-description');
        if (lastIntegrationProvider === 'clickup') {
            vscode.postMessage({
                type: 'clickupRefineTask',
                taskId: id,
                title,
                description,
                workspaceRoot: currentWorkspaceRoot || undefined
            });
        } else {
            vscode.postMessage({
                type: 'linearRefineTask',
                issueId: id,
                title,
                description,
                workspaceRoot: currentWorkspaceRoot || undefined
            });
        }
        return;
    }

    // 2. Handle IMPORT button click
    const importBtn = event.target.closest('[data-import-issue-id]');
    if (importBtn && importBtn.dataset.importIssueId) {
        event.stopPropagation();
        importBtn.disabled = true;
        importBtn.dataset.importing = '';
        if (lastIntegrationProvider === 'clickup') {
            clickUpImportPending = true;
            vscode.postMessage({
                type: 'clickupImportTask',
                taskId: importBtn.dataset.importIssueId,
                includeSubtasks: false,
                workspaceRoot: currentWorkspaceRoot || undefined
            });
        } else {
            linearImportPending = true;
            vscode.postMessage({
                type: 'linearImportTask',
                issueId: importBtn.dataset.importIssueId,
                includeSubtasks: false,
                workspaceRoot: currentWorkspaceRoot || undefined
            });
        }
        return;
    }

    // 3. Handle clicking on subtask card body to view details
    if (lastIntegrationProvider === 'clickup') {
        const clickupBtn = event.target.closest('[data-clickup-subtask-id]');
        if (clickupBtn) {
            event.stopPropagation();
            loadClickUpTaskDetails(clickupBtn.dataset.clickupSubtaskId);
        }
    } else {
        const linearBtn = event.target.closest('[data-linear-subtask-id]');
        if (linearBtn) {
            event.stopPropagation();
            loadLinearTaskDetails(linearBtn.dataset.linearSubtaskId);
        }
    }
});
```
**Implementation Notes**:
- **Field names**: Uses `issueId` for Linear (matching `TaskViewerProvider.ts` line 7402/7791) and `taskId` for ClickUp (matching line 7427/7799). The original plan incorrectly used `taskId` for both.
- **workspaceRoot**: Included in all messages, matching the parent card handler pattern at lines 4514/4522/4540/4547.
- **includeSubtasks: false**: Subtask-level imports should not recursively include nested subtasks. The extension defaults to `true` when omitted (line 7413: `data.includeSubtasks !== false`), so this must be explicitly set.
- **Visual feedback**: Sets `importBtn.disabled = true` and `importBtn.dataset.importing = ''` to show the "..." animation, matching the parent card pattern at lines 4532-4533.
- **Single listener**: Eliminates the double-fire bug by using `lastIntegrationProvider` branching instead of two separate listeners.

## Verification Plan

### Automated Tests
- No automated tests applicable (webview UI changes, no test infrastructure for this component)

### Manual Verification
1. Open implementation.html in the ClickUp/Linear tab
2. Navigate to a task with subtasks
3. Verify subtask cards have white text (not grey)
4. Verify subtask cards have the same background gradient as parent cards
5. Verify subtask cards have REFINE and IMPORT buttons
6. Click REFINE on a Linear subtask — should trigger Linear refine workflow (verify `issueId` field in message, not `taskId`)
7. Click REFINE on a ClickUp subtask — should trigger ClickUp refine workflow (verify `taskId` field in message)
8. Click IMPORT on a subtask — should trigger import workflow with `includeSubtasks: false`
9. Verify IMPORT button shows "IMPORT..." animation while pending
10. Click on subtask card body (outside buttons) — should navigate to subtask detail view
11. Verify only ONE message is sent per click (no double-fire)

## Files Changed
- `src/webview/implementation.html`

## Recommendation
Complexity 4 → **Send to Coder**
