# Terminal Output Flow Control: Ack-Based Backpressure and Page-Level Batching

## Goal

Replace the browser terminal fleet's socket-buffer-based backpressure with an end-to-end ack/credit protocol, so the pty pauses when the **renderer** falls behind rather than when the server's send queue does. Collapse per-terminal output batching into a single page-level drain on both ends.

### Problem

Under agent load the browser terminals lag by seconds. Keystrokes echo late or not at all — the operator types into a terminal that appears frozen. The 6 ms output coalescing (`OUTPUT_FLUSH_MS`) and the binary frame format already landed and helped, but neither bounds how far behind the client can fall: they make each unit of work cheaper without ever telling the producer to stop.

### Root cause

**1. Backpressure is measured on the wrong side of the wire (`src/standalone/terminalWsGateway.ts:266-309`).**

`checkBackpressure` gates `pty.pause()` on `client.ws.bufferedAmount` — the **server's** outbound queue (`ws`'s `_socket.bufferSize + sender._bufferedBytes`). Over loopback the kernel socket buffer accepts writes synchronously, and Chrome's network service reads eagerly into a mojo pipe on a different thread from the blocked renderer. Several megabytes are in flight before that number moves, so `HIGH_WATER_MARK_BYTES` (1 MB, `:6`) is effectively unreachable and `pty.pause()` (`:296`) essentially never fires.

**2. The client acks nothing.** `terminals.js` only ever sends `input`, `resize`, `ping` (`:1134-1142`); the gateway only ever handles those three (`:405-419`). There is no return channel by which "I have parsed N characters" could reach the producer.

**3. Every client-side queue is unbounded.** WS receive queue → `entry.batchQueue` (`terminals.js:1199`) → xterm's internal `_writeBuffer`. The vendored xterm states the requirement outright:

```js
write(e,t){ if(this._pendingData>5e7) throw new Error("write data discarded, use flow control to avoid losing data"); … }
```

50 MB of pending data and xterm **throws**. `flushBatch` (`terminals.js:1266-1275`) calls `entry.term.write(combined)` with no try/catch, inside a rAF callback — so that throw escapes as an unhandled error and the terminal stops draining permanently.

The same excerpt confirms the ack hook exists: `write(data, callback)` is supported, and `_innerWrite` yields every 12 ms (`Date.now()-i>=12?setTimeout(…)`). So xterm is *not* hard-blocking the main thread on parse — the latency is pure queue depth, which is exactly what flow control fixes and micro-optimisation does not.

**4. The eviction path is a spiral, not a recovery.** When backpressure finally does trip: 30 s grace → evict and close (`:282-288`) → client reconnects after 500 ms (`terminals.js:1232-1245`) → server replays up to 256 KB of ring as **one concatenated frame** (`:386-395`) → one giant `term.write` on an already-drowning renderer.

**5. Batching is per-terminal where the bottleneck is per-page.** `OUTPUT_FLUSH_MS = 6` (`:33`) arms one timer per terminal: nine busy terminals is ~1500 flushes/sec server-side and ~1500 frames/sec landing on the browser main thread. `scheduleBatchFlush` (`terminals.js:1248-1264`) likewise arms one rAF **per terminal**, so nine terminals produce ~540 separate `term.write()` calls/sec, each with its own parse and render schedule, when the page can only paint 60 times a second regardless.

### Context

The prior pass on this file already fixed the *per-byte* costs — chunk coalescing, binary framing, terminal-scoped seqs, GPU renderers. Those comments (`:19-42`, `:55-67`) are accurate and their reasoning stands. This plan does not revisit them; it adds the one mechanism they all assumed was already present. The `DRAIN_POLL_MS` poller (`:436-444`) exists precisely because a paused pty cannot re-check its own backpressure — that reasoning carries over unchanged to the char-count watermark.

VS Code solves the identical problem with a char-count credit scheme in its pty host: the renderer acks characters it has actually parsed via `term.write(data, cb)`, and the host pauses on `HighWatermarkChars`, resumes on `LowWatermarkChars`, with the renderer acking every `CharCountAckSize` chars. This plan adopts that design and its constants (5000 / 100000 / 5000).

## Scope

