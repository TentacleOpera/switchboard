# Replace kanban card "agent working" status light with a pulsing border glow ring

## Metadata
**Plan ID:** 4949328E-09C3-43C0-8154-21A8F2EAFB15
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

- `createCardHtml()` in `src/webview/kanban.html` (defined at line 5661) builds
  `workingLight` (a `<span>●</span>`, lines 5722-5724) and interpolates it as the **first
  child** of `.card-topic` (the title line, line 5738).
- When `card.working` flips true/false between renders, the span is inserted/removed,
  shifting the title text right/left by ~ (dot width + 5px margin-right).
- The dot itself is the signal; the pulse is purely an opacity animation on the dot's
  color. Nothing about the signal requires it to live inside the title flow.

### Background / constraints

- The kanban card already uses `border: 1px solid` + `position: relative` + `border-radius: 3px`
  (`.kanban-card` base rule, lines 867-879 — no `overflow` is set on the card itself, so an
  absolutely-positioned `::after` with negative `inset` renders outside the card box).
- Several states already mutate the card's border / box-shadow and must continue to work:
  - `.kanban-card:hover` → teal border-color + teal box-shadow bloom (lines 885-891).
  - `.kanban-card.selected` → teal border + teal box-shadow (inset + outer) (lines 1368-1372).
  - `.kanban-card.feature-card.selected` → purple variant of the above (lines 1375-1379).
  - `.kanban-card.completed` → green 3px left stripe (lines 898-901).
  - `.feature-card` → purple 4px left stripe + faint purple bg (lines 913-916).
  - `.kanban-card.dragging` → opacity 0.4 (lines 893-896).
- `prefers-reduced-motion: reduce` currently disables the dot pulse (lines 981-983); the
  replacement must preserve a reduced-motion fallback (static ring, no animation).
- `card.working` is the single source of truth, set by the backend (serialized into the
  card stream at line 4697); completed cards are never marked working (defensively gated on
  `!isCompleted` in the renderer anyway, line 5722).
- The amber hue (`#e0a800`) is the established "agent working" semantic and must be
  preserved so it stays distinct from green (done/clean) and teal (selected/hover).
- Scope is **kanban cards only**. `card-status-light` exists **only** in
  `src/webview/kanban.html` (verified by repo-wide grep of `src/webview/`). The other views
  use unrelated indicator systems that are NOT touched and NOT affected by removing
  `card-status-light`:
  - `planning.js` / `planning.html` use `.ticket-status-light` — a different class for
    ticket status colors (not an agent-working pulse).
  - `implementation.html` uses `.status-dot` + a `pulse-green` keyframe — a separate
    agent-status system for the implementation-pane activity list.
  - `sharedDefaults.js` / `sharedUtils.js` contain only a button click-flash "pulse" and
    the words "working tree" — no status-light, no agent-working indicator.

## User Review Required

Yes — this is a visual/UX change to a primary board affordance. Reviewer should confirm:
1. The amber ring's prominence on a board with several simultaneously-working cards is
   acceptable (the bloom radius/opacity are single-knob tunables if too busy).
2. Losing the `title="Agent working…"` tooltip on the old dot is acceptable IF the
   card-root `title` fallback (Change 2b, below) is deemed insufficient — otherwise the
   fallback preserves the text explanation.
3. The amber-over-teal coexistence on a hovered/selected working card reads correctly.

## Complexity Audit

### Routine
- Single-file change (`src/webview/kanban.html` only).
- CSS swap: delete one rule block, add one `::after` rule + one keyframe + one
  reduced-motion media query.
- One template-line edit (drop `${workingLight}`) and one class-derivation + append
  (`${workingClass}`) in `createCardHtml()`.
- Reuses patterns already proven in this file: `color-mix(in srgb, ...)` (already used at
  lines 886, 888, 1370, 1371, 1377, 1378), `::after` overlay, `prefers-reduced-motion`.
- No backend, no data model, no persistence, no breaking changes.

