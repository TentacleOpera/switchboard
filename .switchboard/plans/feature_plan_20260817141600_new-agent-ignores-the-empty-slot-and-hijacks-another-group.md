# A New Agent Ignores the Empty Slot You Aimed At and Hijacks Another Group's Grid

## Goal

Adding an agent to a specific empty slot must put it **in that slot**, keep the current group locked, and make it a member of that group. It must never displace an occupied pane, never silently drop the lock, and never re-layout a different group.

### The problem

With a grid open and one slot empty, picking a role to fill it produces any of: the agent appearing in a *different* pane (evicting whatever was there), the group lock silently dropping so the tab strip now shows "All", or — for a role that heads a team — the whole view jumping to another group at that group's layout.

### Root cause — three separate defects on one path

The empty-slot click opens the picker with `onNewTerminalClicked(undefined, 'group:' + activeGroupId)` (`src/webview/terminals.js:4661`). Picking a role calls `createTerminal(role, targetSpec, …)` (`:6499`). Neither the **slot index** nor the **group** survives that hop — `targetSpec` is `undefined`, and the group is encoded only in `pickerState.key`, which is discarded at `:6497`.

`createTerminal`'s seating block (`:6606-6620`) then does one of two wrong things.

**Defect 1 — no delegates: seats into the focused pane and drops the lock.**

```js
                    if (delegates.length === 0) {
                        assignToFocusedPane(data.terminal.friendlyName);
                    }
```

`assignToFocusedPane` (`:3652-3739`) opens with:

```js
        if (activeGroupId && !opts.keepLock) {
            activeGroupId = null;
            activeGroupPage = 0;
        }
```

so the lock is gone before any seating happens. It then targets `focusedPaneIndex` — wherever the caret happened to be, which is emphatically *not* the empty slot the operator clicked. If that pane is occupied, the scan at `:3720-3739` may still find a free slot; if the grid is otherwise full, its fallbacks end in "displace the focused pane". And `addTerminalToActiveGroup` (`:2837-2850`) — the function whose docstring says it "must be called BEFORE seating so the next `seatActiveGroupPage` reconcile does not evict the addition" — is never called at all, so the new terminal is not a member of anything.

Compare `handleLockedTerminalClick` (`:2852-2889`), which gets this right for a *sidebar* click under a lock: it proves a free slot exists with `isFreeSlot`, adds the terminal to the group, then calls `assignToFocusedPane(name, { keepLock: true })`. The create path never learned that contract.

**Defect 2 — role heads a team: the view jumps to another group and re-layouts.**

```js
                    } else if (data.teamGroupId && await switchToTeamGroup(data.teamGroupId, data.terminal.friendlyName)) {
```

`switchToTeamGroup` (`:6647-6653`) calls `switchToGroup(groupId)`, which runs `setLayoutMode(layoutForGroupSwitch(group), { keepLock: true })` (`:2547`) and then `saveLayoutSettings()` (`:2550`). That rewrites `currentLayout` / `effectiveLayout` globally and **persists** it. The operator asked for one seat in one slot and got a different group locked at a different grid size — the reported "adds it randomly to another group, changing the grid layout of that other group".

Whether a role heads an auto-start team is invisible at click time unless the picker annotated it (`:6461-6481`), so the same gesture behaves completely differently depending on which role was chosen.

**Defect 3 — derived role groups reshuffle the sidebar underneath.**

With `groupPrefs.autoRoleGroups` on (`:2657`), a new terminal materialises or joins a derived `dg_role_<role>` group. Combined with defect 1's silent unlock, the terminal then appears under a group the operator never chose, with a member count and layout of its own — reinforcing the "it went somewhere random" reading even when nothing jumped on screen.

**Defect 3 gets no change of its own.** Derived role grouping is a deliberate opt-in feature; its symptom here is entirely downstream of defect 1's silent unlock. Once the lock is retained and membership is written to the group the operator was actually looking at, the terminal appears where they expect and the derived group is just another tab in the strip. Do not add suppression, a setting, or a special case for it.

### Why the slot index has to be threaded, not inferred

`focusedPaneIndex` is explicitly documented as too volatile to decide seating — *"the focused pane is where the caret happens to be (it moves every time the operator types into a pane)"* (`:3699-3701`). The operator's intent is the slot they clicked, and the only way to honour it is to carry that index from the click through the picker to the create response.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, bugfix
**Project:** Browser Switchboard

