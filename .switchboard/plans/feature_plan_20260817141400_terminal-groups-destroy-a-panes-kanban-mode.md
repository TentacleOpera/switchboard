# Switching to a Terminal Group Destroys a Pane's Kanban Mode

## Goal

Kanban mode must be a property of the group's composition, not a global that the next group switch overwrites. Put a pane in kanban mode inside a group, switch away, switch back — the column viewer must still be there, on the same column, workspace and project.

### The problem

Set slot 2 to kanban mode showing `PLAN REVIEWED`. Click another group tab, then click back. Slot 2 is a terminal. The column choice, the workspace and the project filter are gone, and the only way back is to unassign the slot and re-toggle.

### Root cause — two independent defects that compose

**1. Group seating does not skip kanban slots.**

`seatActiveGroupPage()` (`src/webview/terminals.js:2561-2582`) fills slots from index 0 with no regard for pane mode:

```js
const assignments = members.slice(start, start + rendered);
while (assignments.length < getMaxSlotCount()) { assignments.push(null); }
paneAssignments = assignments;
```

Every other seating path in the file deliberately excludes kanban panes:

- `handleLockedTerminalClick`'s free-slot test: `isFreeSlot = (i) => !paneAssignments[i] && paneModes[i] !== 'kanban' && …` (`:2883`)
- `assignToFocusedPane`'s free test: `isFree = (i) => !paneAssignments[i] && paneModes[i] !== 'kanban'` (`:3719`), with a documented "a kanban-mode slot is unassigned but occupied by a live board column, so it is not a free seat" (`:3715-3718`)
- `seatTeamWithoutGroup`'s scan: `while (slot < rendered && (next[slot] || pinnedPanes[slot] || paneModes[slot] === 'kanban')) { slot++; }` (`:6711`)
- `fillEmptyPanes`'s fill test: `if (!paneAssignments[i] && paneModes[i] !== 'kanban')` (`:7076`), with its own copy of the same comment
- `clearGroupLock` — also does not skip them (`:2464-2473`), same defect on the "All" tab.

`seatActiveGroupPage` and `clearGroupLock` are the two that were missed. **The invariant is already written down as fact where it matters most**: the erasure rule's own comment at `:4730-4736` opens *"The seating paths skip kanban slots, so this is the deliberate all-panes-taken displacement"* — a claim that is false for exactly these two paths, which is why the rule below it fires on an ordinary group switch.

**The deeper cause is that the predicate is copy-pasted, not shared.** There are five hand-written copies of "a slot with no assignment but a kanban mode is not free" (`:2883`, `:3719`, `:6711`, `:7076`, plus the prose at `:4730`). Two sites were simply forgotten. Adding a sixth and seventh copy — which this feature would otherwise do, once here and once in the slot-index subtask — re-arms the identical bug for the next path anyone adds. One shared predicate is part of the fix, not a tidy-up.

**2. The mode is then actively deleted, not merely covered.**

`updatePaneElement` (`:4729-4731`):

```js
if (paneModes[index] === 'kanban' && assignedName) {
    paneModes[index] = 'terminal';
}
```

That rule is correct for its stated cases — "the deliberate all-panes-taken displacement (or a persisted mode meeting a restored assignment)" — but it fires on a group switch too. So the switch does not just hide the kanban pane; it *erases* the mode. `switchToGroup` then calls `saveLayoutSettings()` (`:2549-2551`), which persists the erasure to `terminals.paneModes`. Switching back cannot restore it because there is nothing left to restore.

**3. Even with (1) and (2) fixed, the state is global.**

`paneModes`, `kanbanPaneColumn`, `kanbanPaneWorkspace` and `kanbanPaneProject` are single flat arrays (`:26, 36, 42, 46`), saved as four flat settings (`:1607-1610`). They are index-aligned to the grid, not to a group. So a kanban pane set up under group A would leak into group B at the same index — a different bug wearing the same clothes. The state has to be keyed by group.

`groupPrefs` is the shipped home for exactly this: it already holds per-group `layouts`, `orders`, `extras`, `pinned` and `hidden` (`:116`), is loaded with per-key validation (`:1544-1573`) and saved whole (`:1613`).

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, bugfix
**Project:** Browser Switchboard

## Cross-Subtask Contract

