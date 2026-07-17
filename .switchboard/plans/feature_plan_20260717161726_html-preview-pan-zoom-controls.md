# Fix HTML Preview Pan/Zoom Controls (dead buttons, duplicate Fit/Reset, broken Space-to-pan)

## Goal

Make the HTML Previews canvas (Design panel → **HTML PREVIEWS** tab) actually navigable: the zoom toolbar buttons must each do something distinct, and the user must be able to pan/scroll around a zoomed preview.

### Reported symptoms (from testing)
1. "The HTML preview control buttons don't seem to do anything."
2. "The two right-most buttons do exactly the same thing."
3. "There is no way to scroll the canvas. Pressing and holding Space, I expect to be able to pan, but instead it just jumps me down."

### Problem analysis & root cause

The canvas lives in [design.html](src/webview/design.html) (`#html-preview-wrapper`, a `.zoomable-container`) and is driven by the zoom/pan engine in [design.js](src/webview/design.js) (`initZoomListeners`, `zoomAt`, `fitToContainer`, `clampPan`). The previewed page is loaded into `#html-preview-frame` — an `<iframe sandbox="allow-scripts allow-same-origin">` — either via `srcdoc` (`htmlContent`) or via a served localhost URL (`iframeSrc`). The extension injects `DesignPanelProvider._INSPECTOR_SCRIPT` into that HTML's `<head>` ([DesignPanelProvider.ts:4088](src/services/DesignPanelProvider.ts#L4088)).

Three independent defects converge to make the whole control set feel broken:

**A. Space-to-pan "jumps me down" (symptom 3).** The parent webview's Space handler lives on the *parent* window ([design.js:407-413](src/webview/design.js#L407-L413)): it adds `body.space-pan-active` (which reveals the `.zoom-event-layer` capture layer) and calls `e.preventDefault()` to stop the page scrolling. But once the user clicks *into* the preview iframe, keyboard focus is inside the iframe document, so keystrokes are delivered to the iframe — **the parent handler never fires**. `space-pan-active` is never set and `preventDefault()` never runs, so the browser's default "Space scrolls the document down" wins → the page "jumps down." The injected `_INSPECTOR_SCRIPT` *does* run inside the iframe, but it only attaches a `keydown` listener while Inspect Mode is active ([DesignPanelProvider.ts:366](src/services/DesignPanelProvider.ts#L366)) and never forwards Space. Net effect: Space-pan is dead whenever the iframe has focus, which is almost always.

**B. Fit (⤢) and Reset (⟲) are identical (symptom 2).** The two right-most toolbar buttons are `data-action="reset"` and `data-action="fit"` ([design.html:3917-3918](src/webview/design.html#L3917-L3918)). For the HTML preview, both the `.zoomable-viewport` and the `<iframe>` inside it are `width:100%; height:100%` of the container ([design.html:3890-3891](src/webview/design.html#L3890-L3891)). So `getContentDims()` / `fitToContainer()` always measure `contentW === containerW` and `contentH === containerH`, making `fitScale = min(containerW/contentW, containerH/contentH, 1) = 1` ([design.js:271](src/webview/design.js#L271)). "Fit" therefore collapses to "scale 1, centered" — byte-for-byte identical to "Reset" ([design.js:356-368](src/webview/design.js#L356-L368)). They only diverge for image/Stitch previews, whose content has real intrinsic pixel dimensions. Because the iframe canvas has no natural size, fit-to-view is a no-op.

**C. Nothing to pan → the whole toolbar feels inert (symptom 1).** `.zoomable-container` is `overflow:hidden` ([design.html:1994-2002](src/webview/design.html#L1994-L2002)) and the iframe exactly fills it, so zooming *in* magnifies from the top-left but there is no larger-than-viewport surface to move around, and — per defect A — no working way to pan to the magnified region. Zoom in/out do change the transform, but with no navigation the result reads as "the buttons don't do anything." A stale dead call compounds the confusion: `initZoomListeners('image-preview-container', '.zoomable-viewport', 'html')` ([design.js:374](src/webview/design.js#L374)) and the `image-preview-container` lookups in `handlePreviewReady` ([design.js:1373](src/webview/design.js#L1373), [design.js:1386](src/webview/design.js#L1386)) target an element ID that does not exist in the HTML tab (only `image-preview-container-images` / `-design` exist) — harmless no-ops, but leftover cruft to remove.

### The fix (one coherent change)

Turn the injected iframe script into a small **input + measurement bridge**, and have the parent size the canvas to the previewed page's *natural* dimensions:

- The iframe reports its own `scrollWidth`/`scrollHeight` to the parent (works for both `srcdoc` and cross-origin served pages, because the script reads its *own* document). The parent sizes `.zoomable-viewport` to those pixel dims → a real canvas that overflows the viewport. Now **Fit ≠ Reset**, zoom is meaningful, and there is something to pan.
- The iframe forwards Space `keydown`/`keyup` (always-on, `preventDefault`ed) to the parent → Space-pan activates reliably and the page no longer jumps down.
- Add a **keyboard-free "Pan" toggle button** to the toolbar so navigation never depends on iframe focus, and make the capture layer support wheel-scroll panning.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, ux, bugfix

## Complexity Audit (Routine vs Complex/Risky)

| Area | Classification | Notes |
| :--- | :--- | :--- |
| Add always-on Space forward + content-dims reporter to `_INSPECTOR_SCRIPT` | Complex/Risky | Runs inside arbitrary previewed pages; must not break the page, must be idempotent, must not fight Inspect Mode's own `keydown`. |
| Parent listens for `sbSpacePan` / `sbContentDims` messages | Routine | Mirrors the existing `sbInspectState` message plumbing ([design.js:3586](src/webview/design.js#L3586)). |
| Size `.zoomable-viewport` to reported natural dims; update `getContentDims` | Complex/Risky | Changes the pan/zoom math's assumptions; must preserve image/Stitch behavior which relies on `firstElementChild` dims. |
| Fit vs Reset divergence | Routine | Falls out automatically once the canvas has a natural size; verify `reset`=100% and `fit`=fit-to-view. |
| Add "Pan" toggle button + wheel-pan on capture layer | Routine | New button in one toolbar; toggles the same `space-pan-active` state. |
| Remove dead `image-preview-container` references | Routine | Delete no-op call + guarded lookups; behavior-neutral. |

**Risky pieces** get explicit verification steps below. Everything else is mechanical.

## Edge-Case & Dependency Audit

- **Cross-origin served previews.** When a file is served via localhost (`iframeSrc`), the parent cannot read `iframe.contentDocument`. The dims/Space bridge deliberately runs *inside* the iframe and uses `window.parent.postMessage(..., '*')`, so it works regardless of origin. **Confirmed:** the served-HTML path injects `_INSPECTOR_SCRIPT` at [DesignPanelProvider.ts:1936](src/services/DesignPanelProvider.ts#L1936) (`const injected = babelPatch + diag + DesignPanelProvider._INSPECTOR_SCRIPT;`). Both `srcdoc` and served paths inject the script. No fallback timeout is needed.
- **`postMessage` origin filtering.** The parent's existing message handler already matches `event.source === htmlFrame.contentWindow` ([design.js:3540](src/webview/design.js#L3540)); reuse that guard for the new message types so a preview page can't spoof pan/dims for the wrong frame.
- **Inspect Mode co-existence.** Inspect Mode adds its own capturing `keydown` ([DesignPanelProvider.ts:366](src/services/DesignPanelProvider.ts#L366)). The new Space handler must be separate and must not consume keys Inspect Mode needs (Inspect uses Escape/click, not Space) — but both may `preventDefault` Space; ensure ordering doesn't break Inspect's Escape-to-exit.
- **INPUT/TEXTAREA/contentEditable inside the preview.** If the previewed page has a focused form field, Space must type a space, not pan. Mirror the guard already used in the parent handler ([design.js:410](src/webview/design.js#L410)) *inside* the iframe script (check `document.activeElement` tag / `isContentEditable`).
- **Multiple viewports share one `zoomState.html`.** Two containers historically shared the `html` tab state via the `panSource` guard ([design.js:322-324](src/webview/design.js#L322-L324)). Removing the dead `image-preview-container` init must not disturb the surviving `html-preview-wrapper` listener.
- **`resetZoom('html')` on every preview load** ([design.js:1365](src/webview/design.js#L1365)) wipes scale/pan; the new natural-size fit should be (re)applied on the iframe `load` event, after `sbContentDims` is received (content size is unknown until the doc lays out). Chain off the existing `iframe.addEventListener('load', ...)` ([design.js:1417](src/webview/design.js#L1417)).
- **Empty / zero-height documents.** A blank preview reports `scrollHeight` ~0; clamp reported dims to a sensible minimum (e.g. the container size) so the canvas never collapses.
- **Related surfaces.** (1) The **Stitch HTML** tab (`#stitch-html-preview-wrapper`) shares the same `_INSPECTOR_SCRIPT` injection and the same zoom engine code, but `initZoomListeners` was never called for it — its toolbar buttons are dead. This plan now includes wiring `initZoomListeners` for Stitch HTML (see Proposed Changes §4) and adding the Pan toggle to its toolbar (§5), since it's a one-line fix in the same file using the same engine. (2) The **Planning** panel ([planning.html:3752](src/webview/planning.html#L3752)) has the identical four buttons and a `.zoom-event-layer`, but [planning.js](src/webview/planning.js) wires **no** zoom engine at all (0 references to `initZoomListeners`/`zoomState`), so *all* its buttons are dead. That is a separate, larger follow-up (extract/share the engine) and is **not** addressed here.

## Proposed Changes

### 1. `src/services/DesignPanelProvider.ts` — extend `_INSPECTOR_SCRIPT` with the pan/dims bridge

Add an always-on block to the injected script (independent of the inspect `toggle`), near the existing `window.addEventListener('message', ...)` at the bottom ([DesignPanelProvider.ts:381-385](src/services/DesignPanelProvider.ts#L381-L385)):

```js
// ── Space-to-pan forwarding (always on, independent of Inspect Mode) ──
function isEditableTarget(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
window.addEventListener('keydown', function(e) {
    if (e.code !== 'Space' || e.repeat) return;
    if (isEditableTarget(document.activeElement)) return; // let the field type a space
    e.preventDefault();                                    // stop the "jump down"
    window.parent.postMessage({ type: 'sbSpacePan', on: true }, '*');
}, true);
window.addEventListener('keyup', function(e) {
    if (e.code !== 'Space') return;
    window.parent.postMessage({ type: 'sbSpacePan', on: false }, '*');
}, true);
window.addEventListener('blur', function() {
    window.parent.postMessage({ type: 'sbSpacePan', on: false }, '*');
});

// ── Natural content-size reporter (drives real Fit/Reset + panning) ──
function reportDims() {
    var d = document.documentElement;
    var w = Math.max(d.scrollWidth, document.body ? document.body.scrollWidth : 0);
    var h = Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0);
    if (w && h) window.parent.postMessage({ type: 'sbContentDims', w: w, h: h }, '*');
}
window.addEventListener('load', reportDims);
window.addEventListener('resize', reportDims);
try { new ResizeObserver(reportDims).observe(document.documentElement); } catch (e) {}
setTimeout(reportDims, 0);
```

Because `_INSPECTOR_SCRIPT` is guarded by `window.__sbInspectorInstalled` ([DesignPanelProvider.ts:153](src/services/DesignPanelProvider.ts#L153)), this remains idempotent.

> **Superseded:** "Confirm the served-HTML path injects `_INSPECTOR_SCRIPT` too; if not, add injection there (see Audit)."
> **Reason:** The served-HTML path was verified — it DOES inject `_INSPECTOR_SCRIPT`. At [DesignPanelProvider.ts:1936](src/services/DesignPanelProvider.ts#L1936): `const injected = babelPatch + diag + DesignPanelProvider._INSPECTOR_SCRIPT;` followed by `html = this._injectIntoHead(html, injected);`. Both `srcdoc` and served paths inject the script.
> **Replaced with:** No action needed — served-HTML injection is confirmed. The dims/Space bridge will work for both paths.

### 2. `src/webview/design.js` — consume the bridge, size the canvas, unify Space state

**(a) Handle the new iframe messages** in the existing `window.addEventListener('message', ...)` switch (alongside `sbInspectState`, [design.js:3586](src/webview/design.js#L3586)), reusing the `event.source === htmlFrame.contentWindow` guard ([design.js:3540](src/webview/design.js#L3540)):

```js
case 'sbSpacePan': {
    // Gate on the active iframe so a blur from a hidden iframe doesn't
    // kill pan mode in the visible one. Mirrors sbInspectState routing.
    const htmlFrame = document.getElementById('html-preview-frame');
    const stitchFrame = document.getElementById('stitch-html-preview-frame');
    if ((htmlFrame && event.source === htmlFrame.contentWindow) ||
        (stitchFrame && event.source === stitchFrame.contentWindow)) {
        document.body.classList.toggle('space-pan-active', !!event.data.on);
    }
    break;
}
case 'sbContentDims': {
    // Route based on event.source — both HTML and Stitch HTML iframes inject
    // the same _INSPECTOR_SCRIPT, so both will send sbContentDims.
    const htmlFrame = document.getElementById('html-preview-frame');
    const stitchFrame = document.getElementById('stitch-html-preview-frame');
    if (htmlFrame && event.source === htmlFrame.contentWindow) {
        const wrapper = document.getElementById('html-preview-wrapper');
        const vp = wrapper ? wrapper.querySelector('.zoomable-viewport') : null;
        if (vp && event.data.w && event.data.h) {
            vp.style.width = event.data.w + 'px';
            vp.style.height = event.data.h + 'px';
            _htmlContentDims = { w: event.data.w, h: event.data.h };
            fitToContainer('html', wrapper, vp);
        }
    } else if (stitchFrame && event.source === stitchFrame.contentWindow) {
        const wrapper = document.getElementById('stitch-html-preview-wrapper');
        const vp = wrapper ? wrapper.querySelector('.zoomable-viewport') : null;
        if (vp && event.data.w && event.data.h) {
            vp.style.width = event.data.w + 'px';
            vp.style.height = event.data.h + 'px';
            _stitchHtmlContentDims = { w: event.data.w, h: event.data.h };
            fitToContainer('stitchHtml', wrapper, vp);
        }
    }
    break;
}
```

Add module-scoped `let _htmlContentDims = null;` and `let _stitchHtmlContentDims = null;` near `zoomState` ([design.js:205](src/webview/design.js#L205)). Make `getContentDims` prefer the reported dims for iframe-based previews so pan-clamping uses the real canvas:

> **Superseded:** `if (el && el.tagName === 'IFRAME' && _htmlContentDims) return _htmlContentDims;`
> **Reason:** This matches ANY iframe (including Stitch HTML's), but `_htmlContentDims` is only set from the HTML preview's messages. A stale `_htmlContentDims` from a previous HTML preview would corrupt Stitch HTML's pan/zoom math.
> **Replaced with:** Scope the check to the HTML preview wrapper specifically:

```js
function getContentDims(viewportEl) {
    const el = viewportEl ? viewportEl.firstElementChild : null;
    if (el && el.tagName === 'IFRAME') {
        const wrapper = viewportEl.closest('#html-preview-wrapper');
        if (wrapper && _htmlContentDims) return _htmlContentDims;
        const stitchWrapper = viewportEl.closest('#stitch-html-preview-wrapper');
        if (stitchWrapper && _stitchHtmlContentDims) return _stitchHtmlContentDims;
    }
    const w = el.tagName === 'IMG' ? (el.naturalWidth || el.offsetWidth) : el.offsetWidth;
    const h = el.tagName === 'IMG' ? (el.naturalHeight || el.offsetHeight) : el.offsetHeight;
    return (w && h) ? { w, h } : null;
}
```

Note: `fitToContainer` ([design.js:251-276](src/webview/design.js#L251-L276)) has its own inline dims logic that reads `contentEl.offsetWidth`/`offsetHeight` directly (not via `getContentDims`). This still works because the iframe has `width:100%; height:100%` of the viewport — once the viewport is sized to the reported natural dims, the iframe's `offsetWidth`/`offsetHeight` inherit those dimensions. No change needed to `fitToContainer`.

Reset `_htmlContentDims = null` inside `handlePreviewReady` where `resetZoom('html')` is called ([design.js:1365](src/webview/design.js#L1365)) so a new file starts clean. Similarly, reset `_stitchHtmlContentDims = null` where `resetZoom('stitchHtml')` is called ([design.js:1444](src/webview/design.js#L1444)).

**(b) Remove the dead `image-preview-container` wiring**: delete the `initZoomListeners('image-preview-container', '.zoomable-viewport', 'html')` call ([design.js:374](src/webview/design.js#L374)) and the two guarded `image-preview-container` lookups in `handlePreviewReady` ([design.js:1373](src/webview/design.js#L1373), [design.js:1386-1388](src/webview/design.js#L1386-L1388)) — the HTML tab has no such element.

**(c) Wheel-pan while the capture layer is active**: replace the `wheel` handler in `initZoomListeners` ([design.js:301-308](src/webview/design.js#L301-L308)) with a branched version — when `document.body.classList.contains('space-pan-active')` and no ctrl/meta, translate `deltaX/deltaY` into `panX/panY` + `clampPan` instead of zooming:

```js
container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const viewportEl = container.querySelector(viewportSelector);
    if (document.body.classList.contains('space-pan-active') && !(e.ctrlKey || e.metaKey)) {
        // Pan mode: translate wheel deltas into pan offsets.
        zoomState[tab].panX -= e.deltaX;
        zoomState[tab].panY -= e.deltaY;
        const dims = getContentDims(viewportEl);
        if (dims) clampPan(tab, rect, dims.w, dims.h);
        applyZoom(tab, viewportEl);
    } else {
        // Zoom mode: original behavior.
        const factor = Math.exp(-e.deltaY * ((e.ctrlKey || e.metaKey) ? 0.01 : 0.002));
        zoomAt(tab, container, viewportEl,
            zoomState[tab].scale * factor,
            e.clientX - rect.left, e.clientY - rect.top);
    }
}, { passive: false });
```

Ctrl/⌘+scroll still zooms; plain scroll pans when the capture layer is active.

### 3. `src/webview/design.html` — add the Pan toggle button (keyboard-free navigation)

In the HTML-preview `.zoom-toolbar` ([design.html:3914-3919](src/webview/design.html#L3914-L3919)), prepend a pan toggle so panning never depends on Space/focus:

```html
<button class="zoom-btn" data-action="pan" title="Pan mode — drag to move the canvas">✥</button>
<button class="zoom-btn" data-action="zoom-in"  title="Zoom In (hold Space + Scroll)">+</button>
<button class="zoom-btn" data-action="zoom-out" title="Zoom Out (hold Space + Scroll)">−</button>
<button class="zoom-btn" data-action="reset" title="Reset Zoom (100%)">⟲</button>
<button class="zoom-btn" data-action="fit"   title="Fit whole page to view (Double-click)">⤢</button>
```

Handle `action === 'pan'` in the toolbar `click` handler ([design.js:346-369](src/webview/design.js#L346-L369)) by toggling `body.space-pan-active` and the button's `.active` class (same state the Space path uses, so the capture layer + drag/wheel-pan light up without holding a key).

### 4. `src/webview/design.js` — wire `initZoomListeners` for Stitch HTML

> **Superseded:** The Edge-Case audit claimed "The Stitch HTML tab shares the same engine and the same `_INSPECTOR_SCRIPT` injection, so it inherits these fixes for free."
> **Reason:** `initZoomListeners` is NEVER called for `stitch-html-preview-wrapper`. While `zoomState.stitchHtml` exists ([design.js:209](src/webview/design.js#L209)) and `resetZoom('stitchHtml')` / `applyZoom('stitchHtml', ...)` are called in `handlePreviewReady` ([design.js:1444-1473](src/webview/design.js#L1444-L1473)), no wheel/mouse/click/toolbar listeners are attached to the container. The Stitch HTML toolbar buttons ([design.html:3845-3850](src/webview/design.html#L3845-L3850)) are dead — same as the HTML preview's were before this fix.
> **Replaced with:** Add `initZoomListeners('stitch-html-preview-wrapper', '.zoomable-viewport', 'stitchHtml');` alongside the existing init calls ([design.js:372-376](src/webview/design.js#L372-L376)). Also add the Pan toggle button to the Stitch HTML toolbar (see step 5 below).

Add this line after the existing `initZoomListeners` calls:

```js
initZoomListeners('stitch-html-preview-wrapper', '.zoomable-viewport', 'stitchHtml');
```

### 5. `src/webview/design.html` — add Pan toggle to Stitch HTML toolbar

In the Stitch HTML `.zoom-toolbar` ([design.html:3845-3850](src/webview/design.html#L3845-L3850)), prepend the same pan toggle button:

```html
<button class="zoom-btn" data-action="pan" title="Pan mode — drag to move the canvas">✥</button>
<button class="zoom-btn" data-action="zoom-in"  title="Zoom In (hold Space + Scroll)">+</button>
<button class="zoom-btn" data-action="zoom-out" title="Zoom Out (hold Space + Scroll)">−</button>
<button class="zoom-btn" data-action="reset" title="Actual size (100%)">⟲</button>
<button class="zoom-btn" data-action="fit"   title="Fit whole page to view">⤢</button>
```

### 6. `src/webview/design.html` — clarify tooltips

Update the Reset/Fit `title`s in the HTML preview toolbar ([design.html:3917-3918](src/webview/design.html#L3917-L3918)) so their now-distinct roles are legible: Reset ⟲ = "Actual size (100%)", Fit ⤢ = "Fit whole page to view". (Zoom in/out tooltips already mention Space+Scroll.)

## User Review Required

This plan modifies the shared `_INSPECTOR_SCRIPT` which runs inside arbitrary previewed HTML pages. Review the injected script block for:
- Any risk of breaking previewed pages that have their own Space handlers or ResizeObservers.
- Whether the `postMessage` flood from `ResizeObserver` + `resize` + `load` + `setTimeout` could cause excessive re-layouts in the parent.

## Dependencies

None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) `sbContentDims`/`sbSpacePan` messages from the wrong iframe corrupting the other tab's state — mitigated by `event.source` routing. (2) `getContentDims` returning stale dims for the wrong tab — mitigated by per-tab dims variables and `closest()` scoping. (3) Stitch HTML toolbar was dead (no `initZoomListeners`) — fixed by adding the missing init call. (4) ResizeObserver may not exist in all iframe contexts — wrapped in try/catch. Mitigations are inline in the proposed code.

## Verification Plan

**Manual (primary — this is a webview interaction bug):**
1. Build the extension and open **Design panel → HTML PREVIEWS**; select an HTML file taller/wider than the viewport.
2. **Fit vs Reset:** click **⤢ Fit** → the whole page scales to fit inside the canvas (scale < 1, centered). Click **⟲ Reset** → page snaps to 100% actual size and overflows the viewport. The two must now produce visibly different results. Double-click also fits.
3. **Zoom + pan:** click **+ / −** → content scales about the center. Click the new **✥ Pan** button (or click into the preview, hold **Space**) → cursor shows grab; drag to move the canvas in all directions; release/toggle off restores normal interactivity.
4. **No more jump-down:** click inside the preview iframe, then hold **Space** → the page must NOT scroll down; the capture layer appears and drag pans. Type into any `<input>` inside a preview → Space still types a space (does not pan).
5. **Scroll to navigate:** with a zoomed/overflowing canvas, scroll the wheel while pan mode/Space is active → the canvas pans (does not zoom); ctrl/⌘+scroll still zooms.
6. **Served + srcdoc parity:** repeat 2–5 for both a plain file preview (`srcdoc`) and a served preview (localhost `iframeSrc`) to confirm the dims/Space bridge works cross-origin.
7. **No regressions (Images tab):** open the **Images** tab — image fit/reset/zoom still behave. Toggle **Inspect Mode** on an HTML preview and confirm hover-select + Escape still work (Space handler must not break Inspect).
8. **Stitch HTML tab:** open the **Stitch HTML** tab — toolbar buttons (zoom in/out, reset, fit, pan) now work. Fit ≠ Reset. Space-to-pan works inside the Stitch HTML iframe. Wheel-pan works when pan mode is active.
9. **Cross-tab isolation:** switch between HTML Previews and Stitch HTML tabs — dims from one tab must not leak into the other (verify by opening a tall file in HTML, switching to Stitch HTML with a wide file, and confirming each sizes correctly).

**Static (skip compilation, skip automated tests per session directives):**
10. Grep confirms the dead `image-preview-container` references are gone from `design.js` and that `image-preview-container-images` / `image-preview-container-design` are untouched:
    `grep -n "image-preview-container" src/webview/design.js` → only the `-images` / `-design` IDs remain.
11. Grep confirms `initZoomListeners('stitch-html-preview-wrapper'` exists in `design.js`:
    `grep -n "stitch-html-preview-wrapper" src/webview/design.js` → includes the init call.

---

**Recommendation:** Send to Coder (complexity 6).
