# Fix: HTML Preview Tab Black Screen When Switching Between HTML Files

## Metadata

- **Complexity:** 3
- **Tags:** frontend, bugfix, ui

## Goal

Eliminate the black screen that occurs in the **HTML Preview** tab (`preview-pane-html`) when a user switches directly from one HTML file to another HTML file. The current workaround requires switching to a non-HTML file (e.g., a PNG) first, which forces the iframe to clear its content.

## Problem Analysis

### Root Cause

The HTML preview renders inside a sandboxed `<iframe>` using the `srcdoc` attribute (not `src`), because VS Code's webview blocks `vscode-webview-resource:` URIs when used directly as an iframe `src`.

When a user clicks a new HTML file, the frontend (`planning.js`) attempts to clear the previous content before injecting the new HTML:

```javascript
iframe.srcdoc = '';     // ← BUG: set to empty string (keeps attribute)
iframe.srcdoc = html;   // new content
```

Setting `srcdoc` to an empty string does **not** reliably tear down the iframe's browsing context. In VS Code's embedded Chromium, the browser can batch or race these mutations, and the previous `about:blank` navigation can conflict with the new `srcdoc` assignment. The iframe gets stuck on `about:blank`, whose background is `#000` — producing the observed black screen.

The PNG image preview path already demonstrates the correct fix: it calls `iframe.removeAttribute('srcdoc')` (line 2275), which **destroys** the `srcdoc` attribute entirely rather than mutating it to an empty string. When switching back to HTML, the fresh `srcdoc` assignment is applied to a truly reset iframe. The fallback path (line 2305) also uses `removeAttribute('srcdoc')` correctly.

### Affected Locations

Two identical buggy patterns exist in `src/webview/planning.js`:

1. **Success path** (line 2284): clearing old HTML before loading new HTML content.
2. **Error path** (line 2615): clearing the iframe before displaying an error message.

## User Review Required

- Confirm that a brief flash of `about:blank` (white or black) during rapid HTML→HTML switching is acceptable. The fix eliminates the *persistent* black screen but may produce a transient flash between renders due to asynchronous iframe rendering.
- No other user decisions needed — fix is mechanical and well-scoped.

## Complexity Audit

### Routine

- Replace `iframe.srcdoc = ''` with `iframe.removeAttribute('srcdoc')` at two locations
- Both locations follow an existing pattern already used in the image-preview path (line 2275) and fallback path (line 2305)
- Single file change (`src/webview/planning.js`)
- No API, state, or architectural changes

### Complex / Risky

- None

## Edge-Case & Dependency Audit

- **Race Conditions:** Rapid clicking (A→B→A faster than backend responds) is already guarded by `state.previewRequestId` (line 2261), which drops stale responses. The fix does not alter this guard. A transient visual flash between renders is possible but preferable to a persistent black screen.
- **Security:** `removeAttribute('srcdoc')` does not affect CSP nonce injection performed by `_injectLocalCsp()` in the backend (PlanningPanelProvider.ts, line 825). The new `srcdoc` assignment still receives the correctly injected nonce.
- **Side Effects:** None. `removeAttribute('srcdoc')` is a standard DOM operation that triggers a new browsing context per W3C spec. The image-preview path (line 2275) and fallback path (line 2305) already use this pattern without issues.
- **Dependencies & Conflicts:** No dependencies on other plans or in-flight work. The auto-refresh path (`_setupActiveDocWatcher`, line 679) sends `requestId: -1`, which bypasses the frontend stale-response guard (line 2261 allows `requestId === -1`). The fix does not interfere with auto-refresh behavior.

## Dependencies

None.

## Adversarial Synthesis

Key risks: transient flash of `about:blank` during rapid HTML switching (acceptable UX trade-off vs. persistent black screen); pre-existing `onload`/`onerror` handler accumulation at lines 2289-2290 (out of scope, not introduced by this fix). Mitigations: `removeAttribute('srcdoc')` is the W3C-standard way to destroy an srcdoc browsing context; the pattern is already proven in the image-preview and fallback paths.

## Proposed Changes

### 1. `src/webview/planning.js` — Success path (`handlePreviewReady`, line 2284)

**Before:**
```javascript
iframe.style.display = '';
iframe.removeAttribute('src');
iframe.srcdoc = '';  // Force iframe to about:blank before new content (prevents black screen on HTML-to-HTML transition)
const htmlWithBase = injectBaseTag(htmlContent, webviewUri);
iframe.srcdoc = htmlWithBase;
```

**After:**
```javascript
iframe.style.display = '';
iframe.removeAttribute('src');
iframe.removeAttribute('srcdoc');  // Destroy the attribute to guarantee a clean browsing context
const htmlWithBase = injectBaseTag(htmlContent, webviewUri);
iframe.srcdoc = htmlWithBase;
```

