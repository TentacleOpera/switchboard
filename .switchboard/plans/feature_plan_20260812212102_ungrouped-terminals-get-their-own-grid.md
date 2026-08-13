# Clicking an ungrouped terminal silently conscripts it into the locked group — give ungrouped terminals their own grid

## Goal

In the Terminals panel, selecting a terminal that belongs to no group must open a grid of **ungrouped terminals** at the current grid size. It must not drop that terminal into a spare pane of whatever group happens to be locked, and it must never silently rewrite that terminal's membership. Ungrouped terminals should behave as their own group, not as an import into someone else's.

### Problem analysis

`handleLockedTerminalClick(name)` (`src/webview/terminals.js:2585`) runs for every sidebar row click while a group is locked. Its first branch:

```js
if (hasFreeSlot) {
    const isMemberOfActive = group && group.id === activeGroupId;
    if (!isMemberOfActive) {
        // Add to the active group first, then seat with keepLock.
        addTerminalToActiveGroup(name);
        assignToFocusedPane(name, { keepLock: true });
        return;
    }
}
```

`addTerminalToActiveGroup()` (`src/webview/terminals.js:2555`) is a **write**: for a manual group it pushes onto `group.members` and `group.order`; for a derived group it pushes onto `groupPrefs.extras[activeGroupId]`. Both are then persisted by `saveLayoutSettings()`. So a single click on an ungrouped terminal permanently makes it a member of the locked group, and `assignToFocusedPane` drops it into whichever pane happened to be free — which reads exactly as "randomly inserted into the team view".

If there is *no* free slot, control falls to:

```js
if (!group) {
    activeGroupId = null;
    activeGroupPage = 0;
    saveLayoutSettings();
    locateTerminal(name);
    return;
}
```

— the lock is dropped entirely and the whole grid re-seats from the full fleet. So the same gesture produces two different, both-wrong outcomes depending on whether a pane happens to be empty.

### Root cause

There is no representation of "ungrouped" in the group model. `getAllGroups()` (`src/webview/terminals.js:2431`) returns only `terminalGroups` + `getDerivedGroups()`, and `findGroupForTerminalName()` (`src/webview/terminals.js:2541`) returns `null` for anything they do not claim. The code comments record that an `Unassigned` pseudo-group **used to exist and was deleted**, because it was wired into `getAllGroups()` but *not* into `findGroupForTerminalName()`:

> "The Unassigned pseudo-group is retired — it was a computed remainder with no identity to delete, and leaving it in getAllGroups while removing it from findGroupForTerminalName produced a dead click for every ungrouped terminal under a lock."

The removal took away the tab and the grid but left `null` flowing into a code path whose only two options are *capture it* or *tear down the lock*. The fix is to reinstate the pseudo-group **consistently across all four seams that touch it** — membership computation, group enumeration, terminal→group resolution, and the click router — and to make the write paths inert for it.

### Decisions

- **Reserved id `__unassigned__`, source `'unassigned'`.** Manual ids are `grp_*` and derived ids are `dg_*` (`safeGroupIdForValue`, `src/webview/terminals.js:2405`), so there is no collision.
- **The pseudo-group materialises only when at least one live terminal is unclaimed.** Zero unclaimed terminals ⇒ no tab, no id in `getAllGroups()`.
- **It is computed, never stored.** `addTerminalToActiveGroup()` and `setGroupOrder()` must no-op for it, and `deleteGroup()` must be inert — a computed remainder has nothing to delete and must not be pushed into `groupPrefs.hidden`.
- **Membership is computed once per call, not recursively.** The retired version recursed through every group from inside `getGroupMembers()`; the new branch builds the claimed-name union from `terminalGroups` + `getDerivedGroups()` directly and subtracts.
- **The tab renders without a `×`.** Every other tab gets a delete affordance; this one gets none, because there is no record to remove.
- **It sorts to the tail** and is never pinnable.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine**

- Adding an `'unassigned'` branch to `getGroupMembers()`.
- Appending the pseudo-group to `getAllGroups()`'s return.
- Suppressing the `×` for one tab id in `renderGroupTabStrip()`.

**Complex / Risky**

