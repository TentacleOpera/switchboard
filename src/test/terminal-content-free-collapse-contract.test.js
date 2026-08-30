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
 * The behavioural cases exercise the exported `isContentFree` helper AND drive
 * the real `flushOutput` ring through a stub fleet, when the compiled `out/` is
 * present (CI compiles first); they skip gracefully when it is not, so this file
 * stays green in a no-compile verification pass. The source-text cases are the
 * load-bearing regression guards and run unconditionally.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const gatewayTs = fs.readFileSync(path.join(__dirname, '../standalone/terminalWsGateway.ts'), 'utf8');
const terminalsJs = fs.readFileSync(path.join(__dirname, '../webview/terminals.js'), 'utf8');
const terminalsHtml = fs.readFileSync(path.join(__dirname, '../webview/terminals.html'), 'utf8');
const bootstrapTs = fs.readFileSync(path.join(__dirname, '../standalone/bootstrap.ts'), 'utf8');
const taskViewerTs = fs.readFileSync(path.join(__dirname, '../services/TaskViewerProvider.ts'), 'utf8');

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

behavioural('isContentFree: SGR-only and idempotent state frames ARE content-free', () => {
    const { isContentFree } = gatewayExport;
    // An SGR colour change with no glyph is content-free. Collapsing it onto a
    // content-free tail replaces the tail with the latest SGR — the correct
    // current colour state for a replay (plan Edge-Case).
    assert.strictEqual(isContentFree('\x1b[31m'), true, 'SGR-only (no glyph) is content-free');
    assert.strictEqual(isContentFree('\x1b[0m'), true, 'SGR reset (no glyph) is content-free');
    // CR is ABSOLUTE ("column 0"), so a run of them is indistinguishable from
    // one. It is the control the measured devin heartbeat leaves behind.
    assert.strictEqual(isContentFree('\r'), true, 'lone CR is content-free');
    assert.strictEqual(isContentFree(''), true, 'empty is content-free');
    assert.strictEqual(isContentFree('\x1b[10;5H'), true, 'absolute cursor position is content-free');
});

behavioural('isContentFree: screen-MUTATING frames are NOT content-free', () => {
    const { isContentFree } = gatewayExport;
    // REGRESSION GUARD. The collapse keeps only the LAST member of a run, which
    // is sound for idempotent state assignment and UNSOUND for actions. A
    // zero-printable-only gate calls every one of these content-free, and
    // collapsing them silently drops screen state — the "erring wide deletes
    // real history" failure the plan names as its first risk.
    assert.strictEqual(isContentFree('\n'), false, 'LF scrolls — two are not one');
    assert.strictEqual(isContentFree('\r\n\r\n'), false, 'a run of blank lines is real screen state');
    assert.strictEqual(isContentFree('\b'), false, 'BS moves relative to where the cursor already is');
    assert.strictEqual(isContentFree('\t'), false, 'HT moves relative to where the cursor already is');
    assert.strictEqual(isContentFree('\x1b[2J'), false, 'erase-in-display mutates the buffer');
    assert.strictEqual(isContentFree('\x1b[K'), false, 'erase-in-line mutates the buffer');
    assert.strictEqual(isContentFree('\x1b[2L'), false, 'insert-line mutates the buffer');
    assert.strictEqual(isContentFree('\x1b[3M'), false, 'delete-line mutates the buffer');
    assert.strictEqual(isContentFree('\x1b[2S'), false, 'scroll-up mutates the buffer');
    assert.strictEqual(isContentFree('\x1bM'), false, 'reverse index scrolls');
    assert.strictEqual(isContentFree('\x1bc'), false, 'RIS resets the terminal');
});

behavioural('isContentFree: a backspace-over-write (BS + glyph) is NOT content-free', () => {
    const { isContentFree } = gatewayExport;
    // BS moves the cursor; the following space is a printable glyph, so the
    // frame is not content-free and must never be collapsed.
    assert.strictEqual(isContentFree('\b '), false, 'BS + space carries a printable glyph');
});