### Complex / Risky
- Transient overlap with `.card-completing` (line 1115) which sets `overflow: hidden` for
  0.4s — could clip the `inset: -2px` ring if a card were simultaneously working and
  completing. Steady-state gating (`!isCompleted`) makes this theoretical; documented, no
  code change. See Edge-Case & Dependency Audit.
- Soft bloom (`0 0 14px`) may clip slightly at column viewport edges where ancestor
  containers use `overflow: hidden` (body line 247, kanban scroll container line 2597).
  Low severity; the 2px ring (the actual signal) is never clipped. See Edge-Case & Dependency Audit.

## Edge-Case & Dependency Audit

- **Race Conditions:** `card.working` is backend-authored and re-rendered on each sync.
  Between syncs, a user may click "Complete" on a working card, adding `.card-completing`
  (a 0.4s CSS animation, line 1115) while the card still renders as `is-working` until the
  next sync flips `working` to false. During that ≤0.4s window `.card-completing`'s
  `overflow: hidden` would clip the `inset: -2px` ring. In practice `working` is gated on
  `!isCompleted` in the renderer (line 5722), and completion sets the COMPLETED column
  before the completing animation is queued, so the working class is already dropped by the
  time `.card-completing` paints. Net effect: a possible 1-frame clip, invisible to users.
  No code change required; documented for completeness.
- **Security:** None. Pure presentation; no user input, no eval, no injection surface.
  `escapeHtml`/`escapeAttr` usage on the card template is unchanged.
- **Side Effects:**
  - Title layout no longer shifts — the bug being fixed (positive).
  - The old `title="Agent working…"` tooltip on the dot is removed with the dot. Mitigated
    by Change 2b: a `title="Agent working…"` attribute is added to the card root when
    `is-working`, preserving the text/a11y fallback.
  - Ancestor `overflow: hidden` (body line 247, kanban container line 2597) clips the soft
    14px bloom for cards at the top/bottom/sides of a column's visible viewport. The
    directional hover bloom (`0 4px 12px`, line 888) already coexists with the same
    ancestors without complaint; the omnidirectional working bloom clips marginally more at
    top/sides. The 2px ring (the hard signal) is never clipped. Cosmetic only; bloom radius
    is a single-knob tunable.
- **Dependencies & Conflicts:**
  - `kanban-working-pulse` keyframe name is new and does not collide with the existing
    `card-status-light-pulse` (being deleted) or `implementation.html`'s `pulse-green`
    (separate file, separate system).
  - `.kanban-card.is-working` is a new class; no existing selector targets it.
  - `color-mix`, `inset` shorthand, and `::after` box-shadow are all already in active use
    in this file (see Complexity Audit) — no new browser-support surface.
  - `.kanban-card` base has no `overflow` declaration (verified lines 867-879), so the
    negative-`inset` `::after` renders outside the card box as intended.
  - z-index: the card is `position: relative` (creates a stacking context); the ring's
    `::after` `z-index: 1` paints above the card's normal-flow content within that context.
    On hover the card itself rises to `z-index: 50` (line 890), lifting the whole context
    (ring included) — no conflict.

## Dependencies

- None. No other plan or session must precede this; the change is self-contained in
  `src/webview/kanban.html`.

## Adversarial Synthesis

Key risks: (1) the plan as written named a non-existent function (`renderCard` vs the real
`createCardHtml`) — corrected; (2) the plan's "out of scope" list invented a shared
`card-status-light` surface that does not exist (the class is kanban.html-only) — corrected,
and the change is in fact more isolated than originally claimed; (3) the transient
`.card-completing` `overflow: hidden` overlap and the soft-bloom clipping at viewport edges
were undocumented — both low-severity and now logged. Mitigations: fix the function name,
correct the blast-radius prose, preserve the tooltip via a card-root `title` fallback, and
keep the reduced-motion static ring. No research required — every technical claim is proven
by existing code in the same file.

## Proposed Changes

### src/webview/kanban.html

