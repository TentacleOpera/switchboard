# Fix Tickets Tab to Match Local Docs Tab Style and Subtask Navigation

## Goal

The Tickets tab must match the Local Docs tab in both **preview pane styling** and **subtask navigation pattern**. Specifically:
1. The preview pane must use the same typography, spacing, and theme overrides as the local docs `#markdown-preview`
2. Subtasks must be displayed at the **top** of the preview pane as a clickable navigation section, matching how the Online Docs tab displays subpages
3. Subtasks must **not** appear in the sidebar tree (they currently show as separate cards mixed with parent tasks)
4. The current subtask list at the **bottom** of the preview must be removed

This is a UAT fix — the original spec required the tickets tab to match the local/online docs tab patterns.

### Problem Analysis

#### Problem 1: Preview Pane Lacks Markdown Typography
Local docs wraps content in `#markdown-preview`, which inherits ~100 lines of rich typography CSS (headings, paragraphs, lists, code blocks, tables, horizontal rules, blockquotes). Tickets content lives in bare `#tickets-detail-*` divs with only three CSS rules: `font-size: 13px`, `color: var(--text-primary)`, `line-height: 1.5` (planning.html lines 2637-2648). All `cyber-theme-enabled` overrides (scanlines, grid backgrounds, glow borders) are also missing.

#### Problem 2: Subtasks Shown in Sidebar
ClickUp (`getListTasks` with `subtasks=true`) returns subtasks as separate tasks in the project list. The sidebar renders them flat alongside parent tasks, creating a cluttered list where parent and child tasks are indistinguishable. **Linear already filters `parentId` in `getFilteredLinearIssues()` (line 5438)**, but ClickUp's `getFilteredClickUpTasks()` (line 5905) does not.

#### Problem 3: Subtasks Shown at Bottom of Preview (Non-Clickable)
When a parent task is selected, subtasks render at the bottom of the preview as a non-interactive list with REFINE/IMPORT buttons (planning.js lines 5588-5605 for Linear, 6022-6039 for ClickUp). The user specifically requested they appear at the **top** as a clickable navigation section, matching the Online Docs tab's subpages pattern (planning.js lines 2500-2528).

#### Problem 4: No Active Ticket Banner Matching Local Docs Pattern
Unlike local docs (which has `.active-doc-banner` showing the active planning epic at lines 2998-3004), tickets has a custom `.tickets-detail-banner` (lines 3311-3327) with different styling and structure. The tickets banner should match the local docs banner pattern visually while retaining ticket-specific action buttons (Import, Refine, Ask Agent, Back to Parent).

## Metadata

**Tags:** frontend, ui, bugfix
**Complexity:** 5

## User Review Required

- **Banner action button placement**: The plan replaces `tickets-detail-banner` with `active-doc-banner` styling but retains ticket-specific action buttons (Import, Refine, Ask Agent, Back to Parent) inside the banner. Confirm this is acceptable vs. moving action buttons to the existing `controls-strip-tickets`.
- **"Turn off" button semantics**: The local docs `active-doc-banner` has a "Turn off" button that disables the active planning context. For tickets, this button is replaced by ticket-specific actions. Confirm no "Turn off" / "deselect ticket" behavior is needed.
- **Subtask REFINE/IMPORT in nav**: The subtask navigation items at the top will be clickable (navigating to subtask detail). Subtask-level REFINE/IMPORT buttons will NOT appear in the nav — users must click into the subtask first, then use the banner actions. Confirm this workflow is acceptable.

## Complexity Audit

### Routine
- Adding `#markdown-preview-tickets` to existing CSS selector lists (mechanical, ~20 rule blocks)
- Replacing `tickets-detail-banner` HTML with `active-doc-banner`-styled HTML
- Adding `parentId` filter to `getFilteredClickUpTasks()` (one line, mirrors existing Linear filter)
- Removing old `#tickets-detail-subtasks`, `#tickets-detail-comments`, `#tickets-detail-attachments` divs
- Updating `getTicketsTabElements()` element references
- Cleaning up cache variables

### Complex / Risky
- Refactoring `renderTicketsLinearTaskDetail()` and `renderTicketsClickUpTaskDetail()` to render into a single `#tickets-detail-content` div inside `#markdown-preview-tickets` instead of separate section divs — must preserve cache-guard pattern and REFINE/IMPORT delegation
- Wiring subtask navigation clicks to load subtask details while keeping existing delegated REFINE/IMPORT handler working on the new DOM structure
- Ensuring all 20+ CSS selector additions are complete — missed selectors cause subtle visual drift

## Edge-Case & Dependency Audit

