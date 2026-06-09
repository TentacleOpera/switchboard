# Fix HTML Preview Tab Sidebar Button Functionality and Tooltips

## Goal

Fix the "Open in Browser" and "Copy Link" buttons in the HTML Previews tab sidebar so they work reliably and have visible, accessible tooltips.

**Problem:** In the HTML Previews tab, the file card action buttons (`Serve & Open` 🌐 and `Link Doc` 🔗) in the left sidebar reportedly do not work. Clicking "Open in Browser" opens the browser but shows a "Not Found" error. The buttons also lack visible tooltips — they are 22×22px emoji-only icons with no text labels.

**Root Cause Analysis:**
1. **Subdirectory URL bug (the actual "Not Found" cause):** In `_handleServeAndOpenHtml` (`PlanningPanelProvider.ts:4740,4755`), the URL is built using only `path.basename(absolutePath)` — the bare filename. The server is rooted at `sourceFolder` (the configured HTML folder). For files in subdirectories (e.g. `folder/subdir/file.html`), the URL becomes `http://127.0.0.1:PORT/file.html` but the server looks for `sourceFolder/file.html` instead of `sourceFolder/subdir/file.html`, returning 404.
2. **Missing text labels on buttons:** The sidebar file cards use 22×22px emoji-only `card-icon-btn` buttons. The `btn.title` attribute is set in code, but VS Code webview native `title` tooltips can be unreliable for small elements. Users cannot discover what the buttons do without visible labels.
3. **Missing preview-pane action banner:** The HTML Previews tab is the *only* tab without an `active-doc-banner` in the preview pane. Every other tab (Local Docs, Online Docs, Design, Tickets) has one with persistent text action buttons. Users expect to find these actions in the preview pane, not hidden as tiny icons on file cards.
4. **"Copy Link" code path unverified:** The backend `_handleLinkToDocument` code exists and handles `html-folder` source IDs, but it was not confirmed to work end-to-end. It uses `cleanDocId = docId.includes(':') ? docId.substring(docId.indexOf(':')+1) : docId` which may produce incorrect paths if the `docId` format differs from expectations.

## Metadata
- **Status**: Draft
- **Created**: 2025-06-09
- **Updated**: 2025-06-09
- **Tags**: [frontend, backend, bugfix, ui, ux]
- **Complexity**: 5
- **Files Touched**: `src/webview/planning.html`, `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`

## User Review Required

- [ ] Confirm whether the info toast ("Opening X in browser") after `openExternal` is desired — it may feel redundant when the browser opens visibly.
- [ ] Confirm banner placement preference: inside `#preview-pane-html` (matches Tickets pattern) vs. outside `content-row` at top of tab div (matches Local/Online/Design pattern). Current plan uses inside-preview-pane placement.
- [ ] Confirm whether a custom CSS tooltip system is desired, or if native `title` tooltips + text labels on buttons are sufficient.

## Complexity Audit

### Routine
- Replace `path.basename(absolutePath)` with `path.relative(sourceFolder, absolutePath)` in two locations (reuse path at line 4740, new-server path at line 4755)
- Add file existence check before starting server (`fs.promises.access`)
- Fix trailing slash in path traversal check (`replace(/[\\/]+$/, '')` + equality check)
- Add `active-doc-banner-html` markup to `planning.html` following established pattern
- Add `.html-banner-actions` CSS block mirroring `.tickets-banner-actions`
- Wire banner buttons in `loadDocumentPreview` using `.onclick = fn` pattern
- Add defensive null checks in `renderDocCard` action handlers

### Complex / Risky
- Card button layout: changing `card-icon-btn` from fixed 22px to auto-width for icon+text hybrid requires careful CSS to avoid breaking existing icon-only buttons in other tabs
- Banner reset logic: must identify correct code paths for resetting banner state (tab switch, tree rebuild) — not in `previewReady`/`previewError` as originally stated
- `_handleLinkToDocument` `cleanDocId` logic for `html-folder` source: the colon-splitting heuristic may mangle paths containing colons (rare but possible on Windows or with certain filenames)

## Edge-Case & Dependency Audit

