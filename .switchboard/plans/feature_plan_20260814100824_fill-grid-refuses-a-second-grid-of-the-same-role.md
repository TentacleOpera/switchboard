# FILL GRID must build a second grid of a role it has already used

## Goal

Make FILL GRID able to create a second (third, Nth) grid of the same agent role, so an operator can hold a **Planner 1** group and a **Planner 2** group at the same time. Today the second one is impossible: FILL GRID refuses with a toast whenever the chosen role already has enough live terminals *anywhere in the fleet*.

### The reported behaviour

Operator wants two planner groups. The first is built (FILL GRID → role `planner`, layout `2x2` → four planner terminals → SAVE AS GROUP "Planner 1"). Building the second one fails on the FILL click with a message the operator recalls as "planner grid already created". The literal toast is `src/webview/terminals.js:6488`:

```js
showPaneToast(`${role} already has ${liveCount} live terminal${liveCount === 1 ? '' : 's'} — no grid to fill.`);
```

### Root cause

`fillGrid(role, mode)` (`src/webview/terminals.js:6474-6501`) derives how many terminals to create from a **fleet-wide** count of the role:

```js
const slots = LAYOUTS[mode].slots;
let liveCount = 0;
for (const t of fleetList) {
    if (t.status !== 'exited' && t.role === role) { liveCount++; }   // ← whole fleet
}
const need = slots - liveCount;
if (need <= 0) { showPaneToast(...); return; }
```

`fleetList` is every live terminal in the workspace, regardless of which pane, page, or group it belongs to. So the guard answers *"does this role exist anywhere?"* when the only question that matters is *"does the grid I am about to fill have empty seats?"*. Once four planners exist, `need` is `4 - 4 = 0` for a `2x2` fill forever — the role is permanently spent.

The guard was written to satisfy one narrow requirement, still asserted in `src/test/terminal-open-all-seating-contract.test.js:153`:

```js
assert.ok(fill.includes('if (need <= 0)'), 're-running a fill must be a no-op, not a fleet doubling');
```

"Pressing FILL twice in a row must not double the fleet" is reasonable. It was implemented as fleet-wide role exclusivity, which is a much stronger — and wrong — rule. The idempotency it wanted survives a destination-scoped count; the exclusivity does not need to.

### Nothing else blocks a second grid

Three candidate blockers were checked and cleared, so the fix is confined to `fillGrid` and its form:

- **Group names are not unique-checked.** `saveCurrentAsGroup` (`terminals.js:2238-2252`) and `saveSelectionAsGroup` (`terminals.js:2372-2387`) push a record with a fresh `grp_<ts>_<rand>` id and never compare names. "Planner 1" and "Planner 2" are already legal.
- **There is no server-side per-role cap.** `PtyFleetService.create()` (`src/standalone/ptyFleetService.ts:188-193`) walks a counter to the next free `${role}-${n}`; `planner-5`…`planner-8` create normally.
- **`createTerminalsForRole`** (`terminals.js:6343-6377`) has no role ceiling of its own.

### Two defects that ride along on the same function

Fixing the count alone leaves FILL GRID unusable *inside* a group, so both are in scope:

1. **FILL GRID silently drops the group lock.** Line 6494 calls `setLayoutMode(mode)` with no options, and `setLayoutMode` (`terminals.js:3393-3412`) treats an unqualified call as a deliberate composer gesture: `if (activeGroupId && !opts.keepLock) { activeGroupId = null; ... }`. Filling while locked to "Planner 1" throws the operator back to free composition.
2. **Created terminals never join the active group.** Line 6497 calls `fillEmptyPanes()` (`terminals.js:6513-6539`), which writes `paneAssignments` and nothing else. Membership is only ever established by `addTerminalToActiveGroup` (`terminals.js:2643-2656`), which `fillGrid` does not call. Anything it seats under a lock is evicted by the next `seatActiveGroupPage()` reconcile (`terminals.js:2440-2461`), because that function rebuilds `paneAssignments` from `getGroupMembers(group)`.

### The fix

Give FILL GRID an explicit **destination** and scope the count to it.

- **New group** — never counts anything. Creates `slots` fresh terminals of the role, registers them as a manual group under a name the operator can edit (defaulted to `Planner 2`, `Planner 3`, …), and locks to it. This is the path the report asks for, and it is unblockable by construction.
- **Current grid** — tops up only the destination's **empty seats**: the locked group's rendered capacity when a group is locked, otherwise the unoccupied panes of the requested layout. Re-pressing FILL on an already-full destination is still a no-op, so the idempotency requirement is kept — it just stops leaking across grids.

