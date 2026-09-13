# Attach a Seat From Any Terminal Client, Without tmux

## Goal

`switchboard attach <seat>` opens a live, interactive view of a running seat in whatever
terminal the operator is sitting in — an SSH session, a phone terminal app, a second local
window. tmux stops being the mechanism for that, and becomes an opt-in preference for people
who want a multiplexer.

### What tmux is actually for here

tmux was adopted so the product could be used from any terminal client. Persistence came
with it, was never the requirement, and is what has gone wrong: sessions accumulate, orphans
outlive their seats, and a seat's identity now depends on tmux state that nothing reconciles.

Every tmux defect on the board traces to the persistence half, not the viewing half:

| Defect | Cause |
| :--- | :--- |
| Twelve control-mode protocol defects in one day | a parser between the agent and the screen |
| Windows stacking three generations deep | window names reused across restarts |
| The lead pane frozen at 59x24 | `window-size manual` + a resize that never reached the window |
| coder-1's prompts typed into coder-2 | grouped sessions each keep their own current window |
| Session sprawl, orphans, a reaper | nothing prunes a session when its seat goes |

None of those exist in "show me this pty in my terminal".

### The viewing surface already exists

The pty host serves `GET /ws/terminal?token=<token>&name=<seat>` (`ws.go`,
`handleWebSocket`). On connect it sends a `hello` carrying `replayChars`, then one coalesced
binary replay frame of the ring, then live output. Input is binary frames; resize is
`{t:'resize',cols,rows,rendered:true}`. The browser panel is built on exactly this, and
`ws_race_test.go` already drives it from Go.

The credentials are on disk: `.switchboard/pty-host-state.json` carries `port` and `token`,
written by every host at startup (`main.go`, `stateFilePayload`).

So the missing piece is a terminal-side client, not a protocol, not a server, and not a
multiplexer. `cmd/switchboard` is 446 lines of Go and `gorilla/websocket` is already a
module dependency.

### Why this is better than tmux at the job tmux was hired for

- **Nothing persists, so nothing leaks.** Detaching closes a WebSocket. There is no session
  to orphan, no window list to reconcile, no reaper.
- **No routing to get wrong.** The seat is addressed by name in the query string. There is
  no shared window list and no per-session current-window pointer — the two things that put
  coder-1's prompts into coder-2.
- **Many viewers already work.** `f.clients[name]` is a set and `publish` fans out to all of
  them; the browser and a terminal can watch the same seat simultaneously, today.
- **Scrollback is already served, in three tiers** — see below.
- **Sizing has one authority.** The attach client sends its own size; there is no second
  client to arbitrate against, which is the whole reason `window-size manual` existed.

### Scrollback, which is the part this trades on

There are three different things called scrollback here, and only one of them is a gap.

| Tier | What holds it | Size | Covers |
| :--- | :--- | :--- | :--- |
| Live, while attached | the operator's own terminal client | whatever it is set to | scrolling, search, mouse selection, copy |
| Paint-on-connect | the host ring (`main.go:874`) | **256 KB** raw bytes | arriving at a seat mid-session |
| Deep history | `.switchboard/logs/<seat>-<ts>.md` (`log.go`) | **10 MB** per session, then rolled | anything older |

**Live scrolling is the client's job, and it does it better than tmux.** Bytes written to a
normal screen land in the terminal emulator's own scrollback, where the operator's existing
scroll gesture, search and copy already work — no prefix key, no mode to enter and leave,
and it works on a phone where tmux copy-mode is close to unusable.

**The alternate screen is the honest caveat.** When a CLI sends `?1049h` its output never
enters the client's scrollback — that is the terminal's design, and tmux does not fix it
either (copy-mode inside an alternate screen shows only that screen and cannot reach the
main history). The agent CLIs draw their transcript on the normal screen with a redrawn
composer pinned at the bottom, so the common case is covered; a full-screen pager or editor
inside a seat is not scrollable by either mechanism.

**The pre-attach window is the one real number to weigh.** 256 KB at ~96 columns is roughly
800–1500 rendered lines once ANSI overhead is counted, against tmux's default
`history-limit` of 2000 lines per pane. Comparable, and the seating chain's
`capture-pane -S -50000` was already asking for more than tmux's default retains.

