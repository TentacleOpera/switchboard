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

test('the gateway records bracketed-paste mode outside the evicting ring', () => {
    assert.ok(gatewayCode.includes('private bracketedPasteModes = new Map<string, boolean>()'),
        'the mode must be recorded per terminal — a TUI emits \\x1b[?2004h once at startup and the 256 KB ring evicts it, so an attaching client can never learn it from replay');
    // End marker also pins PLACEMENT: the scanner must sit between these two.
    const flush = block(gatewayCode, 'private flushOutput(', 'private scanBracketedPasteMode(');
    const scanIdx = flush.indexOf('this.scanBracketedPasteMode(');
    const ringIdx = flush.indexOf('buffer.chunks.push(');
    assert.ok(scanIdx !== -1 && ringIdx !== -1 && scanIdx < ringIdx,
        'the scan must run before the ring append — the ring evicts, and outliving eviction is the entire point');
});

test('the mode scanner ranks resets and DECSET by position, in one pass', () => {
    const scan = block(gatewayCode, 'private scanBracketedPasteMode(', 'private untrackTerminalData(');
    assert.ok(scan.includes('([hl])'),
        'only final bytes h/l may change state — \\x1b[?2004$p is a status REQUEST and \\x1b[?2004;1$y its reply');
    assert.ok(scan.includes("split(';').includes('2004')"),
        'params must be compared whole, or 12004/20040 false-positive and \\x1b[?1049;2004h is missed');
    assert.ok(scan.includes('\\x1bc|') && scan.includes('\\x1b\\[!p'),
        'RIS and DECSTR must be alternatives in the SAME pass — scanned separately, an unrelated DECSET after a reset makes the reset lose a position compare and the mode goes stale-true');
    assert.ok(/\[0-9;\]\{0,\d+\}/.test(scan),
        'the param class must be length-bounded: an unterminated \\x1b[? followed by a long digit run backtracks quadratically on the output hot path, on the event loop owning every terminal');
    assert.ok(scan.includes('modeScanCarry'),
        'pty reads split anywhere, so \\x1b[?20 + 04h across two chunks must still be detected');

    // The matcher itself, exercised directly — last state-changing event wins.
    const re = /\x1bc|\x1b\[!p|\x1b\[\?([0-9;]{0,64})([hl])/g;
    const last = (s) => {
        re.lastIndex = 0;
        let m, v;
        while ((m = re.exec(s)) !== null) {
            if (m[2]) { if (m[1].split(';').includes('2004')) { v = m[2]; } }
            else { v = 'reset'; }
        }
        return v;
    };
    assert.strictEqual(last('\x1b[?2004h'), 'h');
    assert.strictEqual(last('\x1b[?1049;2004h'), 'h', 'multi-param DECSET must be honoured');
    assert.strictEqual(last('\x1b[?2004l'), 'l');
    assert.strictEqual(last('\x1b[?2004$p'), undefined, 'DECRQM must not register');
    assert.strictEqual(last('\x1b[?2004;1$y'), undefined, 'DECRPM must not register');
    assert.strictEqual(last('\x1b[?12004h'), undefined, 'substring match must not register');
    assert.strictEqual(last('\x1b[?2004h out \x1bc'), 'reset', 'RIS after a set must win');
    assert.strictEqual(last('\x1b[?2004h out \x1b[!p'), 'reset', 'DECSTR after a set must win');
    assert.strictEqual(last('\x1bc \x1b[?2004h'), 'h', 'a set after RIS must win');
    assert.strictEqual(last('\x1bc \x1b[?1000h'), 'reset',
        'an UNRELATED DECSET after RIS must not resurrect the pre-reset value — this is the two-pass bug');
});

test('hello omits the mode when unobserved and the client re-arms from it', () => {
    const hello = block(gatewayCode, "t: 'hello'", 'Replay scrollback BEFORE');
    assert.ok(hello.includes("typeof bracketedPaste === 'boolean'"),
        'omitted, NOT false, when unobserved — telling a client to DISABLE a mode nobody ruled on is a regression');
    const arm = block(terminalsJs, "frame.t === 'hello'", "frame.t === 'inputThrottled'");
    assert.ok(arm.includes('\\x1b[?2004h'),
        'a rebuilt view starts with bracketedPasteMode false and would paste unbracketed — one Enter per line to a raw-mode agent CLI');
    assert.ok(!arm.includes('batchQueue'),
        'the mode escape must bypass batchQueue: that path is billed to pendingAckChars and synthetic chars corrupt the backpressure ledger');
});

test('the recorded mode is torn down with the terminal', () => {
    const untrack = block(gatewayCode, 'private untrackTerminalData(', 'private drainPending(');
    assert.ok(untrack.includes('this.bracketedPasteModes.delete(name)'),
        'a terminal re-created under the same name must not inherit the dead process mode');
    assert.ok(untrack.includes('this.modeScanCarry.delete(name)'), 'carry must not leak across processes');
    assert.ok(block(gatewayCode, 'public dispose()', 'for (const client of this.clients)').includes('this.bracketedPasteModes.clear()'),
        'dispose must clear the recorded modes too');
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) { process.exit(1); }
