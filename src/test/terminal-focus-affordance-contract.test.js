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

test('the focus ring is driven by real caret focus, not by pane selection', () => {
    // term.textarea, NOT term.onFocus/onBlur. Those emitters exist only on the
    // internal CoreTerminal subclass in the vendored bundle — the public Terminal
    // this file constructs has no focus pair, so subscribing to them threw from the
    // middle of the view builder and took the WebSocket with it. The helper textarea
    // is the node that actually holds the caret.
    assert.ok(/term\.textarea\.addEventListener\('focus'/.test(terminalsJs),
        'the ring must be driven by focus on the node that actually holds the caret');
    assert.ok(/term\.textarea\.addEventListener\('blur'/.test(terminalsJs),
        'blur on that same node must clear it');
    assert.ok(terminalsHtml.includes('.terminal-pane.has-caret'),
        '.has-caret is the real typing signal — .focused is selection and survives blur');
});

test('blur clears EVERY pane, not the one that blurred', () => {
    assert.ok(terminalsJs.includes('function clearCaretRing()'),
        'a sweep is the only form correct in every case — Chromium fires no blur on detach');
    assert.ok(/addEventListener\('blur',\s*\(\)\s*=>\s*clearCaretRing\(\)\)/.test(terminalsJs),
        'blur must go through clearCaretRing, not a single-pane classList.remove');
});

test('renderPaneGrid sweeps a ring stranded by a detached container', () => {
    // Panes are reconciled IN PLACE, so a class stranded by a removed/reparented
    // container survives on a LIVE element. Chromium fires no blur on detach and
    // the focus reclaim early-returns when the focused slot is the one that
    // emptied, so onFocus/onBlur alone cannot cover it.
    const fn = block(terminalsJs, 'function renderPaneGrid() {', 'function createPaneElement(');
    assert.ok(/if \(!paneGridEl\.contains\(document\.activeElement\)\) \{\s*clearCaretRing\(\);/.test(fn),
        'renderPaneGrid must sweep the caret ring when the caret is not inside the grid');
    assert.ok(fn.indexOf('focusPaneTerminal(focusedPaneIndex)') < fn.lastIndexOf('clearCaretRing()'),
        'the sweep must run AFTER the focus reclaim, or it wipes the ring the reclaim just set');
});

test('selection never claims the accent, not even on a pinned pane', () => {
    // .focused was demoted to a neutral border precisely because selection is not
    // keyboard focus. .pinned.focused needs its own box-shadow (the property does
    // not merge across class rules) and is the one place the teal ring can sneak
    // back in.
    const pinnedFocused = terminalsHtml.match(/\.terminal-pane\.pinned\.focused\s*\{([^}]*)\}/);
    assert.ok(pinnedFocused, '.terminal-pane.pinned.focused rule is missing');
    assert.ok(!/inset 0 0 0 1px var\(--accent-teal\)/.test(pinnedFocused[1]),
        'the selection component of .pinned.focused must not be the accent — that is the ring .focused was demoted for');
    const focused = terminalsHtml.match(/\.terminal-pane\.focused\s*\{([^}]*)\}/);
    assert.ok(focused && !/var\(--accent-teal\)/.test(focused[1]),
        '.terminal-pane.focused must not use the accent — selection survives the document losing focus');
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

test('the live state renders no chip, and one writer creates AND removes it', () => {
    const sync = block(terminalsJs, 'function syncInputStateChip(', 'function notifyInputDropped(');
    // The whole point of the trim: a badge on every healthy pane reports the
    // normal case. Only the two states an operator must act on get drawn.
    assert.ok(/state\.key === 'live'/.test(sync) && /chip\.remove\(\)/.test(sync),
        'the live state must render no chip and must remove one left by a previous state');
    // The conditional element is why the old early-return-on-missing is a bug now:
    // refreshInputState is handed a live pane with no chip to repaint on every
    // connecting → live, and a chipless pane on every live → connecting.
    assert.ok(/createElement\('span'\)/.test(sync) && /appendChild\(chip\)/.test(sync),
        'the same writer must create the chip — a disconnect arrives at a pane that has none');
    const refresh = block(terminalsJs, 'function refreshInputState(name)', 'function syncInputStateChip(');
    assert.ok(refresh.includes('syncInputStateChip('),
        'the out-of-band refresh must go through the one writer, not repaint inline');
    assert.ok(!/querySelector\('\.pane-input-state'\)[\s\S]*if \(!chip\) \{ return; \}/.test(refresh),
        'refreshInputState must not early-return on a missing chip — that skips every disconnect');
    const render = block(terminalsJs, 'function updatePaneElement(', 'function resolveFlooredLayout()');
    assert.ok(render.includes('syncInputStateChip(') && !/className = 'pane-input-state'/.test(render),
        'the render path must delegate too — two chip builders would drift on the live case');
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
