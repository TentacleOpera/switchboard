'use strict';

/**
 * Source-text contract for the browser terminal INPUT AFFORDANCE.
 *
 * Every failure mode here is silent by construction: a focus ring driven off the
 * wrong state still renders, a dropped keystroke throws nothing, a chip derived
 * from a cached value looks correct until the socket moves, and an inactive
 * cursor style that reverts to xterm's default is invisible in review. Pin them.
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

test('the focus ring is driven by xterm focus, not by pane selection', () => {
    assert.ok(terminalsJs.includes('term.onFocus('), 'xterm onFocus must drive the ring');
    assert.ok(terminalsJs.includes('term.onBlur('), 'xterm onBlur must clear it');
    assert.ok(terminalsHtml.includes('.terminal-pane.has-caret'),
        '.has-caret is the real typing signal — .focused is selection and survives blur');
});

test('blur clears EVERY pane, not the one that blurred', () => {
    assert.ok(terminalsJs.includes('function clearCaretRing()'),
        'a sweep is the only form correct in every case — Chromium fires no blur on detach');
    assert.ok(/onBlur\(\(\)\s*=>\s*clearCaretRing\(\)\)/.test(terminalsJs),
        'onBlur must go through clearCaretRing, not a single-pane classList.remove');
});

test('the ring uses outline, not box-shadow', () => {
    const ring = block(terminalsHtml, '.terminal-pane.has-caret {', '}');
    assert.ok(ring.includes('outline:'),
        'box-shadow is already claimed by .focused and by .pinned; one property, one winner');
    assert.ok(!ring.includes('box-shadow'),
        'a third box-shadow claimant silently erases the pin stripe on a pinned focused pane');
});

test('the ring recolours for states that cannot take input', () => {
    assert.ok(terminalsHtml.includes('.terminal-pane.has-caret.is-input-readonly'),
        'a teal "type here" ring on a disableStdin terminal is the exact lie .focused was demoted for');
    assert.ok(terminalsHtml.includes('.terminal-pane.has-caret.is-input-connecting'),
        'same for a socket that is not open yet');
});

test('the inactive cursor style is none, so exactly one pane shows a caret', () => {
    assert.ok(/cursorInactiveStyle:\s*'none'/.test(terminalsJs),
        "'outline' is xterm 5.5.0's own default — setting it changes nothing");
});

test('keystrokes on a non-OPEN socket are reported, not swallowed', () => {
    assert.ok(terminalsJs.includes('notifyInputDropped(entry)'),
        'the else branch of term.onData must surface the drop');
    assert.ok(!terminalsJs.includes('entry.inputQueue'),
        'input must NOT be queued — replaying stale keystrokes can complete a half-typed command');
    assert.ok(terminalsJs.includes('entry.inputDropNoticed = false'),
        'the notice must reset on reconnect, or the second outage is silent');
});

test('the input-state chip is derived, never cached', () => {
    assert.ok(terminalsJs.includes('function resolveInputState('), 'resolver must exist');
    const resolver = block(terminalsJs, 'function resolveInputState(', 'function refreshInputState(');
    assert.ok(resolver.includes('entry.exited') && resolver.includes('disableStdin'),
        'read-only must cover BOTH the exit frame and the error frame');
    assert.ok(resolver.includes('fleetList'),
        'the title prints "(exited)" from fleetList — a chip that ignores it contradicts the title beside it');
    assert.ok(resolver.indexOf('entry.exited') < resolver.indexOf('WebSocket.OPEN'),
        'a dead terminal on an OPEN socket is read-only — order is load-bearing');
});

test('the CONNECTING window has a nudge site', () => {
    const connect = block(terminalsJs, 'function connectTerminalSocket(', 'function scheduleBatchFlush(');
    assert.ok(connect.includes('refreshInputState('),
        'a reconnect swaps in a CONNECTING socket without re-rendering the grid');
});

test('state colours are tokens, so one edit changes one place', () => {
    assert.ok(/--state-connecting:/.test(terminalsHtml) && /--state-readonly:/.test(terminalsHtml),
        'status colours must be :root tokens, not literals repeated as hex + rgba twins');
    assert.ok(!/\.is-input-live \.pane-input-state\s*\{[^}]*#00e5ff/.test(terminalsHtml),
        'the live state must use var(--accent-teal), not the literal cyan');
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) { process.exit(1); }
