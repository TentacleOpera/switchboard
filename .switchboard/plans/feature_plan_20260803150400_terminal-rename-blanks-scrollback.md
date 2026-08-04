# Renaming a browser terminal blanks its window — the WS gateway never re-keys its per-terminal state

## Goal

Make renaming a terminal in the browser Terminals panel a purely cosmetic operation: the pane keeps showing the conversation that was already on screen, and the terminal keeps a working scrollback ring afterwards.

### Observed problem

Rename a terminal in `terminals.html` (sidebar `rename` button or the pane title inline edit). The pane goes completely blank and stays blank until new output arrives — typically the operator types something, which produces echo, and content starts appearing again from that point. The scrollback that was on screen a moment earlier is gone.

### Root cause

`TerminalWsGateway` keys **all** of its per-terminal state by terminal name, and it never handles the fleet's `renamed` event. Re-verified against the current source during this review; line numbers below are corrected to the live files.

`PtyFleetService.rename` (`src/standalone/ptyFleetService.ts:159-171`) re-keys its own map, mutates `handle.friendlyName` and `handle.name` in place, and emits `{ type: 'renamed', oldName, newName }` (contract at `:38-45`). The gateway's fleet listener (`src/standalone/terminalWsGateway.ts:307-315`) switches on `created` and `closed` only — `renamed` falls through to a bare `broadcastWs('terminalsChanged')`. Nothing is re-keyed.

The consequences follow directly from that:

1. **Blank on re-attach.** `terminals.js` `renameTerminal` (`src/webview/terminals.js:1626-1662`) calls `destroyTerminalView(name)` (`:1639`), then `renderPaneGrid()` builds a fresh view under the new name that connects with `lastSeq = 0`. `setupClient` looks up `this.scrollbackBuffers.get(terminal.name)` (`terminalWsGateway.ts:582`) — the buffer is still filed under the **old** name, so the lookup misses, `replayFrame` is never built, and the hello frame reports `seq: 0`. The pane renders empty.
2. **The ring stays permanently dead.** `trackTerminalData` (`:318-340`) is only ever called on `created` (`:308-309`), and it early-returns on `terminalSubscriptions.has(t.name)`. No buffer is ever created for the new name. In `flushOutput`, `this.scrollbackBuffers.get(terminalName)` misses (`:386`), so `seq` stays `0` and nothing is appended to any ring. Live output still reaches clients — the `onData` closure reads `t.name` at callback time and `rename()` mutated it, so `pendingOutput`/`flushOutput` land on the **new** name and the fan-out filter `c.terminalName === terminalName` (`:400`) matches. That is exactly why content reappears "when you type something", and why it looks like a display glitch rather than lost state.
3. **Client-side resume dies with it.** Every post-rename frame carries `seq === 0`, so `entry.lastSeq` never advances (`src/webview/terminals.js:1982-1988`). A later reconnect asks for the whole ring, gets nothing, and blanks again.
4. **Leaked subscription.** On close, `untrackTerminalData(name)` is called with the *new* name and looks up `terminalSubscriptions.get(newName)` (`:415-419`) → undefined. The old-name `onData` subscription is never disposed.

This is host-agnostic: the same `TerminalWsGateway` serves the standalone bootstrap (`src/standalone/bootstrap.ts:1308-1318`) and the extension's spawned pty host (`src/standalone/ptyHost.ts:40-42`), so both paths are affected and one fix covers both.

### Root cause 5 — a consequence the first draft missed, introduced by the client-side change

The client-side re-key in Proposed Changes §3 removes a mask that `destroyTerminalView` was providing. `ws.onclose` (`src/webview/terminals.js:2039-2052`) reads `entry.exited` and, if the terminal is still listed as active, schedules `entry.reconnectTimer = setTimeout(() => connectTerminalSocket(entry), delay)`. `destroyTerminalView` sets `entry.exited = true` (`:1766`) *before* closing the socket, so today that handler always early-returns.

