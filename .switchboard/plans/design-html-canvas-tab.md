# Design panel — HTML Canvas tab (multi-screen pan/zoom board)

## Goal

Add a **Canvas** tab to the Design panel: a Figma/Miro-style pan-and-zoom surface that lays out **many HTML screens at once** on one board, each screen a framed, labelled iframe. Populate it two ways — **add individual HTML files**, or **add every screen in a Stitch project in one action** — and make **Inspect Mode available per frame**, so an agent can edit any single screen in place from the board.

### Context & the gap

Today the Design panel previews HTML **one file at a time** ([HTML Previews tab](../../../switchboard-site/src/pages/docs/artifacts/html-previews.md): "the selected file renders"). There is no way to see a *set* of screens together — a whole app flow, a design wall, a before/after — the way every SaaS design tool (Figma, Sketch, Miro) shows an artboard board. Users are hand-building these boards: a single large HTML file with dozens of screens laid out in CSS grid (e.g. the reference `daily-diary-designs.html` — ~17–23 phone mockups, 325 KB, one file, authored by an agent). That works but is a bespoke, unmaintainable artifact: no per-screen editing, no reuse of existing Stitch output, no zoom/navigation affordances.

The goal is **not** to productise that file's specific markup (its `board/frame/phone` classes). It's the generic capability SaaS design tools have: a canvas you drop screens onto and pan/zoom around, where each screen stays an independent, editable file.

### The build is mostly composition — these primitives already exist

| Primitive | Where | Reuse for the canvas |
|---|---|---|
| **Localhost-served iframes** (each frame gets its own document origin, so relative assets + isolated CSS work) | `DesignPanelProvider.ts:1778` (`http.createServer`), `:3845-3857` (`_buildLocalhostUrl` → `iframeSrc`); srcdoc rejected for CSP/relative-path reasons at `:1754` | Each canvas frame = one localhost iframe. No new rendering path — reuse the serve infra. |
| **Pan/zoom transform over a scaled iframe** + wheel-forwarding when the capture layer is hidden | `design.js` `panX/panY`/zoom (~`:271-449`); `DesignPanelProvider.ts:407-408` | Generalise from one preview to a surface holding N frames. |
| **Inspect Mode** (hover→select an element, describe a change, Send to Agent / Copy Prompt; preview auto-refreshes) | `inspect.js` (loaded at `DesignPanelProvider.ts:781`); `stitchElementSelected` message `:336` | Attach the same capture layer per frame; edits target that frame's source file. |
| **Stitch project screens enumerated as HTML docs** | `_sendStitchHtmlDocsReady` `DesignPanelProvider.ts:981-1013`, docs shape `{ screenId, name, file, sourceFolder, absolutePath }` | "Add all Stitch project files" = add every `absolutePath` in a project's docs as a frame. |
| **Tabbed shell** (`shared-tab-bar` / `shared-tab-btn` `data-tab` / `shared-tab-content`) | `design.html:3632-3638` | Add a `data-tab="canvas"` button + content panel. |

So the novel work is: the canvas surface (many frames on a transformed plane), the frame-add flows, per-frame inspect targeting, and persistence — not rendering, not inspect, not Stitch enumeration.

## Metadata

**Tags:** frontend, feature, design-panel
**Complexity:** 8

## Product decisions (RESOLVED with owner)

