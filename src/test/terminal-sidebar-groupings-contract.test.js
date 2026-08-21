'use strict';

/**
 * Contract tests for Terminal Sidebar Groupings — Logical Groups That Lock the View.
 * Static tests asserting the new group model, persistence, load shape guard,
 * lock semantics, and the contextual click split are present in terminals.js.
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

test('groupPrefs is declared for derived-group display preferences', () => {
    assert.ok(
        terminalsJs.includes('let groupPrefs = {'),
        'groupPrefs must be declared'
    );
    assert.ok(
        /threshold[^,]*,[^}]*hidden[^,]*,[^}]*pinned[^,]*,[^}]*orders/.test(terminalsJs),
        'groupPrefs must contain threshold, hidden, pinned and orders'
    );
});

test('the legacy groupsView boolean is removed', () => {
    assert.ok(
        !/let groupsView = true;/.test(terminalsJs),
        'groupsView must no longer be declared'
    );
});

test('loadLayoutSettings loads terminalGroups with a widened shape guard', () => {
    const loadBlock = block(terminalsJs, 'async function loadLayoutSettings()', 'async function fetchTerminalList()');
    assert.ok(
        loadBlock.includes("loadSetting('terminals.groups', [])"),
        'loadLayoutSettings must load terminals.groups'
    );
    assert.ok(
        loadBlock.includes("g.source === 'manual' || g.source === 'role' || g.source === 'worktree'"),
        'loadLayoutSettings must accept new-shape group rows'
    );
    assert.ok(
        loadBlock.includes("source: 'manual'"),
        'loadLayoutSettings must normalise legacy rows to manual groups'
    );
    assert.ok(
        loadBlock.includes("loadSetting('terminals.groupPrefs'"),
        'loadLayoutSettings must load groupPrefs'
    );
});

test('saveLayoutSettings persists groups, activeGroupId, and groupPrefs', () => {
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
        saveBlock.includes("saveSetting('terminals.groupPrefs', groupPrefs)"),
        'saveLayoutSettings must persist groupPrefs'
    );
    assert.ok(
        !saveBlock.includes("saveSetting('terminals.groupsView'"),
        'saveLayoutSettings must no longer persist groupsView'
    );
});

// ---------------------------------------------------------------- derived groups

test('derived groups are computed from role and worktree only', () => {
    const derived = block(terminalsJs, 'function getDerivedGroups()', 'function getAllGroups()');
    assert.ok(
        derived.includes("source: 'role'"),
        'getDerivedGroups must emit role groups'
    );
    assert.ok(
        derived.includes("source: 'worktree'"),
        'getDerivedGroups must emit worktree groups'
    );
    assert.ok(
        !derived.includes("source: 'project'"),
        'getDerivedGroups must not invent a project source'
    );
});

test('derived groups respect threshold and hidden list', () => {
    const derived = block(terminalsJs, 'function getDerivedGroups()', 'function getAllGroups()');
    assert.ok(
        derived.includes('groupPrefs.threshold'),
        'getDerivedGroups must use the configured threshold'
    );
    assert.ok(
        derived.includes('groupPrefs.hidden'),
        'getDerivedGroups must filter out hidden ids'
    );
});

// ---------------------------------------------------------------- switchToGroup contracts

test('switchToGroup routes through setLayoutMode and honours keepLock', () => {
    const fn = block(terminalsJs, 'function switchToGroup(', 'function safeGroupIdForValue(');
    // layoutForGroupSwitch, NOT the grow-only layoutForFleetCount: a group switch
    // is a RESTORE and must be able to shrink the grid. Routing it through
    // setLayoutMode keeps applyLayoutFloor's veto intact.
    assert.ok(
        fn.includes('setLayoutMode(layoutForGroupSwitch(group), { keepLock: true })'),
        'switchToGroup must route the group layout through setLayoutMode via the non-monotonic layoutForGroupSwitch, and keep the lock'
    );
    assert.ok(
        !/effectiveLayout\s*=/.test(fn),
        'the lock path must never write effectiveLayout directly — that is the floor bypass'
    );
    assert.ok(
        fn.includes('activeGroupId = id'),
        'switchToGroup must set activeGroupId'
    );
    const seat = block(terminalsJs, 'function seatActiveGroupPage() {', 'function safeGroupIdForValue(');
    assert.ok(
        seat.includes('paneAssignments = assignments'),
        'seatActiveGroupPage must write paneAssignments'
    );
    // Paging is keyed to RENDERED slots, not to nine: a 4-member group in a 2-slot
    // viewport needs paging just as much as a 14-member group in a full one.
    assert.ok(
        seat.includes('getSlotCount(effectiveLayout)') && seat.includes('activeGroupPage * rendered'),
        'the page slice must be keyed to getSlotCount(effectiveLayout)'
    );
    // A lock reseats slots; the pin invariant pinnedPanes[i] -> paneAssignments[i]
    // must still hold after the swap.
    assert.ok(
        /pinnedPanes\[i\] && !paneAssignments\[i\]/.test(seat),
        'a slot the group left empty must have its pin cleared, not left reserving nothing'
    );
});

test('the page index is transient — reset on lock change, clamped by the floor', () => {
    const fn = block(terminalsJs, 'function switchToGroup(', 'function seatActiveGroupPage() {');
    assert.ok(
        /if \(!sameGroup \|\| !opts\.keepPage\) \{ activeGroupPage = 0; \}/.test(fn),
        'moving the lock to a different group must reset the page — a group that reopens on page 3 looks empty'
    );
    const seat = block(terminalsJs, 'function seatActiveGroupPage() {', 'function safeGroupIdForValue(');
    assert.ok(
        seat.includes('if (activeGroupPage >= pageCount)'),
        'the page must be re-clamped when the floor changes the rendered slot count'
    );
    assert.ok(
        !/saveSetting\(['"]terminals\.activeGroupPage/.test(terminalsJs),
        'the page index is a scroll position, not a preference — it must not be persisted'
    );
});

test('the floor re-pages a locked group and the banner reports the shortfall', () => {
    const fn = block(terminalsJs, 'function applyLayoutFloor(opts) {', 'Attempt schedule for the settle ladder');
    assert.ok(
        fn.includes('if (activeGroupId) { seatActiveGroupPage(); }'),
        'a changed rendered slot count must re-page the locked group'
    );
    assert.ok(fn.includes('banner-page-btn'), 'the paging control must sit alongside the shortfall message');
});

test('switchToGroup exits solo mode before locking', () => {
    const fn = block(terminalsJs, 'function switchToGroup(', 'function safeGroupIdForValue(');
    assert.ok(
        fn.includes('document.body.classList.remove(\'is-solo\')'),
        'switchToGroup must clear the is-solo CSS class'
    );
    assert.ok(
        fn.includes('soloTerminalName = null'),
        'switchToGroup must clear soloTerminalName'
    );
});

// ---------------------------------------------------------------- renderSidebarList hierarchy

test('renderSidebarList renders the tab strip and is otherwise one workspace tree', () => {
    const render = block(terminalsJs, 'function renderSidebarList() {', 'function syncLayoutPickerUI()');
    assert.ok(
        render.includes('renderGroupTabStrip()'),
        'renderSidebarList must render the group tab strip — one refresh cycle over fleetList, or the live member counts disagree with the tree'
    );
    assert.ok(
        !render.includes('groupsView'),
        'renderSidebarList must not branch on a groupsView toggle'
    );
    // The sidebar is now ONE tree: Workspace → Terminal. The group slab, the
    // "All terminals" row and the global "+ New terminal" row all moved to the
    // strip or were deleted outright.
    assert.ok(
        !/function renderGroupSidebar\b/.test(terminalsJs),
        'renderGroupSidebar must be gone — groups are a view mode on the tab strip, not a tree tier'
    );
    assert.ok(
        !terminalsJs.includes("'+ New terminal'"),
        'the global + New terminal row must be gone — every workspace and worktree header carries its own + with a defined target'
    );
    assert.ok(
        !terminalsJs.includes('All terminals — free composition'),
        'the All terminals row must be gone — the strip\'s All tab is that affordance now'
    );
});

test('team subheaders are rendered as a tier in the sidebar hierarchy', () => {
    // 1. buildTeamClaimMap filters on manual groups only
    const claimMapFn = block(terminalsJs, 'function buildTeamClaimMap() {', 'function bucketRowsByTeam(');
    assert.ok(
        claimMapFn.includes("g.source !== 'manual'"),
        'buildTeamClaimMap must filter on manual groups only so derived groups do not duplicate tiers'
    );
    // 1b. the claim reads the group's own roster, NOT getGroupMembers — that
    // resolver intersects with the live set, so an exited seat would lose its
    // claim, drop out of its team's tier and re-render as a loose row below it,
    // leaving renderTeamTier's `Xx` count permanently 0.
    assert.ok(
        !/getGroupMembers\(/.test(claimMapFn),
        'buildTeamClaimMap must not resolve through getGroupMembers — its live-set filter evicts exited seats from their team tier'
    );
    assert.ok(
        /g\.order/.test(claimMapFn) && /g\.members/.test(claimMapFn),
        'buildTeamClaimMap must claim off the manual group roster arrays (order + members)'
    );

    // 2. buildTeamClaimMap is called once in renderSidebarList, not inside row loops
    const renderFn = block(terminalsJs, 'function renderSidebarList() {', 'function syncLayoutPickerUI()');
    const claimMapCallCount = (renderFn.match(/buildTeamClaimMap\(\)/g) || []).length;
    assert.strictEqual(
        claimMapCallCount, 1,
        'buildTeamClaimMap must be called once per renderSidebarList invocation'
    );
    assert.ok(
        !/for\s*\([^)]*\)\s*\{[^}]*findGroupForTerminalName/.test(renderFn),
        'findGroupForTerminalName must not be called inside render loops'
    );

    // 3. renderTeamTier uses the collapse key prefix 'team:' and calls saveLayoutSettings()
    const teamTierFn = block(terminalsJs, 'function renderTeamTier(', 'function renderSidebarList()');
    assert.ok(
        teamTierFn.includes("'team:' +"),
        'renderTeamTier must use team: collapse key prefix'
    );
    // The key must carry the LOCATION too. A team spanning a workspace and a
    // worktree renders a tier in each; on a bare 'team:<id>' key those two
    // separate tiers collapse in lockstep.
    assert.ok(
        /const locationKey = locationOwner\.fullPath/.test(teamTierFn)
        && /'team:' \+ locationKey \+ ':' \+ bucket\.group\.id/.test(teamTierFn),
        'the team collapse key must be location-scoped, or two tiers of one team collapse together'
    );
    // The tier `+` mirrors the enclosing header's spawn wiring rather than
    // re-deriving it — no hardcoded picker key, which would mount the picker
    // under a key no header renders.
    assert.ok(
        !/'parent:workspace-root'/.test(teamTierFn),
        'the team tier + must not hardcode a picker key — it must reuse the enclosing header\'s'
    );
    assert.ok(
        teamTierFn.includes('saveLayoutSettings()'),
        'renderTeamTier collapse toggle must persist layout settings'
    );

    // 4. both direct and worktree runs go through bucketRowsByTeam
    const directBucketCount = (renderFn.match(/bucketRowsByTeam\(parentGroup\.direct,\s*claimMap\)/g) || []).length;
    const wtBucketCount = (renderFn.match(/bucketRowsByTeam\(wtGroup\.items,\s*claimMap\)/g) || []).length;
    assert.ok(directBucketCount >= 1, 'direct rows must be bucketed by team');
    assert.ok(wtBucketCount >= 1, 'worktree rows must be bucketed by team');

    // 5. the rejected rationale comments are gone from both files
    assert.ok(
        !terminalsJs.includes('legible without a nesting tier'),
        'rejected rationale comment must be removed from terminals.js'
    );
    assert.ok(
        !terminalsHtml.includes('Replaces the nesting tier'),
        'rejected rationale comment must be removed from terminals.html'
    );

    // 6. CSS classes exist in terminals.html
    assert.ok(terminalsHtml.includes('.team-group'), 'terminals.html must define .team-group');
    assert.ok(terminalsHtml.includes('.team-group-header'), 'terminals.html must define .team-group-header');
    assert.ok(terminalsHtml.includes('.team-items'), 'terminals.html must define .team-items');
    assert.ok(terminalsHtml.includes('.team-group.indent-team'), 'terminals.html must define .team-group.indent-team');
});

test('the lock indicator and the clickable sidebar title are both retired', () => {
    // updateLockIndicator wrote "<name> — locked" into .sidebar-title, duplicating
    // what the active tab now shows directly. Its click handler was a third,
    // unlabelled way to drop the lock, and the hover rule advertised it.
    assert.ok(
        !/function updateLockIndicator\b/.test(terminalsJs),
        'updateLockIndicator must be gone — the active tab is the lock indicator'
    );
    assert.ok(
        !/\.sidebar-title:hover/.test(terminalsHtml),
        'the .sidebar-title hover rule must be gone — nothing there is clickable any more'
    );
    assert.ok(
        terminalsHtml.includes('<span class="sidebar-title">Agents</span>'),
        'the sidebar title must read a static Agents'
    );
});

test('the tab strip offers Unassigned, one tab per group, a delete on every tab, and a +', () => {
    const strip = block(terminalsJs, 'function renderGroupTabStrip() {', 'function terminalNameSuffix(');
    assert.ok(
        strip.includes("allTabName.textContent = 'Unassigned'"),
        'the strip must render a leading Unassigned tab'
    );
    assert.ok(
        strip.includes('clearGroupLock()'),
        'the All tab must route at clearGroupLock — the single visible way to drop the lock'
    );
    assert.ok(
        strip.includes('for (const g of groups)') && strip.includes('const groups = getAllGroups();'),
        'the strip must derive its tabs from getAllGroups()'
    );
    // One verb on every source. deleteGroup itself branches; the tab does not.
    assert.ok(
        strip.includes('deleteGroup(g.id)') && !strip.includes("'hide'"),
        'every tab must render one delete wired at deleteGroup — no source branch, no hide label'
    );
    assert.ok(
        !/confirm\s*\(/.test(strip),
        'no confirm gate — delete executes on the click (and confirm() is a silent no-op in a VS Code webview)'
    );
    // The active tab is inert: "leave this group" is the All tab, not a toggle
    // hidden on the tab you are already looking at.
    assert.ok(
        /if \(activeGroupId === g\.id\) \{ return; \}/.test(strip),
        'clicking the already-active tab must be inert, not a hidden clearGroupLock toggle'
    );
    assert.ok(
        strip.includes("onNewTerminalClicked(undefined, addKey)") && strip.includes("'group:' +"),
        "the strip's + must open the role picker with a group:<id> key"
    );
    assert.ok(
        !terminalsJs.includes("'__groups__'"),
        'the __groups__ picker key died with the slab'
    );
});

test('detach is gone from every group affordance', () => {
    // Reported from UAT: it minted a duplicate manual group with a (detached)
    // suffix, did not switch to it, and gave no feedback — a third meaning for a
    // word this file already uses for the exit grace period and for DOM reparenting.
    const strip = block(terminalsJs, 'function renderGroupTabStrip() {', 'function terminalNameSuffix(');
    // Matches a rendered LABEL, not the substring — an explanatory comment that
    // happens to say "detached" is not a button.
    assert.ok(
        !/(textContent|innerText|innerHTML)\s*=\s*['"`]\s*detach/i.test(strip) && !/['"`]detach['"`]/.test(strip),
        'no group affordance may render detach, in any source'
    );
    // The handler minted a NEW manual group with a "(detached)" suffix holding the
    // same terminals. Nothing may recreate that.
    assert.ok(
        !terminalsJs.includes('(detached)'),
        'nothing may mint a "(detached)" duplicate group'
    );
    // Existing (detached) groups an operator already created are ordinary manual
    // groups — no migration, no name special-casing, no sweep.
    assert.ok(
        !/detached/.test(block(terminalsJs, 'function deleteGroup(id) {', 'function clearGroupLock() {')),
        'deletion must not special-case a (detached) name — those are ordinary manual groups'
    );
    // ...but the unrelated exited-terminal cleanup family must survive.
    assert.ok(
        terminalsJs.includes('armDetachTimer') && terminalsJs.includes('cancelDetachTimer'),
        'the armDetachTimer / cancelDetachTimer family is unrelated and must be untouched'
    );
});

test('the tab strip is attached BEFORE its overflow measurement', () => {
    // offsetWidth/clientWidth are 0 on a detached node. Measuring the row while it
    // was still unparented made availableWidth negative, so EVERY group tab was
    // pushed into the » menu and the strip rendered as "All » +" in every fleet
    // shape — the feature's headline surface, silently empty, with no error.
    const strip = block(terminalsJs, 'function renderGroupTabStrip() {', 'function terminalNameSuffix(');
    const attachAt = strip.indexOf('groupTabStripEl.appendChild(tabRow)');
    const measureAt = strip.indexOf('tabRow.clientWidth');
    assert.ok(attachAt !== -1, 'the strip must attach its tab row');
    assert.ok(measureAt !== -1, 'the strip must measure available width for overflow');
    assert.ok(
        attachAt < measureAt,
        'tabRow must be appended to the strip BEFORE any offsetWidth/clientWidth read, or every tab overflows'
    );
});

test('group membership is legible on the row via a chip', () => {
    assert.ok(
        terminalsJs.includes("groupChip.className = 'item-group-chip'"),
        'each terminal row must carry a group chip so membership survives the loss of the nesting tier'
    );
    assert.ok(
        terminalsJs.includes('findGroupForTerminalName(item.friendlyName)'),
        'the chip must resolve through the same function the lock path uses'
    );
    assert.ok(
        terminalsHtml.includes('.item-group-chip'),
        'the chip must be styled'
    );
});

// ---------------------------------------------------------------- lock / compose split

test('assignToFocusedPane drops the active group lock unless keepLock is passed', () => {
    const fn = block(terminalsJs, 'function assignToFocusedPane(', 'function undoLastAssignment()');
    assert.ok(
        fn.includes('if (activeGroupId && !opts.keepLock) {'),
        'assignToFocusedPane must still drop the lock by default, and only opt out on keepLock'
    );
    assert.ok(
        fn.includes('activeGroupId = null;'),
        'assignToFocusedPane must clear activeGroupId'
    );
    // Exactly ONE caller may pass keepLock: the locked free-slot fill. Everything
    // else — drag-drop, inbound focusTerminal, locateTerminal — keeps dropping it.
    const keepLockCallers = (terminalsJs.match(/assignToFocusedPane\([^)]*keepLock/g) || []).length;
    assert.strictEqual(
        keepLockCallers, 1,
        'only handleLockedTerminalClick\'s free-slot branch may pass keepLock'
    );
    // dismissPeek must stay ABOVE the unlock block and must NOT be gated on
    // keepLock — a deliberate seat is a selection, and selection ends the peek.
    assert.ok(
        fn.indexOf('dismissPeek()') !== -1 && fn.indexOf('dismissPeek()') < fn.indexOf('if (activeGroupId'),
        'dismissPeek must run before the unlock block, ungated'
    );
});

test('the locked free-slot precondition matches what assignToFocusedPane will accept', () => {
    // The caller MUST guarantee a free slot before passing keepLock, because the
    // callee's fallbacks end in "displace the focused pane" — which under a lock
    // evicts a group member to seat a non-member. A precondition looser than the
    // callee's own isOpen()/isFree() test is how that happens.
    const fn = block(terminalsJs, 'function handleLockedTerminalClick(', 'function promoteGroupMember(');
    assert.ok(
        /const isFreeSlot = \(i\) => !paneAssignments\[i\] && paneModes\[i\] !== 'kanban' && \(!pinsActive \|\| !pinnedPanes\[i\]\)/.test(fn),
        'the free-slot precondition must exclude kanban panes AND pinned panes, exactly as assignToFocusedPane does'
    );
    assert.ok(
        fn.includes('addTerminalToActiveGroup(name)') &&
        fn.indexOf('addTerminalToActiveGroup(name)') < fn.indexOf('assignToFocusedPane(name, { keepLock: true })'),
        'membership must be written BEFORE seating — the next seatActiveGroupPage reconcile rebuilds paneAssignments from members and would evict the addition'
    );
});

test('setLayoutMode drops the lock unless keepLock is set', () => {
    const fn = block(terminalsJs, 'function setLayoutMode(', 'function locateTerminal(');
    // Pinned to the full condition, not a prefix: `&& !teamScopeId` is the third
    // term team-scoped mode added, and a prefix match would also accept a fourth
    // term that disables the guard outright. Add a term here deliberately or not
    // at all.
    assert.ok(
        fn.includes('if (activeGroupId && !opts.keepLock && !teamScopeId)'),
        'setLayoutMode must exit the lock when keepLock is not set (and must not '
        + 'drop the team scope, which IS the lock in team-scoped mode)'
    );
});

test('the layout picker authors the locked group\'s layout and re-pages it', () => {
    // This is the ONLY way the operator can express "planners are 2x2". The three
    // other setLayoutMode callers (growLayoutForFleet, switchToGroup,
    // create-grid-for-role) must keep their current behaviour — weakening the
    // shared !opts.keepLock guard instead would leave create-grid holding a lock
    // it then fights with fillEmptyPanes().
    const handler = block(terminalsJs, "const layoutBtns = document.querySelectorAll('.layout-picker .btn-layout');", 'const btnClearAll =');
    assert.ok(
        /groupPrefs\.layouts\[group\.id\] = requested/.test(handler),
        'a derived group\'s picked layout must be stored in groupPrefs.layouts'
    );
    assert.ok(
        /group\.layout = requested/.test(handler),
        'a manual group\'s picked layout must be stored on the group object'
    );
    assert.ok(
        /setLayoutMode\(requested, \{ keepLock \}\)/.test(handler),
        'the picker must keep the lock rather than silently unlocking'
    );
    // setLayoutMode adopts the pick optimistically, so applyLayoutFloor's `changed`
    // test is false and its own seatActiveGroupPage() does not fire. Without an
    // explicit re-page, growing 2h -> 2x2 for a 4-member group reveals two empty
    // panes the group already has members to fill.
    assert.ok(
        handler.indexOf('seatActiveGroupPage()') > handler.indexOf('setLayoutMode(requested'),
        'the picker must re-page the locked group AFTER applying the layout'
    );
    // The grow-only resolver must keep its own callers and its ratchet.
    const grow = block(terminalsJs, 'function growLayoutForFleet(count) {', 'async function loadSetting(');
    assert.ok(
        grow.includes('setLayoutMode(target);') && !grow.includes('keepLock'),
        'growLayoutForFleet must keep dropping the lock — widening for a just-spawned fleet is not the operator authoring a group'
    );
    assert.ok(
        /if \(count <= currentSlots\) \{ return currentLayout; \}/.test(
            block(terminalsJs, 'function layoutForFleetCount(count) {', 'function smallestLayoutFitting(')
        ),
        'layoutForFleetCount must keep its grow-only ratchet — only the group-restore resolver may shrink'
    );
    assert.ok(
        !/currentLayout/.test(block(terminalsJs, 'function smallestLayoutFitting(count) {', 'function growLayoutForFleet(')),
        'smallestLayoutFitting must have NO currentLayout floor — that is the whole point of the split'
    );
});

test('locateTerminal delegates to handleLockedTerminalClick while a group is locked', () => {
    const row = block(terminalsJs, 'itemDiv.addEventListener(\'click\'', 'return itemDiv;\n    }');
    assert.ok(
        row.includes('handleLockedTerminalClick(name)'),
        'row click must call handleLockedTerminalClick when a group is locked'
    );
    assert.ok(
        row.includes('locateTerminal(name)'),
        'row click must call locateTerminal when no group is locked'
    );
});

test('handleLockedTerminalClick distinguishes same-group, cross-group, and unassigned', () => {
    const fn = block(terminalsJs, 'function handleLockedTerminalClick(', 'function promoteGroupMember(');
    assert.ok(
        fn.includes('switchToGroup(group.id)'),
        'handleLockedTerminalClick must switch to another group'
    );
    assert.ok(
        fn.includes('focusPaneTerminal'),
        'handleLockedTerminalClick must focus a visible member'
    );
    // The Unassigned pseudo-group is retired in all three call sites TOGETHER.
    // Retiring it in only getAllGroups() leaves findGroupForTerminalName returning
    // an id switchToGroup cannot resolve — a silent no-op on every ungrouped
    // terminal clicked under a lock, which is the dead click this feature exists
    // to remove, reintroduced.
    const find = block(terminalsJs, 'function findGroupForTerminalName(name) {', 'function addTerminalToActiveGroup(');
    assert.ok(
        /return null;/.test(find) && !find.includes('getUnassignedGroup'),
        'findGroupForTerminalName must return null for an ungrouped terminal, not a pseudo-group'
    );
    assert.ok(
        !/function getUnassignedGroup\b/.test(terminalsJs),
        'getUnassignedGroup must be deleted outright — do not leave it defined but dead'
    );
    assert.ok(
        !terminalsJs.includes("'__unassigned__'") && !terminalsJs.includes("source === 'unassigned'"),
        'no __unassigned__ id and no unassigned branch may remain anywhere'
    );
    // ...and the !group branch it makes live must not be a dead click either.
    assert.ok(
        fn.includes('if (!group) {') && fn.includes('locateTerminal(name)'),
        'the now-live !group branch must seat the terminal rather than returning silently'
    );
    // Clicking a member you cannot see must show it — anything else is a dead click.
    assert.ok(
        fn.includes('promoteGroupMember(group, idxInGroup'),
        'an off-screen member must be promoted into a visible slot'
    );
    const promote = block(terminalsJs, 'function promoteGroupMember(group, fromIndex, toIndex) {', 'function renderGroupTabStrip()');
    assert.ok(
        promote.includes('setGroupOrder(group, members)'),
        'promotion IS composition — the new order must be persisted'
    );
});

test('deleteGroup handles every source and re-seats when the deleted group was locked', () => {
    const fn = block(terminalsJs, 'function deleteGroup(id) {', 'function clearGroupLock() {');
    assert.ok(
        fn.includes('terminalGroups.filter(g => g.id !== id)'),
        'a manual group must be removed from the record'
    );
    assert.ok(
        fn.includes('groupPrefs.hidden.push(id)'),
        'a derived group must be suppressed via the SHIPPED groupPrefs.hidden key — renaming it would orphan every existing suppression'
    );
    assert.ok(
        /delete groupPrefs\.orders\[id\]/.test(fn) && /groupPrefs\.pinned = groupPrefs\.pinned\.filter/.test(fn),
        'a manual delete must prune its orders entry and its pinned id'
    );
    // Dropping the lock is not enough: without a re-seat the panes keep holding
    // the departed group's terminals with the lock silently gone.
    assert.ok(
        fn.includes('clearGroupLock()'),
        'deleting the LOCKED group must route through clearGroupLock so the grid re-seats from the live fleet'
    );
});

test('clearGroupLock re-seats the grid instead of only repainting the sidebar', () => {
    const fn = block(terminalsJs, 'function clearGroupLock() {', 'function saveSelectionAsGroup(');
    assert.ok(
        !/if \(!activeGroupId\) \{ return; \}/.test(fn),
        'the early return must be gone — "All" from an already-unlocked state is a legitimate reset-my-composition gesture'
    );
    assert.ok(
        fn.includes('paneAssignments = assignments'),
        'clearGroupLock must actually re-seat, not just repaint the sidebar'
    );
    assert.ok(
        fn.includes('smallestLayoutFitting('),
        'the layout must resolve non-monotonically so it can SHRINK from the departed group\'s grid'
    );
    assert.ok(
        /pinnedPanes\[i\]/.test(fn),
        'pinned slots must keep their occupant across the re-seat'
    );
});

test('per-group layouts and the extras overlay both survive the loader whitelist', () => {
    // The loader rebuilds groupPrefs field-by-field and DROPS every key it does
    // not name. Miss a key and the feature works all session and loses its state
    // on reload — with no error anywhere. Both siblings edit the same two sites.
    assert.ok(
        /let groupPrefs = \{ threshold: 2, hidden: \[\], pinned: \[\], orders: \{\}, layouts: \{\}, extras: \{\}, autoRoleGroups: false \}/.test(terminalsJs),
        'the initialiser must carry layouts, extras and the autoRoleGroups consent flag'
    );
    const loader = block(terminalsJs, "const savedGroupPrefs = await loadSetting('terminals.groupPrefs', null);", 'if (LAYOUT_MODES.includes(savedMode))');
    assert.ok(
        /layouts: savedLayouts/.test(loader) && /extras: savedExtras/.test(loader),
        'the loader whitelist must name BOTH layouts and extras, or one sibling silently disables the other'
    );
    assert.ok(
        /autoRoleGroups: savedGroupPrefs\.autoRoleGroups === true/.test(loader),
        'the loader whitelist must name autoRoleGroups, or the toggle forgets on reload with no error'
    );
    assert.ok(
        loader.includes('LAYOUT_MODES.includes(v)'),
        'stored layouts must be validated on read so a stale or hand-edited setting cannot inject an unknown layout id'
    );
    assert.ok(
        /extras[\s\S]{0,400}filter\(name => typeof name === 'string'\)/.test(loader),
        'extras values must be coerced to arrays of strings on read'
    );
});

test('getGroupMembers counts one population — no delegate children, extras unioned live', () => {
    const fn = block(terminalsJs, 'function getGroupMembers(group) {', 'function orderGroupMembers(');
    // The role/worktree branches used to filter on status alone, so a delegate
    // child inherited its head's role, joined the group, inflated the count, and
    // — once layouts are persisted — inflated the restored grid by a pane per child.
    const roleBranch = fn.slice(fn.indexOf("group.source === 'role'"));
    assert.ok(
        roleBranch.includes('!t.parentInstanceId'),
        'the role branch must exclude delegate children, matching getDerivedGroups and the manual branch'
    );
    assert.ok(
        fn.slice(fn.indexOf("group.source === 'worktree'")).includes('!t.parentInstanceId'),
        'the worktree branch must exclude delegate children too'
    );
    assert.ok(
        /groupPrefs\.extras\[group\.id\]/.test(fn) && /live\.has\(n\)/.test(fn),
        'the extras union must be intersected with the live set explicitly, or a dead name gets seated'
    );
});

test('a locked group survives a shrinking membership and hidden groups are recoverable', () => {
    // A derived delete is recoverable and must say so — relabelled to match the
    // new verb and relocated into the strip's overflow menu.
    const render = block(terminalsJs, 'function renderGroupTabStrip() {', 'function terminalNameSuffix(');
    assert.ok(
        render.includes('deleted group') && render.includes('groupPrefs.hidden = []'),
        'the strip must surface a count of deleted derived groups and a restore-all'
    );
    // A locked derived group whose membership drops below the threshold must NOT
    // silently unlock — the alternative is the view snapping back with no gesture.
    const seat = block(terminalsJs, 'function seatActiveGroupPage() {', 'function safeGroupIdForValue(');
    assert.ok(
        !/activeGroupId = null/.test(seat),
        'the seating path must never drop the lock on its own'
    );
});

// ---------------------------------------------------------------- role picker (regression)

test('pickerState is declared as module state for state-driven rendering', () => {
    assert.ok(/let pickerState = null;/.test(terminalsJs), 'pickerState is module state');
    assert.ok(/let pickerOpening = null;/.test(terminalsJs), 'pickerOpening guards the in-flight double click');
    assert.ok(/let rolePickerData = null;/.test(terminalsJs), 'rolePickerData caches the fetched roles');
    assert.ok(/let pickerNeedsScroll = false;/.test(terminalsJs), 'the scroll flag is one-shot');
});

test('the strip owns the group:* picker key and reports it into pickerRendered', () => {
    // renderSidebarList ends with `if (pickerState && !pickerRendered) { pickerState = null; }`.
    // The strip's picker is mounted OUTSIDE listEl (that is the point of the strip),
    // so unless the strip reports it, that line nulls pickerState on the very next
    // 5-second fleet poll and the picker vanishes mid-choice. The innerHTML wipe is
    // not what kills it; this line is.
    const render = block(terminalsJs, 'function renderGroupTabStrip() {', 'function terminalNameSuffix(');
    assert.ok(
        !/pickerState\.key !== '__groups__'[\s\S]*pickerState = null/.test(render),
        'the strip must not clear a non-group pickerState — that would kill every per-workspace +'
    );
    assert.ok(render.includes('pickerRendered = true;'), 'the strip must report a mounted picker');
    const list = block(terminalsJs, 'function renderSidebarList() {', 'function syncLayoutPickerUI()');
    assert.ok(
        list.includes('if (renderGroupTabStrip()) { pickerRendered = true; }'),
        'the caller must fold the strip into its pickerRendered bookkeeping'
    );
    // The propagation must be the SOLE signal: an unconditional "any group:* key
    // counts as rendered" guard in renderSidebarList would make the garbage-collect
    // unreachable for a key whose group has since been deleted, stranding it forever.
    assert.ok(
        !/startsWith\('group:'\)[\s\S]{0,120}pickerRendered = true/.test(list),
        'renderSidebarList must not blanket-report group:* keys — the strip decides, after checking the group still resolves'
    );
    assert.ok(
        render.includes('groupStillExists'),
        'the strip must confirm the group still resolves before mounting, so a picker opened against a since-deleted group is garbage-collected'
    );
});

test('the not-rendered clear appears after the parents loop, not inside it', () => {
    const render = block(terminalsJs, 'function renderSidebarList() {', 'function syncLayoutPickerUI()');
    assert.ok(
        /if \(pickerState && !pickerRendered\) \{ pickerState = null; \}/.test(render),
        'the sweep must survive the groups-tier rework'
    );
});

test('the picker mounts into the owning group container, not a shared node', () => {
    const render = block(terminalsJs, 'function renderSidebarList() {', 'function syncLayoutPickerUI()');
    assert.ok(/parentDiv\.appendChild\(mountRolePicker/.test(render), 'workspace rows mount their own picker');
    assert.ok(/wtDiv\.appendChild\(mountRolePicker/.test(render), 'worktree rows mount their own picker');
});

// ---------------------------------------------------------------- save / selection

test('saveCurrentAsGroup creates a manual group from current pane members', () => {
    const fn = block(terminalsJs, 'function saveCurrentAsGroup(', 'function deleteGroup(');
    assert.ok(
        fn.includes("source: 'manual'"),
        'saveCurrentAsGroup must create manual groups'
    );
    assert.ok(
        fn.includes('members: visible'),
        'saveCurrentAsGroup must store pane members'
    );
});

test('multi-select and group-selected affordances exist', () => {
    const row = block(terminalsJs, 'function renderSidebarList() {', 'function syncLayoutPickerUI()');
    assert.ok(
        row.includes('selectedTerminalNames.size > 0'),
        'renderSidebarList must detect an active selection'
    );
    assert.ok(
        row.includes('saveSelectionAsGroup'),
        'the selection UI must offer saveSelectionAsGroup'
    );
});

// ---------------------------------------------------------------- rename and banner

test('renameTerminal only fixups manual group members/order', () => {
    const renameBlock = block(terminalsJs, 'async function renameTerminal(', 'function beginInlineRename(');
    assert.ok(
        renameBlock.includes("if (g.source !== 'manual') { continue; }"),
        'renameTerminal must skip derived groups'
    );
    assert.ok(
        renameBlock.includes("'members', 'order'"),
        'renameTerminal must touch the members and order arrays'
    );
});

test('applyLayoutFloor shows a group-aware shortfall banner', () => {
    const fn = block(terminalsJs, 'function applyLayoutFloor(', '/** Attempt schedule');
    assert.ok(
        fn.includes('activeGroupId ? getAllGroups().find'),
        'applyLayoutFloor must look up the active group for banner text'
    );
    assert.ok(
        fn.includes('Showing'),
        'applyLayoutFloor must produce a showing-N-of-M message'
    );
});

// ---------------------------------------------------------------- html contracts

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

test('terminals.html styles the group tier and selected rows', () => {
    assert.ok(
        terminalsHtml.includes('.group-tier-header'),
        'terminals.html must contain .group-tier-header CSS'
    );
    assert.ok(
        terminalsHtml.includes('.terminal-item.is-selected'),
        'terminals.html must contain .terminal-item.is-selected CSS'
    );
});

// ---------------------------------------------------------------- team seating (createTerminal team branch)

test('createTerminal team branch calls switchToTeamGroup and not assignToFocusedPane', () => {
    // Slice the TEAM branch only — from the `else if` that owns it to the
    // reportTeamStart call. Deliberately NOT from `if (delegates.length === 0)`:
    // that slice swallows the no-delegate branch, whose assignToFocusedPane call
    // is REQUIRED (the common path must not regress), so the "no
    // assignToFocusedPane" assertion below could never pass. The team branch
    // must seat via switchToTeamGroup, NOT assignToFocusedPane — that helper
    // drops the group lock and would undo the seating on the next reconcile.
    const start = terminalsJs.indexOf('} else if (data.teamGroupId');
    assert.ok(start !== -1, 'team branch marker (else if data.teamGroupId) not found');
    const end = terminalsJs.indexOf('reportTeamStart(', start);
    assert.ok(end !== -1, 'reportTeamStart marker not found after team branch');
    const branch = terminalsJs.substring(start, end);
    assert.ok(
        branch.includes('switchToTeamGroup('),
        'the team branch must call switchToTeamGroup to seat the team'
    );
    assert.ok(
        !branch.includes('assignToFocusedPane('),
        'the team branch must NOT call assignToFocusedPane — it drops the group lock'
    );
});

test('switchToTeamGroup awaits reloadTerminalGroups and guards on terminalGroups.some before switchToGroup', () => {
    const fn = block(terminalsJs, 'async function switchToTeamGroup(', 'function focusSeatedTerminal(');
    assert.ok(
        fn.includes('await reloadTerminalGroups()'),
        'switchToTeamGroup must await reloadTerminalGroups before switching'
    );
    assert.ok(
        fn.includes('terminalGroups.some('),
        'switchToTeamGroup must guard on terminalGroups.some — an unguarded switchToGroup is a silent no-op'
    );
    assert.ok(
        fn.includes('switchToGroup(groupId)'),
        'switchToTeamGroup must call switchToGroup with the group id'
    );
});

test('the no-delegate branch still calls assignToFocusedPane(data.terminal.friendlyName)', () => {
    const start = terminalsJs.indexOf('if (delegates.length === 0) {');
    assert.ok(start !== -1, 'no-delegate branch marker not found');
    const end = terminalsJs.indexOf('} else if (data.teamGroupId', start);
    assert.ok(end !== -1, 'team-group branch marker not found');
    const noDelegate = terminalsJs.substring(start, end);
    assert.ok(
        noDelegate.includes('assignToFocusedPane(data.terminal.friendlyName)'),
        'the no-delegate branch must still call assignToFocusedPane — the common path must not regress'
    );
});

test('seatTeamWithoutGroup seats by name and the create path has no bare fillEmptyPanes call', () => {
    const fn = block(terminalsJs, 'function seatTeamWithoutGroup(', 'function reportTeamStart(');
    assert.ok(
        fn.includes('delegates.map('),
        'seatTeamWithoutGroup must seat the team\'s own names via delegates.map'
    );
    assert.ok(
        !fn.includes('fillEmptyPanes('),
        'seatTeamWithoutGroup must not use fillEmptyPanes — it seats in fleetList order with no team notion'
    );
    // growLayoutForFleet only drops the lock as a setLayoutMode side effect, and
    // it no-ops when the grid already fits. Without an explicit clear, a fallback
    // seat under an existing lock is reverted by the next seatActiveGroupPage().
    assert.ok(
        /activeGroupId = null;/.test(fn) && /activeGroupPage = 0;/.test(fn),
        'seatTeamWithoutGroup must drop the group lock explicitly — a stale lock re-seats the OLD group over the team'
    );
    // The create path (from the fetch to the end of createTerminal) must contain
    // no bare fillEmptyPanes() call — the fallback reproduces the bug otherwise.
    const createStart = terminalsJs.indexOf("const res = await fetch('/terminals/verb/ptyCreateTerminal', {");
    const createEnd = terminalsJs.indexOf('async function switchToTeamGroup(', createStart);
    assert.ok(createStart !== -1 && createEnd !== -1, 'createTerminal bounds not found');
    const createPath = terminalsJs.substring(createStart, createEnd);
    assert.ok(
        !createPath.includes('fillEmptyPanes('),
        'the createTerminal path must not call fillEmptyPanes — the fallback seats by name, not fleetList order'
    );
});

test('focusSeatedTerminal assigns focusedPaneIndex and activeTerminalName without assignToFocusedPane', () => {
    const fn = block(terminalsJs, 'function focusSeatedTerminal(', 'function seatTeamWithoutGroup(');
    assert.ok(
        fn.includes('focusedPaneIndex = idx;'),
        'focusSeatedTerminal must assign focusedPaneIndex directly'
    );
    assert.ok(
        fn.includes('activeTerminalName = name;'),
        'focusSeatedTerminal must assign activeTerminalName directly'
    );
    assert.ok(
        !fn.includes('assignToFocusedPane('),
        'focusSeatedTerminal must NOT call assignToFocusedPane — that helper drops the group lock'
    );
});

// ---------------------------------------------------------------- team seating (startTeam / START TEAM button)

test('startTeam seats the whole team via switchToTeamGroup with a seatTeamWithoutGroup fallback', () => {
    // START TEAM used to end on `assignToFocusedPane(headName)`, which seats
    // exactly ONE terminal into the focused pane and drops the group lock — so
    // the head landed in whatever grid was open and every member stayed
    // invisible. The three branches below are the create path's, reused.
    const fn = block(terminalsJs, 'async function startTeam(', 'const GRID_BUILTIN_ROLES = [');
    assert.ok(
        fn.includes('switchToTeamGroup(data.teamGroupId, headName)'),
        'startTeam must seat the team by switching to the group id the backend returned'
    );
    assert.ok(
        fn.includes('seatTeamWithoutGroup(headName, workers)'),
        'startTeam must fall back to seating the team by name when no group is available'
    );
    assert.ok(
        !/'team_'|"team_"|`team_/.test(fn),
        'startTeam must NOT re-derive the group id client-side — the formula lives in wireSpawnedTeam'
    );
});

test('startTeam calls assignToFocusedPane only on the member-less branch', () => {
    const fn = block(terminalsJs, 'async function startTeam(', 'const GRID_BUILTIN_ROLES = [');
    // The literal guard is the contract: a refactor that reinstates the
    // unconditional seat has to delete this line, and CI catches it.
    assert.ok(
        fn.includes('workers.length === 0'),
        'startTeam must guard assignToFocusedPane behind a workers.length === 0 check'
    );
    const teamBranch = fn.substring(fn.indexOf('} else if (data.teamGroupId'));
    assert.ok(
        teamBranch.length > 0 && !teamBranch.includes('assignToFocusedPane('),
        'the team branch of startTeam must NOT call assignToFocusedPane — it drops the group lock'
    );
});

test('startTeam delivers the seat-fallback notice alongside a wiring warning', () => {
    // A wiring failure is EXACTLY the case that also forces the by-name seat
    // (no group registered), so an early-return / else-if toast chain reports
    // the wiring error and never that the team is unlocked from its group. The
    // plan requires both notices to reach the operator.
    const fn = block(terminalsJs, 'async function startTeam(', 'const GRID_BUILTIN_ROLES = [');
    const toasts = fn.match(/showPaneToast\(`Team started with[^`]*`\)/g) || [];
    assert.strictEqual(
        toasts.length, 2,
        'startTeam must carry both warning toasts (delegate warning, wiring warning)'
    );
    for (const t of toasts) {
        assert.ok(
            t.includes('${seatNote}'),
            `the seat-fallback note must ride along with every warning toast, not compete with it: ${t}`
        );
    }
});

test('startTeam awaits fetchTerminalList before it seats', () => {
    // getGroupMembers() filters the group's stored names through a liveness set
    // built from fleetList, so seating before the refresh resolves the team to
    // its head alone — the same ordering bug the create path was fixed for.
    const fn = block(terminalsJs, 'async function startTeam(', 'const GRID_BUILTIN_ROLES = [');
    const fetchIdx = fn.indexOf('await fetchTerminalList()');
    const seatIdx = fn.indexOf('switchToTeamGroup(');
    assert.ok(fetchIdx !== -1, 'startTeam must await fetchTerminalList()');
    assert.ok(seatIdx !== -1, 'startTeam must seat via switchToTeamGroup');
    assert.ok(
        fetchIdx < seatIdx,
        'fetchTerminalList must be awaited BEFORE seating, or the team resolves to its head alone'
    );
});

test('the keepLock call-site count is still exactly 1 (no new keepLock callers)', () => {
    // This change adds no keepLock caller — the team branch seats via
    // switchToGroup, not assignToFocusedPane with keepLock.
    const keepLockCallers = (terminalsJs.match(/assignToFocusedPane\([^)]*keepLock/g) || []).length;
    assert.strictEqual(
        keepLockCallers, 1,
        'only handleLockedTerminalClick\'s free-slot branch may pass keepLock — the team branch must not add one'
    );
});

// ---------------------------------------------------------------- role group consent and location scoping

test('role groups are opt-in and never span a workspace or worktree', () => {
    const derived = block(terminalsJs, 'function getDerivedGroups()', 'function getAllGroups()');
    assert.ok(
        /if \(groupPrefs\.autoRoleGroups\)/.test(derived),
        'the role arm must be gated on consent — a second planner must not conjure a "Planners" tab'
    );
    assert.ok(
        derived.includes('locationKeyForTerminal(t)') && /role \+ LOC_SEP \+ loc/.test(derived),
        'the role key must carry a location component (NUL-separated), or two workspaces\' planners become one group'
    );
    // Slice from the worktree EMISSION loop, not from the first mention of
    // `worktreeMap` — that is `const worktreeMap = new Map()` at the top of the
    // function, so slicing there swallows the role arm's own consent gate and
    // the assertion below can never pass against a correct implementation.
    const worktreeArm = derived.slice(derived.indexOf('for (const [wt, count] of worktreeMap)'));
    assert.ok(
        !/autoRoleGroups/.test(worktreeArm),
        'worktree groups stay automatic — they are location-keyed by construction and were not the complaint'
    );
});

test('the role membership query filters on location, not role alone', () => {
    const fn = block(terminalsJs, 'function getGroupMembers(group) {', 'function orderGroupMembers(');
    const roleBranch = fn.slice(fn.indexOf("group.source === 'role'"), fn.indexOf("group.source === 'worktree'"));
    assert.ok(
        roleBranch.includes('locationKeyForTerminal(t) === group.location'),
        'membership must use the same role+location predicate getDerivedGroups keys on'
    );
    assert.ok(
        roleBranch.includes('!t.parentInstanceId'),
        'delegate children stay excluded'
    );
});

test('the role-grouping toggle is reachable with no group tabs on screen', () => {
    // The » menu is the ONLY control that turns role grouping back on. It used
    // to be built solely when there were tabs or hidden groups — both false in
    // exactly the state the toggle exists to escape.
    const strip = block(terminalsJs, 'function renderGroupTabStrip() {', 'function terminalNameSuffix(');
    assert.ok(
        strip.includes('Group by role'),
        'the strip must carry the role-grouping toggle'
    );
    assert.ok(
        !/if \(groupTabEls\.length > 0 \|\| hasHiddenGroups\)/.test(strip),
        'the overflow measurement must not be gated on there being tabs — the toggle lives inside it'
    );
    assert.ok(
        !/if \(overflowing\.length > 0 \|\| hasHiddenGroups\)/.test(strip),
        'the overflow BUILD must not be gated either — the outer gate alone still yields no menu at zero tabs'
    );
    assert.ok(
        !/if \(true\)|\|\| true/.test(strip),
        'no tautological gate left behind — delete the condition, do not neutralise it'
    );
});

test('a load-time lock is dropped only when consent has removed its group', () => {
    const fetchBlock = block(terminalsJs, 'async function fetchTerminalList()', 'function checkSoloNotFound()');
    assert.ok(
        /restoredLockOnLoad[\s\S]{0,1400}clearGroupLock\(\)/.test(fetchBlock),
        'a role lock that consent has made unreachable must be cleared at the restore site, not left to soft-kill the panel'
    );
    assert.ok(
        /!groupPrefs\.autoRoleGroups && savedId\.startsWith\('dg_role_'\)/.test(fetchBlock),
        'the reconcile must fire only when role grouping is OFF — a merely below-threshold group keeps its lock'
    );
});

// ---------------------------------------------------------------- summary

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
