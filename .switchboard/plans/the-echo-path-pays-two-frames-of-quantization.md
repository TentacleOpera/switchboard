# A keystroke echo waits on two frame boundaries it does not need

<!-- board-collapse-09 -->
> **PARKED BEHIND A MEASUREMENT 2026-09-04 (Board Collapse 09).** Not cancelled. *Attribute Switchboard's CPU before optimising it, and catch the wedge in the act* must land first: it makes CPU attributable per process and per terminal, and times the log-writer passes separately. Four terminal-stream optimisation plans exist and none of them knows what it is buying. That plan's own instruction is explicit — the **only** pre-measurement change permitted is hoisting the client filter above the frame encode, which is a pure win; every other optimisation waits for data. It also records a measurement that contradicts a neighbouring plan's premise, which is the argument for measuring rather than reasoning. Move this back when the numbers exist.


## Goal

Deliver a small, lone output frame straight to xterm instead of holding it for the next animation
frame, and scale the gateway's coalescing window to the link instead of to a 60 Hz local renderer —
removing roughly 20-35 ms from every keystroke on a remote board without touching the batching that
bulk output depends on.

### Problem Analysis

Per keystroke, on top of the actual network round trip, the current path adds:

| Stage | Cost |
| :--- | :--- |
| Gateway coalesce — shared `setInterval(OUTPUT_FLUSH_MS = 6)` | ~3 ms mean |
| Client `scheduleBatchFlush` waits for `requestAnimationFrame` | ~8 ms mean, 17 ms worst |
| `term.write()` → `WriteBuffer` parse → renderer paints next frame | ~8-17 ms |

Two of those three are frame quantizations, and neither is needed for the case in question. A
keystroke echo is a handful of bytes arriving alone; batching it with nothing costs a frame and saves
nothing. `scheduleBatchFlush` is unconditional (`terminals.js:11293`) — every frame, however small,
waits for the shared rAF.

**The batching itself is correct and must stay.** Its own rationale is on the record: forwarding every pty
read as its own frame "made the browser pay a JSON.parse + decode + xterm write per chunk — the
dominant cost in the webview". Under a firehose, coalescing is the reason the pane is usable. The
defect is that the *only* policy is the firehose policy.

**And `OUTPUT_FLUSH_MS` was chosen against the wrong client.** Its comment says so plainly: "~6ms is
under one 60Hz frame, so coalescing never costs a rendered frame of latency: the client rAF-batches
writes anyway." That reasoning is sound for a loopback client and wrong for a 40 ms-RTT tunnel, where
the flush fires roughly seven times more often than the link can benefit from — paying per-frame
overhead, and (with compression) denying deflate the larger frames it works best on.

### Root Cause

Both constants were tuned for a same-machine client where latency is dominated by rendering, not by
transit. Nothing in either path asks how far away the client actually is, even though the gateway
already exchanges ping/pong with it and could answer that question.

> **Superseded:** "the gateway already exchanges ping/pong with it and could answer that question" — and Proposed Change 2's claim that RTT is "measured from the existing ping/pong exchange (`PING_INTERVAL_MS`, and the `'ping'`/`pong` handler already in the message switch)."
> **Reason:** The existing ping/pong infrastructure does NOT measure RTT. `PING_INTERVAL_MS = 30000` drives a WebSocket-level liveness check (`ws.ping()` / `ws.on('pong')` at `terminalWsGateway.ts:1492` / `:1328`) that sets a boolean (`client.isAlive = true`) with no timestamp. The application-level `{t:'ping'}`/`{t:'pong'}` handler (`terminalWsGateway.ts:1376–1377`) exists on the server but the client never sends a ping — it is dead code. Neither path carries a timestamp or computes a round-trip time. An adaptive window built on this "existing" measurement would resolve to the floor forever — a no-op indistinguishable from today, and every invariant would pass green.
> **Replaced with:** RTT measurement must be built. Add a timestamp to the application-level `{t:'ping'}` frame, have the client send periodic RTT probes (cadence 2–5 s, separate from the 30 s liveness check), and compute RTT server-side from the round-trip. Store the last observed RTT per `ClientState`. With no RTT observed yet, use the floor — an unmeasured client must behave exactly like today. See Proposed Change 2 for the full specification.

### Non-goals

- **Do not remove rAF batching.** Bulk output must keep coalescing; only a small lone frame takes the
  fast path.
