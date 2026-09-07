'use strict';

/**
 * Contract tests for the right-hand agent dock in the browser shell.
 *
 * The dock is now its own document at /dock (dock.html + dock.js). The shell
 * hosts ONE iframe pointing at /dock and owns only open/closed, width, the
 * splitter and the minimum-width gate. The dock document owns the tab strip
 * (Agent / CLI / Fleet), seat lifecycle, terminal viewports and the fleet
 * table.
 *
 * Source-text contracts, not behavioural ones — the dock is browser-only DOM
 * code in an IIFE with no export surface, and every failure mode here is a
 * rendering or lifecycle defect a headless run cannot observe. What CAN be
 * pinned is the handful of decisions that are invisible on inspection and
 * were each wrong in a first pass of the plan:
 *
 *   - the dock is a SIBLING after #content, not a child of it (overlay vs dock)
 *   - the shell hosts ONE iframe pointing at /dock (not two /terminals iframes)
 *   - visibility is class-driven (.is-visible), never [hidden] alone
 *   - the dock width floor is 648px (80 columns × 7.80px + 24px chrome)
 *   - the dock toggle glyph is NOT nav-terminals.svg
 *   - the dock document does not import terminals.js
 *   - the dock document uses terminalViewport.js for the CLI tab only
 *   - the Agent tab is an API-backed control surface (no terminal emulator)
 *   - Fleet tab does not instantiate terminal viewport code
 *   - transport.js switchPanel guard applies to the /dock route
 *   - no live isDockFrame caller remains in terminals.js
 *   - no live /terminals?...&dock=1 URL construction remains
 *
 * Run with: node src/test/shell-agent-dock.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const shellJs = fs.readFileSync(path.join(__dirname, '../webview/shell.js'), 'utf8');
const shellHtml = fs.readFileSync(path.join(__dirname, '../webview/shell.html'), 'utf8');
const dockJs = fs.readFileSync(path.join(__dirname, '../webview/dock.js'), 'utf8');
const dockHtml = fs.readFileSync(path.join(__dirname, '../webview/dock.html'), 'utf8');
const bootstrapTs = fs.readFileSync(path.join(__dirname, '../standalone/bootstrap.ts'), 'utf8');
const goPtyProjectionTs = fs.readFileSync(path.join(__dirname, '../services/goPtyFleetProjection.ts'), 'utf8');
const goPtyHostGo = fs.readFileSync(path.join(__dirname, '../../cmd/switchboard-pty-host/main.go'), 'utf8');
const tvpHiddenSplitTs = fs.readFileSync(path.join(__dirname, '../services/TaskViewerProvider.ts'), 'utf8');
const ptyFleetTs = fs.readFileSync(path.join(__dirname, '../standalone/ptyFleetService.ts'), 'utf8');
const terminalsJs = fs.readFileSync(path.join(__dirname, '../webview/terminals.js'), 'utf8');
const terminalsHtml = fs.readFileSync(path.join(__dirname, '../webview/terminals.html'), 'utf8');
const transportJs = fs.readFileSync(path.join(__dirname, '../webview/transport.js'), 'utf8');
const linearJs = fs.readFileSync(path.join(__dirname, '../webview/linear.js'), 'utf8');
const headlessPanelHtmlTs = fs.readFileSync(path.join(__dirname, '../services/headlessPanelHtml.ts'), 'utf8');
const localApiServerTs = fs.readFileSync(path.join(__dirname, '../services/LocalApiServer.ts'), 'utf8');

/** Slice of a source file between two markers, for scoping an assertion to one function. */
function block(code, startMarker, endMarker) {
    const start = code.indexOf(startMarker);
    assert.ok(start !== -1, `marker not found: ${startMarker}`);
    const end = code.indexOf(endMarker, start);
    assert.ok(end !== -1, `end marker not found AFTER "${startMarker}": ${endMarker}`);
    return code.substring(start, end);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (e) {
        console.error(`  FAIL ${name}: ${e.message}`);
        failed++;
    }
}

// ── shell.html: markup ──────────────────────────────────────────────

test('shell.html contains #agent-dock and #dock-splitter', () => {
    assert.ok(shellHtml.includes('id="agent-dock"'), '#agent-dock must exist in shell.html');
    assert.ok(shellHtml.includes('id="dock-splitter"'), '#dock-splitter must exist in shell.html');
});

test('the dock is a sibling AFTER #content, not a child of it', () => {
    const contentIdx = shellHtml.indexOf('id="content"');
    const dockIdx = shellHtml.indexOf('id="agent-dock"');
    assert.ok(contentIdx !== -1 && dockIdx !== -1, 'both #content and #agent-dock must be present');
    assert.ok(dockIdx > contentIdx, '#agent-dock must come after #content in the body');
    const contentClose = shellHtml.indexOf('</div>', contentIdx);
    assert.ok(contentClose !== -1 && contentClose < dockIdx,
        '#content must close before #agent-dock opens — the dock is a body-level sibling, not a child of #content');
});

test('shell.html contains the body.dock-dragging pointer-inert rule', () => {
    assert.ok(/body\.dock-dragging\s+\.panel-frame/.test(shellHtml),
        'body.dock-dragging must neutralise .panel-frame pointer events during a splitter drag');
    assert.ok(/body\.dock-dragging\s+#dock-frame/.test(shellHtml),
        'body.dock-dragging must neutralise #dock-frame pointer events during a splitter drag');
});

// ── shell.html: ONE iframe pointing at /dock ─────────────────────────

