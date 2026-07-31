# Fix HTML preview collapsing fluid pages to min-content width

## Goal

Make the HTML preview iframe (Planning HTML tab, Design HTML tab, Stitch HTML tab) render
responsive/fluid pages at the panel's width instead of collapsing them to a narrow column.
A fluid page must fill the preview panel exactly as it would fill a browser window; only a page
with a genuine intrinsic width wider than the panel should drive the viewport wider.

### Problem analysis / root cause

**Symptom.** A fluid, responsive HTML file previewed in the Planning HTML tab renders in a narrow
column (~350px) with dead space beside it, while the same file opened directly in a browser renders
correctly at full width. Reproduced with
`/Users/patrickvuleta/Documents/GitHub/patrickwork/designs/viaapp-design-system.html`, a fully fluid
page whose only width constraint is `.wrap { max-width: 1020px; margin: 0 auto }`. Because the
collapsed width falls under the page's own `@media (max-width: 640px)` breakpoint, the page also
switches to its mobile layout inside the viewer — visible as two-column rows stacking to one.

**Mechanism.** The preview sizes the iframe from a width the previewed page reports about itself,
which for a fluid page is not a real measurement.

1. `_INSPECTOR_SCRIPT` is injected into every previewed file and reports content dimensions
   (`src/services/DesignPanelProvider.ts:576-586`):

   ```js
   function reportDims() {
       var d = document.documentElement;
       var w = Math.max(d.scrollWidth, document.body ? document.body.scrollWidth : 0);
       ...
       if (w && h) window.parent.postMessage({ type: 'sbContentDims', w: w, h: h }, '*');
   }
   ```

2. Every consumer writes that number straight onto the zoomable viewport as a hard pixel width —
   `src/webview/planning.js:5659`, `src/webview/design.js:3527` and `src/webview/design.js:3545`:

   ```js
   vp.style.width  = w + 'px';
   ```

3. **`scrollWidth` is not an intrinsic width.** For a page that does not overflow horizontally,
   `scrollWidth === clientWidth` — it simply echoes back whatever width the iframe currently has.
   The measurement is therefore self-referential.

4. **An early measurement lands on min-content.** `reportDims` fires on `setTimeout(..., 0)` and on
   `load`, and `#planning-html-preview-wrapper` starts `display: none`
   (`src/webview/planning.html:3793`). Measured with no usable layout width, `scrollWidth` falls
   back to the document's **min-content** width — for the repro page roughly 350px, set by its
   narrowest grid tracks (`184px 1fr`, `minmax(196px, 1fr)`) plus padding.

5. **The wrong value is self-confirming and never recovers.** Once ~350px is written to the
   viewport, the iframe genuinely is 350px wide. `ResizeObserver` re-fires, `scrollWidth` measures
   350px again, and the same value is posted and re-applied. There is no force pushing the width
   back out, so the loop is stable at the wrong value. Dropping below the page's own mobile
   breakpoint can reduce min-content further, tightening the collapse.

**Why this was not caught.** Every other file in the design folders
(`autism360_mockups.html`, `vara-nav-preview.html`, the Stitch output the feature was built for) is
a fixed-width mockup. Their `scrollWidth` is pinned by an element with an explicit pixel width, so
even an early measurement returns the correct number and the loop converges immediately. The bug
only appears for pages with no intrinsic width.

**Related, already-handled failure.** The same feedback loop was previously hit in the *grow*
direction — `100vh`-section pages inflating the canvas without bound — and was fixed with a
`MAX_PREVIEW_DIM = 30000` cap (`src/webview/planning.js:5644-5648`,
`src/webview/design.js:3513-3518`). That cap is a ceiling only; there is no corresponding floor, so
the shrink direction is unguarded. This plan closes that direction properly rather than by adding
a second magic constant.

**Verified against the shipped build.** `Math.max(d.scrollWidth, ...)` is present verbatim in the
installed extension at both `~/.devin/extensions/turnzero.switchboard-1.7.13/dist/extension.js` and
`~/.antigravity-ide/extensions/turnzero.switchboard-1.7.13/dist/extension.js`, so this is live
behaviour and not a dev-only regression.

## Metadata

**Complexity:** 3
**Tags:** bug, webview, html-preview, design-panel

## Non-Goals

- No change to the zoom/pan/fit transform maths (`fitToContainer`, `clampPan`, `applyZoom`).
- No change to Inspect Mode, `sbWheel` forwarding, or the pan capture layer.
- No change to the image preview path (`#image-preview-container`), which is already correct.
- Not removing the `MAX_PREVIEW_DIM` ceiling — it guards a real, separate case.
- No edits to any previewed content file. Adding `min-width` to individual HTML files is a
  workaround for one document, not a fix for the viewer.

