# HTML Canvas (Design panel)

**Complexity:** 6

## Goal

A Figma/Miro-style Canvas tab in the Design panel: a pan-and-zoom surface holding many HTML screens at once, each a free-draggable, independently-editable frame. Populate it by adding individual HTML files or bulk-adding a whole Stitch project's screens; edit any frame in place via per-frame Inspect Mode; and export the whole board as one self-contained HTML for sharing to Claude Artifacts. Delivered as a coherent set: foundation first, then the populate, edit, and export capabilities, then performance hardening and docs.

## How the Subtasks Achieve This

- **Canvas foundation** — the Canvas tab, pan/zoom surface, free-drag localhost-iframe frames, and JSON-sidecar persistence, plus add-individual-files. The base every other subtask builds on.
- **Bulk-add a Stitch project** — one action adds every screen in a Stitch project as frames (reusing the existing `stitchHtmlDocs` enumeration). The headline populate path beyond adding files one at a time.
- **Per-frame Inspect Mode** — click an element in any frame, describe a change, and an agent edits that frame's source in place. The in-canvas editing loop; reuses the existing Inspect Mode, retargeted to the active frame.
- **Export / Flatten** — turns the live multi-iframe canvas into one self-contained HTML (`data:` iframes, assets inlined) so the whole board can be shared to Claude Artifacts. Deterministic default + an agent-flatten escape hatch.
- **Performance hardening + docs** — viewport virtualisation, frame cap, and single static server to keep a 20+ frame canvas responsive; plus the Canvas doc page, tab-table row, and landing-page flow.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Canvas foundation — Design-panel tab, pan/zoom surface, free-drag frames, persistence](../plans/canvas-foundation-tab-panzoom-frames.md) — **CODE REVIEWED**
- [ ] [Canvas — bulk-add a whole Stitch project's screens](../plans/canvas-add-stitch-project.md) — **CODE REVIEWED**
- [ ] [Canvas — per-frame Inspect Mode (point at a screen, an agent edits it)](../plans/canvas-per-frame-inspect-mode.md) — **CODE REVIEWED**
- [ ] [Canvas — Export / Flatten to a shareable single HTML (Claude Artifacts)](../plans/canvas-export-flatten-artifact.md) — **CODE REVIEWED**
- [ ] [Canvas — performance hardening + docs](../plans/canvas-performance-and-docs.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Foundation must land first** — it delivers the tab, surface, frames, and persistence that everything else builds on. Once it's in, the three middle subtasks are independent and can be built in parallel: **bulk-add Stitch**, **per-frame Inspect Mode**, and **Export / Flatten** (Export needs frames + layout but nothing from the other two). **Performance hardening + docs** comes last — virtualisation needs real frames to harden, and the docs describe the finished capability set.

Spine: `foundation → { stitch-add, inspect, export } → performance-and-docs`.

## Review Findings

Reviewed the full 5-subtask delivery (commit `ad17f99` on `switchboard` + uncommitted `switchboard-site` docs) as one unit. **CRITICAL fix applied:** `canvas/addFiles` referenced `_seams().window.showOpenDialog` — `HostSeams` has no `window` member, so Add Files crashed at runtime; corrected to `_seams().ui.showOpenDialog`. **MAJOR fixes applied:** zoom/pan now persist (debounced save wired into all zoom/pan paths); frames grid-pack instead of stacking on a 40px diagonal (fixes both Add Files and Stitch bulk-add); the agent-flatten escape hatch now has a reachable `✦` toolbar button; the flattened HTML is now fed into the existing Upload-to-Claude-Artifacts path via `⇗`/`ⓒ` toolbar buttons that build the upload prompt from the flattened file's path; removed the double-load where `canvasInit` and the tab-entry handler both loaded the canvas. Files changed across the feature: `src/services/DesignPanelProvider.ts`, `src/webview/design.js`, `src/webview/design.html`. Validation: `node --check src/webview/design.js` passes (exit 0); tsc/tests skipped per review directives. **Remaining risks (cross-cutting):** frame-source watchers are never torn down on canvas switch (bounded leak); wheel zoom/pan over a frame body in none/inspect mode is dropped (use Pan mode or toolbar buttons); the `switchboard-site` docs + SVG asset are uncommitted on main and need to land on the same branch.
