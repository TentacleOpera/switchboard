# Rename group tab "All" to "Unassigned" and show only unassigned terminals

## Goal

The leading tab in the `terminals.html` group tab strip is currently labeled **"All"** and, when clicked, calls `clearGroupLock()` to re-seat the pane grid from the **full live fleet**. This is wrong: the tab is meant to be the catch-all for terminals that are not in any manual or derived group, but it currently shows grouped and ungrouped terminals together. The result is a mixed grid where terminals already claimed by a role, worktree, or manual group appear next to genuinely unassigned terminals, which violates the intended separation.

The root cause is in `src/webview/terminals.js`:

- `renderGroupTabStrip()` hard-codes the first tab as `textContent = 'All'` and gives it a misleading "free composition" tooltip.
- `clearGroupLock()` (the click handler for that tab) fills `paneAssignments` from every live terminal (`fleetList.filter(t => t.status !== 'exited' && !t.parentInstanceId)`) without filtering out terminals that are already members of a group.
- The tab carries no count, so the operator cannot see how many unassigned terminals exist.

The fix is to rename the tab to **"Unassigned"**, badge it with the count of unassigned terminals, and make `clearGroupLock()` compute and seat only the terminals that no group claims, using the smallest grid layout that fits that subset.

### Known Limitation — Snapshot, Not Enforced Invariant

The filter is applied in `clearGroupLock()` — the click-the-tab entry point. The `activeGroupId = null` state is also set by three other code paths that do NOT re-seat with the unassigned filter: `handleLockedTerminalClick` (line ~3034, drops lock + `locateTerminal`), `setLayoutMode` (line ~3904, layout change), and `assignToFocusedPane` (line ~3956, sidebar click seating). Additionally, the ongoing `sanitizePaneAssignments()` poll cycle evicts dead names and stale pins but does NOT evict grouped terminals. This means:

- **Sidebar click pollution:** Clicking a grouped terminal in the sidebar while in "Unassigned" mode seats it into the grid, violating the unassigned-only expectation.
- **Load path:** On page reload with `activeGroupId = null`, saved `paneAssignments` may contain grouped terminals from the old full-fleet seating. The "Unassigned" tab is active but the grid shows grouped terminals until the user clicks the tab to re-seat.
- **Initial assignment:** The first-load seeding at line ~2125 seats `fleetList[0]` into pane 0, which may be a grouped terminal.

These are accepted as known limitations for this plan. The "Unassigned" tab delivers a correct unassigned-only grid when clicked; ongoing interaction can pollute it, and the user can click the tab again to reset. Broader invariant enforcement (filtering sidebar clicks, fixing the load path) is deferred — see Outstanding Questions.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

## User Review Required

This plan changes the semantic meaning of the `activeGroupId = null` state from "all terminals" to "unassigned only" but only enforces the filter at the `clearGroupLock()` entry point. The user should review whether the known limitations (sidebar-click pollution, load-path stale state) are acceptable for this iteration or whether broader invariant enforcement is needed in the same change.

## Complexity Audit

This is a **Medium** change. It touches the group-lock lifecycle, the pane seating algorithm, and the tab strip DOM. The logic is localized to one file, but it interacts with several existing invariants:

- `getAllGroups()`, `getGroupMembers()`, and `findGroupForTerminalName()` must stay consistent when deciding whether a terminal is "unassigned".
- Pinned panes must be respected while still honouring the new rule that grouped terminals do not belong in the unassigned grid.
- The layout floor (`applyLayoutFloor()`) can still shrink the chosen grid for a small window, so the "smallest grid needed" is a best-fit request rather than an absolute guarantee.

Risk is low because the change is confined to the unlocked / "Unassigned" state and the existing group-lock path remains untouched.

### Routine
- Renaming the tab label from "All" to "Unassigned" with a count badge span.
- Adding a helper that filters the live fleet by group membership.
- Updating the seating block in `clearGroupLock()` to use the filtered list.

### Complex / Risky
- The semantic change to `activeGroupId = null` creates a label-vs-grid mismatch on paths that set `activeGroupId = null` without re-seating (see Known Limitation above).
- The existing contract test `terminal-sidebar-groupings-contract.test.js` asserts `allTab.textContent = 'All'` and must be updated in the same change.

