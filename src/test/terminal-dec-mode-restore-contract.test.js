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
const terminalsHtml = fs.readFileSync(path.join(__dirname, '../webview/terminals.html'), 'utf8');

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
    assert.ok(!/REARMABLE_DEC_MODES\s*=\s*\[[^\]]*1049/.test(apply),
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

// 7. Mode 9 parity across all three lists — the dead-button guard. Every mouse
//    mode the pill can display must be a mode the pill can clear. Written as a
//    parity assertion derived from a single source, not three independent greps.
test('mode 9 is present in all three mouse-mode lists — the dead-button guard', () => {
    // The pill's release write is the authoritative list of modes it can clear.
    const pill = block(terminalsJs, 'function attachMouseModeRelease(', 'function connectTerminalSocket(');
    const releaseMatch = /term\.write\('([^']*\?9l[^']*)'\)/.exec(pill);
    assert.ok(releaseMatch, 'the pill must write a release escape sequence');
    const releaseSeq = releaseMatch[1];
    const releasedModes = [];
    const modeRe = /\?(\d+)l/g;
    let m;
    while ((m = modeRe.exec(releaseSeq)) !== null) { releasedModes.push(Number(m[1])); }
    // The pill's visibility signal is `enable-mouse-events`, which xterm sets for
    // ANY non-zero event mask — including X10's. So every mouse mode that can
    // show the pill must be in the release write. Derive the mouse subset from the
    // gateway's tracked set: 9, 1000, 1002, 1003, 1006 (1004 is focus, 1049 is alt
    // screen, 2004 is paste — none show the mouse-events class).
    const mouseModes = [9, 1000, 1002, 1003, 1006];
    for (const mode of mouseModes) {
        assert.ok(releasedModes.includes(mode),
            `mode ${mode} can show the pill (enable-mouse-events) but is not in the release write — a dead button`);
    }
    // And 9 must be in the gateway's tracked set and the client's re-armable set.
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

test('the mouse-mode MutationObserver is disconnected in destroyTerminalView', () => {
    const destroy = block(terminalsJs, 'function destroyTerminalView(name)', 'function createTerminalView(');
    assert.ok(destroy.includes('entry.mouseModeObserver'),
        'the MutationObserver must be torn down — term.dispose() will not disconnect it');
    assert.ok(destroy.includes('entry.mouseModeObserver.disconnect()'),
        'the observer must be explicitly disconnected');
});

test('macOptionClickForcesSelection is true in the constructor', () => {
    const ctor = block(terminalsJs, 'new window.Terminal({', '});');
    assert.ok(ctor.includes('macOptionClickForcesSelection: true'),
        'Option-drag must select even while an app is capturing the mouse — without it there is no modifier that can select text in a mouse-reporting app on macOS');
});

test('the wheel handler returns !ev.shiftKey so Shift-wheel scrolls', () => {
    const mat = block(terminalsJs, 'function materializeTerminalView(entry)', 'term.onFocus(');
    assert.ok(mat.includes('attachCustomWheelEventHandler'),
        'the custom wheel handler must be registered');
    assert.ok(mat.includes('!ev.shiftKey'),
        'returning false for Shift-wheel makes xterm skip its own handling and let the browser scroll the viewport');
});

test('--state-mouse-captured is declared in :root with no hex literal in the rule', () => {
    const rootBlock = block(terminalsHtml, ':root {', '}');
    assert.ok(rootBlock.includes('--state-mouse-captured'),
        'the mouse-captured token must be declared in :root — a condition the operator did not ask for reads identically in both themes');
    const rule = block(terminalsHtml, '.mouse-mode-release {', '}');
    assert.ok(rule.includes('var(--state-mouse-captured)'),
        'the pill must use the token, not a hex literal');
    assert.ok(!/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/.test(rule),
        'no hex literal inside the .mouse-mode-release rule — the no-literals convention the accent family follows');
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) { process.exit(1); }
