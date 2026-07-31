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
   (`src/webview/planning.html:3779`). Measured with no usable layout width, `scrollWidth` falls
   back to the document's **min-content** width — for the repro page roughly 350px, set by its
   narrowest grid tracks (`184px 1fr`, `minmax(196px, 1fr)`) plus padding.

> **Superseded:** `#planning-html-preview-wrapper` starts `display: none` (`src/webview/planning.html:3793`).
> **Reason:** Stale line reference — line 3793 is a `<textarea>` inside the tweak popup; the wrapper's inline `style="display: none; flex: 1;"` is at line 3779.
> **Replaced with:** `src/webview/planning.html:3779` (corrected inline above).

   Clarification (added during improve pass): `handlePreviewReady` sets the wrapper to
   `display: flex` *before* assigning `iframe.src`/`srcdoc` (planning.js:4377/4386,
   design.js:1475/1486), so the zero-layout window is not the wrapper's own initial `display:
   none` in the common path — it is any moment the iframe loads while an *ancestor* suppresses
   layout (inactive webview tab pane, hidden panel) or before first layout settles. The fix must
   therefore guard on the measured zero-width condition itself, not on any specific ancestor.

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

**Research addendum (web research, post-review).** Chromium research contradicts the min-content
detail in mechanism step 4: while an iframe (or any ancestor) is `display:none`, Blink detaches
the layout tree and `document.documentElement.clientWidth` **and** `scrollWidth` synchronously
return `0` — not a min-content fallback. A hidden-state report therefore could never have posted
(the existing `w && h` truthy guard suppresses zeros). The wrong ~350px value must instead have
been measured while the frame *was* laid out but at a genuinely narrow width (e.g. the webview's
initial pre-settle layout), after which the self-confirming loop of mechanism step 5 locked it in.
The fix is unaffected: the genuine-overflow test (Implementation step 1) is the true cure for a
narrow-but-laid-out measurement, and the zero-width bail remains defence-in-depth for the
hidden state. The original analysis above is preserved for audit; this addendum is authoritative
where they conflict.

## Metadata

**Complexity:** 4
**Tags:** bugfix, frontend, ui

> **Superseded:** Complexity 3; Tags `bug, webview, html-preview, design-panel`.
> **Reason:** Tags must come from the allowed vocabulary (`bugfix` not `bug`; `webview`/`html-preview`/`design-panel` are not allowed tags). Complexity bumped 3 → 4: the edit touches three consumer sites across two large mirrored webview bundles plus a reporter, and the consumer-side damping rule (never actuate on the fluid signal) is a subtle correctness constraint, not a mechanical edit.
> **Replaced with:** Complexity 4; Tags `bugfix, frontend, ui`.

## User Review Required

- Step 2 of the Implementation Steps was **superseded** during the improve pass: `w: null` no
  longer writes `100%` to the viewport (that re-created the feedback loop in the opposite
  direction for fixed-width pages). Review that Superseded callout before dispatching.
- Two Chromium behavior assumptions that underpinned the recovery path and the overflow test were
  **confirmed by web research** — see `## Resolved Assumptions`. That research also contradicts
  the min-content detail in the root-cause analysis (while hidden, Chromium reports `0`, not
  min-content); the analysis is preserved with an authoritative Research addendum. Flagged here
  per content-preservation protocol rather than silently rewritten.

## Non-Goals

- No change to the zoom/pan/fit transform maths (`fitToContainer`, `clampPan`, `applyZoom`).
- No change to Inspect Mode, `sbWheel` forwarding, or the pan capture layer.
- No change to the image preview path (`#image-preview-container`), which is already correct.
- Not removing the `MAX_PREVIEW_DIM` ceiling — it guards a real, separate case.
- No edits to any previewed content file. Adding `min-width` to individual HTML files is a
  workaround for one document, not a fix for the viewer.

## Complexity Audit

