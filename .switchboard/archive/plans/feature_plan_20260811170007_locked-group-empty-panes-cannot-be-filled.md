# A Locked Group's Empty Panes Cannot Be Filled — Every Sidebar Click Is Captured

## Goal

Make an empty pane fillable while a group is active. Clicking a terminal must be able to mean "put it *there*", not only "switch to whatever group owns it".

### The problem

Reported from UAT: *"my 2×2 terminal layout is not accepting any new terminals. The lower two slots remain completely empty. Selecting a terminal from the sidebar simply puts it in one of the top two slots."* Followed by: *"oh, I need to select 'All terminals — free composition' for this. This is super weird."*

Both observations are the same defect. The operator correctly deduced the workaround, which is the clearest possible evidence that the mode is doing something they never asked for.

### Root cause: the lock intercepts the click before seating is ever reached

The sidebar row handler branches on the lock (`src/webview/terminals.js:2047`):

```js
if (activeGroupId) {
    handleLockedTerminalClick(name);
} else {
    locateTerminal(name);
}
```

`locateTerminal` → `assignToFocusedPane` is the seating path, and it is correct: it scans for a genuinely free pane and prefers it over displacing an occupied one (`:2993-2997`):

```js
const isFree = (i) => !paneAssignments[i] && paneModes[i] !== 'kanban';
if (target === -1 || !isFree(target)) {
    for (let i = 0; i < rendered; i++) { if (isOpen(i) && isFree(i)) { target = i; break; } }
}
```

`handleLockedTerminalClick` (`:2313`) never reaches any of it. Its three outcomes are:

1. the terminal belongs to another group → `switchToGroup(group.id)` — re-seats the whole grid;
2. it belongs to the active group and is on screen → focus it;
3. it belongs to the active group and is off screen → `promoteGroupMember` — reorder within the group.

**None of them seat a terminal into an empty slot.** Under a lock, `paneAssignments` is written by exactly one function, `seatActiveGroupPage` (`:2145`), which fills from group members and pads the remainder with `null`:

```js
const assignments = members.slice(start, start + rendered);
while (assignments.length < getMaxSlotCount()) { assignments.push(null); }
paneAssignments = assignments;
```

So a group with fewer live members than rendered slots produces dead panes that no interaction can fill.

### Why the operator hit it with a 2×2

The empty slots exist because of the layout-inheritance defect covered in the companion plan: Planners (4 members) sets `currentLayout` to `2x2`; switching to Coders (2 members) inherits `2x2` because `layoutForFleetCount` is grow-only (`:1264`); `seatActiveGroupPage` seats two members and pads two `null`s. Clicking any planner to fill a gap is read as "switch to Planners", which re-seats everything into the top slots — precisely the reported symptom.

Fixing the layout plan makes the 2-member group render two panes and hides this. **It does not fix this.** The operator may legitimately want a 2×2 grid holding a 2-member group plus two ad-hoc terminals, and today there is no way to express that, because there is no way to add a terminal to a group at all. `saveSelectionAsGroup` (`:2088`) creates groups from a selection; nothing amends one.

### Root cause, restated

The lock was modelled as *read-only projection of a computed set*. Every write path was routed through group membership, and membership had no mutation primitive. The composer was disabled rather than reconciled — so the mode that is supposed to help you arrange terminals is the one mode in which you cannot arrange terminals.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, ux, bugfix
**Project:** Browser Switchboard

## User Review Required

None.

## Design

### Clicking a non-member with a free pane adds it to the group

Amend `handleLockedTerminalClick`. Before the "belongs to another group → switch" branch (`:2324`), check for a free rendered slot. If one exists, the click means *seat it here and make it a member*:

- Add it to the active group's membership **first** (see the overlay below).
- Seat it into the free slot using the same target-selection rules `assignToFocusedPane` uses, so pins, kanban panes and displacement keep their current semantics.
- Keep the lock. The operator stays where they are.

Switching groups remains reachable — that is what the tab strip is for (companion plan). A sidebar click stops being overloaded with a mode change it was never a good affordance for.

#### `assignToFocusedPane` cannot be called as-is — it drops the lock

