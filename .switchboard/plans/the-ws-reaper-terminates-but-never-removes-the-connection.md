# The WebSocket reaper terminates a dead connection but never removes it, so it reaps the same clients forever

## Goal

Make the wsHub reaper remove the connection it reaps, instead of calling `terminate()` and trusting a `close` event that does not arrive for an already-dead socket. Today a dropped client is re-reaped every 30 seconds for the life of the process — it stays in the broadcast set, it is logged every tick, and nothing ever cleans it up.

### The problem, and the root cause

**The reaper deletes nothing.** `wsHub.ts:190-201`:

```ts
this._pingInterval = setInterval(() => {
    for (const meta of this._connections) {
        if (meta.isAlive === false) {
            console.warn(`[wsHub] reaping connection with no pong: originatorId=…`);
            try { meta.ws.terminate(); } catch { /* ignore */ }
        } else {
            meta.isAlive = false;
            try { meta.ws.ping(); } catch { /* ignore */ }
        }
    }
}, this._options.pingIntervalMs ?? 30000);
```

The reap branch calls `terminate()` and moves on. It never calls `this._connections.delete(meta)`. Removal happens only in `handleDisconnect` (`:361`), which is registered on `close` and `error` (`:375-379`). So the reaper depends entirely on `terminate()` producing a `close` event.

**For an already-dead socket it does not.** When the peer has vanished without a TCP FIN — a dropped tunnel, a sleeping laptop, a killed browser — the `ws` readyState is already `CLOSED` by the time the reaper runs. `terminate()` on a closed socket is a no-op and emits nothing. `handleDisconnect` never runs. The meta stays in `_connections`, `isAlive` stays `false`, and the next tick reaps it again. Forever.

**Measured, not inferred.** A live `server.log` shows the identical six `originatorId`s reaped on every 30-second tick across dozens of consecutive cycles — `client_0svtnftvy_…`, `client_mrygaiebq_…`, `client_d3o6uy66o_…`, `client_zxggksvp7_…`, `client_iajfbrgg9_…`, `client_ry1vqu23a_…`. Two generations of clients about 25 minutes apart, both still being reaped long after the browser tabs were gone.

**The decisive evidence is a line that is absent.** `handleDisconnect` logs `[wsHub] connection closed: originatorId=…, remaining=N` whenever it runs. **Not one such line appears** anywhere in the reaping output. If `terminate()` were producing a close, every reap would be followed by a matching "connection closed". None is. That is the proof that the cleanup path is never entered.

**Three consequences, in increasing order of cost.**

1. **The log grows without bound.** The observed `server.log` is 7.7 MB and the overwhelming majority of it is this one message repeating. It also buries anything useful — which is exactly how a remote-access debugging session ends up with no signal to read.
2. **`_connections` leaks.** Every client that ever disconnects uncleanly stays in the set for the process lifetime. A long-lived board accumulates them.
3. **Every broadcast pays for them.** The set is iterated on each push, so dead entries cost work on every board update, and each one is a `send()` into a dead socket that throws and is swallowed.

**The root cause is a cleanup path with two owners and no fallback.** Removal was designed to be event-driven, which is right for the normal case: a clean close fires `close`, `handleDisconnect` runs, the entry goes. The reaper was added for the abnormal case — a peer that stopped answering — and reused the same event-driven removal, which is precisely the mechanism that cannot be relied on when the peer is already gone. The reaper is the only code that *knows* the connection is dead, and it is the one path that does not act on that knowledge.

## Metadata

> **Superseded:** Complexity: 2
> **Reason:** A 2 is "trivial config/copy." This is a shared-helper extraction with a disconnect-listener divergence concern — the plan itself calls it "the same class of bug as the one being fixed." That is not trivial; it is a localized single-file change with one moderate, well-scoped correctness risk. That is a 3.
> **Replaced with:** Complexity: 3

