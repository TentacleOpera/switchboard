'use strict';

/**
 * Source-text + behavioural contract for browser-terminal SCROLLBACK REPLAY
 * GAP detection and safe parse start.
 *
 * Two defects: (A) the gateway's replay filter could not distinguish "you
 * missed nothing" from "everything you missed was evicted", so a reconnecting
 * client spliced evicted survivors onto a stale screen and sealed the hole by
 * advancing its lastSeq; (B) the first retained chunk can begin mid-escape-
 * sequence, so a cold parser consumes the orphaned remainder as literal text.
 *
 * The behavioural cases exercise the three exported pure helpers when the
 * compiled `out/` is present (CI compiles first); they skip gracefully when it
 * is not, so this file stays green in a no-compile verification pass. The
 * source-text cases are the load-bearing regression guards and run unconditionally.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const gatewayTs = fs.readFileSync(path.join(__dirname, '../standalone/terminalWsGateway.ts'), 'utf8');
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

/**
 * Drop whole-line comments before asserting on the ABSENCE of an identifier.
 *
 * The gap branch's comment explains at length why term.reset() is unusable here,
 * so a bare /term\.reset\(\)/ over the raw block matches the prose that documents
 * the fix and reports the compliant code as a violation. Absence assertions must
 * read code; presence assertions may read either.
 */
function codeOnly(text) {
    return text.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
}

// ---------------------------------------------------------------------------
// Behavioural — the exported pure helpers (require out/, skip if absent).
// ---------------------------------------------------------------------------

// Staleness is checked by mtime, NOT by "does the export exist". A stale out/
// requires cleanly and simply lacks the new helpers, which reports as
// "escapeSequenceEnd is not a function" — indistinguishable from a genuine
// regression that deleted the export. CI runs `npm run compile-tests` before this
// step, so out/ is never stale there and a missing export IS a real failure.
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

behavioural('escapeSequenceEnd: CSI, OSC, two-byte, intermediate, bare ESC, over-long', () => {
    const { escapeSequenceEnd, REPLAY_CSI_SCAN_MAX } = gatewayExport;
    assert.strictEqual(escapeSequenceEnd('\x1b[?2004h', 0), 8, 'CSI ?2004h ends at 8');
    assert.strictEqual(escapeSequenceEnd('\x1b[?2004', 0), -1, 'CSI with no final byte → -1');
    assert.ok(escapeSequenceEnd('\x1b]0;title\x07rest', 0) > 0, 'OSC ends past BEL');
    assert.ok(escapeSequenceEnd('\x1b]0;title\x1b\\rest', 0) > 0, 'OSC ends past ST');
    assert.strictEqual(escapeSequenceEnd('\x1bc', 0), 2, 'two-byte ESC c → 2');
    assert.strictEqual(escapeSequenceEnd('\x1b(B', 0), 3, 'intermediate + final → 3');
    assert.strictEqual(escapeSequenceEnd('\x1b', 0), -1, 'bare ESC → -1');
    // Over-long CSI param run → -1 (bail, do not guess).
    const longCsi = '\x1b[' + '0'.repeat(REPLAY_CSI_SCAN_MAX + 4) + 'h';
    assert.strictEqual(escapeSequenceEnd(longCsi, 0), -1, 'CSI param run over the ceiling → -1');
    // ESC inside a CSI aborts → -1.
    assert.strictEqual(escapeSequenceEnd('\x1b[?20\x1b[0m', 0), -1, 'ESC inside a CSI aborts → -1');
});

