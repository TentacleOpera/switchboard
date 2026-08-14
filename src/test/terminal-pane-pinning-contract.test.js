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

// ------------------------------------------------------- pane header brand icon

/** terminals.html with CSS comments stripped — several rules NAME a selector while
 *  explaining why never to write it, so a bare text search false-positives. */
const htmlNoComments = terminalsHtml.replace(/\/\*[\s\S]*?\*\//g, '');

test('the pane header carries its own brand-icon rule, not the sidebar class', () => {
    assert.ok(/\.pane-brand-icon\s*\{/.test(htmlNoComments),
        '.pane-brand-icon rule is missing — the pane header is the one terminal-identifying '
        + 'surface with no brand mark without it');
    assert.ok(/\.pane-brand-icon\.is-exited\s*\{/.test(htmlNoComments),
        'the exited variant must be a class on the IMAGE');
});

test('no .terminal-pane.is-exited selector — that class only ever lands on a sidebar row', () => {
    // is-exited is applied to .terminal-item in renderTerminalRow; .terminal-pane never
    // receives it, so any rule keyed on it is dead CSS that a manual check would appear
    // to "pass" because the icon dims for an unrelated reason.
    assert.ok(!/\.terminal-pane\.is-exited/.test(htmlNoComments),
        'a .terminal-pane.is-exited rule can never match — stamp the state on the element '
        + 'where fleetItem.status is already in scope instead');
});

test('updatePaneElement declares fleetItem and agentLabel exactly once each', () => {
    // The hoist-and-delete: the icon needs agentLabel before the index chip, so both
    // consts moved to the top of the `if (assignedName)` block. Leaving the originals
    // behind is a same-scope const redeclaration — the whole panel script stops parsing
    // and EVERY pane renders blank, not just this one.
    const region = block(terminalsJs, 'function updatePaneElement(paneEl, index) {', 'function resolveFlooredLayout(');
    const fleetItems = region.match(/const fleetItem\s*=/g) || [];
    const agentLabels = region.match(/const agentLabel\s*=/g) || [];
    assert.strictEqual(fleetItems.length, 1,
        `updatePaneElement must declare const fleetItem exactly once, found ${fleetItems.length}`);
    assert.strictEqual(agentLabels.length, 1,
        `updatePaneElement must declare const agentLabel exactly once, found ${agentLabels.length}`);
});

// ---------------------------------------------------------- dispatch progress chip

test('the dispatch chip is refcounted per terminal, not a boolean', () => {
    // withTerminalLock serialises concurrent sends to one terminal, so the first
    // response can land while a second is still queued. A boolean clears the chip early.
    assert.ok(/const dispatchInFlight = new Map\(\)/.test(terminalsJs),
        'dispatchInFlight must be a Map of counts');
    const begin = block(terminalsJs, 'function beginDispatchIndicator(', 'function endDispatchIndicator(');
    assert.match(begin, /\|\|\s*0\)\s*\+\s*1/, 'begin must increment a count');
    const end = block(terminalsJs, 'function endDispatchIndicator(', 'function refreshDispatchState(');
    assert.match(end, /-\s*1/, 'end must decrement rather than delete outright');
});

test('refreshDispatchState hands the header back to the input-state chip', () => {
    // syncInputStateChip early-returns while .is-dispatching is set, so removing the
    // dispatch chip without this tail leaves the header with NO chip at all — the
    // connecting / read-only / paste-queued states stay invisible until the next poll.
    const fn = block(terminalsJs, 'function refreshDispatchState(name) {', 'function notifyInputDropped(');
    assert.ok(fn.includes('syncDispatchChip('), 'must go through the one chip writer');
    assert.ok(fn.includes('refreshInputState('),
        'refreshDispatchState must call refreshInputState after syncing — otherwise a finished '
        + 'dispatch leaves the pane with no chip for a full poll cycle');
    assert.ok(!fn.includes('renderPaneGrid('),
        'a purely visual repaint must not rebuild the grid — that reparents live xterm DOM');
});

test('the render path syncs the dispatch chip BEFORE the input-state chip', () => {
    // Panes are reused and .is-dispatching is cleared only by syncDispatchChip, so the
    // reverse order makes syncInputStateChip see a stale class from a finished dispatch
    // (or from the pane's previous occupant) and suppress the input chip for a poll cycle.
    const region = block(terminalsJs, 'function updatePaneElement(paneEl, index) {', 'function resolveFlooredLayout(');
    const dispatchAt = region.indexOf('syncDispatchChip(paneEl, titleEl');
    const inputAt = region.indexOf('syncInputStateChip(paneEl, titleEl');
    assert.ok(dispatchAt !== -1 && inputAt !== -1, 'both chip syncs must run in the assigned branch');
    assert.ok(dispatchAt < inputAt,
        'syncDispatchChip must be called before syncInputStateChip');
});

test('the drop dispatch clears the chip from finally, and stale entries are pruned', () => {
    const drop = block(terminalsJs, 'beginDispatchIndicator(targetName)', 'attributeDropDispatch(targetName, ids, workspaceRoot);\n                }');
    assert.match(drop, /\}\s*finally\s*\{[\s\S]*endDispatchIndicator\(targetName\)/,
        'endDispatchIndicator must run in a finally — a rejected fetch must not strand the '
        + 'chip, and the failure toast must never render beside a live "dispatching…"');
    const sanitize = block(terminalsJs, 'function sanitizePaneAssignments() {', 'function renderSidebarList(');
    assert.ok(/dispatchInFlight\.delete\(name\)/.test(sanitize),
        'sanitizePaneAssignments must drop in-flight entries for dead terminals — one that '
        + 'died mid-dispatch never sends a response, so its refcount would strand');
});

test('the dispatch chip has its own box and a dense-layout variant', () => {
    assert.ok(/\.pane-dispatch-state\s*\{/.test(htmlNoComments), '.pane-dispatch-state rule is missing');
    assert.ok(/layout-3x3\s+\.pane-dispatch-state/.test(htmlNoComments),
        'the two dense layouts need the dot-only variant — isTerseLayout() empties the label, '
        + 'and without this the gap survives an empty label');
    assert.ok(/prefers-reduced-motion[\s\S]{0,200}\.pane-dispatch-state::before/.test(htmlNoComments)
        || /\.pane-dispatch-state::before\s*\{\s*animation:\s*none/.test(htmlNoComments),
        'the pulse must be disabled under reduced motion — a static dot still reads as in-progress');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
