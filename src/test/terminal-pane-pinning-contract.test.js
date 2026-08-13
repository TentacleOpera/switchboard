'use strict';

/**
 * Contract tests for terminal pane pinning.
 *
 * Source-text contracts, not behavioural ones: the cockpit is browser-only DOM
 * code in an IIFE with no export surface, and every failure mode here is a
 * seating / persistence / soft-lock defect a headless run cannot observe. What
 * CAN be pinned is the handful of decisions that are invisible on inspection and
 * were each wrong in a first pass — modelled on shell-terminal-strip.test.js
 * (same `block(code, startMarker, endMarker)` helper, same `test(name, fn)`
 * harness, same reason: re-implementing the logic locally would let the test
 * pass for any change to the product code). Reads ../webview/terminals.js and
 * ../webview/terminals.html from disk — never re-implements the logic locally.
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
    assert.ok(end !== -1, `end marker not found after "${startMarker}": ${endMarker}`);
    return code.substring(start, end);
}

// --------------------------------------------------------------- pin state + persistence

test('pinnedPanes is declared beside paneAssignments and persisted', () => {
    assert.ok(
        /let pinnedPanes = \[\];/.test(terminalsJs),
        'pinnedPanes must be declared as an array beside paneAssignments'
    );
    const loadFn = block(terminalsJs, 'async function loadLayoutSettings() {', 'function saveLayoutSettings() {');
    assert.ok(
        /loadSetting\('terminals\.pinnedPanes', \[\]\)/.test(loadFn),
        "loadLayoutSettings must read 'terminals.pinnedPanes' with an array default"
    );
    assert.ok(
        /Array\.isArray\(savedPins\)[\s\S]*pinnedPanes = savedPins\.map\(Boolean\)/.test(loadFn),
        'loadLayoutSettings must guard with Array.isArray and coerce via .map(Boolean)'
    );
    const saveFn = block(terminalsJs, 'function saveLayoutSettings() {', 'async function fetchTerminalList() {');
    assert.ok(
        saveFn.includes("saveSetting('terminals.pinnedPanes', pinnedPanes)"),
        "saveLayoutSettings must persist 'terminals.pinnedPanes'"
    );
});

// --------------------------------------------------------------- sanitize: pin expiry

test('sanitizePaneAssignments normalises pinnedPanes length and clears pins on empty slots', () => {
    const fn = block(terminalsJs, 'function sanitizePaneAssignments() {', 'function renderTerminalRow(');
    // Length normalisation.
    assert.ok(
        /while \(pinnedPanes\.length < maxSlots\) \{ pinnedPanes\.push\(false\); \}/.test(fn),
        'pinnedPanes must be padded to maxSlots with false'
    );
    assert.ok(
        /if \(pinnedPanes\.length > maxSlots\) \{ pinnedPanes\.length = maxSlots; \}/.test(fn),
        'pinnedPanes must be truncated to maxSlots'
    );
    // Unconditional empty-slot pin clear — keyed off !paneAssignments[i], NOT liveNames.
    assert.ok(
        /for \(let i = 0; i < pinnedPanes\.length; i\+\+\) \{[\s\S]*if \(pinnedPanes\[i\] && !paneAssignments\[i\]\) \{ pinnedPanes\[i\] = false; \}/.test(fn),
        'sanitize must clear a pin whose slot is empty, keyed off the slot — not the dead-name drop loop'
    );
});

test('closeTerminal does not reference pinnedPanes — the pin clear is centralised in sanitize', () => {
    const fn = block(terminalsJs, 'async function closeTerminal(name) {', 'async function clearTerminal(name) {');
    assert.ok(
        !fn.includes('pinnedPanes'),
        'closeTerminal must not touch pinnedPanes — the empty-slot rule in sanitize covers it (closeTerminal nulls before the refresh)'
    );
});

// --------------------------------------------------------------- placement: pin-aware

test('assignToFocusedPane consults pins before focus, and pins are inert in a one-pane grid', () => {
    const fn = block(terminalsJs, 'function assignToFocusedPane(terminalName, opts = {}) {', 'function undoLastAssignment() {');
    // The pinsActive guard (rendered > 1) must exist and gate isOpen.
    assert.ok(
        /const pinsActive = rendered > 1;/.test(fn),
        'pinsActive must be gated on rendered > 1 — a one-pane grid has no other seat to protect'
    );
    assert.ok(
        /const isOpen = \(i\) => i < rendered && \(!pinsActive \|\| !pinnedPanes\[i\]\);/.test(fn),
        'isOpen must consult pinnedPanes only when pinsActive'
    );
    // isOpen must appear BEFORE the seating write (paneAssignments[target] = terminalName).
    const isOpenAt = fn.indexOf('const isOpen = ');
    const seatAt = fn.indexOf('paneAssignments[target] = terminalName');
    assert.ok(isOpenAt !== -1 && seatAt !== -1, 'both isOpen and the seating write must exist');
    assert.ok(isOpenAt < seatAt, 'pin filtering (isOpen) must run before the seating write');
});

test('the all-pinned branch emits a toast and returns without seating', () => {
    const fn = block(terminalsJs, 'function assignToFocusedPane(terminalName, opts = {}) {', 'function undoLastAssignment() {');
    const toastAt = fn.indexOf("showPaneToast('All panes are pinned");
    const seatAt = fn.indexOf('paneAssignments[target] = terminalName');
    assert.ok(toastAt !== -1, 'the all-pinned branch must emit the toast');
    assert.ok(toastAt < seatAt, 'the all-pinned toast must precede the seating write (it returns before reaching it)');
    // The toast must pass null onUndo so the Undo button is hidden.
    assert.ok(
        /showPaneToast\('All panes are pinned — unpin one to switch\.', null\)/.test(fn),
        'the all-pinned toast must pass null onUndo so showPaneToast hides the Undo button'
    );
});

test('the already-seated follow-branch returns before any pin logic mutates a slot', () => {
    const fn = block(terminalsJs, 'function assignToFocusedPane(terminalName, opts = {}) {', 'function undoLastAssignment() {');
    const followAt = fn.indexOf('if (existingIndex !== -1 && existingIndex < rendered) {');
    const pinsActiveAt = fn.indexOf('const pinsActive = rendered > 1;');
    assert.ok(followAt !== -1, 'the follow-branch must exist');
    assert.ok(pinsActiveAt !== -1, 'the pinsActive guard must exist');
    assert.ok(
        followAt < pinsActiveAt,
        'the follow-branch must sit ABOVE the pin logic — a seated terminal is followed, never relocated to satisfy a click'
    );
    // The follow-branch must NOT be nested inside an `if (paneAssignments[target])` conditional.
    // It is a top-level early return.
    const followBlock = block(fn, 'if (existingIndex !== -1 && existingIndex < rendered) {', 'const pinsActive = rendered > 1;');
    assert.ok(
        followBlock.includes('return;'),
        'the follow-branch must return (early-exit), not fall through to the pin logic'
    );
});

test('vacating a parked slot vacates its pin — no pin left on an emptied slot', () => {
    // The only reachable path to `paneAssignments[existingIndex] = null` is a
    // terminal parked in a NON-rendered slot (the follow-branch returns for every
    // rendered one). If that slot was pinned — pin in 3x3, shrink to 2h — the pin
    // outlives its occupant on a slot that renders no marker, and saveLayoutSettings
    // persists it. sanitize would heal it, but only on the next list refresh.
    const fn = block(terminalsJs, 'function assignToFocusedPane(terminalName, opts = {}) {', 'function undoLastAssignment() {');
    assert.ok(
        /paneAssignments\[existingIndex\] = null;[\s\S]{0,120}?pinnedPanes\[existingIndex\] = false;/.test(fn),
        'clearing the old slot must clear its pin too — an empty pinned slot reserves a seat nothing can fill'
    );
});

// --------------------------------------------------------------- undo coherence

test('undoLastAssignment restores pins', () => {
    const fn = block(terminalsJs, 'function undoLastAssignment() {', 'function focusPaneTerminal(');
    assert.ok(
        /if \(Array\.isArray\(undoSnapshot\.pins\)\) \{ pinnedPanes = undoSnapshot\.pins; \}/.test(fn),
        'undoLastAssignment must restore pinnedPanes from undoSnapshot.pins (Array.isArray-guarded)'
    );
});

test('every undoSnapshot literal in the file carries a pins key', () => {
    // Count-independent: a future site cannot slip through. Matches `undoSnapshot = {`
    // literals and asserts each carries `pins:`.
    const re = /undoSnapshot = \{/g;
    let m;
    let count = 0;
    while ((m = re.exec(terminalsJs)) !== null) {
        count++;
        // Grab the literal up to the matching closing brace (single-level — these
        // literals do not nest objects).
        const start = m.index;
        const end = terminalsJs.indexOf('};', start);
        assert.ok(end !== -1, `undoSnapshot literal #${count} has no closing '};'`);
        const literal = terminalsJs.substring(start, end);
        assert.ok(
            /pins:/.test(literal),
            `undoSnapshot literal #${count} must carry a pins: key — site at offset ${start}`
        );
    }
    assert.ok(count >= 1, `expected at least 1 undoSnapshot literal (unassign handler; navigation undo removed), found ${count}`);
});

// --------------------------------------------------------------- hide handler clears pin

test('the hide (unassign) handler clears the pin alongside the slot', () => {
    // The hide handler is the unassignBtn click listener in createPaneElement.
    const fn = block(terminalsJs, 'function createPaneElement(index) {', 'function isTerseLayout() {');
    const handler = block(fn, "unassignBtn.addEventListener('click', (e) => {", 'actionsEl.appendChild(pinBtn);');
    assert.ok(
        handler.includes('pinnedPanes[index] = false'),
        'the hide handler must clear pinnedPanes[index] — an empty pinned seat reserves a slot nothing can fill'
    );
    assert.ok(
        /undoSnapshot = \{ slots: paneAssignments\.slice\(\), pins: pinnedPanes\.slice\(\)/.test(handler),
        'the hide handler must snapshot pins so Undo can restore them'
    );
});

// --------------------------------------------------------------- rename leaves pins alone

test('renameTerminal does not reference pinnedPanes — pins are index-keyed by design', () => {
    const fn = block(terminalsJs, 'async function renameTerminal(name, alias) {', 'function beginInlineRename(');
    assert.ok(
        !fn.includes('pinnedPanes'),
        'renameTerminal must not touch pinnedPanes — a rename does not move a slot, and pins are index-keyed'
    );
});

// --------------------------------------------------------------- pin toggle render

test('the pin toggle is gated on slotCount > 1 and uses text labels, not an emoji glyph', () => {
    const fn = block(terminalsJs, 'function updatePaneElement(paneEl, index) {', 'function resolveFlooredLayout() {');
    assert.ok(
        /const pinActive = slotCount > 1;/.test(fn),
        'the pin toggle visibility must be gated on slotCount > 1'
    );
    // Text labels, not emoji — and the FULL words at every layout. The old
    // `terse ? (isPinned ? 'u' : 'p')` form keyed off the layout name (2x3/3x3)
    // rather than measured header width, so `p`/`u` appeared on wide monitors where
    // the words fit; .pane-actions is flex-shrink: 0 and the title ellipsizes first.
    assert.ok(
        /pinBtn\.textContent = isPinned \? 'unpin' : 'pin';/.test(fn),
        'the pin toggle must use full text labels (pin/unpin) — not an emoji glyph, and not layout-name-keyed p/u initials'
    );
    assert.ok(
        /pinBtn\.setAttribute\('aria-pressed', isPinned \? 'true' : 'false'\)/.test(fn),
        'the pin toggle must reflect state in aria-pressed'
    );
});

// --------------------------------------------------------------- HTML: pinned styling

test('.terminal-pane.pinned uses box-shadow, not border, and a .pinned.focused rule exists', () => {
    // The geometry/refit regression guard: a border would shrink the content box
    // by 2px and fire the per-terminal ResizeObserver.
    const pinnedRule = terminalsHtml.match(/\.terminal-pane\.pinned\s*\{([^}]*)\}/);
    assert.ok(pinnedRule, '.terminal-pane.pinned rule is missing');
    assert.ok(
        /box-shadow:\s*inset 3px 0 0 var\(--accent-teal\)/.test(pinnedRule[1]),
        '.terminal-pane.pinned must use box-shadow (inset), never border — a border fires the ResizeObserver refit'
    );
    assert.ok(
        !/border-left:/.test(pinnedRule[1]),
        '.terminal-pane.pinned must NOT use border-left — that shrinks the content box'
    );
    // A single box-shadow property does not merge across two class rules; the
    // pinned-and-focused pane needs its own rule or it loses the focus ring.
    const pinnedFocused = terminalsHtml.match(/\.terminal-pane\.pinned\.focused\s*\{([^}]*)\}/);
    assert.ok(pinnedFocused, '.terminal-pane.pinned.focused rule is missing — without it the pinned+focused pane loses one of the two shadows');
    assert.ok(
        /box-shadow:/.test(pinnedFocused[1]),
        '.terminal-pane.pinned.focused must declare its own box-shadow (the two class rules do not merge)'
    );
});

test('the pinned chip and pinned button have distinct styling rules', () => {
    assert.ok(
        /\.pane-index-chip\.is-pinned\s*\{/.test(terminalsHtml),
        '.pane-index-chip.is-pinned rule is missing'
    );
    assert.ok(
        /\.btn-pin-pane\.is-pinned\s*\{/.test(terminalsHtml),
        '.btn-pin-pane.is-pinned rule is missing'
    );
});

// --------------------------------------------------------------- toast Undo hide

test('showPaneToast hides the Undo button when onUndo is null', () => {
    const fn = block(terminalsJs, 'function showPaneToast(text, onUndo) {', 'function hidePaneToast() {');
    assert.ok(
        /toastUndoBtn\.style\.display = onUndo \? '' : 'none';/.test(fn),
        'showPaneToast must hide the Undo button (display:none) when onUndo is null — the all-pinned toast has no undo'
    );
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
