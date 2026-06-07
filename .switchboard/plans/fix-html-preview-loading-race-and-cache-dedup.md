# Fix HTML Preview Stuck on Loading Due to Silent Cache Dedup

## Goal

Fix the bug in the Switchboard Planning panel where HTML file previews often fail to render on first click, leaving the user stuck in a loading state. The current workaround (click away to another file, then back) should no longer be necessary.

## Problem Analysis

### Root Cause

In `PlanningPanelProvider.ts` (`_handleFetchPreview`, line 2482), the backend maintains a `_lastPreviewContentByPath` cache to deduplicate redundant preview refreshes during file-watcher bursts. When the user clicks an HTML file, the backend reads its content and compares it to the cache:

```ts
const lastContent = this._lastPreviewContentByPath.get(cacheKey);
if (htmlContent === lastContent) {
    return;  // <-- BUG: returns WITHOUT sending any message to the frontend
}
```

If the content matches the cache, the method **silently returns** without posting a `previewReady` (or `previewError`) message. The frontend, which has already switched the UI to the loading state (`html-loading-state` visible, iframe hidden), never receives the signal to transition out of loading. The iframe remains hidden and the preview never appears.

### Why the "Click Away and Back" Workaround Works

The backend implements a "single-entry cache" that clears all *other* keys when processing a new document:

```ts
for (const key of this._lastPreviewContentByPath.keys()) {
    if (key !== currentKey) {
        this._lastPreviewContentByPath.delete(key);
    }
}
```

So:
1. Click file A → backend sends `previewReady`, caches A
2. Click file A again → backend dedups, **returns silently**, frontend stuck
3. Click file B → backend **clears cache for A**, sends `previewReady` for B
4. Click back to A → backend reads A fresh (cache empty), sends `previewReady`

This is exactly the workaround the user describes.

### Why It Happens on First Open

The `open()` method resets `_lastLocalDocsSignature` (to avoid starving a fresh panel) but **does NOT reset `_lastPreviewContentByPath`**. If the user previously opened the Planning panel in the same VS Code session and previewed any HTML file, that content remains cached. When the panel is reopened and the same file is clicked, the stale cache triggers the silent dedup.

Even on a truly first open, auto-refresh events from file watchers can populate the cache before the user clicks, causing the same symptom.

Additionally, `open()` only clears the cache when creating a *new* panel. If the panel already exists, `open()` calls `this._panel.reveal()` and returns early (line 239-241), bypassing any cache reset. Stale cache from a previous session can persist across reveal cycles.

## Metadata

**Tags:** bugfix, frontend, backend, ui, reliability
**Complexity:** 5

## User Review Required

- Confirm that auto-refresh dedup should be preserved (i.e., cache-hit responses should only be sent for user-initiated requests, not auto-refreshes). This is the plan's default assumption.

## Complexity Audit

### Routine
- Adding `_lastPreviewContentByPath.clear()` to `open()` method
- Adding cache-hit response for `html-folder` in `_handleFetchPreview`
- Frontend `handlePreviewReady` update for cache-hit `html-folder` case

### Complex / Risky
- Auto-refresh vs. user-initiated request distinction: must preserve dedup for auto-refresh (`requestId === -1`) while responding to user clicks. Getting this wrong reintroduces flicker.
- `design-folder` and `local-folder` cache-hit handling: these use different rendering (markdown, not iframe) and need source-type-specific frontend logic.
- `open()` vs `reveal()` path: cache must be cleared on both paths, not just panel creation.

## Edge-Case & Dependency Audit

- **Race Conditions:** The frontend `handlePreviewReady` filters by `requestId` (line 1791: `if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;`). Cache-hit responses use the same `requestId` as the user's click, so they pass this guard. If the user clicks the same file twice quickly, the second click generates a new `requestId`, and the backend's race guard (`_latestRequestIds`) ensures only the latest request's response is processed. This is correct.
- **Security:** CSP nonce rotation is correctly handled — the cache compares raw content before CSP injection, so nonce rotation does not trigger false cache misses.
- **Side Effects:** The cache-hit response omits `htmlContent` to avoid re-transmitting large strings. The frontend must handle the missing field gracefully. If the iframe's `srcdoc` was cleared during the loading transition (e.g., by a tab switch), the cache-hit path that just makes the iframe visible would show a blank iframe. **Verification needed**: confirm the loading state transition does NOT clear `srcdoc`.
- **Dependencies & Conflicts:** The `design-folder` preview uses `content` (not `htmlContent`) and renders via markdown (not iframe). The `local-folder` preview also uses `content`. Applying the "same fix" requires source-type-specific handling.

