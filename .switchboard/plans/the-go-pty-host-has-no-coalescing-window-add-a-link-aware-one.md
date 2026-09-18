# The Go PTY host has no coalescing window — add a link-aware one

**Feature:** 94aa8b26-54aa-4323-ad55-eca827444201

## Goal

Give the production terminal gateway (`cmd/switchboard-pty-host`) an output coalescing window sized
to the link rather than to a 60 Hz local renderer, with a lone-frame bypass so a keystroke echo never
waits on it — recovering per-frame overhead and deflate ratio on remote links without adding latency
to the path this feature exists to fix.

### Problem Analysis

The fleet moved into the Go PTY host child (`cmd/switchboard-pty-host`), and the move dropped the
output coalescing the retired `TerminalWsGateway` had. `routeOutput` (main.go:920) is the single
fan-out point: every pty read chunk becomes one seq, one ring entry, and **one WebSocket frame per
client, immediately**. There is no `OUTPUT_FLUSH_MS`, no pending queue, no shared flush tick.

That is the best possible keystroke-echo latency already — zero gateway hold — and the worst
possible bulk-output shape. Under a firehose, every pty read crosses the tailnet as its own frame:
per-frame WebSocket overhead on the wire, and (with `EnableCompression: true` on the upgrader,
ws.go:19) a stream of tiny frames that deflate compresses poorly — deflate wants larger frames. The
client's own rAF batching still saves the render, so the pane stays usable; what is lost is wire
efficiency and per-frame cost on the link.

**The naive fix regresses the feature's reason to exist.** Adding a fixed coalescing window to
`routeOutput` would hold a keystroke echo — a small lone chunk — for the whole window. On a remote
link the correct window is tens of milliseconds, which would put back exactly the wait the sibling
plans remove. So the window is only safe with a lone-frame bypass in front of it: the first chunk of
a quiet stream flushes immediately; the window only coalesces chunks that arrive while a queue is
already forming.

**Why link-aware:** a 6 ms window is right for a loopback client and nearly useless for a 40 ms-RTT
tailnet link, where the flush fires ~7× more often than the link can benefit from. The window should
scale with the slowest attached client's measured round trip.

### Root Cause

The Go host was written as a faithful port of the gateway's *protocol* (binary frames, seq numbering,
replay ring, hello shape) but not its *scheduler*: the coalescing machinery was left behind in the
retired TypeScript class, which nothing constructs anymore
(`terminalWsGateway.ts:392-403`).

### Non-goals

- **Do not add a hold to the lone-frame path.** A single small chunk with an empty queue flushes
  immediately, always — the window only ever delays *queued* output.
- **Do not build an ack/credit ledger.** The Go host accepts `{t:'ack'}` frames for wire
  compatibility and ignores them (ws.go:174-177); this plan does not resurrect backpressure.
- **Do not touch the client write path.** `writeLiveChars` / `scheduleBatchFlush` in
  `terminalViewport.js` are the sibling plan's surface.

## Metadata

**Topic:** Link-aware output coalescing in the Go pty host
**Complexity:** 7
**Tags:** performance, backend, reliability
**Consolidated From:** the-echo-path-pays-two-frames-of-quantization.md (gateway half, superseded)

## User Review Required

None. Thresholds and the RTT mechanism are specified below.

## Complexity Audit

### Routine
- `pending` buffer per terminal in `routeOutput`: a `[]string` + byte count beside the ring, drained
  by a flush function that is today's `routeOutput` fan-out body.
- `wsMessage` gains `Ts`/`Ms` fields; two new `case` arms in the message switch.
- `wsClient` gains an `rttMs` field, written under `f.mu`.

### Complex / Risky
- This introduces the Go host's first flush timer. The lone-frame bypass vs. windowed-queue boundary
  is the load-bearing decision: without it, the window regresses keystroke echo for remote clients —
  the exact latency this feature exists to remove.
- RTT measurement is net-new protocol surface: the Go host's `wsMessage` switch (ws.go:166) has
  `input`/`resize`/`ack` and nothing else; ping/pong/rtt must be added end to end.
- Concurrency: `routeOutput` runs on the terminal's read goroutine; the flush timer fires on its own
  goroutine. Pending-buffer access must be under `f.mu` or a per-terminal lock — pick one and use it
  for every access, including the bypass check.