Re-keying instead of destroying sets no such flag. `connectTerminalSocket` closes the previous socket (`:1939-1942`) and the browser dispatches that `close` event in a later task — by which point `fetchTerminalList()` may have refreshed `fleetList` with the **new** name at status `active`, and `entry.name` is already the new name. The stale handler then matches, arms a 500 ms timer, and reconnects — tearing down the socket the re-key just opened. Not fatal (the reconnect replays the tail correctly) but it is avoidable churn on every rename, and it is the kind of thing that only shows up as an intermittent flicker in the field. The fix is one line and is a general improvement to `connectTerminalSocket`, not a special case for rename.

## Metadata

- **Complexity:** 6
- **Tags:** bugfix, backend, frontend, reliability

> **Superseded:** **Complexity:** 5
> **Reason:** Two additions raise it: the stale-`onclose` guard in `connectTerminalSocket` (Root cause 5), which is a second live-socket behaviour the client change depends on, and the exited-terminal guard. The change is still small, but the number of interacting socket-lifecycle invariants it must hold is now high enough that a reviewer needs to trace them rather than read them.
> **Replaced with:** **Complexity:** 6

## User Review Required

- **Change §3 (client re-key) is separable.** Changes §1 and §2 alone fix the reported bug and the ring. §3 is what removes the visible flash and preserves the operator's scroll position across the rename, at the cost of two extra socket-lifecycle guards. If you want the smallest possible landing, ship §1+§2 first and §3 as a follow-up — the test file is written so the §3 assertion is clearly separable.
- **The test suite for this is source-level only.** Every assertion reads the `.ts`/`.js` as text. "5 passing" is evidence the code was *written*, not that the ring *works*. Manual verification step 5 (unassign → wait past the 15 s detach grace → re-assign → scrollback replays) is the only check that actually proves the buffer was repaired. Do not treat a green suite as the acceptance criterion.
- **Longer-term: names are the wrong key.** This plan re-keys eight collections on rename. The structural fix is a stable per-terminal ID with the name as a display label — see the architecture note under Adversarial Synthesis. That is a separate, much larger plan; flagged so the decision is explicit rather than defaulted.

## Complexity Audit

### Routine

- No protocol change, no persisted state, no schema, no API surface change.
- The re-key itself is two small helpers and eight lines of calls.
- The verb arm and event contract already exist and already carry `oldName`/`newName`.

### Complex / Risky

- **Seven name-keyed collections plus the client list must move atomically** in one synchronous step, or a flush landing mid-rename writes into a half-migrated map. Node's single-threaded model makes a synchronous handler safe; the handler must therefore contain no `await`.
- **`client.terminalName` is read in four places** — the fan-out filter (`:400`), the ack/backpressure path (`:680-684`), the resize path (`:697`, `:702`, `:735`) and the drain poller's per-terminal filter (`:764`). Missing the re-point leaves connected clients stranded on a name the gateway no longer knows.
- **Ordering between server and client is load-bearing.** The client reconnects on the rename's HTTP response, so the re-key must be complete before that response is written. Verified end to end: `EventEmitter.emit` runs handlers inline and `fleet.rename` emits before returning (`ptyFleetService.ts:169`); `ptyHost`'s `ptyRenameTerminal` arm returns `{ success: ok }` after it (`ptyHost.ts:81-83`); in the extension host `TaskViewerProvider.handlePtyVerb` does `const result = await this._ptyHostVerb(verb, payload)` (`TaskViewerProvider.ts:1948`); and `LocalApiServer` writes the response only after `const result = await terminalVerb(...)` (`LocalApiServer.ts:1657`). Both hosts hold — but it is a chain of four hops and deserves the comment in the code.
- **The client-side re-key changes socket lifecycle**, and it removes the `entry.exited` mask that made a stale `onclose` harmless (Root cause 5). It degrades safely to today's destroy/replay behaviour if skipped entirely, but it cannot be half-applied.

## Edge-Case & Dependency Audit

### Race Conditions

