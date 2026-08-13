'use strict';

/**
 * Contract: OPEN AGENT TERMINALS seats every terminal, grows the grid, and
 * paints the first curtain.
 *
 * Source-text contract, not behavioural: the panel is a browser-only IIFE with
 * no export surface. What CAN be pinned is the set of decisions that fixed the
 * three reported defects (staggered batch, missing first curtain, grid of four
 * from six requested) and the invariants that keep them fixed.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'webview', 'terminals.js'), 'utf8');

let failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

function block(startMarker, endMarker) {
    const start = SRC.indexOf(startMarker);
    assert.ok(start !== -1, `marker not found: ${startMarker}`);
    const end = SRC.indexOf(endMarker, start);
    assert.ok(end !== -1, `end marker not found after "${startMarker}": ${endMarker}`);
    return SRC.substring(start, end);
}

// ---------------------------------------------------------------- grow ladder

test('LAYOUT_GROW_ORDER is slot-ascending and excludes 2v', () => {
    const orderBlock = block("const LAYOUT_GROW_ORDER = [", "];");
    assert.ok(orderBlock.includes("'1'"), "grow order must start at '1'");
    assert.ok(orderBlock.includes("'2h'"), "grow order must include '2h'");
    assert.ok(orderBlock.includes("'1x3'"), "grow order must include '1x3'");
    assert.ok(orderBlock.includes("'2x2'"), "grow order must include '2x2'");
    assert.ok(orderBlock.includes("'2x3'"), "grow order must include '2x3'");
    assert.ok(orderBlock.includes("'3x3'"), "grow order must include '3x3'");
    assert.ok(!orderBlock.includes("'2v'"), "grow order must NOT include '2v' — stacked pair is a taste call");
});

test('layoutForFleetCount early-returns currentLayout when the fleet already fits', () => {
    const fn = block('function layoutForFleetCount(', 'function growLayoutForFleet(');
    assert.ok(
        fn.includes('if (count <= currentSlots) { return currentLayout; }'),
        'monotonicity guarantee: never shrink the operator pick'
    );
});

test('growLayoutForFleet guards on is-solo and does not persist', () => {
    const fn = block('function growLayoutForFleet(', 'async function loadSetting(');
    assert.ok(
        fn.includes("document.body.classList.contains('is-solo')"),
        'grow must no-op in solo mode'
    );
    assert.ok(
        !fn.includes('saveLayoutSettings'),
        'growLayoutForFleet must NOT persist — persistence is the caller job'
    );
});

// ---------------------------------------------------------------- open-all body

test('openAllTerminals disarms initialAssignmentDone after the wanted.size guard', () => {
    const openAll = block('async function openAllTerminals() {', 'await fetchTerminalList();');
    const guardIdx = openAll.indexOf('wanted.size === 0');
    const disarmIdx = openAll.indexOf('initialAssignmentDone = true');
    assert.ok(guardIdx !== -1, 'wanted.size === 0 guard must be present');
    assert.ok(disarmIdx !== -1, 'initialAssignmentDone = true must be present');
    assert.ok(
        disarmIdx > guardIdx,
        'initialAssignmentDone disarm must come AFTER the wanted.size guard'
    );
});

test('openAllTerminals grows conditionally on plannedTotal > liveCount', () => {
    const openAll = block('async function openAllTerminals() {', 'await fetchTerminalList();');
    assert.ok(
        openAll.includes('plannedTotal > liveCount'),
        'grow must be gated on there being new terminals to create'
    );
    assert.ok(
        openAll.includes('growLayoutForFleet('),
        'grow must call growLayoutForFleet'
    );
});

test('open-all loop arms the curtain BEFORE seating', () => {
    // The loop now lives in the shared createTerminalsForRole (open-all and Fill grid
    // both use it), so the ordering contract is asserted where the loop actually is.
    // Extraction must not weaken it: arm, THEN seat, because the seat's renderPaneGrid
    // is what paints the curtain.
    const loop = block('async function createTerminalsForRole(', 'async function openAllTerminals()');
    const armIdx = loop.indexOf('armStartupCurtain(');
    const hookIdx = loop.indexOf('if (onCreated) { onCreated(data.terminal); }');
    assert.ok(armIdx !== -1, 'armStartupCurtain must be called in the loop');
    assert.ok(hookIdx !== -1, 'the per-terminal seat hook must be called in the loop');
    assert.ok(
        armIdx < hookIdx,
        'armStartupCurtain must precede the seat hook — the seat render paints the curtain'
    );
    // ...and open-all must actually pass a seating hook, or the whole batch lands
    // seconds later instead of each terminal appearing as it is born.
    const openAll = block('async function openAllTerminals() {', 'await fetchTerminalList();');
    assert.ok(
        openAll.includes('createTerminalsForRole('),
        'open-all must delegate to the shared creation loop, not fork it'
    );
    assert.ok(
        openAll.includes('fillEmptyPanes({ persist: false })'),
        'open-all must seat incrementally via the onCreated hook, with persist:false'
    );
});

test('the creation loop is sequential, and sends no startup command of its own', () => {
    const loop = block('async function createTerminalsForRole(', 'async function openAllTerminals()');
    assert.ok(
        /for \(let i = 0; i < count; i\+\+\) \{[\s\S]*await fetch\(/.test(loop),
        'creations must be serialized — ptyFleetService.create() picks the next free ${role}-${n} off its own map, so concurrent creates for one role collide on a name'
    );
    assert.ok(
        !/Promise\.all/.test(loop),
        'no Promise.all: concurrency is a name collision, not just a startup-command race'
    );
    assert.ok(
        !/startupCommand|sendRobustText|injectStartupCommand/.test(loop),
        'the webview must not send the startup command — ptyFleetService.create() injects it and duplicating it launches each agent CLI twice'
    );
});

test('Fill grid tops up from fleetList and routes its layout through setLayoutMode', () => {
    const fill = block('async function fillGrid(role, mode) {', 'function fillEmptyPanes(');
    assert.ok(
        fill.includes('LAYOUTS[mode].slots'),
        'the count must derive from LAYOUTS[mode].slots, not a second hardcoded slot table'
    );
    assert.ok(
        fill.includes('LAYOUT_MODES.includes(mode)'),
        'the mode must be validated against LAYOUT_MODES before indexing LAYOUTS'
    );
    assert.ok(
        /t\.status !== 'exited' && t\.role === role/.test(fill),
        'the existing count must come from live fleetList rows — the same list the UI renders'
    );
    assert.ok(
        !/getRoleTerminalSet/.test(fill),
        'the webview cannot call getRoleTerminalSet, and it cannot see PTY rows anyway'
    );
    assert.ok(fill.includes('if (need <= 0)'), 're-running a fill must be a no-op, not a fleet doubling');
    assert.ok(
        fill.includes('setLayoutMode(mode)') && !/effectiveLayout\s*=/.test(fill),
        'the layout switch must go through setLayoutMode so applyLayoutFloor still applies'
    );
    assert.ok(!/\bconfirm\(/.test(fill), 'no confirm gate — window.confirm() is a silent no-op in a webview');
});

test('open-all tail persists once and toasts on unseated remainder', () => {
    // The tail is after the first fetchTerminalList — extract from there to end of function.
    const fetchIdx = SRC.indexOf('await fetchTerminalList();', SRC.indexOf('async function openAllTerminals() {'));
    assert.ok(fetchIdx !== -1, 'fetchTerminalList must exist in openAllTerminals');
    const tail = SRC.substring(fetchIdx, SRC.indexOf('    }', fetchIdx + 20));
    assert.ok(
        tail.includes("fillEmptyPanes({ persist: false })"),
        'tail must call fillEmptyPanes with persist:false'
    );
    assert.ok(
        tail.includes('saveLayoutSettings()'),
        'tail must persist exactly once via saveLayoutSettings()'
    );
    assert.ok(
        tail.includes('showPaneToast('),
        'tail must toast when terminals remain unseated'
    );
    assert.ok(
        tail.includes('unseated > 0'),
        'toast must be gated on unseated > 0'
    );
});

// ---------------------------------------------------------------- armStartupCurtain paint-on-arm

test('armStartupCurtain paints directly without calling renderPaneGrid or renderSidebarList', () => {
    const fn = block('function armStartupCurtain(', 'function bumpStartupCurtain(');
    assert.ok(
        fn.includes('if (!name || !hasStartupCommand || startupCurtains.has(name)) { return; }'),
        'the no-op guard must precede the paint'
    );
    assert.ok(
        fn.includes('renderStartupCurtain(contentEl, name)'),
        'paint-on-arm must call renderStartupCurtain directly'
    );
    // Check for call statements (with semicolon), not comment mentions. The comments
    // deliberately name the forbidden functions to explain why they are not called;
    // a bare includes() on the name would false-positive on those comments.
    assert.ok(
        !fn.includes('renderPaneGrid();'),
        'armStartupCurtain must NOT call renderPaneGrid — re-parenting risk'
    );
    assert.ok(
        !fn.includes('renderSidebarList();'),
        'armStartupCurtain must NOT call renderSidebarList — class add is direct'
    );
});

// ---------------------------------------------------------------- fillEmptyPanes

test('fillEmptyPanes accepts an options bag, skips kanban slots, and returns unseated count', () => {
    const fn = block('function fillEmptyPanes(', 'async function renameTerminal(');
    assert.ok(
        fn.includes('function fillEmptyPanes(opts)'),
        'fillEmptyPanes must accept an opts parameter'
    );
    assert.ok(
        fn.includes("opts.persist !== false"),
        'fillEmptyPanes must support persist:false'
    );
    assert.ok(
        fn.includes("paneModes[i] !== 'kanban'"),
        'fillEmptyPanes must still skip kanban-mode slots'
    );
    assert.ok(
        fn.includes('return unseated.length'),
        'fillEmptyPanes must return the unseated count'
    );
    assert.ok(
        fn.includes('return 0'),
        'fillEmptyPanes must return 0 when nothing is unseated'
    );
});

// ---------------------------------------------------------------- existing payload contract (re-asserted locally)

test('open-all payload stays target-free and contains exactly one fetchTerminalList', () => {
    // The POST moved into the shared creation loop; the payload contract did not.
    const loop = block('async function createTerminalsForRole(', 'async function openAllTerminals()');
    assert.ok(
        /body: JSON\.stringify\(\{ role \}\)/.test(loop),
        'open-all must stay target-free — the proxy supplies the active parent'
    );
    // Exactly one await fetchTerminalList() in the whole function. Extract the full
    // function body to the next top-level function declaration.
    const fnStart = SRC.indexOf('async function openAllTerminals() {');
    const fnEnd = SRC.indexOf('async function fillGrid(', fnStart);
    const fullFn = SRC.substring(fnStart, fnEnd);
    const count = (fullFn.match(/await fetchTerminalList\(\);/g) || []).length;
    assert.ok(
        count === 1,
        `openAllTerminals must contain exactly one await fetchTerminalList() (found ${count}) — the contract test block marker depends on it`
    );
});

console.log(failed === 0 ? '\nAll open-all seating contracts passed.' : `\n${failed} contract(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
