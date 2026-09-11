# A tmux Control-Mode Parser, Proven Against Captured Fixtures

## Goal

One component that turns `tmux -CC` control-mode output into the two things its callers need:
the pane id a message is for, and the decoded bytes to render. Built and tested against real
captures from this host, and shipped **before** anything switches over to it, so the risky
cutover lands on a parser that is already proven.

> **Subtask 1 of 2.** The cutover -- switching the seat chain and repointing the three consumers
> of the pty byte stream -- is
> `switch-seats-to-control-mode-and-repoint-the-three-consumers.md`. This card changes no
> behaviour: the parser is unreferenced until that one wires it in.

### What the fixtures already establish

Captured 2026-09-11 against tmux 3.4 and committed as
`protocol-fixtures/tmux-control-mode.json` -- a scratch session emitting colour and CRLF, and a
live Devin planner seat attached read-only at matched size.

- **Entry is a DCS sequence, not a `%` line.** The stream opens `ESC P 1000 p`. A parser that
  scans only for lines starting with `%` swallows it into the first message.
- **Escaping is octal.** `\033`, `\015`, `\012`. Unescape before writing, or panes render
  literal backslashes.
- **Three id sigils, and one collides with the message prefix.** `$` session, `@` window, `%`
  pane -- so `%output %16 ...` is type `%output` addressed to pane 16. The second `%` is an id,
  not a second type.
- **Attaching replays nothing.** The scratch session had already printed three lines; only the
  two emitted after attach arrived. The real seat, mid-conversation, produced no `%output` at
  all. **The current screen must be fetched separately** -- that belongs to subtask 2, but it is
  the parser's job to make the distinction legible rather than look like an empty stream.
- **Observed message types so far:** `%output`, `%end`, `%session-changed`, `%window-renamed`.
  The full set is roughly a dozen; the parser must pass unknown types through as ignorable
  rather than fail on them, because tmux adds types across versions.

### Problem analysis

**The board pane IS a tmux client today.** The seat's startup command ends
`exec tmux attach -t ${view}` (`goPtyFleetProjection.ts`), so everything the operator sees in
the panel is tmux's renderer. Four consequences, all measured on this host:

- **Scrolling swallows typing.** `mouse on` is set globally, and tmux's root table binds
  `WheelUpPane → copy-mode -e`. A wheel scroll puts the pane in copy-mode, where keystrokes go
  to copy-mode instead of the agent. Nothing reports it.
- **The prefix eats keys.** `C-b` opens tmux's command table over the agent's prompt.
- **Resize is a fight.** `aggressive-resize on` had to be set per-window because grouped
  sessions size a window against every attached client — four browser panes at 221x40 and an
  SSH client at 183x53 fought, and the losers repeated their bottom line forever.
- **The status line had to be suppressed** per-view, because it duplicated the sidebar.

Each of those is a workaround for the same root fact: tmux is drawing a pane inside a surface
that already has its own chrome, scrollback, selection and keyboard.

**But tmux is wanted, and for three specific things.** Not for rendering:

1. **Scrollback.** `history-limit` is 50,000 here. The client's xterm `scrollback` is 1,000 and
   has never been felt, because tmux repaints its screen rather than emitting lines the outer
   terminal retains — the history being scrolled is always tmux's.
2. **Phone / SSH access.** `tmux attach -t <session>` from anywhere reaches the live seat.
3. **Surviving a maintenance restart.** The tmux server is independent of the board, so a
   board restart leaves sessions untouched. `the-pty-host-should-outlive-the-board-not-die-with-it.md`
   exists because the alternative failed twice on 2026-09-07, destroying a running four-seat
   team mid-work. **tmux already provides that property**; keeping it means the restart story
   needs no second mechanism.

**Control mode gives all three without the rendering.** `tmux -CC` is tmux's documented protocol
mode: it stops drawing and emits line-oriented output — `%output %<pane> <data>`, `%begin`/`%end`
blocks, `%layout-change`, `%window-add` — which the client parses and renders however it likes.
It is not exotic; iTerm2's tmux integration is this protocol, including its history fetch.