- **Race Conditions**: None identified. Rendering is synchronous per user action (click/select).
- **Security**: No new XSS vectors. All subtask titles/statuses pass through existing `escapeHtml()`/`escapeAttr()`.
- **Side Effects**: Removing `#tickets-detail-subtasks` div means the old subtask REFINE/IMPORT buttons (with `data-refine-issue-id`/`data-import-issue-id` attributes) no longer exist in the DOM. The delegated handler on `#preview-pane-tickets` (line 5234) will simply not match them — no error, but subtask-level REFINE/IMPORT must be accessed through the subtask detail view instead.
- **Dependencies & Conflicts**: `getFilteredClickUpTasks()` is also called from `renderTicketsClickUpList()` (line 5920). Adding `parentId` filter there will correctly hide subtasks from the sidebar. No other consumers of this function are affected.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) Action buttons (Import, Refine, Ask Agent, Back to Parent) lose their container if banner replacement doesn't explicitly include them — must extend `active-doc-banner` with a `.tickets-banner-actions` div. (2) Filtering subtasks at the backend service level would break TaskViewer — filter at JS level only. (3) ~20 CSS selector blocks need `#markdown-preview-tickets` added with exact line numbers to prevent missed selectors and visual drift. Mitigations: retain action buttons in banner, JS-level filtering only, provide complete line-numbered CSS change list.

## Proposed Changes

### 1. `src/webview/planning.html` — Replace Tickets Preview Pane HTML (Lines 3309-3336)

**Context**: The current tickets preview pane uses `tickets-detail-banner` and separate `tickets-detail-section` divs. Replace with `active-doc-banner`-styled banner + `#markdown-preview-tickets` wrapper + subtask navigation + single content div.

**Before** (lines 3309-3336):
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

**After**:
```html
<div id="preview-pane-tickets" style="flex: 1; width: 100%; box-sizing: border-box;">
    <div class="preview-content-wrapper">
        <!-- Active ticket banner matching local docs active-doc-banner pattern -->
        <div class="active-doc-banner inactive" id="active-doc-banner-tickets">
            <div class="active-doc-info">
                <span class="active-doc-label">Active Ticket:</span>
                <span class="active-doc-name" id="active-doc-name-tickets">None</span>
                <span class="tickets-detail-meta" id="tickets-detail-meta" style="display:none">
                    <span id="tickets-detail-status"></span>
                    <span id="tickets-detail-assignee"></span>
                </span>
            </div>
            <div class="tickets-banner-actions">
                <button id="tickets-detail-import" class="strip-btn" disabled>Import</button>
                <button id="tickets-detail-refine" class="strip-btn" disabled>Refine</button>
                <button id="tickets-detail-ask-agent" class="strip-btn" disabled>Ask Agent</button>
                <button id="tickets-back-to-parent" class="strip-btn" style="display:none">Back to Parent</button>
            </div>
        </div>
        <!-- Markdown preview container matching local docs -->
        <div id="markdown-preview-tickets">
            <div id="tickets-empty-preview" class="empty-state">Select a ticket to preview</div>
            <!-- Subtasks navigation (injected at TOP by JS) -->
            <div id="tickets-subtasks-nav" style="display:none"></div>
            <!-- Ticket detail content (description + comments + attachments) -->
            <div id="tickets-detail-content"></div>
        </div>
    </div>
</div>
```

**Logic**:
- `active-doc-banner` uses existing CSS from lines 496-556. The `.inactive` class is toggled by JS.
- `.tickets-banner-actions` is a new div inside the banner holding the 4 action buttons. Styled to match `.active-doc-banner` flex layout.
- `.tickets-detail-meta` (status + assignee) is nested inside `.active-doc-info` and shown/hidden by JS when a ticket is selected.
- `#markdown-preview-tickets` wraps all preview content, inheriting typography from CSS selectors updated in Change #2.
- `#tickets-subtasks-nav` is populated by JS with clickable navigation items.
- `#tickets-detail-content` receives concatenated description + comments + attachments HTML.

**Edge Cases**:
- When no ticket is selected: banner has `.inactive` class, meta is hidden, empty-state shows, subtasks-nav is hidden.
- When a subtask is selected: banner shows subtask title, "Back to Parent" button appears.

### 2. `src/webview/planning.html` — Add `#markdown-preview-tickets` to All CSS Selector Blocks

**Context**: Every CSS rule that targets `#markdown-preview`, `#markdown-preview-online`, `#markdown-preview-design`, or `#kanban-preview-pane` must also target `#markdown-preview-tickets` so ticket content inherits the same typography.

**Implementation**: Add `, #markdown-preview-tickets` to each selector list below. Each entry shows the **exact line range** and the **current selector prefix** to extend.

