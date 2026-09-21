'use strict';

/**
 * Contract test for the Composer feature: compose a prompt locally and
 * deliver it to any active terminal via the host-routed sendToTerminal verb,
 * without switching the active pane (which forces an xterm.js rerender).
 *
 * The composer is a STANDING TAB in the agent dock now (dock.html +
 * dockComposer.js), not a modal in the terminals panel or the command view
 * (plan: the-composer-is-a-modal-you-have-to-summon-make-it-a-dock-tab). The
 * two modal copies collapsed into one surface; both documents keep only a
 * COMPOSER button that posts openDockTab to the shell.
 *
 * Covers all four surfaces of the new shape:
 *   - the dock document (dock.html / dock.js / dockComposer.js)
 *   - the shell (shell.js / shell.html): openDockTab relay + overlay mode
 *   - the terminals panel (composer modal REMOVED, button rewired)
 *   - the command view (composer modal REMOVED, button rewired)
 *
 * Run with:
 *   node src/test/composer-contract.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TERMINALS_JS = fs.readFileSync(path.join(__dirname, '../webview/terminals.js'), 'utf8');
const TERMINALS_HTML = fs.readFileSync(path.join(__dirname, '../webview/terminals.html'), 'utf8');
const TERMINALS_CSS = fs.readFileSync(path.join(__dirname, '../webview/terminals.css'), 'utf8');
const COMMAND_JS = fs.readFileSync(path.join(__dirname, '../webview/command.js'), 'utf8');
const COMMAND_HTML = fs.readFileSync(path.join(__dirname, '../webview/command.html'), 'utf8');
const DOCK_HTML = fs.readFileSync(path.join(__dirname, '../webview/dock.html'), 'utf8');
const DOCK_JS = fs.readFileSync(path.join(__dirname, '../webview/dock.js'), 'utf8');
const DOCK_COMPOSER_JS = fs.readFileSync(path.join(__dirname, '../webview/dockComposer.js'), 'utf8');
const SHELL_JS = fs.readFileSync(path.join(__dirname, '../webview/shell.js'), 'utf8');
const SHELL_HTML = fs.readFileSync(path.join(__dirname, '../webview/shell.html'), 'utf8');

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

/**
 * Strip comments so a "this identifier must not appear" assertion tests the CODE
 * and not the prose about it. dockComposer.js's header comment deliberately says
 * "NEVER read from window.parent" — the documentation the plan asked to carry
 * across — and a raw `.includes()` scan fails on that promise instead of on a
 * violation of it. Block comments first, then line comments.
 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Slice of a source file between two markers, for scoping an assertion to one region. */
function block(code, startMarker, endMarker) {
    const start = code.indexOf(startMarker);
    assert.ok(start !== -1, `marker not found: ${startMarker}`);
    const end = code.indexOf(endMarker, start);
    assert.ok(end !== -1, `end marker not found AFTER "${startMarker}": ${endMarker}`);
    return code.substring(start, end);
}

// ── dock.html: the composer is a tab, not a modal ───────────────────

test('dock.html: the Composer tab sits in the dock tab strip', () => {
    const tabsIdx = DOCK_HTML.indexOf('id="dock-tabs"');
    assert.ok(tabsIdx !== -1, '#dock-tabs strip not found in dock.html');
    const composerIdx = DOCK_HTML.indexOf('id="dock-tab-composer"', tabsIdx);
    assert.ok(composerIdx !== -1, '#dock-tab-composer must exist inside #dock-tabs');
});

test('dock.html: the composer pane holds the four controls the modals carried', () => {
    assert.ok(DOCK_HTML.includes('id="dock-composer-pane"'), '#dock-composer-pane must exist');
    assert.ok(DOCK_HTML.includes('id="dock-composer-target"'), '#dock-composer-target select must exist');
    assert.ok(DOCK_HTML.includes('id="dock-composer-input"'), '#dock-composer-input textarea must exist');
    assert.ok(DOCK_HTML.includes('id="dock-composer-status"'), '#dock-composer-status line must exist');
    assert.ok(DOCK_HTML.includes('id="dock-composer-send"'), '#dock-composer-send button must exist');
});

test('dock.html: dockComposer.js is loaded (with nonce), before dock.js', () => {
    const composerIdx = DOCK_HTML.indexOf('src="/static/webview/dockComposer.js"');
    assert.ok(composerIdx !== -1, 'dockComposer.js script tag must be present');
    const tag = DOCK_HTML.substring(DOCK_HTML.lastIndexOf('<script', composerIdx), composerIdx + 60);
    assert.ok(tag.includes('nonce="{{NONCE}}"'), 'dockComposer.js tag must carry nonce="{{NONCE}}"');
    assert.ok(DOCK_HTML.indexOf('{{DOCK_JS_URI}}') > composerIdx,
        'dockComposer.js must load before dock.js — dock.js calls SwitchboardDockComposer on tab activation');
});

