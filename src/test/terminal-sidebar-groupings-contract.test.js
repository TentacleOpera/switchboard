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

// ---------------------------------------------------------------- inline role picker

test('pickerState is declared as module state for state-driven rendering', () => {
    assert.ok(
        /let pickerState = null;/.test(terminalsJs),
        'pickerState must be declared as module-level state'
    );
    assert.ok(
        /let pickerOpening = null;/.test(terminalsJs),
        'pickerOpening must be declared as module-level state'
    );
    assert.ok(
        /let rolePickerData = null;/.test(terminalsJs),
        'rolePickerData must be declared as module-level state'
    );
    assert.ok(
        /let pickerNeedsScroll = false;/.test(terminalsJs),
        'pickerNeedsScroll must be declared as module-level state'
    );
});

test('the picker renders from pickerState, never via getElementById(role-picker)', () => {
    const render = block(terminalsJs, 'function renderSidebarList() {', 'function setLayoutMode(');
    assert.ok(
        render.includes('pickerState'),
        'renderSidebarList must read pickerState to render the picker'
    );
    assert.ok(
        !render.includes("getElementById('role-picker')"),
        'renderSidebarList must NOT use getElementById(role-picker) — the static element is gone'
    );
    assert.ok(
        render.includes('mountRolePicker('),
        'renderSidebarList must mount the picker via mountRolePicker'
    );
});

test('the picker is appended to the group container, not to .parent-group-items', () => {
    const render = block(terminalsJs, 'function renderSidebarList() {', 'function setLayoutMode(');
    // The parent picker is appended to parentDiv, between headerEl and itemsContainer.
    assert.ok(
        /parentDiv\.appendChild\(mountRolePicker/.test(render),
        'parent picker must be appended to parentDiv, not to itemsContainer'
    );
    // The worktree picker is appended to wtDiv, between wtHeaderEl and wtItemsContainer.
    assert.ok(
        /wtDiv\.appendChild\(mountRolePicker/.test(render),
        'worktree picker must be appended to wtDiv, not to wtItemsContainer'
    );
});

test('the not-rendered clear appears after the parents loop, not inside it', () => {
    const render = block(terminalsJs, 'function renderSidebarList() {', 'function setLayoutMode(');
    assert.ok(
        render.includes('if (pickerState && !pickerRendered)'),
        'the not-rendered clear must be present'
    );
    // The clear must come after the parents loop closes — i.e. after the last
    // listEl.appendChild(parentDiv) and before the Show groups block.
    const clearIdx = render.indexOf('if (pickerState && !pickerRendered)');
    const lastAppendIdx = render.lastIndexOf('listEl.appendChild(parentDiv)');
    assert.ok(
        clearIdx > lastAppendIdx,
        'the not-rendered clear must come AFTER the parents loop, not inside it'
    );
});

test('renderGroupSidebar offers a + New terminal row and clears a non-__groups__ key on entry', () => {
    const groupSidebar = block(terminalsJs, 'function renderGroupSidebar() {', 'function renderSidebarList() {');
    assert.ok(
        groupSidebar.includes("'+ New terminal'"),
        'renderGroupSidebar must offer a + New terminal row'
    );
    assert.ok(
        groupSidebar.includes("onNewTerminalClicked(undefined, '__groups__')"),
        'the + New terminal row must open the picker with the __groups__ key'
    );
    assert.ok(
        groupSidebar.includes("pickerState.key !== '__groups__'"),
        'renderGroupSidebar must clear a non-__groups__ picker key on entry'
    );
});

test('onNewTerminalClicked claims a synchronous in-flight key before its await and re-checks after', () => {
    const fn = block(terminalsJs, 'async function onNewTerminalClicked(', 'function buildRolePicker(');
    const openingAssignIdx = fn.indexOf('pickerOpening = groupKey');
    const awaitIdx = fn.indexOf('await fetchPtyVisibleRoles()');
    const recheckIdx = fn.indexOf("if (pickerOpening !== groupKey)");
    assert.ok(openingAssignIdx !== -1, 'pickerOpening must be assigned before the await');
    assert.ok(awaitIdx !== -1, 'fetchPtyVisibleRoles must be awaited');
    assert.ok(recheckIdx !== -1, 'pickerOpening must be re-checked after the await');
    assert.ok(
        openingAssignIdx < awaitIdx,
        'pickerOpening must be claimed BEFORE the await'
    );
    assert.ok(
        recheckIdx > awaitIdx,
        'pickerOpening must be re-checked AFTER the await'
    );
});

test('the picker mount path consumes a one-shot scroll flag, not scrolling on every render', () => {
    const fn = block(terminalsJs, 'function mountRolePicker(', 'async function createTerminal(');
    assert.ok(
        fn.includes('pickerNeedsScroll'),
        'mountRolePicker must consume the pickerNeedsScroll flag'
    );
    assert.ok(
        fn.includes('pickerNeedsScroll = false'),
        'mountRolePicker must reset the one-shot flag so poll re-renders do not scroll'
    );
    assert.ok(
        fn.includes('scrollIntoView'),
        'mountRolePicker must call scrollIntoView when the flag is set'
    );
});

test('choosing a role closes the picker synchronously, not on the next incidental render', () => {
    // Exact declaration marker: a bare `buildRolePicker(` also matches the prose
    // reference in init()'s replacement comment ~3200 lines earlier.
    const fn = block(terminalsJs, 'function buildRolePicker(targetSpec) {', 'function mountRolePicker(');
    // Every handler that dismisses the picker must clear the state AND re-render.
    // The static picker hid synchronously via `picker.hidden = true`; state-only
    // clearing leaves the menu up until something else renders, and createTerminal's
    // only re-render is behind `res.ok` — so a failed create leaves it up until the
    // 5s fleet poll.
    const dismissals = fn.match(/pickerState = null;/g) || [];
    assert.ok(
        dismissals.length >= 3,
        'role, no-role and cancel handlers must all clear pickerState'
    );
    const renders = fn.match(/renderSidebarList\(\);/g) || [];
    assert.ok(
        renders.length >= dismissals.length,
        'every pickerState clear in buildRolePicker must be followed by renderSidebarList() so the menu closes immediately'
    );
    assert.ok(
        /pickerState = null;\s*\n\s*renderSidebarList\(\);\s*\n\s*createTerminal\(role,/.test(fn),
        'the role button must close the picker BEFORE firing createTerminal'
    );
    assert.ok(
        /pickerState = null;\s*\n\s*renderSidebarList\(\);\s*\n\s*createTerminal\(NO_ROLE,/.test(fn),
        'the No role button must close the picker BEFORE firing createTerminal'
    );
});

test('terminals.html no longer contains the static #role-picker or #btn-new-terminal', () => {
    assert.ok(
        !terminalsHtml.includes('id="btn-new-terminal"'),
        'terminals.html must not contain the #btn-new-terminal button'
    );
    assert.ok(
        !terminalsHtml.includes('id="role-picker"'),
        'terminals.html must not contain the static #role-picker element'
    );
    assert.ok(
        !terminalsHtml.includes('id="role-picker-cancel"'),
        'terminals.html must not contain the static #role-picker-cancel button'
    );
    assert.ok(
        !terminalsHtml.includes('.btn-new-terminal'),
        'terminals.html must not contain the .btn-new-terminal CSS'
    );
    assert.ok(
        terminalsHtml.includes('.role-picker.is-inline'),
        'terminals.html must contain the .role-picker.is-inline CSS for the inline picker'
    );
});

// ---------------------------------------------------------------- summary

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
