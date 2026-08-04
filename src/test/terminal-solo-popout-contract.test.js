'use strict';

/**
 * Contract tests for Solo Terminal Pop-Out Window implementation.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const terminalsJs = fs.readFileSync(path.join(__dirname, '../webview/terminals.js'), 'utf8');
const terminalsHtml = fs.readFileSync(path.join(__dirname, '../webview/terminals.html'), 'utf8');
const shellJs = fs.readFileSync(path.join(__dirname, '../webview/shell.js'), 'utf8');

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

// ---------------------------------------------------------------- solo mode contracts

test('saveSetting suppresses writes in solo mode', () => {
    const saveSettingBlock = block(terminalsJs, 'async function saveSetting(', 'async function loadLayoutSettings()');
    assert.ok(
        saveSettingBlock.includes('if (soloTerminalName) { return; }'),
        'saveSetting must return early when soloTerminalName is active'
    );
});

test('sanitizePaneAssignments exempts soloTerminalName from stale-slot drop', () => {
    const sanitizeBlock = block(terminalsJs, 'function sanitizePaneAssignments() {', 'function renderSidebarList() {');
    assert.ok(
        sanitizeBlock.includes('if (soloTerminalName && paneAssignments[i] === soloTerminalName)'),
        'sanitizePaneAssignments must exempt soloTerminalName from stale-slot drop'
    );
});

test('solo mode initializes layout mode to 1 and pre-sets initialAssignmentDone', () => {
    const initBlock = block(terminalsJs, 'function init() {', 'resolveInitialTheme();');
    assert.ok(initBlock.includes('document.body.classList.add(\'is-solo\')'), 'init must add is-solo class to body');
    assert.ok(initBlock.includes('currentLayout = \'1\''), 'init must force currentLayout to 1');
    assert.ok(initBlock.includes('initialAssignmentDone = true'), 'init must set initialAssignmentDone = true');
});

test('websocket exit frame distinguishes transport eviction from process exit', () => {
    const exitArm = block(terminalsJs, "} else if (frame.t === 'exit') {", "entry.term.options.disableStdin = true;");
    assert.ok(
        exitArm.includes("if (frame.reason === 'Lagging client evicted')"),
        'exit arm must branch on eviction reason'
    );
    assert.ok(
        exitArm.includes("[Disconnected — reconnecting…]"),
        'eviction exit frame must show reconnecting message'
    );
    // Leaving entry.exited false is the whole point: ws.onclose returns early on
    // `exited`, so setting it would suppress the backoff reconnect and strand the
    // view claiming a live process died.
    assert.ok(
        !/Lagging client evicted'\)\s*\{[^}]*entry\.exited = true/.test(exitArm),
        'the eviction branch must NOT set entry.exited — ws.onclose skips reconnect when it is true'
    );
});

test('the eviction sentinel matches the string the gateway actually sends', () => {
    // The client pins the gateway's literal by exact value across a file boundary.
    // Reword it on the server and the client silently reverts to rendering a live
    // terminal as "[Process Exited with code -1]" with stdin disabled and no
    // reconnect — with no test failure anywhere. Pin both sides together.
    const gateway = fs.readFileSync(path.join(__dirname, '../standalone/terminalWsGateway.ts'), 'utf8');
    const sent = gateway.match(/\{ t: 'exit', code: -1, reason: '([^']+)' \}/);
    assert.ok(sent, "terminalWsGateway must still emit an exit frame carrying a `reason` for lagging-client eviction");
    assert.ok(
        terminalsJs.includes(`frame.reason === '${sent[1]}'`),
        `terminals.js branches on a different string than the gateway sends ("${sent[1]}")`
    );
});

test('?solo=<unknown> renders the not-found state and creates no terminal', () => {
    const fn = block(terminalsJs, 'function checkSoloNotFound() {', 'undo of the last assignment mutation');
    assert.ok(fn.includes('if (!soloTerminalName) return;'), 'the check is solo-only');
    assert.ok(
        /const isLive = fleetList\.some\(t => t\.friendlyName === soloTerminalName\)/.test(fn),
        'resolution must be against the fetched fleet list'
    );
    assert.ok(fn.includes('not found'), 'an absent name must render an explicit not-found state');
    assert.ok(
        fn.includes("paneGridEl.style.display = 'none'"),
        'the not-found state must hide the grid rather than render an empty pane'
    );
    // The seeding branch is what would otherwise substitute fleetList[0].
    const sanitize = block(terminalsJs, 'function sanitizePaneAssignments() {', 'function renderSidebarList() {');
    assert.ok(
        sanitize.includes('if (!initialAssignmentDone && fleetList.length > 0)'),
        'the seeding branch must stay gated on initialAssignmentDone (solo pre-sets it to true)'
    );
    // Nothing in the solo path may spawn a terminal to fill the gap.
    assert.ok(!fn.includes('ptySpawn') && !fn.includes('createTerminal'), 'the not-found path must create no terminal');
});

test('"connecting…" is reachable — a failed fetch is not an absent terminal', () => {
    const fn = block(terminalsJs, 'function checkSoloNotFound() {', 'undo of the last assignment mutation');
    assert.ok(fn.includes('if (!hasFetchedList)'), 'checkSoloNotFound must distinguish not-yet-loaded from not-found');
    assert.ok(fn.includes('Connecting'), 'the pre-fetch state must be a neutral connecting message');

    // hasFetchedList is set inside the success branch, so the success-path call can
    // NEVER see it false. The transient state is only reachable if the function is
    // also called before the first fetch and on the failure paths — without those
    // two call sites the whole branch is dead code and a pop-out opened against a
    // down server renders blank.
    const fetchFn = block(terminalsJs, 'async function fetchTerminalList() {', 'function checkSoloNotFound() {');
    const successCall = fetchFn.indexOf('checkSoloNotFound();');
    const failureCall = fetchFn.indexOf('checkSoloNotFound();', successCall + 1);
    assert.ok(successCall !== -1, 'fetchTerminalList must resolve the solo state on success');
    assert.ok(failureCall !== -1, 'fetchTerminalList must ALSO repaint on the error / non-OK / bad-shape path');
    assert.ok(
        fetchFn.includes('} catch (err) {') && fetchFn.lastIndexOf('catch (err)') < failureCall,
        'the failure-path repaint must sit after the catch, so it covers all three swallowed outcomes'
    );

    // init()'s tail — the solo/non-solo first-fetch dispatch, past the message-listener
    // arms that also mention fetchTerminalList.
    const initTail = block(terminalsJs, "window.addEventListener('resize'", 'function postFleetStateToShell()');
    const paintAt = initTail.indexOf('checkSoloNotFound();');
    const fetchAt = initTail.indexOf('fetchTerminalList();');
    assert.ok(paintAt !== -1, 'init must paint the transient solo state itself');
    assert.ok(paintAt < fetchAt, 'init must paint the transient state BEFORE dispatching the first fetch');
});

test('the pinned pane survives an empty fleet without the empty state bleeding through', () => {
    // Operator close removes the terminal from the registry entirely, so fleetList
    // legitimately empties while the solo pane stays pinned and live. #empty-state is
    // a full-height flex SIBLING of #pane-grid — shown inline by renderSidebarList —
    // so leaving it visible stacks "No terminal selected" above the live terminal.
    assert.ok(
        /body\.is-solo #empty-state \{[^}]*display: none !important/.test(terminalsHtml),
        'body.is-solo must suppress #empty-state, which renderSidebarList shows inline on an empty fleet'
    );
    const render = block(terminalsJs, 'function renderSidebarList() {', 'function setLayoutMode(');
    assert.ok(
        /if \(!soloTerminalName\) \{\s*emptyStateEl\.style\.display/.test(render),
        'renderSidebarList must not hide the grid in solo mode — checkSoloNotFound owns its visibility'
    );
});

test('resolveInitialTheme inherits theme from window.opener', () => {
    const themeBlock = block(terminalsJs, 'function resolveInitialTheme() {', 'document.body.classList.add(\'cyber-theme-enabled\');');
    assert.ok(
        themeBlock.includes('window.opener'),
        'resolveInitialTheme must check window.opener'
    );
});

test('terminals.html includes CSS and container for solo mode', () => {
    assert.ok(terminalsHtml.includes('body.is-solo .terminals-sidebar'), 'terminals.html must hide sidebar in solo mode');
    assert.ok(terminalsHtml.includes('id="solo-status"'), 'terminals.html must provide solo-status container');
});

test('shell.js opens solo terminal pop-out URL and fans out theme changes', () => {
    assert.ok(shellJs.includes('/terminals?solo='), 'shell.js must construct solo pop-out URL');
    assert.ok(shellJs.includes('popoutWindows.add('), 'shell.js must track popout windows');
    const themeFanout = block(shellJs, 'function applyThemeToAll(themeName) {', 'function buildFrame(panel) {');
    assert.ok(themeFanout.includes('popoutWindows'), 'applyThemeToAll must fan out theme to popoutWindows');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