- `src/standalone/terminalWsGateway.ts` — ack handling, char-count watermarks, shared flush tick.
- `src/webview/terminals.js` — ack emission, page-level batch drain, guarded writes, debug stats.

Out of scope: the input/paste path (`terminal-input-paste-path.md`), view teardown (`terminal-view-lifecycle-teardown.md`), and WS push scoping (`panel-surface-scoped-ws-push.md`). Those are siblings in the same feature.

## Metadata

- **Complexity:** 7
- **Tags:** performance, bugfix, backend, frontend, terminals

## User Review Required

None. Watermark constants are adopted from a proven implementation and are internal tuning.

## Complexity Audit

### Routine

- The pause/resume mechanics already exist and are proven — `checkBackpressure` (`:266-309`) plus the `DRAIN_POLL_MS` poller already own the `pausedTerminals` set. This plan changes the *input* to that decision, not its machinery.
- `term.write(data, callback)` is a supported two-arg signature in the vendored bundle (verified above); wiring the callback is additive.
- The message handler (`:405-419`) is a flat `if/else if` chain; adding an `ack` branch is one clause.

### Complex / Risky

- **A wrong watermark deadlocks the terminal.** If an ack is dropped, mis-counted, or double-counted, `unackedChars` drifts upward and never returns below the low-water mark — the pty pauses forever and the terminal goes silently dead. This is strictly worse than today's failure mode (lag). Every path that can lose an ack must be enumerated: reconnect, eviction, terminal exit, disposal mid-write.
- **The ack must count parsed chars, not received chars.** Acking on `onmessage` reintroduces exactly the bug being fixed — it measures the transport, not the renderer. The ack must fire from xterm's write callback.
- **Two counters must agree across a reconnect.** The server's `unackedChars` is per-client; a reconnect creates a new `ClientState`. If the counter is not reset, a paused terminal stays paused after its only client reconnects.
- **Replay is unacked by construction.** The connect-time replay frame (`:386-395`) can be 256 KB — larger than the entire low-water budget. It must be excluded from the credit accounting or the terminal pauses immediately on every attach.
- **Multi-client fan-out.** A terminal can have several attached clients (two browser tabs). The pause decision must use the **worst** client, matching today's `maxBuffered` semantics, and evicting the laggard must release its credit.
- **rAF is parked in hidden iframes.** The panel is a `display`-toggled iframe (`shell.js:5-6`), so a page-level rAF scheduler stops entirely when the operator is on another panel. The existing `BATCH_FALLBACK_MS` timer (`:48`) covers this and must survive the refactor — losing it turns every panel switch into a banked-output avalanche.

## Edge-Case & Dependency Audit

### Race Conditions

- **Ack arriving after the terminal exited.** `untrackTerminalData` (`:227-251`) deletes the buffer and closes clients; a late ack must be tolerated as a no-op, not throw in the message handler.
- **Ack arriving after the client was evicted.** The `ClientState` is already out of `this.clients`; the handler must resolve the client by `ws` identity and ignore unknown ones.
- **Pause racing a flush.** `flushOutput` (`:184-225`) can be mid-window when a pause lands. Pausing the pty does not discard already-queued `pending.parts`; those must still flush, or the tail of the last window is lost.
- **Resume racing eviction.** If the last laggard is evicted while paused, `unackedChars` for that client disappears and the terminal must resume. The existing `DRAIN_POLL_MS` poller (`:436-444`) is the only path that can notice this — it must be extended to re-evaluate the char watermark, not just `bufferedAmount`.
- **Client disposal mid-write.** `destroyTerminalView` disposes the terminal; an in-flight `term.write` callback then fires against a disposed instance. The ack emitter must check the entry is still live.

### Security

- No new data sources and no new persisted state. The ack frame carries a single integer.
- The `ack` handler must validate `typeof parsed.chars === 'number'` and clamp to a sane range before subtracting — an unbounded or negative value from a client would let it drive `unackedChars` negative and permanently disable its own backpressure. Clamp to `[0, unackedChars]`.

### Side Effects

