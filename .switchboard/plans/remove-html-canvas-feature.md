# Remove the iframe-based HTML Canvas feature (proper surgical removal)

## Goal

Fully remove the dormant iframe-based Canvas feature. Its tab was **hidden 2026-07-20** (`design.html` — the `data-tab="canvas"` button is commented out) because the model was wrong: it rendered separate files as scaled iframes on a plane, which can't inline into one doc, can't zoom into content, can't run inspect-mode, and has no commentary layer. It's being replaced by [canvas-from-html-preview-multiselect.md](canvas-from-html-preview-multiselect.md) (agent flattens selected files into one inline HTML board). This plan removes the dead code and files. **Backlog priority** — the tab is already hidden, so there is no user-facing urgency; this is cleanup to stop the dead code from rotting in shared files.

### Critical: this is NOT a `git revert`

`ad17f99` ("HTML Canvas") is an **auto-commit-before-review** that swept the whole working tree — it also contains unrelated work (advise-research edits, the codify-plan-autosplit plan, the design-preview-autorefresh plan, `KanbanProvider.ts`/`PlanningPanelProvider.ts` edits). Two later commits and current uncommitted edits also touch the shared canvas files. **Reverting `ad17f99` would trash unrelated work and not apply cleanly.** Removal must be surgical.

### Root cause / background

The iframe-on-a-plane model was architecturally wrong for the goal (a single shareable, editable board of many screens): iframes can't be inlined into one self-contained HTML, can't be zoomed into at the content level, can't run a per-element inspect loop across frame boundaries, and carry no commentary layer. The replacement plan inverts the model — an agent flattens selected files into one inline HTML document up front, so the result is one editable, shareable doc instead of a plane of isolated iframes. Removal is cleanup of the wrong-model code so it stops rotting in the three shared Design-panel files; it is not user-facing (the tab is already hidden).

## Metadata

**Tags:** frontend, refactor
**Complexity:** 5

## User Review Required

Yes — two decisions need a human call before implementation:

1. **`switchboard-site` DESIGN IN THE LOOP section + its SVG.** The uncommitted `switchboard-site` work added a new "DESIGN IN THE LOOP" set piece to `index.astro` (it replaced an older "AWAY FROM YOUR DESK" / remote-control section) and added `public/assets/design-studio-heist-detailed.svg` as its artwork. The section's *content* is about the Design panel generally (Stitch, Inspect Mode, design-as-context) — **not** Canvas-specific — and all three capabilities it describes are surviving tabs. The original plan instructed "Remove the Canvas `interchange__flow`" (no such flow exists) and "Delete `design-studio-heist-detailed.svg`" (which would break the section's `<img>`). **Decision required:** (a) keep the section and SVG as-is (recommended — it markets surviving features), or (b) revert the whole section back to "AWAY FROM YOUR DESK" + `remote-control-detailed.svg` if it was only ever meant to ship alongside Canvas. See the Superseded callouts in the footprint section.
2. **Salvage vs. delete `_inlineLocalAssets` / `_flattenCanvas`.** The replacement plan is agent-driven (the agent inlines assets while flattening). `_inlineLocalAssets` has no callers outside `_flattenCanvas`, and `_flattenCanvas` is canvas-specific (lays frames out on a plane) so it cannot apply to the replacement's single-inline-doc model. Recommendation: **delete both**. Confirm before implementation.

## Complexity Audit

### Routine
- Deleting the 5 canvas subtask plan files (`canvas-foundation-tab-panzoom-frames.md`, `canvas-add-stitch-project.md`, `canvas-per-frame-inspect-mode.md`, `canvas-export-flatten-artifact.md`, `canvas-performance-and-docs.md`).
- Deleting the `html-canvas-design-panel-2713e66b-…` feature card via the board/API (detach subtasks, then delete the feature).
- Removing the commented-out `data-tab="canvas"` button + its comment from `design.html`.
- Removing the `#canvas-content` panel and all `canvas*`-namespaced DOM from `design.html`.
- Removing all `canvas*` identifiers and `canvas/*` message handlers from `design.js`.
- Removing the canvas handler `case`s and canvas helper methods from `DesignPanelProvider.ts`.
- Removing the Canvas row from `design-panel.md`'s tab table and the `canvas.md` doc page.
- Restoring `design-system.md`'s `next:` nav to PM Tools.