## Cross-Subtask Contract

This subtask **lands last** in the feature and consumes two things its siblings build. Do not re-implement either.

- **The pane call site belongs to `The Whole Empty Pane Is a Hidden Hotspot That Fires the Agent Picker`.** That subtask replaces the `.pane-empty-slot` hotspot with an explicit `.pane-add-agent` button and *already writes* `onNewTerminalClicked(undefined, 'group:' + (activeGroupId || '__all__'), index)`. The third argument is inert until this subtask lands. **This plan does not touch `terminals.js:4656-4663`** — it only teaches `onNewTerminalClicked` to read the argument that is already being passed. If that call site does not yet pass an index when you pick this up, the sibling has not landed; land it first rather than duplicating its edit.
- **The free-slot predicate belongs to `Switching to a Terminal Group Destroys a Pane's Kanban Mode`.** That subtask extracts `isSlotFree(i, rendered)` as the single definition of "this rendered slot can take a terminal", precisely because the rule had been copy-pasted into four paths and forgotten in two. **Call it; do not write a fifth copy.**
- That same subtask also rewrites `seatActiveGroupPage` to page by *free* slots. This plan's membership write interacts with that reconcile — see the Edge-Case audit.
- The `add agent` button exists in **both** compositions (locked and unlocked), which is what makes this plan's `__all__` case reachable from a pane at all.

## Complexity Audit (Routine vs Complex/Risky)

**Routine**

- Threading a slot index through `pickerState` — it already carries `key` and `targetSpec`.
- Calling `addTerminalToActiveGroup` before seating, which is the documented contract the sibling path already follows.

**Complex / risky**

- **`assignToFocusedPane`'s `keepLock` precondition is a hard contract.** Its comment (`:3663-3667`): *"The caller MUST guarantee a free slot exists before passing keepLock, because the displacement fallbacks below end in 'displace the focused pane', which under a lock would evict a group member to seat a non-member."* Passing `keepLock: true` without re-proving the slot is free at response time is a new eviction bug in place of the old one.
- **The slot can be taken while the create is in flight.** `createTerminal` awaits `fetch` then `fetchTerminalList()` (`:6574, 6604`) — hundreds of milliseconds during which the 5s poll, a drag-drop or a group reseat can fill the target slot. Re-validate; do not trust the captured index.
- **The team path is genuinely different.** A team spawns N terminals and one slot cannot hold them. The fix is not to suppress the group switch — it is to stop it *silently re-laying-out and persisting*, and to tell the operator what happened. `reportTeamStart` (`:6738-6755`) already exists as that channel and already handles a `seatFallbackReason`.
- **Do not add a new seating mechanism.** Three seating paths already exist (`assignToFocusedPane`, `seatActiveGroupPage`, `seatTeamWithoutGroup`). This plan routes through the first and reuses the second's contract; it must not add a fourth.

## Edge-Case & Dependency Audit