| Case | Handling |
| :--- | :--- |
| Rename while output is mid-flush (`pendingFlushTerminals` holds the old name) | Re-key `pendingOutput`, `pendingFlushTerminals` and `inputQueues` together in the same synchronous handler; the next `flushAllPending` tick sees only the new name. |
| Rename while the terminal is paused for backpressure | `pausedTerminals` and `pausedSince` must move too, or `checkBackpressure` (`:454`) and the drain poller (`:763-770`) can never un-pause the new name and output stalls permanently. |
| Flush landing between the emit and the response | Cannot happen: the handler is synchronous and the event loop does not yield inside it. Enforced by the `no await` test. |
| Stale `onclose` from the socket the client re-key replaces | `connectTerminalSocket` nulls the outgoing socket's `onclose` before closing it — see Proposed Changes §4. Without this the stale handler can arm a reconnect that tears down the socket just opened. |
| Frames in flight when the client re-keys | `connectTerminalSocket` closes the old socket, then reads `entry.lastSeq`. Anything the server sent after that read is still in the ring at `seq > lastSeq` and is replayed on the new connection. No gap, no duplication. |

### Security

- No new network surface. The WS token check, the `?name=` lookup and the per-client credit ledger are all unchanged. `rekeyTerminal` acts only on names the fleet has already accepted, and the fleet rejects a rename onto an existing name before emitting.

### Side Effects

| Case | Handling |
| :--- | :--- |
| Rename to a name already in use | `PtyFleetService.rename` returns `false` before emitting (`:160`); no event, no re-key, client's `data.success` is false and it leaves the view alone. |
| Two clients attached, only one initiated the rename | `client.terminalName` is re-keyed for every matching client, so the passive tab keeps streaming. Its `terminalsChanged` broadcast makes the sidebar re-label. |
| Rename immediately followed by close | `untrackTerminalData` now finds the subscription under the new name and disposes it. Fixes the current leak. |
| Rename of a terminal with no live client | Maps re-key; no client loop work. Next attach replays correctly. |
| Rename an already-exited terminal | Handle is still in the fleet map, so the rename succeeds and the buffer moves. But `setupClient` re-sends `{t:'exit'}` (`:633-635`), and with the client-side re-key the pane already shows an exit line — so a reconnect would print a **second** `[Process Exited with code N]` under the first. Guarded: §3 only reconnects when `entry.term && !entry.exited`. |
| Collision: new name already has a buffer (should be impossible — the fleet rejects it first) | Guard defensively: if the destination key is occupied, log and skip the move rather than clobbering a live ring. |
| Client `lastSeq` continuity after the client-side re-key | The buffer and its `nextSeq` are preserved by the move, so reconnecting with the retained `lastSeq` replays only the tail — the on-screen buffer is not duplicated. |
| Operator scrolled up when the rename lands | With the re-key the view is not destroyed, so `isUserScrolling` is preserved and the tail replay does not yank them to the bottom. With today's destroy/replay it does. |
| `detachTimers` under the old name | `renameTerminal` already calls `cancelDetachTimer` for both the old and new names at entry (`:1629-1630`). The re-key adds no new timer state. |
| Undo snapshot / badges / pane assignments | Already handled by `renameTerminal` (`:1640-1656`); unchanged. |
| `pendingBatchEntries` | Holds `entry` object references, not names — unaffected by the re-key. |

### Dependencies & Conflicts

- **`PtyFleetService` event contract** (`ptyFleetService.ts:38-45`), **`terminals.js` reconnect path**, **`ptyHost.ts` verb arm**. No API surface changes.
- **Shared file with the terminal-scrollbar plan.** `feature_plan_20260803150500_terminal-pane-scrollbar-and-jump-to-latest.md` also edits `src/webview/terminals.js`, but in `materializeTerminalView` (`:1872`), `destroyTerminalView` (`:1762`) and the `createTerminalView` entry literal (`:1821-1843`) — disjoint from this plan's `renameTerminal` (`:1626`) and `connectTerminalSocket` (`:1938`). Land in either order.
- **Positive interaction with that plan.** The client-side re-key moves the whole `entry` object, so that plan's `scrollDisposable` / `jumpBtn` / viewport listener survive a rename for free, and the operator's scroll position (and therefore its jump-to-latest pill) is preserved rather than reset.

## Dependencies

- None — no prior session artefacts are required.

## Adversarial Synthesis

