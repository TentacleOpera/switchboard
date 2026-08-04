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

test('the gateway records the tracked DEC mode set outside the evicting ring', () => {
    assert.ok(gatewayCode.includes('private decModes = new Map<string, Map<number, boolean>>()'),
        'the mode set must be recorded per terminal — a TUI emits \\x1b[?2004h once at startup and the 256 KB ring evicts it, so an attaching client can never learn it from replay');
    // End marker also pins PLACEMENT: the scanner must sit between these two.
    const flush = block(gatewayCode, 'private flushOutput(', 'private scanTerminalModes(');
    const scanIdx = flush.indexOf('this.scanTerminalModes(');
    const ringIdx = flush.indexOf('buffer.chunks.push(');
    assert.ok(scanIdx !== -1 && ringIdx !== -1 && scanIdx < ringIdx,
        'the scan must run before the ring append — the ring evicts, and outliving eviction is the entire point');
});

test('the mode scanner ranks resets and DECSET by position, in one pass', () => {
    const scan = block(gatewayCode, 'private scanTerminalModes(', 'private untrackTerminalData(');
    assert.ok(scan.includes('([hl])'),
        'only final bytes h/l may change state — \\x1b[?2004$p is a status REQUEST and \\x1b[?2004;1$y its reply');
    assert.ok(scan.includes("match[1].split(';')"),
        'params must be split so a multi-param set like \\x1b[?1049;2004h is honoured');
    assert.ok(scan.includes('TRACKED_DEC_MODES.includes('),
        'params must be compared whole against the tracked set, or 12004/20040 false-positive and \\x1b[?1049;2004h is missed');
    assert.ok(scan.includes('\\x1bc|') && scan.includes('\\x1b\\[!p'),
        'RIS and DECSTR must be alternatives in the SAME pass — scanned separately, an unrelated DECSET after a reset makes the reset lose a position compare and the mode goes stale-true');
    // Pinned on the MATCHER DECLARATION, not the body. A body-wide grep for a
    // bounded param class is satisfied by the carry-fragment test at the end of the
    // method, which carries its own {0,64} — so the matcher can be unbounded while
    // a body-wide assertion still passes. Measured on this pattern, unbounding it
    // costs ~4x on 80 KB of digit junk and stays LINEAR (backtracking is one pass
    // per start position, and starts cannot overlap a digit run), so this is a
    // constant cap on per-start backtracking rather than the catastrophic-blowup
    // guard the plan described. Keep the bound: it is free, it holds the matcher and
    // the carry test to the same ceiling, and MODE_SCAN_CARRY_MAX is meaningless
    // without it.
    const modeEventDecl = /const modeEvent = \/[^\n]*\/g;/.exec(scan);
    assert.ok(modeEventDecl, 'the single-pass matcher must be declared as `const modeEvent = /…/g`');
    assert.ok(/\[0-9;\]\{0,\d+\}/.test(modeEventDecl[0]),
        'the param class in the MATCHER ITSELF must be length-bounded — an unterminated \\x1b[? followed by a long digit run otherwise backtracks the whole run on the output hot path, on the event loop owning every terminal in the fleet');
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
    assert.ok(arm.includes('entry.pendingModes'),
        'a rebuilt view starts with bracketedPasteMode false and would paste unbracketed — the recorded mode set is armed on the entry and applied after the replay');
    assert.ok(!arm.includes('batchQueue'),
        'the mode escape must bypass batchQueue: that path is billed to pendingAckChars and synthetic chars corrupt the backpressure ledger');
    const apply = block(terminalsJs, 'function applyServerModes(', 'function isAnswerback(');
    assert.ok(apply.includes('REARMABLE_DEC_MODES'),
        'the authoritative mode write is built from the re-armable allowlist, not the legacy single-mode literal');
});

/**
 * The SHIPPED scanner, executed — not a hand-copied regex and not a grep.
 *
 * Everything else about this change is source text, but the scanner is pure, so
 * the one part that CAN be tested for behaviour is tested for behaviour. The carry
 * specifically: it is load-bearing (pty reads split wherever the kernel says, so
 * `\x1b[?20` + `04h` in two chunks is the common case, not the exotic one), it is
 * where the pre-review scanner was actually broken — it re-fired a consumed reset
 * on every subsequent chunk — and neither a substring assertion nor an inline copy
 * of the regex can detect either failure. The body is extracted from source so a
 * duplicate cannot drift from the original.
 */
