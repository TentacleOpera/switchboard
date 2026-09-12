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
`exec tmux attach -t ${view}` (`goPtyFleetProjection.ts:308`), so the panel renders tmux's UI. Four
workarounds exist for that single fact, all measured on this host:

- **Scrolling swallows typing.** `mouse on` is set globally and tmux's root table binds
  `WheelUpPane -> copy-mode -e`. A scroll puts the pane in copy-mode, where keystrokes stop
  reaching the agent, silently.
- **`prefix None`** had to be set per-view so `C-b` reaches the agent.
- **`aggressive-resize on`** had to be set per-window because grouped sessions size a window
  against every attached client — four browser panes at 221x40 and an SSH client at 183x53
  fought, and the losers repeated their bottom line forever.
- **`status off`** had to be set per-view because the status line duplicated the sidebar.

**Three consumers read that byte stream, not one.** The authority is `main.go:218` — the Go pty
host's `publish()` function, which is the single fan-out point for all pty output:

```go
func (f *fleet) publish(name, data string) {
    f.logOutput(name, data)      // 1. log tee → .switchboard/logs/*.md
    // ... lock ...
    f.rings[name] = append(...)  // 2. scrollback ring (256 KB replay buffer)
    // ... broadcast to WS clients  // 3. browser pane (xterm.js term.write)
}
```

> **Superseded:** The original plan cited `terminalWsGateway.ts:489` as the authority for "three consumers."
> **Reason:** `terminalWsGateway.ts` is `@deprecated RETIRED` (line 393). The fleet moved into the Go pty host child (`cmd/switchboard-pty-host`). The TS gateway is not constructed in production; the three consumers are in Go's `publish()`.
> **Replaced with:** `main.go:218` (`publish()`) as the authority. The three consumers are: (1) the log tee (`log.go:logOutput`), (2) the scrollback ring (`f.rings`), and (3) the WS broadcast to browser clients.

| consumer | today | after the switch |
| :--- | :--- | :--- |
| the browser pane (WS binary frames) | terminal bytes to `term.write` | decoded terminal bytes (same WS frame format) + control events as JSON |
| the scrollback ring (`f.rings`, 256 KB) | terminal bytes, replayed on re-attach | decoded terminal bytes only |
| `logOutput` → `.switchboard/logs/*.md` | terminal bytes (ANSI stripped, CR collapsed) | decoded terminal bytes (same stripping) |

**The log tee is the one to be careful with.** Those transcripts are how planner-4's death was
diagnosed on 2026-09-11 — the pane was destroyed and the log was the only surviving evidence of
`Error: failed to start the ACP agent child`. They are also what `/terminals/<name>/log` serves
and what the Spark context points at. Leave them receiving raw control protocol and they become
streams of `%output %5 hello\015` instead of readable transcripts.

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

### Architecture note: the cutover is in the Go pty host, not TypeScript

> **Superseded:** Demux at all three consumers using the subtask-1 parser — the browser before `term.write`, the gateway before the ring append, and the log writer before the tee. One parser, three call sites; three separate implementations would drift.
> **Reason:** The three consumers are in the Go pty host's `publish()` function (`main.go:218`), not in TypeScript. The TS `terminalWsGateway.ts` is `@deprecated RETIRED`; the TS `terminalLogWriter.ts` is retired (replaced by Go `log.go`). "Three call sites" was a framing from the retired TS architecture. In the Go host, `publish()` is the single fan-out point — demux there and all three consumers receive from the same parsed output.
> **Replaced with:** Demux once in `publish()` using the subtask-1 Go parser. One parse, one call site, three consumers fed from the parsed output. The browser receives decoded terminal bytes via the existing WS binary frame mechanism (unchanged); control events (`%exit`, `%layout-change`) are sent as JSON WS messages (the browser already handles JSON messages — hello, resize, ack).

### Architecture note: input, resize, and history are Go-side changes