> **Superseded:** the current-grid count is role-scoped — `have` counts the *live terminals of `role`* in the locked group's membership, or the *live terminals of `role`* seated in the rendered panes, and `need = slots - have`.
> **Reason:** it disagrees with the function that actually does the seating. `fillEmptyPanes` (`terminals.js:6513-6539`) treats a pane as fillable only when `!paneAssignments[i] && paneModes[i] !== 'kanban'` — so a pane holding a **kanban board column** or a terminal of a **different role** is not a seat this fill can take, yet a role-scoped count reports it as missing. The result is over-creation: a `2x2` with one kanban pane and three planners counts `have = 3`, creates one more planner, and has nowhere to put it — the "could not be seated" toast fires on a grid the operator was told had room. The original plan's own edge-case notes ("Kanban panes are not free seats", "mirror `fillEmptyPanes`") state the requirement correctly and the proposed code did not implement it.
> **Replaced with:** count **seats, not roles**. The role now says only *what to create*; the destination says *how many seats are free*. Locked → `have = getGroupMembers(group).length` (a group is a membership list and pages, so a full membership means a full grid). Unlocked → `have` is the number of indices `i < slots` where `paneAssignments[i]` is set **or** `paneModes[i] === 'kanban'`. This is the same predicate `fillEmptyPanes` will apply, so the count and the seat can no longer disagree, and it answers the root-cause question ("does the grid I am about to fill have empty seats?") literally.

Under a lock, the current-grid path additionally passes `{ keepLock: true }` to `setLayoutMode`, records the chosen mode as the group's stored layout, calls `addTerminalToActiveGroup` for each created terminal *before* seating, and seats through `seatActiveGroupPage()` rather than `fillEmptyPanes()`.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

## User Review Required

None. Every open question in this plan is decided in it: seat-scoped counting, `new` as the default destination, the derived `Planners` tab is left visible, and the two contract-test files this change owns are named with the exact assertions to rewrite.

## Complexity Audit

### Routine

- Adding a third `<select>` and a name `<input>` to the existing `#fill-grid-form` (`src/webview/terminals.html:1950-1957`) — the form, its CSS (`.fill-grid-form`, `.fill-grid-actions`, `terminals.html:1836-1842`), and its show/hide wiring (`terminals.js:859-927`) all already exist.
- Replacing the fleet-wide loop with a seat-scoped count. Same shape, different source array.
- Factoring the duplicated manual-group literal out of `saveCurrentAsGroup` and `saveSelectionAsGroup` into one `createManualGroup(name, members, layout)` so the new-group fill path does not become a third copy.

### Complex / Risky

- **`setLayoutMode`'s lock-drop is load-bearing elsewhere.** Passing `keepLock: true` is correct only on the group-scoped path. The new-group path must *not* pass it — it wants the lock dropped and then re-taken by `switchToGroup(id)`. Getting this backwards strands the grid on the old group's members.
- **Ordering around `addTerminalToActiveGroup` is documented as load-bearing** (`terminals.js:2635-2642`: "Must be called BEFORE seating so the next seatActiveGroupPage reconcile … does not evict the addition"). The create loop must add membership per terminal as it is born, not in a tail pass after seating.
- **`addTerminalToActiveGroup` persists on every call.** Its last line is `saveLayoutSettings()` — 11 setting POSTs (`terminals.js:6438-6440`). Calling it once per created terminal inside the create loop is 8×11 = 88 POSTs for a `3x3` fill. It needs a `persist:false` option, mirroring `fillEmptyPanes(opts)`, with one explicit save in the tail.
- **Two contract-test files pin the current behaviour and go red**, not one:
  - `src/test/terminal-open-all-seating-contract.test.js:135-159` — three assertions, plus a block marker keyed on the old signature.
  - `src/test/terminal-sidebar-groupings-contract.test.js:668-680` — `block('function saveCurrentAsGroup(', 'function deleteGroup(')` then `assert.ok(fn.includes("source: 'manual'"))`. Rewriting `saveCurrentAsGroup` as a `createManualGroup` caller removes that literal from the block. Both must be amended in the same change.
- **Manual groups persist to `terminals.groups`** (`terminals.js:1511`) and are merged from a `terminalsGroupsChanged` push (`reloadTerminalGroups`, `terminals.js:1526-1547`, which unions by id and validates `LAYOUT_MODES.includes(g.layout)`). A record with an invalid `layout` is silently dropped by that validator on the next window's merge, so `createManualGroup` must guarantee a valid mode.
- **Serialized creates are a correctness requirement, not a style choice.** `ptyFleetService.create()` picks the next free name off its own map, so parallel creates for one role collide (`terminal-open-all-seating-contract.test.js:119-133`). The new-group path must reuse `createTerminalsForRole`, never `Promise.all`.

## Edge-Case & Dependency Audit

### Race Conditions

- **Serialized creates.** `createTerminalsForRole` awaits each `POST /terminals/verb/ptyCreateTerminal` in turn because `ptyFleetService.create()` allocates `${role}-${n}` off its own map. Parallelising collides on a name. Pinned by `terminal-open-all-seating-contract.test.js:119-133`; do not introduce `Promise.all` on any new path.
- **`terminalsGroupsChanged` union merge.** A second terminals window merges `terminals.groups` by id (`reloadTerminalGroups`, `terminals.js:1526-1547`). A group created here appears there on the next push. The merge validates `typeof g.id === 'string' && typeof g.name === 'string' && LAYOUT_MODES.includes(g.layout)` and drops anything else, so `createManualGroup`'s layout coercion is what keeps a new group visible in other windows.
- **`fetchTerminalList()` re-entrancy on first load.** It calls `switchToGroup(activeGroupId, { noSave: true })` exactly once (`restoredLockOnLoad`, `terminals.js:1570-1573`). The fill paths run long after that one-shot has fired, so the refetch inside `fillGrid` will not re-seat behind the fill.

