# The Pty Host Writes One WebSocket From Two Goroutines, and the Compressor Panics

## Goal

Every write to a pty-host terminal WebSocket is serialised per connection, so a client
subscribing while its terminal is producing output can neither corrupt the shared deflate
compressor nor receive a live frame where the replay frame belongs. The Go host survives a
subscribe-under-load storm with the race detector clean.

### Problem analysis

On 2026-09-12 at ~10:30 the Go pty host died with a panic raised inside Go's standard
library, not inside Switchboard code:

```
panic: runtime error: slice bounds out of range [:254] with capacity 196
compress/flate.(*deflateFast).matchLen           deflatefast.go:221
compress/flate.(*compressor).encSpeed            deflate.go:359
compress/flate.(*compressor).syncFlush           deflate.go:561
gorilla/websocket.(*flateWriteWrapper).Close     compression.go:109
gorilla/websocket.(*Conn).beginMessage           conn.go:480
gorilla/websocket.(*Conn).WriteMessage           conn.go:773
main.(*fleet).publish                            cmd/switchboard-pty-host/main.go:246
main.(*fleet).readOutput                         cmd/switchboard-pty-host/main.go:198
created by main.(*fleet).create in goroutine 26
```

`compress/flate` does not panic on well-formed input — it is among the most exercised
packages in the stdlib. A `slice bounds out of range` inside `deflateFast.matchLen` means
the compressor's internal match table was mutated by two goroutines at once.

> **Note (line-number drift):** The panic stack trace above is a verbatim record from
> the pre-refactor code, where the fan-out `WriteMessage` lived inside `publish` at
> `main.go:246`. The code has since been refactored: `publish` was split into `publish`
> (the control-mode demux) and `routeOutput` (the fan-out), so the panicking
> `WriteMessage` is now in `routeOutput` at `main.go:558`. All line references below are
> updated to the current source; the stack trace is preserved as-is because it is a
> factual log, not a reasoning output.

`ws.go:18` sets `EnableCompression: true`, so every upgraded connection carries one shared
`flateWriteWrapper`. gorilla/websocket's documented contract is **at most one concurrent
writer per connection** (`NextWriter`, `WriteMessage`, `WriteJSON`, `SetWriteDeadline`,
`EnableWriteCompression`, `SetCompressionLevel`). Nothing in the host enforces it. Every
write site, and the goroutine that owns it:

| Site | Call | Goroutine |
| :--- | :--- | :--- |
| `ws.go:99` | `conn.WriteJSON(hello)` | HTTP upgrade handler |
| `ws.go:104` | `conn.WriteMessage(replay)` | HTTP upgrade handler |
| `main.go:261` | `client.WriteJSON({"t":"exit"})` | `readOutput` (EOF path) |
| `main.go:519` | `client.WriteJSON(control event)` | `broadcastControl` ← `readOutput` |
| `main.go:558` | `client.WriteMessage(output)` | `routeOutput` ← `readOutput` — **the panicking site** |
| `main.go:583` | `client.WriteJSON({"t":"exit"})` | `close` (HTTP handler / `dispose`) |

> **Superseded:** The original table listed five write sites (`ws.go:98`, `ws.go:103`,
> `main.go:209`, `main.go:246`, `main.go:271`) and omitted `broadcastControl`.
> **Reason:** The code was refactored (`publish` → `publish` + `routeOutput`), shifting
> every `main.go` line number, and `broadcastControl` (main.go:519) was missed entirely
> — it writes JSON to every client from the `readOutput` goroutine and races with the
> upgrade handler and `close` the same way `routeOutput` does. The map-type-change
> mitigation catches it at compile time, but the enumeration must be complete.
> **Replaced with:** The six-row table above, with current line numbers and
> `broadcastControl` included.

The host holds three mutexes — `f.mu` (main.go:89, `sync.RWMutex`), `listenersMu`
(:48), `logMu` (:94) — and every one of them guards a **map**. None guards a
connection, and `f.mu` is deliberately released before each write so that slow IO
cannot stall the fleet:

