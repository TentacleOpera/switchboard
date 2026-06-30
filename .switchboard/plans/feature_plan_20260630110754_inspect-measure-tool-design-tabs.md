# Add "Inspect / Measure" button to the Design panel's Images & Design System tabs

## Goal

Add an **Inspect / Measure** button to the Design panel's **IMAGES** tab and **DESIGN SYSTEM** tab. Clicking it opens a Canvas-based inspector over the currently-displayed image that lets the user:

- **Eyedrop a colour** — report the hex of a sampled point, using a *dominant-cluster* read (not a single noisy pixel).
- **Measure spacing/size** — drag a box to get pixel distances, and the dominant colour of the boxed region.
- **Auto-detect proportions** — bounding box + ratios (e.g. a wordmark's cap-height vs a logo's height) for the visible artwork.

This makes the colour/spacing-extraction capability — which today only exists as ad-hoc Python/Pillow scripting outside the tool — a first-class, discoverable feature in the tab users already use to follow design work.

### Problem / background / root cause

Users follow design changes via the Design panel's HTML/image previews, but the panel is **view-only**: there is no way to extract exact values (hex, proportions, spacing) from a reference image or preview. In practice this forces eyeballing or out-of-band scripting, which produces two recurring failures:

1. **Wrong colours from screenshots.** Reference images are usually lossy screen captures (re-compressed, and tagged with a wide-gamut display ICC profile, e.g. Display-P3). Sampling them — even precisely — yields a value that disagrees with the authoritative spec token. A real incident (viaapp ticket `86d385v98`, bug `86d3gnqq3`) burned several review cycles because a navy sampled from a ClickUp screenshot (`#3A4082`) was used to "correct" the documented brand token (`#2B3A67`).
2. **No discoverability.** Even where measurement is possible (the browser Canvas API exposes raw pixels via `getImageData()`), nothing in the UI tells users the capability exists.

**Root cause:** the panel renders previews but never exposes the pixel data underneath them, and the measurement workflow lives entirely outside the product. The fix is to surface a Canvas-based inspector in-tab — no new runtime dependency, works under the existing webview CSP — and to bake in a guardrail that warns when a sampled source is a screenshot rather than a spec value.

## Metadata

**Tags:** frontend, ui, ux, feature, performance
**Complexity:** 6
*(Single-repo workspace — no Repo line per session directive.)*

## User Review Required

Yes — before implementation, review:
1. The **`crossOrigin = "anonymous"` technique + hybrid fallback** (resolved by web research — see *Resolved Research Findings*). Research confirmed `asWebviewUri` images ARE cross-origin and DO taint by default, but VS Code serves them with `Access-Control-Allow-Origin: *`, so a dedicated CORS-enabled `Image()` object untaints the canvas. Step 0 verifies this in a real webview; a backend data-URL relay is the documented fallback if the CORS handshake fails on any target VS Code version.
2. The **DESIGN SYSTEM tab button placement** (`#controls-strip-design` vs the sub-tab switcher) and the proposed disabled-state rules for non-image / Stitch-sub-tab states.
3. The **color-space approach**: research confirmed Chromium canvases default to sRGB (clamping P3 on draw). The recommended fix is a `display-p3` backing canvas + on-demand sRGB conversion at `getImageData()` time, so a sampled hex can **accurately match** an sRGB spec token — directly resolving the `86d385v98` colour-mismatch incident rather than merely labelling it. Confirm whether to ship the P3-canvas path in v1 (recommended) or only label "as-rendered".

## Scope

In scope — the two tabs the user named:

- **IMAGES tab** (`data-tab="images"`, `#images-content`) — inspects `#image-preview-img-images`.
- **DESIGN SYSTEM tab** (`data-tab="design"`) — inspects `#image-preview-img-design` (which lives inside the **Local Docs** sub-panel, `#design-local-panel`; the **Stitch Design Systems** sub-panel shows cards, not an inspectable image).

Explicitly out of scope (see *Future*):

- Sampling rendered pixels from the **HTML PREVIEWS** iframe (colours there already live in the CSS/code; nothing to sample).
- A **Python/Pillow backend** for ICC→sRGB conversion and batch work.

## Approach

Pure **client-side Canvas** inside the existing webview. Pillow is Python and cannot run in the webview sandbox, but every technique needed here maps onto `CanvasRenderingContext2D.getImageData()`:

| Capability | Canvas implementation |
| :--- | :--- |
| Dominant colour (mode, not mean) | histogram over `getImageData().data`, core-cluster filtered |
| Bounding box / cap-height | min/max of classified (non-background) pixels |
| Letter/element spacing | column-occupancy scan (boolean strip → runs) |
| Measure distance | screen→image coordinate mapping × naturalWidth scale |

This works under the current CSP (`img-src` already allows `data: file:` and webview/vscode-resource; `script-src` runs with the page nonce), needs **zero new dependencies**, and runs offline.

**Clarification (canvas untainting — from web research):** `asWebviewUri` images ARE cross-origin to the webview document and DO taint a canvas by default. However, VS Code's internal resource server serves them with `Access-Control-Allow-Origin: *`, so the inspector creates a **dedicated `Image()` object** with `crossOrigin = "anonymous"` set **before** its `src` (ordering is critical — setting `src` first triggers a non-CORS fetch and the canvas stays tainted). This dedicated image is drawn to the offscreen canvas; the DOM's display `<img>` (`#image-preview-img-*`, loaded by design.js without `crossOrigin`) is used **only read-only** for `getBoundingClientRect()` coordinate mapping — never drawn to the canvas. A `SecurityError` catch triggers the hybrid backend data-URL fallback (see *Future / Option B-lite*, now part of the implementation).

