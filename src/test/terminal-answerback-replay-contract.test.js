'use strict';

/**
 * Source-text contract for browser-terminal ANSWERBACK suppression.
 *
 * Scrollback replay re-parses queries the CLI emitted while the view did not
 * exist. xterm answers them, onData forwards the answer to the pty, and the CLI
 * renders it as typed text. Nothing throws — the operator just sees
 * `10;rgb:e0e0/e0e0/e0e011;rgb:1717/1717/1717` appear at the prompt.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

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

// Evaluate the shipped regex rather than a copy, so the test cannot drift from it.
const reSource = /const ANSWERBACK_RE = (\/.*\/);/.exec(terminalsJs);
assert.ok(reSource, 'ANSWERBACK_RE must be declared in terminals.js');
// eslint-disable-next-line no-eval
const ANSWERBACK_RE = eval(reSource[1]);

test('the OSC colour replies that caused the bug are classified as answerback', () => {
    assert.ok(ANSWERBACK_RE.test('\x1b]10;rgb:e0e0/e0e0/e0e0\x1b\\'), 'OSC 10 foreground reply');
    assert.ok(ANSWERBACK_RE.test('\x1b]11;rgb:1717/1717/1717\x07'), 'OSC 11 background reply, BEL-terminated');
    assert.ok(ANSWERBACK_RE.test('\x1b]4;1;rgb:ff/00/00\x07'), 'OSC 4 palette reply');
});

test('the wider query-reply class is covered, not just OSC 10/11', () => {
    assert.ok(ANSWERBACK_RE.test('\x1b[?1;2c'), 'DA1');
    assert.ok(ANSWERBACK_RE.test('\x1b[?6c'), 'DA1, VT102 form');
    assert.ok(ANSWERBACK_RE.test('\x1b[>0;276;0c'), 'DA2');
    assert.ok(ANSWERBACK_RE.test('\x1b[24;80R'), 'CPR');
    assert.ok(ANSWERBACK_RE.test('\x1b[?24;80R'), 'DECXCPR');
    assert.ok(ANSWERBACK_RE.test('\x1b[0n'), 'DSR');
    assert.ok(ANSWERBACK_RE.test('\x1bP1+r5463=1B5B43\x1b\\'), 'XTGETTCAP');
    assert.ok(ANSWERBACK_RE.test('\x1bP0+r5463\x1b\\'), 'XTGETTCAP, invalid-capability form');
    assert.ok(ANSWERBACK_RE.test('\x1bP1$r0m\x1b\\'), 'DECRQSS');
    assert.ok(ANSWERBACK_RE.test('\x1bP>|xterm.js(5.5.0)\x1b\\'), 'XTVERSION');
});

// The reply class modern TUIs provoke most after OSC 10/11: mode 2026 is the
// synchronized-update probe, 2004 is bracketed paste. Missing this final was the
// gap that let the shipped fix pass every other assertion here while the operator
// still saw `?2026;2$y` at the prompt.
test('DECRQM mode replies are classified as answerback', () => {
    assert.ok(ANSWERBACK_RE.test('\x1b[?2026;2$y'), 'DECRQM private mode 2026');
    assert.ok(ANSWERBACK_RE.test('\x1b[?2004;1$y'), 'DECRQM private mode 2004');
    assert.ok(ANSWERBACK_RE.test('\x1b[4;1$y'), 'DECRQM ANSI mode');
});

test('operator keystrokes are NOT classified as answerback', () => {
    for (const key of ['a', 'A', 'hello world', '\r', '\n', '\x03', '\x7f', '\x1b',
                       '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D',
                       '\x1b[H', '\x1b[F', '\x1bOP', '\x1bOR', '\x1bb', '\x1bc', '\x1b[3~',
                       '\x1b[200~hello\x1b[201~', '\x1b[97;5u']) {
        assert.ok(!ANSWERBACK_RE.test(key), `must pass through: ${JSON.stringify(key)}`);
    }
});

// Focus reports are fired from the focus/blur handler, never from a parse, so
// replay cannot provoke them — and suppressing them would break focus reporting
// for the app. Pinned so a future "widen the final class" edit fails here.
test('focus in/out reports are NOT classified as answerback', () => {
    assert.ok(!ANSWERBACK_RE.test('\x1b[I'), 'focus in');
    assert.ok(!ANSWERBACK_RE.test('\x1b[O'), 'focus out');
});

// Pinned as a KNOWN, ACCEPTED collision rather than left to be rediscovered as a
// bug report. xterm maps modified F1-F4 to `ESC [ 1 ; <mod+1> P|Q|R|S` (Keyboard.ts
// case 112-115), so Shift-F3 is byte-identical to a CPR reply for row 1 column 2.
// No content filter can separate them. Narrowing the grammar to exclude this shape
// would let a real row-1 CPR reply reach the prompt — the reported bug, for a real
// reply. This assertion documents which way the trade was taken; flip it only
// together with the comment in terminals.js and a note on what replaced it.
test('modified F1-F4 collide with CPR by protocol design — accepted, not overlooked', () => {
    assert.ok(ANSWERBACK_RE.test('\x1b[1;2R'), 'Shift-F3 is indistinguishable from CPR row 1 col 2');
    assert.ok(!ANSWERBACK_RE.test('\x1b[1;2P'), 'Shift-F1 does NOT collide — P is not a reply final');
    assert.ok(!ANSWERBACK_RE.test('\x1b[1;2Q'), 'Shift-F2 does NOT collide');
    assert.ok(!ANSWERBACK_RE.test('\x1b[1;2S'), 'Shift-F4 does NOT collide');
    assert.ok(!ANSWERBACK_RE.test('\x1b[15;2~'), 'modified F5 does NOT collide — ~ is not a reply final');
});

test('onData drops answerback ONLY while the replay window is open', () => {
    const handler = block(terminalsJs, 'term.onData(', 'connectTerminalSocket(entry);');
    assert.ok(/entry\.suppressAnswerback\s*&&\s*isAnswerback\(data\)/.test(handler),
        'both conditions required — a bare flag check would eat keystrokes, a bare content check would break live colour queries');
});

test('the replay frame is written alone, never coalesced with live output', () => {
    const wr = block(terminalsJs, 'function writeReplay(entry, text)', 'function onWriteParsed(');
    assert.ok(!wr.includes('batchQueue'), 'replay must bypass the shared rAF batch queue');
    assert.ok(wr.includes('entry.suppressAnswerback = true'), 'window must open before the write');
    assert.ok((wr.match(/entry\.suppressAnswerback = false/g) || []).length >= 2,
        'window must close on BOTH the callback and the throw path — a stuck flag mutes live replies for the session');
});

test('the window is armed from the hello frame, not guessed', () => {
    const hello = block(terminalsJs, "frame.t === 'hello'", "frame.t === 'inputThrottled'");
    assert.ok(hello.includes('entry.awaitingReplayFrame'), 'hello must arm the replay marker');
    assert.ok(hello.includes('replayChars'), 'armed off the server-declared replay length');
});

test('a dead socket cannot leak its replay window into the next connection', () => {
    const connect = block(terminalsJs, 'function connectTerminalSocket(entry)', 'let wsUrl =');
    assert.ok(connect.includes('entry.suppressAnswerback = false'), 'reset on reconnect');
    assert.ok(connect.includes('entry.awaitingReplayFrame = false'), 'reset on reconnect');
});

test('a gapped reconnect resets the parser in-band before the replay write', () => {
    // RIS (\x1bc) is written from the hello arm, which the gateway sends
    // synchronously before the replay frame — so it precedes writeReplay in
    // document order AND in wire order. term.reset() is NOT acceptable here: it
    // does not reset the escape-sequence parser, so a stale mid-CSI would consume
    // the replay's first bytes.
    const hello = block(terminalsJs, "frame.t === 'hello'", "frame.t === 'inputThrottled'");
    const risIdx = hello.indexOf("entry.term.write('\\x1bc')");
    assert.ok(risIdx !== -1, 'the hello arm must write RIS (\\x1bc) on a gap');
    // Whole-line comments stripped first: the branch's own comment explains why
    // term.reset() is unusable, so matching the raw block flags the compliant code.
    const helloCode = hello.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/term\.reset\(\)/.test(helloCode),
        'term.reset() does not reset the parser — it must not be used on the gap path');
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) { process.exit(1); }