The reuse above is the crux of this plan and it does not work naively. `assignToFocusedPane` clears the lock as its **first statement** (`:2938-2944`):

```js
function assignToFocusedPane(terminalName) {
    // A deliberate composer seat exits a locked group and keeps the panes as
    // they are until this assignment is applied.
    if (activeGroupId) {
        activeGroupId = null;
        activeGroupPage = 0;
    }
```

"Seat it via `assignToFocusedPane`" and "keep the lock" are directly contradictory instructions. Calling it drops the lock, which re-enters exactly the free-composition mode the operator was trying to avoid, and makes this plan's fix indistinguishable from the "All terminals" workaround they already found.

Two ways out. **Pick the first:**

1. **Add an opt-out: `assignToFocusedPane(name, { keepLock: true })`.** Guard the unlock block on `!opts.keepLock`, matching the established `setLayoutMode(mode, { keepLock })` convention already in this file (`:2898-2906`). One call site passes it — the new branch in `handleLockedTerminalClick`. Every existing caller is untouched and keeps dropping the lock.
2. Extract the target-selection scan (`:2981-3018`) into a pure `pickSeatFor(name)` helper and call it from both. Cleaner in principle, but it lifts ~40 lines of dense, heavily-commented pin/kanban/displacement logic out of the function whose behaviour the contract tests pin, for one new caller. Not worth it here.

Under option 1, note what the rest of `assignToFocusedPane` then does while a lock is held: the "already on screen → follow it" branch (`:2961-2970`), the pin-precedence scan, and the displacement fallbacks all still run. That is intended — but it means the *caller* must guarantee a free slot exists before passing `keepLock`, because the fallbacks end in "displace the focused pane", which under a lock would evict a group member to seat a non-member. Check for a free slot in `handleLockedTerminalClick` and only then call; if there is no free slot, fall through to the existing switch-to-its-group behaviour.

#### The `!group` branch becomes live, and it belongs to this plan

`handleLockedTerminalClick` opens with a branch for a terminal no group claims (`:2315-2323`):

```js
if (!group) {
    // No group claims it at all — drop the lock and seat it, so the click is
    // never dead.
    activeGroupId = null; activeGroupPage = 0;
    saveLayoutSettings();
    locateTerminal(name);
    return;
}
```

It is near-unreachable today because `findGroupForTerminalName` falls back to the `Unassigned` pseudo-group. The group-deletion plan retires that pseudo-group and makes `findGroupForTerminalName` return `null` — at which point this branch becomes the path for **every ungrouped terminal clicked under a lock**, and its "drop the lock" behaviour is the same defect this plan is fixing, just for a different terminal.

Fold it in: with a free slot available, an unclaimed terminal is seated into it and added to the active group, lock retained — identical to the non-member case. Only when no slot is free does it fall back to dropping the lock and seating (there is no other group to switch to). Sequence this plan after the deletion plan so the branch is live when it is rewritten.

### Membership gains an additions overlay

Derived groups (`role`, `worktree`) recompute from `fleetList` on every render, so an added member cannot be stored on the group object — it would vanish on the next 5-second poll. Store additions in `groupPrefs`, keyed by group id, alongside the existing `hidden` / `pinned` / `orders` maps (`:95`):

```js
groupPrefs = { threshold: 2, hidden: [], pinned: [], orders: {}, layouts: {}, extras: {} }
```

`getGroupMembers` (`:2246`) returns *derived members ∪ `extras[group.id]`*, de-duplicated, then ordered by `orderGroupMembers` as today. Manual groups append to their own `members` array as they do now — no overlay needed.

This preserves the property that makes derived groups worth having: a newly spawned planner still joins "Planners" automatically, because the derived half is still computed live. The overlay only adds; it never subtracts.

**Persistence: the save is free, the load is not.** `saveLayoutSettings()` writes the whole object (`:1399`), so nothing is needed on the write side. But the loader rebuilds `groupPrefs` from a field-by-field whitelist and drops every key it does not name (`:1351-1359`) — `threshold`, `hidden`, `pinned`, `orders` and nothing else. `extras` must be added there as well as at the `:95` initialiser. Miss it and added members persist correctly, survive every poll and every group switch, and vanish on the next panel reload — with verification step 5 below as the only thing that catches it.

