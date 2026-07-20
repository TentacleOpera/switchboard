# Fix the "Reset zoom" (⟲) toolbar button so it recenters predictably

## Goal

**Problem:** The second-from-right button in the HTML preview zoom toolbar — the ⟲ "circle loop" icon — is confusing and appears to misbehave. Pressing it "does a random zoom into a random location" and the user cannot tell what it is for.

**Background:** The zoom toolbar has five buttons, left to right: Pan (✥), Zoom In (+), Zoom Out (−), **Reset (⟲)**, Fit (⤢). See [design.html:3936-3942](src/webview/design.html#L3936-L3942). The ⟲ button's `data-action="reset"` and its tooltip says "Actual size (100%)". Its *intended* job is: return to 100% scale. But the icon (a circular refresh/loop arrow) and the effect don't communicate that, and the pan handling makes it land somewhere unexpected.

**Root cause:** The `reset` handler sets `scale = 1` and then calls `clampPan(...)` *without recentering* ([design.js:402-411](src/webview/design.js#L402-L411)):
```js
} else if (action === 'reset') {
    zoomState[tab].scale = 1;
    const dims = getContentDims(viewportEl);
    if (dims) {
        clampPan(tab, rect, dims.w, dims.h);   // keeps current panX/panY, only clamps
    } else {
        zoomState[tab].panX = 0;
        zoomState[tab].panY = 0;
    }
    applyZoom(tab, viewportEl);
}
```
`clampPan` only *bounds* the existing pan offset; it does not reset it. So on a page larger than the container, jumping to 100% keeps whatever fractional pan the user had (scaled differently), landing at a seemingly arbitrary scroll position — exactly the "random zoom into a random location" the user describes. Combined with the ambiguous ⟲ icon and "Actual size" tooltip, the button reads as broken.

**Desired behaviour:** "Reset" should be a *predictable* action: go to 100% scale AND recenter to the top of the page (top-anchored, horizontally centered), so the user always lands at a known spot — the top of the content at real size. The icon/tooltip should clearly say "Reset view (100%)".

## Metadata
- **Complexity:** 3
- **Tags:** frontend, ui, ux, bugfix

## User Review Required

- **Glyph choice:** keep ⟲ with a clearer tooltip, or switch to `1:1` / `⌖`? Plan default is keep ⟲ (minimal change). Confirm preference.
- **Tooltip wording:** the plan now uses "Reset view — 100% size" (neutral, true for both tall and small pages) instead of the earlier "back to top" wording, because `clampPan` centers small pages vertically rather than anchoring top. Confirm the neutral wording is acceptable.

## Complexity Audit (Routine vs Complex/Risky)

**Classification: Routine.** A few lines in the `reset` click branch plus a tooltip/label tweak, duplicated across two webviews. No new architecture, no messaging.

## Edge-Case & Dependency Audit

- **Page larger than container at 100%:** after setting scale to 1, anchor `panY = 0` (top) and center `panX` if the scaled width fits, else clamp `panX` to `0` (left edge). Then `clampPan` to keep it legal. Result: top-left/top-center at real size, deterministic.
- **Page smaller than container at 100%:** `clampPan` already centers when content is smaller than the container — that path is fine; the explicit recenter must not fight it (center both axes when content fits).
- **`getContentDims` returns null (dims not yet reported):** keep the existing `panX=0; panY=0` fallback.
- **Icon/label clarity:** the ⟲ glyph reads as "refresh/reload," not "100%." Either keep ⟲ but make the tooltip explicit ("Reset view — 100%, back to top"), or switch to a clearer glyph (e.g. `1:1` text or `⌖`). Minimum viable fix: correct the tooltip and recenter behaviour; optional: change glyph. Keep the Fit (⤢) button as the "fit whole page" affordance so the two are distinct.
- **Duplicated engine — apply in BOTH webviews** (design.js/design.html + planning.js/planning.html) and the Stitch/HTML toolbars in design.html (there are several `.zoom-toolbar` instances; the reset button text/title should be consistent across all).

## Dependencies

- **None.** Independent of the other four subtasks. Can land in any order, though landing after the fit-to-width plan keeps the Reset semantic (100%, top-anchored for tall pages) consistent with the new default open behavior (also top-anchored width-fit).

## Adversarial Synthesis

**Key risks:** (1) For a page *smaller* than the container at 100%, `clampPan` centers both axes — so the explicit `panY = 0` is dead code on that path and the tooltip "back to top" would lie for small pages. Mitigation: tooltip wording is "Reset view — 100% size" (neutral, true in both cases); the explicit `panY = 0` is kept for the tall-page case where `clampPan` does not override it. (2) The recenter logic could double-center if `clampPan` and the explicit assignment fight — mitigated by setting explicit `panX/panY` first, then letting `clampPan` only bound (it writes back to `zoomState` but only adjusts out-of-bounds values; for in-bounds explicit values it is a no-op). Low risk overall.

## Proposed Changes

### `src/webview/design.js`
Rewrite the `reset` branch ([design.js:402-411](src/webview/design.js#L402-L411)) to recenter deterministically:
```js
} else if (action === 'reset') {
    zoomState[tab].scale = 1;
    const dims = getContentDims(viewportEl);
    if (dims) {
        const scaledW = dims.w; // scale === 1
        // horizontal: center if it fits, else pin to left edge
        zoomState[tab].panX = scaledW <= rect.width ? (rect.width - scaledW) / 2 : 0;
        // vertical: always anchor to the top of the page
        zoomState[tab].panY = 0;
        clampPan(tab, rect, dims.w, dims.h); // keep it legal for both fit/overflow cases
    } else {
        zoomState[tab].panX = 0;
        zoomState[tab].panY = 0;
    }
    applyZoom(tab, viewportEl);
}
```

### `src/webview/design.html`
Clarify the Reset button tooltip on every `.zoom-toolbar` (the HTML preview one at [design.html:3940](src/webview/design.html#L3940), plus the Stitch toolbar and image toolbars):
```html
<button class="zoom-btn" data-action="reset" title="Reset view — 100% size">⟲</button>
```
(Optional, if the user prefers a clearer glyph, replace `⟲` with `1:1` and drop `font-size` accordingly — leave ⟲ if minimal change is preferred.) The tooltip says "100% size" (not "back to top") because `clampPan` centers small pages vertically, so "back to top" would be inaccurate for the small-page case.

### `src/webview/planning.js` and `src/webview/planning.html`
- Apply the identical `reset`-branch rewrite ([planning.js:413-420](src/webview/planning.js#L413-L420)).
- Update the Reset button `title` in [planning.html](src/webview/planning.html) (the `.zoom-toolbar` near [planning.html:3809](src/webview/planning.html#L3809)) to the same "Reset view — 100% size".

## Verification Plan

1. **Build/reload** the extension.
2. **Design → HTML Previews:** open a tall page, zoom to ~300%, pan into the middle/right. Click ⟲ Reset. **Expect:** snaps to exactly 100% scale, scrolled to the top of the page, horizontally centered (or left-pinned if wider than the container) — the same spot every time, not a random location.
3. **Small page:** open a page smaller than the container, zoom in, pan away, click Reset. **Expect:** 100%, centered in the container.
4. **Tooltip:** hover ⟲. **Expect:** "Reset view — 100% size".
5. **Distinct from Fit:** confirm ⤢ Fit still fits the whole page and behaves differently from ⟲ Reset.
6. **Repeat 2–4 in Planning → HTML preview** and **Design → Stitch HTML**.
