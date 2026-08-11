'use strict';

/**
 * Source-text contract for the browser terminal ack/credit flow control and the
 * view lifecycle that shares its files.
 *
 * Every failure mode of a credit scheme is SILENCE — a lost ack, a counter not
 * reset on reconnect, a replay frame billed against the budget, or a disposed
 * view still holding credit all produce a terminal that simply stops printing
 * with no error anywhere. These assertions pin the structural mitigations, since
 * none of them are observable from a unit test of behaviour.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const gatewayCode = fs.readFileSync(path.join(__dirname, '../standalone/terminalWsGateway.ts'), 'utf8');
const terminalsJs = fs.readFileSync(path.join(__dirname, '../webview/terminals.js'), 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}\n     ${e.message}`);
        failed++;
    }
}

/** Slice of a source file between two markers, for scoping an assertion to one function. */
function block(code, startMarker, endMarker) {
    const start = code.indexOf(startMarker);
    assert.ok(start !== -1, `marker not found: ${startMarker}`);
    const end = code.indexOf(endMarker, start);
    assert.ok(end !== -1, `end marker not found: ${endMarker}`);
    return code.substring(start, end);
}

// ---------------------------------------------------------------- flow control

test('the ack is emitted from the xterm write callback, not from onmessage', () => {
    assert.ok(
        terminalsJs.includes('entry.term.write(combined, () => onWriteParsed(entry, combined.length))'),
        'flushBatch must pass a write callback — acking on receipt measures the transport, which is the bug being fixed'
    );
    const onMessage = block(terminalsJs, 'ws.onmessage = (event) => {', 'ws.onclose = () =>');
    assert.ok(!onMessage.includes("t: 'ack'"), 'ws.onmessage must not send an ack directly');
    assert.ok(block(terminalsJs, 'function onWriteParsed(', 'window.__sbTerminalStats').includes("t: 'ack'"),
        'onWriteParsed must be the only ack emitter');
});