Validate on read the way the existing keys do: `extras: (savedGroupPrefs.extras && typeof savedGroupPrefs.extras === 'object') ? savedGroupPrefs.extras : {}`, and coerce each value to an array of strings. `terminals.groupPrefs` is shipped state — an install with no `extras` must load `{}` and behave exactly as today.

Entries naming terminals that no longer exist are filtered by the existing `live` set in `getGroupMembers` (`:2248`) — do not prune them eagerly, since a terminal name can return. **Note that `live` is currently applied only to the `manual` branch**; the `role` and `worktree` branches filter `fleetList` directly (`:2257`, `:2259`). The `extras` union must be intersected with `live` explicitly, or a dead name will be seated. The layout plan aligns those branches onto the shared `live` set — if it has landed, use it; if not, apply `live` to the union here.

### A terminal can now be in two groups

The overlay makes overlap reachable for the first time: a coder added as an extra to "Planners" is a derived member of "Coders" and an extra of "Planners" simultaneously. Consequences to settle rather than discover:

- `findGroupForTerminalName` (`:2303`) returns the **first** match — manual groups, then derived, in `getDerivedGroups()` order. So it names one of the two arbitrarily. The tab-strip plan builds its per-row group chip from this function while describing the chip as naming "the group(s) claiming it". Either the chip shows the single resolved group (accept the ambiguity) or it collects all claimants. State which; do not leave the chip's meaning implicit.
- `getGroupMembers` de-duplicates within a group. Nothing de-duplicates across groups, and nothing should — overlap is now a legitimate state.
- `orderGroupMembers` (`:2273`) keys `groupPrefs.orders` by group id, so the same terminal can hold a different position in each group. That is correct and needs no change.

This also removes the last argument for the `detach` button, which is being deleted in the dead-controls plan: making a derived group editable is now just clicking a terminal into it.

### Removing a member

Adding without removing is a one-way door. The pane header's existing unassign control is the natural counterpart: unassigning a pane while a group is locked removes that terminal from `extras` if it is there, and from a manual group's `members` if it is. A derived member — one the group computes — cannot be removed this way; unassigning it vacates the pane, and the terminal remains a member. Suppressing a derived member is a different feature and is not in scope.

### Empty panes must invite a click

An empty pane under a lock currently renders the header text `Pane N (Empty)` (`:3912`), which reads as inert. Give an empty pane a visible affordance to seat something — reusing the `group:<id>` role-picker entry point the tab-strip plan adds. This is the discoverability half of the fix: the behaviour change above makes the click work, and this makes it apparent that it will.

Two constraints inherited from that plan, both load-bearing:

- The picker survives re-renders only via `pickerState` (`:107`), and `renderSidebarList()` nulls `pickerState` whenever nothing reported mounting it (`:2875`). A picker mounted from a *pane header* is subject to the same trap as one mounted from the tab strip. Reuse whatever reporting mechanism that plan settles on rather than inventing a second one.
- Depend on that plan for the entry point; do not build a parallel one. If it has not landed, ship the behaviour change without the affordance and say so — a working click with no invitation is strictly better than today, and a second picker mechanism is worse than a delayed one.

## Implementation Notes

