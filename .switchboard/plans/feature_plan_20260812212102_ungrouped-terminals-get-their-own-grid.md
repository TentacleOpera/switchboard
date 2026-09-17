# Clicking an ungrouped terminal silently conscripts it into the locked group

## Scope trimmed 2026-09-17 — read this first

This plan was authored 2026-08-12 against a codebase in which unassigned had no
representation at all, and it proposed building one: a first-class pseudo-group
with reserved id `__unassigned__`, taught to `getAllGroups()`,
`getGroupMembers()` and `findGroupForTerminalName()`, with its own tab, its own
delete-suppression, its own persistence clamp and its own chip guard.

**That model has been superseded twice over and is removed from this plan.**

1. *Rename group tab "All" to "Unassigned" and show only unassigned terminals*
   (COMPLETED, 2026-08-19) shipped the unassigned tab and
   `getUnassignedTerminalNames()` (`terminals.js:4495`) using the opposite model:
   unassigned is `activeGroupId === null` plus a computed complement, with no id.
2. *Unassigned Is Reachable From The Rail, And Entering It Seats Only Unassigned
   Terminals* (feature **Switching Between Teams And Unassigned Is a Selection,
   Not a Rebuild**) owns entry into that scope from the rail and from a team, and
   consolidates its seating.

The pseudo-group is not merely redundant now — it is **breaking**.
`getUnassignedTerminalNames()` derives the complement as
`fleetList.filter(...).filter(t => !findGroupForTerminalName(t.friendlyName))`.
Teaching `findGroupForTerminalName()` to return a pseudo-group for ungrouped
terminals inverts that filter to always-false, so the function returns an **empty
list**: the unassigned grid seats nothing and its tab count reads zero. The
original plan could not have known this — `getUnassignedTerminalNames()` was
added a week after it was written.

**Removed as superseded:** the reserved id and pseudo-group constructor; the
`getAllGroups()` / `getGroupMembers()` / `findGroupForTerminalName()` changes;
making the write paths inert; the `×`-suppression on the tab; the stale-lock boot
clamp and the empty-lock fallback (an id that is never stored cannot be restored
or dissolved); the `is-unassigned` tab CSS; and the chip guard shared with the
sidebar-filter subtask — with no pseudo-group, `findGroupForTerminalName()` keeps
returning `null` and no chip was ever at risk.

**What remains is the defect in the title**, which nothing else covers.

## Goal

Clicking a terminal that belongs to no group, while a group is locked, must not
write that terminal into the locked group's membership. It must show the
unassigned grid.

### The problem, and the root cause

`handleLockedTerminalClick(name)` (`src/webview/terminals.js`) runs for every
sidebar row click while a group is locked. Its first branch:

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

`addTerminalToActiveGroup()` is a **write**: for a manual group it pushes onto
`group.members` and `group.order`; for a derived group it pushes onto
`groupPrefs.extras[activeGroupId]`. Both are persisted by `saveLayoutSettings()`.
So one click on an ungrouped terminal permanently makes it a member of whatever
was locked, and `assignToFocusedPane` drops it into whichever pane happened to be
free — which reads exactly as "randomly inserted into the team view".

If there is *no* free slot, control falls through to:

```js
if (!group) {
    activeGroupId = null;
    activeGroupPage = 0;
    saveLayoutSettings();
    locateTerminal(name);
    return;
}
```

— the lock drops and the grid re-seats. So the same gesture produces two
different, both-wrong outcomes depending on whether a pane happens to be empty.

**Root cause:** the ungrouped case is handled *below* the free-slot branch, so
the free-slot branch claims it first. The `!group` handler also predates
`clearGroupLock`'s unassigned seating and re-implements a worse version of it.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

## Feature context

Subtask of **Terminals Panel Sidebar & Group Selection UX**. Previously
sequenced last because it changed the group model; with that scope removed it no
longer does, and it can land in any order relative to its siblings. It no longer
shares a chip-line end-state with the "filter the agent tree to the locked group"
subtask — that reconciliation was a consequence of the pseudo-group and is void.

## Proposed changes

### `src/webview/terminals.js`

**1. Hoist the ungrouped case above the free-slot branch, and route it through
`clearGroupLock()`.**

