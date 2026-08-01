# Browser Terminal Responsiveness Under Load

**Complexity:** 7

## Goal

Fix the browser PTY terminal fleet lag at its four independent sources: output has no end-to-end flow control (backpressure is measured on the server socket, which never fills over loopback, so the pty is never paused while the browser queues seconds of backlog); terminals removed from a pane are never torn down, so the page parses every terminal it has ever shown and leaks WebGL contexts; every panel iframe receives every WS push including the full kanban board, on a single shared main thread; and the input path base64-encodes pastes byte-by-byte then writes them to the pty unbounded, head-of-line blocking every keystroke behind them.

Land the flow-control plan first — it is the keystone and the other three are cheaper and safer on top of it. The other three are mutually independent.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Terminal Output Flow Control: Ack-Based Backpressure and Page-Level Batching](../plans/terminal-output-flow-control.md) — **PLAN REVIEWED**
- [ ] [Terminal View Lifecycle: Dispose Views That Leave a Pane](../plans/terminal-view-lifecycle-teardown.md) — **PLAN REVIEWED**
- [ ] [Scope WS Pushes to the Panels That Asked For Them](../plans/panel-surface-scoped-ws-push.md) — **PLAN REVIEWED**
- [ ] [Terminal Input Path: Binary Frames and Paced PTY Writes](../plans/terminal-input-paste-path.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