```go
clients := make([]*websocket.Conn, 0, len(f.clients[name]))
for client := range f.clients[name] { clients = append(clients, client) }
f.mu.Unlock()                                    // main.go:552 (routeOutput)
for _, client := range clients {
    if err := client.WriteMessage(websocket.BinaryMessage, ...); err != nil {   // :558
```

**The window.** `handleWebSocket` registers the connection as publishable *before* it
writes its own handshake:

```go
f.mu.Lock()
f.clients[name][conn] = struct{}{}   // ws.go:71 — publishable from this instant
replay := append([]outputEvent(nil), f.rings[name]...)
f.mu.Unlock()                        // ws.go:73
...
_ = conn.WriteJSON(...hello...)      // ws.go:99
_ = conn.WriteMessage(binary replay) // ws.go:104
```

Between `ws.go:71` and `ws.go:104` the terminal's own `readOutput` goroutine may call
`publish` → `routeOutput` (or `broadcastControl`) and write to that same connection.
Two writers, one compressor, corrupted state.

**A second defect lives in the same window, and it is a protocol violation rather than a
crash.** `ws.go` states the client contract explicitly: *"the NEXT binary frame after hello
is the replay, and nothing else can be"* — `terminals.js` arms `awaitingReplayFrame` from
`hello.replayChars` and routes the next binary frame through `writeReplay()`, which sets
`suppressAnswerback` while the scrollback is parsed. A live `routeOutput` frame landing
between `ws.go:99` and `ws.go:104` is therefore consumed *as the replay*: the real scrollback is
then treated as live output, and the OSC 10/11 colour queries buried in it get answered
straight back into the pty. Serialising the writes fixes both, because the ordering
guarantee and the memory-safety guarantee are the same lock.

**Why it presents as intermittent.** The race needs live output to land inside a
sub-millisecond subscribe window, so it scales with seat count, output volume and
reconnect churn. The host log immediately before the panic is a reconnect storm — four
`[wsHub] connection closed` / `reaping connection with no pong` lines in the preceding
instants — against a `devin` seat that had been emitting output. Compression does not cause
the bug; it converts an already-invalid concurrent write into a fatal one instead of merely
interleaved frames.

**Blast radius.** The panic kills the whole host process, so every seat's stream drops at
once. The supervisor respawns it, and the replacement logs `State file records a
non-surviving host; not adopting.` and comes up with an empty fleet — the board renders
zero terminals while the tmux sessions and agent processes are all still alive.

## Metadata

- **Complexity:** 4
- **Tags:** pty-host, go, websocket, concurrency

## User Review Required

None.

## Approach

Introduce a per-connection write lock and route every write through it. A `wsClient`
wrapper owning the `*websocket.Conn` plus a `sync.Mutex` replaces the bare `*websocket.Conn`
in the fleet's client maps, so the compiler finds every call site rather than leaving one
to be spotted by review.

Serialising with a lock is chosen over the alternatives:

- **A per-connection writer goroutine with a send channel** is the other correct design,
  but it needs a buffering and drop policy for a slow client, which is a behaviour change
  to terminal streaming. The mutex preserves today's semantics exactly — a slow client
  blocks its own writer and nothing else, because `routeOutput` already iterates a snapshot
  taken outside `f.mu`.
- **Disabling `EnableCompression`** would stop the panic while leaving the data race and
  the replay-ordering defect intact. It also costs real bandwidth on the tailnet path.
  Rejected: it hides the bug rather than fixing it.

Taking the connection's write lock across the hello *and* replay frames as one critical
section is what restores the client contract: `routeOutput` blocks until the replay has
landed, so the first live frame can only arrive after it. `lastSeq`/`event.Seq` already
make the boundary idempotent, so no output is duplicated or lost by the wait.

