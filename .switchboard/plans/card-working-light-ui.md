# Card working-light UI

## Goal

Render the per-card activity light on the kanban board: a small indicator on each card that is
lit while `working` is true (agent dispatched, not yet complete, within the timeout) and absent
otherwise. This is the only user-visible piece of the *Agent activity lights* epic.

### Core problem & root cause

Cards currently show only complexity and epic-subtask-count. `createCardHtml`
(`src/webview/kanban.html:5570`) renders `card-topic` (`5640`), `card-meta` (`5641`), and
`card-actions` (`5642-5653`); the `featureBadge` slot is an empty string (`const featureBadge =
''` at `5626`), and card-level status indicators were deliberately removed to reduce clutter
(comment at `5578-5580`). So the `working` flag produced by the backend subtasks has no
on-screen surface until this subtask adds one.

## Metadata

- **Project:** Switchboard
- **Tags:** UI, frontend, kanban, webview
- **Complexity:** 4

## Implementation

1. **Consume the flag.** `working` arrives on the card object (added in
   `working-state-model-and-dispatch-on.md`; already threaded into card builders and the
   re-render signature in `buildBoardSignature` at `kanban.html:4607`). No new message wiring
   needed here.

2. **Render the light.** In `createCardHtml` (`kanban.html:5570`), add a status dot in the
   `card-topic` slot (reuse the now-empty `featureBadge` position at `5626`, which prepends
   `${featureBadge}` before the topic at `5640`) or in the right-hand action group (`5647`).
   Precedent for a dot indicator already exists — the worktree-status badge handler renders
   `<span style="color:#00ad9f;">●</span> clean` at `kanban.html:6495-6505` (`case
   'worktreeStatuses'`). Prefer a CSS class (`.card-status-light.is-on`) over inline styles so
   the pulse/theme lives in the stylesheet. Example:
   `${card.working ? '<span class="card-status-light is-on" title="Agent working…">●</span>' : ''}`.

3. **Styling.** Add `.card-status-light` styles near the existing card badge styles (e.g. the
   `.complexity-indicator` block at `kanban.html:948-959` or `.card-done-badge` at `905`). A
   subtle pulse animation reads as "live"; keep it low-key. Respect the CRT/afterburner themes
   already in the stylesheet — pick a color token consistent with them.

4. **Accessibility / clarity.** Include a `title` tooltip ("Agent working…"). Ensure the light
   is visually distinct from the green worktree/done indicators so users don't confuse "agent
   working" with "worktree active" or "done".

## User Review Required

- Confirm placement (leading dot in the topic row vs. in the action row).
- Confirm the visual: static dot vs. subtle pulse, and the color (must not clash with the green
  worktree/done dots).

## Complexity Audit

### Routine
- Adding a conditional `<span>` in `createCardHtml` (follows the existing badge pattern).
- Adding a CSS rule near the existing card badge styles.

### Complex / Risky
- **Re-render dependency.** The light only updates if `working` is in the board-diff signature
  (`buildBoardSignature` at `kanban.html:4607`) — that is handled in
  `working-state-model-and-dispatch-on.md`, but verify it during integration or the light will
  appear stuck at its first-render value.
- **Theme fit.** Card visuals must work across the CRT/afterburner themes; test the color in
  each rather than hardcoding a single hex.

## Edge-Case & Dependency Audit

- **Dependency:** requires the `working` flag + re-render signature change from
  `working-state-model-and-dispatch-on.md`. Purely a consumer — no backend changes here.
- **Completed/epic cards:** the backend already suppresses `working` for completed/inactive
  rows; the UI should render nothing in those cases (no empty gap).
- **Confirmation dialogs:** none — per repo rule, no confirm gates anywhere. This is display-only.
- **`window.confirm` note:** irrelevant here (display-only), but a reminder that VS Code webviews
  no-op modals — never add one.

## Dependencies

- Requires the `working` flag on `KanbanCard` AND the `buildBoardSignature` re-render change
  (both in `working-state-model-and-dispatch-on.md`, B-1). This subtask is a pure consumer —
  no backend changes here. If B-1's signature change is missing, the light renders once and
  never updates.

## Proposed Changes

### src/webview/kanban.html — createCardHtml (5570-5655)
- **Context:** builds each card's HTML; `featureBadge` (5626) is an empty slot prepended into
  `card-topic` (5640).
- **Logic:** emit the status dot when `card.working` is truthy, in the `card-topic` slot
  (before `${escapeHtml(shortTopic)}`) — reuses the empty `featureBadge` position. Use a CSS
  class, not inline color.
