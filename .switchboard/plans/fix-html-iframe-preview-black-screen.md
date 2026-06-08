# Fix HTML Preview Black Screen When Switching Between Files in Planning Panel

## Goal

Fix the black/blank screen that appears when switching from one HTML file to another in the Planning Panel's HTML previewer. The preview currently requires opening an image file (PNG) first to reset the iframe state before another HTML file will render.

### Root Cause Analysis

The HTML previewer uses a sandboxed iframe with `srcdoc` to display content. When a user clicks a second HTML file, the frontend receives new content and assigns `iframe.srcdoc = newContent`, but it **never clears the existing `srcdoc` first**.

In VS Code's webview environment (Electron/Chromium), reassigning `srcdoc` on an iframe that already contains an active document can fail to trigger a proper reload. The renderer gets stuck in a dead state — showing a black/blank screen — because the existing document's execution context (especially if it contains JavaScript) interferes with the transition.

The image-preview path already handles this correctly by calling `iframe.removeAttribute('srcdoc')` before switching views, which is why opening a PNG "fixes" the issue.

Additionally, the `_handleFetchPreview` method for `html-folder` sets `_latestRequestIds` but never reads it back before sending `previewReady`, meaning stale file-read responses can still be processed. While the frontend's `requestId` guard usually catches this, auto-refresh paths (`requestId: -1`) bypass that check.

## Metadata

**Tags:** frontend, bugfix, ui
**Complexity:** 3

## User Review Required

- Confirm whether `iframe.removeAttribute('srcdoc')` alone is sufficient on the target Electron version, or if `iframe.srcdoc = ''` should be used as an intermediate step before assigning new content.
- Confirm scope: should the `design-folder` and `local-folder` missing race guards be fixed in this same plan or tracked as a separate follow-up?

## Complexity Audit

### Routine
- Single-line `iframe.removeAttribute('srcdoc')` insertion before `iframe.srcdoc` assignment in `handlePreviewReady()`
- Single-line race guard insertion in `_handleFetchPreview()` for `html-folder` branch
- Both changes mirror existing patterns already proven in the codebase (image-preview path, adapter-based handlers)

### Complex / Risky
- None — all changes are localized, additive, single-line insertions matching existing patterns

## Edge-Case & Dependency Audit

- **Race Conditions:** The `html-folder` branch in `_handleFetchPreview` (line 3302: `await fs.promises.readFile`) has no post-async race guard before `postMessage` at line 3326. A second preview request arriving during the `readFile` await will update `_latestRequestIds`, but the first request's response will still be delivered. The same gap exists for `design-folder` (line 3401) and `local-folder` (line 3482) — these are out of scope for this plan but should be tracked as follow-up.
- **Security:** No new attack surface. Both changes are defensive guards that drop stale data.
- **Side Effects:** Clearing `srcdoc` may cause a brief flash as the iframe navigates to `about:blank` before loading new content. The `loadingState` element is already hidden at this point (line 2123), so the flash is contained within the iframe's own render cycle.
- **Dependencies & Conflicts:** The error path at line 2470 also sets `iframe.srcdoc` without clearing first. If an error occurs while an HTML file with active JS is displayed, the error page could also hit the black-screen bug. This should be patched in the same change.

## Dependencies

None — this plan is self-contained with no cross-plan dependencies.

## Adversarial Synthesis

Key risks: (1) `removeAttribute('srcdoc')` alone may not force iframe reload on all Electron versions — per HTML spec it should navigate to `about:blank`, but Chromium batching could treat synchronous remove+reassign as a no-op. Mitigation: test on target Electron version; fallback to `iframe.srcdoc = ''` as intermediate step if needed. (2) Error path at line 2470 shares the same srcdoc-without-clearing bug and should be patched alongside the main fix. (3) `design-folder`/`local-folder` race guards are missing but out of scope — track as follow-up plan.

## Proposed Changes

### `src/webview/planning.js` — iframe srcdoc transition logic

**Context:** `handlePreviewReady()` function, `html-folder` branch. When `htmlContent` is present (line 2134), the iframe receives new `srcdoc` content without first clearing the existing document.

