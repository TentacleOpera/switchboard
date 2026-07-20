# Let HTML previews scroll/navigate without turning on Pan mode

## Goal

**Problem:** In the HTML previews, when Pan mode (the ✥ button) is *off*, there is no way to navigate the canvas at all — the user can't even scroll up or down. Navigation only works with Pan mode on, and Pan mode is off by default, so the preview feels frozen the moment it opens. The user is (rightly) frustrated that turning pan off disables all navigation and that it starts off.

**Background — how the canvas is laid out:** The HTML preview is an `<iframe>` sized to the page's *natural* pixel dimensions inside an `overflow:hidden` container; scroll/zoom are simulated with a CSS `transform: translate()+scale()` on the `.zoomable-viewport`. Because the iframe is rendered at full natural size, it has no internal scrollbar. An iframe swallows mouse events from the parent, so to pan/zoom over it the code shows a transparent capture layer (`.zoom-event-layer`) — but only while Pan mode is toggled on OR Space is held:
```css
.zoom-event-layer { position:absolute; inset:0; z-index:5; display:none; }   /* design.html:2038 */
body.space-pan-active .zoom-event-layer { display:block; }                    /* design.html:2045 */
```
The container's `wheel` listener (which pans/zooms) lives on the container, but wheel events fired *over the iframe* go to the iframe's document, not the parent — so with the capture layer hidden they reach nothing actionable. The injected iframe script forwards **Space** to the parent ([DesignPanelProvider.ts:393-405](src/services/DesignPanelProvider.ts#L393-L405)) but does **not** forward the wheel.

**Root cause:** Navigation is gated entirely behind the capture layer, which is only present when Pan mode/Space is engaged. With Pan mode off and Space not held, the iframe is interactive (good for clicking links) but there is no channel by which a plain scroll can move the transformed canvas — hence "can't scroll up or down." Pan-off = navigation-dead is a structural consequence, not a preference.

**Desired behaviour:** Plain mouse-wheel / trackpad scroll should navigate (pan) the preview even with Pan mode *off*, while the iframe stays interactive (links/hover still work). Pan mode then becomes an *optional* click-drag convenience, not a prerequisite for basic scrolling. This removes the "why is it off by default / what's the point of off" trap: off still scrolls.

## Metadata
- **Complexity:** 6
- **Tags:** frontend, ui, ux, bugfix

## User Review Required

- **Inner-scroll trade-off:** the iframe wheel forwarder calls `e.preventDefault()` on every wheel event inside the iframe (with `{ passive: false, capture: true }`). A preview HTML page with a legitimately scrollable inner element (e.g. a scrollable `<div class="results">`) will have its inner scroll disabled because the event is consumed for canvas pan. Confirm this trade-off is acceptable for a design-preview context (inner scroll is rare) vs. adding logic to only forward when the iframe's own document isn't scrollable at the target.
- **✥ tooltip update (optional):** the plan optionally revises the Pan button tooltip to "Pan mode — click-drag to move (scroll works without it)". Confirm whether to make this copy change.
- **Container wheel handler refactor (optional):** the plan optionally refactors the existing container `wheel` handler at design.js:328 to also call `applyWheelToTab`, so pan-off and pan-on share one code path. Confirm whether to do this cleanup or leave the two paths separate.

## Complexity Audit (Routine vs Complex/Risky)

**Classification: Complex/Risky.** Touches the iframe↔parent message bridge (injected script) and the parent wheel/pan pipeline. Risks:
- The injected `_INSPECTOR_SCRIPT` runs inside sandboxed, arbitrary preview HTML; a wheel forwarder must be defensive (never throw, respect editable fields, and not fight the page's own scroll if it legitimately scrolls).
- Wheel deltas measured *inside* the iframe are in the iframe's coordinate space; the parent applies them as pan offsets — sign/scale must match the existing pan-mode wheel path so behaviour is consistent.
- Must not double-handle: when the capture layer IS up (Space/pan), the parent already handles wheel; the forwarded wheel must not also fire, or panning doubles.
- Ctrl/Cmd+wheel should still zoom (not pan), matching the existing container handler.

## Edge-Case & Dependency Audit

- **Iframe swallows wheel → forward it:** add a `wheel` listener inside `_INSPECTOR_SCRIPT` that `postMessage`s `{ type: 'sbWheel', deltaX, deltaY, ctrlKey, metaKey }` to the parent (and `preventDefault` so the iframe doesn't also try to scroll a page that happens to be internally scrollable). Guard against editable targets is not needed for wheel, but wrap in try/catch.
- **Parent applies forwarded wheel:** on `sbWheel`, if Ctrl/Cmd → zoom at container center (or last known pointer), else pan by the deltas and `clampPan`. Reuse the exact math already in the container `wheel` handler ([design.js:335-348](src/webview/design.js#L335-L348)) so pan-off scroll matches pan-on scroll.
- **Avoid double handling:** when `body.space-pan-active` is true the capture layer receives wheel directly; in that state the parent should ignore `sbWheel` (the layer covers the iframe so the iframe wheel won't fire anyway, but guard explicitly).
- **Routing for two iframes:** design.js has HTML + Stitch iframes; route `sbWheel` by `event.source === htmlFrame.contentWindow` vs `stitchFrame.contentWindow`, exactly as `sbContentDims`/`sbSpacePan` already do ([design.js:3663-3697](src/webview/design.js#L3663-L3697)).
- **Pan-mode default:** leaving Pan mode off by default is now acceptable because scroll works without it. (Optionally revisit the ✥ tooltip to say "Pan mode — click-drag to move (scroll works without it)".) No forced default change required by this plan; the frustration is resolved by making off usable.
- **Shared injected script:** `_INSPECTOR_SCRIPT` is defined once in `DesignPanelProvider.ts` and injected by BOTH Design and Planning previews ([PlanningPanelProvider.ts:1983](src/services/PlanningPanelProvider.ts#L1983), [PlanningPanelProvider.ts:2082](src/services/PlanningPanelProvider.ts#L2082)) — so the iframe-side forwarder is written once and benefits both webviews. The parent-side `sbWheel` handler must be added to BOTH design.js and planning.js.
- **Coordinate with any inspect/pan coexistence work:** this plan keeps the iframe interactive by default, which is compatible with inspect-while-navigating; do not remove the Space-forwarding path.

## Dependencies

- **Foundational for `feature_plan_20260720095405_inspect-and-pan-coexist-html-preview.md`:** that plan depends on this plan's wheel forwarder existing, so panning has a channel that does not require the opaque capture layer. Land this plan before (or together with) the inspect+pan plan.
- No cross-feature dependencies. The `_INSPECTOR_SCRIPT` change is shared by Design and Planning (defined once in `DesignPanelProvider.ts:151`, injected by both providers), so one edit benefits both webviews.

## Adversarial Synthesis

**Key risks:** (1) `e.preventDefault()` on every iframe wheel event disables inner-element scroll inside preview HTML — flagged in User Review as an accepted trade-off for a design-preview context. (2) `deltaMode` mismatch: iframe wheel events may report `deltaMode` 0 (pixels), 1 (lines), or 2 (pages) depending on browser/platform; the parent's existing container wheel handler applies `panX -= deltaX` directly (pixel assumption). Mitigation: include `deltaMode` in the forwarded message and normalize in `applyWheelToTab` (or document that the existing handler also ignores deltaMode and parity is preserved by matching it). (3) Double-pan when `space-pan-active` is true — mitigated by the explicit `if (document.body.classList.contains('space-pan-active')) break;` guard (redundant but safe, since the capture layer covers the iframe in that state and the iframe wheel won't fire). **Mitigations:** normalize deltaMode or match existing behavior; guard against space-pan-active; wrap the iframe listener in try/catch so a malformed event never throws inside the sandboxed preview.

## Proposed Changes

### `src/services/DesignPanelProvider.ts` — `_INSPECTOR_SCRIPT`
Add a wheel forwarder alongside the existing Space-pan forwarder (after [DesignPanelProvider.ts:405](src/services/DesignPanelProvider.ts#L405)):
```js
// ── Wheel forwarding so the parent can pan/zoom the transformed canvas
//    even when the capture layer is hidden (Pan mode off). The iframe is
//    rendered at natural size and swallows wheel events; forward them up. ──
window.addEventListener('wheel', function(e) {
    try {
        e.preventDefault();
        window.parent.postMessage({
            type: 'sbWheel',
            deltaX: e.deltaX, deltaY: e.deltaY,
            ctrlKey: e.ctrlKey, metaKey: e.metaKey
        }, '*');
    } catch (err) {}
}, { passive: false, capture: true });
```

### `src/webview/design.js`
Add an `sbWheel` case in the message switch, next to `sbContentDims`/`sbSpacePan` ([design.js:3651-3699](src/webview/design.js#L3651-L3699)). Factor the container wheel body into a reusable helper so pan-off and pan-on share it:
```js
function applyWheelToTab(tab, containerId, viewportSelector, deltaX, deltaY, ctrlKey, metaKey) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const viewportEl = container.querySelector(viewportSelector);
    if (ctrlKey || metaKey) {
        const factor = Math.exp(-deltaY * 0.01);
        zoomAt(tab, container, viewportEl, zoomState[tab].scale * factor, rect.width / 2, rect.height / 2);
    } else {
        zoomState[tab].panX -= deltaX;
        zoomState[tab].panY -= deltaY;
        const dims = getContentDims(viewportEl);
        if (dims) clampPan(tab, rect, dims.w, dims.h);
        applyZoom(tab, viewportEl);
    }
}
```
```js
case 'sbWheel': {
    if (document.body.classList.contains('space-pan-active')) break; // capture layer handles it
    const htmlFrame = document.getElementById('html-preview-frame');
    const stitchFrame = document.getElementById('stitch-html-preview-frame');
    const d = event.data;
    if (htmlFrame && event.source === htmlFrame.contentWindow) {
        applyWheelToTab('html', 'html-preview-wrapper', '.zoomable-viewport', d.deltaX, d.deltaY, d.ctrlKey, d.metaKey);
    } else if (stitchFrame && event.source === stitchFrame.contentWindow) {
        applyWheelToTab('stitchHtml', 'stitch-html-preview-wrapper', '.zoomable-viewport', d.deltaX, d.deltaY, d.ctrlKey, d.metaKey);
    }
    break;
}
```
(Optionally refactor the existing container `wheel` handler at [design.js:328](src/webview/design.js#L328) to call `applyWheelToTab` too, to keep one code path.)

### `src/webview/planning.js`
Add the mirror `sbWheel` case in planning's message switch (next to its `sbContentDims` at [planning.js:5380](src/webview/planning.js#L5380)), routing `event.source === planning-html-preview-frame.contentWindow` to `applyWheelToTab('planningHtml', 'planning-html-preview-wrapper', '.zoomable-viewport', ...)`, with the same `space-pan-active` guard.

## Verification Plan

1. **Build/reload** the extension.
2. **Design → HTML Previews, Pan mode OFF (default):** open a tall page and scroll the mouse wheel / two-finger swipe over the preview. **Expect:** the canvas pans vertically (and horizontally) — navigation works with pan off.
3. **Links stay interactive:** with pan off, hover and click a link/button in the preview. **Expect:** normal iframe interaction still works.
4. **Ctrl/Cmd+wheel:** hold Ctrl (or Cmd) and scroll. **Expect:** zoom, not pan.
5. **Pan mode ON still works:** toggle ✥ on, drag and wheel. **Expect:** unchanged pan-drag behaviour, no doubled/‌jumpy panning.
6. **Space-hold still works:** hold Space and drag. **Expect:** momentary pan as before; no double-apply with the forwarded wheel.
7. **Repeat 2–5 in Planning → HTML preview** and **Design → Stitch HTML**.