**Clarification (color space — from web research):** Chromium canvases default to an sRGB backing store that **clamps/clips** Display-P3 pixels on `drawImage()`, which is exactly how `#3A4082`-style drift arises. The recommended path: initialize the offscreen canvas with `getContext('2d', { colorSpace: 'display-p3', willReadFrequently: true })` when `window.matchMedia('(color-gamut: p3)').matches`, draw the P3 image losslessly, then read with `getImageData(x, y, w, h, { colorSpace: 'srgb' })` so the returned bytes are mathematically-correct sRGB. Detect/report the actual `ImageData.colorSpace` in the readout so the user knows whether the value is sRGB-converted or as-rendered.

**Clarification (coordinate mapping):** The original plan proposed reusing `applyZoom`'s `zoomState` (panX/panY/scale) to map screen→image coords. That state is private to design.js's IIFE (`zoomState` at design.js lines 197-203) and manual inversion is fragile under `transform-origin: top left` (design.html line 1996) + flex centering. The refined approach uses the browser's own composed transform via `img.getBoundingClientRect()`:

```
imageX = (clientX - imgRect.left) / imgRect.width  * img.naturalWidth
imageY = (clientY - imgRect.top)  / imgRect.height * img.naturalHeight
```

This is decoupled (inspect.js needs no access to design.js internals), correct under any transform-origin/nesting, and is the primary mapping method. The `zoomState`-inversion approach is retained only as a fallback cross-check.

## Complexity Audit

### Routine
- Adding two `strip-btn` buttons + a shared overlay panel to `design.html` (reuses existing `strip-btn` / cyber-theme classes).
- Registering one new webview JS resource in `DesignPanelProvider._getHtml` (mirrors existing `designJsUri`/`sharedUtilsUri` placeholder wiring — ~6 lines).
- webpack already raw-copies `src/webview/*.js` → `dist/webview/[name][ext]` (webpack.config.js lines 84-87), so a new plain-JS `inspect.js` ships with **no entry-config change**.
- "Copy hex" via `navigator.clipboard.writeText` — the established copy pattern across all webviews (planning.js, design.js, project.js).
- No CSP change required (verified: `img-src ... https: data: file:`, `script-src` nonce + `'unsafe-eval'`, design.html line 6).

### Complex / Risky
- **Canvas tainting of local `asWebviewUri` images** — RESOLVED by web research: images ARE cross-origin and DO taint, but `crossOrigin = "anonymous"` (set before `src`) on a dedicated `Image()` untaints them because VS Code serves `Access-Control-Allow-Origin: *`. Risk reduced to: verifying the CORS handshake on the ~4,000-install base's VS Code versions, with a backend data-URL fallback if it fails (Step 0 + hybrid architecture).
- **Color-space accuracy on wide-gamut displays** — RESOLVED by web research: default sRGB canvas clamps P3 (the `#3A4082` drift root cause). Mitigated by a `display-p3` backing canvas + on-demand sRGB read so sampled hex matches spec tokens. Requires feature-detection (`matchMedia('(color-gamut: p3)')`) and an `ImageData.colorSpace` label in the readout.
- **Screen→image coordinate mapping correctness under zoom/pan** — mitigated by the `getBoundingClientRect()`-fraction method above; verify at 2× zoom and after pan.
- **Dominant-colour quality** — needs bucket-quantization (4-5 bits/channel → mode over buckets → refine to bucket mean) so JPEG/anti-alias noise does not produce a meaningless single-pixel mode. Directly tied to the motivating wrong-hex incident.

## Edge-Case & Dependency Audit

**Race Conditions**
- **RESOLVED (onload stomp):** design.js reassigns `imageImg.onload = () => fitToContainer(...)` on every image load (design.js lines 1416 and 1452). The original plan proposed drawing the DOM `<img>` to the canvas, which would have risked clobbering that onload. The research-driven fix eliminates this entirely: the inspector creates a **separate `new Image()`** (with `crossOrigin = "anonymous"`) for the offscreen canvas, so the DOM `<img>`'s `onload` is never touched. The DOM `<img>` is read-only (only `getBoundingClientRect()` + `naturalWidth`/`naturalHeight`).
- Two containers share each tab's zoom state (design.js lines 316-317 `panSource` guard). inspect.js avoids this entirely by using `img.getBoundingClientRect()`, not `zoomState`.
- The dedicated CORS `Image()` is async (load event) — guard against the user closing the inspector or switching images mid-load: tag each load with a token and ignore stale callbacks.

**Security**
- **Canvas tainting (confirmed by research):** `asWebviewUri` images ARE cross-origin and taint a canvas by default. The inspector's dedicated `Image()` sets `crossOrigin = "anonymous"` BEFORE `src`; VS Code's resource server replies with `Access-Control-Allow-Origin: *`, clearing the taint. If the CORS handshake fails (rare/old VS Code), `getImageData()` throws `SecurityError` — caught and routed to the hybrid backend data-URL fallback (extension host reads the file in Node → postMessage a `data:` URL, which is spec-untainting → draw that to the canvas). Remote `https:` images without a CORS header also throw → show "can't inspect remote image — save it locally first."
- No new `connect-src` is used for the primary path; `connect-src` is `https:` only (design.html line 6), so a webview-side `fetch()` of a `vscode-webview-resource:` URI would be CSP-blocked — the taint-fallback MUST use the postMessage→Node→`data:` URL relay, never a webview-side fetch. The backend relay adds one message type to `onDidReceiveMessage` (see Proposed Changes / DesignPanelProvider).

