'use strict';

/**
 * Contract tests for Terminal Sidebar Groupings — Saved Pane-Assignment Sets.
 * Static tests asserting the group store, switch, rename fixup, solo guard,
 * and corrupt-value resilience are present and correct in terminals.js.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const terminalsJs = fs.readFileSync(path.join(__dirname, '../webview/terminals.js'), 'utf8');
const terminalsHtml = fs.readFileSync(path.join(__dirname, '../webview/terminals.html'), 'utf8');

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

// ---------------------------------------------------------------- group store contracts

test('terminalGroups and activeGroupId are declared as module state', () => {
    assert.ok(
        /let terminalGroups = \[\];[\s\S]*let activeGroupId = null;/.test(terminalsJs),
        'terminalGroups and activeGroupId must be declared as module-level state'
    );
});

test('groupsView flag is declared and defaults to true', () => {
    assert.ok(
        /let groupsView = true;/.test(terminalsJs),
        'groupsView must be declared and default to true so groups mode is the default when groups exist'
    );
});

test('loadLayoutSettings loads terminalGroups with shape guard', () => {
    const loadBlock = block(terminalsJs, 'async function loadLayoutSettings()', 'async function fetchTerminalList()');
    assert.ok(
        loadBlock.includes("loadSetting('terminals.groups', [])"),
        'loadLayoutSettings must load terminals.groups'
    );
    assert.ok(
        loadBlock.includes('Array.isArray(savedGroups)'),
        'loadLayoutSettings must guard against non-array terminals.groups'
    );
    assert.ok(
        loadBlock.includes("typeof g.id === 'string'") &&
        loadBlock.includes("typeof g.name === 'string'") &&
        loadBlock.includes('LAYOUT_MODES.includes(g.layout)') &&
        loadBlock.includes('Array.isArray(g.assignments)'),
        'loadLayoutSettings must validate per-element shape (id, name, layout, assignments)'
    );
});

test('saveLayoutSettings persists groups, activeGroupId, and groupsView', () => {
    const saveBlock = block(terminalsJs, 'function saveLayoutSettings()', 'async function fetchTerminalList()');
    assert.ok(
        saveBlock.includes("saveSetting('terminals.groups', terminalGroups)"),
        'saveLayoutSettings must persist terminalGroups'
    );
    assert.ok(
        saveBlock.includes("saveSetting('terminals.activeGroupId', activeGroupId)"),
        'saveLayoutSettings must persist activeGroupId'
    );
    assert.ok(
        saveBlock.includes("saveSetting('terminals.groupsView', groupsView)"),
        'saveLayoutSettings must persist groupsView'
    );
});

// ---------------------------------------------------------------- switchToGroup contracts

test('switchToGroup routes through setLayoutMode (honours pane-size floor)', () => {
    const fn = block(terminalsJs, 'function switchToGroup(', 'function renderGroupSidebar() {');
    assert.ok(
        fn.includes('setLayoutMode(group.layout)'),
        'switchToGroup must call setLayoutMode so the layout floor is honoured'
    );
    assert.ok(
        fn.includes('paneAssignments = group.assignments.slice()'),
        'switchToGroup must copy the group assignments into paneAssignments'
    );
    assert.ok(
        fn.includes('activeGroupId = id'),
        'switchToGroup must set activeGroupId'
    );
});

test('switchToGroup no-ops in solo mode', () => {
    const fn = block(terminalsJs, 'function switchToGroup(', 'function renderGroupSidebar() {');
    assert.ok(
        fn.includes('if (soloTerminalName) { return; }'),
        'switchToGroup must no-op when soloTerminalName is set'
    );
});

test('switchToGroup sets groupsView to true (re-enters group mode from flat)', () => {
    const fn = block(terminalsJs, 'function switchToGroup(', 'function renderGroupSidebar() {');
    assert.ok(
        fn.includes('groupsView = true'),
        'switchToGroup must set groupsView = true so the sidebar re-enters group mode'
    );
});

// ---------------------------------------------------------------- renderSidebarList mode branch

test('renderSidebarList enters group mode only when groups exist, not solo, and groupsView is true', () => {
    const render = block(terminalsJs, 'function renderSidebarList() {', 'function setLayoutMode(');
    assert.ok(
        render.includes('terminalGroups.length > 0 && !soloTerminalName && groupsView'),
        'renderSidebarList must check groupsView before entering group mode'
    );
    assert.ok(
        render.includes('renderGroupSidebar()'),
        'renderSidebarList must call renderGroupSidebar when groups mode is active'
    );
});

test('Show all terminals toggle sets groupsView=false, does NOT delete groups', () => {
    const groupSidebar = block(terminalsJs, 'function renderGroupSidebar() {', 'function renderSidebarList() {');
    assert.ok(
        groupSidebar.includes('groupsView = false'),
        'Show all terminals must set groupsView = false, not delete groups'
    );
    assert.ok(
        !groupSidebar.includes('terminalGroups = []'),
        'Show all terminals must NOT wipe terminalGroups — that destroys saved groups'
    );
});

test('flat mode offers a Show groups toggle when groups exist but groupsView is false', () => {
    const render = block(terminalsJs, 'function renderSidebarList() {', 'function setLayoutMode(');
    assert.ok(
        render.includes("'Show groups'"),
        'flat mode must offer a Show groups toggle when groups exist but groupsView is false'
    );
    assert.ok(
        /Show groups'[\s\S]*groupsView = true/.test(render),
        'Show groups toggle must set groupsView = true'
    );
});

// ---------------------------------------------------------------- rename fixup

test('renameTerminal fixups group assignments', () => {
    const renameBlock = block(terminalsJs, 'async function renameTerminal(', 'function beginInlineRename(');
    assert.ok(
        renameBlock.includes('for (const g of terminalGroups)'),
        'renameTerminal must iterate over terminalGroups'
    );
    assert.ok(
        /g\.assignments\[i\] === name/.test(renameBlock),
        'renameTerminal must match the old name in group assignments'
    );
    assert.ok(
        /g\.assignments\[i\] = next/.test(renameBlock),
        'renameTerminal must update group assignments to the new name'
    );
});

// ---------------------------------------------------------------- solo guard

test('saveSetting no-ops in solo mode (group persistence suppressed)', () => {
    const saveSettingBlock = block(terminalsJs, 'async function saveSetting(', 'async function loadLayoutSettings()');
    assert.ok(
        saveSettingBlock.includes('if (soloTerminalName) { return; }'),
        'saveSetting must return early when soloTerminalName is active — no terminals.groups write in solo'
    );
});

// ---------------------------------------------------------------- SAVE AS GROUP control

test('terminals.html includes the SAVE AS GROUP button', () => {
    assert.ok(
        terminalsHtml.includes('id="btn-save-group"'),
        'terminals.html must include the SAVE AS GROUP button'
    );
    assert.ok(
        terminalsHtml.includes('SAVE AS GROUP'),
        'SAVE AS GROUP button must have visible text'
    );
});

test('saveCurrentAsGroup snapshots the rendered-length slice of paneAssignments', () => {
    const fn = block(terminalsJs, 'function saveCurrentAsGroup(', 'function deleteGroup(');
    assert.ok(
        fn.includes('paneAssignments.slice(0, getSlotCount(effectiveLayout))'),
        'saveCurrentAsGroup must snapshot only the rendered-length slice, not invisible tail state'
    );
    assert.ok(
        fn.includes('terminalGroups.push(group)'),
        'saveCurrentAsGroup must push the new group onto terminalGroups'
    );
});

// ---------------------------------------------------------------- deleteGroup

test('deleteGroup removes the group and clears activeGroupId if it was active', () => {
    const fn = block(terminalsJs, 'function deleteGroup(', 'function switchToGroup(');
    assert.ok(
        fn.includes('terminalGroups = terminalGroups.filter'),
        'deleteGroup must filter out the group by id'
    );
    assert.ok(
        fn.includes('if (activeGroupId === id) { activeGroupId = null; }'),
        'deleteGroup must clear activeGroupId when the active group is deleted'
    );
});

// ---------------------------------------------------------------- summary

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