behavioural('unterminatedEscapeTail: plain, open, complete, no-ESC, over-long', () => {
    const { unterminatedEscapeTail, REPLAY_BOUNDARY_CARRY_MAX } = gatewayExport;
    assert.strictEqual(unterminatedEscapeTail('plain text'), '', 'plain text → no tail');
    assert.strictEqual(unterminatedEscapeTail('text ending \x1b[?20'), '\x1b[?20', 'open CSI tail preserved');
    assert.strictEqual(unterminatedEscapeTail('text \x1b[?2004h done'), '', 'complete sequence → no tail');
    assert.strictEqual(unterminatedEscapeTail('no escape here'), '', 'no ESC → no tail');
    // Over-long open sequence → give up (degrade to today's behaviour, do not guess).
    const overLong = '\x1b]' + 'x'.repeat(REPLAY_BOUNDARY_CARRY_MAX + 8);
    assert.strictEqual(unterminatedEscapeTail(overLong), '', 'open sequence over the ceiling → give up');
});

behavioural('replaySafeStart: no-carry never trims; carry resolves; unresolvable → 0', () => {
    const { replaySafeStart } = gatewayExport;
    // The load-bearing cases: plain output is NEVER trimmed. This is exactly what
    // the superseded heuristic got wrong (it dropped the first letter of "build ok").
    assert.strictEqual(replaySafeStart('', 'build ok'), 0, 'no carry → never trim');
    assert.strictEqual(replaySafeStart('', '1234 build ok'), 0, 'no carry → never trim, even with digits');
    // Carry that resolves to a terminator inside the head → exact offset past it.
    assert.strictEqual(replaySafeStart('\x1b[?20', '04h then real output'), 3, 'CSI tail resolved → 3 (past the h)');
    // OSC carry resolving via BEL in the head.
    assert.ok(replaySafeStart('\x1b]0;ti', 'tle\x07rest') > 0, 'OSC tail resolved past BEL');
    // Carry that cannot be resolved inside the bounds → 0 (under-trim, not over-trim).
    // A head of only CSI param bytes (0x30-0x3F) has no final byte, so the scanner
    // exits at the ceiling and returns -1 → no trim. (A head containing a letter
    // would terminate the CSI and trim past it — that is correct, not unresolvable.)
    assert.strictEqual(replaySafeStart('\x1b[?20', '1234567890'), 0, 'open CSI with no final byte in head → 0 (no trim)');
});

behavioural('the eviction composition: cut sequence → offset past it, clean boundary → 0', () => {
    // The exact expression the eviction loop evaluates, over the two chunks it has
    // in hand at that moment. Stands in for driving flushOutput through a stubbed
    // fleet service: headSafeStart has ONE writer and this is its whole input.
    const { replaySafeStart, unterminatedEscapeTail } = gatewayExport;
    const headSafeStart = (evicted, head) => replaySafeStart(unterminatedEscapeTail(evicted), head);

    // Eviction cuts a CSI in half — the new head begins with the orphaned tail.
    assert.strictEqual(headSafeStart('output\x1b[?20', '04h then more'), 3,
        'a cut sequence must yield the offset just past its final byte');
    // Eviction lands on a clean boundary — nothing to trim.
    assert.strictEqual(headSafeStart('output\x1b[?2004h', 'plain head'), 0,
        'a clean eviction boundary must leave headSafeStart at 0');
    assert.strictEqual(headSafeStart('no escapes at all', 'plain head'), 0,
        'an evicted chunk with no ESC must leave headSafeStart at 0');
    // Unresolvable remainder degrades to no trim, never to a guess.
    assert.strictEqual(headSafeStart('output\x1b[?20', '1234567890'), 0,
        'an unresolvable remainder must under-trim, never over-trim');
});

// ---------------------------------------------------------------------------
// Source-text — the wiring (assertions on the .ts and .js as text).
// ---------------------------------------------------------------------------

test('the trim is gated on the ring head, not on seq > 1', () => {
    const setup = block(gatewayTs, 'private setupClient(', 'private applyResize');
    assert.ok(setup.includes('missed.length === buffer.chunks.length'),
        'the trim must be gated on the payload starting at the RING HEAD (missed.length === buffer.chunks.length)');
    assert.ok(!/missed\[0\]\.seq\s*>\s*1/.test(setup),
        'a missed[0].seq > 1 gate would corrupt every contiguous reconnect — must be absent');
});

