'use strict';

/**
 * Contract tests for the "Open Terminal Grid" entry point.
 *
 * These are the four checks named in the plan's Verification / Automated
 * section (`.switchboard/plans/vscode-terminals-view-onto-pty-fleet.md`).
 * Every one of them guards a decision that is invisible on inspection and
 * whose regression looks like an improvement:
 *
 *   1. readiness is checked BEFORE a URL is built — never a URI interpolated
 *      from an undefined port, never a silent dead click (PRD contract #6);
 *   2. the port comes from the live LocalApiServer and the URI goes through
 *      asExternalUri, so remote hosts resolve the loopback tunnel;
 *   3. the target is vscode.env.openExternal and NEVER simpleBrowser.show —
 *      Simple Browser is a webview wrapping a cross-origin iframe, which
 *      loses clipboard and Ctrl+C (microsoft/vscode#182642, #129178). This is
 *      the specific "obvious improvement" the plan exists to prevent, so it
 *      is pinned by source scan rather than by comment alone;
 *   4. the new panel button is NOT joined to #createAgentGrid's state machine
 *      — updateTerminalButtonState() relabels that button to CLEAR TERMINALS,
 *      and the new one has exactly one label, always.
 *
 * Run with: node src/test/terminal-grid-entry-point.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const extensionTs = fs.readFileSync(path.join(__dirname, '../extension.ts'), 'utf8');
const taskViewerTs = fs.readFileSync(path.join(__dirname, '../services/TaskViewerProvider.ts'), 'utf8');
const implementationHtml = fs.readFileSync(path.join(__dirname, '../webview/implementation.html'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));

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

/** Body of the openTerminalGrid command handler, bounded by the next `const` at
 *  the same indentation — the registration idiom used throughout activate(). */
function commandHandlerBody() {
    const start = extensionTs.indexOf("registerSwitchboardCommand('switchboard.openTerminalGrid'");
    assert.ok(start > 0, 'switchboard.openTerminalGrid must be registered in extension.ts');
    const rest = extensionTs.slice(start);
    const end = rest.search(/\n    const\s/);
    return end === -1 ? rest : rest.slice(0, end);
}

console.log('\n── Terminal Grid entry point contract ──\n');

// 1. Readiness is checked before anything else, and the handler returns.

test('the handler gates on readiness and returns before building a URL', () => {
    const body = commandHandlerBody();
    const guardIdx = body.search(/if\s*\(!\w+\s*\|\|\s*!\w+\.ready\s*\|\|\s*!\w+\.apiPort\)/);
    assert.ok(guardIdx !== -1,
        'the handler must gate on the { ready, apiPort } pair before doing anything else');
    const returnIdx = body.indexOf('return;', guardIdx);
    assert.ok(returnIdx !== -1, 'the not-ready branch must return');
    // A reason, not a silent no-op (PRD contract #6 — no dead click).
    const guardBlock = body.slice(guardIdx, returnIdx);
    assert.match(guardBlock, /show(Warning|Error|Information)Message/,
        'the not-ready branch must report a reason, never open nothing silently');
    // And the URL must be built strictly AFTER the guard.
    const uriIdx = body.indexOf('Uri.parse');
    assert.ok(uriIdx > returnIdx,
        'the URI must be constructed only after the readiness guard has returned — never from an undefined port');
});

test('getTerminalGridState reads the live LocalApiServer port, not a cached scalar', () => {
    const start = taskViewerTs.indexOf('public getTerminalGridState()');
    assert.ok(start > 0, 'getTerminalGridState must exist on TaskViewerProvider');
    const body = taskViewerTs.slice(start, start + 900);
    assert.match(body, /_localApiServer\?\.getPort\(\)/,
        'the port must come from LocalApiServer.getPort() at call time');
    assert.match(body, /_localApiServer\?\.isListening\(\)/,
        'readiness must include the API server actually listening');
    assert.match(body, /isPtyAvailable\(\)/,
        'readiness must include pty availability — the grid is useless without a fleet');
    // The pair is returned together so it cannot be read half-updated across an await.
    assert.match(body, /return\s*\{[\s\S]*apiPort[\s\S]*ready[\s\S]*\}/,
        'apiPort and ready must be returned as one object, not read separately');
});

// 2. The URI is tunnel-resolved.