**Risk summary.** The dangerous failure mode here is a partial fix that *looks* complete: moving only `scrollbackBuffers` makes the pane render correctly while `terminalSubscriptions`, `pausedTerminals` and `pausedSince` stay stale — a terminal that streams fine until it hits backpressure, then stalls forever, and leaks its `onData` subscription on close. Mitigated by moving all seven collections plus `client.terminalName` in one synchronous handler, and by a drift test that cross-checks `rekeyTerminal`'s move list against `untrackTerminalData`'s teardown list so an eighth collection added later cannot be silently forgotten. Secondary risks: the client-side re-key removes the `entry.exited` mask that made a stale `onclose` harmless (guarded in §4), and the whole test suite is source-regex only — manual step 5 is the only real proof the ring was repaired.

**Architecture note.** The chosen approach — re-key on the `renamed` event — was weighed against keying gateway state by a stable terminal ID with the name demoted to a display label. The ID approach eliminates this bug class outright rather than patching one event, but the name is the handle in the WS query string, the fleet registry, `/health`, worktree routing and every client map; converting it is a multi-file migration with its own compatibility surface, and it would not be a bug fix. Re-keying is correct, minimal and directly testable, and it does not foreclose the ID refactor later. A third option — treating rename as close-plus-create — was rejected outright: it destroys the scrollback ring, which is the symptom being fixed.

## Proposed Changes

### 1. `src/standalone/terminalWsGateway.ts` — handle `renamed` in the fleet listener

**Context.** `initFleetListeners` (`:300-316`). The listener currently has arms for `created` and `closed` only.

**Logic.** Add a third arm before the unconditional `terminalsChanged` broadcast, so the re-key completes before any client learns the rename happened.

**Implementation.**

```ts
        this.fleetService.onDidChange((event) => {
            if (event.type === 'created') {
                this.trackTerminalData(event.terminal);
            } else if (event.type === 'closed') {
                this.untrackTerminalData(event.name, event.code);
            } else if (event.type === 'renamed') {
                this.rekeyTerminal(event.oldName, event.newName);
            }
            if (this.broadcastWs) {
                this.broadcastWs('terminalsChanged', {}, 'terminals');
            }
        });
```

**Edge cases.** `FleetChangeEvent` is a discriminated union (`ptyFleetService.ts:38-45`), so `event.oldName`/`event.newName` narrow correctly with no cast.

### 2. `src/standalone/terminalWsGateway.ts` — the re-key itself

**Context.** The eight name-keyed collections are declared together at `:124-131`. `untrackTerminalData` (`:415-441`) is the existing method that tears the same set down; keep the new method beside it so the two stay visibly paired.

**Logic.** Move every collection from `oldName` to `newName`, then re-point every attached client. Synchronous throughout.

**Implementation.**

```ts
    /**
     * Move every name-keyed collection from `oldName` to `newName` after a fleet
     * rename.
     *
     * PtyFleetService.rename keeps the SAME handle and mutates `handle.name` in
     * place, so the `onData` closure installed by trackTerminalData starts
     * reporting the new name the instant the rename lands — while every map here
     * is still filed under the old one. Left unhandled that produced a terminal
     * with no scrollback ring at all: setupClient's buffer lookup missed and
     * replayed nothing (blank pane), flushOutput's lookup missed so nothing was
     * ever appended and every frame shipped seq 0 (client resume permanently
     * dead), and untrackTerminalData later missed the subscription and leaked it.
     *
     * Keep this list in sync with untrackTerminalData — a name-keyed collection
     * added to one and not the other reintroduces exactly this bug for a
     * different piece of state. terminal-rename-rekey-contract.test.js
     * cross-checks the two bodies for that reason.
     *
     * MUST stay synchronous. EventEmitter.emit runs handlers inline, so this
     * completes before fleet.rename() returns to the ptyRenameTerminal verb arm
     * (ptyHost.ts:81-83), and therefore before the HTTP response the client
     * reconnects on is written (LocalApiServer.ts:1657 awaits the verb first).
     * An await anywhere in here would open a window where a flush lands on a
     * half-migrated set of maps AND break that ordering.
     */
    private rekeyTerminal(oldName: string, newName: string): void {
        if (!oldName || !newName || oldName === newName) { return; }
        if (this.scrollbackBuffers.has(newName) || this.terminalSubscriptions.has(newName)) {
            console.warn(`[TerminalWsGateway] rekey ${oldName} -> ${newName} skipped: destination already tracked`);
            return;
        }

        const moveMap = <T>(map: Map<string, T>) => {
            if (!map.has(oldName)) { return; }
            map.set(newName, map.get(oldName)!);
            map.delete(oldName);
        };
        const moveSet = (set: Set<string>) => {
            if (!set.delete(oldName)) { return; }
            set.add(newName);
        };

        moveMap(this.scrollbackBuffers);
        moveMap(this.terminalSubscriptions);
        moveMap(this.pendingOutput);
        moveMap(this.inputQueues);
        moveMap(this.pausedSince);
        moveSet(this.pendingFlushTerminals);
        moveSet(this.pausedTerminals);

        // Connected clients asked for the old name and are still attached to the
        // same pty. Re-point them or the fan-out filter (c.terminalName === name,
        // :400) stops matching and they go silent — including tabs that did not
        // initiate the rename and have no reason to reconnect. The ack path
        // (:680-684), the resize path (:697) and the drain poller (:764) read the
        // same field.
        for (const client of this.clients) {
            if (client.terminalName === oldName) {
                client.terminalName = newName;
            }
        }
    }
```