**Logic:** The image-preview path (line 2131) already calls `iframe.removeAttribute('srcdoc')` before switching to image mode. The HTML-to-HTML transition needs the same clearing step.

**Implementation:**

1. **Line 2139 (before `iframe.srcdoc` assignment):** Insert `iframe.removeAttribute('srcdoc');` to clear the existing iframe document before setting new content. This mirrors the image-preview path at line 2131.

   ```javascript
   // Current (line 2137-2142):
   if (iframe) {
       iframe.style.display = '';
       iframe.removeAttribute('src');
       const htmlWithBase = injectBaseTag(htmlContent, webviewUri);
       console.log('[PlanningPanel] Setting srcdoc for HTML preview, length:', htmlWithBase.length, 'hasNonce:', /nonce="/.test(htmlWithBase));
       iframe.srcdoc = htmlWithBase;

   // Fixed:
   if (iframe) {
       iframe.style.display = '';
       iframe.removeAttribute('src');
       iframe.removeAttribute('srcdoc');  // ← ADD: clear existing document to prevent black screen
       const htmlWithBase = injectBaseTag(htmlContent, webviewUri);
       console.log('[PlanningPanel] Setting srcdoc for HTML preview, length:', htmlWithBase.length, 'hasNonce:', /nonce="/.test(htmlWithBase));
       iframe.srcdoc = htmlWithBase;
   ```

   **Fallback:** If `removeAttribute('srcdoc')` alone does not force a reload on the target Electron version, replace with `iframe.srcdoc = '';` which explicitly navigates the iframe to `about:blank` before the new content is assigned.

2. **Line 2470 (error path):** Insert `iframe.removeAttribute('srcdoc');` before the error-page `srcdoc` assignment. Same pattern — prevents black screen when transitioning from an HTML file with active JS to an error display.

   ```javascript
   // Current (line 2467-2470):
   if (iframe) {
       iframe.style.display = '';
       iframe.removeAttribute('src');  // Clear any src-based navigation
       iframe.srcdoc = `<html><body style="background:#000;color:#e0e0e0;font-family:sans-serif;padding:2em"><p>Error: ${error.replace(/</g, '&lt;')}</p></body></html>`;

   // Fixed:
   if (iframe) {
       iframe.style.display = '';
       iframe.removeAttribute('src');  // Clear any src-based navigation
       iframe.removeAttribute('srcdoc');  // ← ADD: clear existing document before error page
       iframe.srcdoc = `<html><body style="background:#000;color:#e0e0e0;font-family:sans-serif;padding:2em"><p>Error: ${error.replace(/</g, '&lt;')}</p></body></html>`;
   ```

**Edge Cases:**
- Cache-hit branch (line 2149): checks `iframe.srcdoc` truthiness. Since `removeAttribute` and reassignment happen synchronously, no code path can read `iframe.srcdoc` between them — safe.
- `onload`/`onerror` handlers (lines 2144-2145): these are reassigned (not accumulated) each time, so no leak. The `removeAttribute` may cause an extra `load` event for the `about:blank` transition, but the handler just logs — cosmetic only.

### `src/services/PlanningPanelProvider.ts` — missing race guard for `html-folder` previews

**Context:** `_handleFetchPreview()` method, `html-folder` branch (line 3251). The method sets `_latestRequestIds` at line 3240 but never checks it back after the async `fs.promises.readFile` at line 3302.

**Logic:** All adapter-based handlers (lines 1346, 1374, 1400) check `_latestRequestIds` after their async operations. The `html-folder` branch should do the same to prevent stale responses from being delivered when rapid file switching occurs.

**Implementation:**

1. **After line 3302 (`await fs.promises.readFile`), before line 3305 (cache dedup):** Insert a race guard check:

   ```typescript
   // After: const htmlContent = await fs.promises.readFile(resolvedPath, 'utf8');
   // Add:
   if (requestId !== this._latestRequestIds.get(sourceId)) { return; }
   ```

   This aligns the `html-folder` handler with all other preview sources and prevents stale responses from being delivered when rapid file switching occurs.

