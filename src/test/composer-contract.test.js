'use strict';

/**
 * Contract test for the Composer feature: compose a prompt locally and
 * deliver it to any active terminal via the host-routed sendToTerminal verb,
 * without switching the active pane (which forces an xterm.js rerender).
 *
 * Mirrors the terminal-pane-paste-contract.test.js pattern (static source
 * assertions + a JSDOM runtime check). Covers BOTH composition roots:
 *   - terminals panel (terminals.html / terminals.js)
 *   - command view panel (command.html / command.js)
 *
 * Run with:
 *   node src/test/composer-contract.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TERMINALS_JS = fs.readFileSync(path.join(__dirname, '../webview/terminals.js'), 'utf8');
const TERMINALS_HTML = fs.readFileSync(path.join(__dirname, '../webview/terminals.html'), 'utf8');
const COMMAND_JS = fs.readFileSync(path.join(__dirname, '../webview/command.js'), 'utf8');
const COMMAND_HTML = fs.readFileSync(path.join(__dirname, '../webview/command.html'), 'utf8');

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

/**
 * Extract the body of a top-level function from a JS source string by name.
 * Returns the substring from the function's opening `{` to the matching `}`.
 */
function extractFunctionBody(src, name) {
    const marker = `function ${name}(`;
    const start = src.indexOf(marker);
    assert.ok(start !== -1, `${name} not found in source`);
    let i = src.indexOf('{', start);
    assert.ok(i !== -1, `${name}: opening brace not found`);
    let depth = 1;
    i++;
    while (i < src.length && depth > 0) {
        if (src[i] === '{') { depth++; }
        else if (src[i] === '}') { depth--; }
        i++;
    }
    return src.slice(start, i);
}

// ── terminals.html structural assertions ────────────────────────────

test('terminals.html: #btn-composer exists inside .sidebar-ops', () => {
    const sidebarOpsStart = TERMINALS_HTML.indexOf('class="sidebar-ops"');
    assert.ok(sidebarOpsStart !== -1, '.sidebar-ops container not found');
    // Find the end of the sidebar-ops block (its closing </div>). The button
    // must appear after btn-link-up within that block.
    const btnLinkUpIdx = TERMINALS_HTML.indexOf('id="btn-link-up"', sidebarOpsStart);
    assert.ok(btnLinkUpIdx !== -1, '#btn-link-up not found in sidebar-ops');
    const btnComposerIdx = TERMINALS_HTML.indexOf('id="btn-composer"', btnLinkUpIdx);
    assert.ok(btnComposerIdx !== -1, '#btn-composer must appear after #btn-link-up in sidebar-ops');
});

test('terminals.html: #composer-modal exists with a terminal selector and a textarea', () => {
    assert.ok(TERMINALS_HTML.includes('id="composer-modal"'),
        '#composer-modal element must exist');
    assert.ok(TERMINALS_HTML.includes('id="composer-terminal-select"'),
        '#composer-terminal-select must exist inside the composer modal');
    assert.ok(TERMINALS_HTML.includes('id="composer-input"'),
        '#composer-input textarea must exist inside the composer modal');
});

test('terminals.html: .composer-modal CSS uses position: fixed', () => {
    const cssMatch = TERMINALS_HTML.match(/\.composer-modal\s*\{([^}]*)\}/);
    assert.ok(cssMatch, '.composer-modal CSS rule must exist');
    assert.ok(cssMatch[1].includes('position: fixed'),
        '.composer-modal must use position: fixed (sidebar-level modal)');
    assert.ok(TERMINALS_HTML.includes('.composer-modal[hidden] { display: none; }'),
        '.composer-modal[hidden] override is mandatory (display:flex beats UA hidden)');
});

test('terminals.html: #btn-composer is in the team-scoped and controller-scoped hide rules', () => {
    assert.ok(TERMINALS_HTML.includes('body.is-team-scoped #btn-composer'),
        '#btn-composer must be hidden in team-scoped mode (alongside #btn-link-up)');
    assert.ok(TERMINALS_HTML.includes('body.is-controller-scoped #btn-composer'),
        '#btn-composer must be hidden in controller-scoped mode (alongside #btn-link-up)');
});

// ── terminals.js delivery assertions ─────────────────────────────────

