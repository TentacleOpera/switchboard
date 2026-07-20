# Preserve HTML preview zoom/pan across file auto-refresh

## Goal

**Problem:** In the Design and Planning webview HTML previews, the zoom and pan state is thrown away every time the underlying file is re-rendered (auto-refresh on save). The user has to re-set their zoom level after every edit, which is a constant irritation during iterative design work.

**Background:** The preview is driven by `handlePreviewReady()` in the webview. Each time a preview-ready message arrives — including an *auto-refresh* of the *same* file the user is already looking at — the handler unconditionally resets the zoom/pan engine. A follow-up `sbContentDims` message from the iframe then re-runs `fitToContainer`, so even the reset scale is immediately overwritten by an auto-fit. The net effect is that any manual zoom/pan the user set is lost on every save.

**Root cause (two coupled resets on the same code path):**
1. `handlePreviewReady()` calls `resetZoom('html')` / `resetZoom('planningHtml')` on *every* message, with no check for `isAutoRefreshed`. See [design.js:1408](src/webview/design.js#L1408) and [planning.js:4077](src/webview/planning.js#L4077).
2. The `sbContentDims` handler calls `fitToContainer(...)` on *every* natural-dimension report (which fires on load AND on every ResizeObserver tick), so it re-fits even when we would otherwise want to preserve the user's view. See [design.js:3684](src/webview/design.js#L3684), [design.js:3695](src/webview/design.js#L3695), and [planning.js:5399](src/webview/planning.js#L5399).

The `isAutoRefreshed` flag is already available on the message (`handlePreviewReady` destructures it), so the webview *can* tell "same file re-rendered on save" apart from "user selected a new file" — it just doesn't use that signal to gate the zoom reset.

**Desired behaviour:** When a preview is auto-refreshed (same file, saved again), keep the current `scale`/`panX`/`panY`. When the user selects a *different* file (fresh, non-auto-refresh load), reset/fit as today. Zoom is only ever discarded on an explicit new-file load, never on a background re-render.

## Metadata
- **Complexity:** 5
- **Tags:** frontend, ui, ux, bugfix

## User Review Required

- **Stitch HTML tab parity:** the plan mirrors the same `isAutoRefreshed` guard onto the `stitchHtml` tab for consistency. Confirm Stitch actually sends `isAutoRefreshed` on its preview-ready message before mirroring (the design.js Stitch branch at L1478 should be checked — if it doesn't destructure `isAutoRefreshed`, the guard is a no-op and should be skipped or the provider fixed first).
- **`_fitPending` flag naming/placement:** the one-shot flag is added at the top of the zoom engine module scope. Confirm the naming convention is acceptable (leading underscore matches existing `_htmlContentDims` / `_panToggle` style).

## Complexity Audit (Routine vs Complex/Risky)

**Classification: Complex/Risky (low-to-mid).** The change itself is small, but it lives in a two-message dance (preview-ready → content-dims) that also feeds the initial-fit behaviour, so a naive guard can regress the first-load fit or leave a collapsed canvas. Risk areas:
- The `sbContentDims` handler *also* resizes the viewport (`vp.style.width/height`) — that MUST keep running on auto-refresh (the page's natural dims can change between saves). Only the `fitToContainer` call should be gated, not the viewport sizing.
- The fit-on-load must still fire exactly once for a genuinely new file, or the canvas collapses to near-zero (there is explicit code and comments guarding against this).
- The identical logic is duplicated in two webviews and must stay in parity.

## Edge-Case & Dependency Audit

- **New file vs auto-refresh of same file:** Gate on `isAutoRefreshed`. On a NEW file, `resetZoom` + first-fit as today. On auto-refresh, preserve scale/pan and skip the auto-fit.
- **Same file, natural dimensions changed between saves:** Still update `vp.style.width/height` from `sbContentDims` so pan-clamping stays correct, but re-clamp the *preserved* pan (call `clampPan` / `applyZoom`) instead of `fitToContainer` so the user's zoom survives while the canvas can't be panned out of view.
- **First load timing:** `fitToContainer` currently fires from `sbContentDims` on every report. Introduce a one-shot "fit pending" flag set true only on a fresh (non-auto-refresh) load and cleared after the first successful fit, so ResizeObserver ticks don't re-fit.
- **Two containers per tab (visible/hidden):** existing `panSource` guard is untouched; preserving state does not change which container is active.
- **Duplicated engine — apply in BOTH webviews:** design.js/design.html AND planning.js/planning.html. The Stitch HTML tab (`stitchHtml`) in design.js shares the same pattern; apply the same guard there for consistency ([design.js:1478](src/webview/design.js#L1478), [design.js:3695](src/webview/design.js#L3695)).
- **No backend change:** `isAutoRefreshed` is already sent by `DesignPanelProvider`/`PlanningPanelProvider`; no provider edits needed.

## Dependencies

- **Sibling — `feature_plan_20260720095402_html-preview-initial-fit-to-width.md` (fit-to-width):** the `_fitPending` one-shot fit must call `fitToContainer('html', wrapper, vp, 5, 'width')` (not the default `'contain'`) so a fresh load opens at readable width, not whole-page-fit. Land fit-to-width first; this plan's gated fit call inherits the `mode` param.
- No cross-feature dependencies. No backend/provider changes required.

## Adversarial Synthesis

**Key risks:** (1) `_fitPending` set on a fresh load but never consumed (iframe load failure / CSP hang) could cause a deferred fit on a later auto-refresh, silently discarding the user's zoom — mitigated by overwriting the flag on every fresh load and clearing it on first fit. (2) Preserved pan may be out of bounds under new content dims — mitigated by re-clamping via `clampPan` + `applyZoom` (which reposition, not just clip). (3) The two-message dance (preview-ready → sbContentDims) is duplicated across two webviews + Stitch; parity drift is a real risk — mitigated by applying the identical guard to all three iframe tabs in one pass. **Mitigations:** belt-and-braces clear `_fitPending` on any new-file load; verify `clampPan` writes back to `zoomState` (it does — design.js:261).

## Proposed Changes

### `src/webview/design.js`
Introduce a per-tab "fit pending" one-shot and gate reset/fit on `isAutoRefreshed`.

At the top of the zoom engine (near [design.js:212](src/webview/design.js#L212)):
```js
// One-shot: fit only on a fresh file load, never on auto-refresh or
// ResizeObserver re-reports. Keeps the user's manual zoom across saves.
const _fitPending = { html: false, stitchHtml: false, images: false, design: false };
```

In `handlePreviewReady`, the `html-folder` branch — replace the unconditional reset ([design.js:1408](src/webview/design.js#L1408)):
```js
if (!isAutoRefreshed) {
    resetZoom('html');
    _fitPending.html = true;   // fresh file → fit once when dims arrive
}
// on auto-refresh: keep zoomState.html as-is; do NOT set _fitPending
_htmlContentDims = null;
```
Apply the same pattern to the `stitch-html-folder` branch ([design.js:1478](src/webview/design.js#L1478), key `stitchHtml`).

In the `sbContentDims` handler ([design.js:3675](src/webview/design.js#L3675)) — always size the viewport, but only fit when pending, else re-clamp preserved pan:
```js
vp.style.width = w + 'px';
vp.style.height = h + 'px';
_htmlContentDims = { w, h };
if (_fitPending.html) {
    fitToContainer('html', wrapper, vp);
    _fitPending.html = false;
} else {
    // preserve the user's zoom; just keep it in-bounds for the new dims
    clampPan('html', wrapper.getBoundingClientRect(), w, h);
    applyZoom('html', vp);
}
```
Mirror this for the stitch branch ([design.js:3686](src/webview/design.js#L3686), key `stitchHtml`).

### `src/webview/planning.js`
Same treatment for the `planningHtml` tab:
- Add `_fitPending.planningHtml` one-shot.
- Gate `resetZoom('planningHtml')` at [planning.js:4077](src/webview/planning.js#L4077) on `!isAutoRefreshed` and set `_fitPending.planningHtml = true` there.
- In the one-shot `load` fallback ([planning.js:4118-4128](src/webview/planning.js#L4118-L4128)) only call `fitToContainer` when `_fitPending.planningHtml` is set.
- In the `sbContentDims` handler ([planning.js:5399](src/webview/planning.js#L5399)) replace the unconditional `fitToContainer('planningHtml', ...)` with the same pending-else-clamp branch shown above.

## Verification Plan

1. **Build/reload** the extension (recompile webview bundle, reload the VS Code window).
2. **Design → HTML Previews:** open an HTML file, zoom in to ~200% and pan to a corner. Edit and save the source file so it auto-refreshes. **Expect:** the preview stays at ~200% and the same pan position; no snap-back to fit.
3. **New-file switch still resets:** select a *different* HTML file in the sidebar. **Expect:** it opens at the default fit (not carrying the previous file's 200%).
4. **Dimension change on save:** add a tall section to the file and save. **Expect:** zoom preserved; the page cannot be panned off-canvas (clamp still holds — scroll to the far edge and confirm no empty gutter).
5. **Repeat 2–4 in Planning → HTML preview** and **Design → Stitch HTML** tab.
6. **Regression:** confirm first load of a brand-new file still fits correctly and never shows a collapsed/near-zero canvas across several rapid file switches.

## Review Findings

Reviewed against plan: PASS, no code changes. `_fitPending` one-shot gates the fresh-load fit; auto-refresh preserves `zoomState` (resetZoom skipped) while still sizing the viewport and re-clamping preserved pan via the `else` branch (design.js:3762, planning.js:5461) — the "viewport must keep sizing on refresh" risk is respected. Gate applied in parity across html/stitchHtml/planningHtml. Planning has two `_fitPending.planningHtml` consumers (iframe `load` at 4162 + `sbContentDims` at 5456); the one-shot flag makes them mutually exclusive — no double-fit (loser runs an idempotent clampPan). Remaining risk: none material. Verification: static trace only (compile/tests skipped per dispatch).

Review pass complete: no fixes required for this subtask. Files changed by this subtask: none. This edit signals kanban completion.