### Routine
- One reporter function rewrite inside an injected-script template string (`DesignPanelProvider.ts`).
- Three near-identical `sbContentDims` consumer edits following an existing mirrored pattern.
- One new regression test file following the repo's established `*-regression.test.js` Node `assert` convention.
- No changes to transform maths, message routing, or the sandbox configuration.

### Complex / Risky
- The sizing system is a closed feedback loop (report → resize → re-report); any consumer reaction to the fluid signal re-arms it. The damping rule ("never write width on `w: null`") must be applied identically in all three consumers or fixed-width mockups oscillate.
- The consumer guard `msg.w && msg.h` must be restructured so a null width does not also drop legitimate height updates (pan-clamp regression on tall fluid pages).
- Scrollbar semantics differ between `clientWidth` and `innerWidth`; a naive `scrollWidth > clientWidth` comparison yields false "intrinsic" positives on classic-scrollbar platforms.

## Edge-Case & Dependency Audit

- **Race Conditions:** A stale `sbContentDims` from a previous document can arrive after a file
  switch. Mitigated by the existing checks: `handlePreviewReady` resets the viewport to `100%` and
  dims to `null` on every (auto-)refresh, and consumers gate on `event.source` matching the live
  iframe's `contentWindow`; a navigating iframe destroys its old document, ending its reports.
  ResizeObserver re-reports interleaved with user zoom are already handled by the `_fitPending`
  one-shot and the clamp-preserving-zoom branch — unchanged by this fix.
- **Security:** No new message types and no new injection surface — the reporter already runs
  inside the sandboxed iframe (`allow-scripts allow-same-origin`) and already posts `sbContentDims`.
  Consumers must keep validating `event.source` against the known iframe before acting, as today.
- **Side Effects:** `_planningContentDims` / `_htmlContentDims` / `_stitchHtmlContentDims` feed
  `getContentDims`, which drives `clampPan` in both wheel-pan and zoom paths. On `w: null` these
  must be set to a real number pair (`{ w: wrapper.clientWidth, h: msg.h }`), never left `null`
  after a report, or pan clamping silently degrades to element measurement fallbacks.
- **Dependencies & Conflicts:** `planning.js` and `design.js` intentionally mirror each other's
  zoom math (`resetZoom`/`applyZoom`/`clampPan`/`fitToContainer` exist in both). There is no
  shared webview module, so the "shared helper" of step 2 is shared *within* `design.js` (its two
  branches) while `planning.js` keeps a mirrored copy — consistent with existing convention.
  `MAX_PREVIEW_DIM` (30000) still applies to numeric widths and all heights.

## Dependencies

- None — no prior session artifacts are required.

## Adversarial Synthesis

Key risks: the consumer-side response to `w: null` re-arming the sizing feedback loop as a
100%-vs-intrinsic oscillation on fixed-width pages; the truthy `msg.w && msg.h` guard silently
dropping height updates for fluid pages; and a scrollbar-induced false "intrinsic" classification
on classic-scrollbar platforms. Mitigations: never write viewport width on `w: null` (per-load
`100%` resets already exist), key the consumer guard on `msg.h`, and compare overflow against
`Math.max(clientWidth, window.innerWidth) + 1`.

## Resolved Assumptions

Both Chromium behavior questions flagged during review were confirmed by web research
(CSSOM View spec, ResizeObserver spec, and Blink source: `element.cc`,
`resize_observer_controller.cc`). These findings are authoritative:

1. **CONFIRMED — ResizeObserver recovery across visibility transitions.** A `ResizeObserver`
   observing `document.documentElement` inside an iframe fires after the iframe (or an ancestor)
   transitions from `display:none` to laid out: Blink rebuilds the layout tree during the next
   "Update the rendering" pass and `DeliverObservations()` runs in the same lifecycle cycle.
   Since Chrome 112, hidden iframes are render-throttled (RO/rAF paused while hidden, flushed in
   the next frame on un-hide), so recovery carries a mandatory single-frame delay but is
   reliable. Caveat: synchronous dimension reads in the same microtask as the un-hide still
   return `0` — our reporter only reads on observer/load/resize callbacks, never synchronously
   after a visibility change, so this trap does not apply.