### Security

- No new network surface. `fillGrid` reaches only `ptyCreateTerminal` and `ptyListTerminals`, both already called from this file. The group name is written to `textContent` in `renderGroupTabStrip` (`terminals.js:2803`), never `innerHTML`, so an operator-typed name is inert.

### Side Effects

- **The derived role group is not the manual group.** `getDerivedGroups()` (`terminals.js:2468-2502`) auto-materialises exactly one "Planners" tab once `groupPrefs.threshold` (default 2, `terminals.js:101`) planners are live, and it always contains *every* live planner. After this change the strip shows `Planners` (derived, 8 members) alongside `Planner 1` and `Planner 2` (manual, 4 each). That is correct and expected — the derived tab is a role filter, not a grid — but it must not be mistaken for the fill having leaked. Do not attempt to suppress it.
- **Layout floor can shrink the grid.** `setLayoutMode` runs `applyLayoutFloor()`, so a `2x2` fill in a narrow window renders fewer slots than `LAYOUTS[mode].slots`. Terminals are still created for the full `slots` count (that is existing FILL GRID behaviour). For the **new-group** path the remainder is *not* lost — a locked group pages (`seatActiveGroupPage`, `terminals.js:2440-2461`), so the honest message names the page, not a bigger grid. For the **unlocked** path the remainder really is unseated and `fillEmptyPanes`' existing toast is correct.

  > **Superseded:** the new-group path emits `${n} terminal(s) could not be seated — choose a larger grid.`
  > **Reason:** the new-group path ends in `switchToGroup`, which takes a lock, and a locked group **pages** its membership across `activeGroupPage`. The terminals are seated — on page 2. Telling the operator to choose a larger grid describes the unlocked path's failure mode, not this one, and sends them to fix something that is not broken.
  > **Replaced with:** `${n} of ${born.length} on page 1 — the rest are on the next page.` (only when `born.length > rendered`).

- **Persistence is one write per path.** The new-group path creates → registers → `switchToGroup` (which calls `saveLayoutSettings`). The locked current-grid path adds membership with `persist:false` and saves once after `seatActiveGroupPage()`. The unlocked path lets `fillEmptyPanes()` persist as it does today.
- **The locked path changes the rendered layout but must also record it.** `setLayoutMode(mode, { keepLock: true })` writes `currentLayout`/`effectiveLayout` but not `group.layout`, which is what `layoutForGroupSwitch` (`terminals.js:2616-2620`) reads on the next switch. Without `group.layout = mode`, filling "Planner 2" to `3x3` reverts to `2x2` the moment the operator clicks another tab and back. Set it on the locked branch.

### Dependencies & Conflicts

- **Same-file serialisation with the sibling subtask.** "The Group Tab's × …" edits `renderGroupTabStrip`, `closeTerminal` and adds `closeGroup` in the same `src/webview/terminals.js`, and amends `src/test/terminal-sidebar-groupings-contract.test.js` — the file this plan also amends. Do not dispatch the two concurrently.
- **Delegate children.** Group membership queries exclude `parentInstanceId` rows (`terminals.js:2544-2546`), but a manual group's `members` array is explicit. `createTerminalsForRole` only ever creates top-level terminals, so the new-group members array is clean by construction — no filter needed, but do not copy `fleetList` wholesale into it.
- **`need > slots` is impossible; `need <= 0` on the new-group path is impossible.** The new-group path sets `need = slots` unconditionally. Keep the `LAYOUT_MODES.includes(mode)` validation at the top (`terminals.js:6475`) — it guards the `LAYOUTS[mode]` index and is contract-asserted.
- **Empty group name.** Reuse the existing fallback shape rather than refusing: `saveCurrentAsGroup` falls back to `` `Group ${terminalGroups.length + 1}` ``. A blank name field must produce that fallback, never an empty tab.
- **No confirm gate.** Per `CLAUDE.md` and `terminal-open-all-seating-contract.test.js:158`, `confirm(` must not appear in `fillGrid`. The destination select is a form control, not a confirmation step; the new-group name input is an ordinary form field.
- **Form listeners must be registered once.** `fillGridRole`/`fillGridMode`/`fillGridCancel` are resolved at `terminals.js:859-864`, outside the `btn-fill-grid` click handler. The two new elements must join them there. Registering `change`/`input` listeners *inside* the open handler would add a fresh listener on every open, so the third open runs `syncDestUI` three times per change.
- **`createManualGroup` is not the only place the manual shape appears.** `loadLayoutSettings` (`terminals.js:1435-1437`) coerces a legacy `(layout, assignments)` snapshot into `{ …, source: 'manual', … }` on read. That is a load-time migration of an already-stored record, not a creation site, and it stays. Any "single writer" assertion must account for it — the file-wide count of the literal is **2**, not 1.

## Dependencies

- `sess_intra_feature — The Group Tab's × Deletes the Group Label and Leaves Every Terminal Running` — same-file (`src/webview/terminals.js`) and same-test-file (`src/test/terminal-sidebar-groupings-contract.test.js`) sibling subtask. Serialise; this plan lands first.
- No external session dependencies.

## Adversarial Synthesis