| Line Range | Current Selector Pattern | Change |
|:-----------|:------------------------|:-------|
| 1039-1052 | `#markdown-preview, #markdown-preview-online, #markdown-preview-design` | Add `, #markdown-preview-tickets` |
| 1064-1073 | `#markdown-preview h1…h6, #markdown-preview-online h1…h6, #markdown-preview-design h1…h6, #kanban-preview-pane h1…h6` | Add `, #markdown-preview-tickets h1…h6` |
| 1102-1113 | `#markdown-preview h1, #markdown-preview-online h1, #markdown-preview-design h1, #kanban-preview-pane h1` | Add `, #markdown-preview-tickets h1` |
| 1115-1126 | `#markdown-preview h2, #markdown-preview-online h2, #markdown-preview-design h2, #kanban-preview-pane h2` | Add `, #markdown-preview-tickets h2` |
| 1128-1146 | `#markdown-preview h3…h6, #markdown-preview-online h3…h6, #markdown-preview-design h3…h6, #kanban-preview-pane h3…h6` | Add `, #markdown-preview-tickets h3…h6` |
| 1148-1155 | `#markdown-preview h3, #markdown-preview-online h3, #markdown-preview-design h3, #kanban-preview-pane h3` | Add `, #markdown-preview-tickets h3` |
| 1157-1164 | `#markdown-preview h4, #markdown-preview-online h4, #markdown-preview-design h4, #kanban-preview-pane h4` | Add `, #markdown-preview-tickets h4` |
| 1166-1173 | `#markdown-preview h5, #markdown-preview-online h5, #markdown-preview-design h5, #kanban-preview-pane h5` | Add `, #markdown-preview-tickets h5` |
| 1174 (approx) | `#markdown-preview h6, #markdown-preview-online h6, #markdown-preview-design h6, #kanban-preview-pane h6` | Add `, #markdown-preview-tickets h6` |
| 1176-1184 | `#markdown-preview p, #markdown-preview-online p, #markdown-preview-design p, #kanban-preview-pane p` | Add `, #markdown-preview-tickets p` |
| 1186-1193 | `#markdown-preview li, #markdown-preview-online li, #markdown-preview-design li, #kanban-preview-pane li` | Add `, #markdown-preview-tickets li` |
| 1194-1201 | `#markdown-preview li p, #markdown-preview-online li p, #markdown-preview-design li p, #kanban-preview-pane li p` | Add `, #markdown-preview-tickets li p` |
| 1203-1213 | `#markdown-preview pre, #markdown-preview-online pre, #markdown-preview-design pre, #kanban-preview-pane pre` | Add `, #markdown-preview-tickets pre` |
| 1215-1225 | `#markdown-preview pre code, #markdown-preview-online pre code, #markdown-preview-design pre code, #kanban-preview-pane pre code` | Add `, #markdown-preview-tickets pre code` |
| 1226-1238 (approx) | `#markdown-preview code, #markdown-preview-online code, #markdown-preview-design code, #kanban-preview-pane code` | Add `, #markdown-preview-tickets code` |
| 1241-1251 | `#markdown-preview blockquote, #markdown-preview-online blockquote, #markdown-preview-design blockquote, #kanban-preview-pane blockquote` | Add `, #markdown-preview-tickets blockquote` |
| 1253-1259 | `#markdown-preview ul, #markdown-preview ol, #markdown-preview-online ul, #markdown-preview ol, #markdown-preview-design ul, #markdown-preview-design ol, #kanban-preview-pane ul, #kanban-preview-pane ol` | Add `, #markdown-preview-tickets ul, #markdown-preview-tickets ol` |
| 1262-1275 (approx) | `#markdown-preview table, …` | Add `, #markdown-preview-tickets table` |
| 1276-1288 (approx) | `#markdown-preview th, …` | Add `, #markdown-preview-tickets th` |
| 1289-1301 (approx) | `#markdown-preview td, …` | Add `, #markdown-preview-tickets td` |
| 1302-1310 (approx) | `#markdown-preview tr:hover td, …` | Add `, #markdown-preview-tickets tr:hover td` |
| 1311-1320 (approx) | `#markdown-preview .table-wrapper, …` | Add `, #markdown-preview-tickets .table-wrapper` |
| 1307-1321 | `#markdown-preview a, …` and `#markdown-preview a:hover, …` | Add `, #markdown-preview-tickets a` and `, #markdown-preview-tickets a:hover` |
| 1323-1338 | `#markdown-preview hr, …` and `#markdown-preview img, …` | Add `, #markdown-preview-tickets hr` and `, #markdown-preview-tickets img` |
| 1340-1351 | `#markdown-preview .empty-state, …` | Add `, #markdown-preview-tickets .empty-state` |

**Cyber theme overrides** (also need `#markdown-preview-tickets`):

| Line Range | Current Selector | Change |
|:-----------|:-----------------|:-------|
| 1993-2000 | `.cyber-theme-enabled #markdown-preview code, …` | Add `, .cyber-theme-enabled #markdown-preview-tickets code` |
| 2002-2010 | `.cyber-theme-enabled #markdown-preview pre, …` | Add `, .cyber-theme-enabled #markdown-preview-tickets pre` |
| 2012-2016 | `.cyber-theme-enabled #markdown-preview blockquote, …` | Add `, .cyber-theme-enabled #markdown-preview-tickets blockquote` |