### Root cause

Seating was built when the only way to reach a seat from elsewhere was to make the board's own
terminal a tmux client. That decision put a full terminal multiplexer inside a browser pane, and
every tmux behaviour since — copy-mode, prefix, status line, client-size arbitration — has had to
be individually suppressed. The suppressions work one at a time and never compose into "tmux is
not in the way", because the renderer is still tmux's.

### Non-goals

- **Removing tmux.** It is the session owner, the SSH entry point and the restart-survival
  mechanism. This plan keeps all three and changes only who draws.
- **Changing persistence.** Sessions keep their current lifecycle. This plan neither adds nor
  removes `--survive-parent`; tmux already covers the restart case that plan was written for.
- **`switchboard attach`.** The alternative design (pty host owns the agent, tmux wraps a WS
  client on the phone) was considered and rejected: it needs a new CLI client AND reconnect
  logic on every board restart, where control mode leaves the phone's connection untouched.
- **The agent-exit cascade.** An agent crash still closes its window, destroys the session and
  takes the error with it — see `an-agent-exit-destroys-the-seat-and-its-error-with-it.md`.
  Control mode does not fix it and does not worsen it.

## Metadata

**Complexity:** 4
**Tags:** terminal, infrastructure, ux, backend, reliability

## User Review Required

None. The decision between control mode and a CLI attach client is settled: control mode,
because tmux is already the restart-survival mechanism and a WS client would have to rebuild it.

## Proposed Changes

1. **A pure function, not a service.** `(chunk: string) => { messages: ControlMessage[], rest: string }`
   -- no sockets, no terminal, no filesystem. Control mode is line-oriented over a byte stream,
   so the parser must carry a partial-line remainder between chunks and never assume a chunk
   boundary is a line boundary.
2. **Decode octal escapes in `%output` payloads** and return bytes ready to write.
3. **Model the three outcomes a caller needs:** `output` (pane id + decoded payload), `control`
   (a typed event the caller may act on -- `%exit`, `%layout-change`, `%window-close`), and
   `ignored` (an unknown type, passed through by name so a future tmux cannot break rendering).
4. **Handle `%begin`/`%end` blocks** -- command replies are framed and must not be emitted as
   pane output.
5. **Fixture-driven tests** over `protocol-fixtures/tmux-control-mode.json`, asserting the entry
   sequence, octal decoding, pane-id extraction, and that a payload containing the literal text
   `%output` or `%begin` is returned as data rather than parsed as a control line.

## Verification Plan

- **Replays the fixtures exactly:** parse `scratchWithOutput` and assert the two `%output`
  messages decode to the original colour sequences and CRLF bytes.
- **Chunk-boundary safety:** feed the same fixture split at every byte offset and assert the
  message sequence is identical each time. This is the defect a line-oriented parser over a
  stream always has, and the only way to find it is exhaustively.
- **Payload is never parsed:** a payload containing `%output`, `%begin`, `%exit` or an embedded
  newline is returned as data.
- **Unknown types survive:** an invented `%future-thing` is reported as ignored, not thrown.
- **Entry sequence consumed:** the DCS prefix does not appear in the first message's payload.
- **No I/O:** assert the module imports nothing from `fs`, `ws`, or the terminal -- it must stay
  usable by the browser, the scrollback ring and the log tee alike.

### Goal Invariants

- **One parser, three callers:** assert the module is pure and dependency-free, so the browser,
  the gateway ring and the log writer can all use the same implementation rather than three
  divergent ones.
- **Decoded output is byte-exact:** assert a round trip -- raw payload, parsed, decoded --
  matches what the same program wrote outside tmux.
- **Unknown message types cannot break rendering:** assert an unrecognised type is ignorable and
  never surfaces as pane output.
