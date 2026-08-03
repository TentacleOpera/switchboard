# Renaming a browser terminal blanks its window — the WS gateway never re-keys its per-terminal state

## Goal

Make renaming a terminal in the browser Terminals panel a purely cosmetic operation: the pane keeps showing the conversation that was already on screen, and the terminal keeps a working scrollback ring afterwards.

### Observed problem

Rename a terminal in `terminals.html` (sidebar `rename` button or the pane title inline edit). The pane goes completely blank and stays blank until new output arrives — typically the operator types something, which produces echo, and content starts appearing again from that point. The scrollback that was on screen a moment earlier is gone.

### Root cause

`TerminalWsGateway` keys **all** of its per-terminal state by terminal name, and it never handles the fleet's `renamed` event.

`PtyFleetService.rename` (`src/standalone/ptyFleetService.ts:156-168`) re-keys its own map, mutates `handle.friendlyName` and `handle.name` in place, and emits `{ type: 'renamed', oldName, newName }`. The gateway's fleet listener (`src/standalone/terminalWsGateway.ts:307-316`) switches on `created` and `closed` only — `renamed` falls through to a bare `broadcastWs('terminalsChanged')`. Nothing is re-keyed.

The consequences follow directly from that:

1. **Blank on re-attach.** `terminals.js` `renameTerminal` (`src/webview/terminals.js:1508-1544`) calls `destroyTerminalView(name)`, then `renderPaneGrid()` builds a fresh view under the new name that connects with `lastSeq = 0`. `setupClient` looks up `this.scrollbackBuffers.get(terminal.name)` (`terminalWsGateway.ts:582`) — the buffer is still filed under the **old** name, so the lookup misses, `replayFrame` is never built, and the hello frame reports `seq: 0`. The pane renders empty.
2. **The ring stays permanently dead.** `trackTerminalData` is only ever called on `created` (`:308-309`), and it early-returns on `terminalSubscriptions.has(t.name)`. No buffer is ever created for the new name. In `flushOutput`, `this.scrollbackBuffers.get(terminalName)` misses, so `seq` stays `0` and nothing is appended to any ring (`:386-397`). Live output still reaches clients — the `onData` closure reads `t.name` at callback time and `rename()` mutated it, so `pendingOutput`/`flushOutput` land on the **new** name and the fan-out filter `c.terminalName === terminalName` matches. That is exactly why content reappears "when you type something", and why it looks like a display glitch rather than lost state.
3. **Client-side resume dies with it.** Every post-rename frame carries `seq === 0`, so `entry.lastSeq` never advances (`src/webview/terminals.js:1986-1988`). A later reconnect asks for the whole ring, gets nothing, and blanks again.
4. **Leaked subscription.** On close, `untrackTerminalData(name)` is called with the *new* name and looks up `terminalSubscriptions.get(newName)` (`:415-419`) → undefined. The old-name `onData` subscription is never disposed.

This is host-agnostic: the same `TerminalWsGateway` serves the standalone bootstrap (`src/standalone/bootstrap.ts:1307`) and the extension's spawned pty host (`src/standalone/ptyHost.ts:43`), so both paths are affected and one fix covers both.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, backend, frontend, reliability

## Complexity Audit (Routine vs Complex/Risky)

**Complex.** Not large, but it touches live-socket state on the hot output path.

- Seven name-keyed collections must move atomically and in one synchronous step, or a flush landing mid-rename writes into a half-migrated map. Node's single-threaded model makes a synchronous handler safe; the handler must therefore contain no `await`.
- `client.terminalName` is read by the fan-out filter (`:400`), the ack/backpressure path (`:680-683`) and the resize path (`:767`). Missing any one leaves connected clients stranded on a name the gateway no longer knows.
- Ordering matters between server and client: the client reconnects on the rename's HTTP response, so the re-key must be complete before that response is written. `EventEmitter.emit` is synchronous and `fleet.rename` emits before returning to `ptyHost`'s `ptyRenameTerminal` arm (`src/standalone/ptyHost.ts:81-83`), so this holds — but it is a load-bearing assumption worth a comment.
- The client-side improvement (re-key the view instead of destroying it) changes reconnect semantics for one call site only, and degrades safely to the current destroy/replay behaviour if it is skipped.