- **Picker opened from the strip `+`, not from a pane.** `renderGroupTabStrip`'s `+` uses the same `group:<id>` key (`:3044-3047`) with no slot in mind. A missing slot index falls back to today's behaviour *minus* the unlock — i.e. seat into the first free slot in the active group, still adding membership.
- **`group:__all__`.** With no lock the key is `group:__all__` (`:3044`), and the empty pane's `add agent` button uses the same sentinel. There is no group to add membership to; seat into the requested slot and leave `activeGroupId` null. `addTerminalToActiveGroup` already no-ops when the group is not found (`:2838-2839`), and the `opts.groupId` guard below makes it an explicit skip rather than an accidental one.
- **Membership is written even when no slot is free.** The create succeeded and the picker was scoped to a group, so the terminal *is* a member of that group — it simply has nowhere to sit on the current page. Writing membership regardless is what lets the operator page forward to it (the page affordance the sibling subtask's free-slot paging produces) and is what keeps the toast honest. It also removes a divergence: `isSlotFree` refuses a *pinned* empty slot while `seatActiveGroupPage` will happily seat a member into one, so a membership write gated on a successful seat would report "not seated" and then be contradicted by the next reconcile.
- **Members appended to the end land on the last page.** `addTerminalToActiveGroup` pushes to `group.members`. `seatActiveGroupPage` pages by a constant per-page count, so a free slot existing on the current page means that page is not full, which means it is the last page — the appended member reconciles back into it. Do not add page-clamping logic for this.
- **Target slot is in kanban mode.** A kanban slot is not free — this is exactly what `isSlotFree` encodes. If the captured slot has become a kanban pane, treat it as taken and fall back to the first genuinely free slot.
- **Target slot is pinned.** `assignToFocusedPane` refuses pinned slots when `rendered > 1` (`:3708-3709`); `isSlotFree` carries that term, including its `rendered <= 1` inertness. Nothing extra to do here beyond using the helper.
- **Create fails.** `createTerminal` logs and returns on `!res.ok` / `data.error` (`:6623-6626`). Membership must not be written before the create succeeds, or a failed spawn leaves a phantom member in `group.members` / `groupPrefs.extras`. All membership writes live inside the `data.success && data.terminal` branch.
- **`group.members` is whole-array-saved.** `saveLayoutSettings()` writes the entire `terminals.groups` array (`:1611`), and `reloadTerminalGroups` merges by id without modifying existing entries (`:1627-1630`). Adding a member is safe; do not reorder the array.
- **Stale picker.** `pickerOpening` / `pickerState` are superseded by a later click (`:6366-6383`). The slot index rides `pickerState` and is read into a closure at picker **build** time, so a superseded open cannot leak its index into the winning one.
- **A group switch between opening the picker and choosing a role.** The group is resolved from `pickerState.key` at build time and travels with the create call, so the membership write targets the group the picker was opened against — and the `opts.groupId === activeGroupId` guard means a switch in the interim results in *no* membership write rather than a write to the wrong group.
- **No persisted-shape change, no migration.** `pickerState` is in-memory. The only persisted writes are the existing `terminals.groups` / `groupPrefs.extras` membership writes.

## Proposed Changes

### 1. `src/webview/terminals.js` — carry the slot index through the picker

`onNewTerminalClicked` (`:6362-6389`) takes a third argument and stores it on `pickerState`:

```js
    async function onNewTerminalClicked(targetSpec, key, slotIndex) {
        …
        // slotIndex rides pickerState, not a module-level variable: a later click
        // supersedes this open (:6382), and a shared variable would leak the
        // discarded open's slot into the winning one.
        pickerState = { key: groupKey, targetSpec, slotIndex };
```

`buildRolePicker` reads it from `pickerState` directly rather than through a fourth threaded parameter:

```js
    function buildRolePicker(targetSpec) {
        // Read the scope ONCE, here, and close over it. buildRolePicker runs during a
        // render while pickerState is the current open, so the closure freezes the
        // scope at build time — a group switch or a superseded picker between now and
        // the role click cannot retarget the spawn.
        //
        // Deliberately NOT threaded through mountRolePicker: it has three call sites
        // (:3201, :3480, :3557), two of which are worktree/parent-root pickers with no
        // slot in mind, and adding a parameter to all three only creates three places
        // for the value to desync from pickerState.
        const slotIndex = pickerState ? pickerState.slotIndex : undefined;
        const pickerKey = pickerState ? String(pickerState.key || '') : '';
        const scopeGroupId = pickerKey.startsWith('group:')
            ? (pickerKey.slice('group:'.length) === '__all__' ? null : pickerKey.slice('group:'.length))
            : null;
```

Both the role handler (`:6499`) and the no-role handler (`:6516`) pass a seat-options object as a fourth argument:

```js
                createTerminal(role, targetSpec, hasCommand[role] === true, { slotIndex, groupId: scopeGroupId });
```

```js
            createTerminal(NO_ROLE, targetSpec, false, { slotIndex, groupId: scopeGroupId });
```

`createTerminal`'s signature becomes `async function createTerminal(role, targetSpec, hasStartupCommand, seatOpts)`. `seatOpts` is optional; every other caller is unaffected.

### 2. `src/webview/terminals.js` — seat where the operator asked

Replace `createTerminal`'s seating block (`:6606-6620`):

```js
                    let seatFallbackReason = null;
                    if (delegates.length === 0) {
                        seatFallbackReason = seatIntoRequestedSlot(data.terminal.friendlyName, seatOpts);
                    } else if (data.teamGroupId && await switchToTeamGroup(data.teamGroupId, data.terminal.friendlyName)) {
                        // A team is N terminals; one slot cannot hold it, so the group
                        // switch stands. What must NOT stand is doing it silently — see
                        // switchToTeamGroup for the layout-persistence change.
                    } else {
                        seatFallbackReason = data.teamGroupId ? 'its group did not load' : 'no group was registered';
                        seatTeamWithoutGroup(data.terminal.friendlyName, delegates);
                    }
```

with the new helper beside `seatTeamWithoutGroup`:

```js
    /**
     * Seat a freshly-created single terminal into the slot the operator aimed at,
     * keeping the group lock. Returns null on success, or a reason string for
     * reportTeamStart to surface.
     *
     * Replaces a bare assignToFocusedPane(name), which (a) dropped the group lock
     * unconditionally (:3668), (b) targeted focusedPaneIndex — "where the caret
     * happens to be", explicitly documented as too volatile for durable seating
     * (:3699) — and (c) never called addTerminalToActiveGroup, so the new terminal
     * was evicted by the next seatActiveGroupPage reconcile.
     *
     * Mirrors handleLockedTerminalClick's free-slot branch (:2867-2889): add
     * membership, PROVE a free slot, then seat with keepLock. assignToFocusedPane's
     * keepLock contract requires the caller to guarantee the free slot, because its
     * displacement fallbacks end in "displace the focused pane" — under a lock that
     * evicts a member to seat a non-member.
     */
    function seatIntoRequestedSlot(name, opts) {
        const rendered = Math.max(1, getSlotCount(effectiveLayout));

        // Membership FIRST, and unconditionally on a group-scoped picker — the
        // docstring on addTerminalToActiveGroup is explicit that a later reconcile
        // evicts an addition made after the fact. Written even when no slot is free:
        // the create succeeded, so the terminal IS a member with nowhere to sit, and
        // the group's page affordance is how the operator reaches it. Scoped to the
        // group the PICKER was opened against, not whatever is locked now — a switch
        // in the interim means no write rather than a write to the wrong group.
        if (opts && opts.groupId && opts.groupId === activeGroupId) {
            addTerminalToActiveGroup(name);
        }

        // Re-validate at RESPONSE time. createTerminal awaited a fetch and a
        // fetchTerminalList; the 5s poll, a drag-drop or a group reseat can have
        // filled the captured slot in between. isSlotFree is the shared predicate —
        // it already encodes "unassigned", "not a kanban pane" and "not pinned
        // (unless the grid is down to one pane)".
        let target = isSlotFree(opts && opts.slotIndex, rendered) ? opts.slotIndex : -1;
        if (target === -1) {
            for (let i = 0; i < rendered; i++) { if (isSlotFree(i, rendered)) { target = i; break; } }
        }
        if (target === -1) {
            // No free slot. Do NOT displace: the operator asked to FILL an empty
            // pane. The terminal is live, is a group member, and is reachable from
            // the sidebar and from the group's next page.
            return 'no free slot was left in the grid';
        }

        focusedPaneIndex = target;
        assignToFocusedPane(name, { keepLock: true });
        focusSeatedTerminal(name);
        return null;
    }
```

`focusedPaneIndex = target` before the call is what steers `assignToFocusedPane` — its first target choice is `isOpen(focusedPaneIndex)` (`:3712-3714`) — without adding a fourth seating mechanism.

Note `isSlotFree(opts && opts.slotIndex, rendered)`: a missing index is `undefined`, which fails the helper's range test and falls through to the scan. That is the strip-`+` path.

### 3. `src/webview/terminals.js` — stop the team switch from silently re-laying-out

`switchToTeamGroup` (`:6647-6653`):

```js
    async function switchToTeamGroup(groupId, headName) {
        await reloadTerminalGroups();
        if (!terminalGroups.some(g => g && g.id === groupId)) { return false; }
        const previousLayout = currentLayout;
        switchToGroup(groupId);
        // switchToGroup runs setLayoutMode(layoutForGroupSwitch(group)) and then
        // saveLayoutSettings(), so a role that happens to head an auto-start team
        // silently relocated the operator to another group AT ANOTHER GRID SIZE —
        // and persisted it. The switch itself is correct (a team is N terminals and
        // one slot cannot hold it); doing it without saying so is not.
        if (currentLayout !== previousLayout) {
            showPaneToast(`Started a team — switched to its group and resized the grid to ${currentLayout}.`);
        }
        focusSeatedTerminal(headName);
        return true;
    }
```

### 4. `src/webview/terminals.js` — surface the no-slot case

`reportTeamStart` (`:6738-6755`) already renders `seatFallbackReason`. Its message assumes a team; widen the one line:

```js
        if (seatFallbackReason) {
            showPaneToast(delegates.length > 0
                ? `Team seated without its group — ${seatFallbackReason}.`
                : `Terminal started but not seated — ${seatFallbackReason}. Find it in the sidebar.`);
            return;
        }
```

### 5. `src/webview/terminals.js` — annotate the team roles the operator is about to trigger

The picker already annotates auto-start roles with `starts <team> · <summary>` (`:6461-6481`). Extend the title on the **pane-originated** open only, so the surprise is pre-empted at the point of choice:

```js
                if (slotIndex !== undefined) {
                    btn.title = `${btn.title} — starts as a group, so the grid will switch to that group`;
                }
```

applied inside the existing `if (autoTeam)` branch. No new control, no new mechanism — one clause on an existing tooltip.

## Verification Plan

1. `node --test src/test/` — full suite. Five tests are red at HEAD independently; stash-verify before attributing.
2. **The reported repro.** Lock a 3-member group in `2x2` (slot 4 empty). Put the caret in slot 1. Click the empty slot's `add agent` and pick a role with **no** auto-start team. Assert: it lands in **slot 4**; slot 1 keeps its terminal; the group tab stays active (lock not dropped); the sidebar shows the new terminal as a member of that group.
3. **Membership survives a reconcile.** From the above, resize the window to trip the layout floor (forcing `seatActiveGroupPage`). Assert the new terminal is still seated and still a member — the eviction the missing `addTerminalToActiveGroup` used to cause.
4. **Team role.** Add an agent for a role that heads an auto-start team. Assert the grid switches to the team's group **and** a toast names the switch and the new layout. Assert no *other* group's stored layout changed (inspect `terminals.groupPrefs.layouts` and each manual group's `.layout` before and after). Assert the pane-originated picker showed the extra tooltip clause on that role, and that the strip `+` picker did **not**.
5. **Slot taken mid-flight.** Aim at slot 4, and while the create is in flight drag a sidebar terminal into slot 4. Assert the new terminal takes another free slot and nothing is displaced.
6. **No free slot.** Fill every pane, then trigger the create. Assert nothing is displaced, the lock holds, a toast says the terminal started but was not seated — and that it **is** a member of the group and reachable by paging forward.
7. **Kanban slot is not a seat.** Put slot 4 in kanban mode and aim at slot 3. Assert the terminal lands in slot 3 and the kanban pane is untouched. Then with slot 3 full, aim at slot 4 — assert it is treated as taken and the board column survives.
8. **Pinned slot.** Pin an empty slot and aim at it. Assert it is refused and the terminal goes elsewhere. Then drop the grid to a single pane (`isSlotFree`'s `rendered <= 1` inertness) and assert a pinned lone pane is still seatable.
9. **Strip `+` unchanged.** Open the picker from the tab strip's `+` and pick a role. Assert today's behaviour, except the lock is retained and membership is written.
10. **`__all__` scope.** With no group locked, click a pane's `add agent`. Assert it seats in the aimed slot, `activeGroupId` stays null, and no membership write occurs (`terminals.groups` and `groupPrefs.extras` unchanged).
11. **Group switched mid-picker.** Open the picker from a pane under group A, switch to group B, then pick a role. Assert no member is added to either group and the terminal seats without dropping B's lock.
12. **Failed create.** Point the panel at a role whose CLI is missing so the create fails. Assert no phantom member appears in `terminals.groups` or `groupPrefs.extras`.
13. **Both worktree pickers still work.** Open the role picker from a worktree row and from a parent-root row (`mountRolePicker` at `:3480` and `:3557`). Assert the `targetSpec` still reaches `createTerminal` and the terminal spawns in the right cwd — the paths that would break if the slot index had been threaded through `mountRolePicker`.
