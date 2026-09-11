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
- [ ] [A tmux Control-Mode Parser, Proven Against Captured Fixtures](../plans/render-seats-with-tmux-control-mode-not-a-tmux-client.md) — **CREATED** — ID: 621979c0-fcae-4cfe-a08a-08bbee7310dc
- [ ] [Switch Seats to Control Mode and Repoint the Three Consumers](../plans/switch-seats-to-control-mode-and-repoint-the-three-consumers.md) — **CREATED** — ID: 7190a1d1-bb07-47dc-bd75-d46a40e1b672
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