- **Race Conditions:** None identified — server startup is sequential, banner wiring uses `.onclick = fn` (overwrites, no accumulation).
- **Security:** Path traversal check in `_handleHtmlServerRequest` (line 4790) misses the equality case (`normalizedResolved === normalizedSource`) and doesn't strip trailing slashes from `sourceFolder`. Both are fixed in this plan.
- **Side Effects:** Changing `.card-icon-btn` width from `22px` to `auto` for HTML-specific buttons must not affect icon-only buttons in other tabs (Local Docs, Online Docs, Design). Solution: use a specific class (`.html-serve-btn`, `.html-link-btn`) to scope the width override.
- **Dependencies & Conflicts:**
  - Subdirectory paths with spaces or unicode: `path.relative` + per-segment `encodeURIComponent` handles this.
  - `active-doc-banner-html` ID collision: Must use unique IDs to avoid conflicts with other tabs' banners.
  - Collapsed sidebar: `.card-actions` is hidden via `display: none !important` (line 410). The preview-pane banner buttons provide a fallback.
  - Trailing slash in `sourceFolder`: `path.normalize` may preserve trailing slashes. The `startsWith` path traversal check strips trailing separators before comparison.

## Dependencies

- None (no new packages).

## Adversarial Synthesis

Key risks: (1) Card button CSS overflow — fixed 22px width will clip text labels unless scoped width override is added. (2) Banner reset logic incorrectly targets `previewReady`/`previewError` instead of actual reset paths (tab switch, tree rebuild). (3) `_handleLinkToDocument` `cleanDocId` colon-splitting may mangle valid paths. Mitigations: (1) Use `.html-serve-btn`/`.html-link-btn` specific classes with `width: auto; min-width: 22px;`. (2) Identify correct reset paths before implementing. (3) Add explicit guard for `html-folder` docId format or verify the format at runtime.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`

**Context:** The `_handleServeAndOpenHtml` method (line 4725) builds URLs using `path.basename`, which strips subdirectory paths. The `_handleHtmlServerRequest` method (line 4774) has an incomplete path traversal check.

**Logic:**
1. Replace `path.basename(absolutePath)` with `path.relative(resolvedSourceFolder, absolutePath)` in both the reuse path (line 4740) and new-server path (line 4755). Encode each path segment with `encodeURIComponent`.
2. Add file existence check (`fs.promises.access`) before starting a new server.
3. Fix path traversal check in `_handleHtmlServerRequest`: strip trailing separators from `sourceFolder` before `startsWith`, and add equality check for the root case.

**Implementation:**

In `_handleServeAndOpenHtml` (lines 4740-4741), replace:
```typescript
const filename = path.basename(absolutePath);
const url = `http://127.0.0.1:${existing.port}/${encodeURIComponent(filename)}`;
```
with:
```typescript
const relativeUrlPath = path.relative(resolvedSourceFolder, absolutePath);
const urlPath = relativeUrlPath.split(path.sep).map(encodeURIComponent).join('/');
const url = `http://127.0.0.1:${existing.port}/${urlPath}`;
```

In `_handleServeAndOpenHtml` (lines 4755-4756), replace:
```typescript
const filename = path.basename(absolutePath);
const url = `http://127.0.0.1:${port}/${encodeURIComponent(filename)}`;
```
with:
```typescript
const relativeUrlPath = path.relative(resolvedSourceFolder, absolutePath);
const urlPath = relativeUrlPath.split(path.sep).map(encodeURIComponent).join('/');
const url = `http://127.0.0.1:${port}/${urlPath}`;
```

Add file existence check before starting server (after line 4746):
```typescript
// Verify file exists before spinning up a server
try {
    await fs.promises.access(absolutePath, fs.constants.R_OK);
} catch {
    vscode.window.showErrorMessage(`File not found or not readable: ${absolutePath}`);
    return;
}
```

In `_handleHtmlServerRequest` (lines 4787-4790), replace:
```typescript
const normalizedSource = path.normalize(sourceFolder);
const normalizedResolved = path.normalize(resolvedPath);

