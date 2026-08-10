# Terminal Stream Fidelity - Only Real PTY Bytes Reach the Buffer

**Complexity:** 6

## Goal

A terminal screen buffer must contain exactly what the pty produced, in order, with nothing spliced in and nothing silently missing. Two independent violations exist today: the client injects four connection notices straight into the xterm buffer, permanently desynchronising any Ink-based TUI relative-cursor redraw; and the gateway scrollback replay hands a reconnecting client whatever survived ring eviction as though it were contiguous, sometimes starting mid-escape-sequence. Both produce damage that is buffer content rather than a paint artifact, so neither self-heals.

## How the Subtasks Achieve This

- **Four Client Notices Are Written Into the Terminal Buffer**: moves the queue-drained, pasting, unavailable and reconnecting notices out of the xterm buffer and onto the pane chrome that already exists for them.
- **Scrollback Replay Splices Silently Over Evicted Output**: detects that the ring evicted output the client never received, signals it so the client can start from a clean screen, and never emits a payload beginning mid-escape-sequence.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Four Client Notices Are Written Into the Terminal Buffer, Corrupting Any TUI's Screen Model](../plans/feature_plan_20260807130000_terminal-chrome-writes-corrupt-tui-buffer.md) — **PLAN REVIEWED**
- [ ] [Scrollback Replay Splices Silently Over Evicted Output and Can Start Mid-Escape-Sequence](../plans/feature_plan_20260807130001_gateway-replay-gap-and-unsafe-parse-start.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks can be executed in parallel. The first is client-side (`src/webview/terminals.js`), the second server-side (`src/standalone/terminalWsGateway.ts`).

⚠ **File contention:** the client-side subtask edits `terminals.js`, shared with *Multi-Window Cockpit Reliability*, *Creating Terminals From the Cockpit*, *Shell Rail Terminal Buttons* and *Seat to Plan Attribution*. The project PRD allows one agent stream per file — these must not be coded concurrently.