- **Do not lower `OUTPUT_FLUSH_MS` for a local client.** 6 ms is right for loopback; this plan makes
  it adaptive upward, never downward.
- **Do not add an input-side prediction or local echo.** Predictive echo is a separate, riskier idea
  and is explicitly out of scope here.
- No new gateway constructor argument or setter — see Both Hosts.

## Metadata

**Topic:** Fast path for small lone frames, and link-aware output coalescing
**Complexity:** 6
**Tags:** performance, backend, frontend, reliability

## User Review Required

None. Both thresholds and the RTT source are specified below.

## Complexity Audit

### Routine
- Client fast path: single-file (`terminals.js`), reuses `flushBatch`'s `term.write` + `onWriteParsed` code path. Conditions are three boolean checks.
- "Not-before" stamp in `flushAllPending`: one `Date.now()` comparison per terminal per tick, no new timer.
- Exposing the resolved window in the client diagnostic dump: one additional field.

### Complex / Risky
- RTT measurement infrastructure is net-new: application-level ping/pong must be activated (client sends probes, server computes RTT). This is a protocol change, not a config tweak.
- Gateway-side fast path for small lone frames: must distinguish "first chunk, no queue" (flush immediately) from "queue forming" (apply adaptive window) without racing the shared timer. The boundary between the two is the load-bearing decision — without it, the adaptive window regresses keystroke echo latency for remote clients.
- The adaptive window changes coalescing cadence, which interacts with compression (deflate prefers larger frames) and backpressure timing (fewer, larger frames mean less frequent backpressure checks but more data per check). `MAX_FLUSH_BYTES` still caps a frame, so the backpressure ceiling is unchanged.
- The fast path bypasses `scheduleBatchFlush`, which currently calls `bumpStartupCurtain` — the fast path must call it directly or the startup curtain will not arm for lone-echo terminals.
- The fast path must apply to both the binary frame handler and the legacy `t:'out'` text handler, or a browser tab left open across a downgrade will not benefit.

## Edge-Case & Dependency Audit

**Race Conditions:**
- *Fast path during replay write:* If a live frame arrives while `entry.suppressAnswerback` is true (a replay write is mid-parse), the fast path would write to xterm. xterm's `WriteBuffer` queues writes in order, so the live frame queues behind the replay — ordering is preserved. The `onWriteParsed` callback for the live frame fires after the replay's callback (WriteBuffer fires callbacks in queue order), so `ackSuppressChars` is burned first, then live chars are billed. This is correct. The fast path should still guard on `!entry.suppressAnswerback` as a safety check — it prevents the fast path from firing during the replay window, which is the conservative choice.
- *Adaptive window vs. drainPending:* `drainPending` (`terminalWsGateway.ts:1055`) calls `flushOutput` directly, bypassing `flushAllPending`. This is correct — an exit drain must not be delayed by the "not-before" stamp. The stamp check lives in `flushAllPending`, not `flushOutput`, so `drainPending` naturally bypasses it.
- *RTT changes mid-session:* The window adapts on the next RTT probe. Not a race — a lag of at most the probe interval (2–5 s).

**Security:** No security implications. The ping timestamp and window value are not sensitive.