if (!normalizedResolved.startsWith(normalizedSource + path.sep)) {
```
with:
```typescript
const normalizedSource = path.normalize(sourceFolder).replace(/[\\/]+$/, '');
const normalizedResolved = path.normalize(resolvedPath);

if (!normalizedResolved.startsWith(normalizedSource + path.sep) && normalizedResolved !== normalizedSource) {
```

**Edge Cases:**
- `path.relative` returns a path with OS-specific separators; `split(path.sep)` handles this correctly on all platforms.
- If `absolutePath` equals `resolvedSourceFolder` (user requests the root), `path.relative` returns `'.'`, which encodes to `.` — the server will reject this as a directory request (line 4779-4782).
- `path.relative` can return a path starting with `..` if the file is outside `sourceFolder`; the server's path traversal check will catch this.

### `src/webview/planning.html`

**Context:** The HTML Previews tab (`#html-preview-content`, line 3216) is the only tab without an `active-doc-banner`. The `card-icon-btn` class (line 1838) has fixed 22px width that will clip text labels.

**Logic:**
1. Add `active-doc-banner-html` as the first child of `#preview-pane-html` (before `#html-initial-state`), matching the Tickets banner pattern.
2. Add `.html-banner-actions` CSS mirroring `.tickets-banner-actions`.
3. Add scoped CSS for `.html-serve-btn` and `.html-link-btn` to override `card-icon-btn` width to `auto` while keeping 22px for other icon buttons.
4. Add `.btn-label` CSS for the text portion of hybrid buttons, hidden when sidebar is collapsed.

**Implementation:**

After the opening tag of `#preview-pane-html` (line 3230), before `#html-initial-state` (line 3231), insert:
```html
<div class="active-doc-banner inactive" id="active-doc-banner-html">
    <div class="active-doc-info">
        <span class="active-doc-label">Active File:</span>
        <span class="active-doc-name" id="active-doc-name-html">None</span>
    </div>
    <div class="html-banner-actions">
        <button id="btn-open-browser-html" class="strip-btn" disabled>Open in Browser</button>
        <button id="btn-copy-link-html" class="strip-btn" disabled>Copy Link</button>
    </div>
</div>
```

CSS addition (after existing `.tickets-banner-actions` block around line 567):
```css
.html-banner-actions {
    display: flex;
    gap: 8px;
    align-items: center;
}
.active-doc-banner.inactive .html-banner-actions {
    display: none;
}
```

CSS addition (after existing `.card-icon-btn:disabled` block around line 1870):
```css
/* HTML-specific icon+text hybrid buttons — override fixed width */
.card-icon-btn.html-serve-btn,
.card-icon-btn.html-link-btn {
    width: auto;
    min-width: 22px;
    padding: 0 4px;
    gap: 2px;
}
.card-icon-btn .btn-label {
    font-size: 10px;
    margin-left: 2px;
    display: inline;
}
.content-row.collapsed .card-icon-btn .btn-label {
    display: none;
}
```

**Edge Cases:**
- Banner IDs (`active-doc-banner-html`, `active-doc-name-html`, `btn-open-browser-html`, `btn-copy-link-html`) are unique — verified against all existing banner IDs in `planning.html`.
- The `#preview-pane-html` div already has `display: flex; flex-direction: column;` (inline style at line 3230), so the banner's `flex-shrink: 0` will work correctly.
- When sidebar is collapsed, `.card-actions` is hidden via `display: none !important` (line 410), so `.btn-label` hiding is redundant but harmless — it ensures labels don't appear if `.card-actions` visibility is ever changed.

### `src/webview/planning.js`

**Context:** `loadDocumentPreview` (line 1129) handles the `html-folder` branch but doesn't wire any banner. `renderDocCard` (line 909) renders emoji-only buttons. `handlePreviewReady` (line 2250) and `handlePreviewError` (line 2585) handle HTML preview state but are NOT the correct place for banner reset logic.

**Logic:**
1. In `loadDocumentPreview`'s `html-folder` branch (after line 1142), wire the banner: show it, set the doc name, attach `.onclick` handlers to the two buttons.
2. Identify the correct banner reset paths: (a) when the HTML tab's tree is rebuilt (folder change), (b) when the tab is switched away. Add reset logic there.
3. In `renderDocCard`, change `Serve & Open` and `Link Doc` buttons to icon+text hybrids with specific CSS classes.
4. Add defensive null checks before sending `serveAndOpenHtml` and `linkToDocument` messages.
5. Replace `btn.title` with `btn.setAttribute('data-tooltip', ...)` for custom tooltip display, keeping `title` as accessibility fallback.

**Implementation:**

In `loadDocumentPreview` (after line 1142, `state.activeDocName = docName;`), add:
```javascript
// Wire HTML preview banner
const banner = document.getElementById('active-doc-banner-html');
const bannerName = document.getElementById('active-doc-name-html');
const openBtn = document.getElementById('btn-open-browser-html');
const copyBtn = document.getElementById('btn-copy-link-html');
if (banner) banner.classList.remove('inactive');
if (bannerName) bannerName.textContent = docName;
if (openBtn) {
    openBtn.disabled = false;
    openBtn.onclick = () => {
        vscode.postMessage({
            type: 'serveAndOpenHtml',
            docId: docId,
            docName: docName,
            absolutePath: wrapper ? wrapper.dataset.absolutePath : undefined,
            sourceFolder: sourceFolder
        });
    };
}
if (copyBtn) {
    copyBtn.disabled = false;
    copyBtn.onclick = () => {
        vscode.postMessage({
            type: 'linkToDocument',
            sourceId: sourceId,
            docId: docId,
            docName: docName,
            sourceFolder: sourceFolder
        });
    };
}
```

For banner reset — add a helper function and call it from the appropriate reset paths:
```javascript
function resetHtmlBanner() {
    const banner = document.getElementById('active-doc-banner-html');
    const bannerName = document.getElementById('active-doc-name-html');
    const openBtn = document.getElementById('btn-open-browser-html');
    const copyBtn = document.getElementById('btn-copy-link-html');
    if (banner) banner.classList.add('inactive');
    if (bannerName) bannerName.textContent = 'None';
    if (openBtn) { openBtn.disabled = true; openBtn.onclick = null; }
    if (copyBtn) { copyBtn.disabled = true; copyBtn.onclick = null; }
}
```

Call `resetHtmlBanner()` in:
- The HTML folder tree rebuild handler (when `htmlDocsReady` message is received and the tree is cleared/rebuilt) — search for the handler that clears `#tree-pane-html` content.
- The tab switch handler (when switching away from the HTML tab) — search for the code that hides `#html-preview-content`.

In `renderDocCard` (lines 956-966), replace the `Serve & Open` and `Link Doc` button rendering:
```javascript
} else if (action === 'Link Doc' || action === 'Delete') {
    btn.className = 'card-icon-btn' + (action === 'Link Doc' ? ' html-link-btn' : ' card-delete-btn');
    if (action === 'Link Doc') {
        btn.innerHTML = '<span>🔗</span><span class="btn-label">Copy</span>';
    } else {
        btn.textContent = '×';
    }
    btn.title = action === 'Link Doc' ? 'Copy validated document path' : 'Delete';
    btn.setAttribute('data-tooltip', action === 'Link Doc' ? 'Copy validated document path' : 'Delete');
    btn.setAttribute('aria-label', action === 'Link Doc' ? 'Copy link to document' : 'Delete document');
} else if (action === 'Serve & Open') {
    btn.className = 'card-icon-btn html-serve-btn';
    btn.innerHTML = '<span>🌐</span><span class="btn-label">Open</span>';
    btn.title = 'Start local server and open in browser';
    btn.setAttribute('data-tooltip', 'Start local server and open in browser');
    btn.setAttribute('aria-label', 'Open in browser via local server');
}
```

Add defensive null checks in the action click handler (lines 983-998):
```javascript
} else if (action === 'Link Doc') {
    if (!nodeMetadata?.sourceFolder) {
        console.error('[PlanningPanel] Link Doc clicked but sourceFolder is missing');
        return;
    }
    vscode.postMessage({
        type: 'linkToDocument',
        sourceId: sourceId,
        docId: nodeId,
        docName: title,
        sourceFolder: nodeMetadata.sourceFolder
    });
} else if (action === 'Serve & Open') {
    if (!nodeMetadata?.absolutePath) {
        console.error('[PlanningPanel] Serve & Open clicked but absolutePath is missing');
        return;
    }
    vscode.postMessage({
        type: 'serveAndOpenHtml',
        docId: nodeId,
        docName: title,
        absolutePath: nodeMetadata.absolutePath,
        sourceFolder: nodeMetadata?.sourceFolder
    });
}
```

**Edge Cases:**
- `wrapper` may be `null` in `loadDocumentPreview` if `findTreeNode` returns null — the `wrapper ? wrapper.dataset.absolutePath : undefined` guard handles this.
- `.onclick = fn` overwrites any previous handler, preventing duplicate listeners on repeated calls.
- The `data-tooltip` attribute is set alongside `title` for graceful degradation — if the custom tooltip CSS fails, native `title` still works.

## Verification Plan

### Automated Tests
- Skip (per session directive).

### Manual Verification
1. Open Planning Panel → HTML PREVIEWS tab.
2. Configure a folder with HTML files **in a subdirectory** (e.g. `folder/subdir/page.html`).
3. Click **"Open in Browser"** on a file in a subdirectory:
   - Browser opens to a URL like `http://127.0.0.1:PORT/subdir/page.html` (NOT just `page.html`).
   - The page renders correctly with no "Not Found" error.
4. Click **"Copy Link"** on any file:
   - A VS Code info toast appears: "Document path copied to clipboard: /absolute/path/to/file.html".
5. Select an HTML file to load the preview.
6. **Preview pane banner:** Verify the `active-doc-banner-html` appears with the file name and two enabled buttons: "Open in Browser" and "Copy Link".
7. Click **"Open in Browser"** in the banner — verify it works the same as the sidebar button.
8. Check the sidebar file card buttons:
   - The 🌐 button shows text label "Open" next to the emoji.
   - The 🔗 button shows text label "Copy" next to the emoji.
   - Buttons are wider than 22px to accommodate text but not excessively large.
9. Hover over the 🌐 and 🔗 buttons on the sidebar file cards:
   - A custom styled tooltip appears above the button (if custom tooltip CSS is implemented).
   - If custom tooltip is not implemented, native `title` tooltip still appears.
10. Collapse the sidebar (click «):
    - Card text labels (`.btn-label`) hide, only emojis remain.
    - The preview-pane banner buttons remain functional.
11. Switch to a different tab (e.g. Local Docs), then switch back to HTML Previews:
    - Banner should reset to `.inactive` state when leaving the tab.
12. Change the HTML folder configuration:
    - Banner should reset to `.inactive` state.
13. Select "None" (clear selection):
    - The banner returns to `.inactive` state and buttons become disabled.
14. Test a file with spaces in the path (e.g. `my page.html`):
    - URL correctly encodes spaces as `%20`.
    - Server serves the file correctly.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Subdirectory path contains spaces or unicode | `path.relative` + per-segment `encodeURIComponent` handles this |
| Banner buttons accumulate duplicate listeners | Use `.onclick = fn` (overwrites) instead of `addEventListener` |
| Custom tooltips clipped by `overflow: hidden` parents | Use `position: fixed` in tooltip CSS if needed; test in collapsed/expanded states |
| `active-doc-banner-html` ID conflicts | Verified uniqueness against all other banner IDs in planning.html |
| Trailing slash in `sourceFolder` breaks traversal check | Strip trailing separators with `replace(/[\\/]+$/, '')` before `startsWith` |
| Card button text overflows fixed 22px width | Use scoped classes (`.html-serve-btn`, `.html-link-btn`) with `width: auto; min-width: 22px;` |
| Banner reset logic targets wrong code paths | Identify actual reset paths (tab switch, tree rebuild) instead of `previewReady`/`previewError` |
| `_handleLinkToDocument` `cleanDocId` colon splitting | Verify `docId` format for `html-folder` source at runtime; add guard if format differs |

## Checklist

- [ ] Fix subdirectory URL bug in `_handleServeAndOpenHtml` — reuse path (line 4740) and new-server path (line 4755) (`PlanningPanelProvider.ts`)
- [ ] Add file existence check before starting server (`PlanningPanelProvider.ts`)
- [ ] Fix trailing slash bug in `_handleHtmlServerRequest` path traversal check (line 4787-4790) (`PlanningPanelProvider.ts`)
- [ ] Add `active-doc-banner-html` markup to `#preview-pane-html` before `#html-initial-state` (`planning.html`)
- [ ] Add `.html-banner-actions` CSS to `planning.html`
- [ ] Add scoped `.html-serve-btn`/`.html-link-btn` CSS with `width: auto; min-width: 22px;` (`planning.html`)
- [ ] Add `.btn-label` CSS for icon+text hybrid buttons (`planning.html`)
- [ ] Wire banner in `loadDocumentPreview` `html-folder` branch (`planning.js`)
- [ ] Add `resetHtmlBanner()` helper and call from tab-switch and tree-rebuild handlers (`planning.js`)
- [ ] Update `renderDocCard` to render icon+text buttons with `.html-serve-btn`/`.html-link-btn` classes for `Serve & Open` and `Link Doc` (`planning.js`)
- [ ] Add `data-tooltip` attributes alongside `title` in `renderDocCard` (`planning.js`)
- [ ] Add defensive null checks in `renderDocCard` action handlers (`planning.js`)
- [ ] Verify `_handleLinkToDocument` `cleanDocId` behavior for `html-folder` docId format
- [ ] Manual end-to-end verification

**Recommendation:** Complexity 5 → Send to Coder.

## Review Findings

Implementation verified against plan. All checklist items present in code. One MAJOR issue found and fixed: `handlePreviewError` for `html-folder` did not call `resetHtmlBanner()`, leaving the banner in active state with enabled buttons while the preview showed an error — fixed by adding `resetHtmlBanner()` at `planning.js:2810`. One NIT deferred: `data-tooltip` attributes are set in JS but have no corresponding CSS to render custom tooltips; native `title` tooltips work as fallback. Pre-existing TS errors in `ClickUpSyncService.ts` and `KanbanProvider.ts` are unrelated. `_handleLinkToDocument` `cleanDocId` colon-splitting verified safe for current `${folderIndex}:${relativePath}` docId format.