### Complex / Risky
- **Shared-handler surgery in `design.js`:** `stitchElementSelected` (`design.js:3694`) carries a canvas branch (`canvasState.mode === 'inspect'` → `canvasFindFrameBySource`) alongside the Stitch/HTML-preview inspect path. Only the canvas branch may be removed; the Stitch/preview inspect path must stay intact. This is the single highest-regression-risk edit.
- **Two-repo coordination:** the `switchboard` repo (code) and `switchboard-site` repo (docs/asset) both carry uncommitted Canvas work and must land together to fully remove the feature. The session is single-repo, but the product scope spans both repos — both must be cleaned.
- **Verification grep is identifier-level, not word-level:** the bare word "canvas" survives in non-canvas contexts (e.g. `design.html` zoom-btn titles like "drag or scroll to move the canvas" for the Stitch/HTML-preview tabs). A naive `grep -c canvas` will never hit 0; the check must target `canvas*` identifiers and `canvas/` message types.
- **Feature-card vs. plan-file deletion ordering:** the feature card references the 5 subtask plan files. Deleting plan files while the feature card still references them can produce transient broken links on the board. Order: detach subtasks from the feature → delete the feature card → delete the 5 plan files (or rely on the plan watcher to re-sync; either is safe, but pick one and state it).

## Edge-Case & Dependency Audit

- **Race Conditions:** none material. The canvas code is unreachable (tab hidden), so no live runtime races are introduced by removal. The feature-card/plan-file deletion ordering (above) is the only ordering-sensitive operation, and it is board-side, not runtime.
- **Security:** none. No auth, no secrets, no network surface touched. `_inlineLocalAssets` reads local files and rewrites `url()`/`<img src>` to `data:` URIs — deleting it removes a file-read path, does not add one.
- **Side Effects:**
  - `.switchboard/canvases/<name>.canvas.json` and `<name>.flattened.html` user data: the removal stops reading/writing these, but does **not** delete existing user canvas JSON. Out of scope (user data); note in the plan that any orphaned `.switchboard/canvases/` directories are left for the user to clean manually.
  - `_canvasFrameWatchers` (file watchers) go away with the code — the "watchers never torn down on canvas switch" leak noted in the feature review is moot once the whole feature is gone.
  - `switchboard-site` build: removing `canvas.md` and the Canvas row from `design-panel.md` must not leave any other page's `prev:`/`next:` pointing at `/docs/artifacts/canvas`. Verified: only `design-system.md`'s `next:` points there (fixed in this plan) and `canvas.md`'s own `next:` points to `/docs/pm-tools/overview` (deleted with the file). `pm-tools/overview.md`'s `prev:` already points to Design System — no change needed.
- **Dependencies & Conflicts:**
  - Depends on the replacement plan's final shape for the salvage decision (resolved here: delete both helpers; the replacement is agent-driven).
  - Conflicts with any in-flight work touching `design.html` / `design.js` / `DesignPanelProvider.ts` — the working tree currently has uncommitted edits to `DesignPanelProvider.ts` and `design.html` (unrelated to canvas). The implementer must remove only canvas-namespaced lines and not clobber the unrelated uncommitted edits.
  - The `switchboard-site` Canvas work is uncommitted on `main` — removal happens against that uncommitted state, not as a revert of a landed commit.

## Dependencies

- `canvas-from-html-preview-multiselect.md` — replacement capability (agent-flattened inline board). Independent: this removal does not block the replacement, and the replacement does not require any salvaged helper from this plan (decision: delete both).
- No `sess_…` session dependencies.

## Adversarial Synthesis

Key risks: (1) shared-handler surgery in `stitchElementSelected` — removing too much breaks Stitch/HTML-preview inspect; (2) the `switchboard-site` SVG/section conflict — the plan as written would break the landing page's DESIGN IN THE LOOP `<img>`; (3) a too-loose verification grep that passes while canvas identifiers remain. Mitigations: identifier-level grep, a manual click-through of every surviving Design tab, and the User Review decision on the `switchboard-site` section before any SVG deletion.

## Proposed Changes

### `src/webview/design.html`
- **Context:** the `data-tab="canvas"` button is already commented out (lines ~3639–3643); the `#canvas-content` panel (lines ~4291–4360+) is dormant but present.
- **Logic / Implementation:**
  1. Delete the commented-out `data-tab="canvas"` button and its 4-line explanatory comment (~3639–3643).
  2. Delete the entire `#canvas-content` `shared-tab-content` panel: `controls-strip-canvas`, `canvas-name-select`, `btn-canvas-new`/`-add-files`/`-add-stitch`, `canvas-add-stitch-select`, `status-canvas`, `canvas-viewport`, `canvas-plane`, `canvas-empty-state`, `canvas-capture-layer`, the canvas zoom-btn cluster (`canvas-btn-pan`/`-drag`/`-inspect`/`-flatten`/`-flatten-agent`/`-upload-artifact`/`-copy-artifact-prompt`), and the `canvas-tweak-popup` subtree.
  3. **Do NOT touch** the non-canvas zoom-btn titles that happen to contain the word "canvas" (e.g. ~3867, ~3938 — "drag or scroll to move the canvas" on Stitch/HTML-preview pan buttons). Those are not canvas-feature code.