**Side Effects**
- Primary path (CORS-enabled `Image()`): read-only. The inspector draws a dedicated `Image()` to an offscreen canvas and reads pixels. No file writes, no postMessage to the extension host, no kanban/plan mutations.
- Fallback path (only on `SecurityError`): sends one `postMessage({ type: 'inspectRequestDataUrl', filePath })` to the extension host, which reads the file in Node and replies with `{ type: 'inspectDataUrl', dataUrl, requestId }`. The extension host does NOT write anything; it only reads a file and base64-encodes it in memory. No persisted state changes.
- Must not interfere with existing zoom/pan, dblclick-to-fit, scroll-zoom, or Space-to-pan. Inspector pointer handlers attach only while the overlay is active and must call `e.stopPropagation()` / check the container's `panning` class (set by design.js line 311) so a pan gesture isn't hijacked.

**Dependencies & Conflicts**
- Depends on the existing `.zoomable-viewport` / `#image-preview-img-*` markup (design.html lines 3632-3642, 3818-3828) and the image-load paths in design.js (lines 1398-1428 for IMAGES, 1429-1457 for DESIGN).
- `inspect.js` is a separate `<script>` and cannot see design.js's IIFE-private `zoomState`/`applyZoom`. By design — the rect-fraction mapping needs no such access. If any future feature needs shared state, expose it via a single explicit global (e.g. `window.__sbZoomState`) rather than refactoring the IIFE.
- No new npm dependencies. No webpack entry change (raw copy via CopyPlugin).

## Resolved Research Findings

Web research (52 sources, including WHATWG HTML Living Standard, VS Code release notes/issues, Chromium canvas-color-management docs, and MDN) resolved both previously-uncertain assumptions. Summary of what changed in this plan:

1. **Canvas tainting of local `asWebviewUri` images — CONFIRMED TAINTING, BUT SOLVABLE.** `asWebviewUri` images ARE cross-origin to the webview document (the webview frame origin and the resource origin differ by scheme/subdomain) and DO taint a canvas by default. HOWEVER, VS Code's internal resource server serves them with `Access-Control-Allow-Origin: *`, so setting `crossOrigin = "anonymous"` on a dedicated `Image()` **before** its `src` triggers a CORS-enabled fetch that clears the taint. Key implementation consequences:
   - The inspector must create its **own** `new Image()` with `crossOrigin = "anonymous"` (set before `src`) — NOT draw the DOM's display `<img>` (which design.js loaded without `crossOrigin` and would taint the canvas).
   - `data:` URIs (the fallback path) are spec-guaranteed untainting; `file:` URIs always taint; `blob:` inherits the creating context's origin.
   - A `SecurityError` catch drives the hybrid backend data-URL fallback (Option B-lite), which is now part of the implementation rather than only Future.

2. **Canvas output color space on wide-gamut displays — CONFIRMED sRGB-CLAMPING BY DEFAULT, SOLVABLE.** Chromium (94+) canvases default to an sRGB backing store that **clamps/clips** Display-P3 pixels on `drawImage()` — this is the root cause of the `#3A4082` vs `#2B3A67` drift. The fix: initialize the offscreen canvas with `getContext('2d', { colorSpace: 'display-p3', willReadFrequently: true })` (feature-detected via `matchMedia('(color-gamut: p3)')`), draw losslessly, then read with `getImageData(x, y, w, h, { colorSpace: 'srgb' })` for mathematically-correct sRGB bytes. The readout reports `ImageData.colorSpace` so the user knows whether the value is sRGB-converted or as-rendered.

Both are still verified by the Step 0 real-webview smoke test, but the implementation now has a confirmed technique rather than an open question. Full source list available in the research report.

## Dependencies

- None (no prerequisite plan sessions). The change is self-contained within the Design panel webview + its provider.

## Adversarial Synthesis

**Risk Summary:** Web research resolved the two highest risks. (1) Canvas tainting of `asWebviewUri` images is CONFIRMED real but mitigated by a dedicated `crossOrigin = "anonymous"` `Image()` (VS Code serves `Access-Control-Allow-Origin: *`), with a backend data-URL relay as fallback — residual risk is just verifying the CORS handshake across the install base. (2) Color-space drift (the `#3A4082` root cause) is mitigated by a `display-p3` backing canvas + on-demand sRGB read so sampled hex matches spec tokens. Remaining risks: coordinate-mapping correctness under zoom/pan (mitigated by `getBoundingClientRect()`-fraction mapping), DESIGN-tab button enable/disable state, and dominant-colour quality (mitigated by bucket-quantization). All risks have compact, confirmed mitigations.

## Implementation steps

### 1. `src/webview/design.html`
- Add an **Inspect** button (`class="strip-btn"`, e.g. `id="btn-inspect-images"` and `id="btn-inspect-design"`) to each tab's controls strip (`#controls-strip-images`, and the Design System strip alongside `#btn-design-subtab-stitch`).
- Add a hidden inspector overlay/panel markup once (shared), with: a results readout (hex + swatch + RGB + copy button), a mode toggle (Eyedrop / Measure / Auto-detect), and a dismissible **screenshot guardrail** banner.
- No CSP change required (verified: `img-src ... data: file:`, scripted with nonce).