**Edge cases.** The destination guard fires only if the fleet somehow admitted a duplicate; logging and skipping is strictly safer than clobbering a live ring. `moveSet` uses `delete`'s boolean return so a set that never held the old name is left untouched.

### 3. `src/webview/terminals.js` — re-key the view instead of tearing it down

**Context.** `renameTerminal` at `:1626-1662`; the `destroyTerminalView(name)` call to replace is at `:1639`.

**Logic.** With the server fixed, the current `destroyTerminalView` + full-ring replay already restores the pane, but it round-trips up to `MAX_SCROLLBACK_BYTES` (256 KB, `terminalWsGateway.ts:5`), visibly flashes, and dumps an operator who was scrolled up back at the bottom. Re-keying keeps the rendered buffer and replays only the tail.

**Implementation.** Replace `:1639`:

```js
            if (data && data.success) {
                // Re-key rather than destroy: the gateway keeps the same scrollback
                // ring across a rename, so retaining this entry's lastSeq means the
                // reconnect replays only the tail instead of re-rendering the whole
                // 256 KB ring over a pane that already shows it — and an operator
                // who was scrolled up stays where they were.
                const entry = terminalsMap.get(name);
                if (entry) {
                    cancelDetachTimer(name);
                    terminalsMap.delete(name);
                    entry.name = next;
                    terminalsMap.set(next, entry);
                    // Not `entry.term` alone: reconnecting an exited terminal makes
                    // setupClient re-send {t:'exit'} (terminalWsGateway.ts:633-635),
                    // printing a SECOND "[Process Exited]" line under the one the
                    // pane already shows. A dead pty has nothing to reconnect to.
                    if (entry.term && !entry.exited) {
                        connectTerminalSocket(entry);
                    }
                } else {
                    destroyTerminalView(name);
                }
                for (let i = 0; i < paneAssignments.length; i++) {
```

`connectTerminalSocket` already closes the previous socket, resets the credit counters and appends `&lastSeq=` from the preserved `entry.lastSeq` (`:1938-1959`), so no other change is needed there beyond §4. The `entry.term === null` case (a view claimed but not yet materialised — `createTerminalView` defers construction until the container has a box) falls through without a socket; `materializeTerminalView` connects it under the new name when it renders.

**Edge cases.** `renderPaneGrid` (`:1261-1269`) re-parents `entry.container` by identity, so the live xterm and everything hung off the entry survive the rebuild that `fetchTerminalList()` triggers immediately after. The trailing `paneAssignments` / `activeTerminalName` / `undoSnapshot` / `terminalBadges` updates at `:1640-1656` are unchanged and still run after the re-key.

### 4. `src/webview/terminals.js` — drop the outgoing socket's `onclose` before closing it

**Context.** `connectTerminalSocket`'s prologue at `:1939-1942`. The `onclose` handler it needs to neutralise is at `:2039-2052`.

**Logic.** Today this is masked by `destroyTerminalView` setting `entry.exited = true` before it closes. §3 no longer sets that flag, so the stale handler can fire against a live entry and arm a reconnect that tears down the socket we just opened (Root cause 5). Nulling the handler on the way out is correct for every caller, not just rename.

**Implementation.**