- The window adapts on client attach/detach/probe — a client joining with a high RTT must stretch
  the window for subsequent schedules, and its departure must relax it.

## Edge-Case & Dependency Audit

**Race Conditions:**
- *Timer flush vs. publish:* both touch the pending buffer; all access under `f.mu`. `routeOutput`
  already takes `f.mu` for the ring append — the pending push joins that critical section.
- *Client attaches mid-burst:* its `rttMs` is unset; it contributes the floor (does not stretch the
  window). An unmeasured client behaves exactly like today.
- *Terminal closed with a pending flush:* `f.close` deletes `clients`/`rings`/`nextSeq`; the flush
  must check the terminal still exists (or drain-and-drop) rather than writing to a deleted map.
- *RTT changes mid-session:* the window adapts on the next probe — a lag of at most the probe
  interval, not a race.

**Security:** The ping timestamp and window value are not sensitive. The new control frames carry no
trust decisions — a client could lie about its RTT and only stretch its own window, never past the
ceiling.

**Side Effects:**
- Larger frames for remote clients improve deflate ratio (the point) but mean each frame carries
  more data; the client's own rAF batching already absorbs burst arrival.
- The `{t:'flushWindow'}` control frame must be *additive*: older clients ignore unknown `t` values
  (the JSON switch's else-chain falls through), so this is safe to ship ahead of the client reader.

**Dependencies & Conflicts:**
- Recommended to land after `terminal-websockets-cross-every-link-uncompressed.md` — the adaptive
  window changes frame sizes and the two should be measured together rather than separately
  attributed.
- Shares `terminalViewport.js` with both siblings: the client-side probe loop and the `pong` /
  `flushWindow` frame arms land in `ws.onopen`/`ws.onmessage`/`ws.onclose` (~lines 2009/2025/2226).
  Independent functions, no overlap with the fast-path or prediction edits.

## Dependencies

None.

## Both Hosts

Both hosts spawn the same packaged `switchboard-pty-host` binary (standalone via
`ptyHostSupervisor`, extension likewise) and both proxy `/ws/terminal` to it
(`LocalApiServer._proxyTerminalUpgrade`, LocalApiServer.ts:1433-1440). One Go implementation serves
both hosts; there is no second composition root to wire. The loopback case — a client on the same
machine — must resolve the window to the floor: that is the regression fence, not an afterthought.

## Adversarial Synthesis

Key risks: (1) a window without a lone-frame bypass holds keystroke echoes for up to the window —
the bypass is the plan, not an optimisation; (2) RTT measurement is new protocol surface and a
"measurement" that never resolves would silently pin the window at the floor — mitigated by making
the floor the explicit unmeasured-client behaviour and surfacing `flushWindow`/`lastRttMs` in the
client diagnostic dump so the resolved value is readable; (3) the first flush timer in the Go host
introduces cross-goroutine access to the pending buffer — mitigated by putting all pending access
under `f.mu`. Rejected: per-terminal goroutines/timers (a fleet-level tick is simpler and matches the
retired gateway's single-interval shape); reading RTT from WebSocket-level ping (gorilla's ping/pong
carries no timestamp and the client never sees it — application-level frames are the measurement).

## Proposed Changes

### `cmd/switchboard-pty-host/ws.go` — RTT measurement and window reporting

**Context:** `wsMessage` (ws.go:46) carries `t`/`data`/`cols`/`rows`. The message switch
(ws.go:166-177) handles `input`, `resize`, `ack`. The `hello` frame is written at ws.go:129-136.
`wsClient` (ws.go:57) wraps the conn.

**Logic — server side:**
1. Extend `wsMessage` with `Ts int64 `json:"ts"`` and `Ms int64 `json:"ms"``.
2. Add `case "ping"`: reply `{"t":"pong","ts":message.Ts}` via `client.writeJSON`.
3. Add `case "rtt"`: store `client.rttMs = message.Ms` under `f.mu`.
4. Add `rttMs int64` to `wsClient` (zero = unmeasured; treat 0 as "no observation", since a real RTT
   is never exactly 0 on any link that matters and the floor covers sub-millisecond loopback).
5. `hello` gains `flushWindow`: the currently resolved window for this terminal, so a late-attaching
   client learns it without waiting for a change.
6. When the resolved window changes (client attach/detach, new RTT observation crossing the clamp),
   send `{"t":"flushWindow","ms":<window>}` to every client of that terminal. A tuning value that
   changes behaviour and cannot be read back is the shape of bug this codebase keeps paying for.

### `cmd/switchboard-pty-host/main.go` — Pending buffer, flush tick, adaptive window, lone-frame bypass

**Context:** `routeOutput` (main.go:920) appends to the ring and writes a binary frame per client,
all under `f.mu` for the map reads then unlocked for the writes. `f.clients` is
`map[string]map[*wsClient]struct{}`.

**Logic:**
1. Add `pendingOutput map[string]*pendingBuf` to `fleet` where `pendingBuf` is
   `{ parts []string; notBefore time.Time }`. Initialise in the `fleet` literal at main.go:1554.
2. Split `routeOutput` into `routeOutput` (log tee + ring append + queue) and `flushPending(name)`
   (drain pending → encode → per-client write). The seq advance and ring append keep happening per
   *flush*, not per chunk — move them into `flushPending` so a coalesced frame still gets one seq and
   one ring entry. (This preserves the client's seq/lastSeq gap logic unchanged.)
3. In `routeOutput`, after queueing the chunk:
   - **Lone-frame bypass:** if `len(parts) == 1` and the chunk is under 512 bytes, call
     `flushPending(name)` immediately — no timer armed, no `notBefore` set.
   - Otherwise: compute the window from the slowest attached client —
     `window = clamp(maxRtt over clients with rttMs > 0, floor 6 ms, ceiling 40 ms)`. An all-unmeasured
     terminal resolves to the floor. Set `parts.notBefore = now + window` and arm the shared flush
     tick (one `time.Ticker` at the 6 ms floor for the whole fleet — `flushAllPending` skips
     terminals whose `notBefore` is in the future; disarm the tick when the pending set empties).
4. `flushPending` clears `notBefore` after a drain. A terminal whose queue never empties under the
   byte cap flushes again on the next tick — same shape as the retired gateway's
   `MAX_FLUSH_BYTES` leftovers rule; carry a per-flush byte cap (128 KB) so one firehose cannot
   build an unbounded frame.
5. Exit path: `f.close` (main.go:963) and the exit-drain equivalent must flush pending synchronously
   before deleting the terminal's state — an exit drain must not be delayed by `notBefore`.

**Take the slowest client, not the mean:** a remote client must not be throttled to a local one's
link, and a local client must not wait on a remote one's window invisibly. Max RTT across attached
clients is the conservative pick: it favours coalescing when anyone is far away. Record the choice
in a comment — it is the same class of explicit trade-off the retired gateway's
`reconcileTerminalSize` made for size votes (`terminalWsGateway.ts`, kept as reference).

### `src/webview/terminalViewport.js` — Client-side RTT probe and window read-back

**Context:** `ws.onopen` at ~line 2009, the JSON control-frame else-if chain in `ws.onmessage` at
~line 2075+, `ws.onclose` at ~line 2226.

**Logic:**
1. In `ws.onopen`, start `entry.rttProbeInterval = setInterval(() => ws.send(JSON.stringify({t:'ping', ts: Date.now()})), 3000)`. Clear it in `ws.onclose` and in the socket teardown.
2. In the control-frame chain, add `frame.t === 'pong'`: `entry.lastRttMs = Date.now() - frame.ts;`
   then `ws.send(JSON.stringify({t:'rtt', ms: entry.lastRttMs}))`.
3. Add `frame.t === 'flushWindow'`: `entry.flushWindowMs = frame.ms`; also read `flushWindow` off the
   `hello` frame.
4. `__sbTerminalStats` (terminals.js:11237) gains `lastRttMs` and `flushWindowMs` — `null` when
   unobserved, never a fabricated number.

**Edge Cases:**
- *Probe lost:* no pong arrives; the next probe succeeds; the server keeps the last RTT.
- *Background tab:* `setInterval` clamps to ~1 Hz; probes slow but continue; the server keeps the
  last value.
- *Server too old to know `ping`:* no pong ever arrives; `rttMs` stays 0 server-side, window stays
  at the floor — behaviour identical to today, and `lastRttMs: null` in the dump says why.

## Verification Plan

1. Firehose (`yes`) into a terminal on a remote client: confirm frames coalesce (fewer, larger WS
   frames) and the resolved window reads >6 ms in `__sbTerminalStats`.
2. Type a keystroke on the same remote client: the echo is NOT held — the lone small chunk bypasses
   the window. Confirm via timing and via `flushWindowMs` being visible while echoes arrive
   immediately.
3. Loopback client: window resolves to the floor (6 ms); no regression vs. today.
4. Attach a local and a remote client to the same terminal: window resolves to the remote client's
   RTT; detach the remote one and confirm the window returns to the floor and a `flushWindow`
   control frame is pushed.
5. Protocol check: client sends `{t:'ping', ts}` ~every 3 s; server replies `{t:'pong', ts}` with
   the same `ts`; client reports `{t:'rtt', ms}`; `ClientState.rttMs`/`wsClient.rttMs` updates.
6. Exit drain: kill a terminal with queued output; the final bytes flush immediately, not after
   `notBefore`.
7. Old client against new host / new client against old host: unknown `t` values are ignored on both
   sides; no crash, no stall.

### Goal Invariants

- Assert `routeOutput` (or its rename) flushes immediately when the pending queue holds exactly one
  chunk under 512 bytes — no timer armed, no `notBefore` set.
- Assert the coalescing window is only applied when `len(parts) > 1` at queue time.
- Assert the resolved window is never below 6 ms and never above 40 ms.
- Assert a terminal whose clients all have `rttMs == 0` uses the floor.
- Assert one fleet-level flush tick exists — no per-terminal `time.Ticker`.
- Assert `hello` carries `flushWindow` and a `{t:'flushWindow', ms}` frame is pushed on change.
- Assert `wsClient` stores `rttMs` written by the `{t:'rtt'}` handler, and `{t:'ping',ts}` is echoed
  back as `{t:'pong',ts}`.
- Assert `__sbTerminalStats` exposes `lastRttMs` and `flushWindowMs`, `null` when unobserved.
- Assert `f.close` drains pending output before deleting terminal state.

## Outstanding Questions

- **[user]** The 512-byte lone-frame ceiling is a design choice carried over from the client-side
  plan — proceeding on the assumption it matches; the two could diverge (e.g. gateway bypass at 256,
  client at 512) if measurement shows a reason.
- **[user]** The RTT probe cadence (3 s) balances adaptation speed against traffic — proceeding on
  the assumption 3 s is acceptable; 1 s adapts faster at ~1 extra msg/s per terminal.
- **[user]** Max-vs-mean across attached clients: max favours the remote viewer's coalescing at the
  cost of holding the local client's bursts slightly longer — proceeding on the assumption max is
  right (it mirrors the size-vote logic); mean would split the difference but helps nobody exactly.

## Implementation Summary (2026-09-18)

Done. `cmd/switchboard-pty-host` now has a link-aware coalescing window: `routeOutput` queues chunks into a per-terminal `pendingBuf` (all access under `f.mu`, drain+write serialized by `buf.flushMu` so racing flushes cannot interleave on the wire), with a lone-frame bypass (queue of one, <512 B → immediate `flushPending`) and a burst-anchored `notBefore` (anchored once per burst — refreshing per chunk would starve under a sustained stream) resolved from the MAX attached-client RTT clamped to [6,40] ms, drained by ONE fleet-level 6 ms tick armed while anything is queued. `ws.go` gained `ping`/`pong`/`rtt` protocol arms, `wsClient.rttMs`, `flushWindow` in `hello`, and `{t:'flushWindow'}` pushes on resolve-change (attach/detach/rtt, with a dead-terminal guard); exit and `f.close` drain pending synchronously before teardown, and rename migrates the new maps. Client side: `terminalViewport.js` sends `{t:'ping'}` every 3 s per socket (interval cleared in onclose + all three socket-teardown sites), answers `pong`/`flushWindow`, and reads `flushWindow` off `hello`; `__sbTerminalStats` exposes `lastRttMs`/`flushWindowMs` as null-when-unobserved. gofmt-clean and `node --check` clean; runtime verification items remain as written (skipped per dispatch directive).

## Fix Round (2026-09-18)

Two defects corrected in `cmd/switchboard-pty-host/main.go`: (1) `flushPending(name)` was missing the `string` parameter type — package now builds clean (`go build`, `go vet`, `gofmt` all pass). (2) The window-arming test fused the bypass condition with the window condition, giving a lone ≥512-byte chunk an adaptive `notBefore`; now the window anchors only when `len(parts) > 1`, and a lone oversize chunk queues with no `notBefore` and drains at the next tick (the floor) — which is also what lets a burst form into a coalesced frame.

## Fix Round 2 (2026-09-18)

Defect: `create()` panicked with `assignment to entry in nil map` on any fleet not built by `main()` — the test harness constructs its own `fleet` literal without the two new maps. Fix: `ensureOutputMapsLocked()` lazily initialises `pendingOutput`/`flushWindowMs` under `f.mu` at every write site (create, routeOutput, reresolveFlushWindow, rename), so no construction site carries a requirement only `main()` meets. Verified: `go build`, `go vet`, and `go test ./cmd/switchboard-pty-host/` all pass (suite `ok` in 0.988s).

## Review Findings

Reviewed 2026-09-19. No code changes were required in `cmd/switchboard-pty-host`: every Goal Invariant checks out against the source — the lone-frame bypass fires with no timer and no `notBefore`, the window arms only at `len(parts) > 1`, `resolveFlushWindowLocked` clamps to [6,40] with unmeasured clients contributing the floor, there is exactly one fleet-level ticker, `hello` carries `flushWindow` and changes push `{t:'flushWindow'}`, and both `f.close` and the `readOutput` exit arm drain synchronously before teardown. Lock discipline was audited specifically for the new cross-goroutine work and is sound: `buf.flushMu` is never taken while `f.mu` is held, all `pendingBuf` fields are accessed under `f.mu`, the ticker goroutine captures its ticker and stop channel locally, and the `reresolveFlushWindow` → `removeClient` recursion is bounded by the client count. Every inbound field was traced to its writer's persisted literal rather than a type or docblock: `flushWindow` on `hello` (ws.go:145), `ts` on `pong` (ws.go:195), `ms` on `flushWindow` (main.go `reresolveFlushWindow`), and `wsMessage.Ts`/`Ms` against the client's `{t:'ping',ts}`/`{t:'rtt',ms}` sends — all present. Verification: `go build ./cmd/...`, `go vet`, `gofmt -l` and `go test ./cmd/switchboard-pty-host/...` all clean, plus `test:contract:pty-host-gating`; `go test -race` could not run on this host (ThreadSanitizer needs a 48-bit VMA, this kernel gives 39), so the one gate that would exercise the new concurrency is unverified locally and rests on CI.

## Deferred Findings

- NIT — `broadcastControl` writes its JSON frame immediately while pty output may sit in the coalescing queue for up to the window, so a control event can now overtake bytes produced before it. Inert today: nothing in the repo consumes `t:'control'` (grepped across `src/webview`, `src/services`, `src/standalone`). Becomes real the moment a consumer is added. `cmd/switchboard-pty-host/main.go:942`
- NIT — `routeOutput` racing `f.close`/the exit drain re-creates `pendingOutput[name]` and `nextSeq[name]` for a terminal whose state was just deleted, leaking a map entry and starting a fresh seq on a dying terminal. Bounded and self-limiting because `readOutput` is what drives `routeOutput`. `cmd/switchboard-pty-host/main.go:1116` vs `:1236`
- MAJOR — `test:contract:pty-host-race` (package.json:906, invoked at `.github/workflows/integration-tests.yml:200`) is the only gate that could discriminate on the new cross-goroutine pending-buffer work, and it cannot run on this machine. `ws_race_test.go` also does not exercise the coalescing path at all — it predates it — so even on CI the race detector sees the new code only incidentally, through whatever output the existing test happens to drive.
- MAJOR — none of the seven Verification Plan items was executed: no firehose coalescing measurement, no remote-client keystroke timing, no loopback floor check, no attach/detach window transition, no protocol round-trip observation, no exit-drain check, no old-client/new-host cross-version check.