**Deep history is where this wins outright.** The host already writes a per-session log per
seat and has for months: 481 files and 311 MB on this machine right now, with individual
sessions at the full 10 MB cap. tmux has no equivalent — its history dies with the server,
which is exactly what makes "my agent said something an hour ago" unanswerable today.

### Non-goals

- **Persistence.** A seat does not outlive the pty host, and this plan does not try to make
  it. `switchboard.terminal.fleet.surviveBoard` already exists for anyone who wants it and
  is unchanged here.
- **Reimplementing a multiplexer.** No windows, no splits, no detach-and-reattach-later
  semantics. One command, one seat, one screen. Use the seat list to pick another.
- **Removing tmux.** Seating stays available behind `switchboard.terminal.tmux.enabled`.
  This plan changes its default and its status, not its existence.

## Metadata

- **Complexity:** 6
- **Tags:** cli, feature, refactor

## User Review Required

None.

## Complexity Audit

### Routine

- Dialing an existing WebSocket endpoint (`ws.go` `handleWebSocket`) whose frame contract is
  already exercised by `ws_race_test.go` — no protocol work, only a client.
- Reading `port`/`token` from `.switchboard/pty-host-state.json` — a flat JSON file written by
  every host at startup (`main.go:1505`).
- `switchboard history <seat>` — paging a file that already exists on disk
  (`.switchboard/logs/<seat>-<ts>.md`, `log.go`); the only logic is resolving the newest
  session log and `--session <n>` indexing into rolled predecessors.
- Flipping `switchboard.terminal.tmux.enabled` to `false` by default — a one-line schema
  change in `package.json` plus the standalone/extension config reads.
- Adding the attach hint to the startup banner — a one-line print next to the existing URL.

### Complex / Risky

- **Answerback suppression on a raw terminal.** The browser clears `suppressAnswerback`
  inside xterm.js's write callback (`terminalViewport.js:994`); a raw terminal has no
  callback, so the suppression window's upper bound is a timing decision, not a parse
  boundary. Get it wrong in either direction and you either inject garbage into the agent
  (too short) or eat the operator's first keystroke (too long).
- **Adding `golang.org/x/term` as a new module dependency.** It is not in the module graph
  today (see Superseded callout in §1); adding it changes the build and the cross-compile
  set for the Pi target.
- **The tmux default flip interacts with the legacy `terminalBackend` migration.**
  `bootstrap.ts:4487-4489` re-promotes legacy `terminalBackend: 'tmux'` users to
  `terminal.tmux.enabled: true` on every boot. The plan's default flip does not reach those
  users unless the migration is also updated — and updating it changes behaviour for an
  install base that explicitly chose tmux.

## Edge-Case & Dependency Audit

### Race Conditions

- **Answerback vs. first keystroke.** Device-query answers arrive as a burst right after the
  replay is written. The plan closes the suppression window on the first non-matching input.
  If the operator types during the burst, the first real keystroke closes the window and a
  trailing (delayed) answerback leaks through to the agent. Mitigation: the window should
  also close on a bounded timer (the "short settle"), not solely on first non-match input.
- **Replay vs. live frame boundary.** The host sends `hello` + one coalesced replay frame
  back-to-back under the write lock (`ws.go:128-136`); a live `publish` cannot interleave.
  The attach client must consume exactly `replayChars` worth of the replay frame before
  treating subsequent binary frames as live — same contract the browser honours.

### Security

- The pty host binds `127.0.0.1:0` (loopback only). The attach client must be on the same
  machine as the host — consistent with the Pi appliance model (operator SSHes in, then
  attaches). No remote exposure is added.
- The state file is `0o600` and carries the pty-host token. The attach client reads it with
  the operator's own privileges; no new surface is exposed.

### Side Effects

- Detach closes a WebSocket; the host's `removeClient` drops the viewer from
  `f.clients[name]`. No session, no window, no reaper — the seat is untouched.
- The tmux default flip changes behaviour for any user who never explicitly set
  `terminal.tmux.enabled` and relied on the `true` default. Explicit settings are preserved
  by `configProvider`; only the unset default changes.