> **Superseded:** Input becomes `send-keys -H` to the target pane rather than raw bytes on the pty. Resize becomes `refresh-client -C <w>,<h>`. Fetch history on attach with `capture-pane -p -S -<n>`.
> **Reason:** These were stated as design goals without specifying WHERE the change happens. Today, the Go host's `write()` (`main.go:335`) does `io.WriteString(t.file, data)` — raw bytes to the pty. The Go host's `ptyResize()` (`ws.go:178`) calls `pty.Setsize()` — a pty ioctl. Neither works when the pty is `tmux -CC attach`: raw bytes go to tmux's control-mode parser (which expects commands, not keystrokes), and a pty ioctl doesn't resize the agent's pane. The changes must be in Go.
> **Replaced with:** (1) `write()` formats keystrokes as `send-keys` commands using a three-way encoder (see Proposed Changes item 3) before writing to the pty stdin. (2) `ptyResize()` (or the WS resize handler) writes `refresh-client -C <w>x<h>\n` to the pty stdin instead of calling `pty.Setsize()`, and the chain sets `window-size manual` so the browser panel has deterministic authority over pane geometry (see Proposed Changes item 4). (3) On attach (or on first `%session-changed`), the Go host sends `capture-pane -t %<pane> -peqJN -S -<n>\n` to the pty stdin and the response arrives as a `%begin`/`%end` block (confirmed from `cmd-capture-pane.c` — never `%output`) that the parser surfaces as output. A second `capture-pane -t %<pane> -p -P -C\n` fetches any pending incomplete escape sequence so the rendered grid and the subsequent `%output` stream agree at the seam. The pane id is learned from the parser's `%output %<pane>` messages — a state dependency: the Go host cannot send `send-keys` until it has seen at least one `%output` with a pane id. The attach command is `tmux -u -CC attach` (the `-u` flag forces UTF-8 mode, preventing `utf8_sanitize` from replacing non-ASCII bytes with `_` in format output — a real hazard on a headless Pi where `LANG` may be unset).

### Architecture note: the chain change is standalone-only

The tmux seating chain (ending `exec tmux attach -t ${view}`) is built in `goPtyFleetProjection.ts`,
which is the **standalone host's** fleet projection. The extension host (`TaskViewerProvider.ts`)
does NOT use `goPtyFleetProjection.ts` — it calls `_ptyHostVerb('ptyCreateTerminal', ...)` directly
and does not build a tmux chain. The extension host has no tmux seating today.

This means:
- The one-line chain change (`exec tmux attach` → `exec tmux -CC attach`) is **standalone-only**.
- The Go pty host's rendering changes (parser, demux, control-event handling) affect **both hosts** — both use the same Go pty host for rendering.
- The "both hosts behave identically" verification is about the Go pty host's rendering, not about the chain building. The extension host's terminals don't use tmux, so they are unaffected by the control-mode switch.

## Complexity Audit

### Routine
- The one-line chain change in `goPtyFleetProjection.ts:308` (`exec tmux attach` → `exec tmux -u -CC attach`).
- Deleting the cosmetic suppressions (`status off`, `prefix None`, `aggressive-resize on`) from the chain — they are no longer needed when tmux stops drawing.
- The contract test `tmux-view-session-chrome-contract.test.js` asserts the current suppressions; it needs updating to assert their absence instead.