2. **CONFIRMED — scrollbar geometry.** `window.innerWidth` includes the classic (Windows/Linux)
   scrollbar width; `document.documentElement.clientWidth` excludes it; on macOS overlay
   scrollbars they are equal. Additionally, vertical-scrollbar *insertion* alone can make
   `scrollWidth > clientWidth` (clientWidth contracts by 15-17px while non-shrinkable content
   holds scrollWidth), which is precisely the false-positive the
   `Math.max(clientWidth, innerWidth)` comparison guards against. Note: `innerWidth` is used only
   as a comparison baseline — never as a sizing source — consistent with the research's guidance.

Related research finding already encoded in this plan: Chrome 132 tightened ResizeObserver
loop-limit assertions — resizing the iframe from within the report→resize cycle risks
`"ResizeObserver loop completed with undelivered notifications"`, which is exactly what the
consumer damping rule (never write width on `w: null`) prevents.

## Implementation Steps

### 1. Make the reporter distinguish "intrinsic" from "fluid"

In `src/services/DesignPanelProvider.ts`, rewrite `reportDims` (line 576) so it never reports a
degenerate measurement and never claims an intrinsic width the page does not have:

- **Bail when the frame has no layout.** If `document.documentElement.clientWidth` is `0`, return
  without posting. This alone stops the min-content value from ever reaching the parent.
- **Report width only on genuine overflow.** Compute
  `overflows = rawW > Math.max(d.clientWidth, window.innerWidth) + 1`, where `rawW` is the same
  `Math.max(d.scrollWidth, body ? body.scrollWidth : 0)` value reported today (1px tolerance for
  sub-pixel rounding; the `innerWidth` term neutralizes classic-scrollbar false positives).
  Post `w: rawW` only when `overflows` is true; otherwise post `w: null`, meaning "I have no
  intrinsic width, size me to the container".
- **Keep reporting height unconditionally.** Vertical growth is legitimate and is what the pan
  bounds need.

Height must stay independent of the width decision — a fluid page still has a real content height.

Clarification (testability): implement the decision as a pure function
(`computeReportedWidth(rawW, clientWidth, innerWidth)` → `number | null`) defined once in the
TypeScript source and embedded into the injected script via `fn.toString()`, so the regression
test exercises the exact shipped logic rather than a copy.

### 2. Honour the fluid signal in all three consumers — by damping, not actuating

`src/webview/planning.js:5643` and both branches of `src/webview/design.js:3509`:

> **Superseded:** When `msg.w` is `null`, set `vp.style.width = '100%'` instead of a pixel value,
> and use the wrapper's current width for the stored dims.
> **Reason:** Writing `100%` on null re-arms the feedback loop in the opposite direction for
> intrinsic-width pages: apply 1200px → content fits → next report `w: null` → reset to 100% →
> overflow → `w: 1200` → … a ResizeObserver-cadence oscillation on exactly the fixed-width mockup
> class this viewer was built for. It is also redundant: `handlePreviewReady` already resets the
> viewport to `100%` on every (auto-)refresh (planning.js:4365-4368, design.js:1472,
> design.js:1549), so the fluid default needs no consumer action.
> **Replaced with:** Never write viewport width in response to `w: null`. On null, leave
> `vp.style.width` exactly as it is (it is `100%` from the per-load reset unless a previous
> intrinsic report for the same file set a pixel width — in which case that width is correct and
> must be kept), and record dims as `{ w: <kept pixel width if one is applied, else
> wrapper.clientWidth>, h: msg.h }` so `clampPan`/`fitToContainer` keep working against real
> numbers.

Consumer restructure (all three sites):

- Change the guard from `msg.w && msg.h` to `msg.h` so a null width does not drop height updates.
- `typeof msg.w === 'number'` → cap with `MAX_PREVIEW_DIM`, write pixel width and height, store
  dims, then run the existing fit-or-clamp branch unchanged.