- `seatActiveGroupPage` runs on group switch (`:2132`), on fallback-banner paging (`:4897`), and again from `applyLayoutFloor` when the floor changes the rendered slot count (`:4912`). It rebuilds `paneAssignments` wholesale from members each time (`:2154-2158`) — so an added member must be in `getGroupMembers` output *before* the next seat, or it will be evicted by the very next reconcile. **Add to `extras` first, then seat.** This ordering is not a preference; a window resize is enough to trigger the reconcile.
- The pin invariant `pinnedPanes[i] → paneAssignments[i]` is enforced in `seatActiveGroupPage` (`:2162-2164`, which clears pins on slots the group left empty) and in `sanitizePaneAssignments`. Seating into a free slot under a lock must not break it — and note the interaction: a pinned-but-empty slot is *cleared* by the next reconcile, so seating into it and then triggering a reconcile must not resurrect a pin the operator no longer has.
- `getGroupMembers`'s `unassigned` branch (`:2260-2268`) computes the complement of all membership, so adding `extras` to the union changes what "unassigned" means. **The group-deletion plan deletes that branch and the `getUnassignedGroup` pseudo-group outright.** Sequence this plan after it and the question disappears; if the order is inverted, the `extras` union must be added to the complement computation in that branch too or a group member will also render as unassigned.
- `promoteGroupMember` (`:2346-2355`) writes member order via `setGroupOrder` and then calls `switchToGroup(activeGroupId, { keepPage: true })`. Ensure an `extras` member participates in ordering identically to a derived one — it will, because `orderGroupMembers` operates on whatever list `getGroupMembers` returns.
- Do not add a confirmation step to any of this. Per `CLAUDE.md`, clicks act immediately.

## Verification Plan

1. **The reported case.** Lock a 2-member group displayed in a `2x2` grid. Click a third terminal in the sidebar. It must be seated into an empty lower slot, the lock must be retained, and the group's count must become 3.
2. **Fill both.** Repeat for the fourth slot. All four panes occupied, one group, no mode change.
3. **Survives a poll.** Wait through several 5-second fleet polls; the added terminals must stay seated and still be members.
4. **Survives a switch.** Switch to another group and back — the added members are still there.
5. **Survives a reload — the loader-whitelist check.** Reload the panel; membership persists via `terminals.groupPrefs`. This is the only step that catches a missing `extras` line at `:1351-1359`, and everything from step 1 to 4 passes with that bug present. Also confirm an install with no stored `extras` loads without throwing.
6. **The lock is genuinely retained.** After step 1, read `activeGroupId` — it must still name the group. The screen alone cannot distinguish "seated with the lock held" from "lock dropped and seated by free composition", and the second is the bug.
7. **A window resize does not evict the addition.** After step 1, resize the window until the layout floor changes the rendered slot count. The added member must still be seated — this is the `seatActiveGroupPage` reconcile that the add-before-seat ordering exists to survive.
8. **Derived membership still live.** With a terminal added to "Planners", spawn a new planner and confirm it joins automatically — the overlay has not frozen the group.
9. **An unclaimed terminal behaves identically.** With a fleet where one terminal belongs to no group at all, lock a group with a free pane and click it: seated, added, lock retained — not "lock dropped and seated", which is the pre-existing `!group` behaviour.
10. **Overlap is coherent.** Add a coder to "Planners". Confirm it appears in both groups' member lists and counts, that switching between the two seats it in each, and that its sidebar chip shows whatever the tab-strip plan settled on — not a blank.
11. **No free slot.** With every rendered pane occupied, clicking a non-member behaves as before (switch to its group). Confirm no group member is displaced to make room.
12. **Pins.** Pin a pane, then click a non-member into a free slot. The pinned pane keeps its occupant.
13. **Every other `assignToFocusedPane` caller still drops the lock.** Under a lock, exercise drag-drop onto a pane, an inbound `focusTerminal` from the board, and `locateTerminal` from a non-sidebar route. Each must behave exactly as it does today — only the new `handleLockedTerminalClick` branch passes `keepLock`.
14. **Removal.** Unassign an added terminal; it leaves the group. Unassign a derived member; the pane vacates and membership is unchanged.
15. **Empty-pane affordance.** An empty pane under a lock visibly offers to be filled, and using it seats and adds in one step.
16. **Regression.** `npm test` — `terminal-pane-grid-reconcile-contract.test.js`, `terminal-sidebar-groupings-contract.test.js`, `terminal-focus-affordance-contract.test.js`.

## Completion Summary