- **Edge Cases:** verify the `shared-tab-content` class and the tab-switching JS have no canvas-specific branching beyond what `design.js` removal handles.

### `src/webview/design.js`
- **Context:** 286 lines mention `canvas`; all canvas code is cleanly namespaced `canvas*` except the shared `stitchElementSelected` handler.
- **Logic / Implementation:**
  1. Remove the canvas tab-activation branch (~189–192: `if (tabName === 'canvas' && !canvasState._loaded) { … canvasLoad(…) }`).
  2. Remove all `canvas/*` inbound message handler `case`s: `canvas/loaded`, `canvas/framesAdded`, `canvas/frameRefresh`, `canvas/stitchDocsReady`, `canvas/pathCopied`, `canvas/flattened`, and any remaining `canvas/*` cases (~3239–3320).
  3. Remove every `canvas*` identifier definition: `canvasState`, `canvasApplyTransform`, `canvasPlane`, `canvasViewport`, `canvasSave`/`canvasSaveDebounced`, `canvasSetMode`, `canvasRenderFrames`, `canvasZoomAt`, `canvasFit`, `canvasLoad`, `canvasPopulateNameSelect`/`canvasPopulateStitchSelect`, `canvasComposeTweakPrompt`, `canvasCaptureLayer`, `canvasArtifactUploadPrompt`, `canvasAddFrame`/`canvasRemoveFrame`/`canvasRefreshFrame`, `canvasObserveFrames`, `canvasNextOffset`, `canvasInit`/`canvasInitListeners`, `canvasFindFrameBySource`, `canvasEmptyState`, `canvasBuildFrameEl`, `canvasBounds`, `canvasCopyPath`.
  4. **Shared-handler surgery:** in `stitchElementSelected` (~3694), remove ONLY the canvas branch — the `if (canvasState.mode === 'inspect') { … canvasFindFrameBySource … }` block (~3712–3737). Leave the Stitch/HTML-preview inspect path and the `activeSource` gating intact.
  5. Remove any canvas-specific listener registrations wired in `canvasInitListeners` and the `canvasInit` call site.
- **Edge Cases:** after removal, `node --check src/webview/design.js` must pass. No remaining reference to `canvasState`, `canvasFindFrameBySource`, or any `canvas*` symbol.

### `src/services/DesignPanelProvider.ts`
- **Context:** 71 lines mention canvas; helpers and handler `case`s are cleanly grouped.
- **Logic / Implementation:**
  1. Remove the field `_canvasFrameWatchers` (~159) and the method `_setupCanvasFrameWatchers` (~1894–1924).
  2. Remove `_flattenCanvas` (~1926–1982) and `_inlineLocalAssets` (~1984–2046).

     > **Superseded:** "Check before deleting `_inlineLocalAssets` / `_flattenCanvas`: the replacement plan is agent-driven, but if a deterministic asset-inliner is wanted there, salvage these instead of deleting. Decide against the replacement plan's final shape."
     > **Reason:** The replacement plan (`canvas-from-html-preview-multiselect.md`) is fully agent-driven — the agent inlines assets while flattening selected files into one HTML doc. `_inlineLocalAssets` has no callers outside `_flattenCanvas` (verified: `grep -rn _inlineLocalAssets src/` returns only its definition and the one call from `_flattenCanvas`). `_flattenCanvas` is canvas-specific (lays frames out on a plane with absolute coordinates) and cannot apply to the replacement's single-inline-doc model. Keeping either would leave dead, untested code with no caller — the exact rot this plan exists to remove.
     > **Replaced with:** Delete both `_flattenCanvas` and `_inlineLocalAssets`. No salvage. If a deterministic inliner is ever wanted for the replacement, it can be reintroduced against the replacement's actual shape at that time.

  3. Remove `_buildCanvasFlattenPrompt` (~2048–2062).
  4. Remove the canvas handler `case`s: `canvas/load`, `canvas/save`, `canvas/addFiles`, `canvas/addStitchProject`, `canvasCopyPath`, `canvas/flatten`, `canvas/copyFlattenPrompt`, `canvas/sendFlattenPrompt` (~2393–2555).
  5. Remove the `// ── Canvas helpers ──` and `// ── Canvas (Design panel Canvas tab) ──` section banners.