### 3. `src/webview/planning.html` — Add New CSS Rules

**Context**: New CSS for the tickets banner actions, subtask navigation, and cleanup of old ticket-detail styles.

**Add after the `.active-doc-banner` block (after line ~556)**:
```css
/* Tickets banner actions — extend active-doc-banner for ticket action buttons */
.tickets-banner-actions {
    display: flex;
    gap: 8px;
    align-items: center;
}

.active-doc-banner.inactive .tickets-banner-actions {
    display: none;
}

/* Tickets detail meta inside active-doc-banner */
.tickets-detail-meta {
    display: flex;
    gap: 8px;
    font-size: 11px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    margin-left: 8px;
}
```

**Add subtask navigation styling (after the new banner CSS)**:
```css
/* Subtask navigation — matches Online Docs .page-navigation pattern */
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

**Remove/deprecate old ticket-detail CSS (lines 2601-2689)**:
- Remove `.tickets-detail-banner-inner` (line 2601) — replaced by `.active-doc-banner`
- Remove `.tickets-detail-banner-info` (line 2611) — replaced by `.active-doc-info`
- Remove `.tickets-detail-title` (line 2618) — replaced by `.active-doc-name`
- Remove `.tickets-detail-meta` (line 2624) — moved into banner, re-styled above
- Remove `.tickets-detail-banner-actions` (line 2632) — replaced by `.tickets-banner-actions`
- Remove `.tickets-detail-section` (line 2637) — no longer used (content goes inside `#markdown-preview-tickets`)
- Remove `#tickets-detail-description p, #tickets-detail-description li` (line 2663) — handled by `#markdown-preview-tickets` selectors
- Remove `#tickets-detail-description pre` (line 2669) — handled by `#markdown-preview-tickets` selectors
- Remove `#tickets-detail-description code` (line 2678) — handled by `#markdown-preview-tickets` selectors
- Remove `#tickets-detail-description pre code` (line 2686) — handled by `#markdown-preview-tickets` selectors

**Keep** (still used for subtask/comment/attachment items rendered inside `#markdown-preview-tickets`):
- `.tickets-section-header` (line 2651) — still used for Comments/Attachments headings inside `#tickets-detail-content`
- `.tickets-subtask-item`, `.tickets-subtask-title`, `.tickets-subtask-status`, `.tickets-subtask-actions` (lines 2692-2743) — still used for subtask items in the old bottom-list pattern; **can be removed** since subtasks now use `.subtask-nav-item` in the nav
- `.tickets-comment-item`, `.tickets-comment-author`, `.tickets-comment-date`, `.tickets-comment-body` (lines 2746-2772) — still used for comments inside `#tickets-detail-content`
- `.tickets-attachment-item` (lines 2775-2792) — still used for attachments inside `#tickets-detail-content`

**Update cyber theme overrides (lines 2795-2817)**:
- Remove `.cyber-theme-enabled .tickets-detail-banner-inner` (line 2795) — banner now uses `.active-doc-banner` which already has cyber theme support
- Remove `.cyber-theme-enabled .tickets-subtask-item` and `:hover` (lines 2799-2807) — subtasks now use `.subtask-nav-item`; add cyber override for that instead:
  ```css
  .cyber-theme-enabled #tickets-subtasks-nav .subtask-nav-item {
      background: rgba(13, 13, 13, 0.40);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
  }
  .cyber-theme-enabled #tickets-subtasks-nav .subtask-nav-item:hover {
      box-shadow: 0 0 6px color-mix(in srgb, var(--accent-teal) 20%, transparent);
  }
  ```
- Keep `.cyber-theme-enabled .tickets-comment-item` (line 2809) and `.cyber-theme-enabled .tickets-attachment-item` (line 2815) — still used

### 4. `src/webview/planning.js` — Add `parentId` Filter to ClickUp (Line 5908)

**Context**: `getFilteredClickUpTasks()` (line 5905) does not filter out subtasks. Linear's `getFilteredLinearIssues()` already filters `parentId` at line 5438. Add the same filter for ClickUp.

**Implementation**: At line 5908, add a `parentId` check as the first filter condition:
```javascript
function getFilteredClickUpTasks() {
    const search = String(clickUpProjectSearchValue || '').trim().toLowerCase();
    const statusFilter = String(clickUpProjectStatusFilterValue || '').trim();
    return clickUpProjectIssues.filter(task => {
        if (task?.parentId) return false;  // ← ADD THIS LINE
        if (statusFilter && task.status !== statusFilter) return false;
        if (!search) return true;
        const haystack = [
            task.title,
            task.description,
            task.assignees?.map(a => a.username || a.email).join(' ')
        ].join('\n').toLowerCase();
        return haystack.includes(search);
    });
}
```

**Clarification**: This is a JS-level filter, not a backend service change. `getListTasks()` still returns subtasks from the API (needed for subtask detail loading). The filter only affects what appears in the sidebar list.