### Dependencies & Conflicts

- `golang.org/x/term` is a **new** direct dependency (not already in the graph — see
  Superseded callout). It pulls in `golang.org/x/sys`. Both are pure Go and cross-compile to
  `linux/arm64` for the Pi.
- `gorilla/websocket` is already a direct dependency (`go.mod`) and is what the attach
  client dials with.
- The `attach`, `seats`/`history` verbs must be added to the `ownedVerbs` map in
  `cmd/switchboard/main.go:22` — without that, the Go client delegates them to the Node
  host instead of serving them itself.

## Dependencies

None — this plan depends on no other plan or session.

## Adversarial Synthesis

Key risks: (1) the answerback suppression window on a raw terminal has no parse-boundary
callback to anchor it, so the "short settle" is a timing guess that can either leak garbage
into the agent or eat a keystroke; (2) `golang.org/x/term` is a new dependency the plan
mis-identifies as already present; (3) the tmux default flip is silently defeated for legacy
users by the `bootstrap.ts` `terminalBackend` migration the plan does not touch; (4)
`switchboard seats` duplicates the existing `switchboard fleet` verb. Mitigations: bound
the suppression window with a timer in addition to first-non-match; correct the dependency
claim and add the module explicitly; acknowledge the migration interaction and decide
whether legacy users keep tmux (recommended — preserve their explicit choice); alias
`seats` to `fleet` rather than building a parallel verb.

## Proposed Changes

### 1. `switchboard attach <seat>`

A new verb in `cmd/switchboard`. It resolves `port` and `token` from
`.switchboard/pty-host-state.json`, dials
`ws://127.0.0.1:<port>/ws/terminal?token=<token>&name=<seat>`, and then:

- reads the `hello`, consumes `replayChars` worth of replay as the initial paint, and writes
  it to stdout before anything else — so the operator arrives at the seat's current screen,
  not a blank one;
- puts stdin in raw mode and forwards every byte as a binary frame;
- sends a `resize` frame at start and on `SIGWINCH`;
- restores the terminal on exit through a deferred restore that also runs on `SIGINT`/
  `SIGTERM`, because a client that leaves the operator's shell in raw mode is worse than one
  that never started.

