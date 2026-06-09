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

The PNG image preview path already demonstrates the correct fix: it calls `iframe.removeAttribute('srcdoc')` (line 2275), which **destroys** the `srcdoc` attribute entirely rather than mutating it to an empty string. When switching back to HTML, the fresh `srcdoc` assignment is applied to a truly reset iframe.

### Affected Locations

Two identical buggy patterns exist in `src/webview/planning.js`:

1. **Success path** (line 2284): clearing old HTML before loading new HTML content.
2. **Error path** (line 2615): clearing the iframe before displaying an error message.

## Proposed Changes

### 1. `src/webview/planning.js` — Success path (`handlePreviewReady`, ~line 2281–2287)

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

### 2. `src/webview/planning.js` — Error path (`handlePreviewError`, ~line 2612–2616)

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

### 3. `src/services/PlanningPanelProvider.ts` — Remove stale `srcdoc` comment in `_injectLocalCsp` (line 828)

**Before:**
```typescript
// srcdoc iframes inherit the parent document's CSP, and
```

**After:**
```typescript
// srcdoc iframes inherit the parent document's CSP, and
```

*Note: the comment itself is fine, but the second comment block on line 835 (`Remove any existing CSP <meta> tags...`) references "srcdoc" in an accurate context and should stay. No backend change needed.*

## Validation Steps

1. Open the Switchboard **ARTIFACTS** panel in VS Code.
2. Navigate to the **HTML Preview** tab.
3. Click an HTML file (e.g., `designs/planning_prototype.html`).
4. Without clicking any other file type, click a different HTML file (e.g., `designs/index.html`).
5. **Expected:** the new HTML renders immediately — no black screen.
6. Repeat the switch rapidly (double-click two HTML files in quick succession).
7. **Expected:** no black screen or stuck `about:blank`.
8. Test error case: delete the HTML file while it is being previewed.
9. **Expected:** an error message renders in the iframe instead of a black screen.

## Fallback Plan (if `removeAttribute` alone is insufficient)

If testing reveals that rapid successive clicks still glitch (highly unlikely but possible due to iframe load timing), the next step is to **recreate the `<iframe>` element** on every HTML switch:

1. On switch, create a new `<iframe>` element with identical attributes.
2. Replace the old iframe in the DOM via `parent.replaceChild(newIframe, oldIframe)`.
3. Assign `srcdoc` on the new element.

This guarantees a brand-new browsing context but requires slightly more DOM bookkeeping.

## Risks & Edge Cases

- **Rapid clicking:** if a user clicks HTML A → HTML B → HTML A faster than the backend responds, the frontend request-id guard (`state.previewRequestId`) already drops stale responses; this is unchanged.
- **CSP/nonce:** `removeAttribute('srcdoc')` does not affect the CSP nonce injection performed by `_injectLocalCsp()` in the backend. The new `srcdoc` assignment still receives the correctly injected nonce.
- **Auto-refresh:** the file watcher auto-refresh path (`_setupActiveDocWatcher`) calls `_handleFetchPreview` which sends a `requestId: -1` message. The frontend `handlePreviewReady` allows `requestId === -1` regardless of the current `previewRequestId`, so this fix does not interfere with auto-refresh.
