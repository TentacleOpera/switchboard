# Bug: Design Panel HTML Preview Graphs Don't Render Until Reopen

## Goal

### Problem
HTML files previewed in the Design panel (`design.html`) sometimes do not
display their graphs/charts until the user closes `design.html` and reopens it.
The user has to manually reopen the panel to make canvas-based graphs appear.

### Background
The Design panel's HTML preview renders external HTML files inside a sandboxed
iframe (`#html-preview-frame`). When an HTML file is selected, the preview loads
its content via `iframe.srcdoc = injectBaseTag(htmlContent, webviewUri)`
(`design.js` lines 1242, 1185) or via `iframe.src = msg.iframeSrc` (lines 1229,
1172). The iframe is sandboxed with `allow-scripts allow-same-origin`.

The example file that breaks,
`/Users/patrickvuleta/Documents/GitHub/patrickwork/meetings/revenuecat-map.html`,
renders graphs using the **native HTML5 Canvas 2D API** (no external charting
library). Each chart is an IIFE that runs immediately on load:

```javascript
(function(){
    var canvas=document.getElementById('mrrc'),wrap=document.getElementById('mrrcWrap');
    var ctx=canvas.getContext('2d');
    function draw(){
        var dpr=window.devicePixelRatio||1,cssW=wrap.clientWidth,cssH=300;
        canvas.width=cssW*dpr;canvas.height=cssH*dpr;
        // ... drawing logic using wrap.clientWidth for sizing ...
    }
    draw();
    window.addEventListener('resize', draw);  // redraws only on window resize
})();
```

The canvas sizing depends on `wrap.clientWidth` — the rendered width of the
chart's wrapper div. The charts redraw only on a `window resize` event.

### Root Cause
The iframe content (and its canvas-drawing scripts) executes when `srcdoc` is
set. At that moment, the iframe may have zero or incorrect dimensions because:

1. **The preview wrapper starts hidden.** `#html-preview-wrapper` is initially
   `display: none` and only set to `display: flex` after content loads (design.js
   lines 1224, 1179). When the script runs inside the iframe, `wrap.clientWidth`
   may be 0 (or a stale value) because the iframe's container isn't laid out
   yet, producing zero-size or invisible canvases.

2. **No redraw on visibility change.** The charts listen only for
   `window.addEventListener('resize', draw)`. When `#html-preview-wrapper`
   transitions from `display: none` to `display: flex` (or when the user
   switches tabs back to the HTML preview, or uncollapses the sidebar), the
   iframe becomes visible but **no `resize` event fires inside the iframe**.
   The canvas retains its zero/stale dimensions and the graph is invisible.

3. **Why reopening works.** Closing and reopening `design.html` recreates the
   webview and iframe from scratch. The iframe loads with the wrapper already
   visible (`display: flex`), so `wrap.clientWidth` is correct at
   script-execution time and the canvases render properly.

The `srcdoc` is set once and never reloaded on visibility changes. There is no
mechanism to dispatch a `resize` event into the iframe when it becomes visible.

**Bug status: STILL PRESENT** (verified in source). No visibility-change redraw
trigger exists in `design.js`.

## Metadata
**Tags:** bug, design-panel, html-preview, canvas, iframe, rendering
**Complexity:** 3
**Repo:** switchboard (source at `/Users/patrickvuleta/Documents/GitHub/switchboard`)

## Complexity Audit

### Routine
1. Add a visibility-change hook that dispatches a `resize` event into the
   iframe's `contentWindow` when the preview wrapper becomes visible.
2. The fix requires no changes to the user's HTML files — it works for any
   canvas/chart library that listens for `resize`.

### Complex / Risky
1. **`iframe.contentWindow` cross-origin access.** The iframe uses
   `sandbox="allow-scripts allow-same-origin"`. With `allow-same-origin`, the
   parent can access `iframe.contentWindow` and call
   `contentWindow.dispatchEvent(new Event('resize'))`. If the sandbox were
   `allow-scripts` only (no `allow-same-origin`), this would throw a
   cross-origin error. Confirm the sandbox always includes `allow-same-origin`
   for `srcdoc` previews (it does — design.js lines 1170, 1182, 1227, 1239).
2. **Timing of the resize dispatch.** The resize must fire AFTER the wrapper's
   `display: flex` has been applied and the browser has laid out the iframe.
   A `requestAnimationFrame` (double-rAF) or small `setTimeout` after the
   display change ensures `wrap.clientWidth` is non-zero when the chart's
   `draw()` runs.
3. **`srcdoc` vs `src` previews.** Both paths set the iframe content. The
   visibility fix applies to both — dispatch resize whenever the wrapper becomes
   visible, regardless of how content was loaded.

## Edge-Case & Dependency Audit

- **Non-canvas HTML files:** Dispatching a `resize` event into an HTML file that
  doesn't listen for resize is a no-op. Safe.