**Risk summary.** The dangerous edits are not the new form controls but the three places where this change touches load-bearing shared state: `setLayoutMode`'s lock-drop (correct only on the group-scoped path), `addTerminalToActiveGroup`'s before-seating ordering and its per-call `saveLayoutSettings()`, and the manual-group record shape that a second window validates on merge. The count itself is only safe once it is expressed in the same predicate the seater uses — a role-scoped count silently over-creates against kanban panes and foreign-role panes. Mitigations: seat-scoped counting that mirrors `fillEmptyPanes`, a `persist:false` option on `addTerminalToActiveGroup` with one tail save, a layout-validating `createManualGroup`, and rewriting the assertions in **both** contract files this change invalidates rather than the one the original plan named.

## Proposed Changes

### 1. `src/webview/terminals.html` — destination controls in the fill form

Extend the existing form (currently lines 1950-1957). Two additions: a destination select and a name input shown only for the new-group destination.

```html
<form id="fill-grid-form" class="fill-grid-form" hidden>
    <select id="fill-grid-role" class="link-select" required></select>
    <select id="fill-grid-mode" class="link-select" required></select>
    <!-- Destination. "New group" is the reason this select exists: without it a
         role that already has a grid can never get a second one. -->
    <select id="fill-grid-dest" class="link-select" required>
        <option value="new">New group — build another grid</option>
        <option value="current">Current grid — top up empty panes</option>
    </select>
    <input type="text" id="fill-grid-name" class="item-name-input" placeholder="Group name">
    <div class="fill-grid-actions">
        <button type="button" id="fill-grid-cancel" class="secondary-btn">CANCEL</button>
        <button type="submit" id="fill-grid-confirm" class="secondary-btn is-teal">FILL</button>
    </div>
</form>
```

`new` is first so it is the default — it is the safe destination (it never refuses) and the one the report is about. Update the button's `title` at line 1949 from "Create a grid full of one role's agents" to "Create a new grid of one role's agents, or top up the current one".

Add to the existing `.fill-grid-form` block at `terminals.html:1836-1842` (`.item-name-input` already exists at `terminals.html:243` and supplies the border/colour):

```css
.fill-grid-form .item-name-input { width: 100%; box-sizing: border-box; }
.fill-grid-form .item-name-input[hidden] { display: none; }
```

The `[hidden]` rule is required: `.fill-grid-form` is `display: flex`, and a flex item's `display` beats the UA `[hidden]` rule, so the name field would stay visible on the `current` destination without it.

### 2. `src/webview/terminals.js` — factor the manual-group record

`saveCurrentAsGroup` (2238-2252) and `saveSelectionAsGroup` (2372-2387) already build the same literal twice. Add one builder **above `saveCurrentAsGroup`** and have the new fill path be its third caller rather than a third copy:

```js
/**
 * Build and register a manual group record. The single CREATION site of the
 * { id, name, source:'manual', layout, members, order } shape — three callers
 * (SAVE AS GROUP, save-selection, FILL GRID → new group) had otherwise drifted
 * apart on the name fallback. Does NOT persist: callers finish with
 * switchToGroup (which saves) or their own saveLayoutSettings.
 *
 * The layout coercion is load-bearing, not defensive: reloadTerminalGroups()
 * validates LAYOUT_MODES.includes(g.layout) on the terminalsGroupsChanged
 * merge, so a record with an unknown layout is silently dropped in every
 * OTHER open terminals window while looking fine in this one.
 *
 * NOT the only place the shape appears: loadLayoutSettings() coerces a legacy
 * (layout, assignments) snapshot into the same shape on read. That is a
 * read-time migration of an already-stored record, not a creation site.
 */
function createManualGroup(name, members, layout) {
    const id = 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const list = Array.isArray(members) ? members.filter(Boolean) : [];
    const group = {
        id,
        name: (name || '').trim() || `Group ${terminalGroups.length + 1}`,
        source: 'manual',
        layout: LAYOUT_MODES.includes(layout) ? layout : currentLayout,
        members: list,
        order: list.slice()
    };
    terminalGroups.push(group);
    return group;
}
```

Rewrite the two existing functions as thin callers:

```js
function saveCurrentAsGroup(name) {
    const visible = paneAssignments.slice(0, getSlotCount(effectiveLayout)).filter(Boolean);
    const group = createManualGroup(name, visible, currentLayout);
    saveLayoutSettings();
    switchToGroup(group.id);
}

function saveSelectionAsGroup(name) {
    const members = Array.from(selectedTerminalNames);
    createManualGroup(name, members, layoutForFleetCount(members.length));
    selectedTerminalNames.clear();
    saveLayoutSettings();
    renderSidebarList();
}
```

> Behaviour note: `order` becomes `list.slice()` rather than the same array object as `members`. Today both fields alias one array, so `addTerminalToActiveGroup`'s `group.members.push(name)` followed by its `group.order.includes(name)` check finds the name already present and never appends to `order` — harmless only because they are the same array. Copying makes the two fields independent, which is what every reader (`getGroupMembers`, `orderGroupMembers`) already assumes.

### 3. `src/webview/terminals.js` — `addTerminalToActiveGroup` gains `persist`