- This subtask **owns the shared free-slot predicate** it introduces (`isSlotFree`). The *slot-index* sibling subtask (`A New Agent Ignores the Empty Slot You Aimed At`) calls it instead of writing a sixth copy, so **this subtask must land before it**.
- This subtask edits the `.pane-mode-toggle` branch of the delegated `.pane-content` handler (`:4664-4672`). The **empty-pane hotspot** subtask owns the branch immediately *above* it (`:4656-4663`) and lands first; do not rewrite that branch here.
- The **picker width** subtask edits `renderKanbanPane`'s always-runs tail (`:5382-5384`); this subtask adds `captureKanbanPanesFor` calls inside the two picker `change` handlers in the same function (`:5340-5352`, `:5370-5378`). Different statements, no conflict.
- `switchToTeamGroup` (`:6647-6653`) calls `switchToGroup`, so a team auto-start inherits capture-and-restore from this subtask. That is correct — and it means the slot-index subtask's team path must be verified against the restore behaviour landed here.

## Complexity Audit (Routine vs Complex/Risky)

**Routine**

- Teaching `seatActiveGroupPage` and `clearGroupLock` the `paneModes[i] !== 'kanban'` skip that four other seating paths already apply.
- Adding a `kanbanPanes` map to `groupPrefs` with the same load-time validation shape as `layouts` and `extras`.

**Complex / risky**

- **Slot count vs member count.** Skipping kanban slots reduces the seats available to a group's page. `seatActiveGroupPage` computes `pageCount` from `rendered` (`:2565-2566`); if kanban panes consume seats, the paging arithmetic must use the *free* count or the last member of each page silently disappears.
- **The erasure rule at `:4729` must stay, and must keep BOTH of its cases.** It is the only thing preventing a persisted mode from stranding a terminal behind a board view. Its comment names two producers — a genuine displacement *and* "a persisted mode meeting a restored assignment" on load, where `terminals.paneModes` and `terminals.paneAssignments` both restore and can disagree. Narrow the *prose* to reflect that the group-seating paths no longer produce it; do **not** delete the rule and do **not** drop the load-time case from the comment.
- **No snapshot writes from a render path.** `updatePaneElement` runs on every reconcile including the 5s poll. The capture is strictly event-driven — see the Edge-Case audit; the erasure rule specifically must **not** call it.
- **`groupPrefs` is shipped state on ~4 000 installs.** The loader rebuilds the object from a whitelist (`:1563-1572`); an unvalidated new key is dropped on the next save. The new key must be added to that literal **and** to the module-level default at `:116` (the loader only reassigns `groupPrefs` when a stored value exists), and an install with no stored value must load to `{}` and behave exactly as today.
- **Restore ordering.** `switchToGroup` runs `setLayoutMode(...)` then `seatActiveGroupPage()` then `saveLayoutSettings()` (`:2547-2551`). The per-group kanban state must be restored **before** `seatActiveGroupPage` (so the skip has something to skip) and the *outgoing* group's state must be captured **before** `activeGroupId` is reassigned (`:2537`) — otherwise the capture writes to the wrong group.
- **`clearGroupLock` is a full re-seat, not a page fill.** It rebuilds `assignments` from the entire live fleet, honours pins, and then *resets the layout* via `smallestLayoutFitting(liveNames.length)` (`:2478-2481`). The restore must run before both the pinned-occupant loop and the fill loop, and the kanban skip belongs in the fill loop's `fillIdx` advance.

## Edge-Case & Dependency Audit

