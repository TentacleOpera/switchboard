# The Group Tab's × Deletes the Group Label and Leaves Every Terminal Running

## Goal

Make the `×` on a group tab in the Terminals panel's tab strip do what its position and
its label promise: **end the group's terminals and remove the group in one click**. After
this change, finishing a nine-terminal planning run is one gesture — click the `×` on the
group tab — not one click on the tab plus nine clicks in the sidebar.

### The problem

The tab strip at the top of `terminals.html` renders one tab per group, each carrying a
`×`. Clicking it removes the *group record* and leaves every member terminal alive,
seated, and consuming a WebGL context. There is no affordance anywhere that closes a set
of terminals together, so the only way to finish a batch is to close each terminal
individually from the sidebar row's own `×`. For a 9-terminal planning group that is ten
clicks to end one run, and the first of those ten produces no visible change to the fleet
at all — the group vanishes and every terminal is still there.

### Root cause

`renderGroupTabStrip()` in `src/webview/terminals.js` builds the per-tab delete button and
wires it straight to `deleteGroup(g.id)`:

```js
const delBtn = document.createElement('button');
delBtn.className = 'group-tab-delete';
delBtn.textContent = '×';
delBtn.title = 'Delete this group';
delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteGroup(g.id);
});
```

`deleteGroup(id)` is a pure *bookkeeping* verb. Its entire body operates on
`terminalGroups`, `groupPrefs.orders`, `groupPrefs.pinned` and `groupPrefs.hidden`:

- `source === 'manual'` → splice the record out of `terminalGroups`, prune its ordering
  and pin.
- derived (`role` / `worktree`) → push the id onto `groupPrefs.hidden` (suppress, do not
  destroy — the group is *computed* from the live fleet, so it would reappear on the next
  poll otherwise).

Then it calls `clearGroupLock()` (re-seats the grid from the full live fleet) or
`saveLayoutSettings() + renderSidebarList()`. **`closeTerminal` is never reached from this
path.** The only call site of `closeTerminal(name)` is the per-row `×` built in
`renderTerminalRow` (`item-close-btn`, titled "Close terminal (ends the process)").

So the two `×` glyphs in this panel mean two different things — "forget this label" on a
tab, "end this process" on a row — with nothing on screen distinguishing them. The tab's
own tooltip ("Delete this group") is what makes it read as destructive when it is not.

### Background context

`getGroupMembers(group)` already resolves the exact set to close, for all three group
sources, filtered to live terminals:

- `manual` → `group.order` (or `group.members`) filtered by liveness.
- `role` → every live, non-child terminal whose `role` matches `group.value`.
- `worktree` → every live, non-child terminal whose `worktreePath` matches.

`closeTerminal(name)` is already idempotent and self-cleaning: it POSTs
`/terminals/verb/ptyCloseTerminal`, destroys the view, nulls the terminal's pane slots,
drops its badge/gap state, saves layout settings and refetches the fleet list. Closing N
terminals is therefore N awaited calls plus one group removal — no new backend verb, no
new endpoint.

**No confirmation dialog.** Per this repo's standing rule, delete buttons execute
immediately; `window.confirm()` is also a silent no-op in a VS Code webview, so a gate
here would make the button do literally nothing in one of the two hosts. The tab's `×` is
a 14px target inside a tab that is otherwise a click-to-switch surface, which is the
deliberate misclick protection.

**The non-destructive verb must survive.** Suppressing a derived group without killing
its terminals is a real, separate need (it is what `groupPrefs.hidden` exists for, and the
overflow `»` menu already carries a "restore all" entry for it). That verb moves to an
explicit **Hide** entry in the overflow menu rather than being deleted along with the
current `×` behaviour.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## Complexity Audit

**Routine.**

- One webview file, one function rewritten (`deleteGroup`), one new helper
  (`closeGroupTerminals`), one call-site retarget, one new overflow-menu entry.