## Edge-Case & Dependency Audit

1. **Zero unassigned terminals.** If every live terminal is in a group, the "Unassigned" count is `0` and `clearGroupLock()` should produce an empty grid with the `1` (single-pane) layout. `smallestLayoutFitting(0)` returns `'1'` (first rung in `LAYOUT_GROW_ORDER`), so this is handled.
2. **Pinned grouped terminals.** If the user has a pane pinned while a group was locked, then clicks "Unassigned", that pane must not retain a grouped terminal. Only unassigned terminals may keep a pin. The proposed `clearGroupLock()` checks `unassignedNames.includes(occupant)` and drops the pin if the occupant is grouped.
3. **Saved `activeGroupId = null` on load.** The first fleet fetch currently only calls `switchToGroup()` or `clearGroupLock()` when `activeGroupId` is truthy. This plan does **not** change the load path; it only fixes what happens when the user explicitly clicks the "Unassigned" tab. If the saved pane state is stale (contains grouped terminals), the user can click the tab to reset it. See Known Limitation.
4. **Role/worktree derived groups.** The same `findGroupForTerminalName()` predicate used elsewhere in the file should be reused so "unassigned" is defined exactly as "not claimed by any manual or derived group".
5. **Performance.** `getUnassignedTerminalNames()` calls `findGroupForTerminalName()` per terminal, which calls `getGroupMembers()` per group, which scans the fleet — O(N × M × F) per call. The count badge triggers this on every `renderSidebarList()` cycle (every 5s fleet poll). For realistic counts (N < 50, M < 10, F < 50) this is sub-millisecond and acceptable. An optimization (compute the union of all group members once, then subtract from the live fleet) is possible but not required for this iteration.
6. **Layout floor.** `smallestLayoutFitting(count)` may select `3x3` for many unassigned terminals, but `applyLayoutFloor()` can demote it when the window is small. That behaviour is preserved.
7. **Extras overlay.** `getGroupMembers()` includes the extras overlay for derived groups (terminals manually added via the empty-pane fill). A terminal in a derived group's extras is correctly counted as a group member, not unassigned.
8. **Delegate children.** `getUnassignedTerminalNames()` filters out `t.parentInstanceId` terminals. `getGroupMembers()` for manual groups does not, but since `getUnassignedTerminalNames()` never passes children to `findGroupForTerminalName()`, there is no conflict.
9. **Contract test.** `terminal-sidebar-groupings-contract.test.js` line 342 asserts `strip.includes("allTab.textContent = 'All'")`. The proposed span-based construction removes this line. The test must be updated in the same change to assert the new "Unassigned" construction.

## Dependencies

- None — this plan is self-contained within `src/webview/terminals.js` and its contract test.

## Adversarial Synthesis

Key risks: (1) the existing contract test `terminal-sidebar-groupings-contract.test.js` asserts `allTab.textContent = 'All'` and will break if not updated; (2) the "Unassigned" label is enforced only at `clearGroupLock()` — sidebar clicks, load-path stale state, and the initial-assignment seeding can all pollute the grid with grouped terminals; (3) stale doc comments in `deleteGroup` and `clearGroupLock` say "full live fleet" and must be updated. Mitigations: add a test-update step to the Proposed Changes, document the snapshot limitation in the plan, and update both stale comments.

## Proposed Changes

### `src/webview/terminals.js`

#### 1. Add a helper to enumerate unassigned terminal names

Insert a small utility near the other group helpers (around `getAllGroups()` at line ~2803 or `findGroupForTerminalName()` at line ~2933):

```js
function getUnassignedTerminalNames() {
    const live = fleetList
        .filter(t => t.status !== 'exited' && !t.parentInstanceId)
        .sort(compareTerminals);
    return live
        .filter(t => !findGroupForTerminalName(t.friendlyName))
        .map(t => t.friendlyName);
}
```