## Dependencies

- `sess_html_preview_cache_dedup` — HTML preview cache dedup fix

## Adversarial Synthesis

Key risks: auto-refresh dedup must be preserved (sending cache-hit responses for auto-refreshes would reintroduce flicker), `design-folder`/`local-folder` need source-type-specific cache-hit handling (not a copy-paste of the `html-folder` fix), and the `open()` cache reset must also cover the `reveal()` path. Mitigations: guard cache-hit responses with `requestId >= 0` check, adapt per source type, and add cache clear to the reveal path.

## Implementation Plan

### Step 1: Reset preview cache on panel open AND reveal

In `PlanningPanelProvider.open()`, clear `_lastPreviewContentByPath` on both the creation path and the reveal path.

**File:** `src/services/PlanningPanelProvider.ts`, lines 235-241

```ts
public async open(): Promise<void> {
    // Force the next local-docs send to render (the dedup cache must not starve a
    // freshly revealed/created panel).
    this._lastLocalDocsSignature = '';
    this._lastPreviewContentByPath.clear();  // <-- ADD: clear stale preview cache
    if (this._panel) {
        this._panel.reveal(vscode.ViewColumn.One);
        return;
    }
    // ... panel creation continues
}
```

This ensures stale content from a previous panel session cannot trigger a silent dedup on the first click, regardless of whether the panel is being created or revealed.

### Step 2: Send cache-hit response for user-initiated requests only (html-folder)

In `_handleFetchPreview`, when the HTML content matches the cache for `html-folder`, send a lightweight `previewReady` message — but **only for user-initiated requests** (`requestId >= 0`). For auto-refreshes (`requestId === -1`), preserve the existing silent dedup to prevent flicker.

**File:** `src/services/PlanningPanelProvider.ts`, lines 2479-2484

```ts
// Dedup: compare raw content before CSP injection (nonce may rotate)
const cacheKey = this._getPreviewCacheKey(sourceId, docId, sourceFolder);
const lastContent = this._lastPreviewContentByPath.get(cacheKey);
if (htmlContent === lastContent) {
    // Cache hit — notify frontend for user-initiated requests only
    // (auto-refresh dedup is preserved to prevent flicker)
    if (requestId >= 0) {
        this._panel?.webview.postMessage({
            type: 'previewReady',
            sourceId,
            requestId,
            webviewUri,
            docName: path.basename(resolvedPath),
            isAutoRefreshed: false
        });
    }
    return;
}
```

> Note: `htmlContent` is intentionally omitted from the cache-hit response. The frontend already has the content in the iframe from the previous render. `isAutoRefreshed` is set to `false` because this is a response to a user click, not an auto-refresh.

### Step 3: Handle lightweight `previewReady` on the frontend (html-folder)

In `planning.js`, update `handlePreviewReady` for `sourceId === 'html-folder'` to handle the case where `htmlContent` is missing but `webviewUri` is present (cache-hit scenario).

**File:** `src/webview/planning.js`, lines 1803-1832

The current code has three branches:
1. `isImage && webviewUri` → image preview
2. `htmlContent` → set `iframe.srcdoc`
3. `webviewUri` (fallback) → set `iframe.src`

The cache-hit response (no `htmlContent`, but `webviewUri` present) would fall into branch 3, which sets `iframe.src = webviewUri`. **This is a behavior change**: previously the iframe used `srcdoc`; on cache hit it would switch to `src`, which could cause a full reload and lose scroll position.

**Refined frontend fix**: Add a fourth branch for the cache-hit case that preserves the existing iframe content:

```js
if (isImage && webviewUri) {
    // ... existing image logic (lines 1803-1807)
} else if (htmlContent) {
    // ... existing srcdoc logic (lines 1808-1822)
} else if (webviewUri && iframe && iframe.srcdoc) {
    // Cache hit: content hasn't changed, iframe already has srcdoc content
    // Just ensure iframe is visible — do NOT modify src or srcdoc
    iframe.style.display = '';
    if (imageContainer) { imageContainer.style.display = 'none'; }
    if (imageImg) { imageImg.removeAttribute('src'); }
} else if (webviewUri) {
    // Fallback: iframe src if htmlContent not available and no existing srcdoc
    // (e.g., backend file read failed on first attempt)
    // ... existing fallback logic (lines 1823-1831)
}
```

The key check is `iframe.srcdoc` — if the iframe already has `srcdoc` content from a previous render, we know the content is there and just need to make it visible. If `srcdoc` is empty (e.g., the iframe was cleared by a tab switch), we fall through to the `iframe.src` fallback which will reload the content.

### Step 4: Apply source-type-specific cache-hit handling for design-folder and local-folder

The same cache-dedup pattern exists for `design-folder` (line 2568) and `local-folder` (line 2618), but these source types use different rendering:

- **`design-folder`**: Uses `content` field (not `htmlContent`), renders via markdown preview/editor, not iframe. Cache-hit response should include `content` so the markdown renderer can update. Since markdown rendering is lightweight (no iframe reload), re-sending `content` on cache hit is acceptable.
- **`local-folder`**: Uses `content` field, also renders via markdown. Same approach as `design-folder`.

**File:** `src/services/PlanningPanelProvider.ts`

For `design-folder` (lines 2566-2570):
```ts
const cacheKey = this._getPreviewCacheKey(sourceId, docId, sourceFolder);
const lastContent = this._lastPreviewContentByPath.get(cacheKey);
if (docContent === lastContent) {
    // Cache hit — notify frontend for user-initiated requests only
    if (requestId >= 0) {
        this._panel?.webview.postMessage({
            type: 'previewReady',
            sourceId,
            requestId,
            webviewUri,
            content: docContent,
            docName: path.basename(resolvedPath),
            isAutoRefreshed: false,
            filePath: resolvedPath
        });
    }
    return;
}
```

For `local-folder` (lines 2616-2620):
```ts
const cacheKey = this._getPreviewCacheKey(sourceId, docId, sourceFolder);
const lastContent = this._lastPreviewContentByPath.get(cacheKey);
if (result.content === lastContent) {
    // Cache hit — notify frontend for user-initiated requests only
    if (requestId >= 0) {
        this._panel?.webview.postMessage({
            type: 'previewReady',
            sourceId,
            requestId,
            content: result.content || '',
            docName: result.docTitle,
            isAutoRefreshed: false,
            filePath: resolvedPath
        });
    }
    return;
}
```

> Note: For `design-folder` and `local-folder`, we include `content` in the cache-hit response because the frontend markdown renderer needs it. Unlike the iframe case, markdown rendering is idempotent and lightweight — re-rendering the same content doesn't cause flicker.

### Step 5: Regression test

