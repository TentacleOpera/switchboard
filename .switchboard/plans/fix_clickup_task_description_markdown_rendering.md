# Fix ClickUp Task Description Markdown Rendering

## Goal
Render ClickUp task descriptions as formatted markdown instead of raw markdown text wrapped in `<pre>` tags, matching the already-completed Linear sidebar markdown rendering.

## Metadata
**Tags:** frontend, UI, bugfix
**Complexity:** 3

## User Review Required
No. This is a UI bugfix that reuses the established Linear markdown rendering pattern. No product or design review needed.

## Complexity Audit
### Routine
Single-provider, two-file change reusing established `markdown.api.render` pattern and `.markdown-body` CSS. No new dependencies or architectural patterns. Complexity: 3.

### Complex / Risky
- None

## Motivation
ClickUp task descriptions are stored as markdown (`markdownDescription`). Currently, the sidebar Project tab displays them inside `<pre>` tags with `escapeHtml()`, so users see raw markdown syntax like `## Epic Goal`, `**bold**`, and `[links](url)`. This looks unprofessional and is hard to read. The Linear detail view already renders markdown via `renderedDescriptionHtml` + `.markdown-body` CSS — ClickUp needs the same treatment.

## Edge-Case & Dependency Audit
- **Security:** VS Code's `markdown.api.render` command sanitizes HTML (strips `<script>`, `javascript:` URLs, etc.). Same trusted path used by `ReviewProvider.ts` and the existing Linear rendering.
- **Side Effects:** None. The old `<pre>${escapeHtml(...)}</pre>` path becomes a backward-compatible fallback when `renderedDescriptionHtml` is absent.
- **Dependencies:** The `.markdown-body` CSS class already exists in `implementation.html` (lines 1484–1544) from the Linear markdown rendering work. No new CSS needed.
- **ClickUp API:** `ClickUpSyncService.getTaskDetails()` already returns `markdownDescription` (mapped from `raw.markdown_description`).

## Dependencies
None. Self-contained change using existing ClickUp service, VS Code `markdown.api.render` command, and `.markdown-body` CSS.

## Adversarial Synthesis
Key risks: (1) Plan documents already-implemented code, creating confusion about execution status. (2) No automated test coverage for `TaskViewerProvider` sidebar rendering paths. (3) Pre-existing cache invalidation bug: `_lastClickUpDetailDescriptionHtml` is not reset when `selectedClickUpIssue` is cleared, which can prevent description re-rendering on task re-selection. Mitigations: Relabel plan to reflect completed state; verify manually; consider separate fix for cache bug.

## Proposed Changes

### TaskViewerProvider.ts
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** The `clickupLoadTaskDetails` handler at line 7405 sends a `clickupTaskDetailsLoaded` message. It needs a `renderedDescriptionHtml` field containing VS Code-rendered markdown HTML for the task description.
- **Logic:**
  1. Before posting the message, call `vscode.commands.executeCommand<string>('markdown.api.render', markdownDescription)` to render the task description to HTML.
  2. Wrap in try/catch. If the command throws, fall back to a `<pre>`-wrapped plain-text escape (same pattern as Linear fix).
  3. Add `renderedDescriptionHtml` to the existing message payload.

At line 7417–7425, change:
```typescript
const details = await clickUp.getTaskDetails(data.taskId);
this._view?.webview.postMessage({
    type: 'clickupTaskDetailsLoaded',
    task: this._mapClickUpTaskToSidebar(details.task),
    subtasks: details.subtasks.map(s => this._mapClickUpTaskToSidebar(s)),
    comments: details.comments.map(c => this._mapClickUpComment(c)),
    attachments: details.attachments.map(a => this._mapClickUpAttachment(a))
});
```

To:
```typescript
const details = await clickUp.getTaskDetails(data.taskId);

// Render markdown description to HTML using VS Code's built-in renderer
let renderedDescriptionHtml = '';
try {
    const descriptionMd = (details.task.markdownDescription || details.task.description || '').trim() || 'No description provided.';
    renderedDescriptionHtml = await vscode.commands.executeCommand<string>('markdown.api.render', descriptionMd) || '';
} catch {
    const descriptionText = (details.task.markdownDescription || details.task.description || '').trim() || 'No description provided.';
    renderedDescriptionHtml = `<pre>${descriptionText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
}

