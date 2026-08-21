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
    assert.ok(/#dock-frame\s*\{[^}]*display:\s*none/.test(shellHtml),
        '#dock-frame must declare a base display:none');
    assert.ok(/#dock-frame\.is-visible\s*\{[^}]*display:\s*block/.test(shellHtml),
        '#dock-frame.is-visible must declare display:block');
});

test('#dock-role-menu uses .is-visible, not [hidden] alone', () => {
    assert.ok(/#dock-role-menu\s*\{[^}]*display:\s*none/.test(shellHtml),
        '#dock-role-menu must declare a base display:none');
    assert.ok(/#dock-role-menu\.is-visible\s*\{[^}]*display:\s*block/.test(shellHtml),
        '#dock-role-menu.is-visible must declare display:block');
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

test('the dock toggle is built only inside a frames.has(terminals) guard', () => {
    const manifest = shellJs.indexOf('function renderManifest(manifest) {');
    const dockToggleIdx = shellJs.indexOf('buildDockToggle()', manifest);
    assert.ok(dockToggleIdx !== -1, 'buildDockToggle must be called in renderManifest');
    // Check the guard precedes the call.
    const region = shellJs.substring(manifest, dockToggleIdx + 50);
    assert.ok(/frames\.has\('terminals'\)/.test(region),
        'the dock toggle must be gated on frames.has(\'terminals\')');
});

test('the dock toggle glyph is NOT nav-terminals.svg (edge case 17)', () => {
    const toggleFn = shellJs.match(/function\s+buildDockToggle\(\)\s*\{([\s\S]*?)\n\s{4}\}/);
    assert.ok(toggleFn, 'buildDockToggle function must exist');
    assert.ok(/nav-dock\.svg/.test(toggleFn[1]),
        'the dock toggle must use nav-dock.svg');
    assert.ok(!/nav-terminals\.svg/.test(toggleFn[1]),
        'the dock toggle must NOT reuse nav-terminals.svg — the Terminals panel already uses that glyph');
});

// ── shell.js: no implicit create (edge case 4) ──────────────────────

test('no ptyCreateTerminal call outside startDockTerminal', () => {
    // Every ptyCreateTerminal fetch must be inside startDockTerminal.
    const calls = [];
    const re = /ptyCreateTerminal/g;
    let m;
    while ((m = re.exec(shellJs)) !== null) {
        // Find the enclosing function by scanning backwards for 'function NAME'.
        const before = shellJs.substring(0, m.index);
        const fnMatch = before.match(/function\s+(\w+)\s*\([^)]*\)\s*\{/g);
        const lastFn = fnMatch ? fnMatch[fnMatch.length - 1].match(/function\s+(\w+)/)[1] : '<top>';
        calls.push(lastFn);
    }
    assert.ok(calls.length > 0, 'at least one ptyCreateTerminal call must exist (in startDockTerminal)');
    for (const fn of calls) {
        assert.strictEqual(fn, 'startDockTerminal',
            `ptyCreateTerminal must only be called inside startDockTerminal, not ${fn} — no implicit create on shell load`);
    }
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

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
