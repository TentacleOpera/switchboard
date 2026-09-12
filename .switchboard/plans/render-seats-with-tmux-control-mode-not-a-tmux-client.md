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
  The full set is exactly 17 notification shapes plus 3 block guards in tmux 3.4 (confirmed from
  `control-notify.c` source); the parser must pass unknown types through as ignorable rather than
  fail on them, because tmux adds types across versions.
- **CRLF line terminators on the pty.** tmux 3.4 sets `c_oflag = OPOST|ONLCR` on the `-CC` tty, so
  every control line arrives as `\r\n` on the pty master, not bare `\n`. If the fixture was captured
  through a pipe rather than a pty it will have bare LF and will not match production. The parser
  must handle both (strip `\r` or split on `\r\n`/`\n`).

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

### Architecture note: the parser is in Go, not TypeScript

> **Superseded:** A pure TypeScript function `(chunk: string) => { messages: ControlMessage[], rest: string }` with no I/O, called at three TS call sites — the browser, the gateway ring, and the log writer.
> **Reason:** The three consumers are in the Go pty host (`cmd/switchboard-pty-host/main.go:publish()`), not in TypeScript. The TS `terminalWsGateway.ts` is `@deprecated RETIRED` (line 393); the TS `terminalLogWriter.ts` is retired (replaced by Go `log.go`). A TS parser cannot be called from Go. "One parser, three call sites" was a framing from the retired TS gateway architecture — in the Go host, `publish()` is the single fan-out point, so the parser is called once and its output routes to all three consumers.
> **Replaced with:** A Go pure function in the pty host package (`cmd/switchboard-pty-host/`), tested via Go tests against the same `protocol-fixtures/tmux-control-mode.json`. The parser is called from `publish()` — one call site, three consumers fed from its output. The browser receives decoded terminal bytes via the existing WS binary frame mechanism (no JS parser needed); control events (`%exit`, `%layout-change`) are sent as JSON WS messages.

## Complexity Audit

### Routine
- Octal escape decoding (`\033` → ESC, `\015` → CR, `\012` → LF) — a fixed lookup table.
- Pane-id extraction from `%output %<pane> <data>` — the pane sigil is `%`, the message type is also `%`, and the distinction is positional (first token is type, second is id).
- Unknown message types passed through as ignorable — no logic beyond tagging.
- DCS entry sequence (`ESC P 1000 p`) consumed once at stream start — a prefix strip.