**Not risky:** no protocol change, no persisted state, no schema.

## Edge-Case & Dependency Audit

| Case | Handling |
| :--- | :--- |
| Rename to a name already in use | `PtyFleetService.rename` returns `false` before emitting (`:158`); no event, no re-key, client's `data.success` is false and it leaves the view alone. |
| Rename while output is mid-flush (`pendingFlushTerminals` holds the old name) | Re-key `pendingOutput`, `pendingFlushTerminals` and `inputQueues` together in the same synchronous handler; the next `flushAllPending` tick sees only the new name. |
| Rename while the terminal is paused for backpressure | `pausedTerminals` and `pausedSince` must move too, or `checkBackpressure` can never un-pause the new name and output stalls permanently. |
| Two clients attached, only one initiated the rename | `client.terminalName` is re-keyed for every matching client, so the passive tab keeps streaming. Its `terminalsChanged` broadcast makes the sidebar re-label. |
| Rename immediately followed by close | `untrackTerminalData` now finds the subscription under the new name and disposes it. Fixes the current leak. |
| Rename of a terminal with no live client | Maps re-key; no client loop work. Next attach replays correctly. |
| Rename an already-exited terminal | Handle still in the fleet map; buffer moves; `setupClient` still sends `{t:'exit'}` (`:633-635`). |
| Collision: new name already has a buffer (should be impossible — the fleet rejects it first) | Guard defensively: if the destination key is occupied, log and skip the move rather than clobbering a live ring. |
| Client `lastSeq` continuity after the client-side re-key | The buffer and its `nextSeq` are preserved by the move, so reconnecting with the retained `lastSeq` replays only the tail — the on-screen buffer is not duplicated. |
| Undo snapshot / badges / pane assignments | Already handled by `renameTerminal` (`:1522-1537`); unchanged. |

**Dependencies:** `PtyFleetService` event contract (`ptyFleetService.ts:43`), `terminals.js` reconnect path, `ptyHost.ts` verb arm. No API surface changes.

## Proposed Changes

### 1. `src/standalone/terminalWsGateway.ts` — handle `renamed` in the fleet listener

`initFleetListeners` (`:307-316`):

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

### 2. `src/standalone/terminalWsGateway.ts` — the re-key itself

New private method, placed next to `untrackTerminalData`:

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
     * MUST stay synchronous. EventEmitter.emit runs handlers inline, so this
     * completes before fleet.rename() returns to the ptyRenameTerminal verb arm
     * and therefore before the HTTP response the client reconnects on. An await
     * anywhere in here would open a window where a flush lands on a half-migrated
     * set of maps.
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
        // same pty. Re-point them or the fan-out filter (c.terminalName === name)
        // stops matching and they go silent — including tabs that did not initiate
        // the rename and have no reason to reconnect.
        for (const client of this.clients) {
            if (client.terminalName === oldName) {
                client.terminalName = newName;
            }
        }
    }
