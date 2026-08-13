# Memo modal geometry in the shell modal host

**Complexity:** 5

## Goal

The shell's modal host sizes and positions #modal-dialog without reference to the panel inside it, and both defects land on the Memo panel. The close button overlaps the workspace dropdown's last 12px, and the fixed 700px dialog height leaves ~190px of opaque dead space below the memo controls that swallows backdrop-dismiss clicks. Both are fixed in shell.html/shell.js/memo.html by making the corner reservation and the dialog height explicit contracts the panel can honour.

## How the Subtasks Achieve This

- **Memo Modal Close Button Overlaps The Workspace Dropdown**: Turns the dialog's top-right corner into a named, *derived* reservation — `#modal-dialog` gains `--modal-close-inset` / `--modal-close-size` tokens that `#modal-close` itself consumes, with `--modal-close-reserve` computed from them (42px), so the reserved width can never drift from the button it reserves for. `memo.html` mirrors the resolved value as `.memo-header { padding-right: 42px }`, moving the workspace `<select>` out from under a button that — being a sibling of the iframe — wins every hit test regardless of z-index. Two static CSS declarations; no new state, listener or message.
- **Memo Modal Is Oversized: Dead Space Below The Memo Swallows Backdrop-Dismiss Clicks**: Replaces the dialog's fixed `height: min(700px, 88%)` with `height: var(--modal-content-height, min(700px, 88%))` plus a floor and a cap, so a panel that reports nothing keeps today's exact behaviour. `memo.js` gains an rAF-coalesced `ResizeObserver` that posts its root-element box height to the shell; `shell.js` verifies the sender frame, clamps the value, stores it **per panel id**, and resolves it in `openModal` (adding back the dialog's own 1px border, measured). The dialog then ends where the memo ends, so the region the operator aims at for dismissal is genuinely `#modal-backdrop`.

## Dependencies & sequencing

- **Shipping order is fixed: close-button reservation first, dead-space sizing second.** Both subtasks edit the same rule — `#modal-dialog` in `src/webview/shell.html` (lines 165-177). The first adds the `--modal-close-*` tokens; the second changes the `height` lines and must **preserve** those tokens rather than replace the block. Its Proposed Changes carries them as annotated context for exactly this reason.
- **One agent stream, not two worktrees.** The project PRD's orchestration contract ("one agent stream per provider file; same-file parallel edits collide") applies directly: dispatching these in parallel guarantees a conflict on that block. Sequential in a single stream is the intended execution.
- **Neither subtask is a prerequisite for the other's *correctness*, only for its merge.** The reservation is inert with respect to height, and the height mechanism is inert with respect to the corner. If the order is reversed, the close-button subtask must *add* its tokens to whatever `#modal-dialog` block it finds instead of replacing it.
- **Guards that must hold in both:** no confirmation dialogs anywhere on the close path (`CLAUDE.md`); `shell.js` must remain free of native `title` assignments (asserted by `src/test/shell-modal-panel-contract.test.js` and `src/test/shell-terminal-strip.test.js:503`); `closeModal` must never destroy or reload the modal frame (same contract test) — the memo's live document, WebSocket and pending autosave depend on it.
- **Only `memo` is `presentation: 'modal'` today** (`src/services/headlessPanelHtml.ts:521`). Both fixes live in the generic modal host so the next modal panel inherits them; neither may assume memo is the only consumer.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Memo Modal Close Button Overlaps The Workspace Dropdown](../plans/feature_plan_20260812093100_memo-modal-close-button-overlaps-workspace-dropdown.md) — **PLAN REVIEWED**
- [ ] [Memo Modal Is Oversized: Dead Space Below The Memo Swallows Backdrop-Dismiss Clicks](../plans/feature_plan_20260812093400_memo-modal-content-sized-dialog-dead-space.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

