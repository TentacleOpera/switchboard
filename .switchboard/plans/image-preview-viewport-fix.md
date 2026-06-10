# Fix Image Previews Off-Viewport in planning.html

## Goal
Fix PNG/image previews rendering partially or fully off-screen in the **HTML Previews** tab and the **Design System** tab of the VS Code planning panel by giving the image `.zoomable-viewport` wrappers the same explicit `width: 100%; height: 100%` sizing the iframe viewport already has, so the zoom/pan transform math computes correct offsets.

### Problem
PNG image previews in both the **HTML Previews** tab and the **Design System** tab of the VS Code planning panel render partially or fully off-screen. The root cause is a missing CSS dimension declaration on the `.zoomable-viewport` wrapper inside image preview containers, causing the zoom/pan `transform` math to compute incorrect offsets.

### Root Cause
The HTML preview (iframe) viewport has an explicit inline style (`planning.html:3353`):
```html
<div class="zoomable-viewport" style="width: 100%; height: 100%;">
```

The two image preview viewports do **not**:
```html
<!-- HTML tab image preview (planning.html:3363-3366) -->
<div id="image-preview-container" class="zoomable-container">
    <div class="zoomable-viewport">  <!-- missing width/height -->
        <img id="image-preview-img" ... />
    </div>
</div>

<!-- Design tab image preview (planning.html:3295-3298) -->
<div id="image-preview-container-design" class="zoomable-container">
    <div class="zoomable-viewport">  <!-- missing width/height -->
        <img id="image-preview-img-design" ... />
    </div>
</div>
```

Without an explicit size, `.zoomable-viewport` collapses to the image's natural dimensions. The parent `.zoomable-container` uses `display: flex; align-items: center; justify-content: center`, which centers the shrunken viewport. The JavaScript zoom engine then applies an additional `transform: translate(panX, panY) scale(scale)` — double-centering pushes the image outside the visible area.

**Verified mechanics (Clarification):** `fitToContainer` (`planning.js:78-98`) computes `panX = (containerRect.width - contentW * fitScale) / 2` and the matching `panY` (`planning.js:95-96`). This math assumes the viewport's *untransformed* origin coincides with the container's top-left corner (the viewport rule sets `transform-origin: top left`, `planning.html:2103-2106`). When the unsized viewport shrink-wraps to the image, the container's flex centering (`planning.html:2091-2099`) moves the viewport's resting position to the container's center *before* the transform is applied — so the translate adds a second centering offset on top, displacing the image off-viewport. The iframe path is immune because its inline `width: 100%; height: 100%` makes the viewport fill the container, turning flex centering into a no-op and keeping the resting origin at the container's top-left.

## Metadata
- **Tags:** frontend, ui, bugfix
- **Complexity:** 2

## User Review Required
- **Reset button behavior change (intentional):** After this fix, the Reset zoom button (`resetZoom` → `scale: 1, panX: 0, panY: 0`, `planning.js:59-61`) will place the image at the container's **top-left corner** instead of appearing centered. The old "centered" reset was an accident of the flexbox bug being fixed here, and the new behavior is identical to the existing iframe preview's reset. If centered-reset is preferred, that is a separate follow-up (make the Reset action call `fitToContainer` instead) and is explicitly **out of scope** for this plan.

## Complexity Audit

### Routine
- Single-file change: one appended CSS rule in the `<style>` block of `planning.html`.
- Mirrors an existing, proven pattern — the iframe viewport at `planning.html:3353` already uses `width: 100%; height: 100%` and works correctly with the same zoom engine.
- Zero JavaScript changes; `fitToContainer` (`planning.js:78-98`), `clampPan` (`planning.js:68-76`), and the `img.onload` fit handlers (`planning.js:2474-2480` html tab, `planning.js:2601-2608` design tab) are all already correct under the fixed geometry.
- ID-selector specificity (0,1,1) cleanly overrides the base `.zoomable-viewport` class rule (0,1,0); no `!important` games needed.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None introduced. The `img.onload` → `fitToContainer` sequence is safe: the cache-busted `src` (`?t=' + Date.now()`) is assigned and the `onload` handler attached in the same synchronous task (`planning.js:2471-2480`, `2591-2608`), so the load event cannot fire before the handler exists. The fix is pure CSS and does not alter timing.
- **Security:** None. CSS-only change inside an existing webview; no new content sources, no CSP impact, no sandbox changes.
- **Side Effects:**
  - *Reset button* now rests the image at top-left rather than visually centered (see **User Review Required**) — consistent with the iframe preview's existing reset behavior.
  - The `.edit-mode #image-preview-container-design { display: none !important; }` rule (`planning.html:2511-2514`) only toggles `display` and does not conflict with the new sizing rule.
  - No global `img { max-width: ... }` rule exists for these containers (the only scoped image rule is `#markdown-preview-tickets img`, `planning.html:1435`), so the rendered image size stays consistent with the `naturalWidth`/`naturalHeight` values `fitToContainer` measures.
  - With the viewport at 100%×100%, an image larger than the container overflows the viewport box, but `.zoomable-container { overflow: hidden }` (`planning.html:2094`) clips it as before, and `fitToContainer` scales it down on load.