test('shell.html has exactly one dock iframe (#dock-frame) and no #dock-cli-frame', () => {
    assert.ok(shellHtml.includes('id="dock-frame"'), '#dock-frame must exist in shell.html');
    assert.ok(!shellHtml.includes('id="dock-cli-frame"'), '#dock-cli-frame must be removed — the dock document owns the CLI pane');
    assert.ok(!shellHtml.includes('id="dock-kanban-frame"'), '#dock-kanban-frame must be removed');
});

test('shell.html does not contain dock tab strip, empty state, or fleet table', () => {
    // These elements moved to dock.html — the shell only hosts the iframe.
    assert.ok(!shellHtml.includes('id="dock-tabs"'), '#dock-tabs must not exist in shell.html — moved to dock.html');
    assert.ok(!shellHtml.includes('id="dock-tab-agent"'), '#dock-tab-agent must not exist in shell.html');
    assert.ok(!shellHtml.includes('id="dock-tab-cli"'), '#dock-tab-cli must not exist in shell.html');
    assert.ok(!shellHtml.includes('id="dock-tab-fleet"'), '#dock-tab-fleet must not exist in shell.html');
    assert.ok(!shellHtml.includes('id="dock-empty"'), '#dock-empty must not exist in shell.html — moved to dock.html');
    assert.ok(!shellHtml.includes('id="dock-cli-input"'), '#dock-cli-input must not exist in shell.html');
    assert.ok(!shellHtml.includes('id="dock-start"'), '#dock-start must not exist in shell.html');
    assert.ok(!shellHtml.includes('id="dock-restart"'), '#dock-restart must not exist in shell.html');
    assert.ok(!shellHtml.includes('id="dock-title"'), '#dock-title must not exist in shell.html');
    assert.ok(!shellHtml.includes('id="dock-close"'), '#dock-close must not exist in shell.html');
    assert.ok(!shellHtml.includes('id="dock-fleet"'), '#dock-fleet must not exist in shell.html');
    assert.ok(!shellHtml.includes('id="dock-fleet-tbody"'), '#dock-fleet-tbody must not exist in shell.html');
});

test('shell.html dock-dragging does not reference removed #dock-cli-frame', () => {
    assert.ok(!/body\.dock-dragging\s+#dock-cli-frame/.test(shellHtml),
        'body.dock-dragging must not reference the removed #dock-cli-frame');
    assert.ok(!/body\.dock-dragging\s+#dock-kanban-frame/.test(shellHtml),
        'body.dock-dragging must not reference the removed #dock-kanban-frame');
});

test('#dock-frame uses .is-visible, not [hidden] alone', () => {
    assert.ok(/#dock-frame\s*\{[^}]*display:\s*none/.test(shellHtml),
        '#dock-frame must declare a base display:none');
    assert.ok(/#dock-frame\.is-visible\s*\{[^}]*display:\s*block/.test(shellHtml),
        '#dock-frame.is-visible must declare display:block');
});

test('#dock-role-btn and #dock-role-menu are absent from shell.html', () => {
    assert.ok(!shellHtml.includes('id="dock-role-btn"'), '#dock-role-btn must be absent from shell.html');
    assert.ok(!shellHtml.includes('id="dock-role-menu"'), '#dock-role-menu must be absent from shell.html');
    assert.ok(!shellHtml.includes('#dock-role-menu'), '#dock-role-menu CSS must be absent from shell.html');
    assert.ok(!shellHtml.includes('.dock-role-item'), '.dock-role-item CSS must be absent from shell.html');
});

test('role picker functions and dockRole variable are absent from shell.js', () => {
    assert.ok(!shellJs.includes('buildDockRoleMenu'), 'buildDockRoleMenu must be absent from shell.js');
    assert.ok(!shellJs.includes('fetchDockRoles'), 'fetchDockRoles must be absent from shell.js');
    assert.ok(!shellJs.includes('dockRolesCache'), 'dockRolesCache must be absent from shell.js');
    assert.ok(!shellJs.includes('DOCK_SYSTEM_ROLES'), 'DOCK_SYSTEM_ROLES must be absent from shell.js');
    assert.ok(!shellJs.includes('loadDockRole'), 'loadDockRole must be absent from shell.js');
    assert.ok(!shellJs.includes('dockRole'), 'dockRole must be absent from shell.js');
});

// ── shell.html: sharedDefaults.js loaded before shell.js (edge case 15) ──

test('shell.html loads sharedDefaults.js before shell.js, both with nonce', () => {
    const defaultsIdx = shellHtml.indexOf('src="/static/webview/sharedDefaults.js"');
    const shellJsIdx = shellHtml.indexOf('src="/static/webview/shell.js"');
    assert.ok(defaultsIdx !== -1, 'sharedDefaults.js script tag must be present');
    assert.ok(shellJsIdx !== -1, 'shell.js script tag must be present');
    assert.ok(defaultsIdx < shellJsIdx, 'sharedDefaults.js must load before shell.js');
    const defaultsTag = shellHtml.substring(shellHtml.lastIndexOf('<script', defaultsIdx), defaultsIdx + 50);
    assert.ok(defaultsTag.includes('nonce="{{NONCE}}"'), 'sharedDefaults.js tag must carry nonce="{{NONCE}}"');
    const shellJsTag = shellHtml.substring(shellHtml.lastIndexOf('<script', shellJsIdx), shellJsIdx + 50);
    assert.ok(shellJsTag.includes('nonce="{{NONCE}}"'), 'shell.js tag must carry nonce="{{NONCE}}"');
});

// ── shell.html: width floor (edge case 13) ──────────────────────────