### Complex / Risky
- **Block-stateful parsing.** `%begin`/`%end`/`%error` blocks are opaque — every line between the guards is data, not a control message. A zsh prompt inside a `capture-pane` response can legitimately begin with `%`; the parser must NOT parse it as a control line. tmux guarantees this is safe: `control_write()` queues notifications behind any pending block, so a notification never lands inside one. The parser must track block state (open/closed) and the current command number, and treat everything inside a block as raw data until the matching `%end`/`%error` arrives. This is the parser's highest-risk surface: a misparse here silently corrupts the rendered terminal.
- **`%exit` can arrive mid-block.** `%exit` comes from the client process's stdio, not the server's buffered output — they are not ordered against each other by construction. The parser must treat `%exit` as terminal wherever it appears, including inside an open block (force-close the block and emit the exit event).
- **Chunk-boundary safety.** Control mode is line-oriented over a byte stream; a chunk boundary can split a line mid-escape (`\033` arriving as `\0` then `33`). The parser must carry a partial-line remainder between chunks and never assume a chunk boundary is a line boundary. This is the defect a line-oriented parser over a stream always has, and exhaustive byte-offset splitting is the only way to find it.
- **`%output` payload encoding.** Bytes < 0x20 and `\` (0x5c) are escaped as `\ooo` (three octal digits); 0x7f and bytes ≥ 0x80 pass through raw. The payload is NOT guaranteed ASCII and NOT guaranteed valid UTF-8. The parser must decode octal escapes but pass high bytes through verbatim — do not attempt UTF-8 validation or sanitisation on `%output` payloads.
- **Block guard format.** `%begin <unix-time> <command-number> <flags>` — the parser must match blocks on command number (monotonic, unique), not timestamp (second-resolution, can collide for two commands in the same second). The `flags` field is `1` when the command originated from this client's stdin, `0` otherwise — useful for filtering but not required for correctness.
- **One line may produce multiple blocks.** `cmd_parse_and_append` parses command sequences, so `neww ; splitw` on a single line yields two `%begin`/`%end` pairs. The parser must handle multiple blocks per chunk without assuming one block per line.
- **Go test infrastructure is new.** The pty host has no `*_test.go` files today; tests are JS blackbox contract tests that assert on source text. A parser needs runtime tests (feed bytes, assert decoded output), not source-level assertions. Go tests (`go test ./cmd/switchboard-pty-host/`) are standard but not yet in the npm test pipeline.

## Edge-Case & Dependency Audit

**Race Conditions:** The parser is a pure function with no shared state — each call carries its own `rest` remainder. No race surface. The caller (`publish()`) is behind the pty read lock.

**Security:** The parser decodes octal escapes from a tmux control stream. A malicious or buggy tmux could emit oversized payloads, but the parser's job is to decode and return — the caller handles ring eviction and WS backpressure. No injection surface: the parser returns typed messages, not shell commands.

**Side Effects:** None by design. The parser returns `(messages, rest)` — it does not write to the ring, the log, or WS clients. The caller routes the output.

**Dependencies & Conflicts:**
- Depends on `protocol-fixtures/tmux-control-mode.json` — the fixture file already exists (committed 2026-09-11). The Go tests read it at test time.
- No dependency on the Go pty host's runtime types — the parser defines its own `ControlMessage` type (or equivalent Go struct) and does not import `fleet` or `terminal`.
- No conflict with existing code: the parser is new, unreferenced until subtask 2 wires it in.

## Dependencies

- `protocol-fixtures/tmux-control-mode.json` — the captured fixtures (already committed).
- `cmd/switchboard-pty-host/` — the Go pty host package where the parser lives.

## Adversarial Synthesis

Key risks: (1) the parser was originally specified in TypeScript for consumers that are in Go — corrected to Go; (2) chunk-boundary safety is the one defect a line-oriented stream parser always has and the only way to find it is exhaustive byte-offset splitting; (3) payload-vs-control-line disambiguation silently corrupts the terminal if wrong. Mitigations: Go tests against real fixtures, exhaustive byte-offset splitting, and explicit payload-contains-control-keyword test cases.

## Proposed Changes

> **Superseded:** A pure TypeScript function `(chunk: string) => { messages: ControlMessage[], rest: string }` — no sockets, no terminal, no filesystem. Control mode is line-oriented over a byte stream, so the parser must carry a partial-line remainder between chunks and never assume a chunk boundary is a line boundary.
> **Reason:** The three consumers are in Go, not TypeScript (see Architecture note above). A TS parser cannot be called from Go's `publish()`.
> **Replaced with:** A Go pure function in the pty host package, with the same design principles — no side effects, carries a partial-line remainder, never assumes chunk boundary = line boundary.

1. **A Go pure function, not a service.** `func parseControlMode(chunk string, state *parseState) (messages []ControlMessage, rest string)` — no ring writes, no log writes, no WS sends. Control mode is line-oriented over a byte stream, so the parser must carry a partial-line remainder between chunks and never assume a chunk boundary is a line boundary. The `state` (or `rest`) is threaded by the caller; the parser itself is stateless between calls.

2. **Decode octal escapes in `%output` payloads** and return bytes ready to write. `\033` → ESC (0x1b), `\015` → CR (0x0d), `\012` → LF (0x0a). Unescape before returning, or panes render literal backslashes. Bytes 0x7f and ≥ 0x80 pass through raw — the payload is NOT guaranteed ASCII or valid UTF-8. Do not attempt UTF-8 validation or sanitisation on `%output` payloads; `capture-pane` output bypasses `server_client_print()` and can contain invalid UTF-8.

3. **Model the three outcomes a caller needs:** `output` (pane id + decoded payload), `control` (a typed event the caller may act on — `%exit`, `%layout-change`, `%window-close`, `%session-changed`, `%pane-mode-changed`), and `ignored` (an unknown type, passed through by name so a future tmux cannot break rendering). The full notification inventory for tmux 3.4 is 17 shapes plus 3 block guards — the parser should recognise the common ones and pass the rest through as `ignored`.

4. **Handle `%begin`/`%end`/`%error` blocks as opaque.** Command replies are framed: `%begin <time> <number> <flags>` opens, `%end` or `%error` with matching time+number closes. Every line between the guards is data, not a control message — a zsh prompt inside a `capture-pane` response can legitimately begin with `%`. tmux guarantees notifications never land inside a block (`control_write()` queues them behind pending blocks). The parser must track block state (open/closed) and the current command number, treat everything inside as raw data, and surface the block contents as output when the block closes. Match blocks on command number (monotonic, unique), not timestamp (second-resolution, can collide). One input line may produce multiple blocks (semicolon-separated commands); the parser must handle this without assuming one block per line. Parse errors get a synthetic block (`%begin`, `parse error: ...`, `%error`).

5. **Handle `%exit` as terminal wherever it appears.** `%exit` comes from the client process's stdio, not the server's buffered output — they are not ordered against each other. The parser must treat `%exit` as terminal even inside an open block: force-close the block and emit the exit event. Do not wait for a matching `%end`.

6. **Handle CRLF line terminators.** tmux 3.4 sets `c_oflag = OPOST|ONLCR` on the `-CC` tty, so every control line arrives as `\r\n` on the pty master. The parser must strip `\r` or split on `\r\n`/`\n` — handle both CRLF (production pty) and bare LF (pipe-captured fixture). Stripping all CR is safe because tmux octal-escapes `0x0d` inside `%output` payloads.

7. **Go tests over `protocol-fixtures/tmux-control-mode.json`** (`controlmode_test.go` in the pty host package), asserting: the entry sequence is consumed; octal decoding produces byte-exact output; pane-id extraction works; a payload containing `%output`, `%begin`, `%exit`, or an embedded newline is returned as data; a `capture-pane` response inside a `%begin`/`%end` block with a `%`-prefixed line is surfaced as data, not parsed as a control message; `%exit` arriving mid-block is treated as terminal; CRLF and bare-LF line terminators both parse correctly; an unknown type (`%future-thing`) is reported as ignored. The tests read the fixture JSON (using `encoding/json`) and exercise the parser directly — no live tmux, no pty, no WS.

## Verification Plan

- **Replays the fixtures exactly:** parse `scratchWithOutput` and assert the two `%output` messages decode to the original colour sequences and CRLF bytes.
- **Chunk-boundary safety:** feed the same fixture split at every byte offset and assert the message sequence is identical each time. This is the defect a line-oriented parser over a stream always has, and the only way to find it is exhaustively.
- **Block-stateful parsing:** a `capture-pane` response inside a `%begin`/`%end` block with a line beginning `%` (e.g. a zsh prompt `% test`) is surfaced as data, not parsed as a control message. Everything between `%begin` and `%end`/`%error` is opaque.
- **`%exit` mid-block:** `%exit` arriving inside an open block is treated as terminal — the block is force-closed and the exit event is emitted, without waiting for a matching `%end`.
- **CRLF and bare-LF both parse:** feed the same fixture with `\r\n` line terminators and with bare `\n` and assert identical message sequences.
- **Payload encoding:** a `%output` payload with bytes ≥ 0x80 passes through raw (not sanitised, not UTF-8 validated). A `\` (0x5c) in the payload is escaped as `\134` and decodes back to `\`.
- **Payload is never parsed:** a payload containing `%output`, `%begin`, `%exit` or an embedded newline is returned as data.
- **Unknown types survive:** an invented `%future-thing` is reported as ignored, not thrown.
- **Entry sequence consumed:** the DCS prefix does not appear in the first message's payload.
- **No side effects:** assert the parser is a pure function — it returns messages and a remainder, and does not write to any ring, log, or WS client. (The original "assert the module imports nothing from `fs`, `ws`, or the terminal" was a TypeScript import assertion; in Go, the equivalent is that the parser function takes input and returns output with no I/O.)
- **Go tests run:** `go test ./cmd/switchboard-pty-host/` passes. This is new infrastructure (no `*_test.go` files exist today), but standard Go practice.

## Resolved Assumptions

The following tmux control-mode behaviors were confirmed from the tmux 3.4 source code and iTerm2's reference implementation during web research. They are authoritative and should not be re-researched:

- **`capture-pane -p` output arrives inside a `%begin`/`%end` block**, not as `%output` messages. The entire capture is a single `control_write` call with the trailing newline stripped. Lines inside the block can legitimately begin with `%`. (Source: `cmd-capture-pane.c` in tmux 3.4.)
- **`%output` payload encoding:** bytes < 0x20 and `\` (0x5c) are escaped as `\ooo` (three octal digits); 0x7f and bytes ≥ 0x80 pass through raw. Payload is NOT guaranteed ASCII or valid UTF-8. (Source: `control.c` in tmux 3.4.)
- **CRLF line terminators:** tmux 3.4 sets `c_oflag = OPOST|ONLCR` on the `-CC` tty. Control lines arrive as `\r\n` on the pty master. iTerm2 strips CR in two separate places. (Source: `client.c` in tmux 3.4; `VT100TmuxParser.m` in iTerm2.)
- **`%exit` is from the client process, not the server.** It is not ordered against server-buffered output and can arrive mid-block. iTerm2 force-closes the current command on `%exit`. (Source: `client.c` in tmux 3.4; `TmuxGateway.m` in iTerm2.)
- **Block guard format:** `%begin <unix-time> <command-number> <flags>`. The `flags` field is `1` when the command originated from this client's stdin, `0` otherwise. Match on command number, not timestamp. (Source: `cmd-queue.c` in tmux 3.4.)
- **One line may produce multiple blocks.** Semicolon-separated commands yield multiple `%begin`/`%end` pairs. (Source: `cmd-queue.c` in tmux 3.4.)
- **No `%pane-exited` or `%pane-close` notification exists.** Pane death surfaces only as `%layout-change` (other panes remain) or `%window-close` (last pane). (Source: `control-notify.c` in tmux 3.4.)
- **17 notification shapes in tmux 3.4.** The full inventory: `%output`, `%extended-output`, `%layout-change`, `%window-add`/`%unlinked-window-add`, `%window-close`/`%unlinked-window-close`, `%window-renamed`/`%unlinked-window-renamed`, `%window-pane-changed`, `%pane-mode-changed`, `%session-changed`, `%client-session-changed`, `%session-renamed`, `%session-window-changed`, `%sessions-changed`, `%client-detached`, `%paste-buffer-changed`/`%paste-buffer-deleted`, `%pause`/`%continue`, `%subscription-changed`, `%message`, `%config-error`. (Source: `control-notify.c` in tmux 3.4.)
- **DCS entry (`\033P1000p`) and ST (`\033\\`) are framing bytes.** Strip both. No handshake is required beyond `-CC`. (Source: `control.c` in tmux 3.4.)

### Goal Invariants

- **One parser, one call site, three consumers fed from its output:** assert the Go parser is a pure function called from `publish()`, and that the browser, the ring, and the log all receive from the same parsed output — not from three separate parser implementations.
- **Decoded output is byte-exact:** assert a round trip — raw payload, parsed, decoded — matches what the same program wrote outside tmux.
- **Unknown message types cannot break rendering:** assert an unrecognised type is ignorable and never surfaces as pane output.

## Subtask 1 Implementation Summary

Implemented the Go control-mode parser as `cmd/switchboard-pty-host/controlmode.go` (pure function, no I/O, imports only `strings`) plus `cmd/switchboard-pty-host/controlmode_test.go` proving it against `protocol-fixtures/tmux-control-mode.json`. The parser exposes `ParseControlMode(chunk, *ParseState) []ControlMessage` with four message kinds (Output/Control/Ignored/Block), threads a partial-line remainder and open-block state across chunks, strips the DCS entry (`ESC P 1000 p`) and ST terminator, decodes octal escapes in `%output` payloads (high bytes raw, backslash via `\134`), treats `%begin`/`%end`/`%error` blocks as opaque matched on command number, and force-closes the block on a mid-block `%exit`. Tests cover byte-exact fixture decode, exhaustive chunk-boundary splitting, CRLF/bare-LF equivalence, block-stateful parsing with `%`-prefixed data lines, `%exit` mid-block, high-byte/backslash payloads, payload-never-parsed, unknown-type-ignored, entry-sequence-consumed, and determinism. The parser is unreferenced at runtime until subtask 2 wires it into `publish()`.

## Review Findings

Two parser defects, both found by probing real tmux 3.4 rather than trusting the plan's Resolved
Assumptions. `%extended-output` was listed in `knownControlTypes` and therefore returned as
`KindControl`, but it is pane output and becomes the dominant form the moment flow control is
armed (measured 6707 vs 14 `%output`), so the pane rendered blank; it now parses via
`parseExtendedOutput` into `KindOutput`. `closeBlock` octal-decoded block contents, but
`capture-pane` replies are NOT `\ooo`-escaped — a pane showing literal `\033[31m` came back as
raw `\`,`0`,`3`,`3`, so decoding injected live escape sequences into the pane, ring and log;
block data is now verbatim and the `-C` reply is decoded by the caller via the new
`decodeCaptureC` (tmux `-C` doubles the backslash, a third scheme the plan did not name). Files
changed: `controlmode.go`, `controlmode_test.go` (3 regression tests). Validation: Go verification ran in full (toolchain at `/home/patrick/.local/share/go1.26.5/bin`, not on PATH): `go vet ./cmd/...` clean, `go build ./...` clean, `go test ./cmd/switchboard-pty-host/` green, all four pty-host targets rebuilt via `scripts/build-pty-host.sh`, and `test:contract:pty-host-blackbox` green against the REBUILT binary. The three new tests were proven discriminating by replaying them against the pre-fix code in a scratch copy: `TestExtendedOutputIsPaneOutput` fails with `kind=1` (KindControl) and `TestBlockDataIsNotOctalDecoded` fails with `block data="LIT:\x1b[31m TAIL:\\"` — the literal `\033` decoded into a live ESC, the corruption demonstrated rather than argued.

## Deferred Findings

- NIT: `controlmode.go` and `controlmode_test.go` shipped un-gofmt-ed in 234a9060; formatted in this pass. `go vet` alone does not catch it, and no gate runs gofmt. `cmd/switchboard-pty-host/controlmode.go:1`
- MAJOR: Whole-buffer `ESC \` and CR stripping also rewrites block content, which carries raw ESC under `-e`. `cmd/switchboard-pty-host/controlmode.go:181`
- NIT: The plan's "17 notification shapes" inventory listed `%extended-output` as a notification; it is output. The inventory should not be re-cited as authoritative. `render-seats-with-tmux-control-mode-not-a-tmux-client.md:1`