2. **Also add the same guard before the error fallback `postMessage` at line 3337:**

   ```typescript
   } catch (err: any) {
       // If file read fails, fall back to webviewUri-only delivery
       if (requestId !== this._latestRequestIds.get(sourceId)) { return; }  // ← ADD
       this._panel?.webview.postMessage({
   ```

**Edge Cases:**
- Auto-refresh (`requestId: -1`): The guard checks `requestId !== latest`. If two auto-refreshes arrive, the second sets `_latestRequestIds` to `-1`, and the first's guard check becomes `-1 !== -1` which is `false` — so the first still passes. This is correct: auto-refreshes for the same file should not be dropped.
- Cache-hit path (line 3310): This path already has its own `requestId >= 0` guard, so it's unaffected.

### Audit findings (Step 3 — no code changes, documentation only)

The following paths were audited and findings documented:

1. **`design-folder` branch in `_handleFetchPreview` (line 3401):** Same missing post-async race guard as `html-folder`. After `await fs.promises.readFile`, no check of `_latestRequestIds` before `postMessage` at line 3448. **Recommendation: Track as separate follow-up plan.**

2. **`local-folder` branch in `_handleFetchPreview` (line 3482):** Same missing post-async race guard. After `await localFolderService.fetchDocContent`, no check before `postMessage` at line 3512. **Recommendation: Track as separate follow-up plan.**

3. **`design-folder` handler in `handlePreviewReady` (line 2179):** Does NOT use `srcdoc` — uses `innerHTML` for markdown/JSON rendering. No black-screen risk. No change needed.

4. **`local-folder` handler in `handlePreviewReady`:** Does NOT use `srcdoc` — uses markdown rendering. No black-screen risk. No change needed.

5. **Error path at line 2470:** Uses `srcdoc` without clearing — patched in this plan (see above).

6. **Fallback path at line 2155-2161:** Uses `iframe.src` (not `srcdoc`) after `removeAttribute('srcdoc')`. Already clears `srcdoc` before `src` assignment. No change needed.

## Verification Plan

### Automated Tests

No automated tests added — this is a VS Code webview rendering bug that requires manual verification in the extension host. The fix is two single-line insertions with no new logic branches to unit-test.

### Manual Verification Steps

1. Open the Switchboard Planning Panel and navigate to the HTML previewer
2. Open an HTML file that contains JavaScript — confirm it renders correctly
3. Click a second HTML file — confirm it renders immediately without turning black/blank
4. Rapidly switch between 3–4 HTML files — confirm no stale content or black screens appear
5. Open an image file (PNG) and then switch back to an HTML file — confirm still works correctly
6. Trigger an error condition (e.g., delete the file being previewed) — confirm the error page renders without black screen
7. Check VS Code Developer Tools console — confirm no iframe-related CSP or sandbox errors

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Clearing `srcdoc` causes a brief flash/loading flicker | Low | Low | The `loadingState` element is already shown/hidden around the transition; removing `srcdoc` happens while `loadingState` is hidden and iframe display is being set |
| Race guard drops legitimate auto-refresh responses | Low | Medium | The guard checks `requestId !== latest`, so auto-refresh (`requestId: -1`) still works because `-1 !== -1` is false. Only out-of-order user clicks get dropped |
| CSP/nonce injection breaks due to iframe reset | Very Low | High | The nonce is injected into the HTML string before `srcdoc` assignment; clearing the iframe attribute does not affect the injected content |
| `removeAttribute('srcdoc')` doesn't force reload on some Electron versions | Low | Medium | Fallback: use `iframe.srcdoc = ''` as intermediate step to explicitly navigate to `about:blank` |

## Rollback

If issues arise, revert the two file changes. Both modifications are additive (single-line insertions) and easily reversible with `git revert`.

## Remaining Questions

None — root cause is confirmed and fix is minimal.

## Recommendation

**Complexity: 3 → Send to Intern.** Two single-line insertions matching existing patterns. No architectural changes, no new logic branches, no test infrastructure needed.