- **No group locked (`activeGroupId === null`).** The "All" composition is a real composition. Key its kanban state under the same `__all__` sentinel the picker already uses (`:3044`), so `clearGroupLock` restores it too.
- **Solo mode.** `updatePaneElement` suppresses kanban mode in solo and is documented as never writing it back (`:4709-4713`) precisely to avoid clobbering the cockpit's choice. The capture must inherit that: never capture while `document.body.classList.contains('is-solo')`.
- **Layout shrink.** `renderPaneGrid` pads `paneModes` to `getMaxSlotCount()` and never trims (`:4069-4075`) so a kanban slot survives a shrink-grow round trip. Per-group snapshots must store the full `getMaxSlotCount()` length, not `getSlotCount(effectiveLayout)`.
- **Group deleted while it owns kanban state.** `deleteGroup` prunes `groupPrefs.orders[id]` and `groupPrefs.pinned` for manual groups (`:2399-2405`). Prune `groupPrefs.kanbanPanes[kanbanScopeKey(id)]` in the same block. Derived groups are *suppressed*, not destroyed (`:2406-2411`) — leave their entry, exactly as orders/pinned are left.
- **Group grows past its page.** A member added to a locked group (`addTerminalToActiveGroup`, `:2837-2850`) may need a slot a kanban pane holds. Correct behaviour is the same as everywhere else: the kanban pane is not free, the member goes to the next free slot or the next page. It must **not** displace the board view.
- **Every group full of kanban panes.** If a page has zero free slots, seat nothing and leave the members unseated rather than displacing. The banner/page affordance is the existing honest channel; do not add a toast.
- **A pin on a kanban slot.** `seatActiveGroupPage`'s tail clears any pin on a slot with no assignment (`:2577-2580`), and a kanban slot has none — so a pinned kanban pane loses its pin on the next reseat. That is pre-existing behaviour and is **out of scope**; do not "fix" it here. The relevant point for this plan is that the pin loop must keep running unchanged after the new seating, because it is what enforces `pinnedPanes[i] → paneAssignments[i]`.
- **The 5s fleet poll.** `renderPaneGrid` runs constantly. The capture must be event-driven — on group switch, on `clearGroupLock`, on the kanban toggle, on either picker change — and **never** inside a render path. This is why the erasure rule at `:4729` does not call it: `updatePaneElement` is a render path, and on load it runs before any group scope is meaningful, so a capture there would snapshot a half-restored grid onto whatever group happens to be active. The erasure mutates the live array only; the next event-driven capture (the switch that carries the operator away) records it.
- **`terminals.kanbanPaneColumn` and friends stay.** They remain the live, index-aligned working arrays and the load-time source of truth. The per-group map is a snapshot store layered on top — do not replace the flat settings.
- **Back-compat on the FIRST composition switch.** An existing install loads its kanban pane from the flat settings, and `groupPrefs.kanbanPanes` is empty. Without a seed, the operator's very first click on another group tab (or on **All**) would capture correctly but then restore an absent snapshot — losing the pane they had before the upgrade. Seed the active scope once at load time (see Proposed Change 2a); it is an in-memory write persisted by the next ordinary save, and it makes the first round trip lossless.
- **Migration.** `groupPrefs` shipped; the new sub-key is additive and absent-means-none. No rewrite of stored data, no `.migrated.bak`.

## Proposed Changes

### 1. `src/webview/terminals.js` — declare the per-group store

At `:116`:

```js
    let groupPrefs = { threshold: 2, hidden: [], pinned: [], orders: {}, layouts: {}, extras: {}, autoRoleGroups: false,
        // Per-group kanban pane snapshots, keyed by kanbanScopeKey ('group:__all__'
        // for the unlocked composition). Shape: { modes: string[], columns: (string|undefined)[],
        // workspaces: (string|undefined)[], projects: string[] } — all padded to
        // getMaxSlotCount(). The flat terminals.paneModes/kanbanPane* settings remain
        // the LIVE arrays; this is the snapshot store the group switch reads and writes.
        // Declared here as well as in the loader's whitelist: the loader only reassigns
        // groupPrefs when a stored value exists, so an install with none needs the default.
        kanbanPanes: {} };
```

Validate on load, inside the whitelist literal at `:1563-1572`:

```js
            // Absent or malformed reads as {} — an install with no stored value
            // behaves exactly as it does today.
            const savedKanbanPanes = (savedGroupPrefs.kanbanPanes && typeof savedGroupPrefs.kanbanPanes === 'object')
                ? Object.fromEntries(
                    Object.entries(savedGroupPrefs.kanbanPanes)
                        .filter(([_, v]) => v && Array.isArray(v.modes))
                        .map(([k, v]) => [k, {
                            modes: v.modes.map(m => m === 'kanban' ? 'kanban' : 'terminal'),
                            columns: Array.isArray(v.columns) ? v.columns : [],
                            workspaces: Array.isArray(v.workspaces) ? v.workspaces : [],
                            projects: Array.isArray(v.projects) ? v.projects.map(p => String(p || '')) : [],
                        }])
                )
                : {};
```

and add `kanbanPanes: savedKanbanPanes,` to the assigned object.

### 2. `src/webview/terminals.js` — capture / restore helpers