- **Complexity:** 3
- **Tags:** backend, bugfix, reliability, performance

## User Review Required

None. Two decisions made and recorded:

1. **The reaper deletes the entry itself, and `handleDisconnect` stays idempotent.** It already guards with `if (this._connections.has(meta))`, so a later `close` that does arrive is harmless. Do not replace the event-driven path — belt and braces is correct here, because the two cases genuinely differ.
2. **Log the reap once, not every tick.** With removal fixed this follows automatically; no separate rate-limiting is needed.

## Complexity Audit

### Routine

- Adding a `delete` and firing the disconnect listeners in the reap branch. A handful of lines.
- Extracting the shared `removeConnection(meta)` helper — the body already exists in `handleDisconnect` (`:361-373`); it is a move, not new logic.

### Complex / Risky

- **The disconnect listeners.** `handleDisconnect` notifies `_disconnectListeners` with the `originatorId`. The reaper must do the same or a reaped client is removed from the broadcast set without whatever bookkeeping those listeners perform — a silent divergence between the two removal paths, which is the same class of bug as the one being fixed. Confirmed by inspection: `DesignPanelProvider.setApiServer` (`:221`) registers an `onDisconnect` listener that evicts design seats on a grace timer. If the reaper removes without firing that listener, a reaped design seat is never evicted. Extract one `removeConnection(meta)` helper and call it from both, rather than duplicating the body.
- **Mutating a `Set` while iterating it.** The reap happens inside `for (const meta of this._connections)`. Deleting during iteration is safe for `Set` in JS (the spec guarantees deleted-but-not-yet-visited entries are skipped), but the loop should be made explicit about it — snapshot with `Array.from` before iterating.

## Edge-Case & Dependency Audit

- **A `close` that arrives after the reap.** `handleDisconnect`'s `has()` guard makes the second removal a no-op. Keep that guard.
- **`terminate()` throwing.** Already wrapped. The delete must happen regardless of whether `terminate()` succeeds — put it outside the `try`, or the throwing case leaks exactly as it does today.
- **Snapshotting the reaper's iteration.** `Array.from(this._connections)` before the `for...of` in the ping interval. This is the iteration where mutation happens during the loop. (Note: the broadcast path also iterates `_connections` with `for...of`, but the reaper runs in `setInterval` and `broadcast` is synchronous — Node's single-threaded event loop means they cannot interleave. Snapshotting `broadcast` is harmless defensive practice but is not fixing a real race; the load-bearing snapshot is the reaper's.)
- **`isAlive` after removal.** `meta` is per-connection, created fresh in `handleUpgrade` (`:288`). Once the reaper removes the entry, that `meta` is unreachable — no other code holds the reference. There is no `isAlive`-reset concern; the next connection gets its own `meta` with `isAlive: true`.
- **Both hosts.** `wsHub` is shared, so this fixes the extension and standalone together. Confirmed by inspection: `LocalApiServer` (`:929-936`) constructs `WsHub` without `pingIntervalMs` (defaults to 30000) and calls `attach(false)`. Neither `extension.ts` nor `standalone/bootstrap.ts` wraps or replaces the ping interval — neither even imports `WsHub` directly (standalone imports only `SURFACES`). No composition-root wiring diverges.
- **Does not fix the underlying disconnects.** Clients still drop; this only stops the corpse being kept. Whether the drops themselves are a tunnel keepalive problem is a separate question and out of scope here.

## Dependencies

None. Self-contained in one file, no schema, no migration, no config.

## Adversarial Synthesis

Key risks: (1) firing the reaper's `delete` without firing `_disconnectListeners` — silently diverging the two removal paths and breaking `DesignPanelProvider` seat eviction; mitigation: one shared `removeConnection(meta)` helper used by both. (2) Putting the `delete` inside the existing `try` around `terminate()`, so a throw still leaks; mitigation: delete unconditionally, outside the try. (3) The new contract test using `autoPong: false` (like the existing test B2), which passes today because the socket is still OPEN when terminated — the test must assert removal synchronously in the reaper tick, not wait for a `close` event, or it proves nothing. (4) Claiming this fixes the remote-access spinner that surfaced it — it does not; it fixes the leak and the log noise, and the disconnect cause is separate.