// ── dock.js: tab wiring + the shell's deep-link arm ─────────────────

test('dock.js: composer is a registered tab and reachable via dockActivateTab', () => {
    assert.ok(/DOCK_TABS\s*=\s*\[[^\]]*'composer'[^\]]*\]/.test(DOCK_JS),
        'DOCK_TABS must include composer');
    assert.ok(/dock-tab-composer/.test(DOCK_JS),
        'dock.js must bind the composer tab button');
    assert.ok(DOCK_JS.includes('dockActivateTab'),
        'dock.js must handle the dockActivateTab message — the shell posts it for openDockTab');
});

// ── dockComposer.js: delivery path (invariants from the plan) ───────

test('dockComposer.js: delivery posts to /terminals/verb/sendToTerminal via fetch', () => {
    const body = extractFunctionBody(DOCK_COMPOSER_JS, 'deliverComposerPrompt');
    assert.ok(body.includes("fetch('/terminals/verb/sendToTerminal'"),
        'deliverComposerPrompt must POST to /terminals/verb/sendToTerminal');
});

test('dockComposer.js: delivery payload keeps standingOrders: false', () => {
    // standingOrders:false is LOAD-BEARING — the standalone handler applies
    // standing orders by default, and a user-typed prompt is not a system
    // dispatch. This is the single easiest regression to ship silently.
    const body = extractFunctionBody(DOCK_COMPOSER_JS, 'deliverComposerPrompt');
    assert.ok(body.includes('standingOrders: false'),
        'composer delivery must pass standingOrders: false');
    assert.ok(body.includes('paced: true'),
        'composer delivery must keep paced: true');
});

test('dockComposer.js: delivery never uses postMessage, term.paste or ws.send', () => {
    const body = extractFunctionBody(DOCK_COMPOSER_JS, 'deliverComposerPrompt');
    assert.ok(!body.includes('postMessage'),
        'composer delivery must use fetch, never postMessage');
    assert.ok(!body.includes('term.paste'),
        'composer delivery must use the host-routed verb, not the local term.paste');
    assert.ok(!body.includes('ws.send'),
        'composer delivery must use fetch, never raw ws.send');
});

test('dockComposer.js: the composer never reads fleet state from the parent document', () => {
    // Goal invariant: the dock is a different document — the composer sources
    // the terminal list over the same verb the dock's other tabs use, never
    // by reaching into the parent.
    // Scanned with comments stripped: the module's header comment PROMISES not to
    // read window.parent, and a raw scan fails on the promise. The assertion must
    // still catch a real read — see the stripComments self-check below.
    assert.ok(!stripComments(DOCK_COMPOSER_JS).includes('window.parent'),
        'dockComposer.js must never touch window.parent — fleet comes from ptyListTerminals');
    const body = extractFunctionBody(DOCK_COMPOSER_JS, 'refreshTargets');
    assert.ok(body.includes('/terminals/verb/ptyListTerminals'),
        'refreshTargets must fetch /terminals/verb/ptyListTerminals');
});

test('stripComments still catches a REAL window.parent read (the gate is not a tautology)', () => {
    // Guards the assertion above from rotting into one that can never fail:
    // comments are dropped, code is not.
    const withComment = '// never read from window.parent\nconst x = 1;\n';
    assert.ok(!stripComments(withComment).includes('window.parent'),
        'stripComments must drop a line comment mentioning window.parent');
    const withBlockComment = '/**\n * NEVER read from window.parent.\n */\nconst x = 1;\n';
    assert.ok(!stripComments(withBlockComment).includes('window.parent'),
        'stripComments must drop a block comment mentioning window.parent');
    const withRealRead = '// fleet comes from ptyListTerminals\nconst t = window.parent.fleet;\n';
    assert.ok(stripComments(withRealRead).includes('window.parent'),
        'stripComments must KEEP a real window.parent read — otherwise the gate above can never fail');
});

test('dockComposer.js: refresh preserves the operator selection across a fleet refresh', () => {
    // The standing surface has no open moment — a refresh must not fight the
    // current selection (plan edge case 3).
    const body = extractFunctionBody(DOCK_COMPOSER_JS, 'refreshTargets');
    assert.ok(/selectEl\.value|targetEl\.value|\.value\b/.test(body),
        'refreshTargets must read the current selection');
    assert.ok(/current|previous|prev|selected/.test(body),
        'refreshTargets must keep the prior selection when it is still live');
});

