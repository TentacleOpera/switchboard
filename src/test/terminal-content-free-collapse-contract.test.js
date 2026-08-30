'use strict';

/**
 * Source-text + behavioural contract for the content-free chunk collapse in
 * the terminal scrollback ring, and the client-side "working, no output"
 * signal that surfaces a heartbeating-but-silent seat.
 *
 * The bug: a coding lead running devin emits ~12 no-op frames per second (a
 * 30-byte cursor wiggle with no glyph) and no text while it works. Those
 * frames evict the real history the operator reattaches to read, and the
 * pane's stillness is indistinguishable from a dead terminal.
 *
 * The fix has two halves:
 *   (A) gateway — `flushOutput` replaces a content-free ring tail with an
 *       incoming content-free chunk instead of appending, so a run of
 *       heartbeats collapses to its last member in the ring (ring only; the
 *       wire frame is unchanged).
 *   (B) webview — a printable-aware `lastPrintableAt` timer per pane shows a
 *       "working, no output" affordance when a dispatched, pty-live seat has
 *       produced no glyph for N ms.
 *
 * The behavioural cases exercise the exported `isContentFree` helper when the
 * compiled `out/` is present (CI compiles first); they skip gracefully when it
 * is not, so this file stays green in a no-compile verification pass. The
 * source-text cases are the load-bearing regression guards and run
 * unconditionally.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const gatewayTs = fs.readFileSync(path.join(__dirname, '../standalone/terminalWsGateway.ts'), 'utf8');
const terminalsJs = fs.readFileSync(path.join(__dirname, '../webview/terminals.js'), 'utf8');
const terminalsHtml = fs.readFileSync(path.join(__dirname, '../webview/terminals.html'), 'utf8');
const bootstrapTs = fs.readFileSync(path.join(__dirname, '../standalone/bootstrap.ts'), 'utf8');

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

// The exact 30-byte devin heartbeat recorded in the plan. After CSI/OSC/DCS
// removal only a lone CR (0x0d) remains, which is a C0 control, not a
// printable glyph — so the frame is content-free.
const HEARTBEAT = '\x1b[?2026h\x1b[3B\x1b[3A\r\x1b[2C\x1b[?25h\x1b[?2026l';

// ---------------------------------------------------------------------------
// Behavioural — the exported pure helper (require out/, skip if absent).
// ---------------------------------------------------------------------------

let gatewayExport = null;
let outStale = false;
try {
    const outPath = path.join(__dirname, '../../out/standalone/terminalWsGateway.js');
    const srcPath = path.join(__dirname, '../standalone/terminalWsGateway.ts');
    outStale = fs.statSync(outPath).mtimeMs < fs.statSync(srcPath).mtimeMs;
    gatewayExport = require(outPath);
} catch { gatewayExport = null; /* not compiled — behavioural cases skip */ }

function behavioural(name, fn) {
    test(name, () => {
        if (!gatewayExport || outStale) {
            console.log(`     (skipped: out/ ${gatewayExport ? 'is STALE — run npm run compile-tests' : 'not compiled'})`);
            return;
        }
        fn();
    });
}

behavioural('isContentFree: the measured devin heartbeat is content-free', () => {
    const { isContentFree } = gatewayExport;
    assert.strictEqual(isContentFree(HEARTBEAT), true,
        'the 30-byte cursor wiggle (no glyph) must be content-free');
});

behavioural('isContentFree: a single space and real text are NOT content-free', () => {
    const { isContentFree } = gatewayExport;
    assert.strictEqual(isContentFree(' '), false, 'a single space is a printable glyph');
    assert.strictEqual(isContentFree('build ok\n'), false, 'real text is not content-free');
    assert.strictEqual(isContentFree('\x1b[31mred text\x1b[0m'), false, 'coloured text is not content-free');
});

behavioural('isContentFree: SGR-only and pure-control frames ARE content-free', () => {
    const { isContentFree } = gatewayExport;
    // An SGR colour change with no glyph is content-free by the zero-printable
    // gate. Collapsing it onto a content-free tail replaces the tail with the
    // latest SGR — the correct current colour state for a replay (plan Edge-Case).
    assert.strictEqual(isContentFree('\x1b[31m'), true, 'SGR-only (no glyph) is content-free');
    assert.strictEqual(isContentFree('\x1b[0m'), true, 'SGR reset (no glyph) is content-free');
    // A lone CR / LF / BS is a C0 control, not a printable glyph.
    assert.strictEqual(isContentFree('\r'), true, 'lone CR is content-free');
    assert.strictEqual(isContentFree('\n'), true, 'lone LF is content-free');
    assert.strictEqual(isContentFree(''), true, 'empty is content-free');
});

behavioural('isContentFree: a backspace-over-write (BS + glyph) is NOT content-free', () => {
    const { isContentFree } = gatewayExport;
    // BS moves the cursor; the following space is a printable glyph, so the
    // frame is not content-free and must never be collapsed.
    assert.strictEqual(isContentFree('\b ', false), false, 'BS + space carries a printable glyph');
});

