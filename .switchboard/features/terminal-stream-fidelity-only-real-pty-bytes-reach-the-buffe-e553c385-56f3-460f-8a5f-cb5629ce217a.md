# Terminal Stream Fidelity - Only Real PTY Bytes Reach the Buffer

**Complexity:** 6

## Goal

A terminal screen buffer must contain exactly what the pty produced, in order, with nothing spliced in and nothing silently missing. Two independent violations exist today: the client injects four connection notices straight into the xterm buffer, permanently desynchronising any Ink-based TUI relative-cursor redraw; and the gateway scrollback replay hands a reconnecting client whatever survived ring eviction as though it were contiguous, sometimes starting mid-escape-sequence. Both produce damage that is buffer content rather than a paint artifact, so neither self-heals.

## How the Subtasks Achieve This

- **Four Client Notices Are Written Into the Terminal Buffer**: moves the queue-drained, pasting, unavailable and reconnecting notices out of the xterm buffer and onto the pane chrome that already exists for them.
- **Scrollback Replay Splices Silently Over Evicted Output**: detects that the ring evicted output the client never received, signals it so the client can start from a clean screen, and never emits a payload beginning mid-escape-sequence.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Four Client Notices Are Written Into the Terminal Buffer, Corrupting Any TUI's Screen Model](../plans/feature_plan_20260807130000_terminal-chrome-writes-corrupt-tui-buffer.md) — **CODE REVIEWED** — ID: 5da4a27b-46e5-4aec-af74-cfd6575da188
- [ ] [Scrollback Replay Splices Silently Over Evicted Output and Can Start Mid-Escape-Sequence](../plans/feature_plan_20260807130001_gateway-replay-gap-and-unsafe-parse-start.md) — **CODE REVIEWED** — ID: 67accbdd-16fd-41fe-8f18-977eded6e1bc
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks can be executed in parallel. The first is client-side (`src/webview/terminals.js`), the second server-side (`src/standalone/terminalWsGateway.ts`).

⚠ **File contention:** the client-side subtask edits `terminals.js`, shared with *Multi-Window Cockpit Reliability*, *Creating Terminals From the Cockpit*, *Shell Rail Terminal Buttons* and *Seat to Plan Attribution*. The project PRD allows one agent stream per file — these must not be coded concurrently.

## Review Findings

Both subtasks reviewed together; the feature goal holds — the only client writes into a terminal buffer are now pty output, the replay, DEC-mode reassertion, the gap-path RIS reset, and the process-exit line. One material correctness fix: the gateway's replay trim also fired on a contiguous reconnect at the eviction boundary (`terminalWsGateway.ts:994`), where the client's parser is legitimately mid-sequence, so it would have deleted the continuation and eaten real output — it now additionally requires a provably cold parser (`lastSeq === 0 || replayGap`). Six wired CI gates were red at review start and are now green: four from stale assertions the plans wrongly claimed did not exist (`terminal-input-path` ×2, `terminal-solo-popout` ×2), and two from prohibition regexes matching their own explanatory comments (`terminal-replay-gap`, `terminal-answerback`); the chrome test's write-site count was also raised from 4 to 5 to admit the sibling subtask's RIS write. Full terminal contract suite green (`chrome-not-in-buffer` 10/10, `replay-gap` 17/17, `answerback` 11/11, `input-path` 19/19, `solo-popout` 11/11, `flow-control` 16/16, `dec-mode-restore` 10/10, `rename-rekey` 8/8, `shell-terminal-strip` 34/34) and `tsc -p tsconfig.test.json` clean; three failures are **pre-existing at HEAD** and unrelated (`terminal-focus-affordance` — `entry.inputDropNoticed` absent, `terminal-pane-fit` — `const DEFAULT_ROLES` absent, `terminal-operations-no-periodic-reopen` — documented in CI as unwired and red on main). Remaining risk: both subtasks' operator-facing surfaces (queued chip, error toast, amber GAP badge, RIS-into-a-live-pane) have no automated rendering coverage, so the plans' manual verification steps remain the real gate.