`fillGrid`'s locked path calls this once per created terminal. Its trailing `saveLayoutSettings()` is 11 setting POSTs, so a `3x3` fill would issue 88. Mirror the `fillEmptyPanes(opts)` pattern already used for exactly this reason:

```js
    function addTerminalToActiveGroup(name, opts) {
        const group = getAllGroups().find(g => g.id === activeGroupId);
        if (!group) { return; }
        if (group.source === 'manual') {
            if (!group.members) { group.members = []; }
            if (!group.members.includes(name)) { group.members.push(name); }
            if (Array.isArray(group.order) && !group.order.includes(name)) { group.order.push(name); }
        } else {
            if (!groupPrefs.extras) { groupPrefs.extras = {}; }
            if (!Array.isArray(groupPrefs.extras[activeGroupId])) { groupPrefs.extras[activeGroupId] = []; }
            if (!groupPrefs.extras[activeGroupId].includes(name)) { groupPrefs.extras[activeGroupId].push(name); }
        }
        // opts.persist === false: a batch caller saves once in its tail.
        // saveLayoutSettings() is 11 setting POSTs — per-terminal is 88 for a 3x3.
        if (!opts || opts.persist !== false) { saveLayoutSettings(); }
    }
```

Every existing call site passes no second argument and is unchanged.

### 4. `src/webview/terminals.js` — rewrite `fillGrid` (6474-6501)

```js
/**
 * Create a grid of one role's agents.
 *
 * dest === 'new'      → always creates `slots` fresh terminals and registers them
 *                       as a new manual group. Counts NOTHING: the whole point is
 *                       that a role which already has a grid can get another one.
 * dest === 'current'  → tops up the DESTINATION's EMPTY SEATS only. The locked
 *                       group's membership when a group is locked, otherwise the
 *                       occupied panes of the requested layout.
 *
 * The count is deliberately NOT fleet-wide, and deliberately NOT role-scoped.
 * Fleet-wide made a role single-use: four live planners meant `need <= 0` for
 * every subsequent 2x2 fill, forever. Role-scoped would disagree with the
 * function that does the seating — fillEmptyPanes treats a kanban pane and a
 * pane holding another role as occupied, so counting only this role's terminals
 * reports free seats that do not exist and over-creates. The role says WHAT to
 * create; the destination says HOW MANY SEATS ARE FREE.
 *
 * Re-pressing FILL on a full destination is still a no-op — that is the
 * idempotency the old guard was reaching for, without the exclusivity it caused.
 */
async function fillGrid(role, mode, dest, groupName) {
    if (!role || !LAYOUT_MODES.includes(mode)) {
        console.warn('[Terminals] Fill grid: bad role or mode', role, mode);
        return;
    }
    const slots = LAYOUTS[mode].slots;
    const newGroup = dest !== 'current';
    const group = (!newGroup && activeGroupId)
        ? getAllGroups().find(g => g.id === activeGroupId)
        : null;

    let need = slots;
    if (!newGroup) {
        let have = 0;
        if (group) {
            // A group is a membership list and it PAGES, so a full membership is
            // a full grid regardless of which page is on screen.
            have = getGroupMembers(group).length;
        } else {
            // Exactly fillEmptyPanes' predicate, inverted: a slot is occupied when
            // it holds a terminal OR is showing a live kanban board column. Counted
            // against the REQUESTED mode's slot count, because setLayoutMode has not
            // run yet — paneAssignments is always getMaxSlotCount() long, so every
            // index below `slots` is safe to read.
            for (let i = 0; i < slots; i++) {
                if (paneAssignments[i] || paneModes[i] === 'kanban') { have++; }
            }
        }
        need = slots - have;
        if (need <= 0) {
            showPaneToast(group
                ? `${group.name} has no empty seats (${have} of ${slots}) — pick "New group" to build another.`
                : `This grid has no empty seats — pick "New group" to build another.`);
            return;
        }
    }

    const { hasCommand } = await fetchPtyVisibleRoles();
    initialAssignmentDone = true;

    if (newGroup) {
        // Lock dropped deliberately: switchToGroup below re-takes it on the new
        // group. Passing keepLock here would strand the grid on the old members.
        setLayoutMode(mode);
        const born = [];
        await createTerminalsForRole(role, need, hasCommand[role] === true, (t) => { born.push(t.friendlyName); });
        await fetchTerminalList();
        const created = createManualGroup(groupName, born, mode);
        switchToGroup(created.id);          // seats page 0 and persists
        const rendered = Math.max(1, getSlotCount(effectiveLayout));
        if (born.length > rendered) {
            // A locked group pages — the remainder is seated, on the next page.
            // "Choose a larger grid" would be the UNLOCKED path's message.
            showPaneToast(`${rendered} of ${born.length} on page 1 — the rest are on the next page.`);
        }
        return;
    }

    // Current grid. keepLock only when a group is actually locked, so the
    // free-composition path keeps its existing (correct) behaviour.
    setLayoutMode(mode, group ? { keepLock: true } : {});
    await createTerminalsForRole(role, need, hasCommand[role] === true, (t) => {
        // BEFORE seating — seatActiveGroupPage rebuilds paneAssignments from
        // getGroupMembers, so a terminal added after the seat is evicted.
        // persist:false — the tail saves once; 11 POSTs per terminal otherwise.
        if (group) { addTerminalToActiveGroup(t.friendlyName, { persist: false }); }
    });
    await fetchTerminalList();
    if (group) {
        // The rendered layout is now `mode`; record it so layoutForGroupSwitch
        // restores it. setLayoutMode writes currentLayout, not group.layout, so
        // without this the fill's grid reverts on the next tab click and back.
        if (group.source === 'manual') { group.layout = mode; }
        seatActiveGroupPage();
        saveLayoutSettings();
    } else {
        const unseated = fillEmptyPanes();
        if (unseated > 0) {
            showPaneToast(`${unseated} terminal${unseated === 1 ? '' : 's'} could not be seated — choose a larger grid.`);
        }
    }
}
```

