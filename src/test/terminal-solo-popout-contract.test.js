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