- **Dependencies & Conflicts:**
  - `initZoomListeners` wires all three containers with the same `.zoomable-viewport` selector (`planning.js:6736-6738`); the fix makes the two image containers geometrically identical to the already-working iframe container, so no listener changes are needed.
  - *Pre-existing, unchanged by this fix:* SVGs without intrinsic `width`/`height` can report degenerate `naturalWidth`, in which case `fitToContainer` no-ops at its `!contentW` guard (`planning.js:92`) and the image renders unscaled at the transform identity. Behavior is identical before and after this change.
  - *Pre-existing, unchanged by this fix:* fit is not recomputed on container resize (e.g. dragging the panel divider); the user can re-fit via the ⤢ toolbar button.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) the Reset button's resting position visibly changes from accidentally-centered to top-left, and (2) the file now has two sizing conventions (inline style on the iframe viewport vs. a stylesheet rule for the image viewports). Mitigations: the reset change is documented in **User Review Required** and matches the iframe path's existing behavior, and the new CSS rule carries a comment pointing at the inline iframe equivalent. SVG intrinsic-size and resize-refit gaps are pre-existing and explicitly out of scope.

## Files to Change
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html`

## Implementation Steps

1. **Add CSS rule in `<style>` block** (preferred over inline to keep the pattern consistent with theme overrides):
   ```css
   #image-preview-container .zoomable-viewport,
   #image-preview-container-design .zoomable-viewport {
       width: 100%;
       height: 100%;
   }
   ```

2. **Verify existing `fitToContainer` logic** (`planning.js:78-98`) already handles centering after load — no JS changes needed. ✅ Verified during planning: `fitToContainer` is exactly `planning.js:78-98`; both tabs attach `img.onload` handlers that call it (`planning.js:2474-2480` and `2601-2608`).

## Proposed Changes

### src/webview/planning.html
- **Context:** The base viewport rule lives at `planning.html:2103-2106` (`.zoomable-viewport { transform-origin: top left; will-change: transform; }`), inside the "Zoomable content wrapper" style group starting at line 2090. The two unsized image viewports are at lines 3296 (design tab) and 3364 (html tab); the correctly-sized iframe viewport is at line 3353.
- **Logic:** Make the image preview viewports fill their flex-centered containers, exactly as the iframe viewport already does via inline style. This turns the container's flex centering into a no-op and restores the top-left resting origin that `fitToContainer`'s translate math assumes.
- **Implementation:** Append the following rule immediately after the `.zoomable-viewport` base rule (i.e., after `planning.html:2106`):
  ```css
  /* Image preview viewports must fill the container so flex centering is a no-op
     and fitToContainer's top-left-origin pan math holds — mirrors the inline
     width/height:100% on the iframe viewport (#html-preview-wrapper). */
  #image-preview-container .zoomable-viewport,
  #image-preview-container-design .zoomable-viewport {
      width: 100%;
      height: 100%;
  }
  ```
  Do **not** modify the existing HTML markup or any JavaScript.
- **Edge Cases:** Reset button rests the image at top-left (documented behavior change, consistent with iframe path). Oversized images are clipped by `overflow: hidden` until `fitToContainer` scales them on load. Intrinsic-size-less SVGs fall through `fitToContainer`'s `!contentW` guard exactly as today. The `.edit-mode` display override at `planning.html:2511` is unaffected.

## Verification Plan

> Session directive: no project compilation and no automated test runs in this session. The webview HTML/CSS change requires no compile step; the user will run the test suite separately.

### Automated Tests
- No new automated tests are added for this CSS-only webview fix; the repository has no existing webview rendering test harness for `planning.html`. The user will run the existing test suite separately to confirm no regressions.

### Manual Verification (Acceptance Criteria)
- [ ] PNG images in the **HTML Previews** tab render centered in the viewport at initial load.
- [ ] PNG images in the **Design System** tab render centered in the viewport at initial load.
- [ ] Zoom in/out and pan gestures continue to work correctly on both tabs.
- [ ] Images larger than the viewport are scaled down to fit (existing `fitToContainer` behavior).
- [ ] Images smaller than the viewport remain at natural size, centered.
- [ ] The ⤢ Fit button re-centers and re-fits the image on both tabs.
- [ ] The ⟲ Reset button places the image at scale 1 anchored to the container's top-left (expected new behavior, consistent with the iframe preview's reset).
- [ ] The iframe-based HTML preview (`#html-preview-wrapper`) is visually unchanged.

## Execution Status
- **Status:** Completed
- **Files Changed:**
  - `src/webview/planning.html` — Added CSS rule at line 2107-2114 giving `#image-preview-container .zoomable-viewport` and `#image-preview-container-design .zoomable-viewport` `width: 100%; height: 100%;`, matching the iframe viewport inline style pattern.
- **Validation:** No compilation or automated tests run per session directive. Change is CSS-only, zero JavaScript modifications.
- **Remaining Risks:** Reset button now rests image at top-left (documented behavior change, consistent with iframe preview). No other known risks.

---

**Recommendation: Send to Intern** (Complexity 2)