### Complex / Risky
- **Demux in `publish()`.** The parser is called once per chunk; its output routes to three consumers. The `rest` (partial-line remainder) is per-terminal state, threaded across `publish()` calls. Getting this wrong means the ring, log, or browser receives corrupted bytes — silently.
- **Input path: three-way `send-keys` encoder.** The Go host's `write()` must classify each code point into one of three encodings (C0 controls → `send-keys -H -t %<pane> NN`, code points ≥ 0x20 that aren't shell-safe → `send-keys -t %<pane> 0xNN`, ASCII alphanumerics → `send-keys -lt %<pane> STRING`), run-length-encode runs of the same kind, and chunk at ~333 bytes per `-H` command (iTerm2's limit). The pane id must be known before any input can be sent — a state dependency on the parser having seen a `%output %<pane>` message. If the pane id is unknown (e.g., the seat hasn't emitted yet), input must be buffered or fail-loud, not silently dropped.
- **Empty line on stdin detaches.** `control_read_callback` treats `*line == '\0'` as `CLIENT_EXIT`. Any code path that writes a bare `\n` — a keepalive, a flush of an empty buffer, a `fmt.Fprintln(stdin, cmd)` where `cmd` is empty — silently kills the session. The Go host must guard against writing bare newlines.
- **Copy mode still intercepts `send-keys -H`.** `cmd_send_keys_inject_key` checks `TAILQ_FIRST(&wp->modes)` first; if the pane is in copy/choose mode the key goes to the mode's key table instead of the pane. If the browser panel is authoritative, the host should keep panes out of modes, or issue `send-keys -X cancel` before forwarding input when `%pane-mode-changed` fires.
- **Resize path: `refresh-client -C` + `window-size manual`.** The Go host's resize handler must write `refresh-client -C <w>x<h>\n` to the pty stdin instead of calling `pty.Setsize()`. A control client is invisible to sizing until it issues its first `refresh-client -C` (confirmed from `resize.c`:`ignore_client_size`). The chain should set `window-size manual` so the browser panel has deterministic authority over pane geometry — under `window-size latest` (the default), a second attached client (SSH) will ping-pong the window size, which is the exact arbitration failure the current `aggressive-resize` workaround exists to manage.
- **History fetch on attach: two `capture-pane` calls.** (1) `capture-pane -t %<pane> -peqJN -S -<n>\n` for the scrollback (flags: `-p` stdout, `-e` escape sequences preserved, `-q` suppress errors, `-J` join wrapped lines, `-N` preserve trailing spaces — gated on ≥3.1, which 3.4 satisfies). The response arrives as a `%begin`/`%end` block (confirmed from `cmd-capture-pane.c` — never `%output`). (2) `capture-pane -t %<pane> -p -P -C\n` for the pending incomplete escape sequence (`-P` captures only the trailing fragment, `-C` octal-escapes non-printables). Without the second call, if a pane is mid-escape-sequence at the moment of capture, the rendered grid and the subsequent `%output` stream disagree — the first `%output` continues a sequence whose prefix was never seen.
- **Control events to the browser.** `%exit`, `%layout-change`, `%window-close` must reach the browser as JSON WS messages so it can render them (e.g., show a stated end state for `%exit`). The WS protocol already handles JSON (hello, resize, ack); a new message type is additive. No `%pane-exited` or `%pane-close` notification exists — pane death surfaces only as `%layout-change` (other panes remain) or `%window-close` (last pane). The host must diff layouts to detect pane lifecycle.
- **The log tee must receive decoded bytes.** If `publish()` demuxes before `logOutput()`, the log gets decoded terminal bytes — the same ANSI-stripped, CR-collapsed transcripts it writes today. If the demux happens after, the log fills with `%output` lines. The ordering in `publish()` is load-bearing.
- **UTF-8 sanitization on format output.** `server_client_print()` calls `utf8_sanitize` on non-ASCII bytes unless `CLIENT_UTF8` is set, replacing them with `_`. `CLIENT_UTF8` is set only if `TMUX` env is set, `-u` is passed, or `LANG`/`LC_ALL`/`LC_CTYPE` contains `UTF-8`. On a headless Pi, `LANG` may be unset. The attach command must be `tmux -u -CC attach` to prevent window names, pane titles, and format output from being sanitised to underscores. (`%output` and `capture-pane` bypass this path and are byte-exact regardless.)
- **`automatic-rename` makes `%window-renamed` chatty.** Every command the agent runs can emit a `%window-renamed` notification. If the board re-renders on rename, debounce it or set `set -g automatic-rename off` in the appliance config.

## Edge-Case & Dependency Audit

**Race Conditions:** The pane-id state dependency: the Go host cannot send `send-keys` until it has learned the pane id from the parser. A keystroke arriving before the first `%output` (or before `%session-changed` reveals the session) must be buffered or fail-loud. Buffering risks silent loss; fail-loud risks a bad first-keystroke experience. The plan must choose.

**Security:** `send-keys -H` sends hex-encoded bytes to the pane. The Go host already has `send-keys -H` logic in `tmuxBackend.ts:494` (over a tmux socket, not control-mode stdin). The hex encoding prevents a typed text from being mistaken for a control command — the same property the plan wants.

**Side Effects:** Deleting `status off`, `prefix None`, and `aggressive-resize on` from the chain changes the tmux session's options. The base session (the one an operator attaches to over SSH) keeps its options — only the view session's suppressions are removed. The contract test `tmux-view-session-chrome-contract.test.js` must be updated to reflect this.