- No backend change, no new verb, no schema change, no persisted-state shape change.
  `groupPrefs.hidden` keeps its existing meaning and its existing writers/readers.
- The set-resolution (`getGroupMembers`) and the per-terminal close (`closeTerminal`) both
  already exist and are already correct in isolation.

**Risky edge — called out, not deferred:** the new `×` is genuinely destructive on a
*derived* tab. Clicking `×` on the `Coders` tab now ends every coder terminal in the
fleet, which is what "close group" means and what the operator asked for. The mitigation
is honest labelling (the tooltip and aria-label state the count), not a gate.

## Edge-Case & Dependency Audit

1. **Derived group tab (`Coders`, `Planners`, a worktree basename).** Members are computed
   from the live fleet. Closing them empties the group by construction, so the derived
   group stops materialising on the next `getDerivedGroups()` pass (its member count drops
   below `groupPrefs.threshold`). The `groupPrefs.hidden` push is therefore **not** needed
   on the close path and must not happen — a hidden id would suppress the group later,
   when new terminals of that role are opened. This is the one behavioural difference
   between the two verbs and the reason `deleteGroup` splits rather than gains a flag.

2. **Manual group.** The record must still be spliced out of `terminalGroups` and its
   `groupPrefs.orders[id]` / `groupPrefs.pinned` entries pruned — a manual group with zero
   live members would otherwise persist as an empty tab forever.

3. **A member is seated in a pinned pane.** `closeTerminal` nulls `paneAssignments[i]` but
   does not clear `pinnedPanes[i]`. An empty pinned slot reserves a seat nothing can fill.
   The close loop must clear the pin for every slot it empties, matching the invariant
   `sanitizePaneAssignments` and the `unassignBtn` handler already enforce.

4. **The closed group is the locked group.** `activeGroupId === id` → route through
   `clearGroupLock()` after the closes complete, so the grid re-seats from the surviving
   fleet instead of stranding nine dead panes. `clearGroupLock` already calls
   `saveLayoutSettings` and `renderSidebarList`, so no second save is needed on that arm.

5. **A member is a delegate child (`parentInstanceId` set).** `getGroupMembers`'s `manual`
   arm is liveness-only and *does* include children (deliberately — a team registers head
   + children explicitly). Closing a head without its children would orphan them, so
   closing the whole membership list as resolved is correct. Do **not** re-add a parentage
   filter here.

6. **A member is already exited.** `closeTerminal` POSTs against a dead name; the verb is a
   no-op server-side and the client-side cleanup (`destroyTerminalView`, badge/gap drop)
   still runs, which is desirable — an exited row disappears instead of lingering.

7. **Concurrency.** `closeTerminal` ends with `await fetchTerminalList()`. Running nine of
   them in parallel fires nine list fetches and nine `renderPaneGrid()` passes, each of
   which re-parents every live xterm. Close **sequentially** and refetch **once** at the
   end: extract the per-terminal work into a variant that skips the refetch, then call
   `fetchTerminalList()` once after the loop.

8. **The `+` picker is open on the group being closed.** `renderGroupTabStrip` already
   guards this: the picker only mounts if `getAllGroups()` still contains the id, and
   `pickerState` is garbage-collected when it does not. No new handling needed.

9. **A pop-out window (`?solo=<name>`) is showing a member.** Closing the terminal makes
   `checkSoloNotFound` in that window report `Terminal "<name>" not found`, which is the
   correct and already-implemented behaviour for a terminal that ends.

10. **Empty group.** `getGroupMembers` returns `[]`; the close loop is a no-op and the
    group removal still runs. The button must not become inert on an empty group.

## Proposed Changes

### 1. `src/webview/terminals.js` — split `closeTerminal` so a batch can share one refetch

`closeTerminal(name)` currently ends in `await fetchTerminalList()`. Extract the body into
a private `closeTerminalInner(name)` that does everything **except** the refetch, and keep
`closeTerminal` as the single-terminal wrapper so every existing call site is unchanged.