test('dockComposer.js: the draft persists in localStorage and clears only on a successful send', () => {
    // The draft surviving tab switches, dock close/reopen and reload is the
    // point of the standing surface. Per-surface convenience state — it must
    // be localStorage, never the kanban database and never synced.
    assert.ok(DOCK_COMPOSER_JS.includes('localStorage'),
        'the draft must persist in localStorage');
    assert.ok(DOCK_COMPOSER_JS.includes('sb.composerDraft'),
        'the draft key must be sb.composerDraft');
    const body = extractFunctionBody(DOCK_COMPOSER_JS, 'deliverComposerPrompt');
    assert.ok(/data\.success|success/.test(body),
        'deliverComposerPrompt must branch on the send result');
    // The clear must live INSIDE the success branch, not merely somewhere in the
    // function — a failed send keeping the prompt is half the requirement. The
    // implementation clears through the named writeDraft/persistDraft seams
    // (writeDraft('') blanks the textarea, persistDraft() writes the blank back to
    // sb.composerDraft, keeping the target for the follow-up prompt).
    const successBranch = block(body, 'data.success', '} else {');
    assert.ok(/clearDraft|clearComposerDraft|removeItem|writeDraft\(\s*''\s*\)/.test(successBranch),
        'a successful send must clear the stored draft');
    assert.ok(/persistDraft\(\)|removeItem/.test(successBranch),
        'the cleared draft must be written back to storage, not just to the textarea');
    const failureBranch = body.slice(body.indexOf('} else {'));
    assert.ok(!/writeDraft\(\s*''\s*\)|clearDraft|removeItem/.test(failureBranch),
        'a failed send must NOT clear the draft — the prompt must survive');
});

test('dockComposer.js: no Escape binding — Escape must not close the dock', () => {
    // In a modal, Escape dismissed. In a dock tab, Escape must not close the
    // dock out from under a half-written prompt (plan edge case 4).
    assert.ok(!/key\s*===?\s*'Escape'/.test(DOCK_COMPOSER_JS),
        'dockComposer.js must not bind Escape — a stray Escape must not destroy a draft');
});