**Note on a derived locked group:** `group.layout` is only meaningful for `source === 'manual'`; derived groups store theirs in `groupPrefs.layouts[id]` (`getStoredGroupLayout`, `terminals.js:2595-2604`). The guard above keeps the fill from writing a stray field onto a computed group object that `getDerivedGroups()` rebuilds from scratch on every call.

### 5. `src/webview/terminals.js` — form wiring (859-927)

Resolve the two new elements **alongside the existing ones at 859-864**, not inside the click handler:

```js
        const fillGridDest = document.getElementById('fill-grid-dest');
        const fillGridName = document.getElementById('fill-grid-name');
```

Add the guard for them to the existing `if (btnFillGrid && fillGridForm && fillGridRole && fillGridMode)`, and register the listeners **once**, inside that block but outside the open handler:

```js
            // Default name: "Planner 2", "Planner 3", … derived from the manual
            // groups already named after this role's label. Operator-overwritable.
            const defaultGroupName = (roleKey) => {
                const meta = BUILT_IN_AGENT_LABELS.find(r => r.key === roleKey);
                const label = meta ? meta.label : roleKey;
                let n = 1;
                for (const g of terminalGroups) {
                    const name = g.name || '';
                    const m = /\s(\d+)$/.exec(name);
                    if (m && name.slice(0, m.index) === label) { n = Math.max(n, Number(m[1]) + 1); }
                    else if (name === label) { n = Math.max(n, 2); }
                }
                return `${label} ${n}`;
            };

            const syncDestUI = () => {
                const isNew = fillGridDest.value !== 'current';
                fillGridName.hidden = !isNew;
                if (isNew && !fillGridName.value.trim()) {
                    fillGridName.value = defaultGroupName(fillGridRole.value);
                }
            };

            // Registered ONCE. Inside the btn-fill-grid handler these would stack
            // one listener per open, so the third open fires syncDestUI three times.
            fillGridDest.addEventListener('change', syncDestUI);
            fillGridRole.addEventListener('change', () => {
                // Re-seed the suggestion for the new role unless the operator typed.
                if (fillGridName.dataset.touched !== '1') { fillGridName.value = ''; }
                syncDestUI();
            });
            fillGridName.addEventListener('input', () => { fillGridName.dataset.touched = '1'; });
```

In the `btn-fill-grid` click handler, after `fillGridMode.value = currentLayout;`, seed the destination state for this open:

```js
                fillGridDest.value = 'new';
                fillGridName.value = '';
                delete fillGridName.dataset.touched;
                syncDestUI();
```

Reset the same three lines in the CANCEL handler (905-910) and in the submit handler's `finally` (920-925), so the next open re-derives a fresh suggestion.

Submit handler (912-926) forwards the two new values:

```js
                    await fillGrid(fillGridRole.value, fillGridMode.value, fillGridDest.value, fillGridName.value);
```

### 6. `src/test/terminal-open-all-seating-contract.test.js` — retarget the pinned contract

The existing `'Fill grid tops up from fleetList and routes its layout through setLayoutMode'` test (lines 135-159) pins exactly the behaviour being removed:

- `:136` — `block('async function fillGrid(role, mode) {', …)` matches the old signature; the marker itself breaks.
- `:146` — `/t\.status !== 'exited' && t\.role === role/` — the fleet-wide loop is gone.
- `:153` — `fill.includes('if (need <= 0)')` — still true, now inside the `!newGroup` branch. Keep it.
- `:155` — `fill.includes('setLayoutMode(mode)')` — still true (the new-group branch calls it bare), but the assertion is `&&`-joined to `!/effectiveLayout\s*=/.test(fill)`, which also still holds. Rewritten below for clarity.

`SRC.indexOf('async function fillGrid(', fnStart)` at `:247` is a prefix match and survives unchanged.