This reuses `findGroupForTerminalName()` so the definition of "unassigned" is identical to the rest of the UI. The `findGroupForTerminalName()` call iterates `terminalGroups` then `getDerivedGroups()`, calling `getGroupMembers()` for each — O(N × M × F) per call, acceptable for realistic fleet sizes (see Edge-Case #5).

#### 2. Rename and count the leading tab in `renderGroupTabStrip()`

Replace the existing "All" button construction (lines 3098–3111) with:

```js
const unassignedCount = getUnassignedTerminalNames().length;
const allTab = document.createElement('button');
allTab.type = 'button';
allTab.className = 'group-tab' + (activeGroupId ? '' : ' active');
allTab.title = activeGroupId
    ? 'Drop the lock and show unassigned terminals'
    : 'Unassigned terminals';

const allTabName = document.createElement('span');
allTabName.textContent = 'Unassigned';
allTab.appendChild(allTabName);

const allTabCount = document.createElement('span');
allTabCount.className = 'group-tab-count';
allTabCount.textContent = String(unassignedCount);
allTab.appendChild(allTabCount);

allTab.addEventListener('click', () => {
    clearGroupLock();
});
tabRow.appendChild(allTab);
```

The count and name are split into two child spans so the count can reuse the existing `.group-tab-count` style without clobbering the label. The `allTab` variable name is retained so the overflow-measurement block at line ~3205 (`allTab.offsetWidth`) continues to work without renaming.

#### 3. Make `clearGroupLock()` seat only unassigned terminals

Replace the seating block in `clearGroupLock()` (lines 2552–2603) with a version that filters the live fleet to unassigned terminals and only keeps pins for unassigned terminals:

```js
function clearGroupLock() {
    activeGroupId = null;
    activeGroupPage = 0;

    // Re-seat from the unassigned live fleet (no delegate children, no group
    // members), honouring pins that are still unassigned.
    const unassignedNames = getUnassignedTerminalNames();
    const maxSlots = getMaxSlotCount();
    const assignments = new Array(maxSlots).fill(null);

    for (let i = 0; i < pinnedPanes.length && i < maxSlots; i++) {
        if (pinnedPanes[i]) {
            const occupant = paneAssignments[i];
            if (occupant && unassignedNames.includes(occupant)) {
                assignments[i] = occupant;
            } else {
                pinnedPanes[i] = false;
            }
        }
    }

    const seated = new Set(assignments.filter(Boolean));
    let fillIdx = 0;
    for (const name of unassignedNames) {
        if (seated.has(name)) { continue; }
        while (fillIdx < maxSlots && assignments[fillIdx] !== null) { fillIdx++; }
        if (fillIdx >= maxSlots) { break; }
        assignments[fillIdx] = name;
        fillIdx++;
    }

    paneAssignments = assignments;

    const targetLayout = smallestLayoutFitting(unassignedNames.length);
    currentLayout = targetLayout;
    effectiveLayout = targetLayout;

    syncLayoutPickerUI();
    sanitizePaneAssignments();
    renderPaneGrid();
    applyLayoutFloor();

    saveLayoutSettings();
    renderSidebarList();
}
```

This is the key behavioural change: the grid is sized to the unassigned count (`smallestLayoutFitting(unassignedNames.length)`) and contains only those names. Pins for grouped terminals are dropped (the `else` branch sets `pinnedPanes[i] = false`).

#### 4. Update the `clearGroupLock()` doc comment

Replace the doc comment above `clearGroupLock()` (lines 2538–2551) to reflect the new behaviour:

```js
/**
 * Drop the group lock and re-seat the grid from the unassigned live fleet.
 *
 * Formerly this only dropped the lock and repainted the sidebar, leaving
 * paneAssignments exactly as the departed group left them — the "All
 * terminals" affordance read as dead because, on screen, it was. Now it
 * performs a real seating pass from the unassigned subset (terminals not
 * claimed by any manual or derived group): pinned slots keep their occupant
 * if it is still unassigned, remaining slots fill in compareTerminals order,
 * and the layout resolves via smallestLayoutFitting (non-monotonic, so it
 * can shrink).
 *
 * The early return on `!activeGroupId` is removed: clicking "Unassigned"
 * from an already-unlocked state is a legitimate "reset my composition"
 * gesture and must do the seating pass.
 */
```

#### 5. Update the `deleteGroup` inline comment

The comment at line ~2529 says "clearGroupLock drops the lock, re-seats from the full live fleet honouring pins, and re-renders." Update to:

```js
// clearGroupLock drops the lock, re-seats from the unassigned live fleet
// honouring pins, and re-renders. It also calls saveLayoutSettings.
```

This is accurate because `deleteGroup` removes the group BEFORE calling `clearGroupLock()`, so the deleted group's formerly-grouped terminals are now unassigned and will appear in the re-seated grid — which is the correct behaviour.

### `src/test/terminal-sidebar-groupings-contract.test.js`

#### 6. Update the tab-strip contract test

The test at line 339 (`'the tab strip offers All, one tab per group, a delete on every tab, and a +'`) asserts:

```js
assert.ok(
    strip.includes("allTab.textContent = 'All'"),
    'the strip must render a leading All tab'
);
```

This assertion will break because the new construction uses `allTabName.textContent = 'Unassigned'` instead. Update the assertion to:

```js
assert.ok(
    strip.includes("allTabName.textContent = 'Unassigned'"),
    'the strip must render a leading Unassigned tab'
);
```

Also update the test name to reflect the rename:

```js
test('the tab strip offers Unassigned, one tab per group, a delete on every tab, and a +', () => {
```

The other assertions in this test (`clearGroupLock()`, `getAllGroups()`, `deleteGroup`, `onNewTerminalClicked`, etc.) remain valid — the variable name `allTab` is retained in the source, and the click handler still routes to `clearGroupLock()`.

**Clarification:** The test name and assertion text update is implied by the tab rename requirement, not a new product requirement.

## Verification Plan

### Automated Tests

> **Note:** For this improve pass, compilation and automated tests are NOT executed. The checks below remain written down for the coder to run during implementation.

1. **Run the contract test suite** — `node src/test/terminal-sidebar-groupings-contract.test.js` must pass after the test assertion update in step 6.
2. **Run the full test suite** — `npm test` (or the project's test runner) to confirm no other contract test breaks from the `clearGroupLock()` or `renderGroupTabStrip()` changes.

### Manual Verification

1. **Open the Terminals panel** with at least three terminals: one in a manual group, one claimed by an auto-derived role/worktree group, and one unassigned.
2. **Observe the leading tab.** It should read **"Unassigned"** and its badge should equal the number of terminals not in any group.
3. **Click a group tab.** The grid should show only that group's members.
4. **Click the "Unassigned" tab.** The grid should show only the unassigned terminal(s). The grouped terminals must not appear.
5. **Add a terminal to the manual group.** The "Unassigned" tab count should decrease by one and the grid should update.
6. **Delete the manual group.** The formerly grouped terminals should now be unassigned; clicking the "Unassigned" tab should display them with the smallest layout that fits the new count.
7. **Test with many unassigned terminals.** Verify the layout climbs to `2h`, `1x3`, `2x2`, etc., as needed, but never exceeds the count.
8. **Resize the window very small.** Confirm the layout floor still applies and the fallback banner appears; confirm grouped terminals still never appear in the "Unassigned" grid.
9. **Test pins.** Pin a terminal while a group is locked, then click "Unassigned". If the pinned terminal is not unassigned, the pin must be dropped and the pane left empty.
10. **No regressions.** Manual/derived group switching, paging, and add-to-group behaviour remain unchanged.
11. **Known limitation check (informational).** Click a grouped terminal in the sidebar while in "Unassigned" mode. Confirm it is seated into the grid (this is the accepted snapshot limitation, not a regression). Click the "Unassigned" tab again to confirm it re-seats to unassigned-only.

## Outstanding Questions

- **[user]** Should "Unassigned" be an enforced invariant (filter sidebar clicks to refuse grouped terminals, fix the load path to re-seat on reload), or is the snapshot behaviour (click-the-tab filters, ongoing interaction can pollute) acceptable for this iteration? — proceeding on the assumption that the snapshot behaviour is acceptable and broader enforcement is a follow-up.

## Completion Summary

Implemented renaming of the leading tab from "All" to "Unassigned" with a live count badge for unassigned terminals. Added `getUnassignedTerminalNames()` helper to enumerate terminals not claimed by manual or derived groups, and updated `clearGroupLock()` to seat only unassigned terminals while dropping pins for grouped terminals. Updated contract test in `src/test/terminal-sidebar-groupings-contract.test.js` to match the new tab name and element structure. Files changed: `src/webview/terminals.js` and `src/test/terminal-sidebar-groupings-contract.test.js`. No issues encountered.