## Proposed Changes

### `src/services/wsHub.ts`

- Extract the body of `handleDisconnect` (`:361-373`) into a private `removeConnection(meta: ConnectionMeta)` that: guards on `this._connections.has(meta)`; deletes from `_connections`; logs the "connection closed" line with `remaining=N`; fires `_disconnectListeners` with `meta.originatorId` (only if defined), iterating `Array.from(this._disconnectListeners)` with the existing per-listener `try/catch`.
- Call `removeConnection(meta)` from the reap branch (`:192-195`), **unconditionally and outside the `try` wrapping `terminate()`**. The `terminate()` call stays inside its `try`; the `removeConnection` call comes after it, so a throwing `terminate()` still results in removal.
- Have `handleDisconnect` call `removeConnection(meta)` instead of inlining the body. The `has()` guard moves into the helper.
- Snapshot the connection set with `Array.from(this._connections)` before iterating in the ping interval (`:191`), so deletion during iteration is explicit.

### `src/test/wshub-reaper-contract.test.js` — new

- A focused contract test for the reaper's removal behavior, separate from the broader `design-view-state-seats-contract.test.js` seats tests.

## Files Changed

- `src/services/wsHub.ts` — the shared removal helper and the reaper's use of it
- `src/test/wshub-reaper-contract.test.js` — new

## Verification Plan

### Automated Tests

1. **A reaped connection is removed synchronously in the reaper tick.** Add a connection, force `isAlive = false`, run one tick, and assert `_connections.size === 0` **inside or immediately after the tick callback, before the event loop can deliver a `close` event**. This is the critical assertion: the existing test B2 in `design-view-state-seats-contract.test.js` uses `autoPong: false` and passes *today* because the socket is still OPEN when `terminate()` is called — `close` fires, `handleDisconnect` removes it. That does not reproduce the production bug (where `close` never comes). To prove the fix, the test must demonstrate that removal is the reaper's own action, not deferred to an event. Either (a) assert synchronously before `close` can fire, or (b) mock/stub the `ws` so `terminate()` is a true no-op that emits nothing. **This fails today** only if the test is constructed this way — assert that first, or the test proves nothing.
2. **It is reaped exactly once.** Run three ticks against one dead connection and assert exactly one reap log line, not three.
3. **Disconnect listeners fire on the reap path**, with the same `originatorId` a `close` would have delivered. Register an `onDisconnect` listener, reap a connection, assert the listener was called once with the correct `originatorId`.
4. **A late `close` after a reap is a no-op** — no second log line, no second listener call, no throw. This validates the `has()` guard in `removeConnection`.
5. **`terminate()` throwing still removes the entry.** Stub `meta.ws.terminate` to throw, run a tick, assert `_connections.size === 0` and the listener fired.

### Goal Invariants

- `WsHub` in `src/services/wsHub.ts` has a private method named `removeConnection` that is called from both the ping-interval reap branch and the `handleDisconnect` closure.
- After one ping tick against a connection with `isAlive === false`, `this._connections` does not contain that connection's `meta` (assertion holds synchronously in the tick, not deferred to a `close` event).
- The reap branch in the ping interval calls `removeConnection` outside the `try` block that wraps `meta.ws.terminate()`.
- The ping-interval `for...of` iterates over `Array.from(this._connections)`, not `this._connections` directly.

### Manual

6. Open a board, kill the client uncleanly (close the laptop, drop the tunnel), and watch `server.log`: expect one reap line followed by silence — not a line every 30 seconds.

## Recommendation

Complexity 3 → **Send to Coder**.