test('dockComposer.js: no confirmation gates, no clipboard reads', () => {
    assert.ok(!/\bconfirm\s*\(/.test(DOCK_COMPOSER_JS), 'no confirm() allowed (CLAUDE.md)');
    assert.ok(!DOCK_COMPOSER_JS.includes('window.confirm'), 'no window.confirm allowed');
    assert.ok(!DOCK_COMPOSER_JS.includes('showWarningMessage'), 'no showWarningMessage allowed');
    assert.ok(!DOCK_COMPOSER_JS.includes('navigator.clipboard'), 'composer must never touch the clipboard');
    assert.ok(!DOCK_COMPOSER_JS.includes('readText'), 'composer must never call readText');
});

// ── shell.js: openDockTab relay + overlay mode ──────────────────────

test('shell.js: openDockTab opens the dock and relays dockActivateTab to it', () => {
    assert.ok(SHELL_JS.includes("data.type === 'openDockTab'"),
        'shell.js must handle openDockTab from panel documents');
    const listener = block(SHELL_JS, "window.addEventListener('message', (event) => {", "document.addEventListener('keydown'");
    const at = listener.indexOf("data.type === 'openDockTab'");
    assert.ok(at !== -1, 'the openDockTab arm must exist in the message listener');
    const next = listener.indexOf('} else if (data.type', at);
    const armBody = listener.substring(at, next === -1 ? listener.length : next);
    assert.ok(armBody.includes('if (event.origin !== location.origin) { return; }'),
        'the openDockTab arm must check event.origin');
    assert.ok(SHELL_JS.includes('dockActivateTab'),
        'the shell must relay the requested tab to the dock as dockActivateTab');
});

test('shell.js: overlay mode keeps the dock reachable below the split floor', () => {
    // The composer card depends on the dock opening at tablet widths — an
    // overlaying dock reserves no board width, so the floor is rail+dock.
    assert.ok(/const\s+DOCK_OVERLAY_MIN\s*=\s*48\s*\+\s*DOCK_MIN/.test(SHELL_JS),
        'DOCK_OVERLAY_MIN must be rail + dock floor (no board floor, no splitter)');
    assert.ok(/#agent-dock\.is-overlay/.test(SHELL_HTML),
        'shell.html must carry the #agent-dock.is-overlay presentation rule');
});

// ── terminals panel: the modal is gone, the button rewired ──────────

test('terminals.html: #btn-composer exists inside .sidebar-ops', () => {
    const sidebarOpsStart = TERMINALS_HTML.indexOf('class="sidebar-ops"');
    assert.ok(sidebarOpsStart !== -1, '.sidebar-ops container not found');
    const btnLinkUpIdx = TERMINALS_HTML.indexOf('id="btn-link-up"', sidebarOpsStart);
    assert.ok(btnLinkUpIdx !== -1, '#btn-link-up not found in sidebar-ops');
    const btnComposerIdx = TERMINALS_HTML.indexOf('id="btn-composer"', btnLinkUpIdx);
    assert.ok(btnComposerIdx !== -1, '#btn-composer must appear after #btn-link-up in sidebar-ops');
});

test('terminals.html: NO #composer-modal remains', () => {
    assert.ok(!TERMINALS_HTML.includes('id="composer-modal"'),
        '#composer-modal must be removed from terminals.html — one composer, not three');
    assert.ok(!TERMINALS_HTML.includes('id="composer-terminal-select"'),
        '#composer-terminal-select must leave with the modal');
    assert.ok(!TERMINALS_HTML.includes('id="composer-input"'),
        '#composer-input must leave with the modal');
});

test('terminals.css: .composer-modal rules are gone', () => {
    assert.ok(!/\.composer-modal\s*\{/.test(TERMINALS_CSS),
        '.composer-modal CSS must be removed from terminals.css');
});

test('terminals.css: #btn-composer stays in the scoped hide rules', () => {
    assert.ok(TERMINALS_CSS.includes('body.is-team-scoped #btn-composer'),
        '#btn-composer must be hidden in team-scoped mode (alongside #btn-link-up)');
    assert.ok(TERMINALS_CSS.includes('body.is-controller-scoped #btn-composer'),
        '#btn-composer must be hidden in controller-scoped mode (alongside #btn-link-up)');
});

test('terminals.js: #btn-composer posts openDockTab to the shell', () => {
    assert.ok(TERMINALS_JS.includes("type: 'openDockTab'") && TERMINALS_JS.includes("tab: 'composer'"),
        'the COMPOSER button must post openDockTab with tab:composer');
    assert.ok(TERMINALS_JS.includes('window.parent.postMessage'),
        'the button must reach the shell via window.parent.postMessage');
});

test('terminals.js: the modal composer code is gone', () => {
    for (const name of ['openComposerModal', 'closeComposerModal', 'deliverComposerPrompt',
                        'updateComposerSendButton', 'setComposerStatus']) {
        assert.ok(!new RegExp('function\\s+' + name + '\\s*\\(').test(TERMINALS_JS),
            `${name} must be removed from terminals.js — the composer lives in dockComposer.js`);
    }
    assert.ok(!TERMINALS_JS.includes("getElementById('composer-modal')"),
        'terminals.js must not reference the removed modal element');
});

// ── command view: the modal is gone, the button rewired ─────────────

test('command.html: composer button exists in the dispatch view', () => {
    assert.ok(COMMAND_HTML.includes('id="btn-composer"'),
        '#btn-composer must exist in command.html');
    const dispatchStart = COMMAND_HTML.indexOf('id="view-dispatch"');
    assert.ok(dispatchStart !== -1, '#view-dispatch section not found');
    const btnComposerIdx = COMMAND_HTML.indexOf('id="btn-composer"', dispatchStart);
    assert.ok(btnComposerIdx !== -1,
        '#btn-composer must appear within the dispatch view section');
});

test('command.html: NO #composer-modal remains', () => {
    assert.ok(!COMMAND_HTML.includes('id="composer-modal"'),
        '#composer-modal must be removed from command.html — one composer, not three');
    assert.ok(!COMMAND_HTML.includes('id="composer-terminal-select"'),
        '#composer-terminal-select must leave with the modal');
    assert.ok(!/\.composer-modal\s*\{/.test(COMMAND_HTML),
        '.composer-modal CSS must be removed from command.html');
});

test('command.js: #btn-composer posts openDockTab to the shell', () => {
    assert.ok(COMMAND_JS.includes("type: 'openDockTab'") && COMMAND_JS.includes("tab: 'composer'"),
        'the command COMPOSER button must post openDockTab with tab:composer');
});

test('command.js: the modal composer code is gone', () => {
    for (const name of ['openComposerDialog', 'closeComposerDialog', 'deliverComposerPrompt',
                        'updateComposerSendButton', 'setComposerStatus']) {
        assert.ok(!new RegExp('function\\s+' + name + '\\s*\\(').test(COMMAND_JS),
            `${name} must be removed from command.js — the composer lives in dockComposer.js`);
    }
    assert.ok(!COMMAND_JS.includes("getElementById('composer-modal')"),
        'command.js must not reference the removed modal element');
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
    process.exit(1);
}
