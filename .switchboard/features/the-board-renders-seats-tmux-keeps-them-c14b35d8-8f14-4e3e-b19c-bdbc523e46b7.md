# The Board Renders Seats, tmux Keeps Them

**Complexity:** 6

## Goal

Stop the board pane being a tmux client. A seat moves from exec tmux attach to exec tmux -CC attach, so tmux stops drawing and emits a protocol the panel renders itself. tmux keeps everything it is actually wanted for: it owns the session, it is what a phone reaches over SSH, and it is why a maintenance restart never touches a running seat. What goes is the tmux UI the browser inherited by accident - copy-mode swallowing keystrokes on scroll, the prefix eating keys, the resize arbitration, the duplicated status line - each of which has been suppressed one at a time without ever composing into tmux being out of the way.

## How the Subtasks Achieve This

- **A tmux Control-Mode Parser, Proven Against Captured Fixtures**: builds the one component
  everything else needs -- turning `%output %<pane> <octal>` into a pane id and decoded bytes --
  and proves it against real captures from this host rather than a spec reading. It changes no
  behaviour and is unreferenced until the cutover wires it in, so the risky half lands on a
  parser that already works.
- **Switch Seats to Control Mode and Repoint the Three Consumers**: the cutover. One line moves
  the seat chain to `tmux -CC attach`, and the three readers of that byte stream -- the browser
  pane, the gateway's 256 KB scrollback ring, and the `terminalLogWriter` tee -- are each
  repointed through the parser. Input becomes `send-keys -H`, resize becomes `refresh-client -C`,
  and history is fetched with `capture-pane` on attach.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A tmux Control-Mode Parser, Proven Against Captured Fixtures](../plans/render-seats-with-tmux-control-mode-not-a-tmux-client.md) — **LEAD CODED** — ID: 621979c0-fcae-4cfe-a08a-08bbee7310dc
- [ ] [Switch Seats to Control Mode and Repoint the Three Consumers](../plans/switch-seats-to-control-mode-and-repoint-the-three-consumers.md) — **LEAD CODED** — ID: 7190a1d1-bb07-47dc-bd75-d46a40e1b672
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Strictly sequential.** The parser must land before the cutover; the cutover is the only caller
and there is nothing to verify it against until it exists.

Two facts, captured on 2026-09-11 and committed as `protocol-fixtures/tmux-control-mode.json`,
shape both subtasks and should not be rediscovered:

- **Attaching replays nothing.** A scratch session that had already printed three lines
  delivered only the two emitted after attach; a live idle seat delivered no `%output` at all.
  The history fetch is mandatory, not an optimisation -- without it every panel opens blank.
- **The pty byte stream has three consumers, not one.** `terminalWsGateway.ts:489` states it.
  The log tee is the one to be careful with: those transcripts are the only reason planner-4's
  death was diagnosable on 2026-09-11, when the pane was destroyed and the log still held
  `Error: failed to start the ACP agent child`.

**Not fixed by this feature, and deliberately so:** an agent exit still closes its window,
destroys the session and takes the error with it
(`an-agent-exit-destroys-the-seat-and-its-error-with-it.md`). And the open
`/`-clears-the-line symptom is a verification case here rather than an assumed fix -- control
mode removes tmux's key interpretation from the path, which makes it plausible, not certain.

## Team Dispatch Instructions

### A tmux Control-Mode Parser, Proven Against Captured Fixtures

**Seat:** Coder (complexity 4)

**Acceptance:**
- Go parser replays `protocol-fixtures/tmux-control-mode.json` fixtures exactly — the two `%output` messages in `scratchWithOutput` decode to the original colour sequences and CRLF bytes.
- Chunk-boundary safety: feeding the fixture split at every byte offset produces an identical message sequence each time.
- A payload containing `%output`, `%begin`, `%exit`, or an embedded newline is returned as data, not parsed as a control line.
- An unknown message type (e.g. `%future-thing`) is reported as ignored, not thrown.
- `go test ./cmd/switchboard-pty-host/` passes.

**Must not touch:** `publish()`, `write()`, `ptyResize()`, `readOutput()`, or any existing Go pty host function — the parser is purely additive and unreferenced until the cutover wires it in. Must not modify `goPtyFleetProjection.ts` or any TS file.

### Switch Seats to Control Mode and Repoint the Three Consumers

**Seat:** Coder (complexity 6 — but this is the risky half; a lead reviewer should check the demux ordering in `publish()`, the pane-id state dependency, the empty-line guard, and the three-way input encoder)