```js
    /** Close one terminal and drop all client-side state keyed on its name.
     *  Does NOT refetch the fleet list — callers closing a batch share one refetch. */
    async function closeTerminalInner(name) {
        try {
            await fetch('/terminals/verb/ptyCloseTerminal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
        } catch (err) {
            console.error('[Terminals] Failed to close terminal:', err);
            return false;
        }
        destroyTerminalView(name);
        for (let i = 0; i < paneAssignments.length; i++) {
            if (paneAssignments[i] === name) {
                paneAssignments[i] = null;
                // An empty PINNED slot reserves a seat nothing can fill — the same
                // invariant sanitizePaneAssignments and the unassign handler enforce.
                pinnedPanes[i] = false;
            }
        }
        if (activeTerminalName === name) { activeTerminalName = null; }
        dismissStartupCurtain(name);
        terminalBadges.delete(name);
        terminalReplayGaps.delete(name);
        return true;
    }

    async function closeTerminal(name) {
        await closeTerminalInner(name);
        saveLayoutSettings();
        await fetchTerminalList();
    }
```

> The `pinnedPanes[i] = false` line is new and applies to the single-terminal path too.
> Closing a pinned terminal from the sidebar row previously left the pin set on an empty
> slot until the next `sanitizePaneAssignments` poll.

### 2. `src/webview/terminals.js` — new `closeGroup(id)`, and retarget the tab `×`

`deleteGroup` keeps its current body verbatim and becomes the *hide/forget* verb only. A
new sibling closes the processes:

```js
    /**
     * Close every live member of a group, then remove the group.
     *
     * The destructive counterpart to deleteGroup(): that verb only forgets a label,
     * which is why the tab's × read as a dead click on a nine-terminal planning run.
     * No confirm gate — deletes execute immediately in this codebase, and
     * window.confirm() is a silent no-op inside a VS Code webview.
     *
     * SEQUENTIAL, with ONE refetch at the end. closeTerminal()'s own trailing
     * fetchTerminalList() would otherwise fire once per member, and each one re-parents
     * every live xterm in the grid.
     *
     * A derived group is NOT pushed onto groupPrefs.hidden here. Its membership is
     * computed from the live fleet, so closing the members retires the group on the next
     * getDerivedGroups() pass; a hidden id would additionally suppress it the next time
     * the operator opens terminals of that role.
     */
    async function closeGroup(id) {
        const group = getAllGroups().find(g => g.id === id);
        if (!group) { return; }
        const wasLocked = activeGroupId === id;
        const members = getGroupMembers(group);

        let closed = 0;
        for (const name of members) {
            if (await closeTerminalInner(name)) { closed++; }
        }

        if (group.source === 'manual') {
            terminalGroups = terminalGroups.filter(g => g.id !== id);
            if (groupPrefs.orders && groupPrefs.orders[id]) { delete groupPrefs.orders[id]; }
            if (Array.isArray(groupPrefs.pinned)) {
                groupPrefs.pinned = groupPrefs.pinned.filter(pid => pid !== id);
            }
        }

        if (wasLocked) {
            // Drops the lock, re-seats from the surviving fleet, saves and re-renders.
            clearGroupLock();
        } else {
            saveLayoutSettings();
            renderSidebarList();
        }
        await fetchTerminalList();
        showPaneToast(
            closed === 0
                ? `${group.name} removed (no live terminals)`
                : `Closed ${closed} terminal${closed === 1 ? '' : 's'} in ${group.name}`,
            null
        );
    }
```

Retarget the tab button inside `renderGroupTabStrip`, and make the label state the
consequence:

```js
            const memberCount = members.length;
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'group-tab-delete';
            delBtn.textContent = '×';
            delBtn.title = memberCount > 0
                ? `Close ${g.name} — ends ${memberCount} terminal${memberCount === 1 ? '' : 's'}`
                : `Remove ${g.name} (no live terminals)`;
            delBtn.setAttribute('aria-label', delBtn.title);
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                void closeGroup(g.id);
            });
```