- **Edge Cases:** the unrelated uncommitted edits to `DesignPanelProvider.ts` (feature-mode-directive fix) must be preserved — remove only canvas lines.

### `.switchboard/plans/` — delete 5 subtask plan files
- Delete `canvas-foundation-tab-panzoom-frames.md`, `canvas-add-stitch-project.md`, `canvas-per-frame-inspect-mode.md`, `canvas-export-flatten-artifact.md`, `canvas-performance-and-docs.md`.
- **Order:** delete the feature card first (see below), then delete these files — or delete files first and let the plan watcher re-sync the board. State the chosen order in the implementation; either is safe.

### `.switchboard/features/html-canvas-design-panel-2713e66b-96b7-4ebf-b4a7-2d804c85cdf7.md` — delete the feature card
- Detach all subtasks from the feature, then delete the feature card via the board UI or the local API (e.g. `kanban_operations` / `POST` to the feature delete endpoint). **Do NOT hand-edit `kanban.db` directly.**

### `switchboard-site` — `src/pages/docs/artifacts/`
- **`canvas.md`** — delete the file.
- **`design-panel.md`** (~line 27) — remove the Canvas row from the tab table:
  `| [Canvas](/switchboard-site/docs/artifacts/canvas) | A Figma/Miro-style board: … |`
- **`design-system.md`** (frontmatter) — restore `next:` to PM Tools:

  > **Superseded:** "Revert `design-system.md` `next:` repoint (was → Canvas; restore → PM Tools)."
  > **Reason:** Correct intent, underspecified href. The exact target is the PM Tools overview page (`/docs/pm-tools/overview`), confirmed from `canvas.md`'s own existing `next:` and from `pm-tools/overview.md`'s `prev:` (which already points back to Design System). Writing only "PM Tools" leaves the implementer to guess the href.
  > **Replaced with:** Set `design-system.md` frontmatter `next:` to `title: "PM Tools"`, `href: "/docs/pm-tools/overview"`. No change to `pm-tools/overview.md`'s `prev:` (already correct).

### `switchboard-site` — `src/pages/index.astro` + `public/assets/design-studio-heist-detailed.svg`

> **Superseded:** "Remove the Canvas `interchange__flow` from `index.astro`'s DESIGN IN THE LOOP set piece."
> **Reason:** False premise — there is no Canvas-specific `interchange__flow` in the DESIGN IN THE LOOP section. The section's three flows are "Generate UI from a prompt" (Stitch), "Point at it, describe the change" (Inspect Mode), and "The design is context, not a handoff" (design-as-context). None mention Canvas. All three describe surviving tabs that are NOT being removed.
> **Replaced with:** No `interchange__flow` removal in `index.astro`. The section markets surviving Design-panel capabilities and stays as-is (pending the User Review decision on whether to keep the section at all vs. revert to the prior "AWAY FROM YOUR DESK" set piece).

> **Superseded:** "Delete `public/assets/design-studio-heist-detailed.svg`."
> **Reason:** `design-studio-heist-detailed.svg` is the `<img src>` artwork for the DESIGN IN THE LOOP section in `index.astro`. Deleting it breaks the landing page — the `<img>` would 404. The SVG is not Canvas-specific (alt text: "Bob Ross paints happy little cyan trees at his easel … the spy agent dashes in, grabs the painting and sprints off, and a fresh one takes its place") — it depicts the Design panel's generate-edit-refresh loop, not Canvas.
> **Replaced with:** Keep `design-studio-heist-detailed.svg` (pending the User Review decision). If the user chooses to revert the entire DESIGN IN THE LOOP section back to "AWAY FROM YOUR DESK", then restore `remote-control-detailed.svg` as the artwork and delete `design-studio-heist-detailed.svg` as part of that revert — but only as part of a full section revert, never as a standalone delete.

## Verification Plan

> Per session directives: **skip compilation** (no `tsc`/build) and **skip automated tests**. Verification is manual + syntax-check + grep only.

### Automated Tests
- None run (skipped per session directive).

