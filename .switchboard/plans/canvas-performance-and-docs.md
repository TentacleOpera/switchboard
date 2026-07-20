# Canvas — performance hardening + docs

## Goal

Make a busy Canvas (20–40+ frames) stay responsive, and document the whole Canvas feature. This is the finalisation pass, run after the functional Canvas plans land.

### Context

Each canvas frame is a full HTML document rendered over a localhost server; many at once will hammer memory/CPU and the local server — the real performance risk of the feature. Docs are cross-repo (the `switchboard-site` Astro docs) and land on the same branch.

## Metadata

**Tags:** frontend, performance, docs
**Complexity:** 4

## Proposed Changes

### Performance
- **Viewport virtualisation** — only mount iframes intersecting (or near) the viewport; unmounted frames show a lightweight poster (first-paint screenshot or a title card) until scrolled into view.
- **Frame cap** — a default cap with a visible **"showing N of M"** notice (surface it — never silently truncate).
- **Single shared static server** — reuse/limit one localhost static server for all frames rather than one per file.

### Docs (cross-repo, `switchboard-site`, same branch)
- Add a **Canvas** page under `src/pages/docs/artifacts/` (nav + prev/next) covering: add individual files, add a Stitch project, per-frame Inspect Mode, and Export/Flatten → Claude Artifacts.
- Add the **Canvas** tab row to `design-panel.md`'s tab table (`:19-26`).
- Once shipped, add it as a fourth flow in the landing page's **DESIGN IN THE LOOP** set piece (`index.astro`) — do this only after the feature lands.

## Dependencies
Depends on the functional Canvas plans (foundation + the frame-producing plans) being in place — virtualisation and the docs both need real frames/flows to harden and describe.

## Verification Plan
1. A canvas of 20+ frames stays responsive; off-screen frames virtualise (poster shown), mount on scroll.
2. The "N of M" cap notice shows when the cap is hit.
3. Docs page renders in the Astro site (nav + prev/next correct); `design-panel.md` tab row present; landing-page flow added.

## Definition of Done
- A 20+ frame canvas stays responsive (virtualisation + surfaced frame cap + single static server).
- `switchboard-site` gains a Canvas doc page + a `design-panel.md` tab-table row (+ landing-page flow), committed on the same branch.

## Review Findings

Reviewed commit `ad17f99` (switchboard) plus uncommitted `switchboard-site` changes against this plan. **Performance:** viewport virtualisation is implemented via an `IntersectionObserver` (`canvasObserveFrames`, `design.js:5897`) with a 400px root margin — off-screen iframes swap to `about:blank` and show a poster, remount on scroll-back; the observer is disconnected and re-created on each render to avoid stale observations. The frame cap (`CANVAS_FRAME_CAP = 40`) is surfaced via a "showing N of M" status, never silently truncating (frames beyond the cap are persisted but not rendered). The "single shared static server" is satisfied by the existing `_getOrCreateHtmlServer` pattern (one server per source folder, not per file). **Docs:** `switchboard-site/src/pages/docs/artifacts/canvas.md` exists with correct frontmatter nav (prev: Design System, next: PM Tools), `design-system.md`'s `next` was repointed to Canvas, the `design-panel.md` tab table has the Canvas row, and `index.astro` has the Canvas flow as a fourth `interchange__flow` in the DESIGN IN THE LOOP set piece. No code changes required for this plan. Validation: `node --check src/webview/design.js` passes; docs files present on disk. **Remaining risks:** the `design-studio-heist-detailed.svg` asset and the docs changes are untracked/uncommitted on `switchboard-site` main (need committing to the same branch as the switchboard changes); the "single shared static server" is one-per-folder rather than one-total (matches the existing shipped pattern — acceptable, but a canvas with frames from many folders still spawns one server per folder).