**Dependencies & Conflicts:**
- Depends on subtask 1 (the Go parser) — must land first.
- The `tmux-view-session-chrome-contract.test.js` contract test asserts the current suppressions; it must be updated.
- The `pty-host-blackbox-contract.test.js` test asserts `goPtyFleetProjection.ts` source patterns; it may need updating if the chain changes.
- The Go pty host's `write()` and `ptyResize()` are used by both hosts — changes here affect both.

## Dependencies

- `render-seats-with-tmux-control-mode-not-a-tmux-client.md` — the Go parser (subtask 1, must land first).
- `cmd/switchboard-pty-host/main.go` — `publish()` (demux), `write()` (input), `readOutput()` (attach/history).
- `cmd/switchboard-pty-host/ws.go` — `ptyResize()` (resize), `handleWebSocket()` (control events to browser).
- `cmd/switchboard-pty-host/log.go` — `logOutput()` (receives decoded bytes from `publish()`).
- `src/services/goPtyFleetProjection.ts:308` — the chain change (standalone-only).
- `src/test/tmux-view-session-chrome-contract.test.js` — contract test to update.

## Adversarial Synthesis

Key risks: (1) the demux point was originally specified as three TS call sites but the consumers are in Go's `publish()` — corrected to one Go call site; (2) the input path has a pane-id state dependency — the Go host cannot send `send-keys` until the parser has seen a pane id; (3) the log tee must receive decoded bytes, not raw control protocol — the ordering in `publish()` is load-bearing; (4) the chain change is standalone-only — the extension host has no tmux seating; (5) an empty line on stdin silently detaches — guard against bare newlines; (6) copy mode still intercepts `send-keys -H` — issue `send-keys -X cancel` when `%pane-mode-changed` fires; (7) `window-size latest` (the default) ping-pongs with a second client — set `window-size manual`; (8) a pending incomplete escape sequence at attach time corrupts the first `%output` — fetch with `capture-pane -p -P -C`; (9) UTF-8 sanitization replaces non-ASCII with `_` in format output — use `tmux -u -CC attach`; (10) `capture-pane -S -` can hang on large histories — use a bounded `-S -500`. Mitigations: demux once in `publish()` before any consumer sees the data, buffer or fail-loud on pre-pane-id input, guard against bare newlines, set `window-size manual` + `automatic-rename off`, fetch pending output, use `-u` flag, bound the history fetch, and update the contract tests to assert the new state.

## Proposed Changes

1. **The seat chain: `exec tmux attach -t <view>` becomes `exec tmux -u -CC attach -t <view>`.**
   One line in `goPtyFleetProjection.ts:308`; everything else follows from it. The `-u` flag forces
   UTF-8 mode, preventing `utf8_sanitize` from replacing non-ASCII bytes with `_` in format output
   (window names, pane titles, `list-windows`/`list-panes` output) — a real hazard on a headless Pi
   where `LANG` may be unset. `%output` and `capture-pane` bypass this path and are byte-exact
   regardless. This is standalone-only — the extension host does not build a tmux chain.

2. **Demux once in `publish()`** using the subtask-1 Go parser. The parser is called once per
   chunk; its output routes to all three consumers:
   - **Ring:** decoded output bytes appended to `f.rings[name]` (same `outputEvent` format).
   - **Log:** decoded output bytes passed to `f.logOutput()` (same ANSI stripping, CR collapse).
   - **Browser:** decoded output bytes sent via the existing WS binary frame mechanism
     (`encodeOutputFrame`); control events (`%exit`, `%layout-change`, `%window-close`) sent as
     JSON WS messages (new message type, e.g. `{"t":"control","event":"exit"}`).
   One parse, one call site, three consumers. The `rest` (partial-line remainder) is
   per-terminal state in `publish()`, threaded across calls.

