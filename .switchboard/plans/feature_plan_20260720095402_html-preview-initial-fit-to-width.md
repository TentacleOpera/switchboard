# Open HTML previews fit-to-width, not fully zoomed out

## Goal

**Problem:** When an HTML file is loaded into the Design or Planning preview, it now opens *drastically zoomed out* — tiny and unreadable — where it used to open at a sensible, readable zoom level. This is a regression the user noticed immediately ("it always starts so zoomed out, when previously it started at the right zoom level").

**Background:** The initial view is set by `fitToContainer()`, which is called when the iframe reports its natural content dimensions via the `sbContentDims` message. `fitToContainer` computes a single scale that makes the *entire* page — full width AND full height — fit inside the preview container.

**Root cause:** `fitToContainer` fits the whole page rather than the page width. See [design.js:297](src/webview/design.js#L297):
```js
const fitScale = Math.min(containerRect.width / contentW, containerRect.height / contentH, 1);
```
Because most HTML pages are *tall* (natural height ≫ container height), `containerRect.height / contentH` is a very small number, and `Math.min` picks it — so the page is scaled down until the whole vertical length is visible, i.e. tiny. The planning webview even documents this as the intended behaviour: [planning.js:5399](src/webview/planning.js#L5399) comments `// initial view = whole page`. That "whole page" choice is exactly the regression: a design page should open at readable width, scrolled to the top, not shrunk so its full height fits.

**Desired behaviour:** On initial load, fit the page to the container *width* (never upscale past 100%), anchored at the top-left, so text is readable and the user scrolls/pans down from the top — the classic "fit width" that a browser-like preview should default to. Double-click / the Fit toolbar button can still fit-the-whole-page on demand.

## Metadata
- **Complexity:** 4
- **Tags:** frontend, ui, ux, bugfix

## User Review Required

- **Fit button jump:** after this change, opening a tall page shows it at readable width; clicking ⤢ Fit then shrinks it to whole-page-fit (a visible downward jump). This is the intended "see everything" affordance, but confirm the jump is acceptable UX vs. the old behavior where open and Fit showed the same thing.
- **Narrow-page horizontal anchor:** the plan centers horizontally when the scaled width is narrower than the container. Confirm center (vs. left-pin) is the desired anchor for narrow HTML previews.

## Complexity Audit (Routine vs Complex/Risky)

**Classification: Routine.** A focused change to the initial-scale math plus the initial pan anchor. The only subtlety is keeping images (which legitimately want whole-content fit) on the *old* behaviour while HTML previews get fit-to-width — so the change must be scoped, not global to `fitToContainer`.

## Edge-Case & Dependency Audit

- **Images vs HTML:** The image preview (`images`/`design` tabs) calls `fitToContainer` on `img.onload` and genuinely wants the whole image visible. Do NOT change image fit. Introduce a separate width-fit path for the HTML/Stitch/planning iframe tabs, or pass a `mode` argument (`'width'` vs `'contain'`) and only use `'width'` for iframe tabs.
- **Very wide pages (contentW > containerW):** fit-to-width scales down so full width shows — correct.
- **Narrow pages (contentW < containerW):** clamp scale at 1 (don't upscale) and center horizontally; anchor top vertically.
- **Anchor:** initial `panY` must be `0` (top), not vertically centered — otherwise a tall page opens showing its middle. `panX` centers when the scaled width is narrower than the container, else `0`.
- **Interaction with fit-on-load one-shot:** if the companion "preserve zoom on refresh" work lands, the width-fit must be what the one-shot fit uses on a fresh load; keep the two consistent.
- **Double-click / Fit button unchanged:** the ⤢ Fit action and dblclick should still fit-the-whole-page (contain), so users retain a one-click "see everything" — only the *default open* changes.
- **Duplicated engine — apply in BOTH webviews** (design.js + planning.js) and the Stitch HTML tab in design.js.

## Dependencies

- **Foundational for the feature:** no sibling dependencies; sibling `feature_plan_20260720095401_preserve-html-preview-zoom-on-refresh.md` depends on this plan's `mode` param (its `_fitPending` one-shot fit must pass `'width'` for iframe tabs). Land this plan first.
- No cross-feature dependencies. No backend/provider changes.

## Adversarial Synthesis

**Key risks:** (1) The `fitToContainer` retry recursion (`requestAnimationFrame`) must forward `mode` or a deferred first-load fit silently regresses to `'contain'` — mitigated by the plan explicitly forwarding `mode` in the rAF call. (2) Every `fitToContainer` call site in both webviews must be audited to pass the correct mode (iframe tabs → `'width'`, image tabs + dblclick + Fit button → `'contain'`); a missed site causes inconsistent open behavior with no compiler help — mitigated by the plan enumerating the design.js and planning.js call sites. (3) The Fit-button jump from width to contain on a tall page is intended but visibly different from old behavior — flagged in User Review. **Mitigations:** enumerate all call sites before changing the signature; keep image tabs on default `'contain'`.

## Proposed Changes

### `src/webview/design.js`
Add a fit *mode* to `fitToContainer` (default `'contain'` preserves image behaviour); add a `'width'` mode for iframe previews. Around [design.js:277-302](src/webview/design.js#L277-L302):
```js
function fitToContainer(tab, containerEl, viewportEl, retriesLeft = 5, mode = 'contain') {
    // ... existing rect/content-dim resolution unchanged ...
    if (!contentW || !contentH) return;

    let fitScale, panY;
    if (mode === 'width') {
        fitScale = Math.min(containerRect.width / contentW, 1); // fit width, never upscale
        panY = 0;                                                // anchor at top
    } else {
        fitScale = Math.min(containerRect.width / contentW, containerRect.height / contentH, 1);
        panY = (containerRect.height - contentH * fitScale) / 2;
    }
    zoomState[tab].scale = fitScale;
    zoomState[tab].panX = (containerRect.width - contentW * fitScale) / 2;
    zoomState[tab].panY = panY;
    applyZoom(tab, viewportEl);
}
```
Note: the `retriesLeft` recursion call must forward `mode` too:
```js
requestAnimationFrame(() => fitToContainer(tab, containerEl, viewportEl, retriesLeft - 1, mode));
```

In the `sbContentDims` handler, request width-fit for the iframe tabs ([design.js:3684](src/webview/design.js#L3684) and [design.js:3695](src/webview/design.js#L3695)):
```js
fitToContainer('html', wrapper, vp, 5, 'width');
// ...and for the stitch branch:
fitToContainer('stitchHtml', wrapper, vp, 5, 'width');
```
Leave the image `fitToContainer('images'/'design', ...)` calls ([design.js:1551](src/webview/design.js#L1551), [design.js ~1589](src/webview/design.js#L1589)) on the default `'contain'` mode. Leave the dblclick handler ([design.js:387](src/webview/design.js#L387)) and the ⤢ Fit toolbar action ([design.js:413](src/webview/design.js#L413)) on `'contain'` so "fit whole page" stays available on demand.

### `src/webview/planning.js`
- Add the same `mode` parameter to `fitToContainer` ([planning.js:287-311](src/webview/planning.js#L287-L311)), forwarding it in the retry recursion.
- Change the `sbContentDims` call at [planning.js:5399](src/webview/planning.js#L5399) to `fitToContainer('planningHtml', wrapper, vp, 5, 'width')` and update the misleading `// initial view = whole page` comment to `// initial view = fit to width, top-anchored`.
- Change the one-shot `load` fallback fit ([planning.js:4125](src/webview/planning.js#L4125)) to width mode as well.
- Keep the dblclick fit ([planning.js:397](src/webview/planning.js#L397)) and Fit toolbar action ([planning.js:423](src/webview/planning.js#L423)) on `'contain'`.

## Verification Plan

1. **Build/reload** the extension.
2. **Design → HTML Previews:** open a typical tall design HTML file. **Expect:** it opens at readable width, scrolled to the very top (page title/header visible), NOT shrunk to fit the whole height.
3. **Wide page:** open a page wider than the container. **Expect:** full width visible, scaled down as needed.
4. **Fit-whole-page still works:** click the ⤢ Fit button (and double-click the canvas). **Expect:** the entire page shrinks to fully fit — the on-demand "see everything" is intact.
5. **Images unaffected:** open the Images tab and a large image. **Expect:** whole image fits (unchanged contain behaviour).
6. **Repeat 2–4 in Planning → HTML preview** and **Design → Stitch HTML**.