1. **Layout model — free-drag, from v1.** Frames are dragged and placed freely (Figma-style), not auto-gridded. Each frame persists its own `x/y` (and `w/h`); the canvas ships with drag handles and per-frame position persistence in v1. *(New-frame default: drop new adds at a non-overlapping offset near the viewport centre so a bulk Stitch add doesn't stack on one spot.)*
2. **Persistence — JSON sidecar.** `.switchboard/canvases/<name>.canvas.json`: an ordered list of `{ filePath, label, x, y, w, h }` plus canvas `zoom`/`pan`. Files-you-own, agent-editable, references screens by path (never copies content).
3. **Frames reference source files** (not copies). Inspect Mode edits the referenced file directly, so a canvas frame and the HTML Previews tab show the same underlying file.
4. **Sharing = an Export/Flatten step (NOT the live canvas).** The live canvas is N localhost iframes (needed for editing/isolation); that representation can't go to claude.ai Artifacts (single self-contained file, strict CSP, no localhost/relative assets). So sharing is a distinct **Export → single self-contained HTML** that feeds the existing "Upload to Claude Artifacts" path. Two flatten modes ship (see Phase 6):
   - **Deterministic flatten (default, one click) — `data:` URI iframes.** *(CSP-confirmed empirically via a published test artifact, 2026-07-20 — see Phase 6.)* One outer HTML; each screen embedded as `<iframe src="data:text/html;base64,…">` absolutely positioned per the layout. claude.ai artifacts enforce a hardcoded `frame-src 'self' blob: data:`, so `data:` frames are explicitly allowed while external-origin frames are blocked. This preserves each screen's **complete document** (its own `<head>`/`<style>`) with true isolation — no CSS extraction/merge needed. Every asset the screen references (`<img>`, CSS `url()`) MUST be inlined as a `data:` URI first — the artifact CSP blocks all external requests. **Shadow-DOM mounting is the fallback** only if `data:` iframes prove problematic.
   - **Flatten agent prompt (escape hatch):** Copy Prompt / Send to Agent hands the screens + layout to an agent to merge into one cohesive document (unify tokens, clean markup, handle awkward assets). Non-deterministic, highest polish.
   - **Sandbox caveat:** the artifact runs `sandbox="allow-scripts"`; a nested `data:` iframe is also sandboxed. Static visual screens render fine; heavily *scripted* screens may be limited (rare for design mockups) — the agent-flatten path is the workaround there.

**Remaining performance decision (still open):** many full-document iframes on one page is the real risk (see Complex/Risky) — viewport virtualisation + a surfaced frame cap is proposed. Owner to confirm the cap value, or accept the default.

## Complexity Audit

### Routine
- New `data-tab="canvas"` button + `shared-tab-content` panel in `design.html` (mirror the existing tabs at `:3632-3638`).
- Tab activation wiring in `design.js` (`_activeTab` handling; the panel becomes the active tab like the others).
- "Add Stitch project" action: request the project's `stitchHtmlDocs` (already emitted by `_sendStitchHtmlDocsReady`) and append each `absolutePath` as a frame.
- Canvas JSON load/save via a `canvas/*` message pair to `DesignPanelProvider` (read/write `.switchboard/canvases/<name>.canvas.json`).

### Complex / Risky
- **N iframes performance.** Each frame is a full HTML document over localhost; 20–40+ iframes will hammer memory/CPU and the local static server. **Mitigation:** (a) **viewport virtualisation** — only mount iframes intersecting (or near) the viewport; unmounted frames show a lightweight poster (first-paint screenshot or a title card) until scrolled into view; (b) a **frame cap** with a "showing N of M" notice (per the *no-silent-caps* rule, surface it); (c) reuse/limit the single static server rather than one per file. This is the make-or-break of the feature.
- **Per-frame Inspect targeting.** The existing capture layer + wheel-forwarding (`DesignPanelProvider.ts:407-408`) assume **one** scaled iframe. On a canvas the click must resolve to the *correct* frame's iframe and map coordinates through **both** the canvas transform and the frame's own scale. Inspect must set the "active frame" first, then run the existing select→edit flow against that frame's source file. Getting the coordinate math right across nested transforms is the trickiest part.
- **Pan/zoom + drag vs iframe pointer capture.** Iframes swallow pointer/wheel events. Panning across the canvas, and **dragging a frame**, must keep working over a frame — reuse the existing wheel-forwarding trick; drag frames by their header (not the iframe body); and use a transparent capture layer over the whole canvas, toggled by mode (Pan / Drag / Inspect), so a gesture that starts on a frame does the right thing instead of interacting with the frame's content.
- **Flatten asset-inlining fidelity.** Deterministic flatten must resolve and base64-embed every local `<img src>` and CSS `url(...)` inside each screen so the embedded doc has zero external/relative refs (claude.ai CSP blocks all external requests, even inside a `data:` iframe). Missing/oversized assets must be logged and placeholdered, never silently dropped. This is the highest-risk *correctness* area of the export; the agent-flatten path exists partly as a fallback when deterministic inlining hits awkward assets. *(Isolation mechanism itself is settled: `data:` URI iframes, allowed by the artifact's `frame-src 'self' blob: data:`.)*

## Proposed Changes

### Phase 1 — Tab shell + empty canvas surface
- `design.html`: add the `canvas` tab button + a `shared-tab-content` panel containing a `.canvas-viewport` (clips) → `.canvas-plane` (the transformed surface) → toolbar (zoom in/out, fit, reset; Pan/Inspect toggle; Add ▾).
- `design.js`: activate the tab; implement pan (drag on empty canvas) + zoom (wheel/⌘-scroll, buttons) + fit-to-frames by reusing the existing `panX/panY`/zoom logic, applied to `.canvas-plane` instead of a single preview.
- No frames yet — just an empty, navigable plane.

### Phase 2 — Frames from files (render, free-drag, persistence)
- `DesignPanelProvider`: `canvas/load` + `canvas/save` messages reading/writing `.switchboard/canvases/<name>.canvas.json`; `canvas/addFiles` (open a file picker or accept paths) resolving each to a localhost `iframeSrc` via the existing `_buildLocalhostUrl` serve path.
- `design.js`: render each frame as `.canvas-frame` — a **draggable header** (caption from `label`/filename + a **Link** button copying the file path, matching every other Design tab) above a scaled localhost iframe. Drag by the header (never the iframe body — it captures pointer events); persist `x/y` (and resize `w/h`) on drop. New adds drop at a non-overlapping offset near the viewport centre.
- Auto-refresh a frame's iframe when its source file changes (reuse the HTML Previews folder-watch pattern).

### Phase 3 — Add a whole Stitch project
- Reuse `_sendStitchHtmlDocsReady` (`:981-1013`): an "Add Stitch project ▾" action lists projects; picking one appends every screen's `absolutePath` as a frame, labelled by `name`. This is the headline populate path.

### Phase 4 — Per-frame Inspect Mode
- Generalise the capture layer so clicking a frame sets it active, then runs the existing `inspect.js` select→(**Send to Agent** / **Copy Prompt**) flow against that frame's source file. Reuse `stitchElementSelected` plumbing; the only new logic is active-frame resolution + nested-transform coordinate mapping.
- Edits land in the source HTML; the frame's iframe auto-refreshes (Phase 2 watch).

### Phase 5 — Performance hardening
- Viewport virtualisation (mount iframes on intersection; poster otherwise), frame cap with a visible "N of M" notice, single shared static server.

### Phase 6 — Export / Flatten to a shareable single HTML
The live canvas (localhost iframes) can't be shared to claude.ai Artifacts; Export produces one self-contained file that can. Two modes:
- **Deterministic flatten (default) — `data:` URI iframes.** New `canvas/flatten` handler composes one outer HTML: a positioned container per frame (absolute `x/y/w/h` from the layout JSON) holding `<iframe src="data:text/html;base64,…">`, the screen's full document base64-embedded. **CSP-confirmed empirically** (2026-07-20): a published test artifact rendered both `data:` and `srcdoc` iframes (and an inlined `data:` image inside them), while an external-URL frame was blocked — matching the artifact policy `frame-src 'self' blob: data:`. This keeps each screen's own `<head>`/`<style>` intact with true isolation — no CSS merge. No further CSP verification needed. Then reuse the existing **Upload to Claude Artifacts** path (single-file, already used by HTML Previews). Also offer **Save flattened HTML** to disk.
  - *Asset inlining is the crux* — before base64-embedding a screen, walk its `<img src>`/CSS `url(...)` refs, read the referenced files, and inline them as `data:` URIs so the embedded doc has zero external/relative refs (the artifact CSP blocks all external requests). Skip/placeholder anything unresolvable (log it; no silent drops).
  - *Sandbox note:* the nested `data:` iframe is sandboxed (parent is `sandbox="allow-scripts"`); static screens render fine, heavily-scripted screens may be limited → use the agent-flatten path.
  - *Fallback:* Shadow-DOM mounting (inline each screen's HTML+CSS into a shadow root) only if `data:` iframes misbehave.
- **Flatten agent prompt (escape hatch).** A **Copy Prompt** / **Send to Agent** that hands the agent the frame source paths + layout and asks for a single cohesive self-contained HTML (unify tokens, clean markup, embed assets) — matching the hand-authored board style. Reuses the existing agent-dispatch + Copy-Prompt plumbing; output drops into the same Save/Upload actions.

### Phase 7 — Docs (cross-repo, same branch)
- `switchboard-site`: add a **Canvas** page under `src/pages/docs/artifacts/` (nav + prev/next), covering add-files, add-Stitch-project, per-frame Inspect, and **Export/Flatten → Claude Artifacts**; add the Canvas tab row to `design-panel.md`'s tab table (`:19-26`).
- Once shipped, it becomes a fourth flow in the landing page's new **DESIGN IN THE LOOP** set piece (`index.astro`) — hold that copy until it lands.

## Edge-Case & Dependency Audit
- **Missing / moved source file** — a frame whose `filePath` no longer resolves shows a placeholder ("source not found") with a Remove action; never crash the canvas.
- **Duplicate adds** — adding the same file twice: allow (a board legitimately repeats a screen) but de-dupe the *Stitch-project* bulk-add against frames already present, and surface the count.
- **Multiple canvases** — support named canvases (a picker), each its own JSON; default to a `Default` canvas so the tab is never empty-by-error.
- **Cross-workspace** — respect the Design panel's existing workspace scoping; canvases live under the active workspace's `.switchboard/`.
- **CSP / origin** — reuse the localhost-iframe path exactly (`:3845-3857`); do **not** fall back to `srcdoc` (breaks relative assets + CSP, per `:1754`).
- **Inspect coordinate drift** — verify selection accuracy at several zoom levels and frame scales; this is the most likely correctness bug.

## Dependencies
None blocking. Builds entirely on shipped Design-panel infrastructure (localhost serve, pan/zoom, Inspect Mode, Stitch HTML docs). Independent of the remote-board work.

## Verification Plan

### Manual Verification (primary gate)
1. **Empty canvas** — open the Canvas tab; pan and zoom a blank plane; Fit and Reset behave.
2. **Add files** — add 3–4 individual HTML files; each renders as a framed iframe with a caption + Link; layout persists across a tab switch and a reload (JSON sidecar written).
3. **Add a Stitch project** — pick a project; every screen appears as a frame, correctly labelled; re-adding the same project doesn't duplicate existing frames.
4. **Per-frame Inspect** — enable Inspect, click an element in one frame, send an edit to an agent; only that frame's source changes and its iframe refreshes; other frames untouched. Repeat at 50% and 150% zoom to check coordinate mapping.
5. **Free-drag** — drag frames by their header to new positions; `x/y` persists across reload; dragging over an iframe body doesn't interact with its content.
6. **Export / Flatten** — deterministic flatten of a multi-frame canvas produces one self-contained HTML that renders correctly when opened standalone AND when uploaded to claude.ai Artifacts (screens isolated, assets inlined, layout preserved, zero external refs). Then run the **agent-flatten** prompt and confirm its output also uploads and renders.
7. **Performance** — a canvas of 20+ frames stays responsive; off-screen frames virtualise; the "N of M" cap notice shows when hit.
8. **Broken frame / asset** — delete a referenced file (frame → placeholder, canvas still works); flatten a canvas with a missing image (logged + placeholdered, not a silent drop or crash).

### Automated Tests (write; run per session directive)
- Canvas JSON round-trips (add/remove/reorder → load restores order + zoom/pan).
- Stitch bulk-add maps `stitchHtmlDocs` → frames and de-dupes.
- Missing-file → placeholder, no throw.

## Definition of Done
- A **Canvas** tab renders many HTML screens on one pan/zoom board.
- Screens added individually **and** by whole Stitch project; frames reference source files (no content copy) and carry a Link action.
- Frames are **free-dragged** and their `x/y/w/h` persist.
- **Inspect Mode works per frame**, editing only that frame's source, with accurate selection across zoom levels.
- Layout + zoom/pan persist to `.switchboard/canvases/<name>.canvas.json`; multiple named canvases supported.
- **Export/Flatten** produces a single self-contained HTML (no localhost/relative/external refs) that uploads to claude.ai Artifacts via the existing path — deterministic (Shadow DOM + inlined assets) by default, with an agent-flatten Copy Prompt / Send to Agent alternative.
- A 20+ frame canvas stays responsive (virtualisation + surfaced frame cap).
- Broken/missing sources (and unresolvable assets on flatten) degrade gracefully and are logged, never silently dropped.
- `switchboard-site` gains a Canvas doc page + a `design-panel.md` tab-table row, committed on the same branch.