3. **Input becomes a three-way `send-keys` encoder** in the Go host's `write()` (`main.go:335`).
   Today it does `io.WriteString(t.file, data)` — raw bytes to the pty. After the switch, it
   classifies each code point into one of three encodings (matching iTerm2's reference
   implementation):
   - **C0 controls (0x00–0x1F) and 0x7f** → `send-keys -H -t %<pane> NN NN ...\n` (hex bytes,
     `KEYC_LITERAL` — bypasses prefix key and every binding; this is the fix for "prefix eating
     keys"). Chunk at ~333 bytes per command (iTerm2's limit).
   - **Code points ≥ 0x20 that aren't shell-safe** → `send-keys -t %<pane> 0xNNNN ...\n` (Unicode
     code points, UTF-8 encoded by tmux — not bytes). This is the correct path for typed Unicode;
     `-H` would require manual UTF-8 byte splitting.
   - **Runs of ASCII alphanumerics and `+ / ) : , _`** → `send-keys -lt -t %<pane> STRING\n`
     (literal UTF-8 string, fewest bytes on the wire).
   Run-length-encode runs of the same kind and emit one command per run. The pane id is
   per-terminal state, learned from the parser's `%output %<pane>` messages. If the pane id is
   unknown (no `%output` seen yet), input must be buffered or fail-loud — not silently dropped.
   **Guard against bare newlines:** an empty line on stdin detaches the client
   (`control_read_callback` treats `*line == '\0'` as `CLIENT_EXIT`). Never write a bare `\n`
   without a command.

4. **Resize becomes `refresh-client -C <w>x<h>` + `window-size manual`** in the Go host's resize
   path (`ws.go:178`). Today `ptyResize` calls `pty.Setsize(t.file, ...)` — a pty ioctl. After the
   switch, it writes `refresh-client -C <cols>x<rows>\n` to the pty stdin. A control client is
   invisible to sizing until it issues its first `refresh-client -C` (confirmed from
   `resize.c`:`ignore_client_size`). The chain sets `window-size manual` so the browser panel has
   deterministic authority over pane geometry — under `window-size latest` (the default since
   2.9), a second attached client (SSH) will ping-pong the window size, which is the exact
   arbitration failure the current `aggressive-resize` workaround exists to manage. With
   `window-size manual`, `clients_calculate_size` skips the client loop entirely and the window
   uses its `manual_sx/sy`. The `aggressive-resize on` window option is deleted from the chain —
   it only applies under `smallest`/`largest` and is inert under `manual`.

5. **Fetch history on attach with two `capture-pane` calls** (matching iTerm2's reference
   implementation), sent to the pty stdin on first `%session-changed` (or when the pane id is
   first learned):
   - **Scrollback:** `capture-pane -t %<pane> -peqJN -S -<n>\n` — flags: `-p` stdout, `-e` escape
     sequences preserved, `-q` suppress errors, `-J` join wrapped lines, `-N` preserve trailing
     spaces (gated on ≥3.1, which 3.4 satisfies). The response arrives as a `%begin`/`%end` block
     (confirmed from `cmd-capture-pane.c` — never `%output`) that the parser surfaces as output,
     which `publish()` routes to the ring and browser. This is what preserves the 50,000-line
     scrollback without touching `MAX_SCROLLBACK_BYTES` or the client's `scrollback: 1000`. Use a
     bounded `-S -500` rather than `-S -` (which can hang on panes with very large histories).
   - **Pending output:** `capture-pane -t %<pane> -p -P -C\n` — `-P` captures only the trailing
     incomplete escape sequence the pane has received; `-C` octal-escapes non-printables. Without
     this, if a pane is mid-escape-sequence at the moment of capture, the rendered grid and the
     subsequent `%output` stream disagree — the first `%output` continues a sequence whose prefix
     was never seen. Splice the pending fragment in front of the live stream.

6. **Delete the cosmetic suppressions** from the chain in `goPtyFleetProjection.ts` — `status off`,
   `prefix None`, `aggressive-resize on` — once the client renders. The contract test
   `tmux-view-session-chrome-contract.test.js` must be updated to assert their absence (or
   removed if the assertions no longer apply).