- **Context:** The "agent working" signal on kanban cards is currently an inline `<span>●</span>`
  prepended into `.card-topic` (the title line) by `createCardHtml()`. Its insertion/removal
  on `card.working` toggles causes a horizontal title shift. Moving the signal to a
  border-anchored `::after` glow ring eliminates the layout shift and never fights the
  card's existing `border` / `box-shadow` state machine.

- **Logic:** Use a `::after` pseudo-element on the card for the glow ring, driven by a new
  `.kanban-card.is-working` class. A pseudo-element overlay is chosen over animating the
  card's own `box-shadow` because:
  - It never fights the `box-shadow` declarations on `:hover`, `.selected`, and
    `.feature-card.selected` — those continue to apply to the card itself, while the working
    ring lives on the overlay layer.
  - It never touches `border` / `border-left`, so the completed green stripe and feature
    purple stripe are untouched.
  - It has zero effect on inner layout (absolute, `inset: -2px`, `pointer-events: none`).
  - The card's `position: relative` (line 877) creates a stacking context, so the ring's
    `z-index: 1` paints above card content; the card's hover `z-index: 50` (line 890) lifts
    the whole context, ring included.

- **Implementation (all in `src/webview/kanban.html`):**

  1. **Remove the inline light markup.**
     - Delete the `workingLight` const (lines 5722-5724) and its `${workingLight}`
       interpolation inside the `.card-topic` template (line 5738).
     - The title line becomes
       `<div class="card-topic">${featureBadge}${escapeHtml(shortTopic)}</div>`
       (`featureBadge` is `''` at line 5718, so effectively just the escaped topic).

  2. **Add the `is-working` class to the card root.**
     - Derive `workingClass` once near the old `workingLight` spot:
       `const workingClass = (!isCompleted && card.working) ? ' is-working' : '';`
     - Append it to the existing `${completedClass}${featureClass}` interpolation on the
       `.kanban-card` div (line 5737):
       `<div class="kanban-card${completedClass}${featureClass}${workingClass}" ...>`.

  2b. **Preserve the tooltip / a11y fallback (Clarification — strictly implied by keeping
      the existing signal's text explanation).**
     - The old dot carried `title="Agent working…"`. To preserve that text fallback, add a
       `title` attribute to the card root when `is-working`. The card root currently has no
       `title` (line 5737), so there is nothing to clobber. Either inline a ternary on the
       root div (`${workingClass ? ' title="Agent working…"' : ''}`) or set it via the same
       `workingClass` derivation. This is a one-attribute change and keeps the signal
       explicable to hover/screen-reader users.

  3. **Remove the old `.card-status-light` CSS block** (lines 961-983), including the
     `@keyframes card-status-light-pulse` and its `prefers-reduced-motion` rule. (This block
     is the ONLY `card-status-light` usage in the repo — removing it has zero blast radius
     outside this file.)

  4. **Add the new working-ring CSS.**
     - `.kanban-card.is-working::after` — absolutely positioned overlay:
       `content: ""; position: absolute; inset: -2px; border-radius: 5px;`
       `pointer-events: none; z-index: 1;`
       `box-shadow: 0 0 0 2px #e0a800, 0 0 14px color-mix(in srgb, #e0a800 45%, transparent);`
       `animation: kanban-working-pulse 1.8s ease-in-out infinite;`
       - `inset: -2px` lets the 2px ring sit just outside the card edge so it doesn't
         visually clip the card's own 1px border or the left-stripe accents. (Requires the
         card to have no `overflow: hidden` — confirmed at lines 867-879.)
       - `border-radius` slightly larger than the card's 3px to match the expanded ring.
     - `@keyframes kanban-working-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }`
       (matches the previous 1.8s cadence and 0.45→0.4 trough).
     - `@media (prefers-reduced-motion: reduce) { .kanban-card.is-working::after { animation: none; } }`
       — keep a static ring so the signal is still visible without motion.

  5. **Coexistence notes (no extra code needed, just verified):**
     - Hover/selected: their `box-shadow` is on the card; the ring is on `::after`. Both
       render. The amber ring takes visual precedence around the perimeter while the teal
       hover/selected glow remains on the card body — acceptable, both signals are
       meaningful.
     - Completed: never `is-working` (gated), so no overlap.
     - Feature: purple left stripe on the card border is untouched; amber ring wraps the
       whole card on `::after`.
     - Dragging: card opacity 0.4 dims the ring proportionally — fine.
     - `.card-completing` (line 1115): sets `overflow: hidden` for 0.4s during the
       complete animation. A working card is already non-working by the time this paints
       (gated on `!isCompleted`); a ≤1-frame theoretical clip is invisible. No change.

