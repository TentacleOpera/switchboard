# Claudify Theme Rendering

**Complexity:** 6

## Goal

Make the Claudify theme render with solid opaque panels and a dark immersive ground surface instead of the current washed-out light grey with see-through panels. Today the setup panel background boxes draw the grid directly on the panel surface with no opaque fill, so they read as transparent cut-outs showing the body grid through them; the body ground colour (#1C1C1C) is too light a grey, making the webview read as washed-out rather than dark; and theme changes do not propagate to already-open webviews reliably because the broadcast only reaches 3 of 5 panels and the rest depend on an async config event that can be silently dropped. Together these three plans make the Claudify panel surfaces opaque solid dark, darken the body ground to a dark grey, and unify theme broadcast to reach every open panel directly.

## How the Subtasks Achieve This

- **Fix: Claudify theme — setup panel background boxes are transparent instead of black**: Replaces the claudify `.shared-tab-content` background in `setup.html` with an opaque solid dark fill (`var(--panel-bg)` = `#000000`), removing the grid image from the panel surface so the panel reads as a distinct solid box over the gridded body. The grid stays on the body only.
- **Fix: Claudify theme — webview background behind the grid is too light**: Replaces every claudify ground `background-color: #1C1C1C` with `#0a0a0a` (dark grey) across `setup.html`, `design.html`, and any other webview with a claudify ground occurrence. The darker ground increases grid-line contrast and reads as a dark immersive surface.
- **Fix: Theme changes do not apply to already-open webviews (split theme on Design)**: Extends `broadcastToWebviews` in `TaskViewerProvider.ts` to include `DesignPanelProvider` and `PlanningPanelProvider` via late-bound setters, so theme changes (name + all checkbox toggles) reach every open panel directly via postMessage instead of relying on the async `onDidChangeConfiguration` event that can be silently dropped. The existing config listeners are kept for out-of-band config changes.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix: Theme changes do not apply to already-open webviews (split theme on Design)](../plans/feature_plan_20260707124454_theme-not-applied-to-open-webviews.md) — **PLAN REVIEWED**
- [ ] [Fix: Claudify theme — setup panel background boxes are transparent instead of black](../plans/feature_plan_20260707124454_claudify-setup-panel-transparent-background.md) — **PLAN REVIEWED**
- [ ] [Fix: Claudify theme — webview background behind the grid is too light](../plans/feature_plan_20260707124454_claudify-webview-background-too-light.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

The two CSS plans (setup panel opacity + body ground colour) are independent — they edit different selectors in `setup.html` and `design.html`. The panel plan sets `.shared-tab-content` to solid `#000000`; the ground plan sets `body.theme-claudify` to dark grey `#0a0a0a`. Coordinate so both edits to `setup.html` land cleanly. The theme-broadcast plan edits TypeScript (`TaskViewerProvider.ts`, `DesignPanelProvider.ts`, `PlanningPanelProvider.ts`) and is fully independent of the CSS plans. All three can be executed in parallel. The theme-broadcast fix is most visible when the CSS fixes are also present (a correctly-broadcast theme that renders washed-out panels is still a broken experience).
