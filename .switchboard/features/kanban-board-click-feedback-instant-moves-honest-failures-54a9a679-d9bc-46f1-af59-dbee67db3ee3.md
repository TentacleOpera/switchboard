# Kanban Board Click Feedback - Instant Moves, Honest Failures

**Complexity:** 6

## Goal

Make the board respond truthfully and immediately to a click. Today a card advanced from Planned via a copy-prompt button sits still until the backend DB write returns, and when that write fails the board shows five words of SQLite jargon that reads as your disk is full. Both defects live in the same file (src/webview/kanban.html) and on the same interaction, and they are coupled: one subtask introduces the failure channel the other subtask's advisory classifies.

## How the Subtasks Achieve This

- **Restore The Optimistic Card Move On Planned-Column Copy-Prompt Buttons**: Replaces the blanket `column !== 'PLAN REVIEWED'` suppression with a per-card predictor that mirrors the backend's complexity routing, moving whenever the prediction is exact *or* every visible coder lane renders into one container. Also adds the missing `moveCardsFailed` revert channel to the two prompt arms, without which an unconfirmed optimistic move strands a card permanently — `pendingOptimisticMoves` has no time-based eviction.
- **Kanban status bar: turn raw "disk I/O error" into an actionable recovery instruction**: Classifies the sql.js WASM-heap-exhaustion family at the one display funnel every producer passes through, appends the recovery step for the host the user is actually looking at, and beats the CSS animation and ellipsis clip that make the advisory invisible at 3 s.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Restore The Optimistic Card Move On Planned-Column Copy-Prompt Buttons](../plans/feature_plan_20260815115538_planned-column-copy-prompt-optimistic-move.md) — **PLAN REVIEWED**
- [ ] [Kanban status bar: turn raw "disk I/O error" into an actionable recovery instruction](../plans/feature_plan_20260816164107_kanban-status-bar-db-error-remediation-advice.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard blocker in either direction, but the two subtasks interact and **must not run in parallel**.

- **They edit the same file in the same regions.** Both change `src/webview/kanban.html` around `showStatusBarMessage` / `moveCardsOptimistically`, and both extend overlapping contract tests (`dispatch-view-contract.test.js`, `headless-feature-management-contract.test.js`). Whichever lands second re-runs the first's pins. One stream, sequential.
- **The coupling is real, not incidental.** The optimistic-move subtask adds `moveCardsFailed` posts to the two prompt arms, which routes more raw DB error text through `showStatusBarMessage` carrying a composed `1 plan(s) not advanced: …` prefix. The status-bar subtask's recogniser is deliberately *unanchored* for exactly this reason, and its composed-prefix test case covers it. Either order is therefore safe.
- Recommended order: optimistic move first (it creates the traffic), then the status-bar advisory (which can then be verified against a live failure path rather than a monkey-patched one).