```js
    /** Group-scope key for kanban pane state. The unlocked composition is a real
     *  composition and keys under the same '__all__' sentinel the picker uses. */
    function kanbanScopeKey(groupId) { return 'group:' + (groupId || '__all__'); }

    /** Snapshot the live kanban arrays against a group. NEVER called from a render
     *  path (the 5s poll re-renders constantly) and never in solo mode, where
     *  updatePaneElement deliberately suppresses kanban mode and must not write back. */
    function captureKanbanPanesFor(groupId) {
        if (document.body.classList.contains('is-solo')) { return; }
        const max = getMaxSlotCount();
        if (!groupPrefs.kanbanPanes) { groupPrefs.kanbanPanes = {}; }
        groupPrefs.kanbanPanes[kanbanScopeKey(groupId)] = {
            // Full max length, not the rendered count: renderPaneGrid pads and never
            // trims so a kanban slot survives a shrink-grow round trip.
            modes: Array.from({ length: max }, (_, i) => paneModes[i] === 'kanban' ? 'kanban' : 'terminal'),
            columns: Array.from({ length: max }, (_, i) => kanbanPaneColumn[i]),
            workspaces: Array.from({ length: max }, (_, i) => kanbanPaneWorkspace[i]),
            projects: Array.from({ length: max }, (_, i) => kanbanPaneProject[i] || ''),
        };
    }

    /** Restore a group's snapshot into the live arrays. A group with no snapshot
     *  gets a clean terminal-only grid — NOT the previous group's panes, which is
     *  the leak the flat arrays produce today. */
    function restoreKanbanPanesFor(groupId) {
        const max = getMaxSlotCount();
        const snap = groupPrefs.kanbanPanes && groupPrefs.kanbanPanes[kanbanScopeKey(groupId)];
        for (let i = 0; i < max; i++) {
            paneModes[i] = snap && snap.modes[i] === 'kanban' ? 'kanban' : 'terminal';
            kanbanPaneColumn[i] = snap ? snap.columns[i] : undefined;
            kanbanPaneWorkspace[i] = snap ? snap.workspaces[i] : undefined;
            kanbanPaneProject[i] = snap ? (snap.projects[i] || '') : '';
        }
        kanbanPaneCards = {};
        kanbanPaneProjectsCache = {};
    }
```

### 2a. `src/webview/terminals.js` — seed the active scope once, at load

At the end of the settings load (after `paneModes` / `kanbanPane*` are restored from the flat settings and `activeGroupId` is known, `:1595-1600`):

```js
        // Seed the currently-active scope from the flat settings if it has no snapshot
        // yet. Without this, an install upgrading into this change loses its existing
        // kanban pane on the FIRST switch to another composition: the capture is
        // correct, but the return trip restores an absent snapshot. Absent-only, so it
        // never overwrites a real snapshot, and captureKanbanPanesFor's solo guard applies.
        if (!groupPrefs.kanbanPanes || !groupPrefs.kanbanPanes[kanbanScopeKey(activeGroupId)]) {
            captureKanbanPanesFor(activeGroupId);
        }
```

### 3. `src/webview/terminals.js` — one shared free-slot predicate, then seat around kanban panes

Declare it once, near the other slot helpers (beside `getSlotCount` / `getMaxSlotCount`, `:1400-1407`):

```js
    /**
     * The one definition of "this rendered slot can take a terminal".
     *
     * A kanban-mode slot is unassigned but occupied by a live board column, so it is
     * NOT a free seat. That rule was hand-copied into four separate seating paths
     * (handleLockedTerminalClick, assignToFocusedPane, seatTeamWithoutGroup,
     * fillEmptyPanes) and FORGOTTEN in two more (seatActiveGroupPage, clearGroupLock)
     * — which is the whole reason a group switch bulldozed a kanban pane. New seating
     * paths call this instead of writing a fifth copy.
     *
     * Pins are inert in a one-pane grid: LAYOUTS['1'] is the last rung of
     * LAYOUT_FLOOR_ORDER, so a narrow window can involuntarily drop a pinned 2h layout
     * to a single pane, and honouring the pin there makes every seat a dead click.
     * This mirrors assignToFocusedPane's `pinsActive` exactly (:3707-3710).
     */
    function isSlotFree(i, rendered) {
        if (i < 0 || i >= rendered) { return false; }
        if (paneAssignments[i]) { return false; }
        if (paneModes[i] === 'kanban') { return false; }
        return rendered <= 1 || !pinnedPanes[i];
    }
```

