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

test('an in-flight input drain is re-armed under the new name', () => {
    const rekey = methodBody(GATEWAY_SRC, 'rekeyTerminal');
    assert.match(rekey, /inputQueues\.get\(newName\)[\s\S]{0,200}drainInputQueue\(newName\)/,
        'inputQueues is the one moved collection with a self-rescheduling consumer: ' +
        'drainInputQueue re-arms via setImmediate with the name it was CALLED with, so a ' +
        'drain in flight across the rename wakes under oldName, finds no queue, and returns ' +
        'without clearing draining — which is still true on the moved object, so no later ' +
        'enqueueInput ever restarts the pump and the terminal stdin is dead for good');
    assert.match(rekey, /movedQueue\.draining[\s\S]{0,60}chunks\.length > 0/,
        'guard on draining AND pending chunks, or a healthy queue gets a second drain chain');
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
    const m = TERMINALS_JS.match(/function connectTerminalSocket\([\s\S]*?\n            entry\.ws = null;/);
    assert.ok(m, 'connectTerminalSocket prologue not found');
    assert.match(m[0], /onclose = null/,
        'without destroyTerminalView setting entry.exited first, the outgoing socket\'s ' +
        'onclose fires against a live entry and schedules a reconnect that tears down the ' +
        'socket this call just opened');
    // The other half of the same defect: destroyTerminalView also cleared the pending
    // BACKOFF timer, and renameTerminal no longer calls it. Nulling onclose stops the
    // outgoing socket from arming a NEW timer; it does nothing about one already armed.
    assert.match(m[0], /clearTimeout\(entry\.reconnectTimer\)/,
        'a rename inside a reconnect backoff window leaves the old timer armed; it fires ' +
        '~500ms later against the re-keyed entry and tears down the socket just opened — ' +
        'the double-connect manual step 8 forbids');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