**Side Effects:**
- The fast path bypasses `scheduleBatchFlush`, which calls `bumpStartupCurtain(entry.name)` (line 11295). The fast path must call `bumpStartupCurtain` directly.
- The adaptive window increases frame sizes for remote clients, which improves deflate compression ratios (the plan's stated goal) but means each backpressure check handles more data. `MAX_FLUSH_BYTES` (128 KB) still caps a frame, so no single frame can stall the client.
- The fast path does not call `scheduleBatchFlush`, so it does not add the entry to `pendingBatchEntries`. If a second frame arrives before the fast-path write callback fires, it will find `batchQueue` empty and `pendingBatchEntries` without the entry — it will also take the fast path. xterm's `WriteBuffer` queues both writes in order. This is correct: two lone frames are still small, and ordering is preserved.
- The gateway-side fast path flushes the first small chunk immediately, bypassing the shared timer. Under rapid single-chunk arrivals (one char per event loop tick), each chunk flushes separately — no coalescing. The 512-char ceiling limits this to small frames, and a single-char-per-tick pattern is already pathological. Under a real firehose, chunks queue faster than the event loop drains them, so `pending.parts.length > 1` and the normal coalescing path applies.

**Dependencies & Conflicts:**
- Recommended to land after `terminal-websockets-cross-every-link-uncompressed.md` — the adaptive window changes frame sizes and the two should be measured together.
- The fast path interacts with the startup curtain (`bumpStartupCurtain`), the working-silence affordance (`lastFrameAt` / `lastPrintableAt` stamping, which happens before the fast-path check), and the ack/suppress accounting (`onWriteParsed`).

## Dependencies

None. Recommended to land after
`terminal-websockets-cross-every-link-uncompressed.md`, because the adaptive window changes frame
sizes and the two should be measured together rather than separately attributed.

## Both Hosts

Both changes live in shared files — `terminals.js` (the client, served by both hosts) and
`terminalWsGateway.ts` (constructed at `bootstrap.ts:3207` in-process and at `ptyHost.ts:46` as the
extension's sidecar). Neither requires wiring at either root, which is deliberate: a two-call-site
seam is the known trap here, evidenced by `setBindPolicy` being wired in `bootstrap.ts:3603` and
nowhere in `ptyHost.ts`.

The extension's client connects over loopback, so the adaptive window must resolve to today's 6 ms
there. That is the regression fence, not an afterthought.

## Adversarial Synthesis

Key risks: (1) the RTT measurement infrastructure does not exist and must be built — the plan's original claim that it could be read from "the existing ping/pong exchange" was false and would have shipped a no-op; (2) the adaptive window alone would INCREASE keystroke echo latency for remote clients (from 6 ms to up to 40 ms gateway hold) — the gateway-side fast path for small lone frames is the fix, without which the plan regresses the exact latency it set out to improve; (3) the client fast path must check before the `batchQueue.push` and must call `bumpStartupCurtain` directly, or it will never fire / will strand the startup curtain; (4) the resolved window is server-side but the "existing stats" are client-side — the window must cross that boundary via a control frame. Mitigations: activate the application-level ping/pong with timestamps and client-initiated probes; add a gateway-side fast path that flushes the first small chunk immediately (adaptive window only coalesces subsequent chunks); specify the client fast-path check as pre-push; include the resolved window in the `hello` frame and update it via a lightweight control frame when it changes.

## Proposed Changes

### `src/webview/terminals.js` — Client fast path for a small lone frame

**Context:** The binary frame handler (`ws.onmessage`, ~line 11084) and the legacy `t:'out'` handler (~line 11131) both push to `entry.batchQueue` and then call `scheduleBatchFlush(entry)`. `scheduleBatchFlush` (line 11293) unconditionally waits for a shared `requestAnimationFrame` — costing ~8–17 ms even for a lone 3-byte echo.

**Logic:** In both the binary and legacy text handlers, *before* the `entry.batchQueue.push(text)` call, check:
1. `entry.batchQueue.length === 0` — nothing already queued from a prior frame.
2. `!pendingBatchEntries.has(entry)` — no rAF flush is already pending for this entry.
3. `text.length < 512` — the payload is under the small-frame ceiling.
4. `!entry.suppressAnswerback` — no replay write is in progress (safety guard; see Edge-Case audit).

If all four hold:
- Call `bumpStartupCurtain(entry.name)` directly (this is currently inside `scheduleBatchFlush` and would be skipped).
- Write immediately: `entry.term.write(text, () => onWriteParsed(entry, text.length))` — the same code path `flushBatch` uses (line 11340), preserving the `onWriteParsed` callback so ack accounting is unchanged.
- Do **not** push to `entry.batchQueue`.
- Do **not** call `scheduleBatchFlush(entry)`.
- Return (skip the push + schedule).

If any condition fails, fall through to today's exact behaviour: push to `batchQueue`, stamp live-frame timers (`lastFrameAt`, `lastPrintableAt`, `clearWorkingSilence`), call `scheduleBatchFlush`.

**Implementation detail — timer stamping:** The live-frame timer stamping (`lastFrameAt`, `lastPrintableAt`, `clearWorkingSilence`) at lines 11117–11125 (binary) and 11143–11151 (legacy) happens *after* the push and *before* `scheduleBatchFlush`. The fast-path check should be inserted *before* the push, and the timer stamping should run in both the fast-path and the normal path. Restructure each handler so the stamping happens regardless of which path is taken:

```
// Stamp live-frame timers (both paths)
const now = Date.now();
if (!entry.firstFrameAt) { entry.firstFrameAt = now; }
entry.lastFrameAt = now;
if (now - entry.lastPrintableAt >= PRINTABLE_SCAN_THROTTLE_MS) {
    if (frameHasPrintable(text)) {
        entry.lastPrintableAt = now;
        if (workingSilenceShown.has(entry.name)) { clearWorkingSilence(entry.name); }
    }
}

// Fast path: lone small frame, no pending flush, no replay in progress
if (entry.batchQueue.length === 0
    && !pendingBatchEntries.has(entry)
    && text.length < 512
    && !entry.suppressAnswerback
    && entry.term && !entry.disposed && !entry.suspended) {
    bumpStartupCurtain(entry.name);
    try {
        entry.term.write(text, () => onWriteParsed(entry, text.length));
    } catch (err) {
        entry.writeThrowCount = (entry.writeThrowCount || 0) + 1;
        console.error(`[Terminals] fast-path write failed for ${entry.name}:`, err);
    }
    return;
}

// Normal path
entry.batchQueue.push(text);
scheduleBatchFlush(entry);
return;
```

**Edge Cases:**
- *Two lone frames arrive back-to-back:* The first takes the fast path (queue empty, no pending flush). The second finds `batchQueue` still empty (the first was not pushed) and `pendingBatchEntries` without the entry (the first did not schedule). It also takes the fast path. xterm's `WriteBuffer` queues both in order. Correct.
- *Lone frame then a burst:* The first takes the fast path. The second is larger (>512 chars) or the queue has items — it falls through to the normal path. Correct: latency for the first byte, throughput for the rest.
- *Fast path during replay:* Guarded by `!entry.suppressAnswerback`. If a replay write is in progress, the fast path declines and the frame takes the normal path. Conservative and correct.
- *Legacy text frames:* The same fast-path check must be inserted in the `t:'out'` handler (line 11131) before `entry.batchQueue.push(rawData)`. A browser tab left open across a downgrade uses this path and must benefit equally.

### `src/standalone/terminalWsGateway.ts` — RTT measurement infrastructure

**Context:** The application-level `{t:'ping'}` / `{t:'pong'}` handler exists (line 1376–1377) but the client never sends a ping. The WebSocket-level `ws.ping()` / `ws.on('pong')` (line 1492 / 1328) is a 30-second liveness check with no timestamp. Neither measures RTT.

**Logic — server side:**
1. Extend the `{t:'ping'}` handler (line 1376) to read a `ts` field from the parsed message and include it in the `{t:'pong'}` reply: `this.safeSend(ws, { t: 'pong', ts: parsed.ts })`.
2. Add an `rttMs?: number` field to `ClientState` (line 377). Add a new `{t:'rtt'}` handler (alongside the `{t:'ping'}` handler at line 1376) that sets `client.rttMs = parsed.ms`.

   **Who measures RTT:** The client sends `{t:'ping', ts: Date.now()}`, the server echoes `{t:'pong', ts: <same ts>}`, the client computes `RTT = Date.now() - ts` on receipt. The client then reports the RTT to the server via a new `{t:'rtt', ms: <value>}` message. The server stores it on `ClientState.rttMs`. This keeps the measurement on the side that has the clock for the round-trip (the client) and the storage on the side that needs it (the server).

3. The client sends RTT probes on a 2–5 second interval (e.g., `RTT_PROBE_MS = 3000`), separate from the 30-second liveness check. Start the probe interval in `ws.onopen` (line 11064) and clear it in `ws.onclose` (line 11268).

**Edge Cases:**
- *No RTT observed yet:* `client.rttMs` is `undefined`. The window resolves to the floor (`OUTPUT_FLUSH_MS`). This is the "unmeasured client behaves exactly like today" rule.
- *Stale RTT:* If a client disconnects, its `ClientState` is removed (line 1385). No stale value persists. If a client's RTT changes, the next probe updates it within `RTT_PROBE_MS`.
- *Loopback client:* RTT will be ~0–1 ms. The window resolves to the floor (6 ms). This is the regression fence.

### `src/standalone/terminalWsGateway.ts` — Link-aware coalescing window

**Context:** `scheduleFlush` (line 718) arms a single shared `setInterval` at `OUTPUT_FLUSH_MS` (6 ms). `flushAllPending` (line 727) iterates all terminals with pending output and calls `flushOutput` for each. Every terminal flushes on every tick regardless of link distance.

**Logic:**
1. Add a `flushNotBefore?: number` field per terminal — a "not before" timestamp. Store it on the `PendingOutput` interface (line 126) or in a separate `Map<string, number>`.
2. In `flushAllPending` (line 727), before calling `flushOutput(name)` for a terminal, check: if `Date.now() < flushNotBefore[name]`, skip this terminal for this tick. The terminal stays in `pendingFlushTerminals` and will be checked again on the next tick.
3. When scheduling a flush (in `scheduleFlush`, line 718), compute the "not before" stamp from the slowest attached client's RTT:
   - Find all `ClientState`s for this terminal: `Array.from(this.clients).filter(c => c.terminalName === terminalName)`.
   - Take the max `rttMs` among clients that have one. Clients without an observed RTT contribute the floor (they do not stretch the window).
   - Clamp: `window = Math.max(OUTPUT_FLUSH_MS, Math.min(40, maxRtt))`. The floor is `OUTPUT_FLUSH_MS` (6 ms); the ceiling is 40 ms.
   - Set `flushNotBefore[name] = Date.now() + window - OUTPUT_FLUSH_MS` — the terminal should not flush until at least `window` ms have elapsed since it was scheduled. The `- OUTPUT_FLUSH_MS` accounts for the fact that the timer fires every 6 ms (the floor), so the "not before" stamp is relative to the schedule time, not the tick time.
4. `drainPending` (line 1055) calls `flushOutput` directly, bypassing `flushAllPending` — the "not before" stamp is not checked. This is correct: an exit drain must flush immediately.
5. After `flushOutput` completes (the terminal's pending output is fully flushed or capped by `MAX_FLUSH_BYTES`), clear `flushNotBefore[name]` so the next schedule starts fresh.

**Take the slowest client, not the mean:** A local client attached alongside a remote one must not have its window stretched invisibly. The max/min choice is the same kind of decision `reconcileTerminalSize` (line 1438) already makes explicitly for size votes — it takes `Math.min` of cols/rows across voters, not the mean.

### `src/standalone/terminalWsGateway.ts` — Gateway-side fast path for a small lone frame

> **Superseded:** The original plan had no gateway-side fast path. The adaptive window alone was expected to improve keystroke echo latency.
> **Reason:** The adaptive window INCREASES the gateway hold from 6 ms to up to 40 ms for remote clients. A keystroke echo — a small lone pty chunk — would sit in the coalescing window for up to 40 ms instead of 6 ms. The client fast path saves ~8-17 ms (one rAF cycle), but the gateway adds up to ~34 ms. Net: worse for keystroke echo. The plan could pass its own success check ("window resolves to 40 ms" ✓, "client fast path fires" ✓) while the real goal — reduced keystroke latency — is regressed.
> **Replaced with:** A gateway-side fast path mirroring the client's. In `scheduleFlush` (line 718): if `pending.parts.length === 1` (this chunk is the first and only part — nothing was coalescing before it) AND the chunk is under **512 chars**, flush it immediately via `this.flushOutput(terminalName)` instead of waiting for the shared timer. The adaptive window only applies when `pending.parts.length > 1` (a queue is forming — bulk output). This preserves "latency for the first byte, throughput for the rest" at both hops.

**Context:** `scheduleFlush` (line 718) is called from the pty `onData` handler (line 712) every time a chunk arrives. It adds the terminal to `pendingFlushTerminals` and arms the shared `setInterval`. The first chunk of a keystroke echo waits up to `OUTPUT_FLUSH_MS` (6 ms today, up to 40 ms with the adaptive window) before `flushAllPending` fires.

**Logic:** In `scheduleFlush`, after the existing guard (`if (!pending || pending.parts.length === 0) return`), check:
1. `pending.parts.length === 1` — this chunk is the first and only part (the `onData` handler at line 710 pushes before calling `scheduleFlush`, so `length === 1` means nothing was coalescing before this chunk).
2. `pending.parts[0].length < 512` — the chunk is under the small-frame ceiling.

If both hold:
- Call `this.flushOutput(terminalName)` immediately.
- Do **not** add the terminal to `pendingFlushTerminals`.
- Do **not** arm the shared `setInterval`.
- Return.

If either condition fails, fall through to today's exact behaviour: add to `pendingFlushTerminals`, arm the timer.

**Edge Cases:**
- *Rapid single-chunk arrivals (e.g. a slow `for` loop printing one char per tick):* Each chunk takes the fast path (queue empty each time). This bypasses coalescing entirely, but the 512-char ceiling limits the damage — only small frames take the fast path, and a single-char-per-tick pattern is already pathological. Under a real firehose, chunks arrive faster than the event loop processes them, so `pending.parts.length > 1` and the normal path applies.
- *Chunk arrives while flushOutput is mid-flight:* `flushOutput` is synchronous (it drains `pending.parts`, encodes, and sends). By the time the next `onData` fires, the previous flush is complete. No race.
- *drainPending (exit drain):* `drainPending` (line 1055) calls `flushOutput` directly, bypassing `scheduleFlush`. The fast path does not interfere — it only applies in `scheduleFlush`.

### `src/standalone/terminalWsGateway.ts` — Record the window that was used

**Context:** The plan says "expose the resolved window per terminal (alongside the existing stats)." The existing stats are the *client-side* diagnostic dump (`terminals.js:11420–11444`). The resolved window is *server-side*. The client has no way to know what window the gateway chose unless the server tells it.

**Logic:**
1. Include the resolved window in the `hello` frame (sent in `setupClient`, line 1202). Add a `flushWindow` field: `this.safeSend(ws, { t: 'hello', ..., flushWindow: resolvedWindow })`.
2. When the window changes (a new client attaches with a higher RTT, or a remote client detaches and the window drops back to the floor), send a lightweight control frame to all clients for that terminal: `this.safeSend(ws, { t: 'flushWindow', ms: newWindow })`.
3. On the client, store the window on the entry (`entry.flushWindowMs`) and include it in the diagnostic dump (line 11420–11444): `flushWindowMs: entry.flushWindowMs || null`.

A tuning value that changes behaviour and cannot be read back is the shape of bug this codebase keeps paying for. The control frame makes "why is this pane sluggish" answerable after the fact rather than by re-deriving RTT.

### `src/webview/terminals.js` — Client-side RTT probe

**Context:** The client must send periodic `{t:'ping', ts: Date.now()}` messages and compute RTT from the `{t:'pong', ts}` reply, then report it to the server via `{t:'rtt', ms: <value>}`.

**Logic:**
1. In `ws.onopen` (line 11064), start a probe interval: `entry.rttProbeInterval = setInterval(() => { ws.send(JSON.stringify({ t: 'ping', ts: Date.now() })); }, RTT_PROBE_MS)`. `RTT_PROBE_MS = 3000` (3 seconds — fast enough for responsive adaptation, slow enough to be negligible traffic).
2. In the `ws.onmessage` handler, add a case for `frame.t === 'pong'`: compute `const rtt = Date.now() - frame.ts;` and send `ws.send(JSON.stringify({ t: 'rtt', ms: rtt }))`. Store `entry.lastRttMs = rtt` for the diagnostic dump.
3. In `ws.onclose` (line 11268), clear the probe interval: `if (entry.rttProbeInterval) { clearInterval(entry.rttProbeInterval); entry.rttProbeInterval = null; }`.
4. In the diagnostic dump (line 11420–11444), add: `lastRttMs: entry.lastRttMs || null, flushWindowMs: entry.flushWindowMs || null`.

**Edge Cases:**
- *Probe lost:* If a ping is lost (network blip), no pong arrives. The next probe (3 s later) will succeed. The server's `client.rttMs` retains the last value. Not a problem — the window adapts on the next successful probe.
- *Tab hidden:* `setInterval` is clamped to ~1 Hz in background tabs. Probes slow down but do not stop. The server retains the last RTT. On tab restore, probes resume at full cadence. Not a problem.

## Verification Plan

1. Measure keystroke echo latency on a tailnet board before and after. Expect a reduction of roughly
   one to two frame times; record the actual numbers.
2. Measure the same on a loopback board. It must not regress, and the resolved window must read 6 ms.
3. Paste 40 KB into a pane. Rendering stays coalesced — assert the fast path did **not** fire per
   chunk by checking that frame count at the client is unchanged from today.
4. Run a firehose (`yes`-style) and confirm the pane stays responsive and `MAX_FLUSH_BYTES` still
   caps a frame.
5. Attach a local and a remote client to the same terminal. Confirm the window resolves to the remote
   client's value and that detaching the remote one returns it to the floor.
6. Ack accounting: `pendingAckChars` / `ackSuppressChars` behave identically, and a replay's
   suppression budget is still burned correctly — the fast path must go through `onWriteParsed`.
7. Answerback suppression during replay still works: the fast path must not fire while
   `entry.suppressAnswerback` is set (replay write in progress). The fast path declines to the
   normal path, which queues behind the replay via xterm's `WriteBuffer`.
8. **Both hosts:** run 1, 2 and 3 against standalone and the extension's pty-host sidecar.
9. **RTT probe:** confirm the client sends `{t:'ping', ts}` every ~3 s, the server echoes `{t:'pong', ts}`, the client computes RTT and sends `{t:'rtt', ms}`, and the server's `ClientState.rttMs` updates. On loopback, RTT should be <2 ms and the window should resolve to the floor.
10. **Window control frame:** confirm the `hello` frame includes `flushWindow` and that a `{t:'flushWindow', ms}` frame is sent when the window changes (client attaches/detaches).
11. **Startup curtain:** confirm a terminal whose first output is a lone echo (fast path) still arms and dismisses the startup curtain — `bumpStartupCurtain` is called in the fast path.
12. **Legacy text frames:** with a server downgraded to the `t:'out'` protocol, confirm the fast path still fires for small lone frames.
13. **Gateway fast path:** verify that a single small pty chunk flushes immediately (within one event loop tick, not waiting for the 6 ms timer) while a burst of chunks coalesces. Confirm via the diagnostic surface that the adaptive window is only applied when `pending.parts.length > 1`.
14. **Gateway fast path under adaptive window:** with a remote client (40 ms window), type a keystroke. Confirm the echo flushes immediately from the gateway (not held for 40 ms) — the fast path fires for the first chunk, and the adaptive window only coalesces subsequent chunks.

### Goal Invariants

- Assert the client fast path fires only when `entry.batchQueue.length === 0`, `!pendingBatchEntries.has(entry)`, `text.length < 512`, and `!entry.suppressAnswerback`.
- Assert the fast path invokes `onWriteParsed(entry, text.length)` via the `term.write` callback.
- Assert the fast path calls `bumpStartupCurtain(entry.name)` directly.
- Assert the fast path does not push to `entry.batchQueue` and does not call `scheduleBatchFlush`.
- Assert the fast path is present in both the binary frame handler and the legacy `t:'out'` handler.
- Assert the resolved coalescing window is never below `OUTPUT_FLUSH_MS` (6 ms) and never above 40 ms.
- Assert a terminal with no RTT observation (`client.rttMs` undefined for all clients) uses the floor.
- Assert `sharedFlushInterval` remains a single timer for all terminals (no per-terminal `setInterval`).
- Assert `drainPending` bypasses the "not-before" stamp (calls `flushOutput` directly).
- Assert the resolved window is readable per terminal: included in the `hello` frame, updated via `{t:'flushWindow'}` control frame, and present in the client diagnostic dump.
- Assert the client sends `{t:'ping', ts}` probes at ~3 s intervals and reports RTT via `{t:'rtt', ms}`.
- Assert the server's `{t:'pong'}` reply includes the `ts` field from the `{t:'ping'}` request.
- Assert the gateway fast path flushes immediately when `pending.parts.length === 1` and the chunk is under 512 chars (does not add to `pendingFlushTerminals`, does not arm the shared timer).
- Assert the gateway adaptive window is only applied when `pending.parts.length > 1` at schedule time.

## Outstanding Questions

- **[user]** The 512-char ceiling for the fast path is a design choice — a keystroke echo is typically 1–10 bytes, but 512 chars allows a small prompt redraw or ANSI sequence through. Proceeding on the assumption that 512 is the right ceiling; adjust if measurement shows it should be lower (e.g., 128) to avoid mid-prompt coalescing breaks.
- **[user]** The RTT probe cadence (3 s) is a balance between responsiveness and traffic. Proceeding on the assumption that 3 s is acceptable; a faster cadence (1 s) would adapt more quickly but add ~1 message/second per terminal.