### 2. `src/webview/inspect.js` (new module, loaded after `design.js`)
- `initInspector(tab, imgEl, viewportEl)` — attach to the tab's `<img>` (read-only: coordinate mapping + natural dims) and its `.zoomable-viewport`.
- **Create a dedicated CORS `Image()`** (NOT the DOM `<img>`): set `crossOrigin = "anonymous"` BEFORE `src` (ordering critical), `src` = the DOM `<img>`'s current `src`. On load, draw to an offscreen `<canvas>` at `naturalWidth/naturalHeight`; cache `getImageData()` once per image load.
- **Color space:** if `matchMedia('(color-gamut: p3)').matches`, get the context with `{ colorSpace: 'display-p3', willReadFrequently: true }`; read pixels with `getImageData(x, y, w, h, { colorSpace: 'srgb' })` for spec-accurate sRGB. Report `ImageData.colorSpace` in the readout.
- **Eyedrop:** on click, map screen→image coords via the DOM `<img>`'s `getBoundingClientRect()`-fraction method, sample an N×N neighbourhood, return the **dominant-cluster** hex (bucket-quantize histogram mode after dropping near-background / low-alpha pixels), not a single pixel.
- **Measure:** drag to draw a box → report width/height in image px and the boxed region's dominant colour.
- **Auto-detect:** classify foreground vs background, report bounding box + a couple of useful ratios.
- Expose results to the panel readout; provide "copy hex".
- **Hybrid fallback:** if `getImageData()` throws `SecurityError`, `postMessage({ type: 'inspectRequestDataUrl', filePath })` to the extension host; on receiving `{ type: 'inspectDataUrl', dataUrl }`, draw the `data:` URL image (spec-untainting) to the canvas and proceed.

### 3. `src/services/DesignPanelProvider.ts`
- Register `inspect.js` as a webview resource via `webview.asWebviewUri(...)` (mirror the existing `designJsUri`/`sharedUtilsUri` wiring in `_getHtml`) and inject its `<script nonce>` tag into `design.html`.
- **Add one message handler** to `onDidReceiveMessage` for the hybrid fallback: on `{ type: 'inspectRequestDataUrl', filePath }`, read the file in Node (`fs.readFileSync`), base64-encode it, and `postMessage({ type: 'inspectDataUrl', dataUrl: 'data:image/<ext>;base64,...', requestId })`. No other backend changes.

### 4. Styling
- Reuse `strip-btn` and theme CSS variables; ensure the overlay respects the **cyber-theme** classes already present (`.cyber-theme-enabled #...`).

## Screenshot guardrail (the differentiating feature)
When the inspected image is likely a screenshot, show a persistent note in the readout: *"Colours sampled from a screenshot are lossy and colour-profile shifted — a spec token or Figma value is authoritative."* Detection v1: filename heuristic (`/screenshot|screen shot|\.png$/i` + dimensions matching common device sizes) plus a manual "treat as screenshot" toggle. This directly prevents the failure mode that motivated the feature.

## Future (separate plan)
- **Option B — Pillow/Python backend.** `DesignPanelProvider` can `child_process.spawn('python3', …)` (precedent: `ContextBundler.ts`, `ArchiveManager.ts`) for the one thing Canvas can't do well — **full ICC→sRGB conversion** (`ImageCms`) via embedded ICC profile parsing, and large batch jobs. Gate on feature-detecting `python3` + Pillow with graceful fallback to Option A. Not required for v1 — the P3-canvas + on-demand sRGB read handles the common Display-P3 case without Python.
- **Option B-lite (taint fallback) — NOW IN SCOPE for v1** (moved from Future based on research): the hybrid backend data-URL relay (`inspectRequestDataUrl` / `inspectDataUrl` message pair) is implemented as the `SecurityError` fallback path in `inspect.js` + `DesignPanelProvider.ts`. See Proposed Changes.
- Reference-vs-preview overlay with a per-pixel diff.

## Testing / verification
- **Manual:** in each tab, load an image with a known flat swatch; eyedrop it and confirm the reported hex matches; draw a measure box across a known span and confirm px; repeat at 2× zoom to confirm coordinate mapping; load a remote `https:` image and confirm the graceful taint message.
- **Automated smoke:** add a test (alongside `src/test/prompts-tab-move-regression.test.js` / `agent-config-drag-drop-mode.test.js`) asserting the Inspect button renders in both tabs and toggles the overlay.

## Acceptance criteria
- Inspect button present in the IMAGES and DESIGN SYSTEM controls strips.
- Clicking opens the inspector on the displayed image.
- Eyedrop returns a dominant-cluster hex (copyable); Measure returns image-px distances + region colour; both correct under zoom/pan.
- Screenshot guardrail appears for screenshot sources.
- No regression to existing preview, zoom/pan, or theming.

---

## Proposed Changes

> Line-number-precise, per-file execution breakdown. Preserves and refines the Implementation steps above; in case of conflict, the line anchors below are authoritative against the current source.

