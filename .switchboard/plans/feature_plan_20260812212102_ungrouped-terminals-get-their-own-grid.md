# Clicking an ungrouped terminal silently conscripts it into the locked group — give ungrouped terminals their own grid

## Goal

In the Terminals panel, selecting a terminal that belongs to no group must open a grid of **ungrouped terminals** at the current grid size. It must not drop that terminal into a spare pane of whatever group happens to be locked, and it must never silently rewrite that terminal's membership. Ungrouped terminals should behave as their own group, not as an import into someone else's.

### Problem analysis

`handleLockedTerminalClick(name)` (`src/webview/terminals.js:2658`) runs for every sidebar row click while a group is locked. Its first branch (`src/webview/terminals.js:2700-2708`):

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

`addTerminalToActiveGroup()` (`src/webview/terminals.js:2643`) is a **write**: for a manual group it pushes onto `group.members` and `group.order`; for a derived group it pushes onto `groupPrefs.extras[activeGroupId]`. Both are then persisted by `saveLayoutSettings()`. So a single click on an ungrouped terminal permanently makes it a member of the locked group, and `assignToFocusedPane` drops it into whichever pane happened to be free — which reads exactly as "randomly inserted into the team view".

If there is *no* free slot, control falls to (`src/webview/terminals.js:2712-2721`):

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

There is no representation of "ungrouped" in the group model. `getAllGroups()` (`src/webview/terminals.js:2504`) returns only `terminalGroups` + `getDerivedGroups()`, and `findGroupForTerminalName()` (`src/webview/terminals.js:2622`) returns `null` for anything they do not claim. The code comments record that an `Unassigned` pseudo-group **used to exist and was deleted**, because it was wired into `getAllGroups()` but *not* into `findGroupForTerminalName()`:

> "The Unassigned pseudo-group is retired — it was a computed remainder with no identity to delete, and leaving it in getAllGroups while removing it from findGroupForTerminalName produced a dead click for every ungrouped terminal under a lock."

The removal took away the tab and the grid but left `null` flowing into a code path whose only two options are *capture it* or *tear down the lock*. The fix is to reinstate the pseudo-group **consistently across all five seams that touch it** — membership computation, group enumeration, terminal→group resolution, the click router, **and the free-slot fill branch** — and to make the write paths inert for it.

### Decisions

- **Reserved id `__unassigned__`, source `'unassigned'`.** Manual ids are `grp_*` (`src/webview/terminals.js:2372`) and derived ids are `dg_*` (`safeGroupIdForValue`, `src/webview/terminals.js:2463`), so there is no collision.
- **The pseudo-group materialises only when at least one live terminal is unclaimed.** Zero unclaimed terminals ⇒ no tab, no id in `getAllGroups()`.
- **It is computed, never stored.** `addTerminalToActiveGroup()` and `setGroupOrder()` must no-op for it, and `deleteGroup()` must be inert — a computed remainder has nothing to delete and must not be pushed into `groupPrefs.hidden`.
- **Membership is computed once per call, not recursively.** The retired version recursed through every group from inside `getGroupMembers()`; the new branch builds the claimed-name union from `terminalGroups` + `getDerivedGroups()` directly and subtracts.
- **The tab renders without a `×`.** Every other tab gets a delete affordance; this one gets none, because there is no record to remove.
- **It sorts to the tail** and is never pinnable.
- **It never appears as a membership chip.** The chip's job is "this row belongs to a team you did not select"; "belongs to no team" is not that, and the sidebar is 220px wide. See the cross-subtask contract below.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## Feature context — this is subtask 5 of 5

Feature: **Terminals Panel Sidebar & Group Selection UX**. Lands **last**. It is the only subtask that changes the *group model* rather than the sidebar's rendering, and the three sidebar plans all read that model through generic accessors — so landing it last means those plans are written against a stable model and this plan is written against a stable sidebar.

**Reconciled contracts with the siblings:**

1. **The group chip line is jointly owned with the "filter the agent tree to the locked group" plan.** Once `findGroupForTerminalName()` returns the pseudo-group instead of `null`, every ungrouped row would grow an `Unassigned` chip in unlocked mode — re-spending the 220px the badge-removal plan just freed. The single reconciled end-state for `src/webview/terminals.js:2083` is below in Proposed Changes §11; it is written **verbatim** in the group-filter plan too. Implement it once, in whichever of the two lands second. Do not write two different guards.
2. **The sidebar group filter works on this pseudo-group with no extra branch.** It resolves the lock via `getAllGroups().find(g => g.id === activeGroupId)` and the member set via `getGroupMembers()` — both of which this plan teaches about `__unassigned__`. Locking `Unassigned` therefore filters the sidebar to the ungrouped terminals for free, which is the behaviour the two plans jointly want.
3. **The toolbar pager works on this pseudo-group with no extra branch,** and the `clearGroupLock()` fallback added in §10 re-enters `applyLayoutFloor()` exactly once (it nulls `activeGroupId` before calling back). That interaction is documented in the pager plan; nothing is required here beyond not making the fallback recursive.