```js
        if (entry.ws) {
            // Detach first. The browser dispatches `close` in a later task, and by
            // then entry.name / fleetList may have moved on (rename) — a stale
            // handler would arm a reconnect timer that tears down the socket this
            // call is about to open. Callers that WANT the reconnect are the ones
            // whose socket closed on its own, and their handler has already run.
            try { entry.ws.onclose = null; } catch { /* ignore */ }
            try { entry.ws.close(); } catch { /* ignore */ }
            entry.ws = null;
        }
```

**Edge cases.** The eviction/reconnect path is unaffected: there the socket closes server-side, `onclose` fires and schedules the timer, and by the time the timer calls `connectTerminalSocket` the handler has already done its work — nulling it then is a no-op.

### 5. `src/test/terminal-rename-rekey-contract.test.js` — new regression test

```js
'use strict';
/**
 * Contract: a fleet rename re-keys every per-terminal collection in the WS
 * gateway, and re-points attached clients.
 *
 * PtyFleetService.rename mutates handle.name in place, so the onData closure
 * switches to the new name immediately while the gateway's maps do not. The
 * result was a renamed terminal with no scrollback ring: blank on re-attach,
 * every subsequent frame stamped seq 0, and a leaked onData subscription on
 * close.
 *
 * These are SOURCE-LEVEL assertions. They prove the code was written, not that
 * the ring works — the gateway is TypeScript and instantiating it here would
 * mean asserting against build output. The behavioural proof is manual step 5
 * in the plan (unassign past the detach grace, re-assign, scrollback replays).
 * Do not read a green run as acceptance.
 *
 * The load-bearing assertion is the drift one: it derives the collection list
 * from untrackTerminalData rather than hardcoding it, so a name-keyed map added
 * later cannot be torn down on close while being silently skipped on rename.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const GATEWAY_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'standalone', 'terminalWsGateway.ts'), 'utf8');
const TERMINALS_JS = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'terminals.js'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

/** Body of a private method, up to its 4-space-indented closing brace. */
function methodBody(src, name) {
    const m = src.match(new RegExp(`private ${name}\\([\\s\\S]*?\\n    \\}`));
    assert.ok(m, `${name} not found`);
    return m[0];
}

test('the fleet listener handles the renamed event', () => {
    assert.match(GATEWAY_SRC, /event\.type === 'renamed'[\s\S]{0,120}rekeyTerminal\(/,
        "renamed must re-key; falling through to only broadcastWs('terminalsChanged') " +
        'leaves the scrollback ring filed under the old name');
});

test('every collection untrackTerminalData tears down is also moved on rename', () => {
    const rekey = methodBody(GATEWAY_SRC, 'rekeyTerminal');
    const untrack = methodBody(GATEWAY_SRC, 'untrackTerminalData');
    const collections = [...untrack.matchAll(/this\.(\w+)\.delete\(name\)/g)].map(m => m[1]);
    assert.ok(collections.length >= 7,
        `parsed only ${collections.length} name-keyed collections from untrackTerminalData ` +
        '— the parse is picking up the wrong thing, fix it rather than lowering the bound');
    for (const coll of collections) {
        assert.ok(rekey.includes(coll),
            `untrackTerminalData tears down ${coll} but rekeyTerminal never moves it. A ` +
            'collection that is cleaned on close but not moved on rename is exactly the ' +
            'bug this file exists to prevent, one piece of state at a time.');
    }
});

test('the move helpers go old -> new, not the reverse', () => {
    const rekey = methodBody(GATEWAY_SRC, 'rekeyTerminal');
    assert.match(rekey, /map\.set\(newName,\s*map\.get\(oldName\)!?\)[\s\S]{0,60}map\.delete\(oldName\)/,
        'moveMap must read the old key and write the new one');
    assert.match(rekey, /set\.delete\(oldName\)[\s\S]{0,80}set\.add\(newName\)/,
        'moveSet must drop the old key and add the new one');
});

test('attached clients are re-pointed at the new name', () => {
    const rekey = methodBody(GATEWAY_SRC, 'rekeyTerminal');
    assert.match(rekey, /client\.terminalName = newName/,
        'the fan-out filter compares client.terminalName; a stale one goes silent');
});

test('rekeyTerminal is synchronous', () => {
    const rekey = methodBody(GATEWAY_SRC, 'rekeyTerminal');
    assert.ok(!/\bawait\b/.test(rekey),
        'an await opens a window where a flush lands on half-migrated maps, and breaks the ' +
        'emit-before-HTTP-response ordering the client reconnect depends on');
});

test('the client re-keys its view instead of destroying it on rename', () => {
    const m = TERMINALS_JS.match(/async function renameTerminal\([\s\S]*?\n    \}/);
    assert.ok(m, 'renameTerminal not found');
    assert.match(m[0], /terminalsMap\.set\(next, entry\)/,
        're-keying preserves entry.lastSeq so the reconnect replays only the tail');
    assert.match(m[0], /!entry\.exited[\s\S]{0,60}connectTerminalSocket\(entry\)/,
        'reconnecting an exited terminal makes setupClient re-send {t:"exit"}, printing a ' +
        'second "[Process Exited]" line under the one already on screen');
});

test('a replaced socket cannot arm a reconnect against the new one', () => {
    const m = TERMINALS_JS.match(/function connectTerminalSocket\([\s\S]*?\n        entry\.ws = null;/);
    assert.ok(m, 'connectTerminalSocket prologue not found');
    assert.match(m[0], /onclose = null/,
        'without destroyTerminalView setting entry.exited first, the outgoing socket\'s ' +
        'onclose fires against a live entry and schedules a reconnect that tears down the ' +
        'socket this call just opened');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
```