```js
test('Fill grid scopes its count to the destination and never fleet-wide', () => {
    const fill = block('async function fillGrid(role, mode, dest, groupName) {', 'function fillEmptyPanes(');
    assert.ok(fill.includes('LAYOUTS[mode].slots'), 'the count must derive from LAYOUTS[mode].slots, not a second hardcoded slot table');
    assert.ok(fill.includes('LAYOUT_MODES.includes(mode)'), 'the mode must be validated against LAYOUT_MODES before indexing LAYOUTS');
    assert.ok(
        !/for \(const t of fleetList\)[\s\S]{0,200}t\.role === role/.test(fill),
        'the existing count must NOT be a fleet-wide role scan — that made a role single-use: once one grid existed, every later fill of that role computed need <= 0 forever'
    );
    assert.ok(
        fill.includes('getGroupMembers(group).length') && /paneAssignments\[i\] \|\| paneModes\[i\] === 'kanban'/.test(fill),
        "the top-up count must be SEAT-scoped and must mirror fillEmptyPanes' occupied predicate — a kanban pane and a pane holding another role are not free seats, and a role-scoped count reports them as missing and over-creates"
    );
    assert.ok(fill.includes('if (need <= 0)'), 're-pressing FILL on a full destination must still be a no-op');
    assert.ok(
        /const newGroup = dest !== 'current';[\s\S]*if \(!newGroup\) \{[\s\S]*if \(need <= 0\)/.test(fill),
        'the need<=0 refusal must sit INSIDE the !newGroup branch — the new-group path is the only unblockable way to build a second grid of a role and must never reach it'
    );
    assert.ok(fill.includes('keepLock: true'), 'filling into a locked group must not silently drop the lock (setLayoutMode unlocks on any unqualified call)');
    assert.ok(
        /addTerminalToActiveGroup\(t\.friendlyName, \{ persist: false \}\)/.test(fill),
        'terminals created into a locked group must be registered as members (or seatActiveGroupPage evicts them on the next reconcile) and must NOT persist per terminal — saveLayoutSettings is 11 POSTs'
    );
    assert.ok(fill.includes('group.layout = mode'), "a locked fill must record the chosen layout on the group, or layoutForGroupSwitch reverts it on the next tab click");
    assert.ok(!/getRoleTerminalSet/.test(fill), 'the webview cannot call getRoleTerminalSet, and it cannot see PTY rows anyway');
    assert.ok(!/\bconfirm\(/.test(fill), 'no confirm gate — window.confirm() is a silent no-op in a webview');
    assert.ok(!/Promise\.all/.test(fill), 'creates stay serialized — ptyFleetService.create() picks the next free ${role}-${n} off its own map');
});
```

Add one test for the extracted builder:

```js
test('manual group records have exactly one creation site', () => {
    // Two occurrences, not one: createManualGroup (the creation site) and the
    // legacy (layout, assignments) coercion in loadLayoutSettings, which is a
    // read-time migration of an already-stored record and stays.
    const occurrences = (SRC.match(/source: 'manual',/g) || []).length;
    assert.strictEqual(occurrences, 2, 'createManualGroup plus the loadLayoutSettings legacy coercion — saveCurrentAsGroup, saveSelectionAsGroup and the FILL GRID new-group path must all route through createManualGroup rather than re-inlining the shape');
    for (const marker of ['function saveCurrentAsGroup(', 'function saveSelectionAsGroup(']) {
        const fn = block(marker, '\n    }\n');
        assert.ok(fn.includes('createManualGroup('), `${marker} must route through createManualGroup`);
        assert.ok(!fn.includes("source: 'manual'"), `${marker} must not re-inline the manual-group shape`);
    }
    assert.ok(
        /LAYOUT_MODES\.includes\(layout\) \? layout : currentLayout/.test(block('function createManualGroup(', '\n    }\n')),
        'createManualGroup must coerce the layout — reloadTerminalGroups drops a record whose layout is not in LAYOUT_MODES, so an invalid one vanishes in every OTHER open terminals window'
    );
});
```

### 7. `src/test/terminal-sidebar-groupings-contract.test.js` — the assertion the original plan missed

Lines 668-680 extract `block('function saveCurrentAsGroup(', 'function deleteGroup(')` and assert the block contains `source: 'manual'` and `members: visible`. Both literals leave `saveCurrentAsGroup` when it becomes a `createManualGroup` caller, so this test goes red. Retarget it to the behaviour that still matters — that the function derives its members from the visible panes and routes through the builder:

```js
test('saveCurrentAsGroup creates a manual group from current pane members', () => {
    const fn = block(terminalsJs, 'function saveCurrentAsGroup(', 'function deleteGroup(');
    assert.ok(
        fn.includes('createManualGroup('),
        'saveCurrentAsGroup must create its manual group through the single builder, not a re-inlined literal'
    );
    assert.ok(
        /paneAssignments\.slice\(0, getSlotCount\(effectiveLayout\)\)\.filter\(Boolean\)/.test(fn),
        'saveCurrentAsGroup must store the VISIBLE pane members'
    );
    assert.ok(
        fn.includes('switchToGroup('),
        'saving the current arrangement must lock to the group it just created'
    );
});
```

> Note on the runner: these contract files are plain Node scripts with a hand-rolled `test()` helper and a trailing `process.exit()` — they are wired as `npm run test:contract:terminal-open-all-seating` and `npm run test:contract:terminal-sidebar-groupings` (`package.json:919-920`), not as mocha specs.
>
> **Superseded:** verification runs `npx mocha src/test/terminal-open-all-seating-contract.test.js`.
> **Reason:** mocha is not the runner. The file defines its own `test()` (mocha provides `it`/`describe`) and ends in `process.exit()`, which would terminate the mocha process mid-run. There is no mocha dependency in this repo's test wiring; `npm test` is `vscode-test`.
> **Replaced with:** the named npm scripts above. Running them is outside this plan's verification steps per the dispatch directive; the source-inspection checks below cover the same assertions.