## Complexity Audit (Routine vs Complex/Risky)

**Routine**

- Adding an `'unassigned'` branch to `getGroupMembers()`.
- Appending the pseudo-group to `getAllGroups()`'s return.
- Suppressing the `×` for one tab id in `renderGroupTabStrip()`.

**Complex / Risky**

- **Five seams must agree or the dead-click bug returns.** `getAllGroups()`, `getGroupMembers()`, `findGroupForTerminalName()`, `handleLockedTerminalClick()`'s pseudo-group guard, **and `handleLockedTerminalClick()`'s free-slot fill branch** all have to know about the id. The historical failure was fixing three of four. The free-slot branch is the seam the original write of this plan missed — see the next bullet. This is the single highest-risk aspect of the change.
- **The free-slot fill branch conscripts *into* `Unassigned`, in reverse.** With `activeGroupId === '__unassigned__'` and a free pane, clicking a terminal that *is* claimed by a real group takes `hasFreeSlot && !isMemberOfActive` → `addTerminalToActiveGroup()` (a no-op after §7) → `assignToFocusedPane(name, { keepLock: true })` seats it. The next `seatActiveGroupPage()` reconcile recomputes the complement, finds the terminal is claimed, and **evicts it from the pane with no feedback**. Making the write inert is not sufficient; the *branch* must be skipped when the lock is the pseudo-group, because a computed remainder can never adopt.
- **Recursion / cost.** `findGroupForTerminalName()` already calls `getGroupMembers()` for every group, and it is called **per row** from `renderTerminalRow()` (`src/webview/terminals.js:2083`). If the `'unassigned'` branch of `getGroupMembers()` called `findGroupForTerminalName()` or `getAllGroups()`, it would recurse infinitely. It must compute the claimed union inline from `terminalGroups` and `getDerivedGroups()` only.
- **Persistence of a transient id.** `terminals.activeGroupId` is saved (`src/webview/terminals.js:1511`). `__unassigned__` can be saved and then fail to resolve on next boot (every terminal now grouped, or a zero fleet). The restore path at `src/webview/terminals.js:1570-1573` calls `switchToGroup(activeGroupId, { noSave: true })`, which **early-returns when the group is not found and leaves `activeGroupId` set** (`src/webview/terminals.js:2414`) — an unresolvable lock with no active tab. The restore must null it when it does not resolve, **without dropping the existing `restoredLockOnLoad = true` one-shot latch** — losing that latch re-runs the restore on every 5s poll and stamps the operator's composition back to the saved group forever.
- **`getStoredGroupLayout()` / `groupPrefs.layouts`** are keyed by group id and will happily store a layout for `__unassigned__`. That is desirable (the operator's preferred size for the ungrouped grid persists) and needs no special casing — but `groupPrefs.orders['__unassigned__']`, written by `promoteGroupMember()` → `setGroupOrder()` (`src/webview/terminals.js:2743-2750`), would pin an ordering for a computed set, so `setGroupOrder()` must skip it.
- **`getGroupMembers()`'s `manual` branch does not exclude delegate children** (the parentage clause was deliberately removed — see the comment at `src/webview/terminals.js:2526-2534`), so `getClaimedTerminalNames()` can legitimately contain a child's name. That is harmless here because the unassigned complement independently filters `!t.parentInstanceId`, so a child is excluded whether or not a team claims it. Do not "simplify" by dropping either filter.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| Every live terminal is claimed by some group | No `Unassigned` tab. `findGroupForTerminalName()` never returns the pseudo-group. |
| Click an ungrouped terminal while **All** is active (no lock) | Unchanged — `handleLockedTerminalClick` is not the router in free-composition mode. |
| Click an ungrouped terminal while a group is locked, free pane available | Switch to the `Unassigned` grid. Do **not** seat into the free pane, do **not** write membership. |
| Click an ungrouped terminal while a group is locked, no free pane | Same — switch to the `Unassigned` grid. Both branches now converge on one outcome. |
| Click a terminal belonging to a *real* group while a **real** group is locked | Unchanged: free slot ⇒ adopt into the active group; no free slot ⇒ switch to its group. |
| Click a terminal belonging to a *real* group while **`Unassigned`** is locked | Switch to that terminal's group. The free-slot adopt branch must be **skipped**: `Unassigned` is computed and cannot adopt, so adopting would seat the terminal and then silently evict it on the next reconcile. |
| `Unassigned` is locked and the operator groups one of its members | Next render recomputes membership; the terminal leaves the grid. If the set empties, the tab disappears and the lock must fall back to **All** rather than stranding on a dead id. |
| `Unassigned` locked, more members than panes | Paging works unchanged — it is keyed on `getGroupMembers()` length, which the new branch supplies. |
| Delegate children (`parentInstanceId` set) | Excluded from the `Unassigned` complement by its own `!t.parentInstanceId` filter — **not** by the claimed-union, whose `manual` inputs deliberately include children. Both filters are load-bearing. |
| Exited terminals | Excluded — the `status !== 'exited'` filter applies to the complement directly. |
| `deleteGroup('__unassigned__')` called by any path | Inert. Must not append to `groupPrefs.hidden`, must not clear the lock. |
| Reload with `terminals.activeGroupId === '__unassigned__'` and terminals still ungrouped | Lock restores to the `Unassigned` grid, and `restoredLockOnLoad` is still latched so it happens exactly once. |
| Reload with `terminals.activeGroupId === '__unassigned__'` and nothing ungrouped | `activeGroupId` nulls out; the panel boots in free composition. `restoredLockOnLoad` is still latched. |
| `groupPrefs.threshold` raised so a derived group dissolves | Its terminals become unclaimed and appear in `Unassigned` on the next render. |
| An older extension build reads a `groupPrefs` containing `layouts['__unassigned__']` | Inert. `getStoredGroupLayout` is looked up by a group id that never resolves there, and unknown keys are preserved rather than pruned. No migration needed. |
| `Unassigned` overflows the tab strip | Renders in the `»` menu with its count and no delete affordance — the overflow items carry no `×` for any group (`src/webview/terminals.js:2909-2925`), so nothing extra is required. |

**Dependencies:** confined to `src/webview/terminals.js` and one CSS hook in `src/webview/terminals.html`. No verbs, no backend, no schema. `terminals.groupPrefs` gains no new *keys* — only new id-valued entries inside the existing `layouts` map, which is additive and downgrade-safe.

## Proposed Changes

### `src/webview/terminals.js`

**1. Reserved id, beside the other group constants (`~92`).**

```js
    // The ungrouped remainder, modelled as a first-class group so a click on an
    // ungrouped terminal opens ITS OWN grid instead of being conscripted into
    // whichever group is locked. Computed, never stored: no members array, no
    // delete affordance, no extras overlay. Ids elsewhere are `grp_*` (manual)
    // and `dg_*` (derived), so this cannot collide.
    const UNASSIGNED_GROUP_ID = '__unassigned__';
    const UNASSIGNED_GROUP = { id: UNASSIGNED_GROUP_ID, name: 'Unassigned', source: 'unassigned' };
```

**2. Claimed-name union + pseudo-group constructor (beside `getDerivedGroups`, `~2500`).**

```js
    /** Names claimed by a REAL group (manual or derived). Computed inline from
     *  terminalGroups + getDerivedGroups() — never via getAllGroups() or
     *  findGroupForTerminalName(), both of which call back into
     *  getGroupMembers() and would recurse. May legitimately contain delegate
     *  children: the manual branch of getGroupMembers includes them by design.
     *  The complement below filters children independently, so that is fine. */
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

**3. `getAllGroups()` — append at the tail, after sorting, so it is never pinned into the middle (`~2504`).** Replaces the retired-pseudo-group comment currently there.

```js
    function getAllGroups() {
        const real = sortGroups([...terminalGroups, ...getDerivedGroups()]);
        const unassigned = getUnassignedGroup();
        return unassigned ? [...real, unassigned] : real;
    }
```

**4. `getGroupMembers()` — new branch after the `worktree` branch (`~2544`).**

```js
        } else if (group.source === 'unassigned') {
            const claimed = getClaimedTerminalNames();
            names = fleetList
                .filter(t => t.status !== 'exited' && !t.parentInstanceId && !claimed.has(t.friendlyName))
                .map(t => t.friendlyName);
        }