### Step 0 — `src/webview/inspect.js` (probe only, ~40 LOC, written first and deleted after verifying)
**Context:** Web research confirmed the technique (dedicated `crossOrigin = "anonymous"` `Image()`), but verify it actually works in a real VS Code webview before building the full UI — this is the residual risk across the ~4,000-install base's VS Code versions.
**Logic:** Temporarily add a tiny `inspect.js` that, on a hardcoded trigger (e.g. double-clicking `#image-preview-img-images`), reads that `<img>`'s `src`, creates `new Image()` with `crossOrigin = "anonymous"` set BEFORE `src`, and on load draws it to a canvas and calls `getImageData(0,0,1,1)`. Log `SUCCESS` + `ImageData.colorSpace` or the caught `SecurityError` to the webview devtools console.
**Implementation:** Load it via the wiring in the `DesignPanelProvider.ts` step below. Open the IMAGES tab, select a local image, trigger the probe.
**Edge Cases:** If `SecurityError` despite `crossOrigin` → the CORS handshake failed on this VS Code version; the hybrid backend data-URL fallback (Option B-lite, in scope) handles it at runtime, but if it fails on the developer's own machine, investigate before proceeding. If success → confirm the color-space probe: log `getImageData(0,0,1,1).data` and `.colorSpace` for a known sRGB swatch, compare to the spec value, and confirm a `display-p3`-context read with `{ colorSpace: 'srgb' }` yields the spec token. Delete the probe and continue to Step 1.

