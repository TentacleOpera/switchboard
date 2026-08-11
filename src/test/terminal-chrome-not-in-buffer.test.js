'use strict';

/**
 * Source-text contract for browser-terminal CHROME NOT IN BUFFER.
 *
 * The terminal screen buffer must contain exactly what the pty produced, in
 * order, with nothing spliced in. Four client-side notices (input queue
 * drained, pasting, terminal unavailable, disconnected-reconnecting) used to be
 * written straight into xterm's buffer, permanently desynchronising any
 * Ink-based TUI's relative-cursor redraw. This file pins their absence and the
 * chrome that replaced them, so a future edit cannot quietly reintroduce a
 * buffer write under any of the names this plan removed.
 *
 * Every failure mode here is silent by construction: a notice written into the
 * buffer is content, not a paint artifact, so it survives scrolling and is
 * invisible to every other client attached to the same pty.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

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

// ---- 1. No bracketed notices are written to the buffer ----

test('no bracketed connection/throttle notices are written into the buffer', () => {
    // The shape of the old bug: a \r\n-led line carrying a [bracketed] notice,
    // written via entry.term.write. The four removed sites all matched this.
    // The process-exit line is the ONE allowed survivor — it is written to a
    // terminal whose process is gone, so no TUI will ever redraw over it.
    const writes = terminalsJs.match(/entry\.term\.write\(`[^`]*`[^)]*\)/g) || [];
    const bracketed = writes.filter(w => /\\r\\n.*\\x1b\[\d*m.*\[.*\]/.test(w));
    assert.ok(bracketed.length === 1,
        `expected exactly one bracketed buffer write (the exit line), found ${bracketed.length}: ${bracketed.join(' | ')}`);
    assert.ok(/Process Exited with code/.test(bracketed[0]),
        'the one surviving bracketed write must be the process-exit line');
    assert.ok(!/Input queue drained|Pasting|Disconnected — reconnecting|Terminal unavailable/.test(bracketed[0]),
        'none of the four removed notices may survive in the buffer');
});

test('the only bracketed buffer write that remains is the process-exit line', () => {
    // The exit line is deliberately kept: the process is gone, so no TUI will
    // ever redraw over it, and it is the only record of the exit code.
    const exitArm = block(terminalsJs, "frame.t === 'exit'", "} catch (err) {");
    const writes = exitArm.match(/entry\.term\.write\(`[^`]*`[^)]*\)/g) || [];
    assert.ok(writes.length === 1, `exactly one write expected in the exit arm, found ${writes.length}`);
    assert.ok(/Process Exited with code/.test(writes[0]),
        'the surviving write must be the process-exit line');
    assert.ok(!/Disconnected — reconnecting/.test(exitArm),
        'the [Disconnected — reconnecting…] notice must be gone from the exit arm');
});

test('no new entry.term.write site appears beyond the known set', () => {
    // A future notice written through a variable or assembled above the call
    // would bypass the shape check above. Pin the call-site COUNT so any new
    // write site fails this test regardless of its argument shape.
    //
    // Known sites: (1) DEC-mode seq reassertion, (2) the gap-path RIS reset,
    // (3) the process-exit line, (4) the batch flush, (5) the replay write.
    //
    // The RIS write (\x1bc, on the hello arm) is the sibling replay-gap change,
    // not a notice: it carries no text, resets the parser rather than printing
    // into the screen, and fires only when the gateway reports evicted output.
    // It is pinned by terminal-replay-gap-contract.test.js.
    const count = (terminalsJs.match(/entry\.term\.write\(/g) || []).length;
    assert.ok(count === 5,
        `expected exactly 5 entry.term.write( call sites (DEC seq, gap RIS, exit line, batch flush, replay write), found ${count} — a new buffer write site is a regression`);
});

// ---- 2. Every is-input-* removal site clears every key the resolver returns ----

test('resolveInputState returns the queued key for throttled input', () => {
    const resolver = block(terminalsJs, 'function resolveInputState(', 'function refreshInputState(');
    assert.ok(/key:\s*'queued'/.test(resolver),
        "the resolver must return a 'queued' key for throttled-but-open input");
    assert.ok(/inputThrottled/.test(resolver),
        "the queued branch must read entry.inputThrottled");
});

test('every is-input-* removal site clears the full resolver key set', () => {
    // Derive the keys resolveInputState can return, then assert EVERY
    // classList.remove('is-input-…') site covers them. Hardcoding "check
    // refreshInputState" is what let sites 2 and 3 go unnoticed originally.
    const resolver = block(terminalsJs, 'function resolveInputState(', 'function refreshInputState(');
    const keys = new Set();
    const keyRe = /key:\s*'([a-z]+)'/g;
    let m;
    while ((m = keyRe.exec(resolver)) !== null) { keys.add(m[1]); }
    assert.ok(keys.has('queued'), "derived key set must include queued");

    const removals = terminalsJs.match(/classList\.remove\('is-input-live'[^)]*\)/g) || [];
    assert.ok(removals.length >= 3,
        `expected at least 3 is-input-* removal sites (refreshInputState, updatePaneElement, renderKanbanPane), found ${removals.length}`);
    for (const r of removals) {
        for (const key of keys) {
            assert.ok(r.includes(`'is-input-${key}'`),
                `a removal site does not clear is-input-${key}: ${r}`);
        }
    }
});

// ---- 3. The throttle flag is cleared on both socket transitions ----

test('inputThrottled is reset in ws.onopen and ws.onclose', () => {
    const onopen = block(terminalsJs, 'ws.onopen = () => {', 'ws.onmessage = ');
    assert.ok(/entry\.inputThrottled\s*=\s*false/.test(onopen),
        'ws.onopen must clear inputThrottled so a stranded flag cannot outlive a dead socket');
    const oncloseBody = block(terminalsJs, 'ws.onclose = () => {', 'function scheduleBatchFlush(');
    assert.ok(/entry\.inputThrottled\s*=\s*false/.test(oncloseBody),
        'ws.onclose must clear inputThrottled — the throttled:false frame for a dead socket never arrives');
});

// ---- 4. live still renders no chip ----

test('the live state still renders no chip', () => {
    const sync = block(terminalsJs, 'function syncInputStateChip(', 'function notifyInputDropped(');
    assert.ok(/state\.key === 'live'/.test(sync) && /chip\.remove\(\)/.test(sync),
        'the live state must render no chip and must remove one left by a previous state');
});

// ---- 5. The error arm sets disableStdin before it notifies ----

test('the error arm sets disableStdin before it notifies, and the toast helper exists', () => {
    const errorArm = block(terminalsJs, "frame.t === 'error'", "frame.t === 'exit'");
    const disableIdx = errorArm.indexOf('disableStdin = true');
    const refreshIdx = errorArm.indexOf('refreshInputState(entry.name)');
    const toastIdx = errorArm.indexOf('showTerminalErrorToast(');
    assert.ok(disableIdx !== -1 && refreshIdx !== -1 && toastIdx !== -1,
        'the error arm must set disableStdin, refresh state, and show the toast');
    assert.ok(disableIdx < refreshIdx && refreshIdx < toastIdx,
        'ordering must be: disableStdin → refreshInputState → showTerminalErrorToast, so a toast throw cannot strand a dead terminal accepting input');
    assert.ok(terminalsJs.includes('function showTerminalErrorToast('),
        'showTerminalErrorToast must be defined — an undefined helper throws inside the onmessage try and is swallowed by the catch, silently skipping the state mutations');
    assert.ok(/bodyEl\.textContent\s*=\s*message/.test(terminalsJs),
        'the toast body must use textContent, never innerHTML — frame.message comes off the wire');
});

test('the inputThrottled arm writes nothing to the buffer', () => {
    const arm = block(terminalsJs, "frame.t === 'inputThrottled'", "frame.t === 'error'");
    assert.ok(!/entry\.term\.write/.test(arm),
        'the inputThrottled arm must not write to the buffer — the chip is the whole signal');
    assert.ok(/entry\.inputThrottled\s*=/.test(arm) && /refreshInputState\(entry\.name\)/.test(arm),
        'the arm must record the throttle state and refresh the chip instead of writing');
});

test('the queued chip has a CSS rule and the error toast has a modifier', () => {
    assert.ok(terminalsHtml.includes('.is-input-queued .pane-input-state'),
        'the queued chip must be styled');
    assert.ok(terminalsHtml.includes('.completion-toast.is-error'),
        'the error toast modifier must exist');
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) { process.exit(1); }