Convert the one existing site whose predicate is **byte-identical** — `handleLockedTerminalClick` (`:2882-2883`):

```js
        const isFreeSlot = (i) => isSlotFree(i, rendered);
```

Deliberately **not** converted, because their predicates are not the same expression and changing them is a behaviour change outside this plan's scope:
- `assignToFocusedPane` (`:3707-3733`) splits the test into `isOpen` / `isFree` and re-uses each half in three separate fallback cascades, including one that prefers displacing a terminal pane over a kanban pane.
- `seatTeamWithoutGroup` (`:6711`) tests a local `next` array, not `paneAssignments`.
- `fillEmptyPanes` (`:7076`) omits the pin term (its pinned slots are occupied by construction).

Add a one-line `// see isSlotFree` pointer comment at each of those three so the next reader finds the canonical rule.

Then in `seatActiveGroupPage` (`:2561-2582`), replace the slice-into-slot-0 seating:

```js
        const rendered = Math.max(1, getSlotCount(effectiveLayout));
        // Paging must count FREE slots, or the last member of each page silently
        // vanishes when a kanban pane is open.
        const freeSlots = [];
        for (let i = 0; i < rendered; i++) {
            if (paneModes[i] !== 'kanban') { freeSlots.push(i); }
        }
        const perPage = Math.max(1, freeSlots.length);
        const pageCount = Math.max(1, Math.ceil(members.length / perPage));
        if (activeGroupPage >= pageCount) { activeGroupPage = pageCount - 1; }
        if (activeGroupPage < 0) { activeGroupPage = 0; }
        const page = members.slice(activeGroupPage * perPage, activeGroupPage * perPage + perPage);
        const assignments = new Array(getMaxSlotCount()).fill(null);
        page.forEach((name, n) => { if (freeSlots[n] !== undefined) { assignments[freeSlots[n]] = name; } });
        paneAssignments = assignments;
```

Note the predicate here is deliberately **only** the kanban term, not `isSlotFree`: a group reseat *rebuilds* `paneAssignments` from scratch, so "already assigned" is meaningless, and it may legitimately seat a member into a pinned slot (the pin loop in the existing tail then reconciles). Keep that tail loop unchanged.

Apply the kanban skip in `clearGroupLock`'s fill loop (`:2464-2473`): advance `fillIdx` past any slot where `paneModes[fillIdx] === 'kanban'` as well as any already-assigned slot.

```js
            while (fillIdx < maxSlots && (assignments[fillIdx] !== null || paneModes[fillIdx] === 'kanban')) { fillIdx++; }
```

### 4. `src/webview/terminals.js` — hook capture/restore into the switches

`switchToGroup` (`:2519-2553`), immediately after `if (!group) { return; }` and **before** `activeGroupId = id`:

```js
        // Capture against the OUTGOING scope — after the reassignment below this
        // would write the departing group's panes onto the arriving one.
        captureKanbanPanesFor(activeGroupId);
        const sameGroup = activeGroupId === id;
        activeGroupId = id;
        // Restore BEFORE seatActiveGroupPage, so the seating skip has something to skip.
        restoreKanbanPanesFor(id);
```

`clearGroupLock` (`:2440-2491`), at the top — **before** the pinned-occupant loop and the fill loop, both of which read `paneModes`:

```js
        captureKanbanPanesFor(activeGroupId);
        activeGroupId = null;
        activeGroupPage = 0;
        restoreKanbanPanesFor(null);
```

and in the kanban-toggle branch of the delegated handler (`:4664-4672`), after the mode is set:

```js
            paneModes[index] = 'kanban';
            clearPaneSelection(index);
            if (!kanbanPaneColumn[index]) { kanbanPaneColumn[index] = 'CREATED'; }
            if (!kanbanPaneWorkspace[index]) { kanbanPaneWorkspace[index] = defaultKanbanWorkspace(); }
            captureKanbanPanesFor(activeGroupId);
            saveLayoutSettings();
```

Add the same `captureKanbanPanesFor(activeGroupId)` line to the combined workspace/project picker's change handler (`:5340-5352`), the column picker's change handler (`:5370-5378`), and wherever a pane is toggled back out of kanban mode.

### 5. `src/webview/terminals.js` — narrow the erasure rule's prose, not its behaviour