### 5. `src/webview/planning.js` — Update `getTicketsTabElements()` (Lines 137-165)

**Context**: The function references old element IDs that will be removed from HTML. Update to reference new elements.

**Before** (lines 137-165):
```javascript
function getTicketsTabElements() {
    return {
        listView: document.getElementById('tree-pane-tickets'),
        previewPane: document.getElementById('preview-pane-tickets'),
        detailBanner: document.getElementById('tickets-detail-banner'),
        emptyPreview: document.getElementById('tickets-empty-preview'),
        searchInput: document.getElementById('tickets-search'),
        projectPicker: document.getElementById('tickets-project-picker'),
        stateFilter: document.getElementById('tickets-state-filter'),
        clickUpStatusFilter: document.getElementById('tickets-status-filter'),
        refreshButton: document.getElementById('tickets-refresh'),
        emptyState: document.getElementById('tickets-empty-state'),
        issuesContainer: document.getElementById('tickets-issues-container'),
        loadMoreButton: document.getElementById('tickets-load-more'),
        detailTitle: document.getElementById('tickets-detail-title'),
        detailStatus: document.getElementById('tickets-detail-status'),
        detailAssignee: document.getElementById('tickets-detail-assignee'),
        detailDescription: document.getElementById('tickets-detail-description'),
        detailSubtasks: document.getElementById('tickets-detail-subtasks'),
        detailComments: document.getElementById('tickets-detail-comments'),
        detailAttachments: document.getElementById('tickets-detail-attachments'),
        detailImportButton: document.getElementById('tickets-detail-import'),
        detailRefineButton: document.getElementById('tickets-detail-refine'),
        detailAskAgentButton: document.getElementById('tickets-detail-ask-agent'),
        backToParentButton: document.getElementById('tickets-back-to-parent'),
        hierarchyNav: document.getElementById('tickets-hierarchy-nav'),
        createButton: document.getElementById('tickets-create')
    };
}
```

**After**:
```javascript
function getTicketsTabElements() {
    return {
        listView: document.getElementById('tree-pane-tickets'),
        previewPane: document.getElementById('preview-pane-tickets'),
        activeDocBanner: document.getElementById('active-doc-banner-tickets'),
        activeDocName: document.getElementById('active-doc-name-tickets'),
        detailMeta: document.getElementById('tickets-detail-meta'),
        detailStatus: document.getElementById('tickets-detail-status'),
        detailAssignee: document.getElementById('tickets-detail-assignee'),
        emptyPreview: document.getElementById('tickets-empty-preview'),
        searchInput: document.getElementById('tickets-search'),
        projectPicker: document.getElementById('tickets-project-picker'),
        stateFilter: document.getElementById('tickets-state-filter'),
        clickUpStatusFilter: document.getElementById('tickets-status-filter'),
        refreshButton: document.getElementById('tickets-refresh'),
        emptyState: document.getElementById('tickets-empty-state'),
        issuesContainer: document.getElementById('tickets-issues-container'),
        loadMoreButton: document.getElementById('tickets-load-more'),
        subtasksNav: document.getElementById('tickets-subtasks-nav'),
        detailContent: document.getElementById('tickets-detail-content'),
        detailImportButton: document.getElementById('tickets-detail-import'),
        detailRefineButton: document.getElementById('tickets-detail-refine'),
        detailAskAgentButton: document.getElementById('tickets-detail-ask-agent'),
        backToParentButton: document.getElementById('tickets-back-to-parent'),
        hierarchyNav: document.getElementById('tickets-hierarchy-nav'),
        createButton: document.getElementById('tickets-create')
    };
}
```

**Changes**:
- Remove: `detailBanner`, `detailTitle`, `detailDescription`, `detailSubtasks`, `detailComments`, `detailAttachments`
- Add: `activeDocBanner`, `activeDocName`, `detailMeta`, `subtasksNav`, `detailContent`
- Keep: `detailStatus`, `detailAssignee`, `detailImportButton`, `detailRefineButton`, `detailAskAgentButton`, `backToParentButton`

### 6. `src/webview/planning.js` — Refactor `renderTicketsLinearTaskDetail()` (Lines 5519-5650)

**Context**: The function currently renders into separate divs (`detailTitle`, `detailDescription`, `detailSubtasks`, `detailComments`, `detailAttachments`). Refactor to render into `activeDocBanner` + `subtasksNav` + `detailContent`.

**Implementation**: Replace the function body with the following logic:

**Step 1: Destructure new elements** (replace line 5522):
```javascript
const { activeDocBanner, activeDocName, detailMeta, detailStatus, detailAssignee, subtasksNav, detailContent, detailImportButton, detailRefineButton, detailAskAgentButton, backToParentButton } = getTicketsTabElements();
if (!activeDocBanner || !activeDocName || !detailContent) return;
```

