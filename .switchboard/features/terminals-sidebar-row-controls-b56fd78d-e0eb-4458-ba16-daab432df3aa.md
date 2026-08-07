# Terminals Sidebar Row Controls

**Complexity:** 4

## Goal

Rework the Terminals sidebar row's controls in one pass over renderTerminalRow: replace the non-interactive status dot with an inline close (x) button and delete the 'close' link, move rename behind an edit pencil beside the terminal name, and promote 'clear' from a near-invisible ghost link to a visible bordered button. Fixes an inverted hierarchy where a state pip owned the row's most reachable slot while the process-ending action was its least visible control.

The three defects share one root cause and one owner: `renderTerminalRow` (`src/webview/terminals.js:1039`) gives its prime slot — the right edge of a `justify-content: space-between` row — to a 7px status pip that is not clickable and is "active" on virtually every row, then files all three verbs into an action strip where one flat `.locate-btn` style (borderless, 10px, `opacity: 0.7`) flattens actions of wildly different frequency and consequence into identical near-invisible words. Ending a process, renaming a terminal, and resetting an agent's context all look the same and all look like nothing.

## How the Subtasks Achieve This

- **Rework the Terminals Sidebar Row Controls: Inline ×, Edit Pencil, and a Real Clear Button**: the whole feature, as one pass over `renderTerminalRow` and the matching CSS in `src/webview/terminals.html`. It (a) swaps the `.status-dot` for an `× .item-close-btn` in the same slot and deletes the `close` link from the strip; (b) wraps `.item-name` and a new inline-SVG pencil in an `.item-name-row`, points the pencil at the existing `beginInlineRename`, and deletes the `rename` link; (c) restyles `clear` as a bordered `.item-clear-btn` reusing the panel's existing `.btn-unassign-pane` language rather than inventing a third button style; and (d) re-encodes the exited state — which the deleted red dot was the sidebar's only carrier of — as a `(exited)` text suffix on the handle plus an `is-exited` dimming class, matching what the pane header already does.

**Merge record (improve-feature, 2026-08-07).** This feature originally held two subtasks — `…090300_terminals-sidebar-status-dot-becomes-close-button.md` (dot → ×) and `…090400_terminals-sidebar-rename-becomes-edit-icon-clear-becomes-button.md` (pencil + clear button). They were merged into the single plan above and deleted. Grounds: both rewrote the same function in the same two files with interleaved statements, so the PRD's "one agent stream per provider file" rule made them un-parallelisable; and each staked its own layout decisions on `.item-actions` ending up with exactly one button — an end state only true if the *other* plan also landed. Landing the pencil/clear plan alone would have put a bordered `clear` next to a ghost `close` link: two button languages in one strip, which is the exact incoherence this feature exists to remove. A single owner resolves `.item-actions`'s final form once. Both originals are preserved in git at commit `3ac5da5a`.

## Dependencies & sequencing

- **Cross-feature dependencies:** none. This feature owns `renderTerminalRow` and the `.item-*` CSS block outright; no other in-flight feature edits them. It is purely presentational — no verb, no payload field, no persisted state, no settings key, no schema change — so it has no ordering relationship to the verb-engine burndown or the standalone-bootstrap work.
- **Shipping order within this feature:** single subtask — no internal ordering. Within that plan the edits are numbered §1–§12 and must be applied top-to-bottom in `renderTerminalRow`, because earlier insertions shift the line references used by later ones.
- **Prerequisites and guards:**
  - `.locate-btn` and `.locate-btn.is-danger` must **survive** the change. This work removes their last row-level users, not their last users — `renderGroupSidebar` still uses both for the saved-group `switch`/`delete` buttons (`terminals.js:1221`, `1230`). Deleting either rule silently breaks the saved-groups view.
  - The `termNameEl.dataset.friendlyName` stamp (`terminals.js:1060`) must stay. Appending `(exited)` to `.item-name`'s text is safe only because the delegated dblclick rename handler reads the dataset and not `textContent` (`terminals.js:480-483`).
  - No confirm gate on the ×. Per project rule destructive buttons fire immediately, and `window.confirm()` is a silent no-op in a VS Code webview — a gate would make the button do literally nothing.
  - Verification is manual UAT against a running Terminals panel; this dispatch was scoped with SKIP COMPILATION and SKIP TESTS, so no build or automated-test step is part of the plan.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Rework the Terminals Sidebar Row Controls: Inline ×, Edit Pencil, and a Real Clear Button](../plans/feature_plan_20260807093000_terminals-sidebar-row-controls-rework.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

