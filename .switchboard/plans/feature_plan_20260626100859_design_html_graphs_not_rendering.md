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
   `display: none` (design.html line 3759) and only set to `display: flex` after
   content loads (design.js lines 1224, 1179). Likewise `#claude-preview-wrapper`
   starts `display: none` (design.html line 3809) and is shown at lines 1167,
   1185. When the script runs inside the iframe, `wrap.clientWidth` may be 0 (or
   a stale value) because the iframe's container isn't laid out yet, producing
   zero-size or invisible canvases.

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
**Tags:** frontend, ui, bugfix, reliability
**Complexity:** 4

## User Review Required
Yes — confirm the reproduction on the current installed VSIX before
implementation (open `revenuecat-map.html` in the Design HTML preview and verify
charts are blank until panel reopen). Also confirm whether the `claude`-folder
preview path (claude.ai/design imports) exhibits the same symptom, since the fix
now covers both paths.

## Complexity Audit

### Routine
- Add a `notifyIframeResize(iframe)` helper that dispatches a `resize` event
  into the iframe's `contentWindow` after layout settles (double-rAF), with the
  visibility check performed *inside* the rAF to avoid TOCTOU races.
- Call the helper at the four display-toggle sites (html-folder src/srcdoc at
  lines 1224/1236; claude-folder src/srcdoc at lines 1167/1179).
- Add an `iframe.onload` fallback at the call sites so charts that parse
  asynchronously still get an initial `resize` dispatch after the iframe
  document is ready.
- Forward the parent webview `window resize` to the preview iframe as a
  defensive belt-and-suspenders measure.

### Complex / Risky
- **MutationObserver debounce + dual-target coverage.** A single observer
  covering both `#html-preview-wrapper` and `#claude-preview-wrapper` must be
  debounced (one trailing rAF gate, not a double-rAF per mutation) to avoid
  resize storms when style/class mutations fire rapidly. The visibility check
  must run inside the rAF, not at observer-callback time, to avoid dispatching
  resize into a wrapper that has since been hidden again.
- **`iframe.contentWindow` cross-origin access.** The iframe uses
  `sandbox="allow-scripts allow-same-origin"`. With `allow-same-origin`, the
  parent can access `iframe.contentWindow` and call
  `contentWindow.dispatchEvent(new Event('resize'))`. If the sandbox were
  `allow-scripts` only (no `allow-same-origin`), this would throw a
  cross-origin error. Confirmed the sandbox always includes `allow-same-origin`
  for both preview paths (design.js lines 1170, 1182, 1227, 1239; design.html
  lines 3761, 3811).

## Edge-Case & Dependency Audit

- **Race Conditions:** The MutationObserver must debounce and re-check
  visibility inside the rAF callback. Without this, rapid none→flex→none
  toggles (fast tab switching) can dispatch `resize` into a hidden iframe whose
  `wrap.clientWidth` is 0 — re-introducing the zero-size canvas bug.
- **Security:** `dispatchEvent(new Event('resize'))` into a same-origin iframe
  is safe; it only triggers the iframe's own resize listeners. No data crosses
  the boundary. The `try/catch` in the helper guards against any unexpected
  cross-origin throw.
- **Side Effects:** Dispatching `resize` into an HTML file that doesn't listen
  for resize is a no-op. Safe. Reloading `srcdoc` (the more aggressive
  alternative) would re-run all scripts and cause flicker/side effects —
  explicitly rejected in favor of the resize dispatch.
- **Dependencies & Conflicts:** No new dependencies. The fix is pure DOM
  manipulation in `design.js`. The MutationObserver is added once at webview
  init and lives for the panel's lifetime; it does not conflict with the
  existing `initZoomListeners` calls (lines 365-366) which attach to the same
  wrappers.
- **Non-canvas HTML files:** Dispatching `resize` is a no-op. Safe.
- **Charts that don't listen for resize:** Some chart libraries (e.g. certain
  D3 setups) don't redraw on resize. Those would still not render on visibility
  change. This fix covers the common case (canvas + resize listener, including
  the revenuecat-map.html pattern). A more aggressive fix would reload the
  `srcdoc` on visibility, but that re-runs all scripts (side effects, flicker).
  The resize dispatch is the minimal, safe fix.
- **Tab switching away and back:** When the user switches from the HTML preview
  tab to another Design sub-tab and back, the wrapper may be hidden then shown.
  The MutationObserver dispatches resize on each show.
- **Sidebar collapse/uncollapse:** Collapsing the preview sidebar changes the
  iframe width. An uncollapse triggers a style change on the wrapper, firing
  the observer; the parent `resize` forwarder also catches width changes.

## Dependencies
- None. This is a self-contained bugfix in `src/webview/design.js`.

## Adversarial Synthesis
Key risks: (1) an undebounced MutationObserver firing a resize storm on rapid
style/class mutations; (2) a TOCTOU race where the visibility check runs at
observer-callback time but the rAF fires after the wrapper is hidden again,
re-introducing the zero-size canvas bug; (3) the original plan only observed
`#html-preview-wrapper` and missed the parallel `#claude-preview-wrapper` path,
leaving claude-folder previews broken. Mitigations: debounce the observer with a
single trailing rAF gate, perform the visibility check *inside* the rAF, and
attach the observer to both preview wrappers. An `iframe.onload` fallback covers
async `srcdoc`/`src` parsing for the initial draw.

## Proposed Changes

### File: `src/webview/design.js`

**Change 1 — Add a debounced `notifyIframeResize` helper.**

Add near the other preview helpers (e.g. after `injectBaseTag` around line 442).
The visibility check is performed *inside* the rAF to avoid TOCTOU races. A
module-level rAF token debounces concurrent calls so only one resize dispatch
fires per frame.