- Open the Planning panel
- Click an HTML file → preview renders immediately
- Click the same HTML file again → preview remains visible (no loading state stuck)
- Click a different HTML file → preview switches correctly
- Click back to the first file → preview renders correctly
- Close the panel tab, reopen it, click the same file → preview renders immediately (no stale cache)
- Edit the HTML file externally → auto-refresh updates the preview (no flicker on repeated auto-refreshes of unchanged content)
- Click a design file → preview renders immediately
- Click the same design file again → preview remains visible
- Click a local folder file → preview renders immediately
- Click the same local folder file again → preview remains visible

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`
- **Context:** Backend preview handler with cache dedup that silently returns on cache hit.
- **Logic:** Add `_lastPreviewContentByPath.clear()` in `open()` (both creation and reveal paths). Send lightweight `previewReady` on cache hit for user-initiated requests only (`requestId >= 0`), preserving silent dedup for auto-refreshes.
- **Implementation:** See Steps 1, 2, and 4 above.
- **Edge Cases:** Auto-refresh dedup preserved via `requestId >= 0` guard. CSP nonce rotation unaffected (cache compares pre-injection content).

### `src/webview/planning.js`
- **Context:** Frontend `handlePreviewReady` for `html-folder` currently falls through to `iframe.src` when `htmlContent` is absent.
- **Logic:** Add a cache-hit branch that checks for existing `iframe.srcdoc` content and just makes the iframe visible without modifying `src` or `srcdoc`. This preserves scroll position and avoids a full reload.
- **Implementation:** See Step 3 above.
- **Edge Cases:** If `iframe.srcdoc` is empty (e.g., cleared by tab switch), fall through to `iframe.src` fallback which reloads the content via `webviewUri`.

## Verification Plan

### Automated Tests
- No automated tests exist for the Planning panel preview. Verification is manual.

### Manual Verification
1. Launch extension in debug mode
2. Open Planning panel → HTML Previews tab
3. Click an HTML file → should render immediately
4. Click same file again → should stay rendered (not get stuck on loading)
5. Close panel, reopen, click same file → should render immediately
6. Edit the HTML file externally → auto-refresh should update preview without flicker
7. Click a design file → should render immediately; click again → should stay rendered
8. Click a local folder file → should render immediately; click again → should stay rendered

## Files to Change

- `src/services/PlanningPanelProvider.ts` — reset cache in `open()`, send response on cache hit in `_handleFetchPreview` (html-folder, design-folder, local-folder)
- `src/webview/planning.js` — handle cache-hit `previewReady` for `html-folder` without overwriting iframe content

## Remaining Risks

- If the loading state transition in the frontend clears `iframe.srcdoc`, the cache-hit path that just makes the iframe visible would show a blank iframe. This needs verification during implementation. If it does clear `srcdoc`, the fallback `iframe.src = webviewUri` path will reload the content (slightly less efficient but functionally correct).
- The `requestId >= 0` guard assumes all user-initiated requests have non-negative `requestId` values and all auto-refreshes use `requestId === -1`. This convention is consistent across the codebase but should be verified.

## Recommendation

**Complexity: 5** → Send to Coder

---

## Execution Results

**Status:** ✅ COMPLETED

**Date:** 2025-06-07

### Changes Implemented

#### 1. `src/services/PlanningPanelProvider.ts` - Line 243
- Added `this._lastPreviewContentByPath.clear();` to `open()` method
- Clears stale preview cache on both panel creation and reveal paths
- Prevents silent dedup on first click after panel reopen

#### 2. `src/services/PlanningPanelProvider.ts` - Lines 3140-3153 (html-folder)
- Added cache-hit response for user-initiated requests only (`requestId >= 0`)
- Sends lightweight `previewReady` message without `htmlContent` field
- Preserves silent dedup for auto-refreshes (`requestId === -1`) to prevent flicker

#### 3. `src/webview/planning.js` - Lines 2038-2043 (html-folder)
- Added cache-hit branch: `else if (webviewUri && iframe && iframe.srcdoc)`
- Checks for existing `iframe.srcdoc` content before making iframe visible
- Preserves scroll position by not modifying `src` or `srcdoc`
- Falls through to `iframe.src` fallback if `srcdoc` is empty

#### 4. `src/services/PlanningPanelProvider.ts` - Lines 3238-3252 (design-folder)
- Added cache-hit response with `content` field (markdown rendering needs content)
- User-initiated requests only (`requestId >= 0`)
- Includes `webviewUri`, `content`, `docName`, `isAutoRefreshed: false`, `filePath`

#### 5. `src/services/PlanningPanelProvider.ts` - Lines 3326-3339 (local-folder)
- Added cache-hit response with `content` field
- User-initiated requests only (`requestId >= 0`)
- Includes `content`, `docName`, `isAutoRefreshed: false`, `filePath`

### Verification

Manual verification required per plan:
- Open Planning panel → HTML Previews tab
- Click HTML file → should render immediately
- Click same file again → should stay rendered (no loading stuck)
- Close panel, reopen, click same file → should render immediately
- Edit HTML externally → auto-refresh should update without flicker
- Test design-folder and local-folder similarly

### Notes

- All implementation steps completed as specified
- Auto-refresh dedup preserved via `requestId >= 0` guard
- Source-type-specific handling applied (html-folder omits content, design/local-folder include content)
- Cache reset applies to both creation and reveal paths in `open()`
