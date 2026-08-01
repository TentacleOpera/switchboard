'use strict';

/**
 * Source-text contract for the browser terminal INPUT path.
 *
 * The chunk-boundary logic is the whole plan: a cut inside a multi-byte codepoint
 * silently corrupts pasted text, and a cut inside `\x1b[200~` turns a paste into
 * an escape plus literal text — worse than not chunking at all. Neither failure
 * throws, so both are pinned structurally here.
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

function block(code, startMarker, endMarker) {
    const start = code.indexOf(startMarker);
    assert.ok(start !== -1, `marker not found: ${startMarker}`);
    const end = code.indexOf(endMarker, start);
    assert.ok(end !== -1, `end marker not found: ${endMarker}`);
    return code.substring(start, end);
}

test('the client sends binary input frames', () => {
    assert.ok(terminalsJs.includes('entry.ws.send(encodeInputFrame(data))'),
        'term.onData must send a binary frame — xterm delivers a paste as ONE onData event, so base64 meant a per-byte loop over the whole paste on the shared main thread');
    const encode = block(terminalsJs, 'function encodeInputFrame(str)', 'function base64ToUtf8(');
    assert.ok(encode.includes('0x01'), 'the frame must carry the input opcode');
    assert.ok(encode.includes('TextEncoder'), 'the payload must be raw UTF-8 bytes, not base64');
});

test('utf8ToBase64 is gone but base64ToUtf8 stays for the legacy output branch', () => {
    assert.ok(!terminalsJs.includes('utf8ToBase64'), 'utf8ToBase64 must have no remaining references');
    assert.ok(terminalsJs.includes('function base64ToUtf8('), 'base64ToUtf8 still decodes the retained legacy output frames');
    assert.ok(block(terminalsJs, "frame.t === 'out'", "frame.t === 'hello'").includes('base64ToUtf8'),
        'the legacy output branch must still call it');
});

test('the server accepts binary AND the legacy JSON input frame', () => {
    assert.ok(gatewayCode.includes('opcode === 0x01'), 'binary branch must exist');
    assert.ok(gatewayCode.includes("parsed.t === 'input'"),
        'the base64 JSON branch is retained so a tab left open across a dev restart still types');
});

test('input frames are size-capped on both branches before decode', () => {
    assert.ok(/MAX_INPUT_FRAME_BYTES = 5 \* 1024 \* 1024/.test(gatewayCode), 'cap must be defined');
    assert.ok(gatewayCode.includes('payload.length > MAX_INPUT_FRAME_BYTES'), 'binary branch must check the cap');
    assert.ok(gatewayCode.includes('decoded.length > MAX_INPUT_FRAME_BYTES'),
        'the legacy branch decodes an attacker-supplied base64 string into memory — it needs the cap too');
});

test('chunk boundaries skip UTF-8 continuation bytes', () => {
    const fn = block(gatewayCode, 'private findSafeBoundary(', 'private isEscapeSequenceComplete(');
    assert.ok(fn.includes('(buf[pos] & 0xc0) === 0x80'),
        'must walk backwards past continuation bytes rather than slicing at a fixed offset');
});

test('CSI sequences are parsed properly — the introducer is not a terminator', () => {
    const fn = block(gatewayCode, 'private isEscapeSequenceComplete(', '\n    constructor(');
    assert.ok(fn.includes('0x5b'),
        'ESC [ is an INTRODUCER; treating any 0x40-0x7E byte after ESC as the final byte matches the [ itself and declares every CSI sequence complete at its second byte — which would let \\x1b[200~ be split');
    assert.ok(/for \(i = escPos \+ 2; i < end; i\+\+\)/.test(fn),
        'the CSI scan must start AFTER the introducer');
    assert.ok(fn.includes('c >= 0x40 && c <= 0x7e'), 'a CSI sequence ends on a final byte in 0x40-0x7E');
});

test('ordering is FIFO per terminal', () => {
    assert.ok(gatewayCode.includes('inputQueues = new Map'), 'the queue must be keyed by terminal name');
    assert.ok(gatewayCode.includes('draining: boolean'),
        'a naive setTimeout per chunk reorders a keystroke into the middle of a paste; the drain must be guarded by a flag');
    assert.ok(gatewayCode.includes('setImmediate(() => this.drainInputQueue(terminalName))'),
        'the drain must yield between slices so output flushes and other clients are still serviced during a large paste');
});

test('the input queue is torn down with the terminal', () => {
    const untrack = block(gatewayCode, 'private untrackTerminalData(', 'private drainPending(');
    assert.ok(untrack.includes('this.inputQueues.delete(name)'),
        'a surviving queue would drain into a dead pty');
    assert.ok(block(gatewayCode, 'public dispose()', 'for (const client of this.clients)').includes('this.inputQueues.clear()'),
        'dispose must clear the queues too');
});

test('the throttle notice is informational and two-sided', () => {
    const branch = block(terminalsJs, "frame.t === 'inputThrottled'", "frame.t === 'error'");
    assert.ok(!branch.includes('disableStdin'),
        'input is queued, never dropped — the operator must be able to keep typing');
    assert.ok(branch.includes('frame.throttled === false'),
        'without the CLEAR, the notice reads as "input is permanently throttled" long after the queue drained');
    assert.ok(gatewayCode.includes('private clearInputThrottleIfDrained('), 'the server must send the complementary clear');
});

test('input is independent of output backpressure', () => {
    const enqueue = block(gatewayCode, 'private enqueueInput(', 'private drainInputQueue(');
    assert.ok(!enqueue.includes('pausedTerminals'),
        'conflating the two directions would make a terminal that is merely lagging on OUTPUT unusable for input');
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) { process.exit(1); }