`members` is already computed a few lines above for the count chip — reuse it rather than
calling `getGroupMembers` twice.

### 3. `src/webview/terminals.js` — keep the non-destructive verb reachable

Add a **Hide** entry per group in the overflow `»` menu, wired to the now-unused
`deleteGroup`. Inside the `for (const item of overflowing)` loop, after the count chip:

```js
                    const hideBtn = document.createElement('button');
                    hideBtn.type = 'button';
                    hideBtn.className = 'group-tab-overflow-hide';
                    hideBtn.textContent = 'hide';
                    hideBtn.title = `Hide ${g.name} — terminals keep running`;
                    hideBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        deleteGroup(g.id);
                        menu.style.display = 'none';
                    });
                    menuItem.appendChild(hideBtn);
```

The existing restore entry's text reads "N deleted groups — restore all". Retitle it to
"N hidden groups — restore all" so the two words stop disagreeing now that *delete* and
*hide* are separate verbs.

### 4. `src/webview/terminals.html` — style the new overflow control

Add beside the existing `.group-tab-overflow-item` rules:

```css
        .group-tab-overflow-hide {
            margin-left: auto;
            padding: 0 4px;
            font-size: 9px;
            line-height: 14px;
            border: none;
            border-radius: 2px;
            background: transparent;
            color: var(--text-secondary);
            cursor: pointer;
        }
        .group-tab-overflow-hide:hover {
            background: rgba(255, 255, 255, 0.08);
            color: var(--text-primary);
        }
```

`.group-tab-overflow-item` is already a flex row (it lays out name + count), so
`margin-left: auto` parks the control at the right edge without a layout change.

## Verification Plan

1. **Nine-terminal manual group, unlocked.** Open nine planner terminals, select them,
   save as a group. Click the group tab's `×` **without** switching to the group. Expect:
   all nine processes end (sidebar rows gone, `ptyListTerminals` returns none of them), the
   tab disappears, a toast reads `Closed 9 terminals in <name>`, and the grid re-seats from
   whatever remains.
2. **Same, but locked.** Switch to the group first, then click `×`. Expect the same, plus
   the lock drops and the layout resolves via `clearGroupLock` (non-monotonic — it may
   shrink) rather than leaving nine empty panes.
3. **Derived group.** With three coders open (at or above `groupPrefs.threshold`), click
   `×` on the `Coders` tab. Expect all three to end and the tab to vanish. Then open a new
   coder terminal and confirm the `Coders` tab **reappears** once the threshold is met —
   this is the assertion that the close path did not write `groupPrefs.hidden`. Inspect the
   persisted `terminals.groupPrefs` setting to confirm `hidden` is unchanged.
4. **Pinned member.** Pin a member into pane 2, then close the group. Confirm
   `pinnedPanes[1]` is false afterwards (the pane accepts a sidebar click) — no reserved
   empty seat.
5. **Empty group.** Create a manual group, close its terminals individually from the
   sidebar, then click the tab `×`. Expect the group to be removed and the toast to read
   `<name> removed (no live terminals)`.
6. **Single refetch.** With the network tab open, close a five-member group and count
   `POST /terminals/verb/ptyListTerminals` calls attributable to the action. Expect one
   from `closeGroup`, not five.
7. **Hide verb.** Force enough groups to overflow into the `»` menu, click `hide` on one.
   Expect the terminals to keep running, the group to disappear, and the restore entry to
   read `1 hidden group — restore all`. Click restore; the group returns.
8. **No confirm gate.** Grep the diff for `confirm(`, `showWarningMessage`, and any
   two-click/armed-state pattern in the changed functions. Expect zero hits.
9. **Single-terminal close unchanged.** Close one terminal from its sidebar row `×`.
   Expect identical behaviour to today plus the new pin clearing.
10. `node --check src/webview/terminals.js` clean.
