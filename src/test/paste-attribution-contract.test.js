'use strict';

/**
 * Contract tests for paste attribution of copied dispatch prompts into
 * terminal panes, and for the kanban-pane Copy Prompt button populating the
 * clipboard in the browser host.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const terminalsJs = fs.readFileSync(path.join(__dirname, '../webview/terminals.js'), 'utf8');
const protocolCatalog = JSON.parse(fs.readFileSync(path.join(__dirname, '../../protocol-catalog.json'), 'utf8'));
const allowlistTs = fs.readFileSync(path.join(__dirname, '../generated/verbAllowlist.ts'), 'utf8');
const kanbanDb = fs.readFileSync(path.join(__dirname, '../services/KanbanDatabase.ts'), 'utf8');
const verbSchemas = fs.readFileSync(path.join(__dirname, '../services/verbSchemas.ts'), 'utf8');

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

// ---------------------------------------------------------------- copy-prompt contracts

test('kanban-pane Copy Prompt handler reads data.prompt and writes navigator.clipboard', () => {
    const handler = block(terminalsJs, "const copyBtn = document.createElement('button');", "btnGroup.appendChild(copyBtn);");
    assert.ok(handler.includes("typeof data.prompt === 'string'"), 'copy handler must check data.prompt');
    assert.ok(handler.includes('navigator.clipboard.writeText(data.prompt)'), 'copy handler must call navigator.clipboard.writeText(data.prompt)');
    assert.ok(handler.includes("'Copy failed'"), 'copy handler must label clipboard failure honestly');
});

// ---------------------------------------------------------------- paste attribution scanner contracts

test('extractPastedDispatchIdentity is defined and scans for dispatch identity', () => {
    const fn = block(terminalsJs, 'function extractPastedDispatchIdentity(text) {', 'const pendingBatchEntries = new Set();');
    assert.ok(fn.includes('PLANS TO PROCESS:'), 'scanner must look for dispatch marker');
    assert.ok(fn.includes('PLANS TO DISCUSS:'), 'scanner must reject consultation marker');
    assert.ok(/PLAN_ID=\(\\d\+\)/.test(fn), 'scanner must extract PLAN_ID digits');
    assert.ok(/Plan File:\\s\+\(\\S\+\)/.test(fn), 'scanner must extract Plan File paths');
    assert.ok(fn.includes('PASTE_SCAN_MIN_CHARS'), 'scanner must respect min-chars threshold');
});

test('term.onData arms attribution and fires attributePastedPrompt on a later submit', () => {
    const onData = block(terminalsJs, 'term.onData((data) => {', 'if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {');
    assert.ok(onData.includes('extractPastedDispatchIdentity(data)'), 'onData must call the scanner');
    assert.ok(onData.includes('entry.pendingAttribution'), 'onData must maintain pendingAttribution state');
    assert.ok(onData.includes('/kanban/verb/attributePastedPrompt'), 'onData must POST to attributePastedPrompt');
    assert.ok(/\[\\r\\n\]/.test(onData), 'onData must commit on a submit newline');
    assert.ok(onData.includes('skipCommit'), 'onData must not commit on the arming chunk itself');
});

test('pendingAttribution is cleared on socket close and terminal kill', () => {
    assert.ok(terminalsJs.includes('ws.onclose = () => {\n            entry.pendingAttribution = null;'), 'ws.onclose must clear pendingAttribution');
    assert.ok(terminalsJs.includes('entry.exited = true;\n        entry.pendingAttribution = null;'), 'destroyTerminalView must clear pendingAttribution');
    assert.ok(terminalsJs.includes('entry.pendingAttribution = null;\n            try { entry.ws.onclose = null; }'), 'reconnect must clear pendingAttribution');
});

test('KanbanDatabase has attributePasteDispatch writer', () => {
    const fn = block(kanbanDb, 'attributePasteDispatch(planFile: string', 'Activity-light OFF-switch (marker-driven)');
    assert.ok(fn.includes('UPDATE plans SET dispatched_agent = ?, dispatched_terminal = ?, dispatched_at = ?, updated_at = ?'), 'attributePasteDispatch must write the right columns');
    assert.ok(!fn.includes('routed_to'), 'attributePasteDispatch must not write routed_to');
    assert.ok(!fn.includes('dispatched_ide'), 'attributePasteDispatch must not write dispatched_ide');
});

test('attributePastedPrompt is in the protocol catalog and verb allowlist', () => {
    assert.ok(protocolCatalog.providers.Kanban.verbs.includes('attributePastedPrompt'), 'protocol-catalog.json must list attributePastedPrompt under Kanban');
    assert.ok(allowlistTs.includes("'attributePastedPrompt'"), 'KANBAN_VERBS must include attributePastedPrompt');
});

test('attributePastedPrompt has a permissive schema in verbSchemas.ts', () => {
    assert.ok(verbSchemas.includes('attributePastedPrompt:'), 'verbSchemas.ts must declare attributePastedPrompt');
    assert.ok(verbSchemas.includes('planIds:'), 'schema must allow planIds');
    assert.ok(verbSchemas.includes('planFiles:'), 'schema must allow planFiles');
});

// ---------------------------------------------------------------- drop dispatch attribution

test('wireTerminalDropTarget defines attributeDropDispatch with array-shaped planIds', () => {
    const dropBlock = block(terminalsJs, 'function wireTerminalDropTarget(', 'function createPaneElement(');
    const attrFn = block(terminalsJs, 'function attributeDropDispatch(terminalName, planIds, workspaceRoot) {', "paneEl.addEventListener('dragover', (e) => {");
    assert.ok(attrFn.includes('/kanban/verb/attributePastedPrompt'), 'attributeDropDispatch must POST to attributePastedPrompt');
    assert.ok(attrFn.includes('planIds: ids,'), 'request body must send planIds as an array (ids)');
    assert.ok(!attrFn.includes('planIds: [planId'), 'must not scalar-wrap planIds');
    assert.ok((dropBlock.match(/attributeDropDispatch\(/g) || []).length >= 2, 'drop handler must call attributeDropDispatch in both branches');
    const successIdx = dropBlock.indexOf('promptResult.success');
    const callIdx = dropBlock.indexOf('attributeDropDispatch(', successIdx);
    assert.ok(successIdx !== -1 && callIdx !== -1 && callIdx > successIdx, 'normal branch must call attributeDropDispatch after the promptResult.success guard');
});

// ---------------------------------------------------------------- summary

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
