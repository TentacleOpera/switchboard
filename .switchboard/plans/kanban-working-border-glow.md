# Replace kanban card "agent working" status light with a pulsing border glow ring

## Metadata
**Complexity:** 2
**Tags:** frontend, ui, refactor, bugfix
**Project:** switchboard

## Goal

Replace the inline pulsing dot (`<span class="card-status-light is-on">●</span>`) that is
prepended into a kanban card's title while an agent is dispatched, with a pulsing amber
glow ring drawn **around the card border**. The dot currently causes a horizontal layout
shift of the card title when it appears/disappears, which is jarring. A border-anchored
animation has zero impact on inner layout.

### Problem & root cause

- `renderCard()` in `src/webview/kanban.html` builds `workingLight` (a `<span>●</span>`)
  and interpolates it as the **first child** of `.card-topic` (the title line).
- When `card.working` flips true/false between renders, the span is inserted/removed,
  shifting the title text right/left by ~ (dot width + 5px margin-right).
- The dot itself is the signal; the pulse is purely an opacity animation on the dot's
  color. Nothing about the signal requires it to live inside the title flow.

### Background / constraints

- The kanban card already uses `border: 1px solid` + `position: relative` + `border-radius: 3px`.
- Several states already mutate the card's border / box-shadow and must continue to work:
  - `.kanban-card:hover` → teal border-color + teal box-shadow bloom.
  - `.kanban-card.selected` → teal border + teal box-shadow (inset + outer).
  - `.kanban-card.feature-card.selected` → purple variant of the above.
  - `.kanban-card.completed` → green 3px left stripe.
  - `.feature-card` → purple 4px left stripe + faint purple bg.
  - `.kanban-card.dragging` → opacity 0.4.
- `prefers-reduced-motion: reduce` currently disables the dot pulse; the replacement
  must preserve a reduced-motion fallback (static ring, no animation).
- `card.working` is the single source of truth, set by the backend; completed cards are
  never marked working (defensively gated on `!isCompleted` in the renderer anyway).
- The amber hue (`#e0a800`) is the established "agent working" semantic and must be
  preserved so it stays distinct from green (done/clean) and teal (selected/hover).
- Scope is **kanban cards only**. The `card-status-light` / pulse usages in
  `planning.js`, `planning.html`, `implementation.html`, `sharedDefaults.js`, and
  `sharedUtils.js` belong to other views and are NOT touched.

## Approach

Use a `::after` pseudo-element on the card for the glow ring, driven by a new
`.kanban-card.is-working` class. A pseudo-element overlay is chosen over animating the
card's own `box-shadow` because:

- It never fights the `box-shadow` declarations on `:hover`, `.selected`, and
  `.feature-card.selected` — those continue to apply to the card itself, while the
  working ring lives on the overlay layer.
- It never touches `border` / `border-left`, so the completed green stripe and feature
  purple stripe are untouched.
- It has zero effect on inner layout (absolute, inset:0, pointer-events:none).

### Changes (all in `src/webview/kanban.html`)

1. **Remove the inline light markup.**
   - Delete the `workingLight` const (lines ~5722-5724) and its `${workingLight}`
     interpolation inside the `.card-topic` template (line ~5738).
   - The title line becomes `<div class="card-topic">${featureBadge}${escapeHtml(shortTopic)}</div>`.

2. **Add the `is-working` class to the card root.**
   - In the `renderCard()` return template, add `is-working` to the card's class list
     when `!isCompleted && card.working`. Append it to the existing
     `${completedClass}${featureClass}` interpolation on the `.kanban-card` div
     (e.g. `${completedClass}${featureClass}${workingClass}` where `workingClass`
     is derived once near `workingLight`'s old spot, or inlined).

3. **Remove the old `.card-status-light` CSS block** (lines ~961-983), including the
   `@keyframes card-status-light-pulse` and its `prefers-reduced-motion` rule.

4. **Add the new working-ring CSS.**
   - `.kanban-card.is-working::after` — absolutely positioned overlay:
     `content: ""; position: absolute; inset: -2px; border-radius: 5px;`
     `pointer-events: none; z-index: 1;`
     `box-shadow: 0 0 0 2px #e0a800, 0 0 14px color-mix(in srgb, #e0a800 45%, transparent);`
     `animation: kanban-working-pulse 1.8s ease-in-out infinite;`
     - `inset: -2px` lets the 2px ring sit just outside the card edge so it doesn't
       visually clip the card's own 1px border or the left-stripe accents.
     - `border-radius` slightly larger than the card's 3px to match the expanded ring.
   - `@keyframes kanban-working-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }`
     (matches the previous 1.8s cadence and 0.45→0.4 trough).
   - `@media (prefers-reduced-motion: reduce) { .kanban-card.is-working::after { animation: none; } }`
     — keep a static ring so the signal is still visible without motion.

5. **Coexistence notes (no extra code needed, just verified):**
   - Hover/selected: their `box-shadow` is on the card; the ring is on `::after`. Both
     render. The amber ring takes visual precedence around the perimeter while the
     teal hover/selected glow remains on the card body — acceptable, both signals are
     meaningful.
   - Completed: never `is-working` (gated), so no overlap.
   - Feature: purple left stripe on the card border is untouched; amber ring wraps the
     whole card on `::after`.
   - Dragging: card opacity 0.4 dims the ring proportionally — fine.

## Risks / edge cases

- **Webview Chromium support:** `color-mix`, `inset` shorthand, and `::after`
  box-shadow are all supported in the VS Code webview (Chromium-based). No risk.
- **z-index stacking:** the `::after` ring uses `z-index: 1`; the card content is the
  card's normal flow. Hovered cards elevate to `z-index: 50` on the card itself, so a
  hovered working card's ring correctly rises with it. No conflict.
- **Tooltip on the old dot** (`title="Agent working…"`) is lost. Acceptable — the ring
  is the signal. If a tooltip is desired on the ring, it would need to move to the card
  root `title` attribute; out of scope unless requested.
- **Multiple lit cards on a full board:** the previous CSS comment noted the dot was
  "low-key so a board with several lit cards isn't visually overwhelming." A 2px amber
  ring + 14px bloom on every working card is more prominent than the dot. If it proves
  too busy, the bloom radius/opacity are single-knob tunables. Flagging for review.

## Verification

- No automated test covers this CSS. Manual verification in the VS Code webview:
  1. Dispatch an agent to a card in a non-completed column → confirm the amber glow
     ring appears around the card and pulses; confirm the card title does NOT shift.
  2. Let the agent finish / timeout → confirm the ring disappears with no title shift.
  3. Hover a working card → confirm teal hover glow + amber ring coexist.
  4. Select a working card → confirm teal selected glow + amber ring coexist.
  5. Test a working feature card → confirm purple left stripe + amber ring coexist.
  6. Toggle `prefers-reduced-motion` (OS setting) and reload → confirm ring is static,
     no pulsing.
- `npm run compile` is NOT required (dev/testing uses installed VSIX, `dist/` is not
  the source of truth per CLAUDE.md). The change is in `src/` and picked up by the
  webview on next reload/rebuild of the installed VSIX.

## Out of scope

- The `card-status-light` / pulse usages in the planning pane (`planning.html`,
  `planning.js`), implementation pane (`implementation.html`), `sharedDefaults.js`,
  and `sharedUtils.js`. These are separate views; the user's reported issue is specific
  to kanban cards.
- Adding a tooltip to the new ring.
- Re-tuning the bloom intensity for very full boards (single-knob if requested later).

**Stage Complete:** Created