## Implementation Steps

### 1. Make the reporter distinguish "intrinsic" from "fluid"

In `src/services/DesignPanelProvider.ts`, rewrite `reportDims` (line 576) so it never reports a
degenerate measurement and never claims an intrinsic width the page does not have:

- **Bail when the frame has no layout.** If `document.documentElement.clientWidth` is `0`, return
  without posting. This alone stops the min-content value from ever reaching the parent.
- **Report width only on genuine overflow.** Compute `overflows = scrollWidth > clientWidth + 1`
  (1px tolerance for sub-pixel rounding). Post `w` only when `overflows` is true; otherwise post
  `w: null`, meaning "I have no intrinsic width, size me to the container".
- **Keep reporting height unconditionally.** Vertical growth is legitimate and is what the pan
  bounds need.

Height must stay independent of the width decision — a fluid page still has a real content height.

### 2. Honour the fluid signal in all three consumers

`src/webview/planning.js:5643` and both branches of `src/webview/design.js:3509`:

- When `msg.w` is `null`, set `vp.style.width = '100%'` instead of a pixel value, and use the
  wrapper's current width for `_planningContentDims` / `_htmlContentDims` so the pan and fit maths
  keep working against a real number.
- When `msg.w` is a number, behave exactly as today (including the `MAX_PREVIEW_DIM` cap).

The three blocks are near-identical; factor the shared body into one helper rather than editing the
same logic three times.

### 3. Add a parent-side guard against hidden-wrapper reports

Defence in depth, in the same handler: ignore any report that arrives while the wrapper is not
laid out — `if (!wrapper || wrapper.offsetParent === null) break;`. This protects against future
reporters and against the tab being switched mid-load.

### 4. Re-fit once the wrapper becomes visible

Because reports are now dropped while hidden, the first good measurement must be triggered when the
panel is shown. Confirm the existing `_fitPending` path still fires on tab activation; if it does
not, request a fresh `reportDims` from the iframe when the wrapper transitions to visible.

### 5. Regression test

Add `src/test/html-preview-fluid-width.test.js` covering the reporter's decision logic in isolation
(extract it to a pure function if needed to keep it testable):

- `clientWidth === 0` → no message posted.
- `scrollWidth === clientWidth` (fluid) → `w === null`, `h` still reported.
- `scrollWidth > clientWidth` (intrinsic, e.g. a 1200px mockup in an 800px frame) → `w === 1200`.
- Applying a `w: null` report leaves `vp.style.width === '100%'`.

## Proposed Changes

### `src/services/DesignPanelProvider.ts`

`reportDims` (line 576) gains the zero-width bail and the overflow test, and posts `w: null` for
fluid pages. This is the single highest-value change — it is one edit that corrects all three
consumers.

### `src/webview/planning.js`

`case 'sbContentDims'` (line 5643): handle `w === null` by setting `100%`; add the hidden-wrapper
guard. Line 5659 stops being an unconditional pixel write.

### `src/webview/design.js`

`case 'sbContentDims'` (line 3509): same treatment for both the `html-preview-frame` branch
(line 3527) and the `stitch-html-preview-frame` branch (line 3545), via the shared helper.

### `src/test/html-preview-fluid-width.test.js`

New file, per step 5.

## Verification Plan

### Automated

- `npx jest src/test/html-preview-fluid-width.test.js --forceExit` passes.
- Full suite `npx jest src --forceExit` shows no new failures.

### Manual

1. Build, sync to the installed extension folder, reload the window. The running extension loads
   from `~/.devin/extensions/turnzero.switchboard-1.7.13/dist/`, **not** the repo `dist/` — a build
   alone will not change what is live.
2. **The repro.** Planning → HTML tab → open `viaapp-design-system.html`. It must fill the panel
   width, with swatches in a multi-column grid and type-scale rows in their two-column desktop
   layout. Confirm the page is *not* in its mobile breakpoint.
3. **No regression on fixed-width pages.** Open `autism360_mockups.html` and `vara-nav-preview.html`
   in the same tab. Both must render exactly as before, at their natural widths.
4. **No regression on tall pages.** Open a `100vh`-section Stitch page in the Design HTML tab.
   Confirm it still stabilises and does not inflate the canvas.
5. **Tab-switch path.** Switch away from the HTML tab and back with a fluid page loaded. It must
   re-fit correctly rather than staying collapsed — this exercises step 4.
6. **Zoom and pan.** With a fluid page loaded, confirm fit-to-width, manual zoom, Space-pan and
   Inspect Mode all still behave.

## Completion Report