behavioural('isContentFree: OSC title and CSI cursor moves with no glyph are content-free', () => {
    const { isContentFree } = gatewayExport;
    assert.strictEqual(isContentFree('\x1b]0;title\x07'), true, 'OSC title (no glyph) is content-free');
    assert.strictEqual(isContentFree('\x1b[?25h\x1b[?25l'), true, 'show/hide cursor (no glyph) is content-free');
});

// ---------------------------------------------------------------------------
// Behavioural — the REAL flushOutput ring, driven through a stub fleet.
//
// The source-text cases below pin the shape of the collapse; these pin its
// EFFECT, which is the only thing that can discriminate a working collapse from
// a well-shaped one. They cover the plan's Verification Plan 1-4 and its Goal
// Invariants (ring depth, totalBytes, monotonic nextSeq, untouched wire bytes).
// ---------------------------------------------------------------------------

/** A gateway over a fleet that owns no terminals — `get()` returns undefined, so
 *  checkBackpressure early-returns and no pty is ever touched. */
function makeGateway() {
    const { TerminalWsGateway } = gatewayExport;
    const fleet = {
        list: () => [],
        onDidChange: () => ({ dispose() { /* no-op */ } }),
        get: () => undefined,
    };
    return new TerminalWsGateway(fleet, async () => undefined);
}

/** Register a terminal (creates its ring) without a real pty handle. */
function track(gw, name) {
    gw.trackTerminalData({ name, onData: () => ({ dispose() { /* no-op */ } }) });
    return gw.scrollbackBuffers.get(name);
}

/** Push one chunk through the real flushOutput, one flush per chunk. */
function flush(gw, name, chunk) {
    gw.pendingOutput.set(name, { parts: [chunk], bytes: chunk.length });
    gw.flushOutput(name);
}

function withGateway(fn) {
    const gw = makeGateway();
    try { fn(gw); } finally { gw.dispose(); }
}

behavioural('ring: 5000 heartbeats collapse to ONE chunk and one heartbeat of bytes', () => {
    withGateway(gw => {
        const buf = track(gw, 'seat');
        for (let i = 0; i < 5000; i++) { flush(gw, 'seat', HEARTBEAT); }
        assert.strictEqual(buf.chunks.length, 1, 'a run of heartbeats must occupy ONE ring entry');
        assert.strictEqual(buf.totalBytes, HEARTBEAT.length,
            'totalBytes must reflect exactly one heartbeat, not 5000');
        assert.strictEqual(buf.chunks[0].data, HEARTBEAT,
            'the surviving chunk is the LAST member of the run (cursor rest position + ?25h)');
        // Goal Invariant: nextSeq advances by exactly one per flush regardless.
        assert.strictEqual(buf.nextSeq, 5001, 'nextSeq must advance once per flush, collapse or not');
        assert.strictEqual(buf.chunks[0].seq, 5000, 'the collapsed tail carries the newest seq');
    });
});

behavioural('ring: the wire bytes and their order are untouched by the collapse', () => {
    withGateway(gw => {
        track(gw, 'seat');
        const observed = [];
        gw.onFlush((name, data) => observed.push([name, data]));
        const inputs = [HEARTBEAT, HEARTBEAT, 'build ok', HEARTBEAT];
        for (const chunk of inputs) { flush(gw, 'seat', chunk); }
        assert.deepStrictEqual(observed.map(o => o[1]), inputs,
            'every flush must reach observers byte-identical and in order — the collapse is ring-only');
    });
});

behavioural('ring: a coalesced two-heartbeat burst collapses onto a one-heartbeat tail', () => {
    withGateway(gw => {
        const buf = track(gw, 'seat');
        flush(gw, 'seat', HEARTBEAT);
        flush(gw, 'seat', HEARTBEAT + HEARTBEAT);
        assert.strictEqual(buf.chunks.length, 1,
            'content-free-ness, not byte-identity, must be the gate — a 60-byte burst still collapses');
        assert.strictEqual(buf.chunks[0].data, HEARTBEAT + HEARTBEAT);
        assert.strictEqual(buf.totalBytes, HEARTBEAT.length * 2, 'totalBytes tracks the replacement, not the sum');
    });
});