**Step 2: Handle "no ticket selected" state** (replace lines 5525-5554):
```javascript
if (!selectedLinearIssue) {
    activeDocBanner.classList.add('inactive');
    activeDocName.textContent = 'None';
    if (detailMeta) detailMeta.style.display = 'none';
    if (subtasksNav) { subtasksNav.innerHTML = ''; subtasksNav.style.display = 'none'; }
    if (_lastTicketsDetailContentHtml !== '') { detailContent.innerHTML = ''; _lastTicketsDetailContentHtml = ''; }
    if (detailImportButton) { detailImportButton.disabled = true; delete detailImportButton.dataset.importIssueId; }
    if (detailRefineButton) { detailRefineButton.disabled = true; delete detailRefineButton.dataset.refineIssueId; delete detailRefineButton.dataset.issueTitle; delete detailRefineButton.dataset.issueDescription; }
    if (detailAskAgentButton) { detailAskAgentButton.disabled = true; }
    if (backToParentButton) { backToParentButton.style.display = 'none'; delete backToParentButton.dataset.parentId; delete backToParentButton.dataset.parentProvider; }
    return;
}
```

**Step 3: Update banner** (replace lines 5557-5560):
```javascript
const issue = selectedLinearIssue.issue;
activeDocBanner.classList.remove('inactive');
activeDocName.textContent = issue.title || issue.identifier || issue.id;
if (detailMeta) detailMeta.style.display = '';
if (detailStatus) detailStatus.textContent = issue.state?.name || 'Unknown status';
if (detailAssignee) detailAssignee.textContent = `Assignee: ${issue.assignee?.name || issue.assignee?.email || 'Unassigned'}`;
```

**Step 4: Handle Back to Parent** (keep lines 5562-5572 logic, same as current):
```javascript
if (backToParentButton) {
    const parentId = issue.parentId;
    if (parentId) {
        backToParentButton.style.display = '';
        backToParentButton.dataset.parentId = parentId;
        backToParentButton.dataset.parentProvider = 'linear';
    } else {
        backToParentButton.style.display = 'none';
        delete backToParentButton.dataset.parentId;
        delete backToParentButton.dataset.parentProvider;
    }
}
```

**Step 5: Render subtasks navigation at top** (replace lines 5588-5605):
```javascript
if (subtasksNav) {
    const subtasks = selectedLinearIssue.subtasks;
    if (subtasks && subtasks.length > 0) {
        let navHtml = '<div class="subtasks-header">Subtasks</div>';
        navHtml += '<div style="display: flex; flex-direction: column; gap: 4px;">';
        subtasks.forEach(subtask => {
            navHtml += `<div class="subtask-nav-item" data-subtask-id="${escapeAttr(subtask.id)}" data-provider="linear">
                <span>${escapeHtml(subtask.title || subtask.identifier || subtask.id)}</span>
                <span class="subtask-nav-status">${escapeHtml(subtask.state?.name || 'Unknown')}</span>
            </div>`;
        });
        navHtml += '</div>';
        subtasksNav.innerHTML = navHtml;
        subtasksNav.style.display = '';
    } else {
        subtasksNav.innerHTML = '';
        subtasksNav.style.display = 'none';
    }
}
```

**Step 6: Render all content into `#tickets-detail-content`** (replace lines 5575-5635):
```javascript
let contentHtml = '';

// Description
if (selectedLinearIssue.renderedDescriptionHtml) {
    contentHtml += selectedLinearIssue.renderedDescriptionHtml;
} else {
    contentHtml += `<p>${escapeHtml((issue.description || '').trim() || 'No description provided.').replace(/\n/g, '<br>')}</p>`;
}

// Comments
if (selectedLinearIssue.comments && selectedLinearIssue.comments.length > 0) {
    contentHtml += '<h3>Comments</h3>';
    contentHtml += selectedLinearIssue.comments.map(comment => `
        <div class="tickets-comment-item">
            <span class="tickets-comment-author">${escapeHtml(comment.user?.name || comment.user?.email || 'Unknown')}</span>
            <span class="tickets-comment-date">${escapeHtml(comment.createdAt ? comment.createdAt.slice(0, 10) : '')}</span>
            <div class="tickets-comment-body">${escapeHtml(comment.body || '').replace(/\n/g, '<br>')}</div>
        </div>
    `).join('');
}

// Attachments
if (selectedLinearIssue.attachments && selectedLinearIssue.attachments.length > 0) {
    contentHtml += '<h3>Attachments</h3>';
    contentHtml += selectedLinearIssue.attachments.map(attachment => `
        <button type="button" class="tickets-attachment-item" data-linear-attachment-url="${escapeAttr(attachment.url || '')}">
            ${escapeHtml(attachment.title || attachment.filename || attachment.url || 'Attachment')}
        </button>
    `).join('');
}

if (_lastTicketsDetailContentHtml !== contentHtml) {
    detailContent.innerHTML = contentHtml;
    _lastTicketsDetailContentHtml = contentHtml;
}
```

