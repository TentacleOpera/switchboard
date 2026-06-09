# Fix Tickets Tab to Match Local Docs Tab Style and Subtask Navigation

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, bugfix

## Goal

The Tickets tab must match the Local Docs tab in both **preview pane styling** and **subtask navigation pattern**. Specifically:
1. The preview pane must use the same typography, spacing, and theme overrides as the local docs `#markdown-preview`
2. Subtasks must be displayed at the **top** of the preview pane as a clickable navigation section, matching how the Online Docs tab displays subpages
3. Subtasks must **not** appear in the sidebar tree (they currently show as separate cards mixed with parent tasks)
4. The current subtask list at the **bottom** of the preview must be removed

This is a UAT fix — the original spec required the tickets tab to match the local/online docs tab patterns.

## Problem Analysis

### Problem 1: Preview Pane Lacks Markdown Typography
Local docs wraps content in `#markdown-preview`, which inherits ~100 lines of rich typography CSS (headings, paragraphs, lists, code blocks, tables, horizontal rules, blockquotes). Tickets content lives in bare `#tickets-detail-*` divs with only three CSS rules: `font-size: 13px`, `color: var(--text-primary)`, `line-height: 1.5`. All `cyber-theme-enabled` overrides (scanlines, grid backgrounds, glow borders) are also missing.

### Problem 2: Subtasks Shown in Sidebar
Both Linear (`queryIssues`) and ClickUp (`getProjectTasks` with `subtasks=true`) return subtasks as separate issues in the project list. The sidebar renders them flat alongside parent tasks, creating a cluttered list where parent and child tasks are indistinguishable.

### Problem 3: Subtasks Shown at Bottom of Preview (Non-Clickable)
When a parent task is selected, subtasks render at the bottom of the preview as a non-interactive list with REFINE/IMPORT buttons. The user specifically requested they appear at the **top** as a clickable navigation section, matching the Online Docs tab's subpages pattern.

### Problem 4: No Active Ticket Banner
Unlike local docs (which has `.active-doc-banner` showing the active planning epic), tickets has a custom `.tickets-detail-banner` with different styling. The tickets banner should match the local docs banner pattern.

## Files to Change

1. `src/webview/planning.html` — HTML structure and CSS
2. `src/webview/planning.js` — Ticket list filtering, detail rendering, and subtask navigation
3. `src/services/LinearSyncService.ts` — May need `parentId` filtering in `queryIssues`
4. `src/services/ClickUpSyncService.ts` — May need parent filtering in `getProjectTasks`

## Changes

### 1. Backend: Filter Subtasks from Project List

**Linear (`src/services/LinearSyncService.ts`):**
In `queryIssues`, after fetching and normalizing issues, filter out issues that have a `parentId`:
```typescript
const topLevelIssues = issues.filter(issue => !issue.parentId);
```

**ClickUp (`src/services/ClickUpSyncService.ts`):**
In `getProjectTasks` / `queryTasks`, the API already returns subtasks mixed with parent tasks. Filter out tasks where `parent` or `parentId` is set:
```typescript
const topLevelTasks = tasks.filter(task => !task.parentId && !task.parent);
```

*Note: Verify this doesn't break the TaskViewer sidebar which may also use these methods. If shared, add an optional `includeSubtasks` parameter defaulting to `false` for the PlanningPanel, `true` for TaskViewer.*

### 2. `src/webview/planning.html` — HTML Structure

Replace the tickets preview pane with a structure that mirrors local docs:

**Before:**
```html
<div id="preview-pane-tickets" style="flex: 1; width: 100%; box-sizing: border-box;">
    <div class="preview-content-wrapper">
        <div class="tickets-detail-banner" id="tickets-detail-banner" style="display:none">
            <div class="tickets-detail-banner-inner">
                <div class="tickets-detail-banner-info">
                    <h3 id="tickets-detail-title" class="tickets-detail-title"></h3>
                    <div class="tickets-detail-meta">
                        <span id="tickets-detail-status"></span>
                        <span id="tickets-detail-assignee"></span>
                    </div>
                </div>
                <div class="tickets-detail-banner-actions">
                    <button id="tickets-detail-import" class="strip-btn" disabled>Import</button>
                    <button id="tickets-detail-refine" class="strip-btn" disabled>Refine</button>
                    <button id="tickets-detail-ask-agent" class="strip-btn" disabled>Ask Agent</button>
                    <button id="tickets-back-to-parent" class="strip-btn" style="display:none">Back to Parent</button>
                </div>
            </div>
        </div>
        <div id="tickets-detail-description" class="tickets-detail-section"></div>
        <div id="tickets-detail-subtasks" class="tickets-detail-section"></div>
        <div id="tickets-detail-comments" class="tickets-detail-section"></div>
        <div id="tickets-detail-attachments" class="tickets-detail-section"></div>
        <div id="tickets-empty-preview" class="empty-state">Select a ticket to preview</div>
    </div>
</div>
```