```javascript
let _resizeRafToken = null;
function notifyIframeResize(iframe, wrapperEl) {
    if (!iframe) return;
    if (_resizeRafToken) cancelAnimationFrame(_resizeRafToken);
    _resizeRafToken = requestAnimationFrame(() => {
        _resizeRafToken = null;
        // Re-check visibility INSIDE the rAF — the wrapper may have been
        // hidden again between the observer callback and this frame.
        if (wrapperEl && wrapperEl.style.display === 'none') return;
        if (!iframe.contentWindow) return;
        try {
            // Second rAF ensures the browser has committed the display:flex
            // layout before the chart's draw() reads wrap.clientWidth.
            requestAnimationFrame(() => {
                if (wrapperEl && wrapperEl.style.display === 'none') return;
                if (!iframe.contentWindow) return;
                iframe.contentWindow.dispatchEvent(new Event('resize'));
            });
        } catch (e) {
            // Cross-origin iframe (shouldn't happen with allow-same-origin) — ignore.
        }
    });
}
```

**Change 2 — Dispatch resize after showing the wrapper in all four render
paths, plus an `iframe.onload` fallback for async content.**

In the `html-folder` preview render:

- `src` path (around line 1224): after `iframeWrapper.style.display = 'flex'`
  and `iframe.src = ...` (line 1229), add:
  ```javascript
  notifyIframeResize(iframe, iframeWrapper);
  if (iframe) iframe.addEventListener('load', () => notifyIframeResize(iframe, iframeWrapper), { once: true });
  ```
- `srcdoc` path (around line 1236): after `iframe.srcdoc = ...` (line 1242),
  add the same two lines.

In the `claude`-folder preview render (`msg.target === 'claude'`):

- `src` path (around line 1167): after `iframe.src = ...` (line 1172), add:
  ```javascript
  notifyIframeResize(iframe, iframeWrapper);
  if (iframe) iframe.addEventListener('load', () => notifyIframeResize(iframe, iframeWrapper), { once: true });
  ```
- `srcdoc` path (around line 1179): after `iframe.srcdoc = ...` (line 1185),
  add the same two lines.

**Change 3 — Add a single debounced MutationObserver covering BOTH preview
wrappers.**

Add during webview initialization (e.g. near the `initZoomListeners` calls at
lines 365-366). The observer watches `style`/`class` on both
`#html-preview-wrapper` and `#claude-preview-wrapper` and delegates to the
debounced helper. The helper's internal rAF gate ensures only one resize
dispatch per frame even if both wrappers mutate simultaneously.

```javascript
function setupPreviewResizeObservers() {
    const targets = [
        { wrapperId: 'html-preview-wrapper', frameId: 'html-preview-frame' },
        { wrapperId: 'claude-preview-wrapper', frameId: 'claude-preview-frame' }
    ];
    for (const { wrapperId, frameId } of targets) {
        const wrapper = document.getElementById(wrapperId);
        const frame = document.getElementById(frameId);
        if (!wrapper || !frame) continue;
        const observer = new MutationObserver(() => {
            // Visibility re-check happens inside notifyIframeResize's rAF.
            notifyIframeResize(frame, wrapper);
        });
        observer.observe(wrapper, {
            attributes: true,
            attributeFilter: ['style', 'class']
        });
    }
}
// Call alongside the existing initZoomListeners calls (lines 365-366):
//     initZoomListeners('html-preview-wrapper', '.zoomable-viewport', 'html');
//     initZoomListeners('claude-preview-wrapper', '.zoomable-viewport', 'claude');
//     setupPreviewResizeObservers();
```

This is the primary mechanism for subsequent visibility changes (tab switch,
sidebar toggle, collapse restore). Change 2 remains as belt-and-suspenders for
the initial-load case and as the `onload` fallback for async content.

**Change 4 — Forward parent webview `resize` to both preview iframes
(defensive).**

When the VS Code webview itself resizes, nested iframes usually fire their own
internal `resize` event, but forwarding is cheap insurance. Add during webview
init:

```javascript
window.addEventListener('resize', () => {
    notifyIframeResize(
        document.getElementById('html-preview-frame'),
        document.getElementById('html-preview-wrapper')
    );
    notifyIframeResize(
        document.getElementById('claude-preview-frame'),
        document.getElementById('claude-preview-wrapper')
    );
});
```

## Verification Plan

> **Session directives:** Skip compilation (`npm run compile` / webpack) and
> skip automated tests. Verification is manual via the installed VSIX. The
> test suite will be run separately by the user.

### Automated Tests
- None required for this session (skipped per directive). The change is
  webview-DOM behavior with no unit-test harness in the repo for `design.js`.

### Manual Verification
1. **Repro on current build:** Open `revenuecat-map.html` in the Design panel
   HTML preview. If graphs render, switch to another Design sub-tab and back —
   confirm the graphs disappear or don't re-render. Alternatively, open the
   preview with the wrapper initially hidden and confirm graphs don't render
   until the panel is closed and reopened.
2. **Apply the fix** and rebuild (out of scope for this session — user runs
   `npm run compile` + VSIX install separately).
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
9. **Claude-folder preview test:** Open an HTML file in the `claude`-folder
   preview path. Confirm charts render on initial load and re-render on
   tab-switch back (validates the dual-wrapper observer coverage added in
   Change 3).
10. **Fast-tab-switch stress test:** Rapidly switch between the HTML preview
    tab and another sub-tab several times. Confirm no console errors, no
    blank canvases left behind, and no visible jank (validates the debounce).

---

**Recommendation:** Complexity 4 → **Send to Coder**.