- `msg.w === null` → write **only** `vp.style.height`, store dims per the replacement rule above,
  then run the same fit-or-clamp branch (for a fluid page `fitToContainer` measures the iframe at
  `100%` width and converges on scale 1, top-anchored — a no-op visually).

The two `design.js` branches share one local helper; `planning.js` keeps a mirrored copy per the
files' existing duplication convention (no shared webview module exists).

### 3. Add a parent-side guard against hidden-wrapper reports

Defence in depth, in the same handler: ignore any report that arrives while the wrapper is not
laid out — `if (!wrapper || wrapper.offsetParent === null) break;`. This protects against future
reporters and against the tab being switched mid-load. (The reporter's zero-width bail in step 1
already suppresses these reports; this guard keeps the consumers safe even against a reporter
that posts anyway.)

### 4. Recovery when the wrapper becomes visible

> **Superseded:** "Confirm the existing `_fitPending` path still fires on tab activation; if it
> does not, request a fresh `reportDims` from the iframe when the wrapper transitions to visible."
> **Reason:** There is no tab-activation re-fit in either webview bundle (verified by search), and
> no parent→iframe "report now" channel exists — building one is net-new machinery the graceful
> degradation below does not justify.
> **Replaced with:** Rely on the existing three-layer recovery, and document the degradation: (a)
> the viewport is already `100%` from the per-load reset, so a fluid page renders correctly even
> with zero further reports; (b) the injected `ResizeObserver` on `document.documentElement`
> re-fires `reportDims` when a hidden iframe gains layout — **confirmed by research** (see
> `## Resolved Assumptions` item 1): reliable, with a single-frame delay after un-hide due to
> Chrome 112+ render throttling; (c) the one-shot load-fallback `fitToContainer`
> (planning.js:4404-4416) and `notifyIframeResize` (design.js:620-639) still run. If (b) were
> ever suppressed, intrinsic-width pages loaded while hidden degrade to in-iframe horizontal
> scrolling at 100% width until the next refresh — degraded, not broken; fluid pages are
> unaffected.

### 5. Regression test

> **Superseded:** Add `src/test/html-preview-fluid-width.test.js` and run it with
> `npx jest ... --forceExit`.
> **Reason:** This repository has no jest — no config, no dependency, `npm test` is `vscode-test`.
> The established convention is plain Node `assert` scripts named `*-regression.test.js`,
> executed directly with `node --require ./src/test/bootstrap/sandboxStateHome.js
> src/test/<name>.test.js` (exit code signals pass/fail).
> **Replaced with:** Add `src/test/html-preview-fluid-width-regression.test.js` in that
> convention, importing the compiled `out/services/DesignPanelProvider` module (and the extracted
> pure decision function from step 1) to assert:

- `clientWidth === 0` → no message posted (decision returns without a report).
- `scrollWidth === clientWidth` (fluid) → `w === null`, `h` still reported.
- `scrollWidth > clientWidth` (intrinsic, e.g. a 1200px mockup in an 800px frame) → `w === 1200`.
- Scrollbar false-positive guard: `scrollWidth === innerWidth > clientWidth` (classic scrollbar)
  → `w === null`.
- Consumer damping: applying a `w: null` report after an intrinsic report leaves the viewport's
  pixel width unchanged (no `100%` write — the oscillation guard).

## Proposed Changes

### `src/services/DesignPanelProvider.ts`

- **Context:** `_INSPECTOR_SCRIPT` (lines ~430-586) is the template string injected into every
  previewed HTML file; `reportDims` (line 576) is its sizing reporter.
- **Logic:** Classify the page as intrinsic-width only when the measured content width genuinely
  exceeds the frame's usable viewport; otherwise report `w: null` (fluid). Never report when the
  frame has no layout.