```

### 3. `src/webview/terminals.js` — re-key the view instead of tearing it down

With the server fixed, the current `destroyTerminalView` + full-ring replay already restores the pane, but it round-trips up to 256 KB and visibly flashes. Re-keying keeps the rendered buffer and replays only the tail.

Replace the `destroyTerminalView(name)` call in `renameTerminal` (`:1521`):

```js
            if (data && data.success) {
                // Re-key rather than destroy: the gateway keeps the same scrollback
                // ring across a rename, so retaining this entry's lastSeq means the
                // reconnect replays only the tail instead of re-rendering the whole
                // 256 KB ring over a pane that already shows it.
                const entry = terminalsMap.get(name);
                if (entry) {
                    cancelDetachTimer(name);
                    terminalsMap.delete(name);
                    entry.name = next;
                    terminalsMap.set(next, entry);
                    if (entry.term) {
                        connectTerminalSocket(entry);
                    }
                } else {
                    destroyTerminalView(name);
                }
                for (let i = 0; i < paneAssignments.length; i++) {
```

`connectTerminalSocket` already closes the previous socket, resets the credit counters and appends `&lastSeq=` from the preserved `entry.lastSeq` (`:1938-1959`), so no other change is needed. The `entry.term === null` case (a view claimed but not yet materialised — `createTerminalView` defers construction until the container has a box) falls through without a socket; `materializeTerminalView` connects it under the new name when it renders.

### 4. `src/test/terminal-rename-rekey-contract.test.js` — new regression test

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
 * close. Source-level assertions plus a behavioural check through a stub fleet.
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

test('the fleet listener handles the renamed event', () => {
    assert.match(GATEWAY_SRC, /event\.type === 'renamed'[\s\S]{0,120}rekeyTerminal\(/,
        "renamed must re-key; falling through to only broadcastWs('terminalsChanged') " +
        'leaves the scrollback ring filed under the old name');
});

test('every name-keyed collection is moved', () => {
    const m = GATEWAY_SRC.match(/private rekeyTerminal\([\s\S]*?\n    \}/);
    assert.ok(m, 'rekeyTerminal not found');
    for (const coll of ['scrollbackBuffers', 'terminalSubscriptions', 'pendingOutput',
                        'inputQueues', 'pausedSince', 'pendingFlushTerminals', 'pausedTerminals']) {
        assert.ok(m[0].includes(coll), `rekeyTerminal does not move ${coll}`);
    }
});

test('attached clients are re-pointed at the new name', () => {
    const m = GATEWAY_SRC.match(/private rekeyTerminal\([\s\S]*?\n    \}/);
    assert.match(m[0], /client\.terminalName = newName/,
        'the fan-out filter compares client.terminalName; a stale one goes silent');
});

test('rekeyTerminal is synchronous', () => {
    const m = GATEWAY_SRC.match(/private rekeyTerminal\([\s\S]*?\n    \}/);
    assert.ok(!/\bawait\b/.test(m[0]),
        'an await opens a window where a flush lands on half-migrated maps, and breaks the ' +
        'emit-before-HTTP-response ordering the client reconnect depends on');
});

test('the client re-keys its view instead of destroying it on rename', () => {
    const m = TERMINALS_JS.match(/async function renameTerminal\([\s\S]*?\n    \}/);
    assert.ok(m, 'renameTerminal not found');
    assert.match(m[0], /terminalsMap\.set\(next, entry\)/,
        're-keying preserves entry.lastSeq so the reconnect replays only the tail');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
```

## Verification Plan

1. **Static:** `npx tsc --noEmit -p tsconfig.json` — clean.
2. **New test:** `node src/test/terminal-rename-rekey-contract.test.js` — 5 passing.
3. **Existing terminal suites unaffected:** `node src/test/terminal-flow-control-contract.test.js`, `node src/test/terminal-input-path-contract.test.js`, `node src/test/terminal-token-transport-contract.test.js`, `node src/test/pty-route-surface-contract.test.js`.
4. **Manual — the reported repro:**
   - Open the browser Terminals panel, start a terminal, run something with substantial output (e.g. a long `claude` conversation, or `for i in $(seq 1 500); do echo "line $i"; done`).
   - Rename it from the sidebar.
   - **Expected:** the pane keeps showing the same content with no blank interval. Before the fix it goes empty until the next keystroke.
5. **Ring survives the rename:** after renaming, unassign the terminal from its pane, wait past the 15 s detach grace so the view is destroyed, then re-assign it. The scrollback must replay. Before the fix this replays nothing — this is the check that proves the ring itself was repaired, not just the immediate view.
6. **Sequence numbers advance:** devtools → WS frames for the renamed terminal; the 4-byte BE prefix on output frames must be non-zero and increasing. Before the fix every post-rename frame is `seq 0`.
7. **Second tab is not stranded:** open `/terminals` in two tabs with the same terminal assigned, rename in tab A, confirm tab B keeps streaming live output without a manual reload.
8. **Input still routes:** type into the renamed terminal and confirm the pty receives it (echo appears, commands run).
9. **Backpressure still recovers:** rename a terminal that is mid-firehose (`yes` or a large `cat`), confirm output resumes and does not stall — proves `pausedTerminals`/`pausedSince` moved.
10. **No subscription leak:** rename then close the terminal; confirm no further `flushOutput` activity for either name and that the process count in `/health` drops.
11. **Both hosts:** repeat step 4 under the extension-hosted server and under `npx switchboard` standalone.