behavioural('ring: real output breaks the run', () => {
    withGateway(gw => {
        const buf = track(gw, 'seat');
        flush(gw, 'seat', HEARTBEAT);
        flush(gw, 'seat', 'compiling...');
        flush(gw, 'seat', HEARTBEAT);
        assert.strictEqual(buf.chunks.length, 3, 'heartbeat, text, heartbeat must yield THREE ring entries');
        assert.strictEqual(buf.chunks[1].data, 'compiling...');
    });
});

behavioural('ring: a single space and a line feed are never collapsed away', () => {
    withGateway(gw => {
        const buf = track(gw, 'seat');
        flush(gw, 'seat', HEARTBEAT);
        flush(gw, 'seat', ' ');
        assert.strictEqual(buf.chunks.length, 2, 'a single space is real history');
    });
    withGateway(gw => {
        const buf = track(gw, 'seat');
        flush(gw, 'seat', HEARTBEAT);
        flush(gw, 'seat', '\r\n');
        assert.strictEqual(buf.chunks.length, 2, 'a line feed scrolls — it must survive the collapse');
    });
    withGateway(gw => {
        const buf = track(gw, 'seat');
        flush(gw, 'seat', HEARTBEAT);
        flush(gw, 'seat', '\x1b[2J');
        assert.strictEqual(buf.chunks.length, 2,
            'an erase-in-display must never be dropped — the replay would keep content the terminal cleared');
    });
});

behavioural('ring: two differing SGR-only frames DO collapse, keeping the latest', () => {
    withGateway(gw => {
        const buf = track(gw, 'seat');
        flush(gw, 'seat', '\x1b[31m');
        flush(gw, 'seat', '\x1b[32m');
        assert.strictEqual(buf.chunks.length, 1,
            'byte-identity is only the fast path — differing content-free frames still collapse');
        assert.strictEqual(buf.chunks[0].data, '\x1b[32m', 'the LATEST colour state is the correct replay state');
    });
});