test('#agent-dock min-width and width are both >= 648px', () => {
    const dockRule = shellHtml.match(/#agent-dock\s*\{([^}]*)\}/);
    assert.ok(dockRule, '#agent-dock CSS rule must exist');
    const widthMatch = dockRule[1].match(/width:\s*(\d+)px/);
    const minWidthMatch = dockRule[1].match(/min-width:\s*(\d+)px/);
    assert.ok(widthMatch, '#agent-dock must declare a width');
    assert.ok(minWidthMatch, '#agent-dock must declare a min-width');
    assert.ok(parseInt(widthMatch[1], 10) >= 648,
        `#agent-dock width must be >= 648px (got ${widthMatch[1]}px)`);
    assert.ok(parseInt(minWidthMatch[1], 10) >= 648,
        `#agent-dock min-width must be >= 648px (got ${minWidthMatch[1]}px)`);
});

test('no second margin-top:auto was introduced by the dock CSS', () => {
    const anchors = (shellHtml.match(/margin-top:\s*auto/g) || []).length;
    assert.strictEqual(anchors, 1,
        'exactly one CSS rule may declare margin-top: auto in the strip — the dock must not add a second anchor');
});

// ── shell.js: width floor constant (edge case 13) ───────────────────

test('DOCK_MIN is >= 648 in shell.js', () => {
    const m = shellJs.match(/const\s+DOCK_MIN\s*=\s*(\d+)/);
    assert.ok(m, 'DOCK_MIN must be declared in shell.js');
    assert.ok(parseInt(m[1], 10) >= 648,
        `DOCK_MIN must be >= 648 (got ${m[1]})`);
});

// ── shell.js: narrow-window gate (edge case 7) ──────────────────────

test('DOCK_VIABLE_MIN is declared and the dock toggle consults it', () => {
    assert.ok(/const\s+DOCK_VIABLE_MIN\s*=/.test(shellJs),
        'DOCK_VIABLE_MIN must be declared in shell.js');
    assert.ok(/DOCK_VIABLE_MIN/.test(shellJs),
        'DOCK_VIABLE_MIN must be referenced in shell.js');
    const fn = shellJs.match(/function\s+updateDockViableGating\(\)\s*\{([\s\S]*?)\n\s{4}\}/);
    assert.ok(fn, 'updateDockViableGating function must exist');
    assert.ok(/DOCK_VIABLE_MIN/.test(fn[1]),
        'updateDockViableGating must consult DOCK_VIABLE_MIN');
    assert.ok(/window\.innerWidth/.test(fn[1]),
        'updateDockViableGating must check window.innerWidth');
});

// ── shell.js: toggle gated on frames.has('terminals') (edge case 3) ──

test('the dock toggle is in renderTopRightCluster, gated on frames.has(terminals)', () => {
    const fn = shellJs.match(/function\s+renderTopRightCluster\([\s\S]*?\n\s{4}\}/);
    assert.ok(fn, 'renderTopRightCluster function must exist');
    assert.ok(/frames\.has\('terminals'\)/.test(fn[0]),
        'the dock toggle must be gated on frames.has(\'terminals\')');
    assert.ok(fn[0].includes('dock-toggle-btn'), 'dock button must have .dock-toggle-btn class');
    assert.ok(!shellJs.includes('buildDockToggle'), 'buildDockToggle must be removed from shell.js');
});

test('the dock toggle glyph is NOT nav-terminals.svg (edge case 17)', () => {
    const fn = shellJs.match(/function\s+renderTopRightCluster\([\s\S]*?\n\s{4}\}/);
    assert.ok(fn, 'renderTopRightCluster function must exist');
    assert.ok(/nav-dock\.svg/.test(fn[0]),
        'the dock toggle must use nav-dock.svg');
    assert.ok(!/nav-terminals\.svg/.test(fn[0]),
        'the dock toggle must NOT reuse nav-terminals.svg — the Terminals panel already uses that glyph');
});

// ── shell.js: setDockOpen mounts the /dock iframe ───────────────────

test('setDockOpen assigns width and mounts the /dock iframe', () => {
    const fn = shellJs.match(/function\s+setDockOpen\([\s\S]*?\n\s{4}\}/);
    assert.ok(fn, 'setDockOpen function must exist');
    assert.ok(/dockEl\.style\.width\s*=/.test(fn[0]),
        'setDockOpen must assign dockEl.style.width from persisted state');
    assert.ok(/readDockState\(\)\.width/.test(fn[0]),
        'setDockOpen must read the width from readDockState()');
    assert.ok(/\/dock/.test(fn[0]),
        'setDockOpen must point the iframe at /dock');
    assert.ok(/dockFrame\.src\s*=\s*'\/dock'/.test(fn[0]),
        "setDockOpen must set dockFrame.src to '/dock'");
});

test('shell.js does not construct /terminals?...&dock=1 URLs', () => {
    assert.ok(!/\/terminals\?[^'"]*dock=1/.test(shellJs),
        'shell.js must not construct /terminals?...&dock=1 URLs — the dock is now /dock');
});

// ── shell.js: removed dock management functions ──────────────────────

test('shell.js does not contain dock tab/seat/fleet management functions', () => {
    const removed = [
        'setDockActiveTab', 'normaliseDockTab', 'startFleetPoll', 'stopFleetPoll',
        'refreshFleetTab', 'renderFleetContent', 'toggleHopCheckbox',
        'checkDockLiveness', 'syncDockSeat', 'updateDockTitle', 'mountDockFrame',
        'checkCliLiveness', 'syncCliSeat', 'mountCliFrame', 'showCliEmptyState',
        'startCliSeat', 'showDockEmptyState', 'prefillDockCliInput',
        'renderDockClipboardPrompt', 'startDockTerminal',
        'dockSeatName', 'dockCliSeatName', 'isControllerTerminal',
        'DOCK_TABS', 'DOCK_TAB_BTNS',
    ];
    for (const name of removed) {
        assert.ok(!shellJs.includes(name), `${name} must be removed from shell.js — moved to dock.js`);
    }
});

// ── dock.html: the dock document ─────────────────────────────────────

test('dock.html exists and contains the tab strip with Agent/CLI/Fleet', () => {
    assert.ok(dockHtml.includes('id="dock-tabs"'), '#dock-tabs must exist in dock.html');
    assert.ok(dockHtml.includes('id="dock-tab-agent"'), '#dock-tab-agent must exist in dock.html');
    assert.ok(dockHtml.includes('id="dock-tab-cli"'), '#dock-tab-cli must exist in dock.html');
    assert.ok(dockHtml.includes('id="dock-tab-fleet"'), '#dock-tab-fleet must exist in dock.html');
    assert.ok(!dockHtml.includes('id="dock-tab-kanban"'), '#dock-tab-kanban must not exist in dock.html');
});

test('dock.html contains empty state, CLI input, start/restart, fleet table', () => {
    assert.ok(dockHtml.includes('id="dock-empty"'), '#dock-empty must exist in dock.html');
    assert.ok(dockHtml.includes('id="dock-cli-input"'), '#dock-cli-input must exist in dock.html');
    assert.ok(dockHtml.includes('id="dock-start"'), '#dock-start must exist in dock.html');
    assert.ok(dockHtml.includes('id="dock-restart"'), '#dock-restart must exist in dock.html');
    assert.ok(dockHtml.includes('id="dock-title"'), '#dock-title must exist in dock.html');
    assert.ok(dockHtml.includes('id="dock-close"'), '#dock-close must exist in dock.html');
    assert.ok(dockHtml.includes('id="dock-fleet"'), '#dock-fleet must exist in dock.html');
    assert.ok(dockHtml.includes('id="dock-fleet-tbody"'), '#dock-fleet-tbody must exist in dock.html');
});

test('dock.html has three panes: agent (control surface), cli, fleet (not iframes)', () => {
    assert.ok(dockHtml.includes('id="dock-agent-pane"'), '#dock-agent-pane must exist in dock.html');
    assert.ok(dockHtml.includes('id="dock-cli-pane"'), '#dock-cli-pane must exist in dock.html');
    // The Agent tab is a control surface — it has a log, input, send button,
    // quick actions and a status line, NOT a terminal emulator.
    assert.ok(dockHtml.includes('id="agent-control-log"'), '#agent-control-log must exist in dock.html');
    assert.ok(dockHtml.includes('id="agent-control-input"'), '#agent-control-input must exist in dock.html');
    assert.ok(dockHtml.includes('id="agent-control-send"'), '#agent-control-send must exist in dock.html');
    // The dock document does NOT host iframes for terminals — the CLI tab
    // uses the viewport module directly, and the Agent tab has no terminal.
    assert.ok(!dockHtml.includes('<iframe'), 'dock.html must not contain any iframes');
});

test('dock.html loads terminalViewport.js and dock.js, NOT terminals.js', () => {
    // dock.html carries PLACEHOLDERS, not filenames — getDockHtml substitutes
    // them. Asserting the literal filename against the raw template tests the
    // wrong artefact and fails on a correct page, so assert the whole chain:
    // the placeholder is declared here AND substituted there.
    const headless = fs.readFileSync(path.join(__dirname, '../services/headlessPanelHtml.ts'), 'utf8');
    const getDock = block(headless, 'export function getDockHtml(', 'export function getTerminalsHtml(');
    for (const [placeholder, file] of [
        ['{{TERMINAL_VIEWPORT_JS_URI}}', 'terminalViewport.js'],
        ['{{DOCK_JS_URI}}', 'dock.js'],
    ]) {
        assert.ok(dockHtml.includes(placeholder), `dock.html must reference ${placeholder}`);
        assert.ok(getDock.includes(placeholder.slice(2, -2)) && getDock.includes(file),
            `getDockHtml must substitute ${placeholder} with ${file}`);
    }
    // The load-bearing negative: no script on this page may resolve to the
    // 13K-line panel. Checked on script srcs, so prose may name it.
    const srcs = [...dockHtml.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
    assert.ok(!srcs.some(u => /(^|\/)terminals\.js/.test(u)),
        'dock.html must NOT load terminals.js — the dock document is independent of the Terminals panel');
    assert.ok(!/terminals\.js/.test(getDock),
        'getDockHtml must not substitute any placeholder with terminals.js');
});

test('dock.html has a CSP that allows ws: connections', () => {
    assert.ok(/connect-src\s+'self'\s+ws:\s+wss:/.test(dockHtml),
        'dock.html CSP must allow ws: and wss: connections for the terminal stream');
});

// ── dock.js: the dock document logic ─────────────────────────────────

test('dock.js does not import or require terminals.js', () => {
    // Strip comments first. A bare substring check fails on dock.js's own
    // header comment explaining that it deliberately does NOT import the panel
    // — the assertion would forbid documenting the invariant it enforces.
    const code = dockJs
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(!/(import|require)\s*\(?\s*['"][^'"]*terminals\.js/.test(code),
        'dock.js must not import or require terminals.js');
    assert.ok(!/['"][^'"]*\/terminals\.js['"]/.test(code),
        'dock.js must not reference a terminals.js URL — that reintroduces the 13K-line load');
});

test('dock.js uses terminalViewport.js via SwitchboardTerminalViewport.create', () => {
    assert.ok(dockJs.includes('SwitchboardTerminalViewport.create'),
        'dock.js must use SwitchboardTerminalViewport.create to build viewports');
});

test('dock.js creates a viewport for CLI only (Agent tab is a control surface)', () => {
    assert.ok(/ensureCliViewport/.test(dockJs), 'dock.js must have ensureCliViewport for the CLI tab');
    assert.ok(!/ensureAgentViewport/.test(dockJs), 'dock.js must NOT have ensureAgentViewport — the Agent tab is a control surface, not a terminal');
    assert.ok(!/agentViewport/.test(dockJs), 'dock.js must NOT reference agentViewport — the Agent tab has no terminal');
});

test('dock.js owns the tab strip switching logic', () => {
    assert.ok(/function\s+setDockActiveTab/.test(dockJs), 'dock.js must have setDockActiveTab');
    assert.ok(/DOCK_TABS\s*=\s*\['agent',\s*'cli',\s*'fleet'\]/.test(dockJs),
        'dock.js must declare DOCK_TABS with agent, cli, fleet');
});

test('dock.js Agent tab is a control surface with syncAgentControl and sendAgentControl', () => {
    assert.ok(/function\s+syncAgentControl/.test(dockJs), 'dock.js must have syncAgentControl — the Agent tab loads its config on activation');
    assert.ok(/function\s+sendAgentControl/.test(dockJs), 'dock.js must have sendAgentControl — the Agent tab sends intents to /agent/control');
    assert.ok(dockJs.includes('/agent/control'),
        'dock.js must call /agent/control — the Agent tab is an API-backed control surface');
});

test('dock.js does NOT have startDockTerminal or syncDockSeat (Agent tab is not a terminal)', () => {
    assert.ok(!/function\s+startDockTerminal/.test(dockJs), 'dock.js must NOT have startDockTerminal — the Agent tab is a control surface');
    assert.ok(!/function\s+syncDockSeat/.test(dockJs), 'dock.js must NOT have syncDockSeat — the Agent tab has no pty seat to sync');
    assert.ok(!/function\s+checkDockLiveness/.test(dockJs), 'dock.js must NOT have checkDockLiveness — the Agent tab has no pty seat');
    assert.ok(!/function\s+dockSeatName/.test(dockJs), 'dock.js must NOT have dockSeatName — the Agent tab has no seat');
});

test('dock.js owns CLI seat lifecycle (liveness check and creation)', () => {
    assert.ok(/function\s+checkCliLiveness/.test(dockJs), 'dock.js must have checkCliLiveness');
    assert.ok(/function\s+startCliSeat/.test(dockJs), 'dock.js must have startCliSeat');
});

test('dock.js startCliSeat saves startup commands and spawns hidden terminal', () => {
    const startFn = dockJs.match(/async\s+function\s+startCliSeat\(\)\s*\{([\s\S]*?)\n\s{4}\}/);
    assert.ok(startFn, 'startCliSeat function must exist in dock.js');
    const body = startFn[1];
    assert.ok(body.includes('/kanban/verb/saveStartupCommands'),
        'startCliSeat must call POST /kanban/verb/saveStartupCommands');
    assert.ok(body.includes('/terminals/verb/ptyCreateTerminal'),
        'startCliSeat must call POST /terminals/verb/ptyCreateTerminal');
    assert.ok(body.includes('hidden: true'),
        'startCliSeat must pass hidden: true to ptyCreateTerminal');
});

test('dock.js ptyListAll reads hiddenTerminals from ptyListTerminals', () => {
    // checkCliLiveness calls ptyListAll, which fetches
    // /terminals/verb/ptyListTerminals and merges hiddenTerminals
    // with the visible terminals array. The hidden-seat mechanism is the
    // server-side gate that keeps dock seats out of the sidebar.
    const fn = dockJs.match(/async\s+function\s+ptyListAll\(\)\s*\{([\s\S]*?)\n\s{4}\}/);
    assert.ok(fn, 'ptyListAll function must exist in dock.js');
    const body = fn[1];
    assert.ok(body.includes('/terminals/verb/ptyListTerminals'),
        'ptyListAll must call /terminals/verb/ptyListTerminals');
    assert.ok(body.includes('hiddenTerminals'),
        'ptyListAll must read hiddenTerminals from the response');
});

test('dock.js Fleet tab does not instantiate terminal viewport code', () => {
    // The Fleet tab branch in setDockActiveTab must not call ensureCliViewport
    // or createTerminalView. Verify the fleet branch only starts the poll.
    const fn = block(dockJs, 'function setDockActiveTab', 'function updateDockTitle');
    const fleetBranch = fn.slice(fn.indexOf("'fleet'"));
    assert.ok(!/ensureCliViewport|createTerminalView/.test(fleetBranch),
        'the Fleet tab branch must not instantiate terminal viewport code');
});

test('dock.js Agent tab branch does not instantiate terminal viewport code', () => {
    // The Agent tab branch in setDockActiveTab must not call ensureCliViewport
    // or createTerminalView — it calls syncAgentControl instead.
    const fn = block(dockJs, 'function setDockActiveTab', 'function updateDockTitle');
    const agentBranch = fn.slice(fn.indexOf("else {"));
    assert.ok(!/ensureCliViewport|createTerminalView|connectTerminalSocket/.test(agentBranch),
        'the Agent tab branch must not instantiate terminal viewport code — it is a control surface');
    assert.ok(/syncAgentControl/.test(agentBranch),
        'the Agent tab branch must call syncAgentControl');
});

test('dock.js keeps the CLI viewport alive across tab switches', () => {
    // The CLI viewport is created once and reused — setDockActiveTab does not
    // destroy it when switching away. Verify no destroyTerminalView call
    // inside setDockActiveTab.
    const fn = block(dockJs, 'function setDockActiveTab', 'function updateDockTitle');
    assert.ok(!/destroyTerminalView/.test(fn),
        'setDockActiveTab must not destroy the CLI viewport during tab switches');
});

test('dock.js handles theme changes by applying class and re-theming viewports', () => {
    assert.ok(/function\s+applyTheme/.test(dockJs), 'dock.js must have applyTheme');
    const fn = dockJs.match(/function\s+applyTheme\([\s\S]*?\n\s{4}\}/);
    assert.ok(fn, 'applyTheme function must exist');
    assert.ok(/theme-claudify/.test(fn[0]), 'applyTheme must handle claudify theme');
    assert.ok(/buildTerminalTheme/.test(fn[0]), 'applyTheme must re-theme terminals via buildTerminalTheme');
});

test('dock.js posts dockCloseRequested to parent on close button click', () => {
    assert.ok(dockJs.includes('dockCloseRequested'),
        'dock.js must post dockCloseRequested to the shell when the close button is clicked');
    assert.ok(/window\.parent\.postMessage\(\{\s*type:\s*'dockCloseRequested'\s*\},\s*location\.origin\)/.test(dockJs),
        'dock.js must post dockCloseRequested with location.origin');
});

test('dock.js persists activeTab and seat in sb.agentDock', () => {
    assert.ok(dockJs.includes("DOCK_STATE_KEY = 'sb.agentDock'"),
        'dock.js must use the same sb.agentDock localStorage key as the shell');
    assert.ok(/writeDockState\(\{\s*activeTab\s*\}\)/.test(dockJs),
        'dock.js must persist activeTab via writeDockState');
});

// ── The hidden-seat mechanism must exist SERVER-side in BOTH hosts ──

test('PtyFleetService carries a hidden flag and stamps it on new handles only', () => {
    assert.ok(/hidden\?:\s*boolean/.test(ptyFleetTs),
        'CreateOptions/ExtendedTerminalHandle must declare `hidden?: boolean`');
    assert.ok(ptyFleetTs.includes('hidden: opts?.hidden === true'),
        'create() must stamp `hidden` on the handle literal it builds');
    const singletonArm = ptyFleetTs.slice(
        ptyFleetTs.indexOf('const identity = singletonIdentityForRole(role);'),
        ptyFleetTs.indexOf('const handle: ExtendedTerminalHandle = {')
    );
    assert.ok(singletonArm.length > 0, 'the singleton guard must precede the handle literal');
    assert.ok(!/hidden/.test(singletonArm),
        'the singleton return/reclaim path must never assign `hidden`');
});

test('both hosts forward payload.hidden on ptyCreateTerminal', () => {
    assert.ok(bootstrapTs.includes('hidden: payload.hidden === true'),
        'standalone bootstrap.ts ptyCreateTerminal must forward payload.hidden');
    assert.ok(goPtyProjectionTs.includes('hidden: opts?.hidden === true'),
        'goPtyFleetProjection.ts must forward the hidden flag to the Go PTY host');
    assert.ok(/"hidden":\s*t\.hidden/.test(goPtyHostGo),
        'the Go PTY host must project `hidden` onto every listed row, or no host can split on it');
    assert.ok(/hidden:\s*boolField\(payload,\s*"hidden"\)/.test(goPtyHostGo),
        'the Go PTY host must read the hidden flag off the create payload');
});

test('both hosts emit hiddenTerminals from ptyListTerminals', () => {
    for (const [label, src] of [['bootstrap.ts', bootstrapTs], ['TaskViewerProvider.ts', tvpHiddenSplitTs]]) {
        assert.ok(src.includes('hiddenTerminals'),
            `${label} ptyListTerminals must return a hiddenTerminals array`);
        assert.ok(src.includes("hidden !== true"),
            `${label} must exclude hidden seats from the rendered terminals array`);
        assert.ok(src.includes("hidden === true"),
            `${label} must collect hidden seats into hiddenTerminals`);
    }
});

// ── Dock containment: transport.js switchPanel guard ─────────────────

test('transport.js derives isDockFrame from the /dock route, not ?dock=1', () => {
    // The dock is now its own document at /dock, not a /terminals?...&dock=1 iframe.
    // transport.js must detect the /dock route to keep the switchPanel guard live.
    assert.ok(/isDockFrame\s*=\s*window\.location\.pathname\s*===\s*'\/dock'/.test(transportJs),
        'transport.js must derive isDockFrame from location.pathname === /dock');
    assert.ok(!/URLSearchParams\(window\.location\.search\)\.get\('dock'\)/.test(transportJs),
        'transport.js must NOT parse ?dock=1 — that parameter is retired');
});

test('a dock document cannot switch the shell\'s main panel', () => {
    const senders = transportJs.split("postMessage({ type: 'switchPanel'");
    assert.strictEqual(senders.length, 3,
        'exactly two switchPanel senders are expected in transport.js (the verb map and __switchboardSwitchPanel)');
    for (const preamble of senders.slice(0, 2)) {
        const tail = preamble.slice(-600);
        assert.ok(/if \(isDockFrame\) \{/.test(tail),
            'every switchPanel sender must be dock-guarded — a verb-only fix leaves the global open');
        assert.ok(/console\.warn\(/.test(tail),
            'the guard must warn rather than fail silently — a silent no-op is a dead button to debug');
    }
    assert.ok(!/postMessage\(\{ type: 'switchPanel'[^)]*\}, '\*'\)/.test(transportJs),
        "switchPanel must post with location.origin, never '*'");
});

test('a non-dock panel can still switch the shell panel', () => {
    assert.ok(/postMessage\(\{ type: 'switchPanel', panel: 'tickets' \}, location\.origin\)/.test(linearJs),
        'linear.js must still post switchPanel — the guard is on dock frames, not on content-area panels');
    assert.ok(!/isDockFrame/.test(linearJs),
        'linear.js is a content-area panel and must not acquire a dock guard');
});

// ── terminals.js: isDockFrame removal ────────────────────────────────

test('terminals.js has no live isDockFrame variable or guards', () => {
    // The isDockFrame variable was removed; the viewport dep bag passes false.
    // Comments mentioning isDockFrame are allowed, but no live code reference.
    const nonCommentLines = terminalsJs
        .split('\n')
        .filter(l => !l.trim().startsWith('//'))
        .join('\n');
    assert.ok(!/let\s+isDockFrame/.test(nonCommentLines),
        'terminals.js must not declare an isDockFrame variable');
    assert.ok(!/isDockFrame\s*=\s*publishedMode/.test(nonCommentLines),
        'terminals.js must not read isDockFrame from the published mode');
    assert.ok(!/if\s*\(isDockFrame\)/.test(nonCommentLines),
        'terminals.js must not have any live isDockFrame guard');
    // The viewport dep bag must pass false.
    assert.ok(/isDockFrame:\s*false/.test(terminalsJs),
        'terminals.js must pass isDockFrame: false to the viewport dep bag');
});

test('terminals.js postFleetStateToShell no longer has a dock guard', () => {
    const fn = terminalsJs.match(/function\s+postFleetStateToShell\(\)\s*\{([\s\S]*?)\n\s{4}\}/);
    assert.ok(fn, 'postFleetStateToShell function must exist');
    const body = fn[1];
    assert.ok(body.includes('window.parent === window'),
        'the pop-out guard (window.parent === window) must exist');
    // The isDockFrame early return was removed — the dock is no longer a
    // /terminals iframe, so there is no second /terminals page to suppress.
    const nonCommentBody = body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/isDockFrame/.test(nonCommentBody),
        'postFleetStateToShell must not reference isDockFrame — the dock is now /dock');
});

test('terminals.html does not parse the dock=1 URL param', () => {
    assert.ok(!terminalsHtml.includes("p.get('dock')"),
        'terminals.html must not parse the dock param — it is retired');
    assert.ok(!/mode\.dock/.test(terminalsHtml),
        'terminals.html mode object must not include a dock field');
});

test('terminals.html mode script publishes solo/kanban/team only', () => {
    const bodyIdx = terminalsHtml.search(/<\/head\s*>/i);
    const sidebarIdx = terminalsHtml.indexOf('class="terminals-sidebar"');
    const scriptStart = terminalsHtml.indexOf('__SB_TERMINAL_MODE__', bodyIdx);
    assert.ok(scriptStart !== -1, 'terminals.html must publish __SB_TERMINAL_MODE__');
    assert.ok(scriptStart > bodyIdx && scriptStart < sidebarIdx,
        'the mode parse must sit inside <body> and BEFORE the sidebar markup');
    assert.ok(/var\s+mode\s*=\s*\{\s*solo:\s*null,\s*kanban:\s*false,\s*team:\s*null\s*\}/.test(terminalsHtml),
        'the mode object must declare solo, kanban, team only — no dock field');
});

// ── shell.js: theme fan-out to the dock frame ───────────────────────

test('applyThemeToAll references the dock frame', () => {
    const fn = shellJs.match(/function\s+applyThemeToAll\([\s\S]*?\n\s{4}\}/);
    assert.ok(fn, 'applyThemeToAll function must exist');
    assert.ok(/dockFrame/.test(fn[0]),
        'applyThemeToAll must fan the theme change to the dock frame');
    assert.ok(!/dockCliFrame/.test(fn[0]),
        'applyThemeToAll must not reference the removed dockCliFrame');
});

// ── shell.js: message listener ───────────────────────────────────────

test('shell.js listens for dockCloseRequested from the dock document', () => {
    assert.ok(shellJs.includes('dockCloseRequested'),
        'shell.js must listen for dockCloseRequested — the dock document asks the shell to close');
    const listener = block(shellJs, "window.addEventListener('message', (event) => {", "document.addEventListener('keydown'");
    assert.ok(listener.includes("data.type === 'dockCloseRequested'"),
        'the shell message listener must handle dockCloseRequested');
    // The dockCloseRequested arm must check origin.
    const dockCloseAt = listener.indexOf("data.type === 'dockCloseRequested'");
    const next = listener.indexOf('} else if (data.type', dockCloseAt);
    const armBody = listener.substring(dockCloseAt, next === -1 ? listener.length : next);
    assert.ok(armBody.includes('if (event.origin !== location.origin) { return; }'),
        'the dockCloseRequested arm must check event.origin');
});

test('shell.js relays dockTerminalExited to the dock iframe', () => {
    // The dock document's viewport posts dockTerminalExited to window.parent
    // (the shell) because its isDockFrame flag is true. The shell relays it
    // back to the dock iframe so dock.js can show the restart button.
    assert.ok(shellJs.includes('dockTerminalExited'),
        'shell.js must handle dockTerminalExited — it relays the exit to the dock iframe');
    const listener = block(shellJs, "window.addEventListener('message', (event) => {", "document.addEventListener('keydown'");
    const exitAt = listener.indexOf("data.type === 'dockTerminalExited'");
    assert.ok(exitAt !== -1, 'the shell message listener must handle dockTerminalExited');
    const next = listener.indexOf('} else if (data.type', exitAt);
    const armBody = listener.substring(exitAt, next === -1 ? listener.length : next);
    assert.ok(armBody.includes('if (event.origin !== location.origin) { return; }'),
        'the dockTerminalExited arm must check event.origin');
    assert.ok(/dockFrame\?\.contentWindow\?\.postMessage/.test(armBody),
        'the dockTerminalExited arm must relay to the dock iframe');
});

test('shell.js does not handle missionControlArmed', () => {
    // missionControlArmed moved to dock.js — the dock document has its own
    // transport WS and handles the armed state for the dock title.
    assert.ok(!shellJs.includes('missionControlArmed'),
        'shell.js must not handle missionControlArmed — moved to dock.js');
});

// ── Routing: /dock route and getDockHtml ─────────────────────────────

test('LocalApiServer.ts routes /dock to _handleServePanelById', () => {
    assert.ok(localApiServerTs.includes("pathname === '/dock'"),
        'LocalApiServer must route /dock');
    assert.ok(/_handleServePanelById\('dock'/.test(localApiServerTs),
        'LocalApiServer must call _handleServePanelById with dock');
});

test('headlessPanelHtml.ts has getDockHtml and case dock in getPanelHtmlById', () => {
    assert.ok(/export\s+function\s+getDockHtml/.test(headlessPanelHtmlTs),
        'headlessPanelHtml.ts must export getDockHtml');
    assert.ok(/case\s+'dock':\s*return\s+getDockHtml/.test(headlessPanelHtmlTs),
        'getPanelHtmlById must have a case for dock');
});

test('both composition roots inject terminal-token for the dock panel', () => {
    assert.ok(/id === 'terminals' \|\| id === 'dock'/.test(bootstrapTs),
        'bootstrap.ts must inject terminal-token for both terminals and dock');
    assert.ok(/id === 'terminals' \|\| id === 'dock'/.test(tvpHiddenSplitTs),
        'TaskViewerProvider.ts must inject terminal-token for both terminals and dock');
});

// ── Composition roots & LocalApiServer contracts ─────────────────────

test('POST /mission-control/start endpoint is present in LocalApiServer.ts', () => {
    assert.ok(localApiServerTs.includes("'/mission-control/start'"),
        'LocalApiServer must route /mission-control/start');
    assert.ok(localApiServerTs.includes('_handleMissionControlStart'),
        '_handleMissionControlStart must exist in LocalApiServer');
});

test('missionControlStart is wired in TaskViewerProvider.ts and bootstrap.ts', () => {
    assert.ok(/missionControlStart:\s*async/.test(tvpHiddenSplitTs),
        'TaskViewerProvider must wire missionControlStart');
    assert.ok(/missionControlStart:\s*async/.test(bootstrapTs),
        'bootstrap.ts must wire missionControlStart');
});

test('no string-prefix test against dock- on a fleet entry (seat name is opaque)', () => {
    assert.ok(!/\.startsWith\(['"]dock-/.test(dockJs),
        'dock.js must not test fleet entries with startsWith(\'dock-\') — the seat name is opaque');
    assert.ok(!/\.indexOf\(['"]dock-/.test(dockJs),
        'dock.js must not test fleet entries with indexOf(\'dock-\') — the seat name is opaque');
});

// ── kanban dock mode is still handled in terminals.js ────────────────

test('kanban dock mode is handled in terminals.js and CSS in terminals.html', () => {
    assert.ok(terminalsHtml.includes('body.is-kanban .terminals-sidebar'),
        'terminals.html must hide .terminals-sidebar for body.is-kanban');
    assert.ok(terminalsHtml.includes('body.is-kanban .layout-toolbar'),
        'terminals.html must hide .layout-toolbar for body.is-kanban');
    assert.ok(terminalsHtml.includes('body.is-kanban #empty-state'),
        'terminals.html must hide #empty-state for body.is-kanban');
    assert.ok(terminalsHtml.includes('body.is-kanban #pane-grid'),
        'terminals.html must style #pane-grid for body.is-kanban');
    assert.ok(terminalsHtml.includes("p.get('kanban') === '1'"),
        'terminals.html\'s body-top mode script must parse the kanban query param');
    assert.ok(terminalsJs.includes('isKanbanDock = publishedMode.kanban === true'),
        'terminals.js must derive isKanbanDock from the published mode');
    assert.ok(/startFleetPoll\(\)\s*\{[^}]*isKanbanDock/.test(terminalsJs),
        'startFleetPoll must be suppressed in kanban mode');
    assert.ok(/refreshAgentGroupsForShell\(\)\s*\{[^}]*isKanbanDock/.test(terminalsJs),
        'refreshAgentGroupsForShell must be suppressed in kanban mode');
    assert.ok(/refreshTeamQueueDepths\(\)\s*\{[^}]*isKanbanDock/.test(terminalsJs),
        'refreshTeamQueueDepths must be suppressed in kanban mode');
    assert.ok(terminalsHtml.includes('btn-kanban-toolbar'),
        'btn-kanban-toolbar in terminals.html must be preserved');
});

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\nResult: ${passed} passed, ${failed} failed`);
