# Switch Seats to Control Mode and Repoint the Three Consumers

## Goal

Change the seat's pty from `tmux attach` to `tmux -CC attach`, and repoint everything that reads
the resulting byte stream. tmux keeps owning the session — `tmux attach` from a phone is
unchanged and a board restart still never touches a seat — but it stops drawing, and the board
renders the agent as a plain terminal.

> **Subtask 2 of 2.** The parser this depends on is
> `render-seats-with-tmux-control-mode-not-a-tmux-client.md` and must land first. This card is
> the cutover, and it is the risky half.

### Problem analysis

**The board pane IS a tmux client today.** The seat's startup command ends
`exec tmux attach -t ${view}` (`goPtyFleetProjection.ts`), so the panel renders tmux's UI. Four
workarounds exist for that single fact, all measured on this host:

- **Scrolling swallows typing.** `mouse on` is set globally and tmux's root table binds
  `WheelUpPane -> copy-mode -e`. A scroll puts the pane in copy-mode, where keystrokes stop
  reaching the agent, silently.
- **`prefix None`** had to be set per-view so `C-b` reaches the agent.
- **`aggressive-resize on`** had to be set per-window because grouped sessions size a window
  against every attached client — four browser panes at 221x40 and an SSH client at 183x53
  fought, and the losers repeated their bottom line forever.
- **`status off`** had to be set per-view because the status line duplicated the sidebar.

**Three consumers read that byte stream, not one.** `terminalWsGateway.ts:489` states it:
"to the scrollback ring. The terminal log writer subscribes here to tee". So switching to `-CC`
changes what all three receive:

| consumer | today | after the switch |
| :--- | :--- | :--- |
| the browser pane | terminal bytes to `term.write` | control protocol |
| the gateway scrollback ring (`MAX_SCROLLBACK_BYTES`, 256 KB) | terminal bytes, replayed on re-attach | control protocol |
| `terminalLogWriter` -> `.switchboard/logs/*.md` | terminal bytes | control protocol |

**The log tee is the one to be careful with.** Those transcripts are how planner-4's death was
diagnosed on 2026-09-11 — the pane was destroyed and the log was the only surviving evidence of
`Error: failed to start the ACP agent child`. They are also what `/terminals/<name>/log` serves
and what the Spark context points at. Leave them untouched and they become streams of
`%output %5 hello\015` instead of readable transcripts.

**Attaching replays nothing.** Captured and committed in
`protocol-fixtures/tmux-control-mode.json`: a scratch session that had already printed three
lines delivered only the two emitted after attach, and a live idle seat delivered no `%output`
at all. Without an explicit history fetch every panel opens blank and fills only as the agent
next speaks. This is not an optimisation.

### Root cause

Seating was built when the only way to reach a seat from elsewhere was to make the board's own
terminal a tmux client. That put a terminal multiplexer inside a browser pane, and every tmux
behaviour since has had to be suppressed one at a time. The suppressions work individually and
never compose into "tmux is out of the way", because the renderer is still tmux's.

### Non-goals

- **Removing tmux.** It is the session owner, the SSH entry point, and the restart-survival
  mechanism that `the-pty-host-should-outlive-the-board-not-die-with-it.md` exists to protect —
  an incident that destroyed a running four-seat team twice on 2026-09-07. This changes only who
  draws.
- **Changing persistence.** Session lifecycle is untouched; this neither adds nor needs
  `--survive-parent`.
- **`switchboard attach`.** The alternative (pty host owns the agent, tmux wraps a WS client on
  the phone) was considered and rejected: it needs a new CLI client AND reconnect logic on every
  board restart, where control mode leaves the phone's connection untouched.
- **The agent-exit cascade.** An agent crash still closes its window, destroys the session and
  takes the error with it — `an-agent-exit-destroys-the-seat-and-its-error-with-it.md`. Not
  fixed here, not worsened.

## Metadata

**Complexity:** 6
**Tags:** terminal, infrastructure, ux, backend, reliability

## User Review Required

None. Control mode over a CLI attach client is settled: tmux is already the restart-survival
mechanism, and a WS client would have to rebuild it.

## Proposed Changes

1. **The seat chain: `exec tmux attach -t <view>` becomes `exec tmux -CC attach -t <view>`.**
   One line in `goPtyFleetProjection.ts`; everything else follows from it.
2. **Demux at all three consumers** using the subtask-1 parser — the browser before
   `term.write`, the gateway before the ring append, and the log writer before the tee. One
   parser, three call sites; three separate implementations would drift.
3. **Input becomes `send-keys -H`** to the target pane rather than raw bytes on the pty, so
   typed text can never be mistaken for a control line.
4. **Resize becomes `refresh-client -C <w>,<h>`**, and `aggressive-resize` is deleted — under
   control mode each client declares its own size, so the arbitration that option worked around
   no longer happens.
5. **Fetch history on attach** with `capture-pane -p -S -<n>`, which is what preserves the
   50,000-line scrollback without touching `MAX_SCROLLBACK_BYTES` or the client's
   `scrollback: 1000`.
6. **Delete the cosmetic suppressions** — `status off`, `prefix None` — once the client renders.
7. **Render `%exit`** as a stated end state rather than a dead pane.

## Verification Plan

- **No tmux UI:** assert no status line, that a wheel scroll does not enter copy-mode, and that
  `C-b` reaches the agent as a keystroke.
- **Scrollback preserved:** assert a freshly opened panel scrolls back to tmux's history limit
  and matches `capture-pane -p -S -50000` for the same pane.
- **Phone access unchanged:** with a panel open, assert `tmux attach -t <base>` from a second
  client shows the same live seat and behaves as a normal tmux session.
- **Maintenance restart:** restart the board with seats running. Assert agents keep running, the
  SSH client never drops, and the panel reconnects to the same sessions.
- **The logs stay readable:** assert `.switchboard/logs/<seat>-<session>.md` contains terminal
  transcript, not `%output` lines, and that `/terminals/<name>/log` still serves something a
  human can read. This is the regression that would cost the next incident its evidence.
- **Ring replay still works:** unassign and re-attach a pane; assert the replayed scrollback
  renders as terminal content.
- **Input fidelity:** type `hello/world` and assert the agent receives exactly that — the open
  `/`-clears-the-line symptom. Control mode removes tmux's key interpretation from the path, so
  check it explicitly rather than assuming it fixed.
- **Both hosts:** the chain is built in one place and rendered in one place; assert the
  extension and standalone hosts behave identically.

### Goal Invariants

- **The panel is not a tmux client:** assert no seat's startup command ends in a bare
  `tmux attach` — a source-level check that survives refactors.
- **tmux still owns the session:** assert `tmux attach -t <base>` reaches a live seat while the
  panel is open, so this cannot quietly become "no tmux".
- **A board restart does not touch a seat:** assert session ids and agent pids are unchanged
  across a restart.
- **All three consumers demux:** assert none of the browser, the ring, or the log tee receives
  raw control protocol — the failure here is silent and shows up as unreadable history months
  later.
- **Scrollback does not regress:** assert reachable history is tmux's limit, not xterm's
  `scrollback` value.