- **Charts that don't listen for resize:** Some chart libraries (e.g. certain
  D3 setups) don't redraw on resize. Those would still not render on visibility
  change. This fix covers the common case (canvas + resize listener, including
  the revenuecat-map.html pattern). A more aggressive fix would reload the
  `srcdoc` on visibility, but that re-runs all scripts (side effects, flicker).
  The resize dispatch is the minimal, safe fix.
- **Tab switching away and back:** When the user switches from the HTML preview
  tab to another Design sub-tab and back, the wrapper may be hidden then shown.
  The fix must dispatch resize on each show.
- **Sidebar collapse/uncollapse:** Collapsing the preview sidebar changes the
  iframe width. An uncollapse should also trigger a resize so charts re-fit.

## Proposed Changes

### File: `src/webview/design.js`

**Change 1 — Add a helper to dispatch a resize event into the iframe.**

```javascript
function notifyIframeResize(iframe) {
    if (!iframe || !iframe.contentWindow) return;
    try {
        // Allow layout to settle after the wrapper becomes visible.
        // Double-rAF ensures the browser has committed the display:flex layout
        // before the chart's draw() reads wrap.clientWidth.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                iframe.contentWindow.dispatchEvent(new Event('resize'));
            });
        });
    } catch (e) {
        // Cross-origin iframe (shouldn't happen with allow-same-origin) — ignore.
    }
}
```

**Change 2 — Dispatch resize after showing the wrapper in the HTML preview
render path.**

In the `html-folder` preview render (around lines 1224-1248), after setting
`iframeWrapper.style.display = 'flex'` and setting `srcdoc`/`src`, add:

```javascript
if (iframeWrapper) iframeWrapper.style.display = 'flex';
// ... existing iframe src/srcdoc assignment ...
notifyIframeResize(iframe);
```

And in the `claude`-folder preview render (around lines 1167-1188), add the same
`notifyIframeResize(iframe)` after the wrapper is shown.

**Change 3 — Use a MutationObserver as a robust catch-all for visibility
transitions.**

To cover all paths (tab switch, sidebar toggle, collapse restore, window
resize), add a MutationObserver on `#html-preview-wrapper` that watches for
`style`/`class` changes and dispatches resize when the wrapper becomes visible:

```javascript
const htmlWrapper = document.getElementById('html-preview-wrapper');
const htmlFrame = document.getElementById('html-preview-frame');
if (htmlWrapper && htmlFrame) {
    const observer = new MutationObserver(() => {
        if (htmlWrapper.style.display !== 'none' &&
            !htmlWrapper.classList.contains('collapsed')) {
            notifyIframeResize(htmlFrame);
        }
    });
    observer.observe(htmlWrapper, {
        attributes: true,
        attributeFilter: ['style', 'class']
    });
}
```

This is the most reliable approach — it catches every visibility transition
without instrumenting each toggle path individually. Keep Change 2 as
belt-and-suspenders for the initial-load case; the MutationObserver is the
primary mechanism for subsequent visibility changes.

**Change 4 — Also dispatch resize on parent window resize.**

When the VS Code webview itself resizes (which changes the iframe's available
width), the iframe's internal `resize` event may not fire reliably. Add a
listener on the parent window that forwards resize to the iframe:

```javascript
window.addEventListener('resize', () => {
    notifyIframeResize(document.getElementById('html-preview-frame'));
});
```

## Verification Plan

1. **Repro on current build:** Open `revenuecat-map.html` in the Design panel
   HTML preview. If graphs render, switch to another Design sub-tab and back —
   confirm the graphs disappear or don't re-render. Alternatively, open the
   preview with the wrapper initially hidden and confirm graphs don't render
   until the panel is closed and reopened.
2. **Apply the fix** and rebuild.
3. **Initial-load test:** Open `revenuecat-map.html` in the HTML preview.
   Confirm all 5 canvas charts (MRR by channel, New trials, App Store vs Stripe
   churn, Stripe vs stores retention, Stripe monthly effective price) render
   immediately without reopening.
4. **Tab-switch test:** Switch from the HTML preview to another Design sub-tab
   and back. Confirm the charts re-render (MutationObserver fires resize).
5. **Sidebar collapse/uncollapse test:** Collapse the preview sidebar, then
   uncollapse it. Confirm the charts re-fit to the new width.
6. **Webview resize test:** Resize the VS Code window / panel. Confirm the
   charts re-fit (parent resize forwarded to iframe).
7. **Non-canvas HTML test:** Open a plain HTML file (no canvas) in the preview.
   Confirm the resize dispatch is a no-op (no errors, no visual change).
8. **`src`-based preview test:** Open an HTML file that loads via `iframe.src`
   (not `srcdoc`). Confirm the resize dispatch works for that path too.
