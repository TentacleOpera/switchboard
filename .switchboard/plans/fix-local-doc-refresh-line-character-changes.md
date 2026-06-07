# Fix Local Doc Refresh Line Character Changes

## Goal

Stop the planning panel preview from re-rendering and causing visible line-length flicker when the underlying markdown file has not actually changed. The `renderMarkdown` function in `planning.js` currently re-renders on every file system event, causing the browser to recalculate text layout and change the apparent character count per line even when the content is identical.

**Root cause:** Three compounding failures: (1) `_handleFetchPreview` unconditionally re-sends content on every file system event with no content-level dedup, (2) `handlePreviewReady` unconditionally replaces `innerHTML` even when content is unchanged, and (3) `renderMarkdown` does not normalize `\r\n` line endings, so identical content with different line-ending representations can produce slightly different HTML output.

## Metadata

**Tags:** bugfix, ui, frontend
**Complexity:** 3

## User Review Required

- Confirm that silently skipping `previewReady` on identical content is acceptable (no "auto-refreshed" status toast when content hasn't changed).
- Confirm that the cache clearing strategy (single-entry cache, cleared on document switch) is acceptable for the single-preview model.

## Complexity Audit

### Routine
- Adding a `Map<string, string>` field and composite key helper to `PlanningPanelProvider.ts`
- Inserting `===` comparison guards before existing `postMessage` calls in three branches
- Adding `\r\n`/`\r` normalization at the top of `renderMarkdown`
- Adding `state.activeDocContent === content` guard in `handlePreviewReady` (two branches)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions**: The 300ms debounce in `_setupActiveDocWatcher` (line 631) already coalesces rapid file system events. The dedup check runs after debounce, so only the final event's content is compared. No new race condition introduced.
- **Security**: No security impact — dedup only skips redundant re-renders of already-approved content.
- **Side Effects**: Skipping `previewReady` means the `isAutoRefreshed` status toast won't fire for unchanged content. This is correct behavior (nothing changed = nothing to notify).
- **Dependencies & Conflicts**: The existing `_lastLocalDocsSignature` dedup in `_sendLocalDocsReady` (line 2142) is unrelated — it deduplicates the *document list*, not the *preview content*. No conflict.

## Dependencies

None

## Adversarial Synthesis

Key risks: (1) html-folder branch sends CSP-injected content, so dedup must compare raw file content before `_injectLocalCsp()` or nonce rotation causes false negatives; (2) design-folder branch in `handlePreviewReady` (line 1869) also unconditionally replaces `innerHTML` and was missing from the original plan. Mitigations: use composite key `${sourceId}:${docId}:${sourceFolder||''}` instead of `_activePreviewPath` (avoids ordering dependency on mutable field), compare pre-CSP raw content for html-folder, add DOM dedup guard to both design-folder and local/online branches.

## Context

During investigation, it was discovered that:

1. **No content deduplication on preview path**: `_sendLocalDocsReady` (in `PlanningPanelProvider.ts`) has content deduplication using `_lastLocalDocsSignature`, but `_handleFetchPreview` and the active document watcher (`_setupActiveDocWatcher`) unconditionally re-fetch and re-send content on every file system event.

2. **Unconditional DOM replacement**: `handlePreviewReady` in `planning.js` unconditionally replaces `innerHTML` with `renderMarkdown(content)`, destroying and recreating the entire DOM tree on every refresh — in both the design-folder branch (line 1871) and the local/online branch (line 2022).

3. **Custom renderer idempotency gap**: `renderMarkdown` does not normalize `\r\n` line endings, so identical content with different line ending representations can produce slightly different HTML output.

## Proposed Changes

### [MODIFY] `src/services/PlanningPanelProvider.ts` — Add content deduplication to preview fetch

In `_handleFetchPreview`, after fetching content, compare with the last sent content for **that specific document** and skip sending if identical.

**Add a new field (near line 57, alongside `_lastLocalDocsSignature`):**
```typescript
private _lastPreviewContentByPath: Map<string, string> = new Map();
```

**Add a helper method:**
```typescript
private _getPreviewCacheKey(sourceId: string, docId: string, sourceFolder?: string): string {
    return `${sourceId}:${docId}:${sourceFolder || ''}`;
}
```

> **Clarification:** Uses explicit composite key rather than `_activePreviewPath` to avoid ordering dependency on when that mutable field is set in each branch.

**Clear stale entries at the top of `_handleFetchPreview` (after line 2410):**
```typescript
const currentKey = this._getPreviewCacheKey(sourceId, docId, sourceFolder);
for (const key of this._lastPreviewContentByPath.keys()) {
    if (key !== currentKey) {
        this._lastPreviewContentByPath.delete(key);
    }
}
```

> **Intentional:** Single-entry cache is sufficient for the single-preview model. Navigating A → B → A will re-render A on return, which is correct since the panel state was destroyed.

**In the html-folder branch — after reading raw file content (line 2464), BEFORE `_injectLocalCsp`:**
```typescript
const htmlContent = await fs.promises.readFile(resolvedPath, 'utf8');

// Dedup: compare raw content before CSP injection (nonce may rotate)
const cacheKey = this._getPreviewCacheKey(sourceId, docId, sourceFolder);
const lastContent = this._lastPreviewContentByPath.get(cacheKey);
if (htmlContent === lastContent) {
    return;
}
this._lastPreviewContentByPath.set(cacheKey, htmlContent);

const htmlWithCsp = this._injectLocalCsp(htmlContent);
// ... existing postMessage
```

> **Critical:** Must compare raw `htmlContent` before `_injectLocalCsp()`. The CSP injection includes a nonce that may rotate, causing false negatives if compared post-injection.

**In the design-folder branch — after reading file content (line 2542), before postMessage:**
```typescript
const docContent = await fs.promises.readFile(resolvedPath, 'utf8');

const cacheKey = this._getPreviewCacheKey(sourceId, docId, sourceFolder);
const lastContent = this._lastPreviewContentByPath.get(cacheKey);
if (docContent === lastContent) {
    return;
}
this._lastPreviewContentByPath.set(cacheKey, docContent);

this._panel?.webview.postMessage({ ... });
```

**In the local-folder branch — after `fetchDocContent` succeeds (line 2577), before postMessage:**
```typescript
if (result.success) {
    const resolvedPath = path.resolve(path.join(sourceFolder, cleanDocId));
    // ... existing _activePreview* assignments and _setupActiveDocWatcher ...

    const cacheKey = this._getPreviewCacheKey(sourceId, docId, sourceFolder);
    const lastContent = this._lastPreviewContentByPath.get(cacheKey);
    if (result.content === lastContent) {
        return;
    }
    this._lastPreviewContentByPath.set(cacheKey, result.content || '');

    this._panel?.webview.postMessage({ ... });
}
```

### [MODIFY] `src/webview/planning.js` — Normalize line endings in `renderMarkdown`

**In `renderMarkdown` (line 423), at the top, BEFORE HTML escaping:**
```javascript
function renderMarkdown(markdown) {
    if (!markdown) return '';

    // Normalize line endings to prevent layout differences
    let processed = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Escape HTML first
    processed = processed
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // ... rest of existing logic unchanged
```

### [MODIFY] `src/webview/planning.js` — Add DOM-level deduplication in `handlePreviewReady`

**In the design-folder branch (before line 1869), add content guard:**
```javascript
// Skip re-render if content hasn't changed (prevents line-length flicker)
if (state.activeDocContent === (content || '') && !isImage) {
    if (isAutoRefreshed) {
        const statusDesign = document.getElementById('status-design');
        if (statusDesign) {
            statusDesign.textContent = (docName || 'Loaded') + ' — auto-refreshed';
            statusDesign.style.color = 'var(--accent-teal)';
        }
    }
    return;
}
```

**In the local/online branch (before line 2020), add content guard AFTER the edit-mode check (line 2008-2018):**
```javascript
// Skip re-render if content hasn't changed (prevents line-length flicker)
if (state.activeDocContent === content) {
    if (msg.isAutoRefreshed) {
        targetStatus.textContent = 'Externally updated — refreshed';
        setTimeout(() => { if (targetStatus.textContent === 'Externally updated — refreshed') targetStatus.textContent = ''; }, 2000);
    }
    return;
}
```

> **Note:** The frontend `activeDocContent === content` check is a secondary defense. The primary dedup is in the backend (`_handleFetchPreview`). The frontend guard catches any edge case where the backend sends identical content (e.g., if the backend dedup is bypassed for a new requestId). Line-ending mismatches that pass the backend but fail the frontend are a non-issue because the backend compares the same raw file bytes each time.

## Edge Cases

- **File recreated from scratch (agent rewrite)**: The watcher fires `onDidCreate` when a file is deleted and recreated. Content is re-read and compared. If the recreated file has identical content, the preview already shows the correct text — skipping the re-render is correct. If the content changed, the comparison fails and the preview updates immediately. The `onDidCreate` → `_handleFetchPreview` path remains fully intact.
- **File modified externally while user is editing**: The existing edit-mode conflict detection (lines 2008-2018 for local, lines 1879-1886 for design) already handles this by showing a warning and returning early. The deduplication check runs after those guards, so it never clobbers an active editor.
- **Document switching**: The cache is keyed by `${sourceId}:${docId}:${sourceFolder||''}`, so switching from doc A → doc B → back to doc A does not cause false positives. Stale entries are cleared on each `_handleFetchPreview` call.
- **Empty file to non-empty file**: The Map stores empty string `''` for empty files; on first load the key won't exist, so empty files render correctly.
- **Multiple rapid file system events**: The 300ms debounce in `_setupActiveDocWatcher` already coalesces rapid events; deduplication handles the final event.
- **html-folder with CSP nonce rotation**: Raw content is compared before `_injectLocalCsp()`, so nonce changes do not cause false negatives.
- **Image files**: The html-folder and design-folder branches have early returns for image files (before content comparison). Images always re-render via cache-busted URL, which is correct since binary content can't be string-compared.

## Verification Plan

### Automated Tests
- Verify `renderMarkdown('line1\r\nline2')` produces identical output to `renderMarkdown('line1\nline2')`.
- Verify `_handleFetchPreview` does not post `previewReady` when content is identical for the same document.
- Verify `_handleFetchPreview` still posts `previewReady` when switching to a different document.
- Verify `handlePreviewReady` does not modify DOM when `state.activeDocContent` matches incoming `content` (both design-folder and local/online branches).

### Manual Tests
1. Open a local markdown file in the planning panel preview.
2. Note the line wrapping / character count at a specific viewport width.
3. Trigger a file system event on that file (e.g., save without changes, or touch the file).
4. **Verify:** The preview does not flicker and line lengths remain stable.
5. Make an actual change to the file and save.
6. **Verify:** The preview updates correctly with the new content.
7. Repeat steps 1-6 with a design-folder document.

## Success Criteria
1. Identical file content does not trigger a `previewReady` message from the backend.
2. When `previewReady` is received with identical content, the DOM is not modified (both design-folder and local/online branches).
3. `renderMarkdown` normalizes `\r\n` and `\r` to `\n` before processing.
4. Actual content changes still render correctly and immediately.
5. No regression in edit-mode conflict detection behavior.
6. html-folder dedup works correctly even when CSP nonce rotates.

---

**Recommendation:** Send to Coder (complexity 3).