- **Edge Cases:**
  - `.card-completing` transient overlap — documented above; no code change.
  - Bloom clipping at column viewport edges (ancestor `overflow: hidden`) — cosmetic; the
    2px ring is never clipped; bloom radius is tunable.
  - Tooltip fallback preserved via Change 2b.

## Verification Plan

### Automated Tests
- None. No automated test covers this CSS, and per session directives automated tests are
  skipped. The change is presentation-only in `src/`.

### Manual verification (in the VS Code webview)
1. Dispatch an agent to a card in a non-completed column → confirm the amber glow ring
   appears around the card and pulses; confirm the card title does NOT shift.
2. Let the agent finish / timeout → confirm the ring disappears with no title shift.
3. Hover a working card → confirm teal hover glow + amber ring coexist.
4. Select a working card → confirm teal selected glow + amber ring coexist.
5. Test a working feature card → confirm purple left stripe + amber ring coexist.
6. Toggle `prefers-reduced-motion` (OS setting) and reload → confirm ring is static, no
   pulsing.
7. Hover a working card → confirm the `title="Agent working…"` tooltip still appears (via
   Change 2b fallback).
8. Complete a working card → confirm no visible ring-clip glitch during the 0.4s
   `.card-completing` animation (expected: ring already gone).

### Build
- `npm run compile` is NOT required and is skipped per session directives. Per `CLAUDE.md`,
  dev/testing uses an installed VSIX and `dist/` is not the source of truth; the change is
  in `src/` and is picked up by the webview on next reload/rebuild of the installed VSIX.

## Out of scope

- The unrelated indicator systems in other views: `ticket-status-light` in
  `planning.js` / `planning.html` (ticket status colors), and `status-dot` + `pulse-green`
  in `implementation.html` (implementation-pane agent status). These are separate systems
  and are not affected by this change (there is no shared `card-status-light` surface).
- Re-tuning the bloom intensity/radius for very full boards (single-knob if requested
  later).
- Suppressing the ring under `.card-completing` (theoretical 1-frame clip; not worth the
  extra selector).

## Recommendation

Complexity 2 (Routine). **Send to Intern.**

**Stage Complete:** PLAN REVIEWED

## Review Findings

Files changed: `src/webview/kanban.html` only — old `.card-status-light`/`is-on` block and `card-status-light-pulse` keyframe removed; new `.kanban-card.is-working::after` ring + `kanban-working-pulse` keyframe + reduced-motion fallback added; `createCardHtml()` swaps the inline `${workingLight}` span for a `${workingClass}`/`${workingTitle}` on the card root. Implementation matches the plan spec exactly (values: `inset:-2px`, `border-radius:5px`, `box-shadow 0 0 0 2px #e0a800, 0 0 14px …`, 1.8s pulse, `#e0a800` amber preserved). Validation (compile/tests skipped per directives): repo-wide orphan sweep confirms zero remaining refs to `card-status-light`, `card-status-light-pulse`, `workingLight`, or `.is-on`; single card renderer confirmed; regression trace shows `buildBoardSignature`, the optimistic-move guard, and finish-feedback all key off `card.working` at the data level and are unaffected by the render-only change. No CRITICAL/MAJOR findings; no code fixes required. Remaining risks are the two the plan already deferred as out-of-scope: the 14px bloom can bleed ~6px onto the adjacent card and can be clipped for ≤0.4s if a working card is optimistically completed (`.card-completing` sets `overflow:hidden`) — both cosmetic, invisible during the shrink/fade, single-knob tunable.