## Verification Plan

### Source inspection

1. `grep -n "for (const t of fleetList)" src/webview/terminals.js` — no hit inside `fillGrid`. The fleet-wide scan is gone.
2. In `fillGrid`: `if (need <= 0)` appears exactly once and is lexically inside `if (!newGroup) {`. The new-group branch contains no refusal.
3. In `fillGrid`: the unlocked count reads `paneAssignments[i] || paneModes[i] === 'kanban'` — the same predicate `fillEmptyPanes` inverts at `terminals.js:6527`.
4. `grep -n "source: 'manual'," src/webview/terminals.js` — exactly two hits: `createManualGroup` and the `loadLayoutSettings` legacy coercion. Neither `saveCurrentAsGroup` nor `saveSelectionAsGroup` nor `fillGrid` is among them.
5. `grep -n "addEventListener" src/webview/terminals.js` in the 859-935 range — the `change`/`input` listeners for `fill-grid-dest`, `fill-grid-role` and `fill-grid-name` are registered outside the `btn-fill-grid` click handler.
6. `grep -n "confirm(" src/webview/terminals.js` — no new hits.
7. `grep -n "Promise.all" src/webview/terminals.js` — no hit in `fillGrid` or `createTerminalsForRole`.
8. `node --check src/webview/terminals.js` clean.

### Manual (installed VSIX, Terminals panel)

9. **The reported repro.** With no planner terminals: FILL GRID → role `Planner`, layout `2x2`, destination `New group`, name `Planner 1` → four planners seated, a `Planner 1` tab appears in the group strip and is active. Repeat: FILL GRID → `Planner`, `2x2`, `New group`, name `Planner 2` → **succeeds**, creates `planner-5`…`planner-8`, a `Planner 2` tab appears and is active. Both tabs show a member count of 4. No toast refusal at any point.
10. **Isolation.** Click the `Planner 1` tab → exactly `planner-1`…`planner-4` seated. Click `Planner 2` → exactly `planner-5`…`planner-8`. Neither group's members leak into the other.
11. **Idempotency is preserved.** Locked to `Planner 2` (4 members, `2x2` rendered): FILL GRID → `Planner`, `2x2`, `Current grid` → toast reads `Planner 2 has no empty seats (4 of 4) — pick "New group" to build another.`, and **no** new terminal is created (sidebar count unchanged).
12. **Top-up into a locked group works, and persists.** Locked to `Planner 2`, close `planner-8` from its sidebar row. FILL GRID → `Planner`, `2x2`, `Current grid` → one terminal is created, the `Planner 2` tab stays active (lock NOT dropped), the count returns to 4, and the new terminal is still there after switching to `Planner 1` and back — that round-trip is what proves membership was persisted rather than merely seated.
13. **The locked fill records its layout.** Locked to `Planner 2` (`2x2`), FILL GRID → `Planner`, `3x3`, `Current grid`. Click `Planner 1`, then `Planner 2` again → the grid returns as `3x3`, not `2x2`.
14. **Kanban pane is not a free seat.** In free composition on `2x2`, put one pane into kanban mode and seat one planner. FILL GRID → `Planner`, `2x2`, `Current grid` → exactly **two** planners are created (not three) and both are seated. No "could not be seated" toast, and the kanban pane still shows its board column.
15. **Foreign-role pane is not a free seat.** `2x2` holding two coders and one planner. FILL GRID → `Planner`, `2x2`, `Current grid` → exactly one planner is created. The coders are untouched.
16. **Free-composition top-up.** Click `All`, pick layout `1` (one pane, showing a planner). FILL GRID → `Planner`, `2x2`, `Current grid` → three more planners created and seated, no group created, lock stays off.
17. **Derived group coexists.** With eight planners live, the strip shows a derived `Planners` tab (8) alongside `Planner 1` (4) and `Planner 2` (4). Clicking `Planners` seats all eight across pages. This is expected — do not treat it as leakage.
18. **Persistence and cross-window merge.** Reload the terminals panel → both manual groups, their names, their members, and their stored layouts survive. Open a second terminals window → the same two tabs appear (via the `terminalsGroupsChanged` union merge in `reloadTerminalGroups`), which is also the check that `createManualGroup` wrote a `LAYOUT_MODES`-valid layout.
19. **Name defaulting.** Open the fill form with destination `New group` on a fresh workspace → name pre-fills `Planner 1`; after `Planner 1` exists → pre-fills `Planner 2`. Change the role dropdown without typing → the name re-seeds for the new role. Type a name, then change the role → the typed name is kept. Clear the field and submit → a group is still created, named `Group N`, never blank.
20. **Form state resets.** Open the form, switch destination to `Current grid`, CANCEL, reopen → destination is back to `New group` and the name field is re-seeded. Repeat the open/close cycle five times and change the destination each time → the name updates exactly once per change (no stacked listeners).
21. **Layout floor / paging.** Narrow the window until the floor forces a smaller grid, then FILL GRID → `Planner`, `3x3`, `New group` → nine terminals are created, the visible ones are seated, and the toast reads `N of 9 on page 1 — the rest are on the next page.` Paging forward shows the remainder.

## Recommendation

Complexity 5 → **Send to Coder.**
