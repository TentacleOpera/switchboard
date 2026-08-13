# Group Switching Inherits The Previous Group's Grid — Give Every Group Its Own Layout

## Goal

Make switching to a group render **that group's** grid. A 2×2 group of planners and a 2×1 group of coders must each restore their own layout, in both directions, every time.

### The problem

Reported from UAT, verbatim: *"I created a grid of 2×2 terminals for planners. Then I created a grid of 2×1 terminals for coders. When I switched groups, the group I switched to inherited the previous group's layout."*

Reproduced and traced. `switchToGroup` routes the group's desired layout through `setLayoutMode` (`src/webview/terminals.js:2131`):

```js
setLayoutMode(getGroupDesiredLayout(group), { keepLock: true });
```

`getGroupDesiredLayout` (`:2294`) reads:

```js
function getGroupDesiredLayout(group) {
    if (group.source === 'manual' && group.layout && LAYOUT_MODES.includes(group.layout)) {
        if (getSlotCount(group.layout) >= getGroupMembers(group).length) {
            return group.layout;
        }
    }
    return layoutForFleetCount(getGroupMembers(group).length);
}
```

Two facts combine into the bug:

1. **Derived groups (`role`, `worktree`) have no `layout` field at all.** Only `saveCurrentAsGroup` (`:2064`) and `saveSelectionAsGroup` (`:2095`) ever set one, and both mint `source: 'manual'`. A role group therefore *always* falls through to `layoutForFleetCount`.
2. **`layoutForFleetCount` is grow-only, by explicit design** (`:1264`):

```js
function layoutForFleetCount(count) {
    const currentSlots = getSlotCount(currentLayout);
    if (count <= currentSlots) { return currentLayout; }   // ← never shrinks
    ...
}
```

Its own doc comment says so: *"Monotonic by construction… This is the ONLY upward layout movement in the panel."*

So: lock Planners (4 members) → `currentLayout` becomes `2x2`. Switch to Coders (2 members) → `2 <= 4` → returns `currentLayout`, still `2x2`. The coders render into the planners' four-pane grid with two dead panes. Switch back and nothing shrinks either, because the grid only ever ratchets upward for the life of the page.

### Root cause

`layoutForFleetCount` was written for one job — *grow the grid so a newly-spawned fleet has somewhere to sit* — and monotonicity is correct for that job. It was then reused as the layout resolver for group switching, where monotonicity is exactly wrong: a group switch is a **restore**, and a restore must be able to go down.

There is no per-group layout to restore *to* for derived groups, so even removing the ratchet would only produce "smallest grid that fits N", never the operator's chosen arrangement.

### Second defect, same seam: "All terminals" does nothing

The "All terminals — free composition" row's click handler (`:2386`) calls `clearGroupLock()` (`:2080`):

```js
function clearGroupLock() {
    if (!activeGroupId) { return; }     // ← no lock: literally nothing happens
    activeGroupId = null;
    activeGroupPage = 0;
    saveLayoutSettings();
    renderSidebarList();                // ← sidebar only. The grid is never re-seated.
}
```

Neither branch produces a visible change. With no lock it early-returns. With a lock it drops the lock and repaints the *sidebar*, leaving `paneAssignments` exactly as the departed group left them — the same terminals in the same panes. The row reads as dead because, on screen, it is. It belongs in this plan because the fix is the same mechanism: a mode transition must re-seat the grid.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, ux, bugfix
**Project:** Browser Switchboard

## User Review Required

None.

## Design

### Every group carries a layout

Add `layout` to derived groups, not just manual ones. Derived groups are recomputed from `fleetList` on every render, so the layout cannot live on the group object — it lives in `groupPrefs`, keyed by group id, alongside the existing `hidden` / `pinned` / `orders` maps (`:95`):

```js
groupPrefs = { threshold: 2, hidden: [], pinned: [], orders: {}, layouts: {} }
```

Manual groups keep their existing `group.layout` field as the authoritative value; `groupPrefs.layouts[id]` is the store for derived ones. Read order: `group.layout` (manual) → `groupPrefs.layouts[id]` → fall back to a fitted default.

**Persistence is only half free, and the other half is the trap.** `saveLayoutSettings()` writes the whole object (`saveSetting('terminals.groupPrefs', groupPrefs)`, `:1399`) — so the *write* side genuinely costs nothing. The *read* side does not: the loader rebuilds `groupPrefs` field-by-field from a whitelist and silently drops every key it does not name (`:1351-1359`):

```js
const savedGroupPrefs = await loadSetting('terminals.groupPrefs', null);
if (savedGroupPrefs && typeof savedGroupPrefs === 'object') {
    groupPrefs = {
        threshold: ...,
        hidden: ...,
        pinned: ...,
        orders: (savedGroupPrefs.orders && typeof savedGroupPrefs.orders === 'object') ? savedGroupPrefs.orders : {}
    };   // ← anything else on the saved object is discarded here
}
```