### Manual verification
1. **Canvas tab gone:** open the Design panel — no CANVAS tab button, no `#canvas-content` panel.
2. **Surviving tabs regression check (the real risk — shared files):** click through **HTML Previews, Stitch, Stitch HTML, Briefs, Images, Design System** tabs — each renders, switches, and inspect-mode works. Specifically: in HTML Previews / Stitch HTML, click an element → `stitchElementSelected` inspect popup still fires (only the canvas branch was removed).
3. **JS syntax:** `node --check src/webview/design.js` exits 0.
4. **Identifier-level grep (NOT word-level):**
   - `grep -nE '\bcanvas[A-Z]' src/webview/design.js src/webview/design.html src/services/DesignPanelProvider.ts` → 0 hits (catches `canvasState`, `canvasLoad`, etc.).
   - `grep -nE "'canvas/|\"canvas/|case 'canvas" src/webview/design.js src/services/DesignPanelProvider.ts` → 0 hits (canvas message handlers gone).
   - `grep -nE '_canvasFrameWatchers|_setupCanvasFrameWatchers|_flattenCanvas|_inlineLocalAssets|_buildCanvasFlattenPrompt' src/services/DesignPanelProvider.ts` → 0 hits.
   - The bare word "canvas" may still appear in non-canvas zoom-btn titles (`design.html` ~3867, ~3938) and in SVG-internal metadata — that is expected and NOT a failure.
5. **No dangling references:** no `import`/`require` of removed symbols; no remaining `canvas/*` message `postMessage` senders in `DesignPanelProvider.ts`.
6. **Board state:** the `html-canvas-design-panel-…` feature card is gone; the 5 canvas subtask plan files are gone; no broken plan-file links on the board.
7. **`switchboard-site`:**
   - `src/pages/docs/artifacts/canvas.md` no longer exists.
   - `design-panel.md` tab table has no Canvas row.
   - `design-system.md` `next:` points to `/docs/pm-tools/overview`; clicking next lands on PM Tools.
   - No page's `prev:`/`next:` points to `/docs/artifacts/canvas`.
   - `index.astro` DESIGN IN THE LOOP section renders (per User Review decision); no broken `<img>` (SVG kept, or section reverted per decision).
   - Build the site (manual, if a build step is available outside the skipped compile directive) and confirm no orphaned Canvas nav/prev-next.

## Definition of Done
- All canvas code removed from `design.html` / `design.js` / `DesignPanelProvider.ts`; no regressions in the other Design tabs (manual click-through passes).
- `_inlineLocalAssets` / `_flattenCanvas` / `_buildCanvasFlattenPrompt` / `_setupCanvasFrameWatchers` / `_canvasFrameWatchers` deleted (no salvage).
- Canvas plans + feature removed from the board; canvas docs removed from `switchboard-site`.
- `design-system.md` `next:` restored to `/docs/pm-tools/overview`.
- `index.astro` DESIGN IN THE LOOP section + `design-studio-heist-detailed.svg` either kept (recommended) or fully reverted per User Review decision — never a standalone SVG delete.
- Identifier-level greps all return 0 hits; `node --check src/webview/design.js` passes.

## Recommendation

Complexity 5 → **Send to Coder**. The work is mostly mechanical deletion, but the shared-handler surgery in `stitchElementSelected` and the two-repo coordination push it above intern-tier. A coder should execute it with the manual verification click-through as the acceptance gate.

## Completion Summary

Surgically removed the iframe-based HTML Canvas feature across both repos. In `switchboard`: deleted the commented-out `data-tab="canvas"` button + comment and the entire `#canvas-content` panel from `src/webview/design.html`; removed the canvas tab-activation branch, all `canvas/*` message-handler cases, the canvas branch of the shared `stitchElementSelected` handler (Stitch/HTML-preview inspect path left intact), the `canvasPopulateStitchSelect` call, and the whole canvas module (`canvasState` through `canvasInit()`) from `src/webview/design.js`; removed `_canvasFrameWatchers`, `_setupCanvasFrameWatchers`, `_flattenCanvas`, `_inlineLocalAssets`, `_buildCanvasFlattenPrompt`, and all canvas handler `case`s + banners from `src/services/DesignPanelProvider.ts`; deleted the 5 canvas subtask plan files and the `html-canvas-design-panel-2713e66b-…` feature card (replacement plan `canvas-from-html-preview-multiselect.md` and its `btn-make-canvas-*` / `composeCanvasFromFilesPrompt` webview code kept intact). In `switchboard-site`: deleted `src/pages/docs/artifacts/canvas.md`, removed the Canvas row from `design-panel.md`'s tab table, and repointed `design-system.md` frontmatter `next:` to `/docs/pm-tools/overview`. Per the plan's superseded callouts, the `index.astro` DESIGN IN THE LOOP section and `design-studio-heist-detailed.svg` were kept (not Canvas-specific). Verification: `node --check src/webview/design.js` passes; identifier-level greps for `canvas[A-Z]`, `canvas/` message types, and the five deleted private helpers all return 0 hits; only the bare word "canvas" survives in non-canvas zoom-btn titles, the wheel-forwarding comment, and the replacement Make-Canvas feature — all expected. No issues encountered. Skipped compilation and automated tests per session directives; manual click-through of surviving Design tabs is the remaining acceptance gate.
