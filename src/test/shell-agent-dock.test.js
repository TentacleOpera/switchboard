'use strict';

/**
 * Contract tests for the right-hand agent dock in the browser shell.
 *
 * Source-text contracts, not behavioural ones — the dock is browser-only DOM
 * code in an IIFE with no export surface, and every failure mode here is a
 * rendering or lifecycle defect a headless run cannot observe. What CAN be
 * pinned is the handful of decisions that are invisible on inspection and
 * were each wrong in a first pass of the plan:
 *
 *   - the dock is a SIBLING after #content, not a child of it (overlay vs dock)
 *   - visibility is class-driven (.is-visible), never [hidden] alone — the UA
 *     [hidden]{display:none} rule loses the cascade to any author `display`
 *     declaration (edge case 14)
 *   - the dock width floor is 648px (80 columns × 7.80px + 24px chrome) —
 *     below it the agent CLI inside the dock folds its own diffs (edge case 13)
 *   - the dock toggle glyph is NOT nav-terminals.svg (edge case 17)
 *   - the dock frame's fleet relay is suppressed (edge case 2)
 *   - the seat name is treated as opaque — no 'dock-' prefix test (edge case 4)
 *   - no ptyCreateTerminal call outside startDockTerminal (no implicit create)
 *
 * Run with: node src/test/shell-agent-dock.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const shellJs = fs.readFileSync(path.join(__dirname, '../webview/shell.js'), 'utf8');
const shellHtml = fs.readFileSync(path.join(__dirname, '../webview/shell.html'), 'utf8');
const terminalsJs = fs.readFileSync(path.join(__dirname, '../webview/terminals.js'), 'utf8');

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
    // The dock must NOT be inside #content — it is a direct child of body.
    // Verify by checking that #content's closing </div> appears before #agent-dock.
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

// ── shell.html: visibility via class, not [hidden] alone (edge case 14) ──

test('#dock-empty uses .is-visible, not [hidden] alone', () => {
    assert.ok(/#dock-empty\s*\{[^}]*display:\s*none/.test(shellHtml),
        '#dock-empty must declare a base display:none');
    assert.ok(/#dock-empty\.is-visible\s*\{[^}]*display:\s*flex/.test(shellHtml),
        '#dock-empty.is-visible must declare display:flex');
});

test('#dock-frame uses .is-visible, not [hidden] alone', () => {
    // Both dock frames share one rule, so the selector may be grouped:
    //   #dock-frame,\n#dock-kanban-frame { display: none; ... }
    assert.ok(/#dock-frame\s*(?:,\s*#[a-z-]+\s*)*\{[^}]*display:\s*none/.test(shellHtml),
        '#dock-frame must declare a base display:none');
    assert.ok(/#dock-frame\.is-visible\s*(?:,\s*#[a-z-]+\.is-visible\s*)*\{[^}]*display:\s*block/.test(shellHtml),
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
    // Both must carry the nonce placeholder.
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
    // updateDockViableGating must check window.innerWidth against DOCK_VIABLE_MIN.
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

// ── shell.html & shell.js: CLI input and dock start ─────────────────

test('#dock-empty contains #dock-cli-input and #dock-start', () => {
    assert.ok(shellHtml.includes('id="dock-cli-input"'), '#dock-cli-input must exist in shell.html');
    assert.ok(shellHtml.includes('id="dock-start"'), '#dock-start must exist in shell.html');
});

test('#dock-restart exists in #dock-header', () => {
    assert.ok(shellHtml.includes('id="dock-restart"'), '#dock-restart must exist in shell.html');
    const headerIdx = shellHtml.indexOf('id="dock-header"');
    const restartIdx = shellHtml.indexOf('id="dock-restart"');
    const emptyIdx = shellHtml.indexOf('id="dock-empty"');
    assert.ok(headerIdx < restartIdx && restartIdx < emptyIdx, '#dock-restart must sit inside #dock-header');
});

test('startDockTerminal saves startup commands and spawns hidden terminal', () => {
    const startFn = shellJs.match(/async\s+function\s+startDockTerminal\(\)\s*\{([\s\S]*?)\n\s{4}\}/);
    assert.ok(startFn, 'startDockTerminal function must exist in shell.js');
    const body = startFn[1];
    assert.ok(body.includes('/kanban/verb/saveStartupCommands'),
        'startDockTerminal must call POST /kanban/verb/saveStartupCommands');
    assert.ok(body.includes('/terminals/verb/ptyCreateTerminal'),
        'startDockTerminal must call POST /terminals/verb/ptyCreateTerminal');
    assert.ok(body.includes('hidden: true'),
        'startDockTerminal must pass hidden: true to ptyCreateTerminal');
});

test('checkDockLiveness reads hiddenTerminals from ptyListTerminals', () => {
    const liveFn = shellJs.match(/async\s+function\s+checkDockLiveness\(\)\s*\{([\s\S]*?)\n\s{4}\}/);
    assert.ok(liveFn, 'checkDockLiveness function must exist in shell.js');
    const body = liveFn[1];
    assert.ok(body.includes('/terminals/verb/ptyListTerminals'),
        'checkDockLiveness must call ptyListTerminals');
    assert.ok(body.includes('hiddenTerminals'),
        'checkDockLiveness must read hiddenTerminals from response');
});

test('showDockEmptyState calls /kanban/verb/getStartupCommands', () => {
    const emptyFn = shellJs.match(/async\s+function\s+showDockEmptyState\(\)\s*\{([\s\S]*?)\n\s{4}\}/);
    assert.ok(emptyFn, 'showDockEmptyState function must exist in shell.js');
    const body = emptyFn[1];
    assert.ok(body.includes('/kanban/verb/getStartupCommands'),
        'showDockEmptyState must call /kanban/verb/getStartupCommands');
});

test('dockSeatName loses its parameter in shell.js', () => {
    assert.ok(/function\s+dockSeatName\(\)\s*\{/.test(shellJs),
        'dockSeatName must take no arguments');
});

// ── Composition roots & LocalApiServer contracts ─────────────────────

test('POST /mission-control/start endpoint is present in LocalApiServer.ts', () => {
    const apiServerTs = fs.readFileSync(path.join(__dirname, '../services/LocalApiServer.ts'), 'utf8');
    assert.ok(apiServerTs.includes("'/mission-control/start'"),
        'LocalApiServer must route /mission-control/start');
    assert.ok(apiServerTs.includes('_handleMissionControlStart'),
        '_handleMissionControlStart must exist in LocalApiServer');
});

test('missionControlStart is wired in TaskViewerProvider.ts and bootstrap.ts', () => {
    const tvpTs = fs.readFileSync(path.join(__dirname, '../services/TaskViewerProvider.ts'), 'utf8');
    const bootTs = fs.readFileSync(path.join(__dirname, '../standalone/bootstrap.ts'), 'utf8');
    assert.ok(/missionControlStart:\s*async/.test(tvpTs),
        'TaskViewerProvider must wire missionControlStart');
    assert.ok(/missionControlStart:\s*async/.test(bootTs),
        'bootstrap.ts must wire missionControlStart');
});

test('no string-prefix test against dock- on a fleet entry (seat name is opaque)', () => {
    // The dock must not key on the 'dock-' prefix — PtyFleetService discards
    // the requested name on collision and falls back to the <role>-N series.
    // dockSeatName() is the request-time default only; nothing reads it back.
    // Assert no startsWith('dock-') or indexOf('dock-') on fleet entries.
    assert.ok(!/\.startsWith\(['"]dock-/.test(shellJs),
        'the dock must not test fleet entries with startsWith(\'dock-\') — the seat name is opaque');
    assert.ok(!/\.indexOf\(['"]dock-/.test(shellJs),
        'the dock must not test fleet entries with indexOf(\'dock-\') — the seat name is opaque');
});

// ── shell.js: theme fan-out to the dock frame (edge case 10) ────────

test('applyThemeToAll references the dock frame', () => {
    const fn = shellJs.match(/function\s+applyThemeToAll\([\s\S]*?\n\s{4}\}/);
    assert.ok(fn, 'applyThemeToAll function must exist');
    assert.ok(/dockFrame/.test(fn[0]),
        'applyThemeToAll must fan the theme change to the dock frame');
});

// ── shell.js: setDockOpen assigns width from persisted state ────────

test('setDockOpen assigns dockEl.style.width from persisted state', () => {
    const fn = shellJs.match(/function\s+setDockOpen\([\s\S]*?\n\s{4}\}/);
    assert.ok(fn, 'setDockOpen function must exist');
    assert.ok(/dockEl\.style\.width\s*=/.test(fn[0]),
        'setDockOpen must assign dockEl.style.width from persisted state — otherwise the saved width is write-only');
    assert.ok(/readDockState\(\)\.width/.test(fn[0]),
        'setDockOpen must read the width from readDockState()');
});

// ── terminals.js: dock relay suppression (edge case 2) ──────────────

test('terminals.js returns early from postFleetStateToShell on the dock flag', () => {
    const fn = terminalsJs.match(/function\s+postFleetStateToShell\(\)\s*\{([\s\S]*?)\n\s{4}\}/);
    assert.ok(fn, 'postFleetStateToShell function must exist');
    const body = fn[1];
    const parentGuardIdx = body.indexOf('window.parent === window');
    const dockGuardIdx = body.indexOf('isDockFrame');
    const mapIdx = body.indexOf('fleetList.map');
    assert.ok(parentGuardIdx !== -1, 'the pop-out guard (window.parent === window) must exist');
    assert.ok(dockGuardIdx !== -1, 'the dock guard (isDockFrame) must exist');
    assert.ok(mapIdx !== -1, 'fleetList.map must exist');
    assert.ok(parentGuardIdx < dockGuardIdx,
        'the dock guard must sit AFTER the window.parent === window guard');
    assert.ok(dockGuardIdx < mapIdx,
        'the dock guard must sit BEFORE the fleetList.map call');
});

test('terminals.js parses the dock=1 URL param', () => {
    assert.ok(/isDockFrame\s*=\s*urlParams\.get\(['"]dock['"]\)\s*===\s*['"]1['"]/.test(terminalsJs),
        'terminals.js must parse isDockFrame from the dock=1 URL param');
});

test('dock contains two iframes (agent + kanban) and tab strip in header', () => {
    assert.ok(shellHtml.includes('id="dock-frame"'), '#dock-frame must exist in shell.html');
    assert.ok(shellHtml.includes('id="dock-kanban-frame"'), '#dock-kanban-frame must exist in shell.html');
    assert.ok(shellHtml.includes('id="dock-tabs"'), '#dock-tabs must exist in shell.html');
    assert.ok(shellHtml.includes('id="dock-tab-agent"'), '#dock-tab-agent must exist in shell.html');
    assert.ok(shellHtml.includes('id="dock-tab-kanban"'), '#dock-tab-kanban must exist in shell.html');

    // Tab strip ahead of title and close
    const tabsIdx = shellHtml.indexOf('id="dock-tabs"');
    const titleIdx = shellHtml.indexOf('id="dock-title"');
    const closeIdx = shellHtml.indexOf('id="dock-close"');
    assert.ok(tabsIdx < titleIdx && titleIdx < closeIdx,
        'tab strip must sit ahead of #dock-title and #dock-close in #dock-header');

    // Pointer-events rule covers both frames
    assert.ok(/body\.dock-dragging\s+#dock-kanban-frame/.test(shellHtml),
        'body.dock-dragging must neutralise #dock-kanban-frame pointer events');
});

test('sb.agentDock persistence handles activeTab and defaults to agent', () => {
    const readFn = shellJs.match(/function\s+readDockState\(\)\s*\{([\s\S]*?)\n\s{4}\}/);
    assert.ok(readFn, 'readDockState function must exist');
    assert.ok(readFn[1].includes('activeTab:'), 'readDockState must include activeTab');
    assert.ok(readFn[1].includes("'agent'"), 'activeTab must default to agent');
    assert.ok(shellJs.includes('setDockActiveTab'), 'setDockActiveTab must exist in shell.js');
});

test('applyThemeToAll fans out to both dockFrame and dockKanbanFrame', () => {
    const fn = shellJs.match(/function\s+applyThemeToAll\([\s\S]*?\n\s{4}\}/);
    assert.ok(fn, 'applyThemeToAll function must exist');
    assert.ok(/dockFrame/.test(fn[0]) && /dockKanbanFrame/.test(fn[0]),
        'applyThemeToAll must fan out theme changes to BOTH dock frames');
});

test('kanban dock mode is handled in terminals.js and CSS in terminals.html', () => {
    const terminalsHtml = fs.readFileSync(path.join(__dirname, '../webview/terminals.html'), 'utf8');
    assert.ok(terminalsHtml.includes('body.is-kanban .terminals-sidebar'),
        'terminals.html must hide .terminals-sidebar for body.is-kanban');
    assert.ok(terminalsHtml.includes('body.is-kanban .layout-toolbar'),
        'terminals.html must hide .layout-toolbar for body.is-kanban');
    assert.ok(terminalsHtml.includes('body.is-kanban #empty-state'),
        'terminals.html must hide #empty-state for body.is-kanban');
    assert.ok(terminalsHtml.includes('body.is-kanban #pane-grid'),
        'terminals.html must style #pane-grid for body.is-kanban');

    // Precedence and parsing
    assert.ok(terminalsJs.includes("urlParams.get('kanban') === '1'"),
        'terminals.js must parse kanban query param');

    // Poll suppressions in kanban mode
    assert.ok(/startFleetPoll\(\)\s*\{[^}]*isKanbanDock/.test(terminalsJs),
        'startFleetPoll must be suppressed in kanban mode');
    assert.ok(/refreshAgentGroupsForShell\(\)\s*\{[^}]*isKanbanDock/.test(terminalsJs),
        'refreshAgentGroupsForShell must be suppressed in kanban mode');
    assert.ok(/refreshTeamQueueDepths\(\)\s*\{[^}]*isKanbanDock/.test(terminalsJs),
        'refreshTeamQueueDepths must be suppressed in kanban mode');

    // In-grid kanban toolbar button is preserved
    assert.ok(terminalsHtml.includes('btn-kanban-toolbar'),
        'btn-kanban-toolbar in terminals.html must be preserved');
});

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