7. **Render `%exit`** as a stated end state. The Go host sends `{"t":"control","event":"exit"}`
   (or similar) as a JSON WS message; the browser renders it as a stated end state rather than a
   dead pane. `%exit` can arrive mid-block (it comes from the client process's stdio, not the
   server's buffered output — they are not ordered against each other); the parser force-closes
   any open block and emits the exit event.

8. **Handle copy-mode interception.** `send-keys -H` with `KEYC_LITERAL` bypasses the prefix key
   and every binding, but `cmd_send_keys_inject_key` still checks `TAILQ_FIRST(&wp->modes)` first
   — if the pane is in copy/choose mode, the key goes to the mode's key table instead of the
   agent. The Go host should listen for `%pane-mode-changed` notifications and issue
   `send-keys -t %<pane> -X cancel\n` before forwarding input when a mode is active, or
   configure the pane to never enter copy mode (`set -t %<pane> mode-keys off` is not available,
   but not sending mouse events that trigger copy-mode is sufficient under control mode since the
   browser handles its own scrollback).

9. **Set `window-size manual` and `automatic-rename off`** in the chain. `window-size manual`
   gives the browser panel deterministic authority over pane geometry (see item 4).
   `automatic-rename off` prevents `%window-renamed` from firing on every command the agent runs
   — without it, the notification stream is extremely chatty and any board re-render on rename
   will thrash.

10. **Configure flow control** with `refresh-client -f no-detach-on-destroy,pause-after=30\n`
    sent on attach. Without `pause-after`, if a pane's oldest queued block is more than 300
    seconds old (e.g., a browser panel behind a slow websocket), tmux sets
    `exit_message = "too far behind"`, discards output, and terminates the client. With
    `pause-after=30`, tmux instead sends `%pause %<pane>` and stops queuing for that pane; the
    host resumes with `refresh-client -A '%0:continue'\n` and repairs the pane's content with
    `capture-pane`. `no-detach-on-destroy` prevents the control client from detaching when a
    session is destroyed, which is the agent-exit cascade this feature deliberately does not fix
    but should not worsen.

## Verification Plan

- **No tmux UI:** assert no status line, that a wheel scroll does not enter copy-mode, and that
  `C-b` reaches the agent as a keystroke.
- **Scrollback preserved:** assert a freshly opened panel scrolls back to tmux's history limit
  and matches `capture-pane -p -S -50000` for the same pane.
- **Pending-output splice:** assert that if a pane is mid-escape-sequence at attach time, the
  rendered grid and the subsequent `%output` stream agree at the seam — no corrupted first line.
- **Phone access unchanged:** with a panel open, assert `tmux attach -t <base>` from a second
  client shows the same live seat and behaves as a normal tmux session.
- **Resize arbitration eliminated:** with a panel open and an SSH client attached at a different
  size, assert the panel's pane geometry does not ping-pong — `window-size manual` holds.
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
- **Unicode input:** type a non-ASCII character (e.g. `é`) and assert the agent receives the
  correct UTF-8 bytes — the `0xNN` code-point path, not `-H` byte splitting.
- **Empty-line guard:** assert no code path writes a bare `\n` to the pty stdin — an empty
  command detaches the client.
- **Copy-mode handling:** if a pane enters copy mode (detected via `%pane-mode-changed`), assert
  input is not swallowed — the host issues `send-keys -X cancel` or equivalent before forwarding.
- **Both hosts:** the Go pty host's rendering (parser, demux, control-event handling) is shared
  by both hosts. Assert the extension and standalone hosts behave identically for terminals
  that use control mode. Note: the chain change is standalone-only — the extension host does
  not build a tmux chain, so its terminals are unaffected by the control-mode switch.
- **Contract tests updated:** assert `tmux-view-session-chrome-contract.test.js` reflects the
  new chain (no `status off`, `prefix None`, or `aggressive-resize on` suppressions; `window-size
  manual` and `automatic-rename off` added).
- **Pre-pane-id input:** assert a keystroke arriving before the first `%output` (pane id
  unknown) is handled — buffered or fail-loud, not silently dropped.
- **UTF-8 format output:** assert window names and pane titles containing non-ASCII characters
  are not sanitised to `_` — the `-u` flag on attach prevents this.

### Goal Invariants

- **The panel is not a tmux client:** assert no seat's startup command ends in a bare
  `tmux attach` — a source-level check that survives refactors.
- **tmux still owns the session:** assert `tmux attach -t <base>` reaches a live seat while the
  panel is open, so this cannot quietly become "no tmux".
- **A board restart does not touch a seat:** assert session ids and agent pids are unchanged
  across a restart.
- **All three consumers receive decoded bytes:** assert none of the browser, the ring, or the
  log tee receives raw control protocol — the failure here is silent and shows up as unreadable
  history months later.
- **Scrollback does not regress:** assert reachable history is tmux's limit, not xterm's
  `scrollback` value.
- **Input reaches the agent, not tmux:** assert typed text arrives at the agent via the
  three-way `send-keys` encoder (`-H` for C0, `0xNN` for code points ≥ 0x20, `-lt` for ASCII
  alphanumerics), not as a raw byte to the pty that tmux's control-mode parser would interpret.

## Resolved Assumptions

The following tmux control-mode behaviors were confirmed from the tmux 3.4 source code and
iTerm2's reference implementation during web research. They are authoritative and should not be
re-researched:

- **`send-keys -H` is the correct input path for C0 controls.** Each `-H` argument is parsed with
  `strtol(..., 16)` and rejected unless 0x00–0xff; the value is tagged `KEYC_LITERAL` and written
  as a single raw byte. This bypasses the prefix key and every binding. Multi-byte UTF-8 must be
  sent as one hex argument per byte via `-H`, OR as a `0xNNNN` Unicode code point via the non-`-H`
  path (which tmux UTF-8 encodes). iTerm2 uses a three-way encoder: `-H` for C0, `0xNN` for code
  points ≥ 0x20, `-lt` for ASCII alphanumerics. (Source: `cmd-send-keys.c`, `input-keys.c`,
  `key-string.c` in tmux 3.4; `TmuxGateway.m` in iTerm2.)
- **`send-keys -H` shipped in tmux 3.0a, not 3.0.** The `CHANGES` entry is misfiled under 2.9→3.0
  but the code is absent in the 3.0 tag and present in 3.0a. Irrelevant for the pinned 3.4
  appliance. (Source: tmux 3.0 and 3.0a release tags.)
- **`refresh-client -C` makes a control client count for sizing.** Until the first `-C`, the
  control client is excluded from every size calculation (`ignore_client_size` in `resize.c`).
  After `-C`, `window-size`/`aggressive-resize` apply normally. Three forms accepted: `80x24`,
  `80,24`, and `@0:80x24` (per-window, ships in 3.3; iTerm2 requires 3.4). Bounds 1–10000.
  (Source: `cmd-refresh-client.c`, `resize.c` in tmux 3.4.)
- **`capture-pane -p` output arrives inside a `%begin`/`%end` block**, not as `%output`. The
  entire capture is a single `control_write` call with the trailing newline stripped. Lines
  inside can legitimately begin with `%`. (Source: `cmd-capture-pane.c` in tmux 3.4.)
- **iTerm2 fetches history with `capture-pane -peqJN -t "%<pane>" -S -<maxHistory>`** and fetches
  pending output with `capture-pane -p -P -C -t "%<pane>"`. The pending-output fetch is required
  to splice mid-escape-sequence fragments. (Source: `TmuxWindowOpener.m` in iTerm2.)
- **No `%pane-exited` or `%pane-close` notification exists.** Pane death surfaces only as
  `%layout-change` (other panes remain) or `%window-close` (last pane). (Source:
  `control-notify.c` in tmux 3.4.)
- **No handshake is required beyond `-CC`.** The DCS (`\033P1000p`) is emitted automatically;
  tmux does not read stdin until the attach completes. (Source: `control.c`, `server-client.c`
  in tmux 3.4.)
- **CRLF line terminators on the pty.** tmux 3.4 sets `c_oflag = OPOST|ONLCR` on the `-CC` tty.
  Control lines arrive as `\r\n`. iTerm2 strips CR in two places. (Source: `client.c` in tmux
  3.4; `VT100TmuxParser.m` in iTerm2.)
- **Empty line on stdin detaches.** `control_read_callback` treats `*line == '\0'` as
  `CLIENT_EXIT`. (Source: `control.c` in tmux 3.4.)
- **Copy mode intercepts `send-keys -H`.** `cmd_send_keys_inject_key` checks pane modes first.
  (Source: `cmd-send-keys.c` in tmux 3.4.)
- **`window-size latest` (the default) ping-pongs with a second client.** `window-size manual`
  gives deterministic authority. `aggressive-resize` is inert under `manual`. (Source: `resize.c`
  in tmux 3.4.)
- **UTF-8 sanitization on format output.** `server_client_print()` calls `utf8_sanitize` unless
  `CLIENT_UTF8` is set. Use `tmux -u -CC attach` or set `LANG=C.UTF-8`. (Source:
  `server-client.c`, `tmux.c` in tmux 3.4.)
- **Command length limits.** iTerm2 caps at ~333 bytes per `-H` command, ~125 code points per
  `0xNN` command, 1000 characters per `-l` command. (Source: `TmuxGateway.m` in iTerm2.)
- **`%exit` comes from the client process, not the server.** It is not ordered against
  server-buffered output and can arrive mid-block. (Source: `client.c` in tmux 3.4; iTerm2
  `TmuxGateway.m`.)
- **Flow control.** Without `pause-after`, tmux kills a client whose oldest queued block exceeds
  300 seconds (`CONTROL_MAXIMUM_AGE`). With `pause-after=<n>`, tmux sends `%pause` and stops
  queuing; resume with `refresh-client -A '%n:continue'`. (Source: `control.c` in tmux 3.4.)
- **`if-shell` and `run-shell` block the command queue.** Never put them on control-mode stdin —
  they stall every subsequent command including `send-keys`. (Source: tmux 3.4 architecture;
  iTerm2 design notes.)
- **`automatic-rename` makes `%window-renamed` fire on every command.** Set `automatic-rename off`
  to avoid notification thrash. (Source: tmux 3.4 `options-table.c`; community corroboration.)

---

## Implementation Summary

Subtask 2 implemented. The standalone seat chain in `goPtyFleetProjection.ts` now ends with `exec tmux -u -CC attach -t ${view}`; the three per-view suppressions (`status off`, `prefix None`, `aggressive-resize on`) are deleted and replaced with `window-size manual` and `automatic-rename off`. A new `controlmode_io.go` wires the parser from subtask 1 into `fleet.publish()`: each chunk is demuxed once, decoded `%output` bytes route to the ring, log, and browser, and control notifications (`%exit`, `%session-changed`, `%layout-change`, `%pane-mode-changed`, etc.) forward to the browser as JSON WS messages. Input is encoded via the three-way `send-keys` encoder (hex bytes for C0/0x7f, Unicode code points for non-literal runes, literal UTF-8 for safe ASCII), with a `controlActive` runtime gate that stays raw until tmux's DCS entry is actually seen so the startup chain reaches the shell verbatim. Resize uses `refresh-client -C` instead of `pty.Setsize`, and history is fetched on first pane-id discovery via bounded `capture-pane -peqJN -S -500` plus `capture-pane -p -P -C` for the pending escape fragment. The `tmux-view-session-chrome-contract.test.js` now asserts the new chain and the absence of the removed suppressions.

## Review Findings

The cutover wired all three consumers correctly but routed the wrong bytes to them. `%output` was
emitted to `t.emit`/`routeOutput` with no filter against the learned `t.paneID`, and a view session
is GROUPED with its team base — verified on tmux 3.4 that one `-CC` client receives every pane's
output — so each seat in a four-seat team rendered and transcribed all four agents, destroying the
per-seat diagnostic record the feature depends on; output is now filtered on `t.paneID`, and the
`list-panes` reply was made authoritative so a foreign first `%output` can no longer latch the
seat onto the wrong pane permanently. Separately `%pause` had no handler and the host never sent
`refresh-client -A`, so the `pause-after=30` this code arms would silence a lagging seat forever;
it now resumes. Files changed: `cmd/switchboard-pty-host/main.go`,
`.github/workflows/integration-tests.yml` (the plan's own acceptance gate
`test:contract:tmux-view-chrome` was defined at `package.json:1012` and invoked by nothing).
Validation: `tmux-view-chrome` 8/8, `tmux-backend`, `pty-host-gating`, `compile-tests` green;
`pty-route-surface` 7-red is pre-existing and unrelated.

## Deferred Findings

- MAJOR: Go changes not compile-verified locally (no Go toolchain on this host). `cmd/switchboard-pty-host/main.go:1`
- MAJOR: No automated check exercises the live control-mode attach path; the acceptance items "typed hello/world arrives exactly", "`/` does not clear the line", "unicode input", "window-size manual holds" and "board restart leaves pids unchanged" were NOT executed in this pass. Passing the unit and source-text suites is not evidence the core mechanism works. `switch-seats-to-control-mode-and-repoint-the-three-consumers.md:1`
- MAJOR: Pane-id filtering does not apply before the id is learned, so the first bytes after attach are unfiltered in a grouped session. `cmd/switchboard-pty-host/main.go:303`
- NIT: `%pause` auto-resume makes the requested backpressure vestigial. `cmd/switchboard-pty-host/main.go:396`