> **Superseded:** the original test file's header claim — "Source-level assertions **plus a behavioural check through a stub fleet**" — and its `test('every name-keyed collection is moved')`, which asserted a hardcoded list of seven names appears anywhere inside `rekeyTerminal`'s body.
> **Reason:** No behavioural check was actually written, so the header promised coverage the file did not have. And a hardcoded `includes(coll)` list passes on a body that merely *mentions* a collection in a comment, passes on a move written in the wrong direction, and — worst — goes stale silently the moment an eighth name-keyed collection is added, which is precisely how this bug would recur.
> **Replaced with:** an honest header that says the suite is source-level and names manual step 5 as the behavioural proof; a drift test that derives the collection list from `untrackTerminalData` instead of hardcoding it; a direction assertion on the move helpers; and two new assertions covering the exited-terminal and stale-`onclose` guards.

## Verification Plan

### Automated Tests

Not run during this planning pass (the session directed no compilation and no test execution). Run them at implementation time:

1. **Static:** `npx tsc --noEmit -p tsconfig.json` — clean.
2. **New test:** `node src/test/terminal-rename-rekey-contract.test.js` — 7 passing.
3. **Existing terminal suites unaffected:** `node src/test/terminal-flow-control-contract.test.js`, `node src/test/terminal-input-path-contract.test.js`, `node src/test/terminal-token-transport-contract.test.js`, `node src/test/pty-route-surface-contract.test.js`.

### Manual

4. **The reported repro:**
   - Open the browser Terminals panel, start a terminal, run something with substantial output (e.g. a long `claude` conversation, or `for i in $(seq 1 500); do echo "line $i"; done`).
   - Rename it from the sidebar.
   - **Expected:** the pane keeps showing the same content with no blank interval and no visible flash. Before the fix it goes empty until the next keystroke.
5. **Ring survives the rename — the check that actually proves the fix:** after renaming, unassign the terminal from its pane, wait past the 15 s detach grace so the view is destroyed, then re-assign it. The scrollback must replay. Before the fix this replays nothing. This is the only step that proves the ring itself was repaired rather than just the on-screen view.
6. **Sequence numbers advance:** devtools → WS frames for the renamed terminal; the 4-byte BE prefix on output frames must be non-zero and increasing. Before the fix every post-rename frame is `seq 0`.
7. **Scroll position preserved:** scroll up ~200 lines, then rename. The view must stay where it was rather than snapping to the bottom.
8. **No reconnect churn:** with the devtools Network → WS panel open, rename a terminal. Exactly **one** new WS connection should open. A second one appearing ~500 ms later means the §4 `onclose` guard is missing or ineffective.
9. **Second tab is not stranded:** open `/terminals` in two tabs with the same terminal assigned, rename in tab A, confirm tab B keeps streaming live output without a manual reload.
10. **Input still routes:** type into the renamed terminal and confirm the pty receives it (echo appears, commands run).
11. **Backpressure still recovers:** rename a terminal that is mid-firehose (`yes` or a large `cat`), confirm output resumes and does not stall — proves `pausedTerminals`/`pausedSince` moved.
12. **Exited terminal:** let a terminal exit, then rename it. Exactly one `[Process Exited with code N]` line on screen — not two.
13. **No subscription leak:** rename then close the terminal; confirm no further `flushOutput` activity for either name and that the process count in `/health` drops.
14. **Both hosts:** repeat step 4 under the extension-hosted server and under `npx switchboard` standalone.