The Go binary is the single implementation behind **both composition roots** — `extension.ts`
(`:1030`, `taskViewerProvider.setPtyHostSupervisor(new PtyHostSupervisor({...}))`) and
`standalone/bootstrap.ts` (`:1620-1626`, the same construction) both spawn
`dist/<platform>/switchboard-pty-host` through `PtyHostSupervisor`. One diff therefore lands
in both hosts, and the verification below covers both by exercising the shared binary. There
is no TypeScript-side counterpart to keep in step, and no host-specific arm to mirror.

## Complexity Audit

### Routine

- The wrapper type and the mutex are a mechanical transformation of six call sites
  (the five originally listed plus `broadcastControl` at `main.go:519`).
- The map type change (`map[*websocket.Conn]struct{}` → `map[*wsClient]struct{}`) is
  compiler-enforced; nothing can be missed silently.
- `removeClient`, `close` and the alias/rename path keep their existing shape — they move
  map entries, and the entry is now a pointer to a wrapper rather than to a conn.

### Complex / Risky

- **Lock ordering.** The write lock must never be taken while `f.mu` is held, or a slow
  client write would stall the whole fleet — exactly the stall `f.mu.Unlock()` at
  `main.go:552` (in `routeOutput`) exists to prevent. The rule is one-directional: `f.mu`
  may be released before taking a write lock, never the reverse. No code path needs both.
- **`close()` writing an exit frame while `routeOutput` is mid-write** is the same race in
  a different pair of goroutines. It is fixed by the same lock, but it means `close` can
  now block briefly behind an in-flight output write; that is correct and bounded by the
  socket write deadline.
- The alias path (`main.go:795-796`) aliases one client map under two names and then deletes
  the old key under `f.mu`. It is not a lasting second writer and needs no change — noted
  because it looks like one on first reading.

## Edge-Case & Dependency Audit

**Race conditions:** the defect *is* the race. The fix is only demonstrated by the Go race
detector under concurrent subscribe + publish; a passing functional test proves nothing
here, because the current code passes every functional test today.

**Slow/dead clients:** a client that stops reading fills its socket buffer and blocks its
own write until the deadline, now while holding its write lock. `routeOutput` then blocks
on that one client. This is already true of the current code (the blocking `WriteMessage`
is unchanged); the lock does not widen it, because the lock is per connection and
`routeOutput` iterates clients sequentially either way. A write error still triggers
`Close` + `removeClient` as it does now.

**Replay boundary:** holding the lock across hello+replay must not deadlock with
`removeClient`, which takes `f.mu` only. Distinct locks, no nesting.

**Zero-client terminals:** `routeOutput` snapshots an empty slice and writes nothing.
Unchanged.

**Rename during subscribe:** `handleWebSocket` resolved `name` before registering; a rename
moves the map entry under `f.mu`. The wrapper pointer travels with the entry, so the write
lock follows the connection rather than the name. No new case.

## Dependencies

None. The change is confined to the Go module and its build.

Explicitly **out of scope**: the respawned host logging `State file records a non-surviving
host; not adopting.` and coming up with an empty fleet while the tmux sessions survive. That
is a distinct defect in adoption/state-file handling with its own failure mode and belongs
to *The Board Renders Seats, tmux Keeps Them*. Fixing the panic reduces how often it is
reached; it does not address it.

## Adversarial Synthesis

Key risks: a missed write site (`broadcastControl`) leaves the race alive at a lower rate
— caught by the map-type-change at compile time, but the original plan's enumeration
omitted it. Stale line numbers (code refactored: `publish` → `publish` + `routeOutput`)
would mislead an implementer. The race detector is not wired into any script today.
Mitigations: compiler-enforced map type change, corrected line numbers, new `-race` test
wired as `test:contract:pty-host-race`.

Key risks:

1. **A partial fix is indistinguishable from a whole one.** If any single write site keeps
   using the bare conn, the race survives and the panic returns at a lower rate — and every
   test still passes. Mitigation: change the map's element type so the compiler rejects a
   missed site, rather than adding a lock and leaving `*websocket.Conn` reachable.