**After:**
```html
<div id="preview-pane-tickets" style="flex: 1; width: 100%; box-sizing: border-box;">
    <div class="preview-content-wrapper">
        <!-- Active ticket banner matching local docs active-doc-banner -->
        <div class="active-doc-banner inactive" id="active-doc-banner-tickets">
            <div class="active-doc-info">
                <span class="active-doc-label">Active Ticket:</span>
                <span class="active-doc-name" id="active-doc-name-tickets">None</span>
            </div>
            <div class="active-doc-actions">
                <button class="btn-disable-doc" id="btn-disable-doc-tickets">Turn off</button>
            </div>
        </div>
        <!-- Markdown preview container matching local docs -->
        <div id="markdown-preview-tickets">
            <div id="tickets-empty-preview" class="empty-state">Select a ticket to preview</div>
            <!-- Subtasks navigation (injected at TOP by JS) -->
            <div id="tickets-subtasks-nav"></div>
            <!-- Ticket detail content -->
            <div id="tickets-detail-content"></div>
        </div>
    </div>
</div>
```

### 3. `src/webview/planning.html` — CSS

**Add `#markdown-preview-tickets` to all `#markdown-preview` selector blocks.**

Find every CSS rule that targets `#markdown-preview`, `#markdown-preview-online`, `#markdown-preview-design`, or `#kanban-preview-pane` and add `#markdown-preview-tickets` to the selector list.

Key groups to update:
- Headings (`h1`–`h6`)
- Paragraphs (`p`)
- Lists (`ul`, `ol`, `li`)
- Code blocks (`pre`, `code`)
- Tables (`table`, `th`, `td`)
- Blockquotes (`blockquote`)
- Horizontal rules (`hr`)
- Links (`a`)
- Images (`img`)
- `.cyber-theme-enabled` overrides for all of the above

**Add subtask navigation styling:**
```css
#tickets-subtasks-nav {
    margin-bottom: 16px;
    padding: 12px;
    background: var(--panel-bg2);
    border: 1px solid var(--accent-teal-dim);
    border-radius: 4px;
}
#tickets-subtasks-nav .subtasks-header {
    font-size: 11px;
    font-weight: 600;
    color: var(--accent-teal);
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}
#tickets-subtasks-nav .subtask-nav-item {
    padding: 6px 8px;
    cursor: pointer;
    border-radius: 3px;
    transition: background 0.1s;
    font-size: 13px;
    color: var(--accent-teal);
    display: flex;
    justify-content: space-between;
    align-items: center;
}
#tickets-subtasks-nav .subtask-nav-item:hover {
    background: var(--accent-teal-dim);
}
#tickets-subtasks-nav .subtask-nav-item.selected {
    background: var(--accent-teal-dim);
}
#tickets-subtasks-nav .subtask-nav-status {
    font-size: 11px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
}
```

**Remove or deprecate `.tickets-detail-banner` CSS:**
The `.tickets-detail-banner`, `.tickets-detail-banner-inner`, `.tickets-detail-title`, `.tickets-detail-meta`, and `.tickets-detail-banner-actions` CSS blocks are replaced by `.active-doc-banner` styling. Remove them.

Keep `.tickets-detail-section` only for structural margin/padding if needed, but remove its `font-size`, `color`, and `line-height` rules (the `#markdown-preview-tickets` parent will handle typography).

### 4. `src/webview/planning.js` — Filter Subtasks from Sidebar

**For Linear:**
In `renderTicketsLinearList()` or `getFilteredLinearIssues()`, filter out issues that have `parentId`:
```javascript
const filteredIssues = getFilteredLinearIssues().filter(issue => !issue.parentId);
```

**For ClickUp:**
In `renderTicketsClickUpList()` or `getFilteredClickUpTasks()`, filter out tasks that have `parentId`:
```javascript
const tasks = getFilteredClickUpTasks().filter(task => !task.parentId);
```

### 5. `src/webview/planning.js` — Subtask Navigation at Top of Preview

Refactor `renderTicketsLinearTaskDetail()` and `renderTicketsClickUpTaskDetail()`:

**Step 1: Update banner state**
```javascript
const banner = document.getElementById('active-doc-banner-tickets');
const docName = document.getElementById('active-doc-name-tickets');
banner.classList.remove('inactive');
docName.textContent = issue.title || issue.identifier || 'Untitled';
```

**Step 2: Render subtasks at top as navigation**
```javascript
const subtasksNav = document.getElementById('tickets-subtasks-nav');
if (subtasks && subtasks.length > 0) {
    let navHtml = '<div class="subtasks-header">Subtasks</div>';
    navHtml += '<div style="display: flex; flex-direction: column; gap: 4px;">';
    subtasks.forEach(subtask => {
        navHtml += `<div class="subtask-nav-item" data-subtask-id="${escapeAttr(subtask.id)}" data-provider="${provider}">
            <span>${escapeHtml(subtask.title || subtask.name || subtask.id)}</span>
            <span class="subtask-nav-status">${escapeHtml(subtask.state?.name || subtask.status || 'Unknown')}</span>
        </div>`;
    });
    navHtml += '</div>';
    subtasksNav.innerHTML = navHtml;
    subtasksNav.style.display = '';
} else {
    subtasksNav.innerHTML = '';
    subtasksNav.style.display = 'none';
}
```