- **Four seams must agree or the dead-click bug returns.** `getAllGroups()`, `getGroupMembers()`, `findGroupForTerminalName()`, and `handleLockedTerminalClick()` all have to know about the id. The historical failure was fixing three of four. This is the single highest-risk aspect of the change.
- **Recursion / cost.** `findGroupForTerminalName()` already calls `getGroupMembers()` for every group. If the `'unassigned'` branch of `getGroupMembers()` called `findGroupForTerminalName()` or `getAllGroups()`, it would recurse infinitely. It must compute the claimed union inline from `terminalGroups` and `getDerivedGroups()` only.
- **Persistence of a transient id.** `terminals.activeGroupId` is saved (`src/webview/terminals.js:1480`). `__unassigned__` can be saved and then fail to resolve on next boot (every terminal now grouped, or a zero fleet). The restore path at `src/webview/terminals.js:1504` calls `switchToGroup(activeGroupId, { noSave: true })`, which **early-returns when the group is not found and leaves `activeGroupId` set** — an unresolvable lock with no active tab. The restore must null it when it does not resolve.
- **`getStoredGroupLayout()` / `groupPrefs.layouts`** are keyed by group id and will happily store a layout for `__unassigned__`. That is desirable (the operator's preferred size for the ungrouped grid persists) and needs no special casing — but `groupPrefs.orders['__unassigned__']` written by `promoteGroupMember()` would pin an ordering for a computed set, so `setGroupOrder()` must skip it.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| Every live terminal is claimed by some group | No `Unassigned` tab. `findGroupForTerminalName()` never returns the pseudo-group. |
| Click an ungrouped terminal while **All** is active (no lock) | Unchanged — `handleLockedTerminalClick` is not the router in free-composition mode. |
| Click an ungrouped terminal while a group is locked, free pane available | Switch to the `Unassigned` grid. Do **not** seat into the free pane, do **not** write membership. |
| Click an ungrouped terminal while a group is locked, no free pane | Same — switch to the `Unassigned` grid. Both branches now converge on one outcome. |
| Click a terminal belonging to *another* real group under a lock | Unchanged: free slot ⇒ adopt into the active group; no free slot ⇒ switch to its group. |
| `Unassigned` is locked and the operator groups one of its members | Next render recomputes membership; the terminal leaves the grid. If the set empties, the tab disappears and the lock must fall back to **All** rather than stranding on a dead id. |
| `Unassigned` locked, more members than panes | Paging works unchanged — it is keyed on `getGroupMembers()` length, which the new branch supplies. |
| Delegate children (`parentInstanceId` set) | Excluded, matching every other membership computation. |
| Exited terminals | Excluded — `live` filter already applies. |
| `deleteGroup('__unassigned__')` called by any path | Inert. Must not append to `groupPrefs.hidden`, must not clear the lock. |
| Reload with `terminals.activeGroupId === '__unassigned__'` and terminals still ungrouped | Lock restores to the `Unassigned` grid. |
| Reload with `terminals.activeGroupId === '__unassigned__'` and nothing ungrouped | `activeGroupId` nulls out; the panel boots in free composition. |
| `groupPrefs.threshold` raised so a derived group dissolves | Its terminals become unclaimed and appear in `Unassigned` on the next render. |

**Dependencies:** confined to `src/webview/terminals.js` and one CSS hook in `src/webview/terminals.html`. No verbs, no backend, no schema. `terminals.groupPrefs` gains no new keys.

## Proposed Changes

### `src/webview/terminals.js`

**1. Reserved id, beside the other group constants (~line 92).**

```js
    // The ungrouped remainder, modelled as a first-class group so a click on an
    // ungrouped terminal opens ITS OWN grid instead of being conscripted into
    // whichever group is locked. Computed, never stored: no members array, no
    // delete affordance, no extras overlay. Ids elsewhere are `grp_*` (manual)
    // and `dg_*` (derived), so this cannot collide.
    const UNASSIGNED_GROUP_ID = '__unassigned__';
    const UNASSIGNED_GROUP = { id: UNASSIGNED_GROUP_ID, name: 'Unassigned', source: 'unassigned' };
```

**2. Claimed-name union + pseudo-group constructor (beside `getDerivedGroups`, ~line 2429).**

```js
    /** Names claimed by a REAL group (manual or derived). Computed inline from
     *  terminalGroups + getDerivedGroups() — never via getAllGroups() or
     *  findGroupForTerminalName(), both of which call back into
     *  getGroupMembers() and would recurse. */
    function getClaimedTerminalNames() {
        const claimed = new Set();
        for (const g of terminalGroups) {
            for (const n of getGroupMembers(g)) { claimed.add(n); }
        }
        for (const g of getDerivedGroups()) {
            for (const n of getGroupMembers(g)) { claimed.add(n); }
        }
        return claimed;
    }

    /** The Unassigned pseudo-group, or null when every live terminal is claimed. */
    function getUnassignedGroup() {
        const claimed = getClaimedTerminalNames();
        const anyFree = fleetList.some(t =>
            t.status !== 'exited' && !t.parentInstanceId && !claimed.has(t.friendlyName));
        return anyFree ? UNASSIGNED_GROUP : null;
    }
```

**3. `getAllGroups()` — append at the tail, after sorting, so it is never pinned into the middle (~line 2431).**

```js
    function getAllGroups() {
        const real = sortGroups([...terminalGroups, ...getDerivedGroups()]);
        const unassigned = getUnassignedGroup();
        return unassigned ? [...real, unassigned] : real;
    }
```

**4. `getGroupMembers()` — new branch before the extras overlay (~line 2451).**

```js
        } else if (group.source === 'unassigned') {
            const claimed = getClaimedTerminalNames();
            names = fleetList
                .filter(t => t.status !== 'exited' && !t.parentInstanceId && !claimed.has(t.friendlyName))
                .map(t => t.friendlyName);
        }
```

The extras overlay below it is already gated on `group.source !== 'manual'` — tighten that gate so a stale `groupPrefs.extras['__unassigned__']` from a hand-edited setting can never union a claimed terminal back in:

```js
        if (group.source !== 'manual' && group.source !== 'unassigned' && groupPrefs.extras) {
```

**5. `findGroupForTerminalName()` — return the pseudo-group instead of `null` (~line 2541).** This is the seam whose omission killed the previous attempt.

```js
    function findGroupForTerminalName(name) {
        for (const g of terminalGroups) {
            if (getGroupMembers(g).includes(name)) { return g; }
        }
        for (const g of getDerivedGroups()) {
            if (getGroupMembers(g).includes(name)) { return g; }
        }
        // Unclaimed terminals resolve to the Unassigned pseudo-group — NOT null.
        // Returning null here is what left handleLockedTerminalClick with only
        // two bad options: capture the terminal, or tear the lock down.
        const live = fleetList.some(t =>
            t.friendlyName === name && t.status !== 'exited' && !t.parentInstanceId);
        return live ? UNASSIGNED_GROUP : null;
    }
```

**6. `handleLockedTerminalClick()` — never conscript an ungrouped terminal (~line 2585).** Insert the guard *before* the free-slot fill branch:

```js
        const group = findGroupForTerminalName(name);
        const rendered = Math.max(1, getSlotCount(effectiveLayout));

        // Ungrouped terminals are their own group. Opening one switches to the
        // Unassigned grid at the current size; it must NOT be seated into a
        // spare pane of the locked group, because that path writes membership
        // (addTerminalToActiveGroup) and permanently conscripts it.
        if (group && group.source === 'unassigned' && activeGroupId !== UNASSIGNED_GROUP_ID) {
            switchToGroup(UNASSIGNED_GROUP_ID);
            activeTerminalName = name;
            const seatIdx = paneAssignments.indexOf(name);
            if (seatIdx !== -1 && seatIdx < getSlotCount(effectiveLayout)) { focusPaneTerminal(seatIdx); }
            renderSidebarList();
            return;
        }
```

The `if (!group)` branch below it stays as the guard for a name that resolves to nothing live at all (raced deletion) — it is no longer the ordinary path for ungrouped terminals.

**7. Make the write paths inert for the pseudo-group.**

`addTerminalToActiveGroup()` (~line 2555):

```js
    function addTerminalToActiveGroup(name) {
        // The Unassigned group is a computed remainder: writing membership for
        // it would make a claimed terminal appear as unclaimed.
        if (activeGroupId === UNASSIGNED_GROUP_ID) { return; }
        const group = getAllGroups().find(g => g.id === activeGroupId);
        ...
    }
```

`setGroupOrder()` (~line 2503):

```js
    function setGroupOrder(group, order) {
        if (!group || group.source === 'unassigned') { return; }
        ...
    }
```

`deleteGroup()` (~line 2197):

```js
    function deleteGroup(id) {
        if (id === UNASSIGNED_GROUP_ID) { return; }
        ...
    }
```

**8. `renderGroupTabStrip()` — no `×` on the Unassigned tab (~line 2738).**

```js
            // Every group tab carries a delete affordance EXCEPT the computed
            // Unassigned remainder, which has no record to remove.
            if (g.source !== 'unassigned') {
                const delBtn = document.createElement('button');
                ... unchanged ...
                tab.appendChild(delBtn);
            }
```

Add the class hook while building the tab so the CSS below can address it:

```js
            tab.className = 'group-tab' + (isActive ? ' active' : '')
                + (g.source === 'unassigned' ? ' is-unassigned' : '');
            tab.title = g.source === 'unassigned'
                ? 'Terminals not in any group'
                : g.name;
```

**9. Clamp a stale saved lock on boot (~line 1504).** `switchToGroup()` early-returns on an unresolvable id and leaves `activeGroupId` set.

```js
                    if (!restoredLockOnLoad && activeGroupId) {
                        // A saved lock that no longer resolves (group deleted, or
                        // __unassigned__ with nothing left ungrouped) must clear,
                        // not persist as a lock with no tab.
                        if (!getAllGroups().some(g => g.id === activeGroupId)) {
                            activeGroupId = null;
                            activeGroupPage = 0;
                        } else {
                            switchToGroup(activeGroupId, { noSave: true });
                        }
                    }
```

**10. Drop a lock that empties.** In `seatActiveGroupPage()` (~line 2367), the lookup already returns `undefined` when the pseudo-group dissolves; make that fall back rather than silently no-op:

```js
        const group = activeGroupId ? getAllGroups().find(g => g.id === activeGroupId) : null;
        if (!group) {
            // The locked group no longer exists — most reachably, Unassigned
            // emptied because its last member was grouped. Fall back to free
            // composition instead of leaving stale seats behind.
            if (activeGroupId) { clearGroupLock(); }
            return;
        }
```

### `src/webview/terminals.html`

Mark the Unassigned tab as the computed remainder — dashed border, no accent fill, so it does not read as a saved group (~line 745, beside `.group-tab.active`):

```css
        /* The computed remainder, not a saved group: dashed edge, neutral text.
           It carries no delete affordance, so it must not look like the tabs
           that do. */
        .group-tab.is-unassigned {
            border-style: dashed;
            border-color: var(--border-bright);
            font-style: italic;
        }
        .group-tab.is-unassigned.active {
            border-style: solid;
        }
```

## Verification Plan

1. **Build + install:** `npm run compile`, package and install the VSIX, open the Terminals panel in a browser window.
2. **Tab appears:** spawn 4 terminals of one role (so a derived group forms) plus 2 of a role below the threshold. Confirm an italic, dashed `Unassigned 2` tab appears at the tail of the strip, with **no** `×`.
3. **The reported defect — free pane:** lock the derived group at a grid size with at least one empty pane. Click one of the two ungrouped terminals in the sidebar. Confirm the panel switches to the `Unassigned` grid showing **both** ungrouped terminals — not a single terminal dropped into a spare pane of the derived group.
4. **No silent membership write:** click back to the derived group's tab. Confirm its count is unchanged and the ungrouped terminal is **not** listed in it. Reload the panel and confirm the count is still unchanged (i.e. nothing was persisted to `groupPrefs.extras`).
5. **The other branch — no free pane:** set the grid size so the locked group exactly fills every pane. Click an ungrouped terminal. Confirm the same outcome as step 3 (previously this dropped the lock entirely).
6. **Grid size respected:** with `Unassigned` locked, switch grid sizes. Confirm the ungrouped terminals re-seat at the chosen size and that the size persists across a switch away and back.
7. **Paging:** create 5 ungrouped terminals, lock `Unassigned`, choose a 4-pane size. Confirm paging works across the ungrouped set.
8. **Dissolve:** with `Unassigned` locked, select its members and save them as a manual group. Confirm the `Unassigned` tab disappears and the panel falls back to free composition rather than showing an active tab that no longer exists.
9. **No tab when fully grouped:** group every live terminal. Confirm no `Unassigned` tab renders anywhere, including the `»` overflow menu.
10. **Delete is inert:** with `Unassigned` present, confirm no `×` renders on it and that `groupPrefs.hidden` never gains `__unassigned__` (inspect via the persisted `terminals.groupPrefs` setting).
11. **Reload clamp:** lock `Unassigned`, then reload the panel with every terminal still ungrouped — the lock restores. Then group them all and reload again — confirm the panel boots into free composition with the **All** tab active, not into a dead lock.
12. **Performance:** with 9 terminals and 3 groups, confirm the 5s fleet poll shows no visible render stall and no runaway CPU (the claimed-union computation runs once per `getGroupMembers('unassigned')` call, not per row).