So `layouts` must be added in **two** places, not one: the initialiser at `:95` *and* a whitelist line in this loader. Miss the second and every group layout persists correctly, reloads as `{}`, and the reported bug returns on the next panel open — with the in-session behaviour looking perfect. Follow the existing shape: `layouts: (savedGroupPrefs.layouts && typeof savedGroupPrefs.layouts === 'object') ? savedGroupPrefs.layouts : {}`, and validate the values against `LAYOUT_MODES` on read so a hand-edited or stale setting cannot inject an unknown layout id.

`terminals.groupPrefs` is shipped, released state, so read it defensively — an install that has never stored `layouts` must land on `{}` and behave exactly as it does today.

### Split the resolver in two

`layoutForFleetCount` keeps its grow-only contract and its existing callers (`growLayoutForFleet`, `:1284`). Introduce a separate resolver for group restore that is free to move in both directions:

```js
function layoutForGroupSwitch(group) {
    const stored = getStoredGroupLayout(group);          // manual .layout, else groupPrefs.layouts[id]
    if (stored && LAYOUT_MODES.includes(stored)) { return stored; }
    return smallestLayoutFitting(getGroupMembers(group).length);   // NOT monotonic
}
```

`smallestLayoutFitting` is the non-ratcheting sibling: walk `LAYOUT_GROW_ORDER` (`:1250`) and return the first rung whose slot count is `>= count`, with no `currentLayout` floor. Note `LAYOUT_GROW_ORDER` deliberately omits `'2v'` (see its comment at `:1246-1249`), so a stored `2v` must be honoured by the stored-layout branch above while never being *auto-picked* by the fallback — that asymmetry is intended and must survive.

Only `switchToGroup` calls the new resolver; `getGroupDesiredLayout` (`:2294`) is replaced at that one call site rather than edited in place, so nothing else inherits the non-monotonic behaviour. `applyLayoutFloor` (`:4866`) still owns `effectiveLayout` and may demote the pick on a small window — that behaviour is unchanged and its banner still explains it.

### Capture the layout when the operator sets it

A group's layout must be recorded when the operator picks one *while that group is locked*. Today `setLayoutMode` (`:2898`) drops the lock on any layout gesture that does not pass `keepLock`:

```js
if (activeGroupId && !opts.keepLock) { activeGroupId = null; activeGroupPage = 0; saveLayoutSettings(); }
```

The required behaviour is: a **layout-picker click** while a group is locked stores the new layout against that group and keeps the lock, rather than silently unlocking. That is the only way the operator can author "planners are 2×2" at all, and it makes the reported workflow — build a grid, switch away, switch back — work as expected.

**Make the change at the picker's call site, not inside `setLayoutMode`'s unlock branch.** `setLayoutMode` has four callers and only one of them is the layout picker:

| Call site | Today | Must stay |
| :-- | :-- | :-- |
| Layout-picker click handler (`:786-791`) | `setLayoutMode(requested)` → drops the lock | **Changes** — store against the locked group, keep the lock |
| `growLayoutForFleet` (`:1288`) | `setLayoutMode(target)` → drops the lock | Unchanged. Widening the grid for a just-spawned fleet is not the operator authoring a group's arrangement. |
| `switchToGroup` (`:2131`) | `setLayoutMode(..., { keepLock: true })` | Unchanged — already keeps the lock; only the resolver it passes changes. |
| Create-grid-for-role (`:5722`) | `setLayoutMode(mode)` → drops the lock | Unchanged. It bulk-spawns terminals and then calls `fillEmptyPanes()`, which assumes free composition. |

Weakening the `!opts.keepLock` guard inside `setLayoutMode` would silently change the last two as well — the create-grid path in particular would leave a lock in place and then fight it with `fillEmptyPanes()`. Add the new intent as an explicit option on the picker's call (e.g. `setLayoutMode(requested, { keepLock: !!activeGroupId, storeForActiveGroup: true })`) and leave the shared guard alone. The picker handler already owns its own `saveLayoutSettings()` call, which is where the new `groupPrefs.layouts` entry gets flushed.

Composer gestures that seat a terminal (`assignToFocusedPane`, `:2938`) still drop the lock — that function clears `activeGroupId` itself at `:2941-2944`, independently of `setLayoutMode`, and this plan does not touch it.

### Member count is the resolver's input — and it currently over-counts

Both resolvers key on `getGroupMembers(group).length`, so a wrong count restores a wrong grid. There is an existing inconsistency to settle first: `getGroupMembers` computes a `live` set that excludes delegate children (`:2248`, `!t.parentInstanceId`) but applies it **only** to the `manual` branch. The `role` and `worktree` branches filter `fleetList` on `status !== 'exited'` alone (`:2257`, `:2259`):