```js
        const group = findGroupForTerminalName(name);

        // An ungrouped terminal is never adopted by the lock. Show the
        // unassigned grid instead. This must sit ABOVE the free-slot branch:
        // that branch calls addTerminalToActiveGroup(), which is a persisted
        // membership write, so letting it claim an ungrouped terminal
        // permanently conscripts it into whatever happened to be locked.
        if (!group && activeGroupId) {
            clearGroupLock();          // the single unassigned seater
            activeTerminalName = name;
            const seatIdx = paneAssignments.indexOf(name);
            if (seatIdx !== -1 && seatIdx < getSlotCount(effectiveLayout)) {
                focusPaneTerminal(seatIdx);
            }
            renderSidebarList();
            return;
        }
```

`clearGroupLock()` already nulls `activeGroupId`, seats the unassigned
complement, sizes the grid with `smallestLayoutFitting`, saves and re-renders —
so the bespoke `activeGroupId = null` / `saveLayoutSettings()` / `locateTerminal`
sequence is not repeated here.

**2. Retire the now-unreachable `!group` fallback below.**

With the hoisted guard above it, the old `if (!group)` branch is reachable only
when `activeGroupId` is already null — in which case `handleLockedTerminalClick`
is not the router at all. Delete it rather than leaving a second, divergent
implementation of the same outcome. Its comment asserting that the pseudo-group
"was retired" describes a design decision that is now simply the shipped model;
it does not need restating.

**3. Do not introduce a lock id for unassigned.**

`clearGroupLock()` must keep meaning `activeGroupId = null`. Anything that adds
an id for the unassigned scope re-opens the
`getUnassignedTerminalNames()` inversion described at the top of this plan.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| Click an ungrouped terminal while a group is locked, **free pane available** | Unassigned grid. No membership write. (The reported defect.) |
| Click an ungrouped terminal while a group is locked, **no free pane** | Identical outcome — both branches now converge. |
| Click an ungrouped terminal with **no lock** | Unchanged; `handleLockedTerminalClick` is not the router in free composition. |
| Click a terminal in a **real** group while another real group is locked | Unchanged: free slot ⇒ adopt into the active group; no free slot ⇒ switch to its group. |
| Name resolves to nothing live at all (raced deletion) | `findGroupForTerminalName` returns `null` and the hoisted guard runs `clearGroupLock()`, which seats the live complement. Harmless. |
| Delegate children (`parentInstanceId` set) | Excluded from the unassigned set by `getUnassignedTerminalNames()`'s own `!t.parentInstanceId` filter. Unchanged by this plan. |

**Dependencies & conflicts**

- **Unassigned Is Reachable From The Rail** (feature *Switching Between Teams And
  Unassigned Is a Selection, Not a Rebuild*) lifts `clearGroupLock`'s body into
  `seatUnassignedFleet()` and keeps `clearGroupLock` as a caller. This plan calls
  `clearGroupLock()` either way, so the two are compatible in either order. They
  share `terminals.js`; sequence rather than parallelise.
- Confined to `src/webview/terminals.js`. No verbs, no backend, no schema, no
  CSS. `terminals.groupPrefs` gains no new keys.

**Security:** none. Client-side rendering logic only.

## Verification Plan

> Testing is against a running standalone host (`node dist/standalone/cli.js`), in
> the browser cockpit.

1. **The reported defect — free pane:** spawn 4 terminals of one role so a
   derived group forms, plus 2 of a role below the threshold. Lock the derived
   group at a grid size with at least one empty pane. Click one of the two
   ungrouped terminals in the sidebar. Confirm the panel switches to the
   unassigned grid showing **both** ungrouped terminals — not one terminal
   dropped into a spare pane of the derived group.
2. **No silent membership write:** click back to the derived group's tab.
   Confirm its count is unchanged and the ungrouped terminal is not in it.
   Reload and confirm the count is still unchanged — i.e. nothing was persisted
   to `groupPrefs.extras`.
3. **The other branch — no free pane:** size the grid so the locked group
   exactly fills every pane. Click an ungrouped terminal. Confirm the same
   outcome as step 1 (previously this dropped the lock entirely).
4. **Real groups unaffected:** with a real group locked and a free pane, click a
   terminal belonging to a different real group. Confirm the existing adopt
   behaviour is unchanged.
5. **Grid size:** confirm the unassigned grid seats at
   `smallestLayoutFitting(count)` — no empty trailing panes.
6. **No regression in free composition:** with no lock, click ungrouped and
   grouped rows. Confirm unchanged behaviour.
7. `npm run compile-tests` before any `test:contract:*` script.

## No migration

No setting is renamed, dropped or repurposed. No new key is written.
