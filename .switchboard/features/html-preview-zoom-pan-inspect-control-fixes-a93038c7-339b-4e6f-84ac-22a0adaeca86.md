# HTML Preview Zoom/Pan/Inspect Control Fixes

**Complexity:** 7

## Goal

Fixes for the HTML preview zoom/pan/inspect controls in the Design and Planning webviews: preserve zoom across auto-refresh, open fit-to-width instead of fully zoomed out, fix the Reset button to recenter predictably, allow scroll navigation without Pan mode, and make Inspect Mode and Pan work together. Shared engine lives in design.js/design.html, planning.js/planning.html, and the injected _INSPECTOR_SCRIPT in DesignPanelProvider.ts.

## How the Subtasks Achieve This

- **Open HTML previews fit-to-width, not fully zoomed out**: Adds a `mode` param to `fitToContainer` (`'contain'` default for images, `'width'` for iframe tabs) so HTML previews open at readable width anchored at the top instead of shrunk to fit the whole vertical page. Foundational — defines the fit API the other subtasks build on.
- **Preserve HTML preview zoom/pan across file auto-refresh**: Gates `resetZoom` and the auto-fit on `isAutoRefreshed` via a per-tab `_fitPending` one-shot flag, so saving a file preserves the user's manual zoom/pan while a fresh file load still fits. The one-shot fit inherits the fit-to-width `mode` param.
- **Fix the "Reset zoom" (⟲) toolbar button so it recenters predictably**: Rewrites the `reset` click branch to set scale=1, anchor `panY=0` (top for tall pages), center or left-pin `panX`, then `clampPan`. Clarifies the tooltip to "Reset view — 100% size". Independent of the others; keeps Reset distinct from Fit.
- **Let HTML previews scroll/navigate without turning on Pan mode**: Adds a wheel forwarder inside the shared `_INSPECTOR_SCRIPT` (used by both Design and Planning) that `postMessage`s `sbWheel` to the parent, plus a parent-side `applyWheelToTab` helper so plain scroll pans the canvas even with Pan mode off (iframe stays interactive for links/hover). Enables the inspect+pan coexistence plan.
- **Make Inspect Mode and Pan work together in HTML previews**: Adds a `body.inspect-active` class (toggled from `sbInspectState`, cleared on refresh) and a CSS rule `body.inspect-active .zoom-event-layer { display:none !important; }` so the opaque pan capture layer never covers the iframe while Inspect is on. Panning during inspect routes through the sibling wheel forwarder (wheel-only; Space-hold does not raise the overlay during inspect).

## Dependencies & sequencing

- **Cross-feature dependencies:** None. All five subtasks are internal to the HTML preview zoom/pan/inspect engine.
- **Shipping order within this feature:**
  1. **fit-to-width** (`..._initial-fit-to-width.md`) — foundational; defines the `mode` param on `fitToContainer` that the preserve-zoom plan's one-shot fit must call with `'width'`. Land first.
  2. **preserve zoom on refresh** (`..._preserve-html-preview-zoom-on-refresh.md`) — builds on the `mode` param; its gated `fitToContainer` call in `sbContentDims` composes with fit-to-width in the same code site. Land second.
  3. **reset button recenter** (`..._reset-zoom-button-recenter-and-clarify.md`) — independent, but landing after 1–2 keeps Reset's top-anchored semantic consistent with the new top-anchored default open. Can land in any order if needed. Land third.
  4. **scroll without Pan mode** (`..._scroll-navigation-without-pan-mode.md`) — adds the `_INSPECTOR_SCRIPT` wheel forwarder + parent `sbWheel` handler. Enables plan 5. Land fourth.
  5. **inspect + pan coexist** (`..._inspect-and-pan-coexist-html-preview.md`) — depends on plan 4's wheel forwarder for panning while the overlay is suppressed. Land last.
- **Prerequisites / guards:** All five subtasks touch `src/webview/design.js` and `src/webview/planning.js` (duplicated engine — keep parity). Plans 4 and 5 also touch the shared `_INSPECTOR_SCRIPT` in `src/services/DesignPanelProvider.ts` (one edit benefits both webviews). No backend/provider message changes required — `isAutoRefreshed`, `sbContentDims`, `sbInspectState`, and `sbSpacePan` already exist.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Preserve HTML preview zoom/pan across file auto-refresh](../plans/feature_plan_20260720095401_preserve-html-preview-zoom-on-refresh.md) — **CODE REVIEWED**
- [ ] [Open HTML previews fit-to-width, not fully zoomed out](../plans/feature_plan_20260720095402_html-preview-initial-fit-to-width.md) — **CODE REVIEWED**
- [ ] [Fix the "Reset zoom" (⟲) toolbar button so it recenters predictably](../plans/feature_plan_20260720095403_reset-zoom-button-recenter-and-clarify.md) — **CODE REVIEWED**
- [ ] [Let HTML previews scroll/navigate without turning on Pan mode](../plans/feature_plan_20260720095404_html-preview-scroll-navigation-without-pan-mode.md) — **CODE REVIEWED**
- [ ] [Make Inspect Mode and Pan work together in HTML previews](../plans/feature_plan_20260720095405_inspect-and-pan-coexist-html-preview.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Completion Summary

Implemented all five subtasks in dependency order (fit-to-width → preserve-zoom → reset-button → scroll-without-pan → inspect+pan-coexist) across the duplicated Design/Planning webview engine. Files changed: `src/webview/design.js`, `src/webview/planning.js` (fitToContainer `mode` param + width-fit call sites, `_fitPending` one-shot gate on `isAutoRefreshed`, reset-branch recenter rewrite, `applyWheelToTab` helper + `sbWheel` case, `inspect-active` body-class toggle/clear); `src/webview/design.html`, `src/webview/planning.html` (reset button tooltips → "Reset view — 100% size", `body.inspect-active .zoom-event-layer { display:none !important }` CSS rule); `src/services/DesignPanelProvider.ts` (shared `_INSPECTOR_SCRIPT` wheel forwarder posting `sbWheel` with `deltaMode`). No backend/provider message-protocol changes — `isAutoRefreshed`, `sbContentDims`, `sbInspectState`, `sbSpacePan` already existed. No issues encountered; skipped compilation/tests per dispatch instructions.