- **Busy terminals become intentionally slower.** A `yes`-style firehose will now be paced to what the renderer can absorb, so its *output rate* drops. That is the point, but it changes observable behaviour: a command that previously blasted and finished will now take longer to scroll past. Scrollback content is unaffected (the ring is server-side).
- **CPU drops across the whole page.** Because all six panels share one main thread (`shell.js:146-167`), pacing the terminals gives time back to the board and every other panel, not just the terminals panel.
- **The existing `bufferedAmount` guard becomes the secondary path.** It must be kept, not replaced: over a remote tunnel or SSH-forwarded port the transport genuinely can be the bottleneck, and that is the case `bufferedAmount` measures correctly.

### Dependencies & Conflicts

- **`terminal-input-paste-path.md`** also edits `terminalWsGateway.ts`'s `ws.on('message')` handler and `terminals.js`. Textual overlap is confined to that one handler. Land **this** plan first: the paste plan's value depends on the output path being paced.
- **`terminal-view-lifecycle-teardown.md`** edits `terminals.js` (`renderPaneGrid`, `destroyTerminalView`) and must make `flushBatch`/the ack emitter no-op on a disposed entry. Whichever lands second inherits that requirement.
- No new libraries. `term.write(data, cb)` is in the vendored bundle; `pty.pause()`/`resume()` are already called.

## Dependencies

None blocking. Sibling plans in the same feature may land in any order; the recommended order is this plan first.

**Migration:** none. No persisted state, no settings, no DB columns. The `ack` frame is additive — a server without the handler ignores it (the existing `catch` at `:416-418` already swallows unrecognised frames), and a client that never acks is treated as having zero credit consumed, i.e. exactly today's behaviour. The Terminals panel first shipped 2026-07-31 and is unreleased, so no install-base compatibility is required either way.

## Adversarial Synthesis

**Risk summary.** The danger is trading a visible bug (lag) for an invisible one (a permanently paused terminal). Every failure mode of a credit scheme is silence: a lost ack, a counter not reset on reconnect, a replay frame counted against the budget, or an evicted client's credit never released all produce a terminal that simply stops printing with no error anywhere. Mitigations are structural, not incidental: exclude replay from accounting, reset the counter with the `ClientState` on every attach, release credit on eviction and close, and extend the existing drain poller to re-evaluate the char watermark so no pause can be terminal (the same reasoning the `DRAIN_POLL_MS` comment already records for `bufferedAmount`). Add a hard safety valve — if a terminal has been paused longer than `MAX_PAUSE_MS` with no ack movement, force-resume and log — so the worst case degrades to today's behaviour rather than to a dead terminal. Residual accepted risk: a genuinely slow renderer now paces the pty, so high-volume commands take longer to complete their output; that is the intended trade.

## Proposed Changes

### `src/standalone/terminalWsGateway.ts`

**Context.** One class owns the per-terminal scrollback ring, the coalescing timers, the client set, and the backpressure decision.

#### (a) Char-count constants and per-client credit

Add alongside the existing byte watermarks (keep those; they become the secondary guard):

- `LOW_WATER_CHARS = 5000`, `HIGH_WATER_CHARS = 100000`, `MAX_PAUSE_MS = 10000`.
- `ClientState` (`:91-96`) gains `unackedChars: number` (init `0`).

> **Superseded:** `ClientState` also gains `pausedSince?: number`.
> **Reason:** The pause decision is per-terminal (`pausedTerminals` set, `pty.pause()`), not per-client. A per-client stamp is ambiguous with several attached clients — which client's stamp did the pausing? — and a client attached after the pause began would carry no stamp at all, silently breaking the `MAX_PAUSE_MS` safety valve.
> **Replaced with:** Track `pausedSince` per terminal — a `Map<string, number>` parallel to `pausedTerminals`, stamped on the transition into pause and cleared on resume.

Document why two independent watermarks coexist: bytes measure the transport (correct for remote/tunnelled clients), chars measure the renderer (correct for loopback). Either may pause; both must clear to resume.

#### (b) Count on send, discount on ack

In `flushOutput` (`:184-225`), after `safeSendBinary` succeeds for a client, add `client.unackedChars += combined.length`. Do **not** count the connect-time replay frame in `setupClient` (`:386-395`) — it is a catch-up burst the client has not yet asked for credit against, and at up to 256 KB it exceeds the entire high-water budget on its own.

In the message handler (`:405-419`), add:

```
else if (parsed.t === 'ack' && typeof parsed.chars === 'number') { … }
```

