# Browser Terminal Responsiveness Under Load

**Complexity:** 7

## Goal

Fix the browser PTY terminal fleet lag at its four independent sources: output has no end-to-end flow control (backpressure is measured on the server socket, which never fills over loopback, so the pty is never paused while the browser queues seconds of backlog); terminals removed from a pane are never torn down, so the page parses every terminal it has ever shown and leaks WebGL contexts; every panel iframe receives every WS push including the full kanban board, on a single shared main thread; and the input path base64-encodes pastes byte-by-byte then writes them to the pty unbounded, head-of-line blocking every keystroke behind them.

Land the flow-control plan first — it is the keystone and the other three are cheaper and safer on top of it. The other three are mutually independent.

## How the Subtasks Achieve This

- **Terminal Output Flow Control: Ack-Based Backpressure and Page-Level Batching**: Replaces server-socket backpressure (unreachable over loopback) with a VS Code-style char-credit ack protocol, so the pty pauses when the renderer falls behind rather than never; collapses per-terminal flush timers and rAFs into one page-level drain on both ends. This is the keystone — it bounds the queue depth the other three plans assume.
- **Terminal View Lifecycle: Dispose Views That Leave a Pane**: Adds grace-period disposal for unassigned terminals (socket, xterm instance, WebGL context), bounds live WebGL contexts below the browser cap, and makes client scrollback explicit — so a detached terminal stops consuming parse, sockets, and GPU memory indefinitely.
- **Scope WS Pushes to the Panels That Asked For Them**: Filters `wsHub.broadcast` by a per-connection surface subscription and scopes the connect-time resync the same way, so the Terminals panel no longer parses the full kanban board and panels stop receiving each other's traffic on the shared main thread.
- **Terminal Input Path: Binary Frames and Paced PTY Writes**: Replaces the char-by-char base64 + JSON input encoding with binary frames, and paces pty writes through a per-terminal FIFO with UTF-8/escape-safe chunk boundaries, so a large paste can no longer head-of-line-block the keystrokes typed after it.

## Dependencies & sequencing

- **Cross-feature dependencies:** none. All four subtasks are confined to the browser-cockpit terminal/transport path (`terminalWsGateway.ts`, `terminals.js`, `wsHub.ts`, `transport.js`, `bootstrap.ts`) and require nothing from other features.
- **Shipping order within this feature:** land **Terminal Output Flow Control first** — the input plan's echo storm is only survivable on a paced output path, and its message-handler edits apply more easily on top of the ack branch. **Terminal Input Path** lands second, after flow control (shared `ws.on('message')` handler and `terminals.js`; it also extends the `window.__sbTerminalStats` debug object flow control introduces). **Terminal View Lifecycle** can land in parallel with either — whichever of it and flow control lands second must reconcile the shared `flushBatch` / `destroyTerminalView` guards (disposed-entry guard plus page-level drain set). **Scope WS Pushes** touches different files entirely and can land at any point, in parallel with all three.
- **Prerequisites / guards:** flow control's connect-time replay frame must be excluded from credit accounting and credit must reset on attach, or terminals pause permanently; lifecycle's `entry.exited`-before-socket-close ordering must be preserved or disposed views resurrect via reconnect; ws-push must fail open (a connection declaring no surfaces receives everything) to keep released clients working; the input server must keep the legacy base64 JSON branch for stale tabs.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Terminal Output Flow Control: Ack-Based Backpressure and Page-Level Batching](../plans/terminal-output-flow-control.md) — **CODE REVIEWED**
- [ ] [Terminal View Lifecycle: Dispose Views That Leave a Pane](../plans/terminal-view-lifecycle-teardown.md) — **CODE REVIEWED**
- [ ] [Scope WS Pushes to the Panels That Asked For Them](../plans/panel-surface-scoped-ws-push.md) — **CODE REVIEWED**
- [ ] [Terminal Input Path: Binary Frames and Paced PTY Writes](../plans/terminal-input-paste-path.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