test('the URI is passed through asExternalUri before openExternal', () => {
    const body = commandHandlerBody();
    const asExternalIdx = body.indexOf('asExternalUri');
    const openExternalIdx = body.indexOf('openExternal');
    assert.ok(asExternalIdx !== -1,
        'the URI must go through vscode.env.asExternalUri — under Remote-SSH / Dev Containers / Codespaces the extension host\'s 127.0.0.1 is not the user\'s machine');
    assert.ok(openExternalIdx !== -1, 'the handler must call vscode.env.openExternal');
    assert.ok(asExternalIdx < openExternalIdx,
        'asExternalUri must resolve the tunnel BEFORE openExternal is handed the URI');
});

// 3. The Simple Browser prohibition. THIS is the regression the plan exists for.

test('the implementation uses openExternal and never simpleBrowser.show', () => {
    const body = commandHandlerBody();
    assert.match(body, /vscode\.env\.openExternal\(/,
        'the grid must open in the system browser via vscode.env.openExternal');
    // Scan CODE, not comments — the prohibition must be *named* in a comment at
    // the call site (asserted below) while being absent from the executable text.
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/simpleBrowser/i.test(code),
        'simpleBrowser.show is a webview wrapping a cross-origin iframe: navigator.clipboard throws and Electron eats Cmd/Ctrl+C before it reaches the frame (microsoft/vscode#182642, #129178). A terminal that cannot be interrupted is not a terminal. Do NOT "improve" this.');
    // The reason must live at the call site, not only in the plan file.
    const comments = body.match(/\/\/[^\n]*/g)?.join('\n') || '';
    assert.match(comments, /182642|129178|Simple Browser|simpleBrowser/,
        'the prohibition must be commented at the call site so the next reader inherits the reason, not just the rule');
});

// 4. The panel button is a plain action, outside the existing state machine.

test('implementation.html has both buttons and only #createAgentGrid is stateful', () => {
    assert.ok(implementationHtml.includes('id="createAgentGrid"'),
        '#createAgentGrid must still exist');
    assert.ok(implementationHtml.includes('id="openTerminalGrid"'),
        '#openTerminalGrid must exist beside it');
    const fnStart = implementationHtml.indexOf('function updateTerminalButtonState()');
    assert.ok(fnStart > 0, 'updateTerminalButtonState must exist');
    // Bound the function at the next top-level `function` declaration at the
    // same indentation — the file's own idiom for its inline script.
    const rest = implementationHtml.slice(fnStart + 1);
    const relEnd = rest.search(/\n        (?:function|async function)\s/);
    const fnBody = relEnd === -1 ? rest : rest.slice(0, relEnd);
    assert.ok(!fnBody.includes('openTerminalGrid'),
        'updateTerminalButtonState must NOT touch #openTerminalGrid — it relabels its button to CLEAR TERMINALS, and the grid button has one label, always');
});

test('the command is contributed in package.json', () => {
    const cmds = (packageJson.contributes && packageJson.contributes.commands) || [];
    const entry = cmds.find(c => c.command === 'switchboard.openTerminalGrid');
    assert.ok(entry, 'switchboard.openTerminalGrid must appear in contributes.commands');
    assert.ok(/Terminal Grid/.test(entry.title || ''),
        'the contributed command must be titled for the command palette');
    // No views entry — nothing renders inside VS Code.
    const views = JSON.stringify((packageJson.contributes && packageJson.contributes.views) || {});
    assert.ok(!/openTerminalGrid|terminalGrid/i.test(views),
        'no contributes.views entry — the fleet stays in the browser, nothing renders inside VS Code');
});

test('the status-bar item and the Hub entry both exist (compactMode defaults to true)', () => {
    // compactMode defaults to true, which hides every individual item and shows
    // only the Hub. Shipping only the standalone item would make the button
    // invisible on a default install.
    assert.match(extensionTs, /terminalGridStatusBarItem\s*=\s*vscode\.window\.createStatusBarItem\(\s*vscode\.StatusBarAlignment\.Right,\s*97\.5\s*\)/,
        'the standalone status-bar item must sit at Right/97.5 — 98 is already a two-way collision (Agents + Design)');
    assert.match(extensionTs, /label:\s*'\$\(browser\) Terminal Grid'/,
        'the Hub quick-pick must carry a Terminal Grid entry — that is what the default install sees');
    // It is a terminal control and must appear/disappear with Agents/Clear/Reset.
    assert.ok(extensionTs.includes('terminalGridStatusBarItem.show()'),
        'the item must be shown under the showTerminalControls gate');
    assert.ok(extensionTs.includes('terminalGridStatusBarItem.hide()'),
        'the item must be hidden with the other terminal controls and in compact mode');
    assert.match(extensionTs, /enabledCount\s*\+=\s*4/,
        'the compact-branch terminal-control count must be 4, not 3 — it drives whether the Hub icon appears at all');
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