function loadScanner() {
    const SIG = 'private scanTerminalModes(terminalName: string, data: string): void {';
    const start = gatewayCode.indexOf(SIG);
    assert.ok(start !== -1, `scanner signature changed — update SIG in loadScanner: ${SIG}`);
    let depth = 0;
    let end = -1;
    for (let i = start + SIG.length - 1; i < gatewayCode.length; i++) {
        if (gatewayCode[i] === '{') { depth++; }
        else if (gatewayCode[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end !== -1, 'unbalanced braces in scanTerminalModes');
    // The only type annotation in the body. Kept as a targeted strip rather than a
    // general one so a NEW annotation fails loudly here instead of silently. The
    // `as typeof TRACKED_DEC_MODES[number]` cast is TypeScript syntax that
    // `new Function` cannot parse — strip it so the body is JS-executable while the
    // gateway source keeps its type-safe cast.
    const body = gatewayCode.slice(start + SIG.length, end)
        .replace('let match: RegExpExecArray | null;', 'let match;')
        .replace(/ as typeof TRACKED_DEC_MODES\[number\]/g, '')
        .replace(/new Map<number, boolean>\(\)/g, 'new Map()');
    const leftover = /:\s*(?:RegExpExecArray|string|number|boolean)\b/.exec(body);
    assert.ok(!leftover, `unstripped type annotation in the extracted body (${leftover && leftover[0]}) — add it to the replace list above`);

    const carryMax = /MODE_SCAN_CARRY_MAX = (\d+)/.exec(gatewayCode);
    assert.ok(carryMax, 'MODE_SCAN_CARRY_MAX must be declared');
    // TRACKED_DEC_MODES is a module-level const the extracted body references but
    // `new Function` does not close over the module scope. Hard-coded here with a
    // separate assertion (below) that the gateway's literal matches — that
    // assertion is what catches a future mode being added to the gateway and not to
    // the harness.
    const TRACKED_DEC_MODES = [9, 1000, 1002, 1003, 1004, 1006, 1049, 2004];
    const trackedDecl = /export const TRACKED_DEC_MODES = \[([^\]]+)\] as const;/.exec(gatewayCode);
    assert.ok(trackedDecl, 'TRACKED_DEC_MODES must be declared in the gateway');
    const trackedLiteral = trackedDecl[1].split(',').map(s => Number(s.trim()));
    assert.deepStrictEqual(trackedLiteral, TRACKED_DEC_MODES,
        'the harness TRACKED_DEC_MODES must match the gateway literal — a mode added to the gateway and not here throws `TRACKED_DEC_MODES is not defined`');
    const scan = new Function('MODE_SCAN_CARRY_MAX', 'TRACKED_DEC_MODES', 'terminalName', 'data', `"use strict";${body}`);
    return {
        carryMax: Number(carryMax[1]),
        gw() {
            return {
                decModes: new Map(),
                modeScanCarry: new Map(),
                feed(name, ...chunks) {
                    for (const c of chunks) { scan.call(this, Number(carryMax[1]), TRACKED_DEC_MODES, name, c); }
                    return (this.decModes.get(name) || new Map()).get(2004);
                },
            };
        },
    };
}

test('the scanner detects a DECSET split across pty reads', () => {
    const { gw } = loadScanner();
    assert.strictEqual(gw().feed('t', 'out\x1b[?20', '04h more'), true, 'split mid-params');
    assert.strictEqual(gw().feed('t', 'out\x1b', '[?2004h'), true, 'split after the bare ESC');
    assert.strictEqual(gw().feed('t', '\x1b[?2004', 'h'), true, 'split before the final byte');
    assert.strictEqual(gw().feed('t', ...'hi\x1b[?2004h!'.split('')), true, 'one byte per read');
    assert.strictEqual(gw().feed('t', 'tail\x1b', 'c'), false, 'RIS split across reads');
    assert.strictEqual(gw().feed('t', 'tail\x1b[!', 'p'), false, 'DECSTR split across reads');
    assert.strictEqual(gw().feed('t', 'plain output\n'), undefined,
        'a terminal that never emitted 2004 must stay UNOBSERVED, not default to false');
});

test('the carry cannot re-fire a sequence the scan already consumed', () => {
    const { gw } = loadScanner();
    const a = gw();
    a.feed('t', '\x1b[?2004h');
    assert.strictEqual(a.feed('t', 'lots of plain output\n'), true, 'a consumed enable must survive later plain output');
    // The pre-review defect: a consumed reset left in the carry re-fired on every
    // later chunk. Here the enable must win because it is genuinely later.
    assert.strictEqual(gw().feed('t', '\x1b[?2004h', '\x1bc', '\x1b[?2004h'), true);
    // ...and the reset must win when IT is later, across chunk boundaries, even
    // with an unrelated DECSET and a colour SGR in between.
    assert.strictEqual(gw().feed('t', '\x1b[?2004h', 'text\x1b[0m', '\x1bc', '\x1b[?1000h'), false);
    const b = gw();
    b.feed('t', 'red \x1b[31m');
    assert.strictEqual(b.modeScanCarry.get('t'), '', 'a colour SGR tail must be dropped, never carried');
});

test('the carry is bounded and per-terminal', () => {
    const { gw, carryMax } = loadScanner();
    const drip = gw();
    for (let n = 0; n < 400; n++) {
        drip.feed('t', n === 0 ? '\x1b[?' : '1');
        assert.ok((drip.modeScanCarry.get('t') || '').length <= carryMax,
            `carry grew past MODE_SCAN_CARRY_MAX — an unterminated escape must degrade to a missed detection, never unbounded growth`);
    }
    assert.strictEqual(drip.decModes.get('t'), undefined, 'a digit drip must not set the mode');

    const cross = gw();
    cross.feed('a', '\x1b[?20');
    cross.feed('b', '04h');
    assert.strictEqual(cross.decModes.get('b'), undefined,
        "terminal b must not complete terminal a's partial escape — the carry is per terminal");
    assert.strictEqual(cross.feed('a', '04h'), true, "a's own carry must still complete");
});

test('a hostile digit run does not stall the output hot path', () => {
    const { gw } = loadScanner();
    // M7, automated — a THROUGHPUT FLOOR, not a test of the {0,64} bound. Measured,
    // the bound changes this from ~0.05ms to ~0.2ms on 80 KB: both are linear, so no
    // timing assertion can discriminate the bound (the structural assertion above
    // does that). What this DOES catch is a future edit to the matcher that
    // introduces genuine catastrophic backtracking — nested quantifiers, an
    // alternation that can match the empty string inside a loop — on the scanner
    // that runs on every flush of every terminal in the fleet.
    const junk = '\x1b[?' + '0123456789;'.repeat(4000);
    const start = process.hrtime.bigint();
    gw().feed('t', junk);
    gw().feed('t', ('\x1b[?' + '9'.repeat(64)).repeat(2000));
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 1000, `scanning ${junk.length} chars of digit junk took ${ms.toFixed(0)}ms — the matcher has acquired catastrophic backtracking`);
});

test('the recorded mode is torn down with the terminal', () => {
    const untrack = block(gatewayCode, 'private untrackTerminalData(', 'private drainPending(');
    assert.ok(untrack.includes('this.decModes.delete(name)'),
        'a terminal re-created under the same name must not inherit the dead process mode');
    assert.ok(untrack.includes('this.modeScanCarry.delete(name)'), 'carry must not leak across processes');
    assert.ok(block(gatewayCode, 'public dispose()', 'for (const client of this.clients)').includes('this.decModes.clear()'),
        'dispose must clear the recorded modes too');
});

test('a multi-param DECSET records every tracked mode in the set', () => {
    const { gw } = loadScanner();
    const g = gw();
    g.feed('t', '\x1b[?1049;1000;1006h');
    const modes = g.decModes.get('t');
    assert.ok(modes, 'the inner mode map must be created on the first mode event');
    assert.strictEqual(modes.get(1049), true, '1049 in the multi-param set');
    assert.strictEqual(modes.get(1000), true, '1000 in the multi-param set');
    assert.strictEqual(modes.get(1006), true, '1006 in the multi-param set');
    assert.strictEqual(modes.get(2004), undefined, '2004 was not in the set — omitted, not false');
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) { process.exit(1); }