**Step 7: Update button states** (keep lines 5637-5649 logic, same as current):
```javascript
if (detailImportButton) { detailImportButton.dataset.importIssueId = issue.id; detailImportButton.disabled = false; }
if (detailRefineButton) { detailRefineButton.dataset.refineIssueId = issue.id; detailRefineButton.dataset.issueTitle = issue.title || ''; detailRefineButton.dataset.issueDescription = issue.description || ''; detailRefineButton.disabled = false; }
if (detailAskAgentButton) { detailAskAgentButton.disabled = false; }
```

### 7. `src/webview/planning.js` — Refactor `renderTicketsClickUpTaskDetail()` (Lines 5966-6096)

**Context**: Same refactoring pattern as Linear, but for ClickUp task details.

**Implementation**: Apply the same 7-step pattern as Change #6, with ClickUp-specific adaptations:
- Destructure new elements (replace line 5969)
- Handle "no task selected" state (replace lines 5972-6001)
- Update banner with `task.title || task.identifier || task.id` (replace lines 6004-6007)
- Handle Back to Parent with `task.parentId` (keep lines 6084-6095 logic)
- Render subtasks navigation with `data-provider="clickup"` and `subtask.status` instead of `subtask.state?.name` (replace lines 6022-6039)
- Render content into `detailContent` with `task.markdownDescription || task.description` and ClickUp comment/attachment structure (replace lines 6009-6069)
- Update button states with `dataset.importTaskId` / `dataset.refineTaskId` (keep lines 6071-6083 logic)

### 8. `src/webview/planning.js` — Add Subtask Navigation Click Handler

**Context**: Clicking a subtask in `#tickets-subtasks-nav` should load that subtask's details. This uses the existing `loadLinearTaskDetails()` (line 6109) and `loadClickUpTaskDetails()` (line 6147) functions.

**Implementation**: Add a delegated click handler on `#tickets-subtasks-nav`, installed once during initialization (near line 5234 where other delegated handlers are set up):
```javascript
document.getElementById('tickets-subtasks-nav')?.addEventListener('click', (e) => {
    const item = e.target.closest('.subtask-nav-item');
    if (!item) return;
    const subtaskId = item.dataset.subtaskId;
    const provider = item.dataset.provider;
    // Highlight selected item
    const nav = document.getElementById('tickets-subtasks-nav');
    nav?.querySelectorAll('.subtask-nav-item').forEach(i => i.classList.remove('selected'));
    item.classList.add('selected');
    if (provider === 'linear') {
        loadLinearTaskDetails(subtaskId);
    } else if (provider === 'clickup') {
        loadClickUpTaskDetails(subtaskId);
    }
});
```

**Edge Cases**:
- The handler is on `#tickets-subtasks-nav`, not on `#preview-pane-tickets`, so it won't conflict with the existing REFINE/IMPORT delegation (line 5234).
- The `.subtask-nav-item` elements use `data-subtask-id` and `data-provider` attributes, not `data-import-issue-id` or `data-refine-issue-id`, so the existing delegation won't accidentally catch these clicks.

### 9. `src/webview/planning.js` — Clean Up Cache Variables (Lines 91-105)

**Context**: Old cache variables for separate sections become redundant. Replace with a single content cache per provider.

**Remove**:
- `_lastTicketsDetailSubtasksHtml` (line 96)
- `_lastTicketsDetailCommentsHtml` (line 97)
- `_lastTicketsDetailAttachmentsHtml` (line 98)
- `_lastTicketsClickUpDetailSubtasksHtml` (line 102)
- `_lastTicketsClickUpDetailCommentsHtml` (line 103)
- `_lastTicketsClickUpDetailAttachmentsHtml` (line 104)

**Add**:
- `_lastTicketsDetailContentHtml = '';` (replaces lines 96-98)
- `_lastTicketsClickUpDetailContentHtml = '';` (replaces lines 102-104)

**Keep**:
- `_lastTicketsDetailDescriptionHtml` (line 95) — can be removed since description is now part of the combined content cache
- `_lastTicketsClickUpDetailDescriptionHtml` (line 101) — same

Actually, since all content now goes into a single `detailContent` div with a single cache variable, both `_lastTicketsDetailDescriptionHtml` and `_lastTicketsClickUpDetailDescriptionHtml` are also redundant. Remove them too and rely solely on `_lastTicketsDetailContentHtml` and `_lastTicketsClickUpDetailContentHtml`.

### 10. `src/webview/planning.js` — Update All References to Removed Elements

**Context**: Any code outside the two render functions that references the old element IDs must be updated.