Resolve the `ClientState` by `ws` identity, ignore unknown clients, and subtract with a clamp: `client.unackedChars = Math.max(0, client.unackedChars - Math.min(parsed.chars, client.unackedChars))`. Then call `checkBackpressure` for that terminal so a resume can fire on the ack itself rather than waiting up to `DRAIN_POLL_MS`.

#### (c) `checkBackpressure` decides on the worse of the two signals

Rework (`:266-309`) to compute `maxUnacked` alongside the existing `maxBuffered`, and pause when `maxBuffered > HIGH_WATER_MARK_BYTES || maxUnacked > HIGH_WATER_CHARS`; resume only when `maxBuffered < LOW_WATER_MARK_BYTES && maxUnacked < LOW_WATER_CHARS`. Stamp the per-terminal `pausedSince` on the transition into pause and clear it on resume.

Add the safety valve: if `pausedSince` is set and `Date.now() - pausedSince > MAX_PAUSE_MS`, force-resume, zero every attached client's `unackedChars`, and `console.warn` with the terminal name. A stuck counter must degrade to lag, never to silence.

Keep the eviction path (`:279-292`) but release credit when a client is evicted or removed — deleting the `ClientState` already does this, provided the `maxUnacked` computation only walks `targetClients`.

#### (d) Reset credit on attach

In `setupClient` (`:355-360`), `unackedChars` starts at `0` with the new `ClientState`. Explicitly comment why: a reconnecting client's credit belongs to a socket that no longer exists, and carrying it forward would leave the terminal paused with no client able to ack it down.

#### (e) One shared flush tick

Replace the per-terminal `setTimeout` in `scheduleFlush` (`:171-178`) with a single class-level `setInterval` at `OUTPUT_FLUSH_MS` that walks a `Set<string>` of terminals with pending output and flushes each. Arm the interval on the first pending terminal and clear it when the set empties, so an idle fleet costs no timer at all.

`drainPending` (`:253-264`) must keep working — it is called from `untrackTerminalData` before announcing exit and must remain synchronous. Have it flush directly from the pending map and remove the terminal from the pending set rather than relying on the tick.

**Edge cases.** `flushOutput`'s re-arm when a window exceeds `MAX_FLUSH_BYTES` (`:222-224`) becomes "leave the terminal in the pending set" — the next tick picks it up. `dispose` (`:482-497`) must clear the shared interval.

### `src/webview/terminals.js`

#### (f) Ack from the write callback

`flushBatch` (`:1266-1275`) becomes:

- Guard the whole body: return early if the entry is disposed or `entry.term` is gone.
- Wrap `entry.term.write(...)` in try/catch. On throw, log with the terminal name and the pending length — this is xterm's 50 MB `_pendingData` valve and it currently escapes into a rAF callback with no diagnostic.
- Pass a callback: `entry.term.write(combined, () => onWriteParsed(entry, combined.length))`.

`onWriteParsed` accumulates into `entry.pendingAckChars` and sends `{t:'ack', chars:N}` once it reaches `ACK_CHUNK_CHARS = 5000`, zeroing the accumulator. It must no-op when the socket is not `OPEN` and when the entry has been disposed.

Flush any residual `pendingAckChars` on socket close is **not** required (the server resets credit on attach) but the accumulator must be zeroed in `connectTerminalSocket` (`:1147-1151`) so a reconnect does not ack characters the new server-side counter never issued.

#### (g) One page-level drain

Replace the per-entry `animationFrameId` (`:1248-1264`) with module-level state: a `Set` of entries with pending data, one `rafId`, one `fallbackTimerId`.

- `scheduleBatchFlush(entry)` adds the entry to the set and arms the shared rAF and the shared `BATCH_FALLBACK_MS` timer if not already armed.
- The drain walks the set, calls `flushBatch` for each, and clears the set.
- Keep the fallback timer and its comment (`:1255-1257`) verbatim in intent — it is the only thing draining terminals while the panel is `display:none`, and the reason is unchanged.

`destroyTerminalView` (`:1036-1064`) must remove the entry from the pending set instead of cancelling a per-entry rAF, and its `entry.animationFrameId` / `entry.batchFallbackTimer` handling goes with it. Drop those fields from the entry shape (`:1095-1110`).