this._view?.webview.postMessage({
    type: 'clickupTaskDetailsLoaded',
    task: this._mapClickUpTaskToSidebar(details.task),
    subtasks: details.subtasks.map(s => this._mapClickUpTaskToSidebar(s)),
    comments: details.comments.map(c => this._mapClickUpComment(c)),
    attachments: details.attachments.map(a => this._mapClickUpAttachment(a)),
    renderedDescriptionHtml
});
```

### implementation.html — JavaScript
#### [MODIFY] `src/webview/implementation.html`
- **Context:** The `clickupTaskDetailsLoaded` handler at line 2840 stores the selected task. The `renderSidebarClickUpTaskDetail()` function at line 4026 renders the description using `<pre>${escapeHtml(...)}</pre>`.

**Step 1:** Update `clickupTaskDetailsLoaded` handler (around line 2870) to store `renderedDescriptionHtml`:

Change:
```javascript
selectedClickUpIssue = {
    task: message.task,
    subtasks: Array.isArray(message.subtasks) ? message.subtasks : [],
    comments: Array.isArray(message.comments) ? message.comments : [],
    attachments: Array.isArray(message.attachments) ? message.attachments : []
};
```

To:
```javascript
selectedClickUpIssue = {
    task: message.task,
    subtasks: Array.isArray(message.subtasks) ? message.subtasks : [],
    comments: Array.isArray(message.comments) ? message.comments : [],
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    renderedDescriptionHtml: message.renderedDescriptionHtml || ''
};
```

**Step 2:** Update `renderSidebarClickUpTaskDetail()` at line 4051–4053:

Change:
```javascript
const descHtml = task.markdownDescription
    ? `<pre>${escapeHtml(task.markdownDescription)}</pre>`
    : (task.description ? `<pre>${escapeHtml(task.description)}</pre>` : '<p>No description provided.</p>');
```

To:
```javascript
let descHtml;
if (selectedClickUpIssue.renderedDescriptionHtml) {
    descHtml = selectedClickUpIssue.renderedDescriptionHtml;
} else {
    // Fallback: backward-compatible plain-text rendering
    descHtml = task.markdownDescription
        ? `<pre>${escapeHtml(task.markdownDescription)}</pre>`
        : (task.description ? `<pre>${escapeHtml(task.description)}</pre>` : '<p>No description provided.</p>');
}
```

Then add/remove the `.markdown-body` class when assigning to `detailDescription`:

Change:
```javascript
if (_lastClickUpDetailDescriptionHtml !== descHtml && detailDescription) {
    detailDescription.innerHTML = descHtml;
    _lastClickUpDetailDescriptionHtml = descHtml;
}
```

To:
```javascript
if (_lastClickUpDetailDescriptionHtml !== descHtml && detailDescription) {
    detailDescription.innerHTML = descHtml;
    _lastClickUpDetailDescriptionHtml = descHtml;
    if (selectedClickUpIssue.renderedDescriptionHtml) {
        detailDescription.classList.add('markdown-body');
    } else {
        detailDescription.classList.remove('markdown-body');
    }
}
```

## Acceptance Criteria
- [x] ClickUp task descriptions in the sidebar display as formatted markdown (headings, bold, italic, links, lists, code blocks) — *Implemented in `TaskViewerProvider.ts` and `implementation.html`*
- [x] Raw markdown syntax is not visible in the detail view — *Verified by code inspection*
- [x] Card list descriptions remain as plain text (no markdown rendering) — *Card list uses separate `renderSidebarClickUpProjectList()` path*
- [x] Styling matches the existing dark theme via `.markdown-body` — *CSS already present in `implementation.html`*
- [x] Long descriptions are scrollable (`max-height: 300px` with `overflow-y: auto` from existing CSS) — *Existing CSS applies*
- [x] Falls back to `<pre>`-escaped plain text if `renderedDescriptionHtml` is absent — *Fallback implemented in provider try/catch*
- [x] No XSS vulnerabilities (HTML sanitized by VS Code's markdown renderer) — *Uses same trusted path as Linear and `ReviewProvider`*

## Verification Plan
### Automated Tests
None. `TaskViewerProvider` and `implementation.html` currently have no automated test coverage. Regression testing for this change is manual.

### Manual Tests
1. Open sidebar → Project tab → ClickUp → Select a task with markdown description (e.g., one with `## headings` and `**bold**`)
2. Verify description shows rendered markdown, not raw text
3. Select a task with an empty description → verify "No description provided." placeholder
4. Select a task with a very long description → verify scrolling works
5. Verify card list still shows plain text descriptions
6. Verify import and "Send to Planner" buttons still function
7. Select a task, click Back, then re-select the same task → verify description re-renders correctly

## Files Changed
- `src/services/TaskViewerProvider.ts` — Add `renderedDescriptionHtml` field to `clickupTaskDetailsLoaded` message
- `src/webview/implementation.html` — Store `renderedDescriptionHtml` in `selectedClickUpIssue`; update `renderSidebarClickUpTaskDetail()` to use rendered HTML with `.markdown-body` class toggle

---

**Recommendation:** Send to Coder. Implementation is already complete; remaining work is manual verification and addressing the pre-existing `_lastClickUpDetailDescriptionHtml` cache invalidation bug.