**Search for and update**:
- `tickets-detail-banner` — replace with `active-doc-banner-tickets`
- `tickets-detail-title` — replace with `active-doc-name-tickets`
- `tickets-detail-description` — replace with `tickets-detail-content`
- `tickets-detail-subtasks` — remove references (subtasks now in `tickets-subtasks-nav`)
- `tickets-detail-comments` — remove references (comments now in `tickets-detail-content`)
- `tickets-detail-attachments` — remove references (attachments now in `tickets-detail-content`)

**Key locations to check**:
- Any `document.getElementById('tickets-detail-banner')` calls outside `getTicketsTabElements()`
- Any `document.getElementById('tickets-detail-title')` calls
- The `#preview-pane-tickets` click delegation handler (line 5234) — verify it still works with new DOM structure

## Edge Cases

- **No subtasks**: `#tickets-subtasks-nav` is hidden (`style.display = 'none'`), preview shows only description/comments/attachments inside `#markdown-preview-tickets`
- **Subtask with no description**: Shows `<p>No description provided.</p>` inside `#markdown-preview-tickets` so it gets proper paragraph styling
- **Deep nesting (subtask of subtask)**: Linear and ClickUp both support arbitrary depth. The "Back to Parent" button always goes up one level. The sidebar continues to show only top-level tasks.
- **Clicking a subtask that is also in the project list**: After ClickUp `parentId` filtering, subtasks won't appear in the sidebar. Linear already filters them. Navigation is parent-first via the subtask nav.
- **Theme switching**: All `#markdown-preview-tickets` selectors respond to `.cyber-theme-enabled` (added in Change #2). The `#preview-pane-tickets` already has cyber grid background support (line 2116).
- **HTML descriptions**: Pre-rendered HTML from APIs is safe to inject into `#markdown-preview-tickets` — child selectors will style it
- **Empty preview state**: When no ticket is selected, `#tickets-empty-preview` (inside `#markdown-preview-tickets`) shows "Select a ticket to preview" with `.empty-state` styling inherited from the `#markdown-preview-tickets .empty-state` selector

## Risks

- **Click handler conflicts**: The existing delegated handler on `#preview-pane-tickets` (line 5234) uses `e.target.closest('[data-import-issue-id], [data-import-task-id]')`. After DOM restructure, the banner action buttons (Import, Refine, Ask Agent, Back to Parent) are still inside `#preview-pane-tickets`, so delegation continues to work. The subtask nav items use different data attributes (`data-subtask-id`, `data-provider`) and a separate handler on `#tickets-subtasks-nav`, so no conflict.
- **State management**: Old cache variables (`_lastTicketsDetailSubtasksHtml`, etc.) are replaced by unified content caches. Must ensure no code path still references the old variables.
- **`#tickets-empty-preview` visibility**: The empty state div is now inside `#markdown-preview-tickets`. When a ticket is selected, JS must hide it (or the content rendering overwrites it). When deselected, JS must restore it.

## Verification Plan

### Automated Tests
- No automated tests to run (skipped per session directive).

### Manual Verification
1. Open the Tickets tab.
2. Verify sidebar shows **only parent tasks** (no subtasks mixed in) for both Linear and ClickUp.
3. Select a parent task with subtasks.
4. Verify:
   - `.active-doc-banner` appears (no `.inactive` class) with ticket title in `.active-doc-name`
   - Status and assignee appear in `.tickets-detail-meta` inside the banner
   - Import, Refine, Ask Agent buttons are visible and enabled in the banner
   - **Subtasks section appears at TOP** of preview as clickable items with status badges
   - Clicking a subtask loads its detail (banner updates, content changes, "Back to Parent" appears)
   - Description uses same typography as Local Docs (headings, lists, code blocks styled)
   - Comments and attachments appear below description with proper heading styles
   - Cyber theme grid/scanlines apply to the preview pane
5. Select a task with no subtasks.
6. Verify no subtasks nav section appears, only description/comments/attachments.
7. Deselect the ticket (click empty area).
8. Verify banner shows `.inactive` state with "None", action buttons hidden, empty state visible.
9. Test with both Linear and ClickUp integrations.
10. Switch to cyber theme and verify all `#markdown-preview-tickets` overrides apply (code glow, blockquote glow, grid background).

---

## Review Findings

**Reviewer**: Direct in-place review executed. HTML and JS changes verified against plan requirements. All 10 planned changes implemented correctly. One padding fix applied.

**Files changed**: `src/webview/planning.html` (removed `#markdown-preview-tickets` from kanban block @line 1126 to restore `padding: 0 26px` matching local docs; all other changes already in place). No JS changes required.

**Validation**: Not run per session directive (SKIP COMPILATION / SKIP TESTS). Manual code-path review confirms no orphaned element references, no missing cache variables, and delegated handlers remain compatible with new DOM structure.

**Remaining risks**: Orphaned `.tickets-section-header` CSS block (plan said keep; not actually used by render functions — harmless dead code). Redundant `#preview-pane-tickets` CSS block at line ~2772 (superseded by `#markdown-preview-tickets` — harmless).