Made empty panes under a locked group fillable via sidebar clicks, and added an extras overlay for derived-group membership. Added `extras: {}` to both `groupPrefs` sites (initialiser and loader whitelist with array-of-strings coercion), preserving the `layouts` key from plan 2. Modified `getGroupMembers` to union derived members with `groupPrefs.extras[id]`, de-duplicated and intersected with the `live` set explicitly (the role/worktree branches inline the child-excluding predicate rather than reading the live Set). Added `{ keepLock }` opt to `assignToFocusedPane` — the unlock block is guarded on `!opts.keepLock`, dismissPeek stays above it and is not reordered or gated. Rewrote `handleLockedTerminalClick`: before the switch-to-its-group branch, checks for a genuinely free rendered slot; if one exists and the terminal is not a member of the active group, adds it to the group's membership FIRST (via `addTerminalToActiveGroup` — extras for derived, members array for manual), then seats with `assignToFocusedPane(name, { keepLock: true })`. The `!group` branch is folded in: with a free slot, an unclaimed terminal is seated and added identically; only without a free slot does it fall back to dropping the lock. Modified the unassign handler to remove the terminal from `groupPrefs.extras` (derived) or `group.members` (manual) when a group is locked — a derived member's pane vacates but membership is unchanged. Empty-pane affordance: the placeholder text changes to "Click a terminal to add it to this group" under a lock, and a delegated click handler in `createPaneElement` opens the role picker via `onNewTerminalClicked(undefined, 'group:' + activeGroupId)` — reusing the strip's `group:*` picker key so `renderGroupTabStrip` reports it and it survives the fleet-poll garbage-collect. No parallel picker mechanism is built; the picker appears in the strip, not the pane header. Stated in code that the sidebar chip shows the first claimant under overlap (manual groups first, then derived in `getDerivedGroups()` order), not all claimants. Two defects found in review and fixed: (1) stale placeholder text — the creation branch only builds the node when absent, so a pane empty before the lock kept the old text forever; added an `else` branch that re-derives the text on every reconcile for an existing non-kanban `.pane-empty-slot`, matching the header-button re-derivation rule. (2) kanban empty-state hijack — `.kanban-pane-empty` carries `.pane-empty-slot`, so the click handler fired on a working board control; gated the handler on `!target.classList.contains('kanban-pane-empty')` and `paneModes[index] !== 'kanban'`, matching the `isFreeSlot` exclusion the seating logic already applies. File changed: `src/webview/terminals.js` only. `npm test` waived per dispatch instructions.

## Review Findings

**CRITICAL (fixed):** post-review fix (1), the stale-placeholder-text re-derive, used `existing.textContent = …`, which replaces *every* child node — including the `kanban mode` toggle button the creation branch appends — so the first reconcile after any pane emptied silently and permanently deleted the only entry point to kanban pane mode for the life of the page (panes are reused, not rebuilt); fixed to update the leading text node's `nodeValue` instead, leaving element children intact, and pinned by a new assertion in `terminal-pane-grid-reconcile-contract.test.js`. **MAJOR (fixed):** `handleLockedTerminalClick`'s `hasFreeSlot` precondition excluded kanban panes but not pinned ones, while the `assignToFocusedPane` it then calls with `keepLock` refuses pinned slots via `isOpen` — a looser precondition than the callee's own test is exactly how the displacement fallbacks get reached and evict a group member under the lock, which the plan explicitly forbids; the predicate now mirrors `isOpen(i) && isFree(i)` including the `rendered > 1` pin gate. Verified clean otherwise: `extras` is present in both `groupPrefs` sites with array-of-strings coercion and without dropping plan 2's `layouts`, the union is intersected with `live` explicitly, `keepLock` has exactly one caller, add-before-seat ordering holds, and the kanban empty-state click hijack is correctly gated. Files changed by this review: `src/webview/terminals.js`, `src/test/terminal-sidebar-groupings-contract.test.js`, `src/test/terminal-pane-grid-reconcile-contract.test.js`. Contrary to the completion summary above, verification **was** run — no skip directive was present in the review dispatch: `terminal-sidebar-groupings` 38/38, `terminal-pane-grid-reconcile`, `terminal-pane-pinning` 15/15 and `terminal-focus-affordance` executed, with `tsc`/`compile` clean; remaining risk is that overlap semantics (a terminal in two groups) are asserted only at source level and still want a UAT pass.