**Acceptance:**
- No seat's startup command ends in a bare `tmux attach` — source-level check in `goPtyFleetProjection.ts` (now `tmux -u -CC attach`).
- `tmux attach -t <base>` from a second client still reaches the live seat while a panel is open.
- `.switchboard/logs/<seat>-<session>.md` contains terminal transcript, not `%output` lines.
- A freshly opened panel scrolls back to tmux's history limit (matches `capture-pane -p -S -50000`).
- Pending-output splice: no corrupted first line if a pane is mid-escape-sequence at attach time.
- Typed `hello/world` arrives at the agent exactly — the `/`-clears-the-line symptom is checked, not assumed.
- Unicode input (e.g. `é`) arrives as correct UTF-8 bytes — the `0xNN` code-point path, not `-H` byte splitting.
- No code path writes a bare `\n` to the pty stdin — an empty command detaches the client.
- `window-size manual` holds: panel pane geometry does not ping-pong with a second attached client.
- `tmux-view-session-chrome-contract.test.js` is updated to reflect the deleted suppressions and added options.
- A board restart leaves session ids and agent pids unchanged.

**Must not touch:** session lifecycle (`--survive-parent` is neither added nor removed); the agent-exit cascade (`an-agent-exit-destroys-the-seat-and-its-error-with-it.md` is not fixed here). The extension host's terminal creation path (`TaskViewerProvider.ts` `createFleetTerminalAndDeliver`) is not modified — the chain change is standalone-only. Never put `if-shell` or `run-shell` on control-mode stdin — they block the command queue.

## Completion Summary

Both subtasks landed and were committed (234a9060). Subtask 1 delivered a pure Go tmux control-mode parser (`controlmode.go`) with fixture-proven byte-exact decode, exhaustive chunk-boundary splitting, opaque block handling, and unknown-type pass-through; `go test ./cmd/switchboard-pty-host/` is green. Subtask 2 cut the seat chain over to `exec tmux -u -CC attach`, repointed the three pty consumers (log tee, 256KB scrollback ring, browser WS) through the parser, and switched input to `send-keys -H`/`0xNN`/`-lt`, resize to `refresh-client -C`, and history to `capture-pane -S -50000`. The per-view suppressions (status off, prefix None, aggressive-resize) were deleted; window-size manual and automatic-rename off were added. The chrome contract test was updated and passes (8/8). Two fix rounds were needed: a `go vet` format-string defect in the test file and a history-fetch bound (-500 → -50000) plus a contract-test regex that matched comment text.

## Review Findings

Reviewed 234a9060 against live tmux 3.4 on this host rather than against the plan's cited
sources, which surfaced four defects that every existing gate passed: `%extended-output` (the
DOMINANT output form once `pause-after=30` is armed — measured 6707 vs 14 `%output`) was
classified as a notification and never rendered; `capture-pane` block contents were octal-decoded
though they arrive raw, turning literal `\033` in scrollback into live escape sequences in the
pane, ring and log; `%output` was routed without filtering on the seat's pane, so every seat in a
grouped team rendered and logged all four agents; and `%pause` had no handler and no
`refresh-client -A` resume, so a lagging panel silenced its seat permanently. Files changed:
`cmd/switchboard-pty-host/controlmode.go`, `cmd/switchboard-pty-host/main.go`,
`cmd/switchboard-pty-host/controlmode_test.go` (3 regression tests),
`.github/workflows/integration-tests.yml`. Validation: `tmux-view-chrome` 8/8, `tmux-backend`,
`pty-host-gating` and `compile-tests` all green; `pty-route-surface` is 7-red but PRE-EXISTING —
it reads none of the files this commit materially changed and its `terminals.js` assertion fails
identically at 49e2f7ca. **Principal remaining risk: no Go toolchain exists on this host, so none
of the Go fixes are compile-verified locally — CI's `go test ./...` is the first real check.**

## Deferred Findings

- MAJOR: Go fixes are not compile-verified — no Go toolchain on this host; `go test`/`go vet`/`gofmt` could not run. `cmd/switchboard-pty-host/controlmode.go:1`
- MAJOR: The global `ESC \` (ST) and CR strips run over block content too, which with `-e` contains RAW ESC — a captured OSC sequence ending in ST would be silently eaten. Fixing needs the strips moved out of the whole-buffer path. `cmd/switchboard-pty-host/controlmode.go:181`
- MAJOR: No automated check discriminates the core mechanism end-to-end (a real seat rendering through control mode). The new Go tests cover the parser; nothing covers the live attach path. `cmd/switchboard-pty-host/controlmode_test.go:1`
- NIT: `%pause` now auto-resumes, which defeats the backpressure `pause-after=30` requests; correct for restoring seat liveness but the flow-control intent is now vestigial. `cmd/switchboard-pty-host/main.go:396`