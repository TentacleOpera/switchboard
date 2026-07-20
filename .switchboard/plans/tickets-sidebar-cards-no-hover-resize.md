# Tickets tab: stop sidebar cards resizing on hover

## Goal

Stop ticket sidebar cards from changing height as the mouse moves over them. The card action row (To kanban / Link / Move / Open) is collapsed to zero height at rest and expands on hover, so passively moving the cursor down the list makes every card grow and shrink — a jarring, constant layout shift. Make card height stable regardless of hover.

### Problem & root-cause analysis

`.card-actions` is collapsed at rest and revealed on hover/selection/focus ([src/webview/planning.html:2908-2928](src/webview/planning.html)):

```css
.ticket-node .card-actions {
    max-height: 0;
    opacity: 0;
    pointer-events: none;
    transition: max-height 0.15s ease, opacity 0.15s ease, margin-top 0.15s ease;
}
.ticket-node:hover .card-actions,
.ticket-node.selected .card-actions,
.ticket-node:focus-within .card-actions {
    max-height: 80px;
    margin-top: 4px;
    opacity: 1;
    pointer-events: auto;
}
```

Because the reveal is driven by `:hover` and animates `max-height` (0 → 80px) **plus** `margin-top` (0 → 4px), every card the cursor passes over grows by ~1 button-row + 4px and then collapses again when the cursor leaves. Scrolling or scanning the list produces continuous reflow. The original intent (comment at [:2905-2907](src/webview/planning.html)) was a "clean" list, but the cost is unstable card sizing the user finds worse than a slightly taller list.

## User Review Required

- Confirm the **dimmed-until-hover (opacity-only)** treatment: actions always occupy their space (no height change), rendered at reduced opacity (e.g. `0.55`) at rest and full opacity on hover/selection. Confirm the `0.55` rest opacity is acceptable (visible enough to know buttons are there, dim enough to read as "quiet").
- Confirm the always-on row's height is acceptable — cards will be ~1 button-row + 4px taller at rest than today.

## Metadata
**Tags:** frontend, ui, css
**Complexity:** 2

## Complexity Audit

### Routine
- Replacing the `.ticket-node .card-actions` reveal rules at [:2908-2928](src/webview/planning.html) with always-on geometry + opacity-only dim/brighten.
- Keeping the compact button sizing at [:2930-2935](src/webview/planning.html) (`height: 22px`, `font-size: 10px`) so the always-on row stays tight.
- CSS-only change — no JS, no backend.

### Complex / Risky
- **`pointer-events: auto` at rest is a behavior change.** Previously the buttons were `pointer-events: none` at rest (invisible, unclickable). With the always-on row at `opacity: 0.55`, the buttons are visible (dimmed) and clickable at rest. This is intended (the user can see and click them without hovering), but it means misclicks on the "quiet" row are now possible. At `0.55` opacity the buttons are clearly visible, so the risk is low — but verify the rest opacity is not so low that users click "invisible" buttons by accident.
- **`flex-wrap: wrap` on the action row at narrow sidebar widths.** `.ticket-node .card-actions` has `flex-wrap: wrap` ([:2912](src/webview/planning.html)). At narrow sidebar widths the 4-button row may wrap to 2 lines, making the always-on row ~2 button-rows tall. Card height is still *constant* (always 2 lines at that width), so the goal is met — but cards in a narrow sidebar will be taller than today's hovered cards. Pre-existing behavior (the hover-reveal also wrapped); not a regression. Flag for awareness.
- **Collapsed-sidebar behavior.** When the sidebar is collapsed to the narrow rail (`.content-row.collapsed #tree-pane-tickets`), cards still render in the rail. The always-on action row at rail width may wrap to many lines. Pre-existing (hover-reveal also wrapped). Not a regression, but verify the rail state still reads as a card and not a wall of buttons.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Pure CSS, no JS state.
- **Security:** None. CSS only.
- **Side Effects:** `:focus-within` no longer needs to drive visibility (the row is always visible), but focus styles should remain so keyboard users see which button is focused. The plan keeps `:focus-within` out of the visibility rules but does not remove focus outlines.
- **Dependencies & Conflicts:**
  - **Soft ordering:** lands after *Remove the Refine button from ticket cards* so the row has 4 buttons (To kanban / Link / Move / Open), not 5. Either order works.
  - **No file conflict** with the Refine-removal subtask — that touches `planning.js` (card renderers), this touches `planning.html` (CSS). Different files, different concerns.
  - No backend changes.

## Dependencies

- **Soft ordering:** land after *Remove the Refine button from ticket cards* so the row has 4 buttons. Either order works.
- No external session dependencies.

## Adversarial Synthesis

Key risks: (1) `pointer-events: auto` at rest makes dimmed buttons clickable — low risk at `0.55` opacity but verify the rest opacity reads as "visible but quiet," not "invisible"; (2) `flex-wrap: wrap` at narrow sidebar widths makes the always-on row taller (still constant height, but taller than today's hovered state). Mitigations: pick a rest opacity that is unambiguously visible (≥ 0.5); accept the narrow-sidebar wrap as pre-existing behavior (the hover-reveal also wrapped).

## Proposed Changes

### `src/webview/planning.html` (CSS)
- **Context:** `.ticket-node .card-actions` rules at [:2908-2935](src/webview/planning.html).
- **Logic:** Make the action row **always occupy its space** so card height is constant, using the dimmed-until-hover treatment (keeps the "quiet until you look" feel without any layout shift).
- **Implementation:**
  1. Set `.ticket-node .card-actions` to the revealed geometry permanently: `max-height: none; margin-top: 4px; pointer-events: auto;` and **drop the `max-height`/`margin-top` transitions**. The row's height must never depend on hover/selection.
  2. **Dim at rest, brighten on hover/selection — opacity only.** At rest render the row at reduced opacity (e.g. `opacity: 0.55`); on `.ticket-node:hover` / `.ticket-node.selected` set `opacity: 1`. Animate **only** `opacity` (and optionally color) — never `max-height`/`margin`. This replaces the old reveal rules at [:2921-2928](src/webview/planning.html).
  3. Keep the compact button sizing at [:2930-2935](src/webview/planning.html) (`height: 22px`, `font-size: 10px`) so the always-on row stays tight.
- **Edge Cases:** `flex-wrap: wrap` at narrow widths — see Complexity Audit. `:focus-within` no longer needed for visibility but focus outlines should remain.

### After the Refine-removal plan lands
- Note: after the Refine-removal plan lands there are 4 card buttons max (To kanban / Link / Move / Open), which fit on one row at sidebar width — so an always-on single row does not meaningfully lengthen cards.

## Verification Plan

### Automated Tests
- Skipped per session directive (no automated tests run).

### Manual Checks
- Hover-scan down a long ticket list: no card changes height; no reflow. Confirm in both themes (default + claudify).
- Selected card is visually distinct; actions remain clickable and keyboard-reachable (Tab still reaches the buttons — `:focus-within` no longer needed for visibility but focus styles should remain).
- Card height is identical whether hovered, selected, or at rest.
- At narrow sidebar widths (and collapsed-rail state), verify the always-on row does not make cards unreadable — pre-existing wrap behavior, not a regression.

## Decisions (confirmed)
- Use dimmed-until-hover (opacity-only): actions always occupy their space (no height change), rendered at reduced opacity at rest and full opacity on hover/selection.

## Routing
**Complexity 2 → Send to Intern.** Single-file CSS change, no JS, no backend. One behavior-change note (pointer-events at rest) that the dimmed opacity resolves.