### 2. `src/webview/planning.js` — Error path (`handlePreviewError`, line 2615)

**Before:**
```javascript
iframe.style.display = '';
iframe.removeAttribute('src');
iframe.srcdoc = '';  // Force iframe to about:blank before error page (prevents black screen)
iframe.srcdoc = `<html><body ...`;
```

**After:**
```javascript
iframe.style.display = '';
iframe.removeAttribute('src');
iframe.removeAttribute('srcdoc');  // Destroy the attribute to guarantee a clean browsing context
iframe.srcdoc = `<html><body ...`;
```

### Note: `_injectLocalCsp` comment (PlanningPanelProvider.ts, line 828)

The comment on line 828 (`srcdoc iframes inherit the parent document's CSP`) is accurate and requires no modification. The second comment block on line 835 (`Remove any existing CSP <meta> tags...`) also references srcdoc in an accurate context and should stay. No backend change needed.

## Verification Plan

### Automated Tests

- No automated tests required (skip per session directive). The fix is a two-line DOM attribute change with no logic branches.

### Manual Verification

1. Open the Switchboard **ARTIFACTS** panel in VS Code.
2. Navigate to the **HTML Preview** tab.
3. Click an HTML file (e.g., `designs/planning_prototype.html`).
4. Without clicking any other file type, click a different HTML file (e.g., `designs/index.html`).
5. **Expected:** the new HTML renders immediately — no persistent black screen.
6. Repeat the switch rapidly (double-click two HTML files in quick succession).
7. **Expected:** no persistent black screen or stuck `about:blank`. A brief transient flash is acceptable.
8. Test error case: delete the HTML file while it is being previewed.
9. **Expected:** an error message renders in the iframe instead of a black screen.
10. Test auto-refresh: modify the HTML file on disk while it is being previewed.
11. **Expected:** the preview updates automatically without black screen.

## Fallback Plan (if `removeAttribute` alone is insufficient)

If testing reveals that rapid successive clicks still produce a persistent (not transient) black screen, the next step is to **recreate the `<iframe>` element** on every HTML switch:

1. On switch, create a new `<iframe>` element with identical attributes.
2. Replace the old iframe in the DOM via `parent.replaceChild(newIframe, oldIframe)`.
3. Assign `srcdoc` on the new element.

This guarantees a brand-new browsing context but requires slightly more DOM bookkeeping.

## Execution Summary

**Status:** COMPLETED

**Files changed:**
- `src/webview/planning.js` (2 edits)
  - Line 2277: success path (`handlePreviewReady`) — `iframe.srcdoc = ''` → `iframe.removeAttribute('srcdoc')`
  - Line 2608: error path (`handlePreviewError`) — `iframe.srcdoc = ''` → `iframe.removeAttribute('srcdoc')`

**Validation:**
- No compilation step run (per session directive).
- No automated tests run (per session directive).
- Change matches existing proven pattern at lines 2268 and 2298.

**Remaining risks:** None new. Pre-existing handler accumulation at lines 2282-2283 remains out of scope.

## Risks & Edge Cases

- **Rapid clicking:** if a user clicks HTML A → HTML B → HTML A faster than the backend responds, the frontend request-id guard (`state.previewRequestId`) already drops stale responses; this is unchanged.
- **CSP/nonce:** `removeAttribute('srcdoc')` does not affect the CSP nonce injection performed by `_injectLocalCsp()` in the backend. The new `srcdoc` assignment still receives the correctly injected nonce.
- **Auto-refresh:** the file watcher auto-refresh path (`_setupActiveDocWatcher`) calls `_handleFetchPreview` which sends a `requestId: -1` message. The frontend `handlePreviewReady` allows `requestId === -1` regardless of the current `previewRequestId`, so this fix does not interfere with auto-refresh.
- **Transient flash:** during rapid HTML→HTML switching, a brief flash of `about:blank` may appear between renders due to asynchronous iframe rendering. This is a cosmetic artifact and preferable to the persistent black screen.
- **Handler accumulation (pre-existing, out of scope):** lines 2289-2290 attach `onload`/`onerror` handlers on every `handlePreviewReady` call without removing prior handlers. This is a pre-existing issue not introduced by this fix.

**Recommendation:** Complexity 3 → Send to Intern.

## Review Findings

**Reviewer pass completed.** No code changes required during review. Verified via grep that zero instances of `iframe.srcdoc = ''` remain in `src/webview/planning.js`. Both the success path (line 2479) and error path (line 2855) correctly use `iframe.removeAttribute('srcdoc')`, matching the existing proven pattern in the image-preview (line 2453) and fallback (line 2517) paths. No remaining risks introduced by this fix.