### `src/webview/design.html`
**Context:** Add buttons + overlay markup + one script tag. No CSP change (line 6 already permits `img-src ... https: data: file:` and nonce'd `script-src`).

**Logic / Implementation:**
- **IMAGES tab button:** Inside `#controls-strip-images` (line 3791-3797), append `<button id="btn-inspect-images" class="strip-btn" disabled>Inspect</button>` after the `#status-images` span (line 3796). Keep it `disabled` until an image is loaded.
- **DESIGN SYSTEM tab button:** Inside `#controls-strip-design` (line 3597-3608), append `<button id="btn-inspect-design" class="strip-btn" disabled>Inspect</button>` after `#status-design` (line 3607). *Clarification:* prefer the main controls strip over the sub-tab switcher (line 3611-3614) for consistency with the IMAGES tab; the button is disabled whenever the active preview is not an image (markdown/JSON) or the Stitch sub-tab is showing.
- **Shared overlay panel:** Add once, e.g. as a sibling of `#images-content` / `#design-content` near the end of the body (before the `<script>` tags, line 4057). Markup: a positioned `#inspect-overlay` containing a mode toggle (Eyedrop / Measure / Auto-detect), a readout (swatch + hex + RGB + "Copy" button using `navigator.clipboard.writeText`), the dismissible screenshot-guardrail banner, and a close button. Hidden by default (`display:none`).
- **Script tag:** After line 4059 (`<script nonce="{{NONCE}}" src="{{DESIGN_JS_URI}}"></script>`), add `<script nonce="{{NONCE}}" src="{{INSPECT_JS_URI}}"></script>` so `inspect.js` loads after `design.js`.

**Edge Cases:** Overlay must trap pointer events only while visible (avoid blocking zoom/pan when hidden). Respect `.cyber-theme-enabled` styling (design.html line 2134 region). No `confirm()` dialogs anywhere (project rule).

### `src/webview/inspect.js` (new, plain JS — raw-copied by webpack CopyPlugin, webpack.config.js lines 84-87)
**Context:** Self-contained module; cannot access design.js's IIFE-private `zoomState`/`applyZoom`. Uses the DOM `<img>`'s `getBoundingClientRect()`-fraction mapping (read-only, no design.js dependency) for coordinates, and a **dedicated CORS `Image()`** for pixel reads (research-confirmed untainting technique).

**Logic / Implementation:**
- `initInspector(tab, imgId, containerId)` — resolve `displayImg = document.getElementById(imgId)` (the DOM `<img>` shown in the viewport) and `containerEl`. Attach click handlers to `#btn-inspect-<tab>` to toggle the overlay.
- **Dedicated CORS Image + canvas build (primary path):** on overlay open, create `const probe = new Image(); probe.crossOrigin = "anonymous";` THEN set `probe.src = displayImg.src;` (ordering critical — `crossOrigin` before `src` triggers a CORS-enabled fetch; VS Code serves `Access-Control-Allow-Origin: *`). On `probe.onload`, build an offscreen `<canvas>` at `probe.naturalWidth × naturalHeight`. **Color space:** `const useP3 = window.matchMedia('(color-gamut: p3)').matches; const ctx = canvas.getContext('2d', { colorSpace: useP3 ? 'display-p3' : 'srgb', willReadFrequently: true });` then `ctx.drawImage(probe, 0, 0)`. Tag the load with a token; ignore stale callbacks if the user closed the inspector or switched images.
- **`getImageData` read:** cache the full buffer with `ctx.getImageData(0, 0, w, h)` once; for individual eyedrops read `ctx.getImageData(ix, iy, N, N, { colorSpace: 'srgb' })` so returned bytes are mathematically-correct sRGB (prevents the `#3A4082` P3-clamp drift). Report `ImageData.colorSpace` in the readout.
- **Screen→image mapping (uses the DOM display `<img>`, read-only):**
  ```
  const r = displayImg.getBoundingClientRect();
  const ix = (clientX - r.left) / r.width  * displayImg.naturalWidth;
  const iy = (clientY - r.top)  / r.height * displayImg.naturalHeight;
  ```
  Robust under `transform-origin: top left` (design.html line 1996) + flex centering + any zoom/pan. The DOM `<img>` is never drawn to the canvas (it was loaded without `crossOrigin` and would taint); only `probe` (the CORS `Image()`) is drawn.
- **Eyedrop:** sample an N×N neighbourhood (N≈5) around `(ix,iy)`; dominant-cluster hex via bucket-quantize (4-5 bits/channel) → mode over populated buckets → refine to bucket mean; drop near-background / low-alpha pixels. Write hex + RGB + swatch + `colorSpace` label to the readout.
- **Measure:** mousedown→mousemove→mouseup draws a screen-space selection box (an absolutely-positioned div over the container); on mouseup convert both corners to image coords via the mapping above; report `|dx|`, `|dy|` in image px and the boxed region's dominant colour (same histogram over the sub-rectangle). `e.stopPropagation()` so pan doesn't trigger.
- **Auto-detect:** classify foreground vs background (delta from edge/corner median colour), report bounding box (min/max non-bg pixels) + ratios (e.g. bbox width/height, cap-height heuristic).
- **Copy:** `navigator.clipboard.writeText(hex)` (established pattern; see planning.js/design.js/project.js).
- **Guardrail:** set the screenshot banner visible when `isLikelyScreenshot(filename, naturalWidth, naturalHeight)` (filename regex `/screenshot|screen shot/i` or `.png` + common device dims) OR the manual "treat as screenshot" toggle is on.
- **Hybrid fallback (Option B-lite, in scope):** wrap the `getImageData()` call in try/catch. On `SecurityError`, `vscode.postMessage({ type: 'inspectRequestDataUrl', filePath: state.activeDocFilePath, requestId })` (reuse `state.activeDocFilePath` already tracked in design.js lines 1433; if not accessible, read from a data attribute on the overlay). Listen for `{ type: 'inspectDataUrl', dataUrl, requestId }` and on match, draw the `data:` URL `Image()` (spec-untainting) to the canvas and proceed. `data:` URLs never taint, so this path needs no `crossOrigin`.

**Edge Cases:**
- `SecurityError` on the primary CORS path → triggers the hybrid backend fallback above (NOT just an error message for local images; the fallback keeps the feature working). Remote `https:` images without CORS → show "can't inspect remote image — save it locally first" (no backend relay for remote URLs).
- Coexistence with Space-to-pan: skip eyedrop/measure while the container has class `panning` (set by design.js line 311) or when `e.button !== 0` (inspect.js can't see `zoomState`).
- Large images: stride/sample-cap the histogram (e.g. read every 2nd pixel) to stay responsive; `willReadFrequently: true` keeps the canvas CPU-backed.
- High-DPI: the rect-fraction method already normalizes by `naturalWidth/clientWidth`, so no separate devicePixelRatio factor is needed.
- `colorSpace` option support: older Chromium may not accept `{ colorSpace }` in `getImageData` — feature-detect and fall back to the default read (still correct on sRGB displays; only wide-gamut accuracy degrades).

### `src/services/DesignPanelProvider.ts`
**Context:** Wire the `{{INSPECT_JS_URI}}` placeholder + add the hybrid-fallback message handler. `_getHtml` is at lines 331-381; the existing `designJsUri` block is lines 359-362 and `sharedUtilsUri` is lines 364-367. The message handler lives in `_handleMessage` (the `onDidReceiveMessage` callback wired at lines 121-125 / 217-221).

**Logic / Implementation:**
- After the `sharedUtilsUri` block (line 367), add:
  ```ts
  const inspectJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'inspect.js')
  );
  htmlContent = htmlContent.replace(/\{\{INSPECT_JS_URI\}\}/g, inspectJsUri.toString());
  ```
- In `_handleMessage`, add a case for the hybrid fallback:
  ```ts
  case 'inspectRequestDataUrl': {
      const filePath = message.filePath;
      try {
          const buf = fs.readFileSync(filePath);
          const ext = path.extname(filePath).slice(1).toLowerCase();
          const mime = ext === 'jpg' ? 'jpeg' : (ext || 'png');
          this.postMessage({
              type: 'inspectDataUrl',
              dataUrl: `data:image/${mime};base64,${buf.toString('base64')}`,
              requestId: message.requestId
          });
      } catch (e) {
          this.postMessage({ type: 'inspectDataUrlError', requestId: message.requestId, error: String(e) });
      }
      break;
  }
  ```
  This is the ONLY backend change; it reads a file and base64-encodes it in memory (no writes). webpack CopyPlugin already ships `src/webview/inspect.js` → `dist/webview/inspect.js` (no entry-config change).

**Edge Cases:** `inspect.js` missing from `dist/` (e.g. unbuilt) would leave `{{INSPECT_JS_URI}}` literally in the HTML and the `<script src>` 404 — same failure mode as a missing `design.js`, which the existing `possiblePaths` HTML lookup (lines 336-350) does not guard against for JS. Acceptable for v1 (matches current `design.js` behaviour); a future hardening could warn if the URI placeholder survives replacement. The `inspectRequestDataUrl` handler must validate `filePath` is within an allowed workspace root before reading (defense-in-depth against a crafted message), mirroring the `_SERVER_DENY_LIST` spirit at lines 66-76.

### `src/webview/design.js` (tiny additive change for the fallback file path)
**Context:** inspect.js is a separate `<script>` and cannot read design.js's IIFE-private `state.activeDocFilePath` (set at line 1433). The hybrid fallback needs the on-disk file path to request a `data:` URL from the extension host.
**Logic / Implementation:** Where design.js sets `imageImg.src` for the IMAGES tab (line 1415) and DESIGN tab (line 1448), also set `imageImg.dataset.filePath = filePath || '';` (the `filePath` variable is in scope at both points). This is a read-only data attribute; inspect.js reads it via `displayImg.dataset.filePath` only on the fallback path. No behavior change to existing preview/zoom/pan.
**Edge Cases:** If `filePath` is empty/undefined (e.g. a remote URL), the attribute is empty and the fallback is skipped (the remote-image error message shows instead).

### Styling (inline in `design.html` `<style>` or a shared block)
**Context:** Reuse `strip-btn` (lines 226-253) and cyber-theme overrides (line 2134).
**Implementation:** Overlay uses `position: absolute; inset: 0;` over the preview pane, `pointer-events: none` when hidden and `auto` when shown. Swatch/readout use existing theme CSS variables. Add `.cyber-theme-enabled #inspect-overlay { … }` rules to match the established pattern.

## Verification Plan

> Per session directives: **compilation (`npm run compile`) and automated tests are NOT run in this session** — they are executed separately by the user. The steps below describe what to run/author; the session only updates this plan.

### Automated Tests
- Author a smoke test alongside `src/test/agent-config-drag-drop-mode.test.js` / `src/test/prompts-tab-move-regression.test.js` asserting: (a) `#btn-inspect-images` and `#btn-inspect-design` render inside their respective controls strips; (b) clicking toggles `#inspect-overlay` visibility. Run via the project's existing test command (deferred to the user per session directive — do NOT run in this session).
- No unit test for the histogram/mapping math is required for v1 (manual swatch verification below covers it), but a small pure-function test for `dominantClusterHex(imageData, x, y, n)` is recommended if the function is extracted testably.

### Manual
- **Step 0 probe** (see Proposed Changes Step 0): real-webview smoke test — confirm the dedicated `crossOrigin = "anonymous"` `Image()` yields `getImageData()` without `SecurityError`; log a known sRGB swatch's sampled bytes + `ImageData.colorSpace` and confirm a `display-p3`-context read with `{ colorSpace: 'srgb' }` yields the spec token (resolving the `86d385v98` drift).
- In each tab, load an image with a known flat swatch; eyedrop it and confirm the reported hex matches (within bucket tolerance); draw a measure box across a known span and confirm px; repeat at 2× zoom and after panning to confirm coordinate mapping; load a remote `https:` image and confirm the graceful taint message.
- Verify the hybrid fallback: temporarily break the CORS path (e.g. load a remote image) and confirm the `inspectRequestDataUrl` → `inspectDataUrl` relay draws the `data:` URL and the inspector works; confirm the `data-file-path` attribute is set by design.js on image load.
- Toggle the cyber theme and confirm the overlay styles correctly.
- Confirm no regression to existing preview, zoom/pan (scroll, dblclick-fit, Space-to-pan), and tab switching.

---

**Recommendation:** Complexity 6 (Medium) — four files (design.html, new inspect.js, DesignPanelProvider.ts, design.js), one backend message handler (hybrid fallback), color-space feature-detection, and a confirmed CORS-untainting technique. The two highest risks are now research-resolved with confirmed mitigations; remaining risks (mapping correctness, button enable/disable, dominant-colour quality) are well-scoped. **Send to Coder.** Lead with the Step 0 CORS/color-space probe before any UI work.

---

## Reviewer Pass (in-place, 2026-06-30)

### Stage 1 — Grumpy Principal Engineer

> *Reviews the commit `d8d418b` against this plan. Buckle up.*

**[CRITICAL] design.js:1472-1474 — You broke the Design System tab's image preview. Full stop.**
The original `handlePreviewReady` design-folder branch was an exclusive `if (isImage) … else if (json) … else if (yaml) … else { markdown }` chain. You "refactored" it into `if (isImage) { … } else { disable inspect }` followed by a **separate top-level** `if (msg.fileType === 'json') … else if (yaml) … else { markdown }`. Congratulations: when an image loads (`fileType === 'image'`, confirmed at `DesignPanelProvider.ts:3115`), the image branch shows the container, and then the orphaned markdown `else` branch runs and does `imgCont.style.display = 'none'` — **hiding the image you just rendered and showing an empty markdown pane.** The Design System tab can no longer display images. This is the exact feature the plan exists to enhance, and you bricked it. Unacceptable.

**[CRITICAL] design.html:4049-4053 — You deleted the Apply Design System modal's action buttons.**
The diff removed `<button id="btn-cancel-apply">` and `<button id="btn-execute-apply">` plus their wrapping row, and in the process dropped a closing `</div>` so the `#design-system-apply-modal` container never closed — leaving the `#inspect-overlay` **nested inside the hidden apply modal** (`display: none`), which would make the inspector invisible forever. The JS handlers at `design.js:4175` and `design.js:4188` still reference both button IDs, so the "Apply Design System to Screens" workflow is now a dead modal with no way to apply or cancel. You added a feature by amputating an existing one. Two regressions for the price of one commit.

**[MAJOR] inspect.js:314-318 / 326-330 — The SecurityError fallback you spec'd is not wired.**
The plan (Proposed Changes, inspect.js) explicitly requires: "wrap `getImageData()` in try/catch; on `SecurityError`, `postMessage({ type: 'inspectRequestDataUrl', filePath })`." Your catch just retries `getImageData` **without the `{ colorSpace }` option** — which has nothing to do with taint and will throw `SecurityError` again, uncaught. The only fallback path that actually fires is `probe.onerror` (line 129). That covers the common CORS-failure case (crossOrigin + no CORS header ⇒ load failure, not load-tainted), so it's not totally dead — but the spec'd defense-in-depth is missing and the catch is misleading dead code.

**[MAJOR] inspect.js:110 — Screenshot guardrail over-triggers on every PNG.**
`fileName.endsWith('.png')` flags **every** PNG as a screenshot, including legitimate PNG design assets / logo exports. The plan said "`.png` + dimensions matching common device sizes" — you dropped the dimension signal. The result: the orange guardrail banner screams "this is a lossy screenshot" at a user inspecting a pristine exported logo. Also case-sensitive — `.PNG` escapes. Annoying, not fatal.

**[NIT] inspect.js:4061 / design.html:4061 — Overlay is `position: absolute` pinned to viewport coords.**
The overlay resolves against the initial containing block (no positioned ancestor — verified, the modals are `position: fixed` and the overlay is a body-level sibling), so it works at open time. But it won't follow panel scroll. `position: fixed` would be more honest for a viewport-pinned interaction layer. Defer.

**[NIT] design.js:4094 — Unguarded deref in the local-subtab re-evaluation.**
`document.getElementById('image-preview-container-design').style.display` will throw if that element is ever absent. It exists today, so it's fine, but defensive `?.` costs nothing. Also the local handler only *enables* the button, never disables it when switching back to local with no image loaded — minor state asymmetry vs. the stitch handler.

### Stage 2 — Balanced Synthesis

**Keep as-is:**
- `DesignPanelProvider.ts` wiring (`{{INSPECT_JS_URI}}` + `inspectRequestDataUrl` handler) — clean, and the path-validation defense-in-depth exceeds the plan's requirement. `_getWorkspaceRoots`/`fs`/`path` all present.
- `inspect.js` core: dedicated `crossOrigin="anonymous"` `Image()` before `src` (ordering correct), `getBoundingClientRect()`-fraction coordinate mapping, bucket-quantized dominant colour, P3 feature-detection with sRGB read, colorSpace label in readout, copy-hex, stale-request token guard. All faithful to the plan.
- `design.js` IMAGES-tab branch — the added `else { disable }` is safe (no following chain to desync).
- `dataset.filePath` plumbing on both image-load paths — correct, read-only, used only on the fallback path.

**Fix now (CRITICAL/MAJOR):**
1. **CRITICAL — restore the exclusive if/else chain** in the design-folder branch so images render again. Done: nested the json/yaml/markdown chain inside the non-image `else`, with the inspect-disable at the top of that else.
2. **CRITICAL — restore the apply-modal buttons + closing structure** so `#inspect-overlay` is a sibling (not a child of the hidden modal) and the Apply workflow works. Done.

**Defer (NIT / acceptable risk):**
- SecurityError→backend-fallback wiring (MAJOR but largely unreachable in practice via the onerror path; revisit if Step 0 probe shows load-tainted behaviour on any target VS Code).
- PNG guardrail over-trigger + case-sensitivity (UX noise, not a crash).
- Overlay `position: fixed` + scroll-follow (verify manually; defer).
- Local-subtab `?.` guard + disable-on-no-image symmetry.

### Code fixes applied
- `src/webview/design.js` (design-folder `handlePreviewReady` branch): re-nested the `json`/`yaml`/`markdown` chain inside the non-image `else` block, restoring the original exclusive semantics so image previews render in the DESIGN SYSTEM tab. Inspect-button disable now lives at the top of that `else`.
- `src/webview/design.html` (apply-modal block): restored `<button id="btn-cancel-apply">`, `<button id="btn-execute-apply">`, and their wrapping flex row; restored the three closing `</div>`s so `#design-system-apply-modal` closes before `#inspect-overlay`, making the overlay a body-level sibling instead of a child of the hidden modal.

### Validation results
- `node --check src/webview/inspect.js` → OK.
- `node --check src/webview/design.js` → OK (brace-balanced after re-nest).
- HTML div-balance: apply-modal now opens 1 (modal) + 1 (modal-content) + 1 (modal-header, self-closed) + 1 (modal-body) + 2 inner rows + 1 apply-screens-list, with matching closes; `#inspect-overlay` confirmed as a sibling starting at the line after the modal's final `</div>`.
- Per session directives: `npm run compile` and automated tests NOT run in this session (deferred to user). No new test authored here.

### Remaining risks
1. **SecurityError→data-URL fallback not wired on the `getImageData` path** (only `probe.onerror` triggers the backend relay). Reachable only if an image loads-but-tainted despite `crossOrigin="anonymous"`; the Step 0 real-webview probe is the gate.
2. **Screenshot guardrail flags all `.png` files** (no dimension check, case-sensitive `.png`). UX noise on legitimate PNG assets.
3. **Overlay uses `position: absolute` pinned to the viewport rect captured at open** — won't follow panel scroll during an active inspection session.
4. **DESIGN-tab inspect enable/disable** depends on the `btn-design-subtab-local.active` class check inside `img.onload`; switching subtabs before load completes, or the local-subtab handler's disable-on-no-image gap, can leave the button in a stale state. Manual verification recommended.
5. **Step 0 CORS/color-space probe** still required on a real webview across target VS Code versions before declaring the primary path solid for the ~4,000-install base.
