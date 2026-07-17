# Wire Up the Planning Panel HTML Preview Zoom/Pan Controls (all four buttons are dead)

## Goal

Make the Planning panel's **HTML PREVIEWS** canvas navigable. Today the preview renders, but every zoom/pan control is inert: the four toolbar buttons do nothing, the transparent capture layer is never shown, and there is no way to zoom or pan the previewed page.

### Problem analysis & root cause

The Planning panel's HTML previewer markup in [planning.html](src/webview/planning.html) is a near-exact copy of the Design panel's: `#planning-html-preview-wrapper` is a `.zoomable-container` ([planning.html:3752](src/webview/planning.html#L3752)) holding a `.zoomable-viewport` (sized `width:100%; height:100%`, [planning.html:3753](src/webview/planning.html#L3753)), the preview `<iframe id="planning-html-frame">` ([planning.html:3754](src/webview/planning.html#L3754)), a `.zoom-event-layer` ([planning.html:3774](src/webview/planning.html#L3774)), and a `.zoom-toolbar` with four buttons — `zoom-in`, `zoom-out`, `reset`, `fit` ([planning.html:3775-3780](src/webview/planning.html#L3775-L3780)).

**But the entire zoom/pan engine is missing from the Planning webview's script.** [planning.js](src/webview/planning.js) has **zero** references to `initZoomListeners`, `zoomState`, `zoomAt`, `fitToContainer`, `clampPan`, or `applyZoom` (confirmed by grep — 0 matches). `planning.js` only shows/hides `#planning-html-preview-wrapper` and assigns the iframe's `src` / `srcdoc` ([planning.js:3852-3898](src/webview/planning.js#L3852-L3898)). Nothing:
- attaches a `wheel` / `mousedown` / `mousemove` / `mouseup` handler to the container → **no drag-pan, no scroll-zoom**;
- attaches a `click` handler to `.zoom-btn` → **the +, −, ⟲, ⤢ buttons do nothing**;
- listens for Space to reveal the capture layer → **no Space-pan**.

Two supporting gaps compound it:
1. **No CSS to drive the capture layer.** [planning.html](src/webview/planning.html) has the `.zoomable-container` / `.zoomable-viewport` / `.zoom-toolbar` / `.zoom-btn` rules ([planning.html:2092-2160](src/webview/planning.html#L2092-L2160)) but **no `.zoom-event-layer` rule and no `body.space-pan-active .zoom-event-layer` rule** (grep finds the `.zoom-event-layer` only as the bare `<div>` at line 3774, with no style). So even if an engine set `space-pan-active`, the layer would not become an interactive overlay — it has no `position`/`inset`/`z-index`/`display` styling.
2. **The iframe fills the container exactly** (`width:100%; height:100%`), so — exactly as in the Design panel — a fit-to-view would collapse into reset (both compute scale 1) unless the canvas is given the previewed page's natural size.

Good news that shrinks this task: the Planning panel **already** has the cross-iframe plumbing this needs. [PlanningPanelProvider.ts](src/services/PlanningPanelProvider.ts) already injects `DesignPanelProvider._INSPECTOR_SCRIPT` into previewed HTML on both the `srcdoc` path ([PlanningPanelProvider.ts:2082](src/services/PlanningPanelProvider.ts#L2082)) and the served path ([PlanningPanelProvider.ts:1983](src/services/PlanningPanelProvider.ts#L1983)); and [planning.js](src/webview/planning.js) already has a `window.addEventListener('message', ...)` switch with an `sbInspectState` case guarded by `event.source === planningHtmlFrame.contentWindow` ([planning.js:4663](src/webview/planning.js#L4663), [planning.js:5126-5131](src/webview/planning.js#L5126-L5131)) and an Inspect toggle button that posts into the frame ([planning.js:8621-8626](src/webview/planning.js#L8621-L8626)). So the message channel and injection points exist — only the parent-side engine and CSS are absent.

> **Verified during improve pass:** `DesignPanelProvider._INSPECTOR_SCRIPT` **already emits** `sbSpacePan` ([DesignPanelProvider.ts:397,401,404](src/services/DesignPanelProvider.ts#L397)) and `sbContentDims` ([DesignPanelProvider.ts:412](src/services/DesignPanelProvider.ts#L412)), guarded by `window.__sbInspectorInstalled` ([DesignPanelProvider.ts:153](src/services/DesignPanelProvider.ts#L153)). PlanningPanelProvider injects that same script. So the iframe bridge messages already exist — Space-pan and fit-to-natural-size light up automatically once this plan adds the parent-side consumers. No companion-plan dependency.

### The fix

Give the Planning webview the same working zoom/pan engine the Design panel has, plus the missing CSS, and a keyboard-free **Pan** toggle so navigation works regardless of iframe focus. Reuse the Planning panel's existing `message` switch to consume the iframe bridge messages.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, ui, ux, bugfix

## User Review Required

Yes — review the four correctness corrections below (marked **Superseded**) before dispatch. They change the step-1 CSS, the step-3 engine shape, and the step-4 message handlers from the original draft. Also confirm the share-vs-duplicate decision (Option B chosen; Option A3 noted as a DRY alternative the original plan missed).

## Complexity Audit

### Routine
- Add `.zoom-event-layer` + `body.space-pan-active` CSS to `planning.html` — copy the two rules verbatim from [design.html:2038-2047](src/webview/design.html#L2038-L2047).
- Add the `#planning-html-preview-wrapper > .zoomable-viewport` flex-flow override — copy verbatim from [design.html:2026-2032](src/webview/design.html#L2026-L2032) (substitute the planning wrapper id).
- Wire `.zoom-btn` click actions + add the Pan toggle button to the toolbar — one toolbar; identical handler shape to the Design panel ([design.js:384-409](src/webview/design.js#L384-L409)).
- Consume `sbSpacePan` / `sbContentDims` in the existing `message` switch — add two cases beside the existing `sbInspectState` case, reusing its frame-source guard.
- Apply natural-size canvas + initial fit on preview load — hook into the existing `planning-html-folder` branch of `handlePreviewReady` ([planning.js:3852](src/webview/planning.js#L3852)).

### Complex / Risky
- Port the zoom/pan engine into `planning.js` faithfully — the risk is divergence from the Design panel's engine and touching the large `planning.js` file. Mitigated by mirroring known-good code *including the two-driver pan model, the `MAX_PREVIEW_DIM` cap, and the `getContentDims` wrapper-id branch*. A shallow port (function names only) silently breaks fit/pan math — see the Superseded callouts in Proposed Changes.

## Edge-Case & Dependency Audit

- **Race Conditions**
  - `state.previewRequestId` guard: the engine must not clobber a canvas mid-load. Apply size/fit only inside the `requestId === state.previewRequestId` branch already present at [planning.js:3853](src/webview/planning.js#L3853), and reset zoom state (`resetZoom('planningHtml')` + `_planningContentDims = null`) when a new file loads.
  - Resize→ResizeObserver feedback loop: pages built from `100vh` sections grow the canvas without bound when the viewport is sized to reported dims. Cap reported dims at `MAX_PREVIEW_DIM = 30000` (mirror [design.js:3666](src/webview/design.js#L3666)) so the loop stabilizes.
  - Pan-toggle vs Space-hold race: clicking the Pan button blurs the iframe, which fires an iframe-side `sbSpacePan { on:false }`. If `sbSpacePan` toggles the body class directly, that blur message cancels the toggle the same click just armed. Use the independent two-driver model (`_panToggle` / `_spaceHeld` / `refreshPanActive`) from [design.js:227-242](src/webview/design.js#L227-L242) so the momentary Space hold cannot cancel the sticky Pan toggle.

- **Security**
  - Cross-origin served previews: reading `iframe.contentDocument` from the parent fails for localhost-served pages, which is why dims/Space come *from inside* the iframe via `postMessage`. No parent-side cross-origin read is introduced.
  - No new `eval`/`Function`/dynamic-script injection; the engine is plain DOM transform math.

- **Side Effects**
  - Inspect Mode co-existence: Planning already toggles Inspect via `sbInspectToggle` ([planning.js:8621](src/webview/planning.js#L8621)); the new Space handling lives in the shared `_INSPECTOR_SCRIPT` and is independent of inspect state. The capture layer (`z-index:5`) sits above the iframe but below the tweak popup (`z-index:20`) and toolbar (`z-index:10`); when Pan/Space is active the layer covers the iframe so inspect hover-select is intentionally suspended until Pan/Space is released. Verify toggling Inspect on a Planning preview still hover-selects and Escape-exits when Pan/Space is off.
  - Other Planning tabs (PRD, Constitution, Research) post messages too — see Dependencies & Conflicts.

- **Dependencies & Conflicts**
  - Frame-source disambiguation: the Planning webview has multiple iframes (PRD/constitution/etc. also post messages). The new `sbSpacePan`/`sbContentDims` cases MUST reuse the existing guard `event.source === planningHtmlFrame.contentWindow` and `state.activeSource === 'planning-html-folder'` used by the `sbInspectState` case ([planning.js:5128](src/webview/planning.js#L5128)) so unrelated frames can't drive the canvas. `sbSpacePan` specifically must gate on `event.source` (mirror [design.js:3650](src/webview/design.js#L3650)) so a hidden iframe's blur doesn't kill pan in the visible one.
  - Empty/zero-size documents: clamp reported dims to a minimum (container size) so a blank preview never collapses the canvas.
  - CSS parity, not drift: copy the capture-layer rules exactly from the Design panel so behavior matches; do not invent new z-index/stacking. The capture layer uses `z-index:5`.

> **Superseded:** *"Dependency on the shared `_INSPECTOR_SCRIPT` (companion HTML-preview-controls plan). Space-to-pan and true fit-to-page rely on the injected iframe script emitting `sbSpacePan` and `sbContentDims`. Those messages are added to `DesignPanelProvider._INSPECTOR_SCRIPT` by the companion plan... If this plan lands first, add the same idempotent always-on Space-forward + dims-reporter block to `_INSPECTOR_SCRIPT` here."*
> **Reason:** Verified against source: `DesignPanelProvider._INSPECTOR_SCRIPT` already emits `sbSpacePan` ([DesignPanelProvider.ts:397,401,404](src/services/DesignPanelProvider.ts#L397)) and `sbContentDims` ([DesignPanelProvider.ts:412](src/services/DesignPanelProvider.ts#L412)), and `PlanningPanelProvider` already injects that script on both paths. The companion dependency does not exist; the contingency risks double-injection noise (the `__sbInspectorInstalled` guard prevents double-install, but the contingency is dead code).
> **Replaced with:** No companion dependency. Space-pan and fit-to-natural-size work immediately once the parent-side consumers in step 4 land. Drop the "add the block to `_INSPECTOR_SCRIPT` here" contingency entirely.

> **Superseded:** *"Shared vs duplicated engine (design decision)... Option A: extract into a new `src/webview/zoomPanEngine.js` loaded by both webviews via a new `{{ZOOM_PAN_ENGINE_URI}}` placeholder... Option B: duplicate... Recommendation: Option B."*
> **Reason:** The original Option A overlooked that both webviews already load a shared script via `{{SHARED_UTILS_URI}}` (replaced in `DesignPanelProvider.ts:756`, `PlanningPanelProvider.ts:678` and `:1803`). A shared engine can ride that existing placeholder without new provider templating — a third, lower-cost DRY path.
> **Replaced with:** Keep **Option B (duplicate)** as the chosen approach for this isolated panel fix (blast-radius argument holds). Note **Option A3** as the DRY alternative the original missed: host the engine in the existing `SHARED_UTILS_URI` script so both `design.js` and `planning.js` call one copy with no new placeholder. Prefer A3 if a follow-up consolidates the two panels onto one engine; otherwise B is fine for now.

## Dependencies

- None. The iframe-bridge messages (`sbSpacePan`, `sbContentDims`) already ship in `DesignPanelProvider._INSPECTOR_SCRIPT`, which `PlanningPanelProvider` already injects. No companion plan must land first.

## Adversarial Synthesis

Key risks: (1) a shallow engine port that copies function names but omits the `#planning-html-preview-wrapper > .zoomable-viewport` flex-flow CSS override, the `MAX_PREVIEW_DIM` cap, and the two-driver `_panToggle`/`_spaceHeld` model — any one of which makes the buttons fire while fit/pan is visually wrong or self-defeating; (2) missing source guard on `sbSpacePan` letting unrelated iframes kill pan. Mitigations: port the Design panel's *behavior* verbatim (CSS rule, cap, two-driver model, source guard, `getContentDims` wrapper-id branch), not just the function signatures; verify Reset vs Fit produce visibly different results on an oversized page.

## Proposed Changes

### 1. `src/webview/planning.html` — add the missing capture-layer CSS **and** the viewport flex-flow override

Beside the existing `.zoomable-container` / `.zoom-toolbar` rules (~[planning.html:2092-2160](src/webview/planning.html#L2092-L2160)), add the rules that `design.html` has and `planning.html` lacks. Copy **both** blocks verbatim from [design.html:2026-2047](src/webview/design.html#L2026-L2047), substituting the planning wrapper id in the first block:

```css
/* The HTML iframe viewport is sized to the previewed page's natural pixel dims
   (via sbContentDims). As a flex child of the centered .zoomable-container it
   would be shrunk on the main axis and centered (negative origin) on the cross
   axis — both break the transform-based fit/pan math, which assumes a fixed-size
   box anchored at the container's top-left. Take it out of flex flow so the
   reported dims are honored and the top-left origin holds. In the default
   100%×100% state this is a no-op. */
#planning-html-preview-wrapper > .zoomable-viewport {
    position: absolute;
    top: 0;
    left: 0;
    flex-shrink: 0;
}

/* Transparent layer above the iframe so pan/zoom mouse events reach the
   container instead of disappearing into the iframe document. Hidden by
   default; shown only while Space is held or Pan mode is on. */
.zoom-event-layer {
    position: absolute;
    inset: 0;
    z-index: 5;
    cursor: grab;
    display: none;
}
body.space-pan-active .zoom-event-layer {
    display: block;
}
```

> **Superseded:** The original step 1 copied only `.zoom-event-layer` + `body.space-pan-active .zoom-event-layer` (cited as `design.html:2020-2033`).
> **Reason:** That omitted the `#html-preview-wrapper > .zoomable-viewport { position:absolute; top:0; left:0; flex-shrink:0 }` rule at [design.html:2026-2032](src/webview/design.html#L2026-L2032). Without the planning equivalent, `sbContentDims` sets explicit pixel dims on a flex child that the container then shrinks/centers, so `fitToContainer`'s top-left-origin pan math anchors wrong — buttons fire but Fit and Reset look identical on oversized pages (the exact failure the verification step checks for).
> **Replaced with:** Add **both** the viewport flex-flow override (planning wrapper id) and the capture-layer rules. The citation is corrected to `design.html:2026-2047`.

### 2. `src/webview/planning.html` — add a keyboard-free Pan toggle to the toolbar

Extend the toolbar ([planning.html:3775-3780](src/webview/planning.html#L3775-L3780)) to mirror the Design panel's fixed set, so navigation never depends on iframe focus and Fit/Reset read distinctly:

```html
<div class="zoom-toolbar">
    <button class="zoom-btn" data-action="pan" title="Pan mode — drag to move the canvas">✥</button>
    <button class="zoom-btn" data-action="zoom-in"  title="Zoom In (hold Space + Scroll)">+</button>
    <button class="zoom-btn" data-action="zoom-out" title="Zoom Out (hold Space + Scroll)">−</button>
    <button class="zoom-btn" data-action="reset" title="Actual size (100%)">⟲</button>
    <button class="zoom-btn" data-action="fit"   title="Fit whole page to view (Double-click)">⤢</button>
</div>
```

### 3. `src/webview/planning.js` — add the zoom/pan engine (faithful port)

Port the engine from [design.js:204-410](src/webview/design.js#L204-L410) with a header comment `// Ported from design.js zoom/pan engine — keep in sync`. **Port the behavior, not just the names.** Include, in particular:

- A `zoomState` entry keyed `planningHtml: { scale:1, panX:0, panY:0, isPanning:false, startX:0, startY:0, panSource:null }`.
- `let _planningContentDims = null;` alongside the engine state.
- The **two-driver pan model** from [design.js:227-242](src/webview/design.js#L227-L242): `let _panToggle = false; let _spaceHeld = false;` plus `refreshPanActive()`, `setPanToggle(on)`, `setSpaceHeld(on)`. `refreshPanActive` toggles `body.space-pan-active` from `_panToggle || _spaceHeld` and toggles the `.active` class on `.zoom-btn[data-action="pan"]` from `_panToggle` only. **Do not** toggle the body class directly from `sbSpacePan` — that lets the iframe blur message cancel the Pan toggle.
- `getContentDims(viewportEl)` mirroring [design.js:244-256](src/webview/design.js#L244-L256) but with the iframe branch checking `viewportEl.closest('#planning-html-preview-wrapper')` and returning `_planningContentDims` when set.
- `clampPan`, `fitToContainer` (with the `retriesLeft` rAF retry for 0×0 containers), `zoomAt`, `resetZoom`, `applyZoom`, and `initZoomListeners(containerId, viewportSelector, tab)` (including the `dblclick`→`fitToContainer` and the `click` handler with the `pan`/`zoom-in`/`zoom-out`/`reset`/`fit` actions from [design.js:384-409](src/webview/design.js#L384-L409)). The `pan` action calls `setPanToggle(!_panToggle)`.
- Call `initZoomListeners('planning-html-preview-wrapper', '.zoomable-viewport', 'planningHtml')` during panel init (near where other one-time listeners are attached, e.g. by the `planning-html-btn-inspect` listener at [planning.js:8621](src/webview/planning.js#L8621)).

If Option A3 (shared module via existing `SHARED_UTILS_URI`) is chosen instead, move the functions into the shared utils script already loaded by both webviews (no new placeholder needed — `SHARED_UTILS_URI` is replaced in both providers), and call it from both `design.js` and `planning.js`.

> **Superseded:** The original step 3 said to "include the `pan` action (toggle `body.space-pan-active` + button `.active`)".
> **Reason:** Toggling the body class directly from the Pan button (and from `sbSpacePan`) collapses the two independent drivers into one and reintroduces the exact blur-cancels-toggle bug the reference's two-driver model exists to prevent ([design.js:227-232 comment](src/webview/design.js#L227-L232)).
> **Replaced with:** Use `setPanToggle()` from the Pan button and `setSpaceHeld()` from `sbSpacePan`; `refreshPanActive()` is the single place that writes `body.space-pan-active`.

### 4. `src/webview/planning.js` — consume the iframe bridge messages (source-guarded, capped, two-driver)

In the existing `window.addEventListener('message', ...)` switch ([planning.js:4663](src/webview/planning.js#L4663), where `const msg = event.data`), beside the `sbInspectState` case ([planning.js:5126](src/webview/planning.js#L5126)), add two cases. Use `msg.*` (the switch's convention) and reuse the same `state.activeSource === 'planning-html-folder'` + `event.source === planningHtmlFrame.contentWindow` guard:

```js
case 'sbSpacePan': {
    // Gate on the active iframe so a blur from a hidden iframe doesn't
    // kill pan mode in the visible one. Mirrors sbInspectState routing
    // and design.js sbSpacePan (design.js:3645-3654).
    const planningHtmlFrame = document.getElementById('planning-html-frame');
    if (state.activeSource === 'planning-html-folder' &&
        planningHtmlFrame && event.source === planningHtmlFrame.contentWindow) {
        setSpaceHeld(!!msg.on); // two-driver model — do NOT toggle body class directly
    }
    break;
}
case 'sbContentDims': {
    // Cap reported dims: sizing the viewport resizes the iframe, which re-fires
    // the iframe's resize/ResizeObserver reporter. Pages built from 100vh
    // sections then feed back and grow the canvas without bound. Capping halts
    // the loop. Mirrors design.js sbContentDims (design.js:3657-3689).
    const MAX_PREVIEW_DIM = 30000;
    const planningHtmlFrame = document.getElementById('planning-html-frame');
    if (state.activeSource !== 'planning-html-folder' ||
        !planningHtmlFrame || event.source !== planningHtmlFrame.contentWindow) {
        break;
    }
    const wrapper = document.getElementById('planning-html-preview-wrapper');
    const vp = wrapper ? wrapper.querySelector('.zoomable-viewport') : null;
    if (vp && msg.w && msg.h) {
        const w = Math.min(msg.w, MAX_PREVIEW_DIM);
        const h = Math.min(msg.h, MAX_PREVIEW_DIM);
        vp.style.width  = w + 'px';
        vp.style.height = h + 'px';
        _planningContentDims = { w, h };
        fitToContainer('planningHtml', wrapper, vp); // initial view = whole page
    }
    break;
}
```

Declare `let _planningContentDims = null;` with the engine state (step 3), and reset it to `null` + call `resetZoom('planningHtml')` in the `planning-html-folder` branch of `handlePreviewReady` ([planning.js:3852](src/webview/planning.js#L3852)) when a new file loads.

> **Superseded:** The original step 4 snippet used `event.data.on` / `event.data.w` / `event.data.h`, toggled `document.body.classList` directly from `sbSpacePan`, omitted the `event.source` guard on `sbSpacePan`, and omitted the `MAX_PREVIEW_DIM` cap.
> **Reason:** (a) The switch convention is `msg.*` (`const msg = event.data` at [planning.js:4664](src/webview/planning.js#L4664)); `event.data.*` works but is inconsistent. (b) Direct body-class toggle from `sbSpacePan` reintroduces the blur-cancels-Pan-toggle race. (c) No source guard lets a hidden iframe's space-up kill pan in the visible one — the plan's own Edge-Case audit required the guard but the code omitted it. (d) No cap hangs the webview on `100vh`-section pages via the resize feedback loop documented at [design.js:3661-3665](src/webview/design.js#L3661).
> **Replaced with:** The snippet above — `msg.*`, `setSpaceHeld()` (two-driver), source guard on both cases, `MAX_PREVIEW_DIM = 30000` cap.

### 5. `src/webview/planning.js` — apply initial fit on load

In the `planning-html-folder` branch, after assigning `iframe.src` / `iframe.srcdoc` ([planning.js:3867-3882](src/webview/planning.js#L3867-L3882)), add a one-shot `iframe.addEventListener('load', () => { /* dims arrive via sbContentDims; as a fallback, fitToContainer using firstElementChild dims */ }, { once: true })` so the canvas fits even if the bridge message is delayed, matching the Design panel's load hook ([design.js:1413-1417](src/webview/design.js#L1413)).

## Verification Plan

> **Session directive:** Compilation and automated tests are SKIPPED per the dispatching session. Verification is manual-only. (Static grep checks below are read-only inspections, not build/test runs.)

**Manual (primary):**
1. Open **Planning panel → HTML PREVIEWS**; select an HTML file (ideally one larger than the viewport).
2. **Buttons now work:** click **+ / −** → the preview scales about the center; **⟲ Reset** → snaps to 100% actual size; **⤢ Fit** → scales the whole page to fit the canvas. **Reset and Fit must produce visibly different results on an oversized page** (regression check against the old dead state AND against a shallow port missing the viewport flex-flow CSS). Double-click also fits.
3. **Pan without keyboard:** click the new **✥ Pan** button → capture layer activates (grab cursor); drag to move the canvas in all directions; click Pan again to restore normal interactivity with the previewed page. **Race check:** clicking Pan must NOT immediately turn itself off via the iframe-blur space-up message (the two-driver model prevents this).
4. **Space-pan:** click into the preview, hold **Space** → page does not jump/scroll down; drag pans; release restores interactivity. Typing in a focused `<input>` inside the preview still inserts a space.
5. **Scroll navigation:** with a zoomed/overflowing canvas, scroll while Pan/Space active → the canvas pans; ctrl/⌘+scroll zooms.
6. **`100vh`-section page (cap check):** preview a page built from full-height sections → the canvas must NOT grow unbounded / hang the webview (the `MAX_PREVIEW_DIM` cap prevents the resize feedback loop).
7. **srcdoc + served parity:** repeat for a plain file preview (`srcdoc`) and a served preview (localhost `iframeSrc`).
8. **No regressions:** toggle **Inspect Mode** on a Planning preview (with Pan/Space off) → hover-select + Escape-exit still work; other Planning tabs (PRD, Constitution, Research) are unaffected; auto-refresh of a previewed file still re-renders and resets zoom state.
9. **Design panel unaffected:** re-run the Design panel HTML/Stitch/Images previews to confirm no shared-state leakage (only relevant if Option A3 was taken — Option B touches no Design-panel files).

**Static (read-only grep, not a build):**
10. `grep -n "initZoomListeners\|zoomState\|fitToContainer\|setPanToggle\|setSpaceHeld\|refreshPanActive" src/webview/planning.js` returns matches (0 before this change).
11. `grep -n "space-pan-active\|#planning-html-preview-wrapper > .zoomable-viewport" src/webview/planning.html` matches both the capture-layer rule and the viewport flex-flow override.

### Automated Tests

Skipped per session directive. If a webview test harness exists in a later session, add assertions that the Planning `.zoom-toolbar` has a `data-action="pan"` button, that `planning.js` wires `.zoom-btn` clicks, and that `sbContentDims` with `w/h` exceeding `MAX_PREVIEW_DIM` clamps the viewport style to 30000px.

---

**Recommendation:** Complexity 5 → **Send to Coder.**

### Completion Summary

Implemented the Planning panel HTML preview zoom/pan controls. Added the missing `#planning-html-preview-wrapper > .zoomable-viewport` flex-flow override, `.zoom-event-layer` capture-layer CSS, and `.zoom-btn.active` state to `src/webview/planning.html`; updated the toolbar to include a Pan toggle button. Ported the full zoom/pan engine from `src/webview/design.js` into `src/webview/planning.js` with the `planningHtml` tab key, `_planningContentDims`, two-driver `_panToggle`/`_spaceHeld` pan model, `MAX_PREVIEW_DIM` cap, and iframe-source guards. Wired `sbSpacePan` and `sbContentDims` messages into the existing `message` switch and added reset/fit logic on preview load in `handlePreviewReady`. Verified with `node --check` and the static grep checks from the verification plan; syntax is valid and all required symbols/CSS selectors are present. No build or automated tests were run per the session directive.
