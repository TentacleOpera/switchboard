'use strict';

/**
 * Source-text contract for browser-terminal DEC private-mode restore on reattach.
 *
 * The pty app enables mouse reporting (1000/1002/1003/1006/9), focus reporting
 * (1004), bracketed paste (2004) and the alt screen (1049). Each is CLIENT state
 * that a fresh xterm starts without, and the app never re-announces a mode it
 * believes is settled. The gateway records the set; the client re-arms it AFTER
 * the replay so a stale enable inside the evicted-tail replay cannot win. Every
 * one of these behaviours fails silently and is invisible to a headless run, so
 * they are pinned structurally here.
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

// 1. The gateway records ALL tracked modes, not just 2004, and scans before the
//    ring append.
test('the gateway tracks the full DEC mode set and scans before the ring append', () => {
    assert.ok(gatewayCode.includes('export const TRACKED_DEC_MODES = '),
        'the tracked set must be declared as a module constant');
    const decl = /export const TRACKED_DEC_MODES = \[([^\]]+)\] as const;/.exec(gatewayCode);
    assert.ok(decl, 'TRACKED_DEC_MODES must be a literal array');
    const modes = decl[1].split(',').map(s => Number(s.trim()));
    for (const m of [9, 1000, 1002, 1003, 1004, 1006, 1049, 2004]) {
        assert.ok(modes.includes(m), `mode ${m} must be tracked`);
    }
    const flush = block(gatewayCode, 'private flushOutput(', 'private scanTerminalModes(');
    const scanIdx = flush.indexOf('this.scanTerminalModes(');
    const ringIdx = flush.indexOf('buffer.chunks.push(');
    assert.ok(scanIdx !== -1 && ringIdx !== -1 && scanIdx < ringIdx,
        'the scan must run before the ring append — the ring evicts, and outliving eviction is the entire point');
});

// 2. Hello omits `modes` when nothing has been observed, and derives
//    `bracketedPaste` from the same record.
test('hello omits modes when unobserved and derives bracketedPaste from the same record', () => {
    const hello = block(gatewayCode, "t: 'hello'", 'Replay scrollback BEFORE');
    assert.ok(hello.includes('modes && modes.size > 0'),
        'modes must be omitted, NOT false, when nothing has been observed — telling a client to DISABLE a mode nobody ruled on is a regression');
    assert.ok(hello.includes('Object.fromEntries(modes)'),
        'the mode map is serialised as a plain object');
    // The derivation sits just above the safeSend; assert against the surrounding
    // region rather than the post-`t: 'hello'` slice.
    const setup = block(gatewayCode, 'const modes = this.decModes.get(terminal.name);', 'Replay scrollback BEFORE');
    assert.ok(setup.includes('modes?.get(2004)'),
        'bracketedPaste must be derived from the same record so the legacy field can never disagree with modes["2004"]');
});

// 3. The client applies the set AFTER the replay — assert applyServerModes is
//    called from writeReplay's callback and that the hello branch only applies
//    inline when !entry.awaitingReplayFrame.
test('the client applies the mode set after the replay parse', () => {
    const wr = block(terminalsJs, 'function writeReplay(entry, text)', 'function onWriteParsed(');
    assert.ok(wr.includes('entry.pendingModes'),
        'writeReplay must apply pendingModes in its callback — the authoritative write lands after the replay parse, not before it');
    const hello = block(terminalsJs, "frame.t === 'hello'", "frame.t === 'inputThrottled'");
    assert.ok(hello.includes('!entry.awaitingReplayFrame && applyServerModes'),
        'the hello branch must only apply inline when there is no replay to wait for');
});

// 4. 1049 is absent from REARMABLE_DEC_MODES, and the ?1049l literal appears
//    ONLY in a statement that also tests === 'alternate'. Assert ?1049h appears
//    nowhere in terminals.js.
test('alt screen is reset-only and buffer-gated', () => {
    assert.ok(!terminalsJs.includes('\\x1b[?1049h'),
        'the client must NEVER write ?1049h — it would switch a fresh xterm to an empty alt buffer and hide the replayed scrollback');
    const apply = block(terminalsJs, 'function applyServerModes(', 'function isAnswerback(');
    // Parsed from the DECLARATION, which sits ABOVE applyServerModes and is therefore
    // outside the slice above — a regex run against `apply` can never match it and the
    // assertion would pass no matter what the list contained.
    const rearmDecl = /const REARMABLE_DEC_MODES = \[([^\]]+)\];/.exec(terminalsJs);
    assert.ok(rearmDecl, 'REARMABLE_DEC_MODES must be declared');
    assert.ok(!rearmDecl[1].split(',').map(s => Number(s.trim())).includes(1049),
        '1049 must be absent from REARMABLE_DEC_MODES — it is handled separately and conditionally');
    // The gate: `inAlt` is read from term.buffer.active.type === 'alternate', and
    // the ?1049l write is gated on `inAlt`. Both must live in applyServerModes and
    // the write line must reference the gate variable — two independent greps
    // (one for 'alternate', one for ?1049l) would pass on a file where the gate
    // and the write had drifted apart.
    assert.ok(apply.includes("=== 'alternate'"),
        "applyServerModes must read term.buffer.active.type === 'alternate' as the gate");
    const writeLines = apply.split('\n').filter(l => l.includes("\\x1b[?1049l"));
    assert.ok(writeLines.length > 0, '?1049l must appear in applyServerModes');
    for (const line of writeLines) {
        assert.ok(line.includes('inAlt'),
            '?1049l must be gated on the inAlt variable (set from === "alternate") — an ungated write teleports the cursor to row 0 on top of the replayed scrollback');
    }
});

// 5. The carry-fragment guard regex survives in the gateway scanner.
test('the carry-fragment guard survives in the gateway scanner', () => {
    const scan = block(gatewayCode, 'private scanTerminalModes(', 'private untrackTerminalData(');
    assert.ok(scan.includes("/^\\x1b(\\[(\\?[0-9;]{0,64}|!)?)?$/.test(fragment) ? fragment : ''"),
        'the carry-fragment guard must survive — a colour SGR or OSC title tail must be dropped, never carried into the next chunk');
});

// 6. decModes is torn down at all THREE sites.
test('decModes is torn down at all three name-keyed collection sites', () => {
    const untrack = block(gatewayCode, 'private untrackTerminalData(', 'private drainPending(');
    assert.ok(untrack.includes('this.decModes.delete(name)'),
        'untrackTerminalData must delete the mode map — a terminal re-created under the same name must not inherit the dead process modes');
    const rekey = block(gatewayCode, 'private rekeyTerminal(', 'private setupClient(');
    assert.ok(rekey.includes('moveMap(this.decModes)'),
        'rekeyTerminal must move the mode map — a rename must not lose the recorded state');
    assert.ok(block(gatewayCode, 'public dispose()', 'for (const client of this.clients)').includes('this.decModes.clear()'),
        'dispose must clear the mode maps too');
});

// 7. Mode 9 parity across both lists. X10 mouse reporting is the one mouse mode
//    that is easy to forget — it predates the 1000-family and reads as legacy —
//    so a terminal that tracks it server-side but cannot re-arm it (or the
//    reverse) restores a pane into a half-live mouse state on reattach.
test('mode 9 is tracked by the gateway and re-armable on the client', () => {
    const trackedDecl = /export const TRACKED_DEC_MODES = \[([^\]]+)\] as const;/.exec(gatewayCode);
    const tracked = trackedDecl[1].split(',').map(s => Number(s.trim()));
    assert.ok(tracked.includes(9), 'mode 9 must be tracked by the gateway');
    const rearmDecl = /const REARMABLE_DEC_MODES = \[([^\]]+)\];/.exec(terminalsJs);
    assert.ok(rearmDecl, 'REARMABLE_DEC_MODES must be declared');
    const rearm = rearmDecl[1].split(',').map(s => Number(s.trim()));
    assert.ok(rearm.includes(9), 'mode 9 must be re-armable on the client');
});

test('pendingModes is reset on reconnect and cleared on the replay throw path', () => {
    const connect = block(terminalsJs, 'function connectTerminalSocket(entry)', 'let wsUrl =');
    assert.ok(connect.includes('entry.pendingModes = null'),
        'a set left armed by a socket that died mid-replay describes a stream this connection will not receive');
    const wr = block(terminalsJs, 'function writeReplay(entry, text)', 'function onWriteParsed(');
    assert.ok(wr.includes('entry.pendingModes = null'),
        'the throw path must clear pendingModes alongside suppressAnswerback');
});

test('macOptionClickForcesSelection is true in the constructor', () => {
    const ctor = block(terminalsJs, 'new window.Terminal({', '});');
    assert.ok(ctor.includes('macOptionClickForcesSelection: true'),
        'Option-drag must select even while an app is capturing the mouse — without it there is no modifier that can select text in a mouse-reporting app on macOS');
});

test('Shift-wheel scrolls the viewport even while the app is capturing the wheel', () => {
    const mat = block(terminalsJs, 'function materializeTerminalView(entry)', "term.textarea.addEventListener('focus'");
    assert.ok(mat.includes('attachCustomWheelEventHandler'),
        'the custom wheel handler must be registered');
    assert.ok(mat.includes('!ev.shiftKey'),
        'a plain wheel must still reach xterm untouched — only Shift-wheel is intercepted');
    // The load-bearing half, and the one a "simplification" back to `!ev.shiftKey`
    // would silently delete. While mouse reporting is active xterm's mouse-report
    // listener runs `cancel(e, true)` UNCONDITIONALLY — preventDefault fires whatever
    // the custom handler returns — so returning false suppresses the mouse report but
    // NOT the preventDefault, and native scroll is dead in exactly the state this
    // bypass exists for. The scroll therefore has to be performed here.
    assert.ok(mat.includes("classList.contains('enable-mouse-events')"),
        'the Shift-wheel branch must detect the mouse-reporting state — that is the state where xterm preventDefaults regardless of our return value');
    assert.ok(/scrollTop \+= delta/.test(mat) && mat.includes('term.scrollLines(') && mat.includes('term.scrollPages('),
        'the handler must scroll the viewport itself in the mouse-reporting state — a bare `false` return leaves preventDefault standing and the gesture does nothing');
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) { process.exit(1); }