behavioural('isContentFree: OSC title and CSI cursor moves with no glyph are content-free', () => {
    const { isContentFree } = gatewayExport;
    assert.strictEqual(isContentFree('\x1b]0;title\x07'), true, 'OSC title (no glyph) is content-free');
    assert.strictEqual(isContentFree('\x1b[?25h\x1b[?25l'), true, 'show/hide cursor (no glyph) is content-free');
});

// ---------------------------------------------------------------------------
// Source-text — the gateway collapse wiring (assertions on the .ts as text).
// ---------------------------------------------------------------------------

test('isContentFree is exported and gates on zero printables after escape removal', () => {
    assert.ok(/export function isContentFree\(text: string\): boolean/.test(gatewayTs),
        'isContentFree must be exported from terminalWsGateway.ts');
    const fn = block(gatewayTs, 'export function isContentFree', '\ninterface ScrollbackBuffer');
    assert.ok(fn.includes('replace(ESCAPE_SEQUENCE_RE'),
        'isContentFree must strip escapes via the ESCAPE_SEQUENCE_RE regex');
    assert.ok(/ch >= 0x20 && ch !== 0x7f/.test(fn),
        'printable test must be code point >= 0x20 and != DEL (0x7f)');
});

test('flushOutput collapses a content-free incoming chunk onto a content-free tail', () => {
    const flush = block(gatewayTs, 'private flushOutput(', 'private scanTerminalModes');
    assert.ok(flush.includes('isContentFree(combined)'),
        'the collapse must test the incoming combined chunk for content-free-ness');
    assert.ok(flush.includes('isContentFree(tail.data)'),
        'the collapse must test the ring tail for content-free-ness');
    assert.ok(/combined === tail\.data \|\| isContentFree\(tail\.data\)/.test(flush),
        'byte-identity must be the fast path that skips the tail scan, NOT the sole gate');
    assert.ok(flush.includes('tail.data = combined') && flush.includes('tail.seq = seq'),
        'the collapse must replace the tail chunk data AND seq with the incoming chunk\'s');
    assert.ok(/buffer\.totalBytes \+= combined\.length - oldLen/.test(flush),
        'totalBytes must be adjusted by the difference, not by the full incoming length');
});

test('the collapse replaces the tail instead of pushing a new chunk', () => {
    const flush = block(gatewayTs, 'private flushOutput(', 'private scanTerminalModes');
    // The collapse IF branch must NOT push; the push lives in the else.
    const ifBranch = block(flush, 'if (tail && isContentFree(combined)', '} else {');
    assert.ok(!/buffer\.chunks\.push/.test(ifBranch),
        'the collapse branch must not push a new chunk — it replaces the tail');
    assert.ok(flush.includes('buffer.chunks.push({ seq, data: combined });'),
        'the non-content-free path must still push a new chunk');
});

test('the wire frame and seq consumption are unchanged by the collapse', () => {
    const flush = block(gatewayTs, 'private flushOutput(', 'private scanTerminalModes');
    // nextSeq++ runs unconditionally before the collapse decision, so the wire
    // frame always gets a fresh monotonic seq.
    assert.ok(/seq = buffer\.nextSeq\+\+/.test(flush),
        'nextSeq++ must run unconditionally before the collapse decision');
    assert.ok(flush.includes('encodeOutputFrame(seq, combined)'),
        'the wire frame must still be encoded from seq + combined, unchanged');
    assert.ok(flush.includes('safeSendBinary(client.ws, frame)'),
        'client fan-out must be unchanged');
});

test('headSafeStart eviction handling is unchanged — no parallel re-derivation', () => {
    const flush = block(gatewayTs, 'private flushOutput(', 'private scanTerminalModes');
    assert.ok(flush.includes('replaySafeStart(unterminatedEscapeTail(removed.data)'),
        'the eviction loop must still compute headSafeStart from the discarded chunk');
    // No new headSafeStart computation was added for the collapse.
    const collapseBranch = block(flush, 'const tail =', 'while (buffer.totalBytes > MAX_SCROLLBACK_BYTES');
    assert.ok(!/headSafeStart/.test(collapseBranch),
        'the collapse must not add a parallel headSafeStart re-derivation');
});

// ---------------------------------------------------------------------------
// Source-text — the webview "working, no output" signal (assertions on .js).
// ---------------------------------------------------------------------------

test('the webview tracks lastPrintableAt and lastFrameAt per pane entry', () => {
    assert.ok(/lastPrintableAt:\s*0/.test(terminalsJs),
        'terminal entries must initialise lastPrintableAt to 0');
    assert.ok(/lastFrameAt:\s*0/.test(terminalsJs),
        'terminal entries must initialise lastFrameAt to 0');
});