test('flushBatch wraps term.write in try/catch', () => {
    assert.ok(/try\s*\{\s*entry\.term\.write/.test(terminalsJs),
        "xterm throws at 50 MB of pending data; unguarded, that escapes a rAF callback and the terminal never drains again");
});

test('flushBatch guards on disposed, NOT exited', () => {
    const flush = block(terminalsJs, 'function flushBatch(entry)', 'function onWriteParsed(');
    assert.ok(flush.includes('entry.disposed'), 'flushBatch must bail on a disposed view');
    assert.ok(!/if \(!entry \|\| entry\.exited/.test(flush),
        'guarding on exited drops the final output of an exiting process — the gateway drains before announcing exit, so that output is still queued here');
});

test('gateway handles the ack frame and clamps it', () => {
    assert.ok(gatewayCode.includes("parsed.t === 'ack'"), 'gateway must have an ack branch');
    assert.ok(gatewayCode.includes('Math.max(0, Math.min(parsed.chars, client.unackedChars))'),
        'an unbounded or negative ack would let a client drive its own credit negative and disable its backpressure');
});

test('replay is excluded from the credit ledger on BOTH ends', () => {
    const setup = block(gatewayCode, 'private setupClient(', "ws.on('pong'");
    assert.ok(!setup.includes('unackedChars +='), 'setupClient must not bill the replay burst to the new client');
    assert.ok(setup.includes('replayChars'), 'hello must carry the replay length so the client knows what not to ack');
    assert.ok(terminalsJs.includes('entry.ackSuppressChars'),
        'the client must suppress acks for replayed chars — otherwise it pays down credit it never consumed and backpressure is off for the first 256 KB after every reconnect');
    const onWrite = block(terminalsJs, 'function onWriteParsed(', 'window.__sbTerminalStats');
    assert.ok(onWrite.includes('entry.ackSuppressChars'), 'the suppression budget must be burned inside onWriteParsed');
});

test('pause is a disjunction and resume a conjunction of both watermarks', () => {
    assert.ok(gatewayCode.includes('maxBuffered > HIGH_WATER_MARK_BYTES || maxUnacked > HIGH_WATER_CHARS'),
        'either signal may pause: bytes measure the transport (correct when tunnelled), chars measure the renderer (correct over loopback)');
    assert.ok(gatewayCode.includes('maxBuffered < LOW_WATER_MARK_BYTES && maxUnacked < LOW_WATER_CHARS'),
        'both must clear to resume');
    assert.ok(/HIGH_WATER_CHARS = 100000/.test(gatewayCode) && /LOW_WATER_CHARS = 5000/.test(gatewayCode),
        'watermarks must match the VS Code pty-host constants this design is adopted from');
});

test('the MAX_PAUSE_MS valve measures ack STALL, not elapsed pause', () => {
    assert.ok(gatewayCode.includes('now - pausedTime > MAX_PAUSE_MS'), 'safety valve must exist inside checkBackpressure');
    const ackBranch = block(gatewayCode, "parsed.t === 'ack'", "parsed.t === 'ping'");
    assert.ok(/pausedSince\.set\(/.test(ackBranch),
        'ack progress must refresh the pause stamp, or a legitimately slow renderer has its backpressure force-disabled every MAX_PAUSE_MS');
});

test('credit is reset with the ClientState on every attach', () => {
    const setup = block(gatewayCode, 'private setupClient(', 'this.clients.add(client)');
    assert.ok(setup.includes('unackedChars: 0'),
        'a reconnecting client\'s credit belongs to a socket that no longer exists; carrying it forward leaves the terminal paused with nobody able to ack it down');
    // End marker is the socket-URL build. It used to be `const protocol =`, which the
    // out-of-process pty host removed: the scheme is now baked into the module-scope
    // PTY_HOST_ORIGIN, because the gateway no longer lives on the page's own origin.
    const connect = block(terminalsJs, 'function connectTerminalSocket(entry)', 'let wsUrl =');
    assert.ok(connect.includes('entry.pendingAckChars = 0') && connect.includes('entry.ackSuppressChars = 0'),
        'both client-side accumulators must be zeroed on reconnect');
});

test('batching is page-level on both ends, with the hidden-panel fallback intact', () => {
    assert.ok(!terminalsJs.includes('animationFrameId'), 'no per-entry rAF may remain');
    assert.ok(terminalsJs.includes('pendingBatchEntries') && terminalsJs.includes('sharedBatchRafId'),
        'the drain must be a single page-level rAF over a pending set');
    assert.ok(terminalsJs.includes('sharedBatchFallbackTimer') && terminalsJs.includes('BATCH_FALLBACK_MS'),
        'rAF is parked in a display:none iframe — the fallback timer is the only thing draining a hidden panel');
    assert.ok(gatewayCode.includes('sharedFlushInterval') && gatewayCode.includes('pendingFlushTerminals'),
        'the gateway must coalesce onto one shared flush tick rather than a timer per terminal');
    assert.ok(block(gatewayCode, 'public dispose()', 'for (const client of this.clients)').includes('clearInterval(this.sharedFlushInterval)'),
        'dispose must clear the shared flush interval');
});

test('debug stats are exposed', () => {
    assert.ok(terminalsJs.includes('window.__sbTerminalStats'), 'there must be a way to diagnose a stuck counter in the field');
});

// ------------------------------------------------------------ view lifecycle

test('unassign arms disposal and assignment cancels it', () => {
    const tail = block(terminalsJs, 'for (const [name, entry] of terminalsMap.entries())', 'function resolveFlooredLayout');
    assert.ok(tail.includes('armDetachTimer(name)'), 'the unassigned branch must arm a disposal timer');
    assert.ok(tail.includes('cancelDetachTimer(name)'), 'the assigned branch must cancel any pending timer');
});

test('every disposal path clears the detach timer', () => {
    const destroy = block(terminalsJs, 'function destroyTerminalView(name)', 'function createTerminalView(');
    assert.ok(destroy.includes('cancelDetachTimer(name)'),
        'PtyFleetService reuses freed names, so a stale timer could dispose a DIFFERENT terminal that inherited the name');
    assert.ok(destroy.includes('pendingBatchEntries.delete(entry)'), 'disposal must drop the entry from the page-level drain set');
    const rename = block(terminalsJs, 'async function renameTerminal(', 'try {');
    assert.ok(rename.includes('cancelDetachTimer(name)') && rename.includes('cancelDetachTimer(next)'),
        'rename must clear the timer under BOTH the old and the inherited new name');
});

test('the detach timer re-checks assignment before disposing', () => {
    const arm = block(terminalsJs, 'function armDetachTimer(name)', 'function cancelDetachTimer(');
    assert.ok(arm.includes('paneAssignments.includes(name)'),
        'assignment can change without a re-render (assignToFocusedPane early-return), so the callback must re-check');
});

test('WebGL contexts are capped before construction, and released exactly once', () => {
    assert.ok(terminalsJs.includes('MAX_WEBGL_CONTEXTS = 12'),
        '12, not 16 — the other panels share the page context budget');
    assert.ok(terminalsJs.includes('liveWebglContexts < MAX_WEBGL_CONTEXTS'),
        'the cap must be checked BEFORE constructing WebglAddon; by the time onContextLoss fires the damage has landed on a different terminal');
    const attach = block(terminalsJs, 'function attachRenderer(term, entry)', 'const ALL_THEME_CLASSES');
    assert.ok(attach.includes('liveWebglContexts - 1'), 'context loss must decrement the counter');

    // Accounting is a ONE-SHOT closure minted at the moment of acquisition, not three
    // hand-paired sites keyed on entry.isWebgl. The old shape needed the loss handler to
    // clear isWebgl so destroyTerminalView would not double-decrement; the release closure
    // makes double-decrement structurally impossible instead, and the flag is cleared
    // INSIDE it. Asserting the old shape here would forbid the fix.
    assert.ok(/holder\.release = \(\) => \{\s*\n\s*if \(released\) \{ return; \}\s*\n\s*released = true;/.test(attach),
        'the release closure must be one-shot: guard on `released` BEFORE the decrement, or a swap plus a late context loss decrements twice');
    assert.ok(/released = true;[\s\S]{0,400}?liveWebglContexts = Math\.max\(0, liveWebglContexts - 1\);[\s\S]{0,200}?entry\.isWebgl = false;/.test(attach),
        'the one-shot closure must own BOTH the counter decrement and the isWebgl clear, so the two can never disagree');
    assert.ok(/released = true;[\s\S]{0,600}?forceReleaseWebglContext\(webgl\)/.test(attach),
        'the closure must also hand the GL context back: WebglAddon.dispose() leaves the live context to GC, so accounting-only release frees nothing the process can see');

    // The invariant that replaces hand-paired accounting: exactly one increment, and no
    // decrement anywhere outside the closure.
    const incrementSites = terminalsJs.match(/liveWebglContexts\+\+/g) || [];
    assert.strictEqual(incrementSites.length, 1, 'exactly one increment site, and it must be in attachRenderer');
    assert.ok(attach.includes('liveWebglContexts++'), 'the single increment must live in attachRenderer');
    const decrementSites = terminalsJs.match(/liveWebglContexts(--|\s*-=|\s*=\s*Math\.max\(0, liveWebglContexts - 1\))/g) || [];
    assert.strictEqual(decrementSites.length, 1,
        'exactly one decrement site — it must live in the holder.release closure and nowhere else');

    // Re-entrancy: forceReleaseWebglContext calls loseContext(), which fires
    // webglcontextlost straight back into this handler while swapRenderer is mid-teardown.
    const lossHandler = attach.slice(attach.indexOf('webgl.onContextLoss('));
    assert.ok(/webgl\.onContextLoss\(\(\) => \{[\s\S]{0,900}?if \(released\) \{ return; \}/.test(attach),
        'onContextLoss must early-return on `released`, or our own deliberate loseContext() double-attaches a renderer');
    assert.ok(lossHandler.indexOf('if (released) { return; }') < lossHandler.indexOf('holder.release()'),
        'the re-entrancy guard must precede the release call it is guarding');

    const destroy = block(terminalsJs, 'function destroyTerminalView(name)', 'function createTerminalView(');
    const releaseAt = destroy.indexOf('entry.rendererAddon.release()');
    const disposeAt = destroy.indexOf('.dispose()', releaseAt);
    const tryAt = destroy.indexOf('try {', releaseAt);
    assert.ok(releaseAt !== -1, 'disposal must route the context drop through the holder, never a bare decrement');
    assert.ok(releaseAt < disposeAt,
        'release BEFORE dispose — dispose() drops addon._renderer, and with it the only path to the GL context');
    assert.ok(releaseAt < tryAt,
        'release OUTSIDE the try wrapping dispose() — a dispose() that throws must still give the budget back');
});

test('exited and disposed stay distinct, and reconnect keys on exited', () => {
    assert.ok(terminalsJs.includes('disposed: false') && terminalsJs.includes('exited: false'),
        'both flags must exist on the entry shape');
    const destroy = block(terminalsJs, 'function destroyTerminalView(name)', 'function createTerminalView(');
    const disposedAt = destroy.indexOf('entry.exited = true');
    const closeAt = destroy.indexOf('entry.ws.close()');
    assert.ok(disposedAt !== -1 && closeAt !== -1 && disposedAt < closeAt,
        'exited must be set BEFORE the socket is closed, or onclose reconnects a view that is being torn down');
    const onclose = block(terminalsJs, 'ws.onclose = () => {', 'function scheduleBatchFlush');
    assert.ok(onclose.includes('entry.exited'), 'the reconnect guard must key on exited');
});

test('scrollback is explicit', () => {
    assert.ok(/scrollback: \d+,/.test(terminalsJs),
        'left implicit, client memory is untracked against the server ring it now depends on for re-attach');
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) { process.exit(1); }