## Uncertain Assumptions

None. Every claim in this plan was verified directly against the source in this workspace during the review: the eight name-keyed collections and their teardown in `untrackTerminalData`; `PtyFleetService.rename`'s in-place mutation and synchronous emit; the `FleetChangeEvent` union; all four `client.terminalName` read sites; the four-hop emit→verb→proxy→HTTP-response ordering chain across both hosts; `setupClient`'s buffer lookup and replay construction; and the client-side `ws.onclose` reconnect handler that motivates the §4 guard. No web research is required before implementation.

---

**Recommendation: Send to Coder** (complexity 6).

---

## Completion Report

Implemented all five proposed changes. `src/standalone/terminalWsGateway.ts`: added a `renamed` arm to the fleet listener (`:312-314`) and a synchronous `rekeyTerminal` method (`:471-507`) that moves all seven name-keyed collections (scrollbackBuffers, terminalSubscriptions, pendingOutput, inputQueues, pausedSince, pendingFlushTerminals, pausedTerminals) and re-points attached `client.terminalName` values. `src/webview/terminals.js`: replaced the `destroyTerminalView(name)` call in `renameTerminal` (`:1907-1928`) with an in-place re-key that preserves `entry.lastSeq` and reconnects only live (`!entry.exited`) terminals, and added an `onclose = null` detach in `connectTerminalSocket`'s prologue (`:2325-3234`) to prevent stale reconnect timers. Created `src/test/terminal-rename-rekey-contract.test.js` (7 passing) including the drift test that derives the collection list from `untrackTerminalData`. One issue: the plan's test regex for the `connectTerminalSocket` prologue specified 8-space indentation but the actual `entry.ws = null;` line sits at 12 spaces; corrected the regex to match the real indentation (assertion intent unchanged). Existing terminal contract suites (flow-control, input-path, token-transport, pty-route-surface) all green — no regressions. Compilation and automated tests beyond the new contract file were skipped per session instructions; manual verification steps 4-14 in the plan remain the behavioural proof.

## Review Findings

Three MAJOR defects fixed: (1) `rekeyTerminal` moved `inputQueues` but not the self-rescheduling `drainInputQueue` `setImmediate` that captures the old name — a drain in flight across a rename woke to no queue, returned without clearing `draining`, and left the renamed terminal's stdin permanently dead; now re-armed under the new name (`terminalWsGateway.ts:605-624`). (2) §3 removed `destroyTerminalView` and with it its `clearTimeout(entry.reconnectTimer)`, so a rename inside a reconnect backoff produced the exact double-connect manual step 8 forbids; `connectTerminalSocket` now clears the pending timer in its prologue (`terminals.js:2643-2652`). (3) `terminal-rename-rekey-contract.test.js` was defined but invoked by nothing — added `test:contract:terminal-rename-rekey` to `package.json` and a CI step in `.github/workflows/integration-tests.yml`; two new assertions cover fixes (1) and (2), suite now 8 passing. Also re-keyed the orphaned `fitLadderGen` entry (NIT). Verified: `tsc --noEmit` clean for all changed files (5 pre-existing TS2835 errors elsewhere, untouched), `node --check` on `terminals.js` OK, sibling suites green (flow-control 16, input-path 14, token-transport, pty-route-surface, pty-host-gating), PRD gates `verb-returns:check` / `parity:check` / `push-routing:check` all pass; remaining risk is that this suite is source-regex only — manual steps 4-14 (especially step 5, and now a rename mid-paste to exercise the drain re-arm) are still the behavioural proof.