- **Edge cases:** render nothing (no empty gap) when `working` is falsy; completed/epic cards
  already have `working` suppressed by the backend.

### src/webview/kanban.html — stylesheet (near 905-959)
- **Context:** card badge styles (`.card-done-badge` at 905, `.complexity-indicator` at
  948-959) and the theme tokens.
- **Logic:** add `.card-status-light` (base) + `.card-status-light.is-on` (lit) + a subtle
  `@keyframes` pulse; pick a color distinct from the green worktree/done dots.
- **Edge cases:** must read acceptably across CRT/afterburner themes — use a theme token or
  test in each; keep the pulse low-key to avoid visual noise on a busy board.

## Adversarial Synthesis

Key risks: (1) the light is invisible without B-1's `buildBoardSignature` change (4607) — this
subtask must land after B-1 and the integration must verify the signature includes `working`;
(2) color collision with the existing green worktree/done dots (6495-6505, 5632) would make
"agent working" indistinguishable from "done" — pick a distinct hue (e.g. amber/blue) and test
in both themes; (3) a pulse animation on many simultaneously-working cards could be distracting
— keep it subtle, and prefer a static dot if the board typically has several lit at once.

## Verification Plan

> Per session directives: no automated tests, no compilation. Verify via the installed VSIX.

### Manual checks
- Dispatch a card (light ON) → confirm the dot appears on that card only.
- Trigger a marker/timeout clear → confirm the dot disappears and leaves no empty gap.
- Confirm the dot color is visually distinct from the green worktree "clean" dot and the
  `✓ Done` badge in both CRT and afterburner themes.
- Confirm completed and epic cards never show the dot.
- Confirm the `title="Agent working…"` tooltip appears on hover.
- Open a board with 3+ working cards → confirm the pulse is not visually overwhelming.

### Recommendation
Complexity 4 → **Send to Coder.**

## Review Findings

**Stage 1 (Grumpy Principal Engineer):** The pretty dot — the only thing the user ever
sees. If it's wrong, the whole feature is wrong. Show me.

- **PASS** — `workingLight` (kanban.html:5720-5722) renders `<span class="card-status-light is-on" title="Agent working…">●</span>` only when `!isCompleted && card.working`. Completed cards and non-working cards render nothing (no empty gap).
- **PASS** — Light placed in `card-topic` slot (5736): `${workingLight}${featureBadge}${escapeHtml(shortTopic)}` — leading dot before the topic, reusing the empty `featureBadge` position.
- **PASS** — `buildBoardSignature` (4697) includes `|${card.working ? '1' : '0'}` — the light re-renders on state change (B-1's signature change is present).
- **PASS** — CSS (965-983): `.card-status-light` base is `color: transparent` (invisible when off); `.is-on` is `#e0a800` (amber) with `card-status-light-pulse` animation (1.8s ease-in-out, opacity 1→0.45→1). `@media (prefers-reduced-motion: reduce)` disables the animation. Amber is distinct from green worktree/done dots.
- **PASS** — No `window.confirm()` or confirmation dialogs — display-only, per repo rule.
- **NIT** — The `title="Agent working…"` tooltip uses an ellipsis character (…) — consistent with the codebase's existing usage. No issue.
- **NIT** — The pulse animation on multiple simultaneously-working cards could be visually distracting on a busy board. The plan's adversarial synthesis flagged this; the 1.8s interval and 0.45 opacity floor keep it subtle. Acceptable.

**Stage 2 (Balanced):** No CRITICAL or MAJOR findings. The UI is a clean consumer of B-1's
`working` flag and signature change. The `!isCompleted` guard is a belt-and-suspenders defense
(the backend already suppresses `working` for completed cards). CSS is theme-safe (amber works
on both CRT and afterburner backgrounds). The `prefers-reduced-motion` support is a nice touch.

**Fix applied:** None — no valid CRITICAL/MAJOR findings.

**Validation:** No compilation/tests per session directives. Manual checks recommended: (1)
dispatch → dot appears on that card only; (2) marker/timeout clear → dot disappears, no gap;
(3) completed/epic cards never show the dot; (4) dot color distinct from green in both themes.

**Remaining risks:** (1) If B-1's `buildBoardSignature` change were missing, the light would
render once and never update — verified present, so no risk. (2) Pulse on many cards could
distract — mitigated by subtle animation parameters.

**Stage Complete:** CODE REVIEWED
