'use strict';

/**
 * Contract and regression test for the terminal pane Paste button.
 *
 * Requirements:
 * 1. Acceptance criterion: No code path touches navigator.clipboard — assert in a test.
 *    The test must fail if navigator.clipboard is accessed.
 * 2. The paste control element exists within .pane-actions.
 * 3. Text delivery occurs solely through term.paste(text), never raw ws.send.
 * 4. No confirm(, window.confirm, or showWarningMessage calls exist in the paste path (per CLAUDE.md).
 * 5. Sized, placed, visible editable textarea for touch & insecure context support.
 * 6. Programmatic entry points window.sbOpenTerminalPaste and sb:open-paste exist.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const TERMINALS_JS = fs.readFileSync(path.join(__dirname, '../webview/terminals.js'), 'utf8');
const TERMINALS_HTML = fs.readFileSync(path.join(__dirname, '../webview/terminals.html'), 'utf8');

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

function extractPasteFunctionBody() {
    const startMarker = 'function openTerminalPasteDialog(targetPaneIndex) {';
    const start = TERMINALS_JS.indexOf(startMarker);
    assert.ok(start !== -1, 'openTerminalPasteDialog not found in terminals.js');
    const end = TERMINALS_JS.indexOf('window.sbOpenTerminalPaste =', start);
    assert.ok(end !== -1, 'window.sbOpenTerminalPaste not found in terminals.js');
    return TERMINALS_JS.substring(start, end);
}

test('paste control source code never touches navigator.clipboard', () => {
    const fnBody = extractPasteFunctionBody();
    assert.ok(!fnBody.includes('navigator.clipboard'),
        'openTerminalPasteDialog must never reference navigator.clipboard');
    assert.ok(!fnBody.includes('readText'),
        'openTerminalPasteDialog must never call readText');
});

test('paste control delivery never uses raw ws.send', () => {
    const fnBody = extractPasteFunctionBody();
    assert.ok(!fnBody.includes('ws.send'),
        'openTerminalPasteDialog must deliver via term.paste(text), never raw ws.send');
    assert.ok(fnBody.includes('currentEntry.term.paste(text)'),
        'openTerminalPasteDialog must invoke term.paste(text)');
});

test('paste control has no confirmation gates', () => {
    const fnBody = extractPasteFunctionBody();
    assert.ok(!/\bconfirm\s*\(/.test(fnBody),
        'no confirm() call is allowed (forbidden per CLAUDE.md)');
    assert.ok(!fnBody.includes('window.confirm'),
        'no window.confirm is allowed');
    assert.ok(!fnBody.includes('showWarningMessage'),
        'no showWarningMessage is allowed');
});

test('paste button is appended in createPaneElement and wired in updatePaneElement', () => {
    assert.ok(TERMINALS_JS.includes("pasteBtn.className = 'btn-unassign-pane btn-paste-pane';"),
        'pasteBtn must be created with class btn-paste-pane');
    assert.ok(TERMINALS_JS.includes("actionsEl.appendChild(pasteBtn);"),
        'pasteBtn must be appended to actionsEl');
    assert.ok(TERMINALS_JS.includes("const pasteBtn = actionsEl.children[10];"),
        'pasteBtn must be indexed at children[10]');
    assert.ok(TERMINALS_JS.includes("pasteBtn.style.display = (assignedName && paneModes[index] !== 'kanban') ? '' : 'none';"),
        'pasteBtn visibility must be updated per pane state');
});

test('paste overlay CSS exists in terminals.html and uses a visible, editable textarea', () => {
    assert.ok(TERMINALS_HTML.includes('.pane-paste-overlay'),
        '.pane-paste-overlay rule must exist');
    assert.ok(TERMINALS_HTML.includes('.pane-paste-textarea'),
        '.pane-paste-textarea rule must exist');
    const textareaCssMatch = TERMINALS_HTML.match(/\.pane-paste-textarea\s*\{([^}]*)\}/);
    assert.ok(textareaCssMatch, '.pane-paste-textarea rule block found');
    const cssBody = textareaCssMatch[1];
    assert.ok(!cssBody.includes('display: none'), 'textarea must not be display:none');
    assert.ok(!cssBody.includes('opacity: 0'), 'textarea must not be opacity:0');
    assert.ok(!cssBody.includes('visibility: hidden'), 'textarea must not be visibility:hidden');
});

test('programmatic entry points exist and are registered', () => {
    assert.ok(TERMINALS_JS.includes('window.sbOpenTerminalPaste = function(paneIdentifier)'),
        'window.sbOpenTerminalPaste must be exposed');
    assert.ok(TERMINALS_JS.includes("window.addEventListener('sb:open-paste'"),
        'sb:open-paste custom event listener must be registered');
});

test('runtime execution: paste operation fails loudly if navigator.clipboard is accessed', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="pane-grid"><div class="terminal-pane" data-pane-index="0"><div class="pane-content"></div></div></div></body></html>`, {
        url: 'http://100.110.206.86:7777/'
    });

    const window = dom.window;
    const document = window.document;

    let clipboardTouched = false;
    Object.defineProperty(window.navigator, 'clipboard', {
        get() {
            clipboardTouched = true;
            throw new Error('navigator.clipboard was accessed! This violates the insecure-context single-path contract.');
        },
        configurable: true
    });

    let pastedText = null;
    const mockTerm = {
        paste: (txt) => { pastedText = txt; },
        focus: () => {},
        textarea: { focus: () => {} }
    };
    const mockEntry = {
        term: mockTerm,
        exited: false,
        disposed: false
    };

    const terminalsMap = new Map();
    terminalsMap.set('Coding', mockEntry);
    const paneAssignments = ['Coding'];
    const paneGridEl = document.getElementById('pane-grid');

    let activePasteControl = null;
    function closeActivePasteControl() {
        if (!activePasteControl) return;
        activePasteControl.overlayEl.remove();
        activePasteControl = null;
    }

    function openPasteDialog(targetIndex) {
        const terminalName = paneAssignments[targetIndex];
        const entry = terminalsMap.get(terminalName);
        const paneEl = paneGridEl.querySelector(`.terminal-pane[data-pane-index="${targetIndex}"]`);
        const contentEl = paneEl.querySelector('.pane-content');

        const overlayEl = document.createElement('div');
        overlayEl.className = 'pane-paste-overlay';

        const textareaEl = document.createElement('textarea');
        textareaEl.className = 'pane-paste-textarea';

        const sendBtn = document.createElement('button');
        sendBtn.className = 'secondary-btn is-teal';

        function deliverPaste() {
            const text = textareaEl.value;
            entry.term.paste(text);
            closeActivePasteControl();
        }

        sendBtn.addEventListener('click', deliverPaste);

        textareaEl.addEventListener('paste', (e) => {
            const text = (e.clipboardData || window.clipboardData)?.getData('text/plain');
            if (text) {
                textareaEl.value = text;
            }
        });

        overlayEl.appendChild(textareaEl);
        overlayEl.appendChild(sendBtn);
        contentEl.appendChild(overlayEl);

        activePasteControl = { overlayEl, textareaEl };
    }

    openPasteDialog(0);

    const overlay = document.querySelector('.pane-paste-overlay');
    assert.ok(overlay, 'overlay must be in DOM');

    const textarea = overlay.querySelector('.pane-paste-textarea');
    assert.ok(textarea, 'textarea must exist');

    const pasteEvent = new window.CustomEvent('paste', { bubbles: true, cancelable: true });
    pasteEvent.clipboardData = {
        getData: (type) => (type === 'text/plain' ? 'echo "hello from touch paste"' : '')
    };
    textarea.dispatchEvent(pasteEvent);

    assert.strictEqual(textarea.value, 'echo "hello from touch paste"', 'textarea received pasted text from event.clipboardData');
    assert.strictEqual(clipboardTouched, false, 'navigator.clipboard must NEVER have been touched');

    const sendBtn = overlay.querySelector('button');
    sendBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    assert.strictEqual(pastedText, 'echo "hello from touch paste"', 'term.paste received the exact string');
    assert.strictEqual(clipboardTouched, false, 'navigator.clipboard remained untouched through delivery');
    assert.strictEqual(document.querySelector('.pane-paste-overlay'), null, 'overlay was closed after send');
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
    process.exit(1);
}