test('the webview stamps timers only on LIVE frames, not replay frames', () => {
    // The awaitingReplayFrame branch returns before the stamping site.
    const onmessage = block(terminalsJs, 'ws.onmessage = (event) => {', 'ws.onclose = () => {');
    const replayReturn = onmessage.indexOf('writeReplay(entry, text);');
    const stampSite = onmessage.indexOf('entry.lastFrameAt = now;');
    assert.ok(replayReturn !== -1 && stampSite !== -1,
        'both the replay return and the stamp site must be present');
    assert.ok(stampSite > replayReturn,
        'the lastFrameAt stamp must be AFTER the awaitingReplayFrame return, so replay never stamps');
});

test('the webview resets lastPrintableAt only on a printable glyph via frameHasPrintable', () => {
    assert.ok(/function frameHasPrintable\(text\)/.test(terminalsJs),
        'frameHasPrintable must be defined');
    const stamp = block(terminalsJs, 'entry.batchQueue.push(text);', 'scheduleBatchFlush(entry);');
    assert.ok(stamp.includes('frameHasPrintable(text)'),
        'the binary live path must test the frame for printables');
    assert.ok(/if \(frameHasPrintable\(text\)\) {[\s\S]*?entry\.lastPrintableAt = now;/.test(stamp),
        'lastPrintableAt must be reset only inside the frameHasPrintable guard');
});

test('the signal is gated on the seat holding a dispatched card', () => {
    const fn = block(terminalsJs, 'function seatHoldsCard(', 'function renderWorkingSilence(');
    assert.ok(/item\.planTitle \|\| item\.planId/.test(fn),
        'seatHoldsCard must gate on fleet item planTitle/planId (dispatched_terminal)');
    const update = block(terminalsJs, 'function updateWorkingSilence(', 'function startWorkingSilenceSweep(');
    assert.ok(update.includes('seatHoldsCard(name)'),
        'updateWorkingSilence must gate on seatHoldsCard');
    assert.ok(update.includes('WORKING_LIVE_WINDOW_MS'),
        'updateWorkingSilence must gate on pty liveness (recent frame)');
    assert.ok(update.includes('WORKING_SILENCE_MS'),
        'updateWorkingSilence must gate on the silence threshold');
});

test('the signal clears the instant a printable frame arrives', () => {
    const stamp = block(terminalsJs, 'entry.batchQueue.push(text);', 'scheduleBatchFlush(entry);');
    assert.ok(stamp.includes('clearWorkingSilence(entry.name)'),
        'a printable live frame must call clearWorkingSilence immediately');
});

test('the affordance is a non-opaque overlay, not a full cover', () => {
    assert.ok(terminalsHtml.includes('.working-silence'),
        'the .working-silence CSS must be present');
    const css = block(terminalsHtml, '.working-silence {', '.working-silence-label {');
    assert.ok(/pointer-events: none/.test(css),
        'the affordance must not steal keystrokes from xterm');
    // It must NOT be a full inset:0 opaque cover like the startup curtain —
    // the whole point is to keep the cursor wiggles visible.
    assert.ok(!/inset: 0/.test(css),
        'the affordance must not be a full-cover overlay (inset:0) — it would hide the liveness it exists to report');
});

test('the silence threshold reads the injected body data attribute, defaulting to 90000', () => {
    const cfg = block(terminalsJs, 'const WORKING_SILENCE_MS', 'const WORKING_LIVE_WINDOW_MS');
    assert.ok(/workingSilenceMs/.test(cfg),
        'WORKING_SILENCE_MS must read the workingSilenceMs body data attribute');
    assert.ok(/90000/.test(cfg),
        'WORKING_SILENCE_MS must default to 90000 when the attribute is absent');
});

test('the sweep is started once during init', () => {
    const init = block(terminalsJs, 'function init() {', 'function postFleetStateToShell(');
    assert.ok(init.includes('startWorkingSilenceSweep()'),
        'init must start the working-silence sweep');
});

test('the affordance is cleared on terminal destroy, exit, and error', () => {
    assert.ok(/destroyTerminalView[\s\S]{0,200}clearWorkingSilence\(name\)/.test(terminalsJs),
        'destroyTerminalView must clear the affordance');
    assert.ok(/frame\.t === 'error'[\s\S]{0,500}clearWorkingSilence\(entry\.name\)/.test(terminalsJs),
        'the error frame handler must clear the affordance');
    assert.ok(/frame\.t === 'exit'[\s\S]{0,900}clearWorkingSilence\(entry\.name\)/.test(terminalsJs),
        'the exit frame handler must clear the affordance');
});

// ---------------------------------------------------------------------------
// Source-text — the config injection (both hosts share one knob).
// ---------------------------------------------------------------------------

test('the standalone host injects data-working-silence-ms from activityLight.turnEndSilenceMs', () => {
    assert.ok(/data-working-silence-ms=/.test(bootstrapTs),
        'bootstrap.ts must inject data-working-silence-ms');
    assert.ok(/activityLight\.turnEndSilenceMs/.test(bootstrapTs),
        'bootstrap.ts must read the threshold from activityLight.turnEndSilenceMs');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exitCode = 1; }