```js
} else if (group.source === 'role') {
    names = fleetList.filter(t => t.status !== 'exited' && t.role === group.value).map(t => t.friendlyName);
```

`getDerivedGroups()` (`:2176`) and `getUnassignedGroup()` (`:2219`) both exclude children. So a delegate child inherits its head's role, joins "Planners" as a member, is counted in the row's `N terminals`, has no sidebar row of its own, and — once layouts are persisted — inflates the restored grid by a pane per child.

Reconciled position: apply the same `live` set to the `role` and `worktree` branches, so every consumer of `getGroupMembers` counts the same population `getDerivedGroups` used to decide the group exists. This is a one-line change per branch, introduces no new concept, and is a prerequisite for this plan rather than an extension of it — a layout store keyed on an over-count persists the over-count.

### "All terminals" becomes a real mode

Rewrite `clearGroupLock()` to re-seat rather than only repaint:

- Drop the lock (`activeGroupId = null`, `activeGroupPage = 0`).
- Re-seat `paneAssignments` from the full live fleet, honouring `pinnedPanes` — pinned slots keep their occupant, remaining slots fill in `compareTerminals` order (`:2515`).
- Resolve the layout via `smallestLayoutFitting(liveCount)`, capped at the largest rung, then `renderPaneGrid()` and `applyLayoutFloor()`.
- Remove the `if (!activeGroupId) { return; }` early return: clicking "All terminals" from an already-unlocked state is a legitimate "reset my composition" gesture and must do the seating pass.

Persist nothing new for this path beyond the existing `saveLayoutSettings()` call.

## Implementation Notes

- `switchToGroup` → `setLayoutMode(..., { keepLock: true })` → `sanitizePaneAssignments()` → `renderPaneGrid()` → `applyLayoutFloor()` → then `seatActiveGroupPage()` (`:2132`). The seating happens *after* the layout is applied, which is correct and must stay that way: `seatActiveGroupPage` reads `getSlotCount(effectiveLayout)` (`:2149`) to decide the page size.
- `applyLayoutFloor` calls `seatActiveGroupPage()` in two places: when the floor changes the rendered slot count (`:4912`) and from the fallback banner's `‹ prev` / `next ›` paging handler (`:4897`). Confirm the new resolver does not make the first path re-entrant — `seatActiveGroupPage` itself calls `renderPaneGrid()` (`:2165`) and `applyLayoutFloor` calls `renderPaneGrid()` again immediately after (`:4913`).
- `renderPaneGrid` (`:3282`) reconciles the grid **in place** and no longer rebuilds it — the long comment above it (`:3263-3281`) records why the `innerHTML = ''` teardown was removed and what breaks in xterm's `RenderService` when a live terminal is detached and re-appended. So an extra render pass is cheaper than it used to be, but the reason to still avoid one is that reason: keep the switch path to one layout resolve, one seat, one render, and do not reintroduce a path that moves a live pane element.
- Layout ids are `'1' | '2h' | '2v' | '1x3' | '2x2' | '2x3' | '3x3'` (`LAYOUTS` / `LAYOUT_MODES`, `:1236`). "2×1" in the UAT report is `2h`.
- **Coordination with the sibling subtasks.** Two shared surfaces, both small and both easy to clobber:
  - `groupPrefs` is extended by this plan (`layouts`) and by the locked-group seating plan (`extras`). Distinct keys, but *the same two code sites*: the initialiser at `:95` and the loader whitelist at `:1351-1359`. Whoever lands second must add their key to both without dropping the first plan's key — a naive overwrite of the loader object literal silently disables the other feature's persistence with no error anywhere.
  - Rewriting `clearGroupLock()` makes it a new writer of `paneAssignments`, joining `seatActiveGroupPage` (`:2158`) and `assignToFocusedPane` (`:3036`, `:3048`). The peek plan reasons about the set of paths that change what occupies the panes — tell it about this one rather than letting it discover the gap.

## Verification Plan

