'use strict';

/**
 * Contract tests for Terminal Sidebar Role Ordering.
 *
 * The sidebar now sorts terminal rows by the operator's Kanban column order
 * instead of raw Map insertion order. These tests lock in the wiring and the
 * replace-not-merge semantics that stop hidden roles from inheriting stale weights.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const terminalsJs = fs.readFileSync(path.join(__dirname, '../webview/terminals.js'), 'utf8');
const agentConfigTs = fs.readFileSync(path.join(__dirname, '../services/agentConfig.ts'), 'utf8');

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
    const end = code.indexOf(endMarker, start + startMarker.length);
    assert.ok(end !== -1, `end marker not found: ${endMarker}`);
    return code.slice(start, end + endMarker.length);
}

test('fallback constant mirrors DEFAULT_KANBAN_COLUMNS', () => {
    const defaultBlock = block(agentConfigTs, 'export const DEFAULT_KANBAN_COLUMNS: KanbanColumnDefinition[] = [', '];');
    const defaultMap = {};
    const defaultObjects = defaultBlock.match(/\{[^{}]*\}/g) || [];
    for (const obj of defaultObjects) {
        const roleMatch = obj.match(/role:\s*['"]([^'"]+)['"]/);
        const orderMatch = obj.match(/order:\s*(\d+)/);
        if (roleMatch && orderMatch) { defaultMap[roleMatch[1]] = parseInt(orderMatch[1], 10); }
    }

    const fallbackBlock = block(terminalsJs, 'const KANBAN_ROLE_ORDER_FALLBACK = {', '};');
    const fallbackMap = {};
    const fallbackRe = /\b([a-z_][a-z0-9_]*):\s*(\d+)/g;
    let m;
    while ((m = fallbackRe.exec(fallbackBlock)) !== null) { fallbackMap[m[1]] = parseInt(m[2], 10); }

    assert.deepStrictEqual(fallbackMap, defaultMap,
        'KANBAN_ROLE_ORDER_FALLBACK must stay in lockstep with DEFAULT_KANBAN_COLUMNS');
});

test('buildColumnList carries the role field through', () => {
    const build = block(terminalsJs, 'function buildColumnList(structure, customColumns) {', 'function recomputeRoleOrderMap() {');
    assert.ok(/role:\s*item\.role \|\| null/.test(build),
        'buildColumnList must preserve role so the sidebar can derive ordering');
});

test('recomputeRoleOrderMap replaces the fallback, not merges', () => {
    const recompute = block(terminalsJs, 'function recomputeRoleOrderMap() {', '/** Build a flat');
    assert.ok(/next\[col\.role\] = col\.order;/.test(recompute),
        'live structure must be written into a fresh map');
    assert.ok(/\.\.\.KANBAN_ROLE_ORDER_FALLBACK/.test(recompute),
        'an empty cache must fall back to the constant, not a merged constant');
});

test('compareTerminals encodes the documented total order', () => {
    const compare = block(terminalsJs, 'function compareTerminals(a, b) {', 'function renderSidebarList() {');
    assert.ok(/status === 'exited'/.test(compare), 'exited must sink');
    assert.ok(/roleOrderMap\[a\.role\]/.test(compare), 'must consult roleOrderMap for tier');
    assert.ok(/localeCompare/.test(compare), 'unmapped roles must sort alphabetically');
    assert.ok(/terminalNameSuffix\(a\.friendlyName\)/.test(compare), 'numeric suffix must sort numerically');
    assert.ok(/a\.startTime/.test(compare), 'startTime must be a tiebreak');
});

test('renderSidebarList sorts before iterating', () => {
    const render = block(terminalsJs, 'function renderSidebarList() {', 'for (const item of parentGroup.direct) {');
    assert.ok(/group\.direct\.sort\(compareTerminals\)/.test(render),
        'direct terminals must sort before rendering');
    assert.ok(/wtGroup\.items\.sort\(compareTerminals\)/.test(render),
        'worktree terminals must sort before rendering');
});

test('fetchKanbanColumnStructure sends no workspaceRoot and shares body', () => {
    const fetchFn = block(terminalsJs, 'async function fetchKanbanColumnStructure(force = false) {', 'async function pollKanbanPanes() {');
    assert.ok(/body: '{}'/.test(fetchFn), 'must send empty body');
    assert.ok(!/workspaceRoot/.test(fetchFn),
        'must not send a workspaceRoot — the selected workspace is the single key');
    assert.ok(/fetchKanbanColumnStructure\(true\)/.test(terminalsJs),
        'must have a bypassed caller for init or focus');
});

test('init wires window focus bypass and boot fetch', () => {
    const initFn = block(terminalsJs, 'function init() {', 'function postFleetStateToShell() {');
    assert.ok(/window\.addEventListener\('focus', \(\) => fetchKanbanColumnStructure\(true\)\)/.test(initFn),
        'focus must refetch with throttle bypassed');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