2. **The race detector is not wired into anything today.** `scripts/build-pty-host.sh`
   only cross-compiles and runs no `go test`. A fix verified by "it did not crash while I
   clicked around" is not verified. Mitigation: the new Go test is required to run under
   `-race` and is wired as a script, so it is reachable from CI.

   > **Superseded:** "`cmd/switchboard-pty-host` has no `_test.go` at all"
   > **Reason:** `controlmode_test.go` (496 lines) already exists in the package, testing
   > the control-mode parser against real tmux captures. The race test is still needed —
   > `controlmode_test.go` tests the parser, not concurrency — but the factual claim that
   > no test file exists was wrong.
   > **Replaced with:** The statement above: the build script runs no `go test`, which is
   > the actual gap. The package has tests; they just don't cover concurrency.
3. **Testing the wrong layer.** `test:contract:pty-host-blackbox` spawns the host from
   `dist/`, so it cannot see a race in `cmd/` source unless the binary is rebuilt first.
   Mitigation: the verification sequence rebuilds via `scripts/build-pty-host.sh` before the
   blackbox suite, and the Go race test runs against source independently.
4. **Compression masking.** Under `-race` with compression disabled the corruption may not
   reproduce as a panic. Mitigation: the race test keeps `EnableCompression: true` and
   asserts on the detector's report, not on a crash.

## Proposed Changes

### 1. `cmd/switchboard-pty-host/ws.go` — a `wsClient` wrapper with a write lock

Add the type and its two write helpers. Every write in the host goes through these:

```go
// One concurrent writer per connection is gorilla/websocket's documented contract.
// With EnableCompression the writers share one flate compressor, so violating it is
// not interleaved frames but a panic inside compress/flate — see the 2026-09-12
// deflateFast.matchLen crash. This mutex is the only thing enforcing the contract.
type wsClient struct {
    conn    *websocket.Conn
    writeMu sync.Mutex
}

func (c *wsClient) writeMessage(messageType int, data []byte) error {
    c.writeMu.Lock()
    defer c.writeMu.Unlock()
    return c.conn.WriteMessage(messageType, data)
}

func (c *wsClient) writeJSON(v any) error {
    c.writeMu.Lock()
    defer c.writeMu.Unlock()
    return c.conn.WriteJSON(v)
}
```

### 2. `cmd/switchboard-pty-host/main.go` — the fleet holds wrappers, not conns

- `clients map[string]map[*websocket.Conn]struct{}` → `map[string]map[*wsClient]struct{}`.
- `main.go:91` (fleet struct field), `main.go:232` (create map init), `main.go:565`
  (`removeClient`), `main.go:795-796` (alias path) take `*wsClient`.
- `main.go:509-510` (`broadcastControl` snapshot) and `main.go:548-549` (`routeOutput`
  snapshot) iterate `*wsClient` instead of `*websocket.Conn`.
- `main.go:261` (readOutput EOF exit), `main.go:519` (`broadcastControl` WriteJSON),
  `main.go:558` (`routeOutput` WriteMessage), `main.go:583` (`close` exit) call
  `client.writeJSON(...)` / `client.writeMessage(...)`. `f.mu` stays released across each
  write loop exactly as today.
- `removeClient(name string, client *wsClient)` and the `_ = client.conn.Close()` call
  sites reach the conn through the wrapper.

### 3. `cmd/switchboard-pty-host/ws.go` — handshake and replay are one critical section

Register the wrapper, then hold its write lock across hello **and** the replay frame so
`routeOutput` cannot interleave a live frame into the replay slot:

```go
client := &wsClient{conn: conn}
f.mu.Lock()
if f.clients[name] == nil {
    f.clients[name] = make(map[*wsClient]struct{})
}
f.clients[name][client] = struct{}{}
replay := append([]outputEvent(nil), f.rings[name]...)
f.mu.Unlock()
defer func() { f.removeClient(name, client); _ = conn.Close() }()

// hello + the ONE coalesced replay frame must reach the client back-to-back: the
// client arms awaitingReplayFrame from hello.replayChars and treats the NEXT binary
// frame as the replay. A publish landing between them is parsed as scrollback.
client.writeMu.Lock()
_ = conn.WriteJSON(map[string]any{ /* hello, unchanged */ })
if replayText != "" {
    _ = conn.WriteMessage(websocket.BinaryMessage, encodeOutputFrame(replaySeq, replayText))
}
client.writeMu.Unlock()
```