- **Implementation:** Extract the classification into a pure function embedded via `.toString()`
  (step 1 clarification); `reportDims` bails on `clientWidth === 0`, computes `overflows` with
  the `innerWidth` guard, and posts `{ type: 'sbContentDims', w: rawW | null, h }`.
- **Edge Cases:** Sub-pixel rounding (1px tolerance); classic scrollbars (`innerWidth` term);
  `document.body` absent during early parse (existing ternary preserved); zero-layout iframe
  (bail).

### `src/webview/planning.js`

- **Context:** `case 'sbContentDims'` (line 5643) currently writes reported dims straight onto the
  viewport (line 5659) under a `msg.w && msg.h` guard; the per-load `100%` reset already lives in
  `handlePreviewReady` (lines 4365-4368).
- **Logic:** Damp the loop — actuate width only on a genuine intrinsic report; keep height flowing
  on every report.
- **Implementation:** Guard on `msg.h`; numeric `msg.w` keeps today's behaviour including the
  `MAX_PREVIEW_DIM` cap; `msg.w === null` updates height and stored dims only (step 2 replacement
  rule). Add the hidden-wrapper `offsetParent` guard (step 3).
- **Edge Cases:** Stale report after file switch (source check + per-load reset); report while
  hidden (guard); intrinsic report followed by null reports (width retained — oscillation guard).

### `src/webview/design.js`

- **Context:** `case 'sbContentDims'` (line 3509) has two mirrored branches — `html-preview-frame`
  (line 3527) and `stitch-html-preview-frame` (line 3545); per-load resets at lines 1472 and 1549.
- **Logic / Implementation / Edge Cases:** Identical to `planning.js`, with the shared body
  factored into one local helper used by both branches (step 2).

### `src/test/html-preview-fluid-width-regression.test.js`

- **Context:** New regression test in the repo's Node `assert` convention (see superseded step 5).
- **Logic:** Assert the reporter's classification table and the consumer's damping rule.
- **Implementation:** Imports the compiled module under `out/` and the extracted pure function;
  runs standalone with `node --require ./src/test/bootstrap/sandboxStateHome.js
  src/test/html-preview-fluid-width-regression.test.js`.
- **Edge Cases:** The five assertions listed in step 5, including the scrollbar false-positive and
  the post-intrinsic null damping case.

## Verification Plan

Per session directives, no compilation step and no automated test run is part of this verification
plan. The regression test file is authored as part of implementation and can be executed on demand
with `node --require ./src/test/bootstrap/sandboxStateHome.js
src/test/html-preview-fluid-width-regression.test.js`.

### Automated Tests

- Omitted per session directive (SKIP TESTS). On-demand command recorded above.

### Manual

Prerequisite (performed outside this plan's scope — SKIP COMPILATION): the fix must be live in the
installed extension. The running extension loads from
`~/.devin/extensions/turnzero.switchboard-1.7.13/dist/`, **not** the repo `dist/` — a build alone
will not change what is live; sync and reload before checking.

1. **The repro.** Planning → HTML tab → open `viaapp-design-system.html`. It must fill the panel
   width, with swatches in a multi-column grid and type-scale rows in their two-column desktop
   layout. Confirm the page is *not* in its mobile breakpoint.
2. **No regression on fixed-width pages.** Open `autism360_mockups.html` and `vara-nav-preview.html`
   in the same tab. Both must render exactly as before, at their natural widths — and remain
   stable (no flicker or width oscillation while the ResizeObserver settles).
3. **No regression on tall pages.** Open a `100vh`-section Stitch page in the Design HTML tab.
   Confirm it still stabilises and does not inflate the canvas.
4. **Tab-switch path.** Switch away from the HTML tab and back with a fluid page loaded. It must
   render correctly on return (via the recovery layers in step 4).
5. **Zoom and pan.** With a fluid page loaded, confirm fit-to-width, manual zoom, Space-pan and
   Inspect Mode all still behave.

## Recommendation

**Send to Coder** (complexity 4).

## Completion Report
