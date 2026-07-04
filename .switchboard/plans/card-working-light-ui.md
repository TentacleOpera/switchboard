# Card working-light UI

## Goal

Render the per-card activity light on the kanban board: a small indicator on each card that is
lit while `working` is true (agent dispatched, not yet complete, within the timeout) and absent
otherwise. This is the only user-visible piece of the *Agent activity lights* epic.

### Core problem & root cause

Cards currently show only complexity and epic-subtask-count. `createCardHtml`
(`src/webview/kanban.html:5416`) renders `card-topic` (`5486`), `card-meta` (`5487`), and
`card-actions` (`5488-5499`); the `epicBadge` slot is an empty string (`5472`), and card-level
status indicators were deliberately removed to reduce clutter (`5424-5426`). So the `working`
flag produced by the backend subtasks has no on-screen surface until this subtask adds one.

## Metadata

- **Project:** switchboard
- **Tags:** UI, frontend, kanban, webview
- **Complexity:** 4

## Implementation

1. **Consume the flag.** `working` arrives on the card object (added in
   `working-state-model-and-dispatch-on.md`; already threaded into card builders and the
   re-render signature at `kanban.html:4575`). No new message wiring needed here.

2. **Render the light.** In `createCardHtml` (`kanban.html:5416`), add a status dot in the
   `card-topic` slot (reuse the now-empty `epicBadge` position at `5486`) or in the right-hand
   action group (`5493`). Precedent for a dot indicator already exists — worktree status dots
   render `<span style="color:#00ad9f;">●</span>` at `kanban.html:6345-6349`. Prefer a CSS class
   (`.card-status-light.is-on`) over inline styles so the pulse/theme lives in the stylesheet.
   Example: `${card.working ? '<span class="card-status-light is-on" title="Agent working…">●</span>' : ''}`.

3. **Styling.** Add `.card-status-light` styles near the existing card badge styles (e.g. the
   `.complexity-indicator` block at `kanban.html:938-949` or `.card-done-badge` at `895`). A
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
  (`kanban.html:4575`) — that is handled in `working-state-model-and-dispatch-on.md`, but verify
  it during integration or the light will appear stuck at its first-render value.
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