test('replayChars is assigned AFTER the slice', () => {
    const setup = block(gatewayTs, 'private setupClient(', 'private applyResize');
    const sliceIdx = setup.indexOf('combined.slice(');
    const assignIdx = setup.indexOf('replayChars = combined.length');
    assert.ok(sliceIdx !== -1 && assignIdx !== -1,
        'both the slice and the replayChars assignment must be present');
    assert.ok(sliceIdx < assignIdx,
        'replayChars must be assigned AFTER the trim, or the ack ledger drifts by the trimmed bytes');
});

test('replayGap uses the exact comparison and rides the hello frame conditionally', () => {
    const setup = block(gatewayTs, 'private setupClient(', 'private applyResize');
    assert.ok(/oldestRetained\s*>\s*lastSeq\s*\+\s*1/.test(setup),
        'the gap test must be the exact oldestRetained > lastSeq + 1');
    assert.ok(setup.includes('...(replayGap ? { replayGap: true } : {})'),
        'replayGap must be omitted when false, not sent as false — same convention as bracketedPaste/modes');
});

test('the gap log names both seqs and a frame count, not a byte count', () => {
    const setup = block(gatewayTs, 'private setupClient(', 'private applyResize');
    assert.ok(/console\.warn\([\s\S]*lastSeq=[\s\S]*oldest retained seq=/.test(setup),
        'the gap log must name the client lastSeq and the oldest retained seq');
    assert.ok(/frame\(s\) evicted/.test(setup),
        'the gap log must report a frame count — the evicted byte count is not knowable');
    assert.ok(!/byte count of the hole/.test(setup),
        'the gap log must not claim a byte count');
});

test('headSafeStart is computed at eviction and stored on the buffer', () => {
    assert.ok(gatewayTs.includes('headSafeStart: number;'),
        'ScrollbackBuffer must declare headSafeStart');
    assert.ok(/headSafeStart:\s*0,\s*nextSeq:\s*1/.test(gatewayTs),
        'trackTerminalData must initialise headSafeStart to 0');
    const flush = block(gatewayTs, 'while (buffer.totalBytes > MAX_SCROLLBACK_BYTES', '}\n        }\n');
    assert.ok(flush.includes('buffer.headSafeStart = replaySafeStart('),
        'the eviction loop must compute headSafeStart from the discarded chunk');
});

test('the client resets in-band on the hello arm, before the replay', () => {
    const hello = block(terminalsJs, "frame.t === 'hello'", "frame.t === 'inputThrottled'");
    assert.ok(hello.includes("entry.term.write('\\x1bc')"),
        'the hello arm must write RIS (\\x1bc) through the write queue');
    assert.ok(!/term\.reset\(\)/.test(codeOnly(hello)),
        'term.reset() does not reset the parser — it must not be used on the gap path');
    assert.ok(hello.includes('entry.batchQueue = []'),
        'the stale batch must be dropped, not flushed, so it cannot be parsed after RIS');
    assert.ok(hello.includes('markReplayGap(entry.name)'),
        'markReplayGap must be called on the gap branch');
    // The RIS write must carry no write callback — billing it to pendingAckChars
    // would corrupt the backpressure ledger.
    const risCall = hello.match(/entry\.term\.write\('\\x1bc'\)[^;]*;?/);
    assert.ok(risCall, 'the RIS write call must be present');
    assert.ok(!/write\('\\x1bc',\s*\(\)/.test(hello),
        'the RIS write must have no write callback — synthetic writes are not billed');
});

test('the gap flag is per-socket and cleared in the connectWs teardown', () => {
    const teardown = block(terminalsJs, 'function connectTerminalSocket(', 'let wsUrl =');
    assert.ok(teardown.includes('entry.replayGap = false'),
        'a gap flag left armed by a dead socket must be cleared alongside awaitingReplayFrame');
    assert.ok(teardown.includes('entry.awaitingReplayFrame = false'),
        'the existing awaitingReplayFrame clear must still be present');
});

test('gap state is NOT in terminalBadges', () => {
    const mark = block(terminalsJs, 'function markReplayGap(', 'function renderPaneGrid()');
    assert.ok(mark.includes('terminalReplayGaps'),
        'markReplayGap must touch terminalReplayGaps, not terminalBadges');
    assert.ok(!mark.includes('terminalBadges'),
        'markReplayGap must not write into terminalBadges — that map feeds the shell rail done light');
    assert.ok(terminalsJs.includes('const terminalReplayGaps = new Set();'),
        'terminalReplayGaps must be a separate Set');
});

test('postFleetStateToShell still derives its done light from terminalBadges only', () => {
    const post = block(terminalsJs, 'function postFleetStateToShell(', 'const LAYOUTS = {');
    assert.ok(post.includes('terminalBadges'),
        'postFleetStateToShell must still read terminalBadges');
    assert.ok(!/terminalReplayGaps/.test(post),
        'postFleetStateToShell must NOT read terminalReplayGaps — a gap must not light the shell rail as done');
});

test('every terminalBadges clear site has a terminalReplayGaps counterpart', () => {
    // Derive the site list by regex, then assert a matching terminalReplayGaps
    // call within a small window of each. Modelled on the rename-rekey contract's
    // derived-collection assertion — a new clear site without a gap counterpart
    // would strand a GAP badge forever.
    const deleteSites = [];
    const re = /terminalBadges\.(delete\(([a-zA-Z_.]+)\)|clear\(\))/g;
    let m;
    while ((m = re.exec(terminalsJs)) !== null) {
        deleteSites.push({ idx: m.index, arg: m[2] || null, isClear: m[1] === 'clear()' });
    }
    assert.ok(deleteSites.length >= 6, `expected at least 6 terminalBadges clear sites, found ${deleteSites.length}`);
    for (const site of deleteSites) {
        const window = terminalsJs.substring(site.idx, site.idx + 400);
        if (site.isClear) {
            assert.ok(window.includes('terminalReplayGaps.clear()'),
                'a terminalBadges.clear() site must have a terminalReplayGaps.clear() counterpart nearby');
        } else {
            // The rename site rekeys (delete + add) rather than a plain delete.
            assert.ok(window.includes('terminalReplayGaps'),
                `a terminalBadges.delete(${site.arg}) site must have a terminalReplayGaps counterpart nearby`);
        }
    }
});

test('the badge does not reuse the success colour', () => {
    const rule = block(terminalsHtml, '.pane-badge.is-gap {', '}');
    assert.ok(rule.includes('--state-connecting'),
        '.pane-badge.is-gap must use --state-connecting (amber), not --accent-teal (success)');
    assert.ok(!/--accent-teal/.test(rule),
        'a gap badge in the success accent would read as DONE — must not reuse --accent-teal');
});

test('the gap badge renders at both the sidebar and the pane header', () => {
    assert.ok(terminalsJs.includes("gapBadge.className = 'pane-badge is-gap'"),
        'the GAP badge element must be created with the is-gap class');
    // Sidebar site uses item.friendlyName; pane header uses assignedName.
    assert.ok(/terminalReplayGaps\.has\(item\.friendlyName\)/.test(terminalsJs),
        'the sidebar must render the GAP badge');
    assert.ok(/terminalReplayGaps\.has\(assignedName\)/.test(terminalsJs),
        'the pane header must render the GAP badge');
});

test('replayGapped is exposed on the diagnosis surface', () => {
    assert.ok(/replayGapped:\s*terminalReplayGaps\.has\(name\)/.test(terminalsJs),
        'window.__sbTerminalStats must report replayGapped so a gap is diagnosable afterwards');
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) { process.exit(1); }