test('terminals.js: openComposerModal is a function', () => {
    assert.ok(/function openComposerModal\s*\(/.test(TERMINALS_JS),
        'openComposerModal must be a function in terminals.js');
});

test('terminals.js: delivery posts to /terminals/verb/sendToTerminal via fetch', () => {
    const body = extractFunctionBody(TERMINALS_JS, 'deliverComposerPrompt');
    assert.ok(body.includes("fetch('/terminals/verb/sendToTerminal'"),
        'deliverComposerPrompt must POST to /terminals/verb/sendToTerminal');
});

test('terminals.js: delivery payload includes standingOrders: false', () => {
    const body = extractFunctionBody(TERMINALS_JS, 'deliverComposerPrompt');
    assert.ok(body.includes('standingOrders: false'),
        'composer delivery must pass standingOrders: false (sendToTerminal hardcodes kind:dispatch)');
});

test('terminals.js: composer delivery does NOT use postMessage', () => {
    const body = extractFunctionBody(TERMINALS_JS, 'deliverComposerPrompt');
    assert.ok(!body.includes('postMessage'),
        'composer delivery must use fetch, never postMessage (terminals.js has no acquireVsCodeApi)');
});

test('terminals.js: composer delivery does NOT use term.paste or ws.send', () => {
    const body = extractFunctionBody(TERMINALS_JS, 'deliverComposerPrompt');
    assert.ok(!body.includes('term.paste'),
        'composer delivery must use the host-routed sendToTerminal verb, not the local term.paste');
    assert.ok(!body.includes('ws.send'),
        'composer delivery must use fetch, never raw ws.send');
});

test('terminals.js: composer code path never touches navigator.clipboard', () => {
    for (const name of ['openComposerModal', 'deliverComposerPrompt', 'updateComposerSendButton']) {
        const body = extractFunctionBody(TERMINALS_JS, name);
        assert.ok(!body.includes('navigator.clipboard'),
            `${name} must never reference navigator.clipboard`);
        assert.ok(!body.includes('readText'),
            `${name} must never call readText`);
    }
});

test('terminals.js: composer code path has no confirmation gates', () => {
    for (const name of ['openComposerModal', 'deliverComposerPrompt', 'closeComposerModal']) {
        const body = extractFunctionBody(TERMINALS_JS, name);
        assert.ok(!/\bconfirm\s*\(/.test(body),
            `${name}: no confirm() call is allowed (forbidden per CLAUDE.md)`);
        assert.ok(!body.includes('window.confirm'),
            `${name}: no window.confirm is allowed`);
        assert.ok(!body.includes('showWarningMessage'),
            `${name}: no showWarningMessage is allowed`);
    }
});

// ── command.html structural assertions ──────────────────────────────

test('command.html: composer button exists in the dispatch view', () => {
    assert.ok(COMMAND_HTML.includes('id="btn-composer"'),
        '#btn-composer must exist in command.html');
    const dispatchStart = COMMAND_HTML.indexOf('id="view-dispatch"');
    assert.ok(dispatchStart !== -1, '#view-dispatch section not found');
    const btnComposerIdx = COMMAND_HTML.indexOf('id="btn-composer"', dispatchStart);
    assert.ok(btnComposerIdx !== -1,
        '#btn-composer must appear within the dispatch view section');
});

test('command.html: #composer-modal exists with a terminal selector and a textarea', () => {
    assert.ok(COMMAND_HTML.includes('id="composer-modal"'),
        '#composer-modal element must exist in command.html');
    assert.ok(COMMAND_HTML.includes('id="composer-terminal-select"'),
        '#composer-terminal-select must exist inside the command composer modal');
    assert.ok(COMMAND_HTML.includes('id="composer-input"'),
        '#composer-input textarea must exist inside the command composer modal');
});

test('command.html: .composer-modal CSS uses position: fixed', () => {
    const cssMatch = COMMAND_HTML.match(/\.composer-modal\s*\{([^}]*)\}/);
    assert.ok(cssMatch, '.composer-modal CSS rule must exist in command.html');
    assert.ok(cssMatch[1].includes('position: fixed'),
        '.composer-modal must use position: fixed in command.html');
    assert.ok(COMMAND_HTML.includes('.composer-modal[hidden] { display: none; }'),
        '.composer-modal[hidden] override is mandatory in command.html');
});

// ── command.js delivery assertions ───────────────────────────────────

test('command.js: openComposerDialog is a function', () => {
    assert.ok(/function openComposerDialog\s*\(/.test(COMMAND_JS),
        'openComposerDialog must be a function in command.js');
});

test('command.js: delivery posts to /terminals/verb/sendToTerminal via fetch', () => {
    const body = extractFunctionBody(COMMAND_JS, 'deliverComposerPrompt');
    assert.ok(body.includes("fetch('/terminals/verb/sendToTerminal'"),
        'deliverComposerPrompt must POST to /terminals/verb/sendToTerminal in command.js');
});

test('command.js: delivery payload includes standingOrders: false', () => {
    const body = extractFunctionBody(COMMAND_JS, 'deliverComposerPrompt');
    assert.ok(body.includes('standingOrders: false'),
        'command.js composer delivery must pass standingOrders: false');
});

test('command.js: composer code path has no confirmation gates', () => {
    for (const name of ['openComposerDialog', 'deliverComposerPrompt', 'closeComposerDialog']) {
        const body = extractFunctionBody(COMMAND_JS, name);
        assert.ok(!/\bconfirm\s*\(/.test(body),
            `${name}: no confirm() call is allowed (forbidden per CLAUDE.md)`);
        assert.ok(!body.includes('window.confirm'),
            `${name}: no window.confirm is allowed`);
    }
});

test('command.js: composer code path never touches navigator.clipboard', () => {
    for (const name of ['openComposerDialog', 'deliverComposerPrompt']) {
        const body = extractFunctionBody(COMMAND_JS, name);
        assert.ok(!body.includes('navigator.clipboard'),
            `${name} must never reference navigator.clipboard`);
    }
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
    process.exit(1);
}