#### (h) Debug stats

Expose `window.__sbTerminalStats` — a getter returning, per terminal: `lastSeq`, `batchQueue.length`, `pendingAckChars`, bytes written since load, and count of write throws. Without this there is no way to confirm the fix works or to diagnose a stuck counter in the field. Console-only; no UI.

## Verification Plan

### Automated Tests

New `src/test/terminal-flow-control-contract.test.js`, following the source-text convention of the existing contract tests and registered in `package.json` with the same `node --require ./src/test/bootstrap/sandboxStateHome.js` prefix as its siblings, plus the CI workflow entry.

1. **`terminals.js` acks from a write callback.** Assert `term.write(` is called with two arguments in `flushBatch` and that the ack send is reachable only from that callback — not from `ws.onmessage`.
2. **The write is guarded.** Assert `flushBatch` contains a `try`/`catch` around the write.
3. **Gateway handles `ack`.** Assert `terminalWsGateway.ts` has a `parsed.t === 'ack'` branch that clamps with `Math.max(0, …)`.
4. **Replay is not counted.** Assert `setupClient`'s replay `safeSendBinary` is not followed by an `unackedChars +=` in the same block.
5. **Both watermarks gate the resume.** Assert the resume condition is a conjunction of the byte and char low-water checks, and the pause a disjunction of the high-water checks.
6. **The safety valve exists.** Assert `MAX_PAUSE_MS` is referenced inside `checkBackpressure`.
7. **No per-terminal rAF remains.** Assert `terminals.js` no longer contains `entry.animationFrameId`.
8. **Credit resets on attach.** Assert `unackedChars` is initialised in the `ClientState` literal in `setupClient`.

### Manual

1. **Reproduce first.** With the fleet idle, run `yes | head -c 50000000` in one browser terminal. Record time-to-prompt and whether typing in a *second* terminal is responsive during it. Capture `window.__sbTerminalStats` mid-run.
2. **Post-fix, same command:** typing in the second terminal stays responsive throughout, and `batchQueue.length` stays bounded (it should not climb into the thousands).
3. **Pause actually fires.** Confirm via a `console.warn` or a temporary log that `pty.pause()` is called during the firehose and `resume()` afterwards — this is the assertion that the old code path never satisfied.
4. **Terminal is not left dead.** After the firehose ends, run `echo hello` in the same terminal and confirm it prints. Repeat five times; a credit leak shows up as an eventual silent terminal.
5. **Reconnect mid-firehose.** Kill the WS from devtools (or stop/start the standalone server) while output is streaming. Confirm the terminal reconnects, replays, and resumes printing — and specifically that it is not left paused.
6. **Two tabs on one terminal.** Attach the same terminal in two browser tabs, block one tab (devtools breakpoint on the drain), and confirm the pty pauses for both and resumes when the breakpoint is released.
7. **Hidden panel.** Start a firehose, switch to the Board panel for 30 s, switch back. Output must be current, not a banked avalanche — this is the `BATCH_FALLBACK_MS` path surviving the refactor.
8. **Nine terminals.** In the 3x3 layout with nine active agents, confirm the page stays interactive and no terminal starves.
9. **Regression suite.** Run the contract tests. Confirm the five known-red tests at HEAD are unchanged — stash-verify before attributing any red test to this work.

## Uncertain Assumptions

The following are external (third-party/OS) claims that cannot be verified from this repository. The user was advised to run web research to confirm them before implementation; a ready-to-run research prompt was supplied in chat.

- VS Code's pty-host char-count flow-control constants are exactly `HighWatermarkChars = 100000`, `LowWatermarkChars = 5000`, `CharCountAckSize = 5000` — the values this plan adopts as `HIGH_WATER_CHARS` / `LOW_WATER_CHARS` / `ACK_CHUNK_CHARS`.
- Chrome's loopback WebSocket behaviour: the server-side `ws.bufferedAmount` stays near zero over loopback because the browser's network service drains the socket eagerly into a mojo pipe on a thread separate from the (potentially blocked) renderer.

## Recommendation

Complexity 7 → **Send to Lead Coder.** This is the keystone of the feature; the other three plans are cheaper and safer once it lands.
