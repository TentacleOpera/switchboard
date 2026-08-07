# Terminal Kanban Mode Polish

**Complexity:** 5

## Goal

Polish the terminal kanban mode in terminals.html: show feature subtask counts on card rows, fix drag-and-drop prompt delivery to use the server-side ptySendPrompt pipeline (with /clear and auto-enter), and add a discoverability tooltip teaching users they can drag plan cards onto terminal panes.

## How the Subtasks Achieve This

- **Show Feature Subtask Count in Terminal Kanban Mode Card Rows**: Adds the "FEATURE: N SUBTASK(S)" label to feature card rows in the terminal kanban pane, matching the main kanban board's display. The `subtaskCount` field is already populated by the backend (`KanbanProvider._buildBoardCards`); the fix is purely in `terminals.js`'s `renderKanbanPane` row meta construction and the `bodySig` change-detection string.
- **Fix Terminal Kanban Drag-Drop to Use Server-Side Prompt Delivery (ptySendPrompt)**: Replaces the raw WebSocket `encodeInputFrame` send in the drop handler with a `/terminals/verb/ptySendPrompt` call, which delegates to the server-side `sendPromptToPty` pipeline. This brings `/clear` before prompt, bracketed-paste framing, chunked writes, and auto-Enter to the terminal kanban drag-drop — parity with the kanban board's `triggerAction` dispatch path. Shift-drop retains a raw paste (no Enter) for review-before-submit.
- **Add Drag-and-Drop Hint Tooltip to Terminal Kanban Mode Header**: Adds a `⤿` info glyph with a native `title` tooltip to the kanban pane header, teaching operators that plan cards can be dragged onto terminal panes. Also sets a `title` on the `.pane-header` element itself so hovering anywhere in the header reveals the instruction.

## Dependencies & sequencing

No hard ordering constraints; subtasks can be executed in parallel. The drag-drop fix (subtask 2) and the tooltip (subtask 3) are complementary — the tooltip teaches the feature that the fix makes work correctly. The subtask count display (subtask 1) is independent of both.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Show Feature Subtask Count in Terminal Kanban Mode Card Rows](../plans/feature_plan_20260806143801_subtask-count-in-terminal-kanban-mode.md) — **CODE REVIEWED**
- [ ] [Fix Terminal Kanban Drag-Drop to Use Server-Side Prompt Delivery (ptySendPrompt)](../plans/feature_plan_20260806143803_fix-kanban-drag-drop-prompt-delivery.md) — **CODE REVIEWED**
- [ ] [Add Drag-and-Drop Hint Tooltip to Terminal Kanban Mode Header](../plans/feature_plan_20260806143804_kanban-mode-drag-drop-hint-tooltip.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Completion Report

Implemented the three terminal kanban mode polish items: feature cards now show a purple `FEATURE: N SUBTASK(S)` label before the complexity badge, with `subtaskCount` added to the body signature so changes refresh; the drag-to-terminal drop now routes through `/terminals/verb/ptySendPrompt`, giving it the same `/clear`, bracketed-paste, chunked, auto-Enter pipeline as the board, while Shift-drop still pastes raw for review; and a `⤿` drag hint glyph with native title tooltips was added to the kanban pane header. Files changed: `src/webview/terminals.js`, `src/webview/terminals.html`, `src/standalone/bootstrap.ts`, and the feature plan. The only issue encountered was the standalone host's missing `ptySendPrompt` verb, which was added. Compilation and tests were skipped per session directives.

## Review Findings

Review pass completed across all 3 subtasks. One MAJOR fix applied: the extension host's `handlePtyVerb` (TaskViewerProvider.ts) proxied `ptySendPrompt` to the ptyHost child without injecting `clearBeforePrompt` config defaults, so under the extension host the drag-drop would not send `/clear` — a parity gap with the standalone host's `getPromptDeliveryOptions()`. Fixed by adding config injection (reads `vscode.workspace.getConfiguration` defaults when `clearBeforePrompt` is not explicitly passed). One NIT fix applied: stale `headerEl.title` tooltip persisted on `.pane-header` when switching back to terminal mode — added `headerEl.title = ''` in `updatePaneElement`. Verification: `tsc --noEmit` clean for plan-touched files (5 pre-existing TS2835 errors in unrelated files); `test:contract:pty-route-surface`, `test:contract:pty-host-gating`, `test:contract:pty-dispatch-focus`, `test:contract:browser-kanban-pane-order`, `test:contract:terminal-flow-control` all pass. Gate-wiring audit: `pty-route-surface-contract.test.js` is wired in CI via `npm run test:contract:pty-route-surface` in `.github/workflows/integration-tests.yml`. Remaining risk: manual drag-drop and visual verification not run (requires live browser cockpit with active CLI agents).