```

The extras overlay below it is already gated on `group.source !== 'manual'` (`src/webview/terminals.js:2554`) — tighten that gate so a stale `groupPrefs.extras['__unassigned__']` from a hand-edited setting can never union a claimed terminal back in:

```js
        if (group.source !== 'manual' && group.source !== 'unassigned' && groupPrefs.extras) {
```

Also delete the now-false "the 'unassigned' source branch is gone" comment at `src/webview/terminals.js:2563-2565`.

**5. `findGroupForTerminalName()` — return the pseudo-group instead of `null` (`~2622`).** This is the seam whose omission killed the previous attempt.

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

**6. `handleLockedTerminalClick()` — never conscript an ungrouped terminal (`~2670`).** Insert the guard *before* the free-slot fill branch:

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

**7. The free-slot fill branch must not fire under an `Unassigned` lock (`~2700`).** This is the fifth seam.

```js
        if (hasFreeSlot) {
            const isMemberOfActive = group && group.id === activeGroupId;
            // The Unassigned lock can never adopt: its membership is a computed
            // complement, so addTerminalToActiveGroup is inert and the seat would
            // survive only until the next seatActiveGroupPage reconcile evicted
            // it — a click that appears to work and then silently undoes itself.
            // Fall through to the group-switch branch instead.
            if (!isMemberOfActive && activeGroupId !== UNASSIGNED_GROUP_ID) {
                // Add to the active group first, then seat with keepLock.
                addTerminalToActiveGroup(name);
                assignToFocusedPane(name, { keepLock: true });
                return;
            }
        }
```

The `if (!group)` branch below it stays as the guard for a name that resolves to nothing live at all (raced deletion) — it is no longer the ordinary path for ungrouped terminals. Update its now-stale comment, which currently asserts the pseudo-group was retired.

**8. Make the write paths inert for the pseudo-group.**

`addTerminalToActiveGroup()` (`~2643`):

```js
    function addTerminalToActiveGroup(name) {
        // The Unassigned group is a computed remainder: writing membership for
        // it would make a claimed terminal appear as unclaimed.
        if (activeGroupId === UNASSIGNED_GROUP_ID) { return; }
        const group = getAllGroups().find(g => g.id === activeGroupId);
        ...
    }
```

`setGroupOrder()` (`~2584`):

```js
    function setGroupOrder(group, order) {
        if (!group || group.source === 'unassigned') { return; }
        ...
    }
```

`deleteGroup()` (`~2271`) — the guard must be the **first** statement, before the `getAllGroups().find()`, or the pseudo-group falls through to the derived branch and is pushed into `groupPrefs.hidden`:

```js
    function deleteGroup(id) {
        if (id === UNASSIGNED_GROUP_ID) { return; }
        ...
    }
```

**9. `renderGroupTabStrip()` — no `×` on the Unassigned tab (`~2814`).**

```js
            // Every group tab carries a delete affordance EXCEPT the computed
            // Unassigned remainder, which has no record to remove.
            if (g.source !== 'unassigned') {
                const delBtn = document.createElement('button');
                ... unchanged ...
                tab.appendChild(delBtn);
            }
```

Add the class hook while building the tab (`~2799`) so the CSS below can address it:

```js
            tab.className = 'group-tab' + (isActive ? ' active' : '')
                + (g.source === 'unassigned' ? ' is-unassigned' : '');
            tab.title = g.source === 'unassigned'
                ? 'Terminals not in any group'
                : g.name;
```

**10. Clamp a stale saved lock on boot (`~1570`).** `switchToGroup()` early-returns on an unresolvable id and leaves `activeGroupId` set. **Keep the `restoredLockOnLoad = true` latch on every path** — dropping it re-runs the restore on every 5s poll.

```js
                    if (!restoredLockOnLoad && activeGroupId) {
                        restoredLockOnLoad = true;
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

**11. Drop a lock that empties.** In `seatActiveGroupPage()` (`~2440`), the lookup already returns `undefined` when the pseudo-group dissolves; make that fall back rather than silently no-op:

```js
        const group = activeGroupId ? getAllGroups().find(g => g.id === activeGroupId) : null;
        if (!group) {
            // The locked group no longer exists — most reachably, Unassigned
            // emptied because its last member was grouped. Fall back to free
            // composition instead of leaving stale seats behind.
            //
            // clearGroupLock() calls applyLayoutFloor() at its tail, and
            // applyLayoutFloor's `changed` branch calls back into this function
            // — but it nulls activeGroupId FIRST, so the re-entry takes the
            // `activeGroupId ? ... : null` false arm and terminates one level
            // deep. Do not add a re-entrancy flag; do not make this recursive.
            if (activeGroupId) { clearGroupLock(); }
            return;
        }
```

**12. The chip must not name the pseudo-group** (`renderTerminalRow`, `~2083`). **Shared end-state with the "filter the agent tree to the locked group" subtask — identical text in both plans; write it once.**

```js
        // Two suppressions, one line:
        //  - Under a group lock every visible row is a member, so the chip
        //    carries no information — and the sidebar is 220px wide.
        //  - The Unassigned pseudo-group is the computed remainder, not a
        //    membership. Chipping it would label most of the fleet with a word
        //    that means "no group", spending the width the count badge just
        //    gave back.
        const resolvedGroup = activeGroupId ? null : findGroupForTerminalName(item.friendlyName);
        const claimingGroup = (resolvedGroup && resolvedGroup.source !== 'unassigned')
            ? resolvedGroup
            : null;
        if (claimingGroup) {
            ...unchanged chip construction...
        }
```

### `src/webview/terminals.html`

Mark the Unassigned tab as the computed remainder — dashed border, no accent fill, so it does not read as a saved group (`~749`, beside `.group-tab.active`):

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

> Testing is done against an **installed VSIX**, not the repo's `dist/`. No compilation or automated-test step is part of this plan.

1. **Install + open:** install the current VSIX and open the Terminals panel in a browser window.
2. **Tab appears:** spawn 4 terminals of one role (so a derived group forms) plus 2 of a role below the threshold. Confirm an italic, dashed `Unassigned 2` tab appears at the tail of the strip, with **no** `×`.
3. **The reported defect — free pane:** lock the derived group at a grid size with at least one empty pane. Click one of the two ungrouped terminals in the sidebar. Confirm the panel switches to the `Unassigned` grid showing **both** ungrouped terminals — not a single terminal dropped into a spare pane of the derived group.
4. **No silent membership write:** click back to the derived group's tab. Confirm its count is unchanged and the ungrouped terminal is **not** listed in it. Reload the panel and confirm the count is still unchanged (i.e. nothing was persisted to `groupPrefs.extras`).
5. **The other branch — no free pane:** set the grid size so the locked group exactly fills every pane. Click an ungrouped terminal. Confirm the same outcome as step 3 (previously this dropped the lock entirely).
6. **The reverse conscription (fifth seam):** lock `Unassigned` at a grid size with at least one empty pane, then click a terminal that belongs to the derived group. Confirm the panel **switches to the derived group** — it must not seat that terminal into the free `Unassigned` pane. Then wait through two fleet polls (10s) and confirm nothing was seated and then silently removed.
7. **Grid size respected:** with `Unassigned` locked, switch grid sizes. Confirm the ungrouped terminals re-seat at the chosen size and that the size persists across a switch away and back.
8. **Paging:** create 5 ungrouped terminals, lock `Unassigned`, choose a 4-pane size. Confirm paging works across the ungrouped set.
9. **Dissolve:** with `Unassigned` locked, select its members and save them as a manual group. Confirm the `Unassigned` tab disappears and the panel falls back to free composition rather than showing an active tab that no longer exists — and that no stack overflow or hang occurs (the `clearGroupLock` ↔ `applyLayoutFloor` re-entry).
10. **No tab when fully grouped:** group every live terminal. Confirm no `Unassigned` tab renders anywhere, including the `»` overflow menu.
11. **Delete is inert:** with `Unassigned` present, confirm no `×` renders on it and that `groupPrefs.hidden` never gains `__unassigned__` (inspect via the persisted `terminals.groupPrefs` setting).
12. **Reload clamp:** lock `Unassigned`, then reload the panel with every terminal still ungrouped — the lock restores. Then group them all and reload again — confirm the panel boots into free composition with the **All** tab active, not into a dead lock.
13. **Latch not lost:** after the reload in step 12, click **All** to drop the lock, then leave the panel idle for 30s (≥6 fleet polls). Confirm the lock does **not** re-apply itself — this is the `restoredLockOnLoad` one-shot regression check.
14. **No Unassigned chips:** with no lock active and several ungrouped terminals, confirm **no** row shows an `Unassigned` chip. Rows in real groups still show their chip.
15. **Delegate children:** with a manual team (head + children) and some ungrouped terminals, confirm the children appear as members of the team and **never** in the `Unassigned` set.
16. **Performance:** with 9 terminals and 3 groups, confirm the 5s fleet poll shows no visible render stall and no runaway CPU (the claimed-union computation runs once per `getGroupMembers('unassigned')` call, not per row).