behavioural('ring: spanStart keeps gap detection exact across a collapsed run', () => {
    withGateway(gw => {
        const buf = track(gw, 'seat');
        flush(gw, 'seat', 'first');            // seq 1
        for (let i = 0; i < 20; i++) { flush(gw, 'seat', HEARTBEAT); }  // seq 2..21
        assert.strictEqual(buf.chunks.length, 2);
        const collapsed = buf.chunks[1];
        assert.strictEqual(collapsed.seq, 21, 'the collapsed chunk carries the newest seq for the resume compare');
        assert.strictEqual(collapsed.spanStart, 2,
            'spanStart must stay at the run\'s FIRST seq so a client that disconnected mid-run is not told it lost real output');
    });
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
    const ifBranch = block(flush, 'if (tail && !headTrimStanding', '} else {');
    assert.ok(!/buffer\.chunks\.push/.test(ifBranch),
        'the collapse branch must not push a new chunk — it replaces the tail');
    assert.ok(flush.includes('buffer.chunks.push({ seq, data: combined, spanStart: seq });'),
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

test('the ring chunk carries spanStart, preserved across a collapse', () => {
    assert.ok(/spanStart: number;/.test(gatewayTs), 'ScrollbackChunk must declare spanStart');
    const flush = block(gatewayTs, 'private flushOutput(', 'private scanTerminalModes');
    assert.ok(/buffer\.chunks\.push\(\{ seq, data: combined, spanStart: seq \}\)/.test(flush),
        'an appended chunk must seed spanStart from its own seq');
    const collapseBranch = block(flush, 'if (tail && !headTrimStanding', '} else {');
    assert.ok(!/spanStart/.test(collapseBranch),
        'the collapse must NOT touch spanStart — it names the run\'s first seq');
    const attach = block(gatewayTs, 'const oldestRetained =', 'replayGap = lastSeq');
    assert.ok(/buffer\.chunks\[0\]\.spanStart/.test(attach),
        'gap detection must compare against spanStart, not the collapsed chunk\'s newest seq');
});

test('headSafeStart eviction handling is unchanged — no parallel re-derivation', () => {
    const flush = block(gatewayTs, 'private flushOutput(', 'private scanTerminalModes');
    assert.ok(flush.includes('replaySafeStart(unterminatedEscapeTail(removed.data)'),
        'the eviction loop must still compute headSafeStart from the discarded chunk');
    // No new headSafeStart computation was added for the collapse.
    // The collapse may READ headSafeStart (it declines when a trim offset is
    // standing against a single-chunk ring, which would otherwise slice the
    // replacement at an offset computed for the bytes it replaced). What it must
    // never do is ASSIGN one: the eviction loop stays the sole writer.
    const collapseBranch = block(flush, 'const tail =', 'while (buffer.totalBytes > MAX_SCROLLBACK_BYTES');
    assert.ok(!/headSafeStart\s*=[^=]/.test(collapseBranch),
        'the collapse must not add a parallel headSafeStart re-derivation');
    assert.ok(/headTrimStanding/.test(collapseBranch),
        'the collapse must decline when a head trim offset is standing against a single-chunk ring');
});

// ---------------------------------------------------------------------------
// Source-text — the webview "working, no output" signal (assertions on .js).
// ---------------------------------------------------------------------------

test('the webview tracks lastPrintableAt, lastFrameAt and firstFrameAt per pane entry', () => {
    assert.ok(/lastPrintableAt:\s*0/.test(terminalsJs),
        'terminal entries must initialise lastPrintableAt to 0');
    assert.ok(/lastFrameAt:\s*0/.test(terminalsJs),
        'terminal entries must initialise lastFrameAt to 0');
    assert.ok(/firstFrameAt:\s*0/.test(terminalsJs),
        'terminal entries must initialise firstFrameAt to 0');
});

// REGRESSION GUARD, and the one that decides whether this feature works at all.
// The silence clock's origin for a seat that has NEVER printed must be
// firstFrameAt. lastFrameAt is restamped by every heartbeat — 12 times a second
// on the measured seat — so using it as the origin holds `now - since` at ~0
// forever and the affordance can never appear for the exact seat the plan
// measured (183 frames, 0 printable characters in 15 s).
test('the silence clock falls back to firstFrameAt, never to lastFrameAt', () => {
    const update = block(terminalsJs, 'function updateWorkingSilence(', 'function startWorkingSilenceSweep(');
    assert.ok(/const since = entry\.lastPrintableAt \|\| entry\.firstFrameAt;/.test(update),
        'the never-printed fallback must be firstFrameAt');
    assert.ok(!/entry\.lastPrintableAt \|\| entry\.lastFrameAt/.test(update),
        'lastFrameAt must NOT be the silence-clock origin — the heartbeat restamps it');
    assert.ok(/if \(!entry\.firstFrameAt\) \{ entry\.firstFrameAt = now; \}/.test(terminalsJs),
        'firstFrameAt must be stamped once, on the first live frame');
});

// The live-frame handler runs once per flush frame (up to ~166/s, frames up to
// MAX_FLUSH_BYTES). An unconditional O(n) regex scan plus a querySelectorAll
// there is real main-thread cost on the busiest terminals — which are exactly
// the ones that will never show this signal.
test('the printable scan and the DOM clear are throttled off the live-frame hot path', () => {
    assert.ok(/const PRINTABLE_SCAN_THROTTLE_MS = \d+;/.test(terminalsJs),
        'a scan throttle constant must exist');
    const stamp = block(terminalsJs, 'entry.batchQueue.push(text);', 'scheduleBatchFlush(entry);');
    assert.ok(/now - entry\.lastPrintableAt >= PRINTABLE_SCAN_THROTTLE_MS/.test(stamp),
        'the printable scan must be gated by the throttle');
    assert.ok(/workingSilenceShown\.has\(entry\.name\)/.test(stamp),
        'the DOM clear must be gated on the affordance actually being shown');
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

// BOTH composition roots, per the standalone/extension no-divergence rule. The
// panel HTML is shared, so a threshold injected by one host and not the other is
// invisible at runtime — the missing host silently falls back to the 90s default
// and the operator's configured value is ignored on exactly one of them.
test('the extension host injects the same attribute from the same setting', () => {
    assert.ok(/data-working-silence-ms=/.test(taskViewerTs),
        'TaskViewerProvider.ts must inject data-working-silence-ms too');
    assert.ok(/activityLight\.turnEndSilenceMs/.test(taskViewerTs),
        'TaskViewerProvider.ts must read the threshold from activityLight.turnEndSilenceMs');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exitCode = 1; }