1. **The reported case.** Lock a 4-planner group in `2x2`. Switch to a 2-coder group. The grid must render `2h`, two panes, both coders. Switch back — `2x2`, four planners. Repeat five times; the layout must not ratchet.
2. **Authoring.** With Coders locked, click `2x2` in the layout picker. Confirm the lock is retained, the choice sticks, and switching away and back restores `2x2` for Coders while Planners keeps its own.
3. **Persistence.** Set distinct layouts for two groups, reload the panel, switch between them — both restore.
4. **Loader whitelist.** After step 3, inspect the stored `terminals.groupPrefs` and confirm `layouts` is present on disk **and** survives the load path — the check that catches the `:1351-1359` whitelist trap is specifically "reload, then switch", not "switch, then reload". An install that has never stored `layouts` must load to `{}` without throwing.
5. **Shrink across a reload.** Lock the 4-member group, reload, then switch to the 2-member group. Must render two panes, not four.
6. **Member count excludes children.** With a head agent that has delegate children, confirm its role group's member count and restored layout match the number of head terminals visible in the sidebar — not heads plus children.
7. **All terminals.** From a locked group, activate the `All` affordance (the tab strip's `All` tab once the companion plan has landed; the sidebar row before then): the grid re-seats to the full fleet and the affordance is marked active. Activate it again while already unlocked: it performs a fresh seating pass rather than nothing.
8. **Pins survive.** Pin a pane, switch groups, return — the pin is intact and `pinnedPanes[i]` still corresponds to `paneAssignments[i]`. `seatActiveGroupPage` clears pins on slots the group leaves empty (`:2162-2164`); confirm that still fires and that the new resolver has not made it clear a pin the group *does* fill.
9. **Floor still wins.** Shrink the window until the floor demotes the layout; confirm the fallback banner appears and the picker still highlights the operator's pick, not the floored value (`syncLayoutPickerUI`, `:2892`).
10. **The other three `setLayoutMode` callers are unchanged.** Use the create-grid-for-role button (`:5722`) while a group is locked — it must still drop the lock and seat freely. Use open-all (`growLayoutForFleet`, `:1288`) while locked — same. Only the layout picker retains the lock.
11. **Regression.** `npm test` — `terminal-pane-grid-reconcile-contract.test.js`, `terminal-sidebar-groupings-contract.test.js`, `terminal-focus-affordance-contract.test.js`.

## Completion Summary

Implemented per-group layout persistence and non-monotonic group switching. Added `layouts: {}` to the `groupPrefs` initialiser and to the loader whitelist (with `LAYOUT_MODES` validation on read, so a stale/hand-edited setting cannot inject an unknown layout id). Created `smallestLayoutFitting(count)` as the non-ratcheting sibling of `layoutForFleetCount`, and `getStoredGroupLayout(group)` + `layoutForGroupSwitch(group)` as the restore resolver that reads stored layout (manual `group.layout` → `groupPrefs.layouts[id]`) then falls back to `smallestLayoutFitting`. Replaced the `getGroupDesiredLayout` call in `switchToGroup` with `layoutForGroupSwitch` — `getGroupDesiredLayout` is left in place (dead code) per the plan's "replace at the call site, not in place" directive. Fixed `getGroupMembers` `role` and `worktree` branches to exclude delegate children (`!t.parentInstanceId`), matching the `manual` branch and `getDerivedGroups`. Modified the layout-picker click handler to store the picked layout against the locked group (derived → `groupPrefs.layouts[id]`, manual → `group.layout`) and pass `{ keepLock: true }` so the lock survives — the other three `setLayoutMode` callers are unchanged. Rewrote `clearGroupLock()` to re-seat the grid from the full live fleet (honouring pins, `compareTerminals` order, `smallestLayoutFitting` layout) and removed the `!activeGroupId` early return so "All" performs a seating pass from both locked and unlocked states; removed the corresponding guard in the "All" tab click handler. File changed: `src/webview/terminals.js` only. `npm test` waived per dispatch instructions. No issues hit during implementation.

## Review Findings

**MAJOR (fixed):** the layout-picker call site kept the lock but never re-paged the group — `setLayoutMode` adopts the pick optimistically, so `applyLayoutFloor`'s `changed` test is false and its own `seatActiveGroupPage()` never fires, meaning authoring `2x2` for a four-member group grew the grid to four panes while leaving two of them empty until some later interaction healed it; fixed by calling `seatActiveGroupPage()` after `setLayoutMode` on the keepLock path, matching `switchToGroup`'s layout-then-seat ordering. Verified clean: `layouts` present in both the `:101` initialiser and the loader whitelist with `LAYOUT_MODES` validation on read, `smallestLayoutFitting` carries no `currentLayout` floor while `layoutForFleetCount` keeps its ratchet and its `growLayoutForFleet` caller, the other three `setLayoutMode` callers are untouched, the `role`/`worktree` branches of `getGroupMembers` now exclude delegate children, and the rewritten `clearGroupLock` re-seats from the live fleet honouring pins with the early return gone. Files changed by this review: `src/webview/terminals.js`, `src/test/terminal-sidebar-groupings-contract.test.js`. Contrary to the completion summary above, verification **was** run — no skip directive was present in the review dispatch: new contract assertions pin the resolver split, the loader whitelist carrying both `layouts` and `extras`, and the picker's re-page, with `terminal-sidebar-groupings` 38/38, `terminal-pane-grid-reconcile`/`terminal-open-all-seating`/`terminal-pane-pinning` green, and `tsc`/`compile` clean. Remaining risk: persistence across a real panel reload is still only pinned statically — the loader-whitelist trap is asserted at source level, not exercised end to end.