**Step 3: Wire click handlers for subtask navigation**
Add delegated click handler on `#tickets-subtasks-nav`:
```javascript
document.getElementById('tickets-subtasks-nav')?.addEventListener('click', (e) => {
    const item = e.target.closest('.subtask-nav-item');
    if (!item) return;
    const subtaskId = item.dataset.subtaskId;
    const provider = item.dataset.provider;
    if (provider === 'linear') {
        loadLinearTaskDetails(subtaskId);
    } else if (provider === 'clickup') {
        loadClickUpTaskDetails(subtaskId);
    }
});
```

**Step 4: Render description/comments/attachments into `#tickets-detail-content`**
Concatenate all remaining sections into a single HTML string and inject into `#tickets-detail-content`:
```javascript
const contentDiv = document.getElementById('tickets-detail-content');
let html = '';

// Description
if (renderedDescriptionHtml) {
    html += renderedDescriptionHtml;
} else {
    html += `<p>${escapeHtml((description || '').trim() || 'No description provided.').replace(/\n/g, '<br>')}</p>`;
}

// Comments
if (comments && comments.length > 0) {
    html += '<h3>Comments</h3>';
    html += comments.map(c => `...`).join('');
}

// Attachments
if (attachments && attachments.length > 0) {
    html += '<h3>Attachments</h3>';
    html += attachments.map(a => `...`).join('');
}

contentDiv.innerHTML = html;
```

**Step 5: Handle "Back to Parent"**
When viewing a subtask, show a "Back to Parent" button in the `.active-doc-banner` action area:
```javascript
const backToParentBtn = document.getElementById('tickets-back-to-parent');
if (issue.parentId) {
    backToParentBtn.style.display = '';
    backToParentBtn.dataset.parentId = issue.parentId;
} else {
    backToParentBtn.style.display = 'none';
}
```

**Step 6: Clear state when deselecting**
```javascript
// When no ticket selected:
banner.classList.add('inactive');
docName.textContent = 'None';
subtasksNav.innerHTML = '';
subtasksNav.style.display = 'none';
contentDiv.innerHTML = '';
```

### 6. `src/webview/planning.js` — Update Element References

Update `getTicketsTabElements()`:
- Remove: `detailBanner`, `detailTitle`, `detailStatus`, `detailAssignee`, `detailSubtasks`, `detailComments`, `detailAttachments`
- Add: `activeDocBanner`, `activeDocName`, `subtasksNav`, `detailContent`
- Keep: `detailImportButton`, `detailRefineButton`, `detailAskAgentButton`, `backToParentButton`

### 7. `src/webview/planning.js` — Remove Old Subtask Rendering

Delete the code in `renderTicketsLinearTaskDetail()` and `renderTicketsClickUpTaskDetail()` that renders subtasks into `#tickets-detail-subtasks` at the bottom. This is now handled by the `#tickets-subtasks-nav` at the top.

Also delete the code that renders comments and attachments into their old separate divs — they now go into `#tickets-detail-content`.

## Edge Cases

- **No subtasks**: `#tickets-subtasks-nav` is hidden, preview shows only description/comments/attachments
- **Subtask with no description**: Shows "No description provided" inside `#markdown-preview-tickets` so it gets proper paragraph styling
- **Deep nesting (subtask of subtask)**: Linear and ClickUp both support arbitrary depth. The "Back to Parent" button always goes up one level. The sidebar continues to show only top-level tasks.
- **Clicking a subtask that is also in the project list**: After backend filtering, subtasks won't appear in the sidebar. But if the user searches for a subtask by ID, it won't appear in results. This is intentional — the navigation model is parent-first.
- **Theme switching**: All `#markdown-preview-tickets` selectors must respond to `.theme-afterburner-updated` and `.cyber-theme-enabled`
- **HTML descriptions**: Pre-rendered HTML from APIs is safe to inject into `#markdown-preview-tickets` — child selectors will style it

## Risks

- **Backend API changes**: Filtering subtasks from project lists changes the data contract. Must verify TaskViewer sidebar doesn't break (it may need `includeSubtasks=true`)
- **Click handler conflicts**: Delegated handlers on `#preview-pane-tickets` for REFINE/IMPORT buttons must continue working after DOM restructure
- **State management**: The `_lastTicketsDetailSubtasksHtml` cache variables become redundant and should be cleaned up to avoid stale state

## Validation

1. Open the Tickets tab.
2. Verify sidebar shows **only parent tasks** (no subtasks mixed in).
3. Select a parent task with subtasks.
4. Verify:
   - `.active-doc-banner` appears with ticket title
   - **Subtasks section appears at TOP** of preview as clickable items with status badges
   - Clicking a subtask loads its detail (banner updates, content changes)
   - "Back to Parent" button appears when viewing a subtask
   - Description uses same typography as Local Docs (headings, lists, code blocks styled)
   - Comments and attachments appear below description with proper heading styles
   - Cyber theme grid/scanlines apply to the preview pane
5. Select a task with no subtasks.
6. Verify no subtasks nav section appears, only description.
7. Test with both Linear and ClickUp integrations.