At `:4729-4736`. The rule is unchanged; only its comment is corrected, and it deliberately does **not** capture:

```js
        // A terminal reached a slot still marked kanban. Two producers remain, both
        // legitimate: the deliberate all-panes-taken displacement, and a persisted mode
        // meeting a restored assignment at load (terminals.paneModes and
        // terminals.paneAssignments are separate settings and can disagree). The
        // group-seating paths no longer produce it — seatActiveGroupPage and
        // clearGroupLock skip kanban slots (see isSlotFree).
        //
        // NO captureKanbanPanesFor here: updatePaneElement is a render path and runs on
        // every 5s poll tick, and at load it runs before any group scope is meaningful.
        // Snapshotting from here would write a half-restored grid onto whatever group is
        // active. The mutation below is to the LIVE array; the next event-driven capture
        // (the switch that carries the operator away) records it, which is what makes a
        // genuine displacement stick across a round trip.
        if (paneModes[index] === 'kanban' && assignedName) {
            paneModes[index] = 'terminal';
        }
```

### 6. `src/webview/terminals.js` — prune on delete

In `deleteGroup`'s manual branch (`:2399-2405`), beside the `orders` / `pinned` prune:

```js
            if (groupPrefs.kanbanPanes) { delete groupPrefs.kanbanPanes[kanbanScopeKey(id)]; }
```

Derived groups are suppressed rather than destroyed — leave their entry, exactly as `orders` and `pinned` are left.

## Verification Plan

1. `node --test src/test/` — full suite. Five tests are red at HEAD independently; stash-verify before attributing.
2. **The reported repro.** Group A (2 members) locked, layout `2x2`. Toggle slot 3 to kanban mode, pick `PLAN REVIEWED`, pick a non-default workspace/project. Switch to group B. Switch back to A. Assert slot 3 is kanban mode, on `PLAN REVIEWED`, with the same workspace and project.
3. **No leak.** From the above, switch to group B (which never had a kanban pane). Assert **no** slot in B is in kanban mode.
4. **"All" tab.** Toggle a kanban pane with no group locked, switch to a group, click **All**. Assert the pane returns, and that `clearGroupLock`'s re-seat filled *around* it rather than into it.
5. **Seating skip.** Lock a 4-member group in `2x2` with slot 2 in kanban mode. Assert only 3 members seat, a page affordance appears, and the kanban pane is untouched. Page forward — assert the 4th member takes a *terminal* slot, never slot 2.
6. **Displacement still erases.** Fill every non-kanban slot, then click a sidebar terminal to force a displacing seat onto the kanban pane. Assert the mode drops, and that it does **not** come back after switching away and back — proof that the switch-time capture recorded the erasure without the render path writing snapshots.
7. **Persistence.** Reload the panel. Assert every group's kanban state comes back, and confirm `terminals.groupPrefs` in the DB contains a `kanbanPanes` object.
8. **Back-compat, no stored key.** With a `terminals.groupPrefs` value saved *before* this change (no `kanbanPanes` key) and a kanban pane live in the flat settings, load the panel. Assert the pane is present, then switch to another group and back — assert the pane returns (the load-time seed). Then confirm an install with no kanban pane at all renders terminal-only and takes its first toggle+switch round trip correctly.
9. **Solo.** Pop a terminal out to solo and back. Assert no group's kanban snapshot was overwritten.
10. **Poll stability.** Leave a kanban pane open for ≥30s under a lock. Assert the column picker does not reset and that **zero** snapshot writes occur on poll ticks — instrument `captureKanbanPanesFor` with a temporary counter and assert it stays at 0 across six ticks.
11. **Group delete.** Delete a manual group that owns a snapshot; assert its `kanbanPanes` entry is gone. Delete (suppress) a derived group that owns one; assert its entry survives, then unsuppress it and assert the pane returns.
12. **Predicate consolidation.** Confirm `handleLockedTerminalClick` still refuses to seat a non-member into a pinned or kanban slot, in a multi-pane grid *and* in a single-pane grid (where pins are inert) — the `rendered <= 1` term in `isSlotFree`.
13. **Team auto-start round trip.** With a kanban pane open under a locked group, start a role that heads an auto-start team (so `switchToTeamGroup` → `switchToGroup` runs). Assert the team's group seats normally, then switch back to the original group and assert its kanban pane returns with its column, workspace and project.
