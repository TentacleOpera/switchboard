# Canvas foundation — Design-panel tab, pan/zoom surface, free-drag frames, persistence

## Goal

Add a **Canvas** tab to the Design panel: a Figma/Miro-style pan-and-zoom surface holding many HTML screens at once, each a framed, free-draggable iframe. This plan is the **foundation** the other Canvas plans build on — it delivers a working canvas you can add individual HTML files to, arrange freely, and that persists. (Stitch bulk-add, per-frame Inspect Mode, and Export/Flatten are separate plans that depend on this one.)

### Context

The Design panel previews HTML **one file at a time** (HTML Previews tab). There's no way to see a *set* of screens together the way SaaS design tools show an artboard board. Users hand-build these as a single large HTML file — unmaintainable, no per-screen editing. This delivers the generic capability: a canvas you drop screens onto and pan/zoom around, each screen an independent file.

**Reuses shipped primitives** (compose, don't rebuild): localhost-served iframes with their own origin (`DesignPanelProvider.ts:1778` `http.createServer`, `:3845-3857` `_buildLocalhostUrl`→`iframeSrc`; srcdoc rejected for CSP at `:1754`); the existing pan/zoom transform + wheel-forwarding over a scaled iframe (`design.js` `panX/panY`/zoom ~`:271-449`; `DesignPanelProvider.ts:407-408`); the tab shell (`design.html:3632-3638` `shared-tab-bar`/`shared-tab-btn`/`shared-tab-content`).

## Metadata

**Tags:** frontend, feature, ui
**Complexity:** 6

## Proposed Changes

1. **Tab shell** — `design.html`: add a `data-tab="canvas"` button + `shared-tab-content` panel containing `.canvas-viewport` (clips) → `.canvas-plane` (transformed surface) → toolbar (zoom in/out, fit, reset; Pan/Drag mode toggle; Add ▾). `design.js`: activate the tab like the others (`_activeTab`).
2. **Pan/zoom surface** — implement pan (drag on empty canvas) + zoom (wheel/⌘-scroll, buttons) + fit-to-frames by reusing the existing `panX/panY`/zoom logic, applied to `.canvas-plane`.
3. **Frames from files** — `DesignPanelProvider`: `canvas/addFiles` (file picker or accept paths) resolving each to a localhost `iframeSrc` via `_buildLocalhostUrl`. `design.js`: render each as `.canvas-frame` — a **draggable header** (caption from filename + a **Link** button copying the file path, matching every Design tab) above a scaled localhost iframe.
4. **Free-drag** — drag by the header (never the iframe body — it captures pointer events); a transparent capture layer over the canvas, toggled by mode (Pan / Drag), routes gestures correctly. New adds drop at a non-overlapping offset near viewport centre. Persist `x/y/w/h` on drop.
5. **Persistence** — `canvas/load` + `canvas/save` messages read/write `.switchboard/canvases/<name>.canvas.json`: `{ frames: [{ filePath, label, x, y, w, h }], zoom, pan }`. Frames **reference** source files (never copy). Support multiple named canvases (picker); default to a `Default` canvas.
6. **Auto-refresh** — a frame's iframe refreshes when its source file changes (reuse the HTML Previews folder-watch pattern).

## Complex / Risky
- **Pan/drag vs iframe pointer capture** — iframes swallow pointer events; the mode-toggled capture layer + header-only drag is the mechanism. Get this right or dragging/panning over a frame breaks.
- **Transform math** — frame `x/y/w/h` live in canvas-plane coordinates; the plane is itself scaled/panned. Keep one clear coordinate space.

## Dependencies
None. This is the base for the other Canvas plans.

## Verification Plan
1. Open the Canvas tab; pan and zoom a blank plane; Fit and Reset behave.
2. Add 3–4 individual HTML files; each renders as a framed iframe with caption + Link.
3. Drag frames by their header; `x/y` persists across a tab switch and a reload (JSON sidecar written).
4. Dragging over an iframe body doesn't interact with its content.
5. Edit a source file on disk → its frame refreshes.
6. Second named canvas is independent; `Default` canvas is never empty-by-error.

## Definition of Done
- A Canvas tab renders many HTML screens on one pan/zoom board; frames are free-dragged and `x/y/w/h` persist.
- Add individual HTML files; frames reference source files (no copy) and carry a Link action.
- Layout + zoom/pan persist to `.switchboard/canvases/<name>.canvas.json`; multiple named canvases supported.
- Broken/missing source → placeholder, canvas still works.

## Review Findings

Reviewed the committed implementation (commit `ad17f99`) against this plan. **CRITICAL:** `canvas/addFiles` called `_seams().window.showOpenDialog` — `HostSeams` has no `window` property (only `ui`), so Add Files threw `TypeError` at runtime; fixed to `_seams().ui.showOpenDialog` (`DesignPanelProvider.ts:2357`). **MAJOR:** zoom/pan were not persisted (wheel zoom, button zoom, fit, reset, wheel-pan never called `canvasSave` — only drag-pan saved on mouseup); added a debounced `canvasSaveDebounced()` and wired it into `canvasZoomAt`, `canvasFit`, the wheel pan/zoom path, and reset (`design.js`). **MAJOR:** `canvasNextOffset` placed frames on a 40px diagonal cascade — frames overlapped heavily (480×320 default); replaced with an 8-column grid-pack so new adds are non-overlapping (`design.js`). **MAJOR:** `canvasInit` called `canvasLoad('Default')` on every Design panel open AND the tab-entry handler loaded again on first switch (double-load + eager load even when the tab is never visited); removed the eager load — the canvas now lazy-loads on first tab visit. Files changed: `src/services/DesignPanelProvider.ts`, `src/webview/design.js`. Validation: `node --check src/webview/design.js` passes (exit 0); tsc/tests skipped per review directives. **Remaining risks:** frame-source watchers are never torn down on canvas switch / frame removal (bounded by unique files on disk — resource leak, not a correctness bug); wheel zoom/pan over a frame body in `none`/`inspect` mode is swallowed by the iframe and the forwarded `sbWheel` is dropped by the parent (the existing `sbWheel` router only handles the html/stitch preview frames) — panning/zooming over a frame requires Pan mode or the toolbar buttons.