The inner calls use `conn` directly because the lock is already held; they must not call
`client.writeMessage`, which would deadlock on the non-reentrant mutex. This is the one
place in the host that takes the lock explicitly, and the comment says why.

### 4. `cmd/switchboard-pty-host/ws_race_test.go` — a new race-detector test

> **Superseded:** "No Go test exists in this package today."
> **Reason:** `controlmode_test.go` (496 lines) already exists, testing the control-mode
> parser. The gap is concurrency coverage, not test-file existence.
> **Replaced with:** No concurrency test exists in this package today.

No concurrency test exists in this package today. Add one that reproduces the original
defect: create a fleet terminal, start a writer goroutine publishing output continuously,
and subscribe/unsubscribe N clients concurrently against it through the real upgrade
handler with `EnableCompression: true`. The assertion is that the run completes under
`-race` with no detector report and no panic. Wire it as
`test:contract:pty-host-race` in `package.json`:

```
"test:contract:pty-host-race": "go test -race -count=1 ./cmd/switchboard-pty-host/..."
```

## Verification Plan

### Automated Tests

1. `npm run test:contract:pty-host-race` — **fails on current `main`** (race detector
   reports the concurrent `WriteMessage`/`WriteJSON` on one conn), passes after the change.
   This is the discriminating test; the others are regression cover.
2. `gofmt -l cmd/switchboard-pty-host` returns empty, and `go vet ./cmd/...` is clean.
3. `bash scripts/build-pty-host.sh` rebuilds all targets, then
   `npm run test:contract:pty-host-blackbox` and `npm run test:contract:pty-host-gating`
   pass — in that order, because the blackbox suite spawns the host from `dist/` and would
   otherwise exercise the previous binary.
4. `npm run test:contract:pty-route-surface`, `test:contract:pty-prompt-delivery-framing`,
   `test:contract:pty-clear-policy` and `test:contract:pty-dispatch-focus` stay green —
   these cover the streaming and prompt paths the wrapper now sits in front of.

### Goal Invariants

- Subscribing a client to a terminal that is actively emitting output never panics the
  host, repeated across a sustained subscribe/unsubscribe loop under `-race`.
- The first binary frame a client receives after `hello` is the replay frame, never a live
  output frame, when output is flowing during the upgrade.
- No `*websocket.Conn` write method is called anywhere in `cmd/switchboard-pty-host` outside
  the `wsClient` helpers and the single commented critical section in `handleWebSocket`
  (`grep -n 'conn\.Write\|client\.Write' cmd/switchboard-pty-host/*.go` returns only those).
- A single slow client cannot block another client's output: `routeOutput` holds no `f.mu`
  and no other client's write lock while writing.

## Completion Summary

Implemented the per-connection write lock: added a `wsClient` wrapper (conn + `sync.Mutex`) with `writeMessage`/`writeJSON` helpers in `ws.go`, and changed `fleet.clients` from `map[*websocket.Conn]struct{}` to `map[*wsClient]struct{}` so the compiler rejects any missed write site. All six write sites (`readOutput` EOF, `broadcastControl`, `routeOutput`, `close`, and the `handleWebSocket` hello+replay) now route through the wrapper; `handleWebSocket` takes the lock explicitly across hello+replay as one critical section so a live `routeOutput` frame cannot land in the replay slot. Added `ws_race_test.go` (real upgrade handler + real `publish` fan-out, `EnableCompression` on both sides, 16 concurrent subscribers × 25 iters) and wired it as `test:contract:pty-host-race`. `go build`, `go vet`, and `gofmt -l` are clean; the goal-invariant grep returns only the two wrapper helpers and the two critical-section calls.