Detach is an escape sequence, not Ctrl-C: Ctrl-C must reach the agent, which is the point of
raw mode. Use `Ctrl-\` followed by `q` — two keys, neither of which any CLI binds — and
print the detach key in the hello banner so it is discoverable without documentation.

> **Superseded:** `golang.org/x/term` is added for raw mode and size; it is the standard
> library-adjacent answer and already an indirect dependency of the module graph.
>
> **Reason:** Verified against the actual module graph: `go.mod` lists only
> `github.com/creack/pty` and `github.com/gorilla/websocket`; `go.sum` is 4 lines with no
> `golang.org/x/term` or `golang.org/x/sys` entry; `go list -m all` confirms the graph is
> exactly three modules. `golang.org/x/term` is **not** present, directly or indirectly. The
> claim that it is "already an indirect dependency" is false — adding it is a new direct
> dependency that also pulls in `golang.org/x/sys`.
>
> **Replaced with:** Add `golang.org/x/term` as a new direct dependency (`go get
> golang.org/x/term@latest`), which also brings in `golang.org/x/sys`. Both are pure Go and
> cross-compile cleanly to `linux/arm64` for the Pi target. Alternatively, raw mode and
> terminal size can be obtained via `golang.org/x/sys/unix` termios ioctls directly (one
> fewer module), but `x/term`'s `MakeRaw`/`GetState`/`Restore` and `GetSize` are the
> idiomatic choice and worth the one extra module.

**Implementation detail — workspace-root resolution.** The state file lives at
`<workspace-root>/.switchboard/pty-host-state.json` (`main.go:1499`). The attach verb must
resolve the workspace root before it can read the file. Reuse the existing Go-client
machinery: `ResolveEndpoint` + `ResolveServerRoot` (already used by every owned verb in
`runOwnedVerb`, `cmd/switchboard/main.go:97-135`) resolve the board endpoint and its
advertised root; then read `<root>/.switchboard/pty-host-state.json` for `port` and
`token`. This keeps attach consistent with the other owned verbs and avoids a separate
root-discovery path. (An alternative is to dial the board's own `/ws/terminal` listener,
which proxies the upgrade to the pty host — `LocalApiServer.ts:1322` — but that adds a hop
and requires the board's auth token; the direct loopback dial is simpler and the pty host's
`CheckOrigin` already accepts an empty Origin for CLI clients, `ws.go:31`.)

**Implementation detail — `ownedVerbs`.** Add `attach`, `seats`, and `history` to the
`ownedVerbs` map (`cmd/switchboard/main.go:22`) and to the `dispatchOwned` switch
(`cmd/switchboard/main.go:172`). Without this the verbs fall through to the Node host
delegation arm and never reach the Go client.

### 2. Suppress answerback across the replay, or every attach types garbage

The replay frame is raw agent output, so it carries whatever device queries the CLI emitted
during the session — OSC colour queries, `ESC[c` (DA), `ESC[6n` (DSR). Writing those to a
terminal makes it **answer** them, and the answer arrives on stdin, which this client
forwards to the agent. Every attach would inject a burst of `ESC[?62;...c` into the seat as
though the operator had typed it.

This is not hypothetical and it is already solved once: `terminalViewport.js:994` sets
`suppressAnswerback` for the duration of the replay parse and drops matching input, against

```js
const ANSWERBACK_RE = /^(?:\x1b\][\s\S]*|\x1bP[\s\S]*|\x1b\[[?>]?[0-9;]*(?:[cnR]|\$y))$/;
```

A raw terminal is **more** exposed than xterm.js, not less: it is a real emulator and will
certainly reply. Port that exact regex to Go and apply it to stdin from connect until the
replay has been written plus a short settle, closing the window early on the first input
that does not match. Suppress on the INPUT side, as the browser does — do not try to strip
query sequences out of the replay, which mangles legitimate output and cannot be tested
against a fixture of real agent bytes.

> **Clarification (answerback window boundary):** The browser clears
> `suppressAnswerback` inside xterm.js's async write callback (`terminalViewport.js:997`),
> which fires when the replay has been fully parsed. A raw terminal offers no such
> callback — bytes are written to stdout and the terminal parses them asynchronously. The
> "short settle" must therefore be a **bounded timer** (e.g. 200–500 ms after the last
> replay byte is written), combined with the first-non-match-input early-close. The timer is
> the upper bound that prevents a delayed answerback from leaking if the operator never
> types; the first-non-match close is the fast path. Without the timer, a quiet seat with a
> slow terminal emulator could leak a late answerback after the operator's first keystroke
> already closed the input-side window.

Pin it with a test that feeds a replay containing a DA query and asserts nothing is written
back to the host.

### 3. `switchboard seats` — the list you attach from

`ptyListTerminals` already returns names, roles and status. Surface it as a plain table so
`switchboard seats` then `switchboard attach <name>` is the whole workflow over SSH. `--json`
for scripting, consistent with the existing CLI verbs.

> **Clarification (`seats` vs the existing `fleet` verb):** The Go client **already** has a
> `fleet` verb (`internal/client/verbs.go:566` `CmdFleet`) that calls
> `/terminals/verb/ptyListTerminals` and renders a `SEAT | ROLE | STATUS | CURRENT PLAN /
> TASK` table with `--json` support — exactly the surface §3 describes. Building a
> parallel `seats` verb would duplicate `fleet` and create a divergence with no benefit.
> **Replaced with:** Make `seats` a thin alias for `fleet` (add `"seats": true` to
> `ownedVerbs` and route it to `CmdFleet` in `dispatchOwned`), so the attach workflow reads
> naturally as `switchboard seats` → `switchboard attach <name>` without forking the
> listing implementation. If a distinct verb is still wanted, justify why `fleet` is
> insufficient — but do not build two verbs that call the same endpoint and render the same
> table.

### 4. tmux seating becomes opt-in

Flip `switchboard.terminal.tmux.enabled` to `false` by default and rewrite its description
to say what it is now for — a multiplexer for people who want one — rather than implying it
is how remote viewing works.

This is a clean break: teams have never shipped, and a seat created without tmux simply has
an empty `tmuxSession`/`tmuxWindow`, which every tmux path already treats as "not
tmux-backed" (`close()`, `resizeTmuxWindow`, `ensureTmuxRouting` all test exactly that).

> **Clarification (interaction with the legacy `terminalBackend` migration):** The default
> flip lives in two places that must change together: the `package.json` schema default
> (`package.json:380`, currently `true`) and the standalone/extension config reads
> (`bootstrap.ts:4514`, `cli.ts:4752`, `extension.ts` — all pass `true` as the fallback).
> Additionally, `bootstrap.ts:4487-4489` runs a migration that re-promotes any legacy
> `terminalBackend: 'tmux'` user to `terminal.tmux.enabled: true` on every boot. That
> migration **defeats** the new default for those users. This is arguably correct — it
> preserves the explicit intent of a user who chose tmux — but the plan must state it
> rather than imply the flip reaches everyone. If the intent is to turn tmux off for legacy
> users too, the migration must be updated or removed; if the intent is to preserve their
> choice, leave the migration and document that only new installs get the `false` default.
> Recommended: leave the migration (preserve explicit choice), flip only the schema default
> and the `getConfigBoolean` fallbacks for new installs.

### 5. `switchboard history <seat>` — reach the deep log

The per-session logs already exist and nothing surfaces them. Add a verb that resolves the
seat's current session log and pages it (honouring `$PAGER`, defaulting to plain stdout so
it pipes), with `--session <n>` to reach a rolled predecessor and `--follow` to tail.

This is the tier tmux never had, and it is the answer to "scroll back further than the
ring": not a bigger buffer, a file that was already on disk.

### 6. Say where the seat can be reached

The board's startup banner already prints its URL. Add the attach hint — `switchboard
attach <seat>` — next to it, so the terminal path is discoverable from the thing an operator
already reads on boot.

## Verification Plan

### Automated Tests

1. **New** `src/test/cli-attach-contract.test.js`, wired as `test:contract:cli-attach` **and
   invoked from `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is not
   a gate. Spawns a real pty host, creates a seat, runs `switchboard attach` against a pty,
   asserts: the replay paints before live output; a keystroke reaches the agent; a `SIGWINCH`
   produces a resize frame; exit restores cooked mode.
2. **Go test** over the detach sequence: `Ctrl-\ q` detaches, and `Ctrl-\` followed by
   anything else is forwarded to the agent verbatim — a detach key that eats a legitimate
   keystroke is worse than a longer one.
3. Assert `switchboard history` resolves the newest session log for a seat, and that
   `--session 1` reaches the rolled predecessor rather than silently returning the newest.
4. Assert two simultaneous clients on one seat both receive output, pinning the fan-out this
   plan depends on (`f.clients[name]` is already a set; the test stops a future change from
   making it single-client).
5. Regression: `test:contract:pty-host-blackbox`, `test:contract:tmux-view-chrome`,
   `go test ./cmd/...`, `gofmt -l ./cmd`.

### Goal Invariants

- From an SSH session on another machine, `switchboard seats` then `switchboard attach
  <name>` shows the live seat and accepts typing. Verified by doing it, not by reasoning
  about it.
- Ctrl-C typed into an attached seat interrupts the **agent**, not the attach client.
- Attaching to a seat whose ring contains a device query sends **zero** bytes to the agent.
  Verified by attaching to a seat with a real CLI banner in its ring and watching the host's
  write path, not by reasoning about which queries a CLI emits.
- Detaching leaves the agent running and the seat unchanged — no session, no window, nothing
  to clean up afterwards. `tmux ls` is unchanged by an attach/detach cycle.
- Arriving at a busy seat paints its recent screen from the ring, and scrolling up in the
  operator's own terminal reaches everything that arrived since attaching.
- `switchboard history <seat>` reaches output older than the ring, including from a previous
  rolled session.
- The browser panel and a terminal client can watch the same seat at once, and both see the
  same output.
- With tmux disabled, starting a team creates zero tmux sessions and every seat is still
  fully usable from both the browser and `switchboard attach`.
