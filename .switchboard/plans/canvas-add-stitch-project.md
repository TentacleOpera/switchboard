# Canvas — bulk-add a whole Stitch project's screens

## Goal

Add a one-action **"Add Stitch project"** path to the Canvas tab: pick a Stitch project and every screen in it lands on the canvas as a frame, labelled by screen name. This is the headline populate path (vs adding files one at a time).

### Context

A Stitch project already has its screens enumerated as HTML docs — `_sendStitchHtmlDocsReady` (`DesignPanelProvider.ts:981-1013`) emits `docs: Array<{ screenId, name, file, sourceFolder, absolutePath }>`. Bulk-add = take all `absolutePath`s for a project and add each as a canvas frame using the foundation's `canvas/addFiles` path.

## Metadata

**Tags:** frontend, feature
**Complexity:** 3

## Proposed Changes
- `design.html`/`design.js`: an **"Add Stitch project ▾"** action in the Canvas toolbar lists projects (reuse the existing project list the Stitch tab already loads).
- On pick: request the project's `stitchHtmlDocs` (reuse `_sendStitchHtmlDocsReady`), append every screen's `absolutePath` as a frame labelled by `name`, laid out at non-overlapping offsets (grid-pack the batch so they don't stack).
- **De-dupe** against frames already present on the canvas (by `filePath`); surface the count added vs skipped.

## Dependencies
Depends on **canvas-foundation-tab-panzoom-frames** (frame rendering, `canvas/addFiles`, persistence).

## Verification Plan
1. Pick a Stitch project → every screen appears as a labelled frame, packed without overlap.
2. Re-add the same project → existing frames are not duplicated; a "N added, M already present" count shows.
3. Added frames persist to the canvas JSON like any other frame.

## Definition of Done
- One action adds all of a Stitch project's screens as canvas frames, correctly labelled, de-duped against what's already there, count surfaced.

## Review Findings

Reviewed commit `ad17f99` against this plan. The `canvas/addStitchProject` handler (`DesignPanelProvider.ts:2378`) reuses `_resolveStitchProjectName` + `_getImageCacheDir` + `KanbanDatabase.getStitchScreensForProject` to enumerate screens and resolve labels, posts `canvas/stitchDocsReady`, and the webview de-dupes by `filePath` via `canvasAddFrame` (returns null on duplicate) and surfaces an "N added, M already present" count — matches the plan. **MAJOR (fixed via foundation):** the bulk-add reused `canvasNextOffset`, which placed frames on a 40px diagonal cascade — every screen in a project stacked nearly on top of the previous one instead of being grid-packed as the plan requires; the foundation-plan fix (8-column grid-pack in `canvasNextOffset`) resolves this for bulk-add too. No issues found in the de-dupe, labelling, or count-surfacing logic. Files changed (via foundation fix): `src/webview/design.js`. Validation: `node --check src/webview/design.js` passes. **Remaining risk:** `canvasSave` is called once per frame during a bulk-add (N rapid disk writes for an N-screen project) — functionally correct but could be debounced for large projects.
