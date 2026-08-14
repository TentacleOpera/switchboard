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

`renderGroupTabStrip()` in `src/webview/terminals.js:2818-2827` builds the per-tab delete
button and wires it straight to `deleteGroup(g.id)`:

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

`deleteGroup(id)` (`terminals.js:2271-2303`) is a pure *bookkeeping* verb. Its entire body
operates on `terminalGroups`, `groupPrefs.orders`, `groupPrefs.pinned` and
`groupPrefs.hidden`:

- `source === 'manual'` → splice the record out of `terminalGroups`, prune its ordering
  and pin.
- derived (`role` / `worktree`) → push the id onto `groupPrefs.hidden` (suppress, do not
  destroy — the group is *computed* from the live fleet, so it would reappear on the next
  poll otherwise).

Then it calls `clearGroupLock()` (re-seats the grid from the full live fleet) or
`saveLayoutSettings() + renderSidebarList()`. **`closeTerminal` is never reached from this
path.** The only call site of `closeTerminal(name)` is the per-row `×` built in
`renderTerminalRow` (`terminals.js:2162`, titled "Close terminal (ends the process)").

So the two `×` glyphs in this panel mean two different things — "forget this label" on a
tab, "end this process" on a row — with nothing on screen distinguishing them. The tab's
own tooltip ("Delete this group") is what makes it read as destructive when it is not.

### Background context

`getGroupMembers(group)` (`terminals.js:2525-2567`) already resolves the exact set to
close, for all three group sources, filtered to live terminals:

- `manual` → `group.order` (or `group.members`) filtered by liveness.
- `role` → every live, non-child terminal whose `role` matches `group.value`.
- `worktree` → every live, non-child terminal whose `worktreePath` matches.

`closeTerminal(name)` (`terminals.js:6665-6685`) is already idempotent and self-cleaning:
it POSTs `/terminals/verb/ptyCloseTerminal`, destroys the view, nulls the terminal's pane
slots, drops its badge/gap state, saves layout settings and refetches the fleet list.
Closing N terminals is therefore N awaited calls plus one group removal — no new backend
verb, no new endpoint.

**No confirmation dialog.** Per this repo's standing rule, delete buttons execute
immediately; `window.confirm()` is also a silent no-op in a VS Code webview, so a gate
here would make the button do literally nothing in one of the two hosts. The tab's `×` is
a 14px target inside a tab that is otherwise a click-to-switch surface, which is the
deliberate misclick protection.

**The non-destructive verb must survive, and must stay reachable.** Suppressing a derived
group without killing its terminals is a real, separate need (it is what
`groupPrefs.hidden` exists for, and the overflow `»` menu already carries a "restore all"
entry for it). Ungrouping a *manual* group without killing its terminals is the same need
on the other source. That verb moves to an explicit **Hide** entry in the overflow menu —
and the overflow menu itself has to change, because today it only exists when tabs
actually overflow.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## User Review Required

None. The one judgement call — the `»` overflow button becomes permanent whenever any
group exists, because it is now the only home of the non-destructive Hide verb — is
decided in this plan and stated in Proposed Changes §3.

## Complexity Audit

### Routine

- One webview file for the behaviour: one new helper (`closeTerminalInner`), one new verb
  (`closeGroup`), one call-site retarget, one new overflow-menu entry.
- No backend change, no new verb, no schema change, no persisted-state shape change.
  `groupPrefs.hidden` keeps its existing meaning and its existing writers/readers.
- The set-resolution (`getGroupMembers`) and the per-terminal close (`closeTerminal`) both
  already exist and are already correct in isolation.

### Complex / Risky

- **Refetch ordering is the whole correctness story.** `closeTerminalInner` does not remove
  rows from `fleetList` — only `fetchTerminalList()` does. Anything that re-seats or
  re-resolves the layout must run *after* that refetch or it reads a fleet that still
  contains the nine terminals just killed.
- **The new `×` is genuinely destructive on a *derived* tab.** Clicking `×` on the `Coders`
  tab now ends every coder terminal in the fleet, which is what "close group" means and
  what the operator asked for. The mitigation is honest labelling (the tooltip and
  aria-label state the count), not a gate.
- **Two verbs whose names invert their danger.** After this change `closeGroup` kills
  processes and `deleteGroup` does not, even though "delete" reads as the more destructive
  word. See the naming decision in Proposed Changes §2.
- **Three assertions in `src/test/terminal-sidebar-groupings-contract.test.js` pin the
  current strip and go red:** `:272-275` (`deleteGroup(g.id)` on the tab **and**
  `!strip.includes("'hide'")`), `:600-602` (the restore entry says `deleted group`), and
  the overflow-container gate implied by `:629`. They must be rewritten in this change.
- **`renderGroupTabStrip` is under source-text block markers at four call sites in that
  test file** (`:259`, `:301`, `:332`, `:600`, `:629`), all keyed on
  `'function renderGroupTabStrip() {' → 'function terminalNameSuffix('`. Anything added to
  the strip lands inside every one of them.

## Edge-Case & Dependency Audit

### Race Conditions

1. **Concurrency.** `closeTerminal` ends with `await fetchTerminalList()`. Running nine of
   them in parallel fires nine list fetches and nine `renderPaneGrid()` passes, each of
   which re-parents every live xterm. Close **sequentially** and refetch **once** at the
   end: extract the per-terminal work into a variant that skips the refetch, then call
   `fetchTerminalList()` once after the loop.

2. **Stale `fleetList` between the closes and the re-seat.** `closeTerminalInner` nulls
   pane slots but leaves the terminal's row in `fleetList`; only `fetchTerminalList()`
   replaces that array. `clearGroupLock()` re-seats from `fleetList` **and** re-resolves
   the layout via `smallestLayoutFitting(liveNames.length)` (`terminals.js:2359`), then
   persists it.

   > **Superseded:** `closeGroup` calls `clearGroupLock()` (or `saveLayoutSettings() +
   > renderSidebarList()`) and *then* `await fetchTerminalList()`.
   > **Reason:** that order hands `clearGroupLock` a `fleetList` that still contains all
   > nine just-killed terminals. It sizes the grid for them (`3x3` for nine dead rows),
   > seats their dead names, and saves that layout. The later refetch clears the names via
   > `sanitizePaneAssignments` but does **not** revisit `currentLayout` — so the operator
   > clicks `×` and is left staring at an empty 3×3, which is visually indistinguishable
   > from the bug this plan exists to fix. The unlocked arm has the same defect one step
   > down: `renderSidebarList()` paints rows for terminals that are already gone.
   > **Replaced with:** drop the lock flag first (so the refetch's own render pass is not
   > painting a lock that points at a deleted group), `await fetchTerminalList()`, and only
   > then re-seat via `clearGroupLock()` or repaint via `saveLayoutSettings() +
   > renderSidebarList()`. The refetch's internal render is a transient free-composition
   > paint of the surviving fleet, which is the correct intermediate state.

3. **A `terminalsChanged` push lands mid-loop.** The gateway broadcasts from inside the
   fleet service, so a poll can refetch `fleetList` while the loop is still closing. The
   loop iterates over `members`, a snapshot taken before the first close, so it is
   unaffected; `closeTerminalInner` is idempotent against an already-dead name.

### Security

- No new network surface. `closeGroup` reaches only `ptyCloseTerminal` and
  `ptyListTerminals`, both already called from this file. Group names reach the DOM through
  `textContent` only.

### Side Effects

4. **Derived group tab (`Coders`, `Planners`, a worktree basename).** Members are computed
   from the live fleet. Closing them empties the group by construction, so the derived
   group stops materialising on the next `getDerivedGroups()` pass (its member count drops
   below `groupPrefs.threshold`). The `groupPrefs.hidden` push is therefore **not** needed
   on the close path and must not happen — a hidden id would suppress the group later,
   when new terminals of that role are opened. This is the one behavioural difference
   between the two verbs and the reason `deleteGroup` splits rather than gains a flag.

5. **Manual group.** The record must still be spliced out of `terminalGroups` and its
   `groupPrefs.orders[id]` / `groupPrefs.pinned` entries pruned — a manual group with zero
   live members would otherwise persist as an empty tab forever.

6. **A member is seated in a pinned pane.**

   > **Superseded:** `closeTerminal` nulls `paneAssignments[i]` but does not clear
   > `pinnedPanes[i]`, so the close loop must set `pinnedPanes[i] = false` for every slot
   > it empties.
   > **Reason:** the premise is false and the fix breaks a pinned contract. The empty-slot
   > pin clear is *deliberately centralised* in `sanitizePaneAssignments`
   > (`terminals.js:1863-1865`), keyed off the slot being empty rather than the occupant
   > being dead, and the comment above it (`terminals.js:1855-1862`) names `closeTerminal`
   > as the exact reason it is keyed that way: "closeTerminal() nulls its own slots BEFORE
   > this refresh lands … Keying off the slot being empty instead of the occupant being
   > dead covers every path — close, death-while-closed, hide, and a torn two-key
   > persistence write." `sanitizePaneAssignments` runs inside `fetchTerminalList`
   > (`terminals.js:1574`), which this plan already calls once after the loop. On top of
   > that, `terminal-pane-pinning-contract.test.js:89-93` asserts
   > `!fn.includes('pinnedPanes')` over the `closeTerminal` body with the message "the pin
   > clear is centralised in sanitize". Adding the line turns a green contract red to fix
   > a bug that does not exist.
   > **Replaced with:** `closeTerminalInner` does not reference `pinnedPanes` at all. The
   > shared refetch's `sanitizePaneAssignments` clears every pin the batch emptied, in one
   > pass, exactly as it does today for a single close.

7. **A member is a delegate child (`parentInstanceId` set).** `getGroupMembers`'s `manual`
   arm is liveness-only and *does* include children (deliberately — a team registers head
   + children explicitly; see the comment at `terminals.js:2527-2534`). Closing a head
   without its children would orphan them, so closing the whole membership list as
   resolved is correct. Do **not** re-add a parentage filter here.

8. **A member is already exited.** `closeTerminal` POSTs against a dead name; the verb is a
   no-op server-side and the client-side cleanup (`destroyTerminalView`, badge/gap drop)
   still runs, which is desirable — an exited row disappears instead of lingering.

9. **A close fails.** The `fetch` throws (host down mid-batch) and that member stays alive,
   but the group record is removed regardless — the label is gone either way, and orphaned
   terminals are visible and closable from the sidebar. The toast must say so rather than
   claiming a clean sweep; a silent "Closed 7 terminals" on a 9-member group is the same
   class of lie this plan is fixing.

10. **Empty group.** `getGroupMembers` returns `[]`; the close loop is a no-op and the
    group removal still runs. The button must not become inert on an empty group.

11. **A pop-out window (`?solo=<name>`) is showing a member.** Closing the terminal makes
    `checkSoloNotFound` in that window report `Terminal "<name>" not found`, which is the
    correct and already-implemented behaviour for a terminal that ends.

### Dependencies & Conflicts

12. **The `+` picker is open on the group being closed.** `renderGroupTabStrip` already
    guards this: the picker only mounts if `getAllGroups()` still contains the id, and
    `pickerState` is garbage-collected when it does not. No new handling needed.

13. **Hide is unreachable as specified.** The overflow menu builds its items from
    `for (const item of overflowing)` and the whole `»` container only renders when
    `overflowing.length > 0 || hasHiddenGroups` (`terminals.js:2889`). A Hide entry added
    inside that loop exists only for tabs that have already been pushed out of the strip by
    width — which, per the code's own comment at `terminals.js:2864-2868`, is "a guard, not
    the common path". On a normal three-group strip nothing overflows, so the
    non-destructive verb would be reachable through no gesture at all. That is not
    "surviving"; it is being deleted with an alibi. Fixed in Proposed Changes §3.

14. **Same-file serialisation with the sibling subtask.** "FILL GRID must build a second
    grid…" edits `src/webview/terminals.js` (the group region and `fillGrid`) and amends
    `src/test/terminal-sidebar-groupings-contract.test.js` — both files this plan also
    edits. Do not dispatch the two concurrently; that plan lands first.

15. **Source-text block markers constrain where `closeGroup` may be declared.** The
    contract file brackets this region tightly: `deleteGroup → clearGroupLock` (`:317`,
    `:513`), `clearGroupLock → saveSelectionAsGroup` (`:535`), and
    `saveCurrentAsGroup → deleteGroup` (`:668`). The only slot in the group region not
    inside an existing marker pair is **after `saveSelectionAsGroup`, before
    `toggleTerminalSelection`**. Declare `closeGroup` there.

## Dependencies

- `sess_intra_feature — FILL GRID must build a second grid of a role it has already used` —
  same-file (`src/webview/terminals.js`) and same-test-file
  (`src/test/terminal-sidebar-groupings-contract.test.js`) sibling subtask. Serialise; that
  plan lands first.
- No external session dependencies.

## Adversarial Synthesis

**Risk summary.** Two of the three original findings inverted on inspection: the pin-clear
"fix" duplicates an invariant that is deliberately centralised in
`sanitizePaneAssignments` and turns a green pinning contract red, and the re-seat runs
before the refetch, sizing the grid from a fleet that still contains the terminals just
killed — leaving the operator with an empty NxN that looks exactly like the reported bug.
The third risk is reachability: the Hide entry as specified only exists when tabs overflow,
so the non-destructive verb would ship unreachable on any normal strip. Mitigations: refetch
before any re-seat, leave `pinnedPanes` entirely to sanitize, list every group in the `»`
menu rather than only the overflowing ones, and rewrite the three strip assertions this
change invalidates.

## Proposed Changes

### 1. `src/webview/terminals.js` — split `closeTerminal` so a batch can share one refetch

`closeTerminal(name)` (6665-6685) currently ends in `await fetchTerminalList()`. Extract
the body into a private `closeTerminalInner(name)` **declared immediately above
`closeTerminal`** that does everything **except** the refetch, and keep `closeTerminal` as
the single-terminal wrapper so every existing call site is unchanged.

Declaring the inner function *above* `closeTerminal` keeps it outside
`terminal-pane-pinning-contract.test.js:90`'s block
(`'async function closeTerminal(name) {' → 'async function clearTerminal(name) {'`), so
that contract stays green and stays meaningful.

```js
    /**
     * Close one terminal and drop the client-side state keyed on its name.
     *
     * Does NOT refetch the fleet list — a batch caller shares one refetch, because
     * fetchTerminalList() re-parents every live xterm through renderPaneGrid() and
     * nine of those in a row is nine full grid reconciles.
     *
     * Returns false when the close request failed, so a batch can report honestly
     * instead of claiming terminals it did not end.
     *
     * Deliberately does NOT touch pinnedPanes. The empty-slot pin clear is
     * centralised in sanitizePaneAssignments (keyed off the SLOT being empty, not
     * the occupant being dead, precisely because this function nulls its slots
     * before the refresh lands) and runs on the shared refetch.
     */
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
            if (paneAssignments[i] === name) { paneAssignments[i] = null; }
        }
        if (activeTerminalName === name) { activeTerminalName = null; }
        dismissStartupCurtain(name);
        terminalBadges.delete(name);
        terminalReplayGaps.delete(name);
        return true;
    }

    async function closeTerminal(name) {
        // Early return on failure preserves today's exact behaviour: the whole
        // body used to sit inside one try, so a throw skipped the save and the
        // refetch too.
        if (!await closeTerminalInner(name)) { return; }
        saveLayoutSettings();
        await fetchTerminalList();
    }
```

### 2. `src/webview/terminals.js` — new `closeGroup(id)`, and retarget the tab `×`

`deleteGroup` keeps its current body verbatim and becomes the *hide/forget* verb only. Its
doc comment (2254-2270) must be rewritten — it currently opens "Delete a group, whatever
its source. One verb, one meaning from the operator's perspective", which is exactly the
claim this change retires:

```js
    /**
     * HIDE a group: forget the label, leave every terminal running.
     *
     * The non-destructive half of the split. closeGroup() is the destructive one
     * and owns the tab's ×; this verb is reached from the » menu's "hide" entry.
     * The names invert their apparent danger — "delete" here kills nothing — so
     * check which one you are calling. (The name is kept because
     * terminal-sidebar-groupings-contract.test.js brackets this region with three
     * source-text markers keyed on `function deleteGroup(`.)
     *
     * What it stores differs by source:
     *   manual    → remove from terminalGroups; prune groupPrefs.orders[id]
     *               and groupPrefs.pinned (the record is gone, so its ordering
     *               and pin are dead state).
     *   derived   → suppress via groupPrefs.hidden (the shipped key — no new
     *               groupPrefs field). Orders/pinned are left intact so a
     *               restore returns the operator's member ordering.
     *
     * If the hidden group is the locked one, route through clearGroupLock() so the
     * grid re-seats from the live fleet rather than stranding the departed group's
     * terminals in their panes. No refetch is needed here: nothing died, so
     * fleetList is already accurate — which is the one thing closeGroup cannot
     * assume.
     */
    function deleteGroup(id) { /* body unchanged */ }
```

> **Naming — considered and rejected.** Renaming `deleteGroup` → `hideGroup` would remove
> the danger inversion, but the name is a source-text contract marker in three places
> (`terminal-sidebar-groupings-contract.test.js:317`, `:513`, `:668`) and the rename buys
> clarity in one file at the cost of churn in another. The doc comment above plus the
> assertion in §5 that the two verbs are structurally distinct carry the same load.

Declare the new verb **after `saveSelectionAsGroup`, before `toggleTerminalSelection`** —
per Edge-Case 15, the only slot in the group region outside every existing block marker:

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
     * fetchTerminalList() would otherwise fire once per member, and each one
     * re-parents every live xterm in the grid.
     *
     * The refetch runs BEFORE the re-seat and that order is load-bearing:
     * closeTerminalInner does not remove rows from fleetList, so clearGroupLock()
     * on the stale list would size the grid via smallestLayoutFitting() for the
     * nine terminals just killed and persist that — an empty 3x3, which is what
     * the reported bug already looked like.
     *
     * A derived group is NOT pushed onto groupPrefs.hidden here. Its membership is
     * computed from the live fleet, so closing the members retires the group on the
     * next getDerivedGroups() pass; a hidden id would additionally suppress it the
     * next time the operator opens terminals of that role.
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

        // Drop the lock flag before the refetch so its render pass does not paint a
        // lock pointing at a group that no longer exists. The re-seat waits.
        if (wasLocked) { activeGroupId = null; activeGroupPage = 0; }

        // One refetch for the whole batch, and it must precede any re-seat.
        await fetchTerminalList();

        if (wasLocked) {
            // Now that fleetList is truthful: drop the lock properly, re-seat from
            // the SURVIVING fleet, resolve the layout, save and re-render.
            clearGroupLock();
        } else {
            saveLayoutSettings();
            renderSidebarList();
        }

        const failed = members.length - closed;
        showPaneToast(
            members.length === 0
                ? `${group.name} removed (no live terminals)`
                : failed > 0
                    ? `Closed ${closed} of ${members.length} in ${group.name} — ${failed} failed to close`
                    : `Closed ${closed} terminal${closed === 1 ? '' : 's'} in ${group.name}`,
            null
        );
    }
```

Retarget the tab button inside `renderGroupTabStrip` (2812-2828), and make the label state
the consequence:

```js
            // Destructive: ends every member process, then removes the group. The
            // non-destructive "forget the label" verb (deleteGroup) lives in the »
            // menu's hide entry. No confirm gate — per CLAUDE.md, delete executes
            // on the click, and confirm() is a silent no-op in a VS Code webview.
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

`members` is already computed a few lines above for the count chip (`terminals.js:2806`) —
reuse it rather than calling `getGroupMembers` twice.

### 3. `src/webview/terminals.js` — make the non-destructive verb actually reachable

The `»` menu currently builds items from `overflowing` and only renders at all when
`overflowing.length > 0 || hasHiddenGroups` (2889). Three edits inside
`renderGroupTabStrip`, all in the overflow block (2869-2963):

**(a) The container gates on there being groups, not on overflow.** Change the outer
condition at 2889 from `if (overflowing.length > 0 || hasHiddenGroups)` to
`if (groupTabEls.length > 0 || hasHiddenGroups)`. The tab-removal loop directly beneath it
keeps iterating `overflowing` only — nothing is pushed out of the strip that does not need
to be.

> **Decision:** this makes the `»` button permanent whenever any group exists, where today
> it appears only on a crowded strip. That is a deliberate, visible change and it is the
> price of the split: the menu is now the home of a verb, not just an overflow spill. The
> alternative — a second control on a 14px tab — was rejected in the architecture review.

Retitle the button to match: `overflowBtn.title = 'All groups — switch or hide';`

**(b) The menu lists every group, not only the overflowing ones.** Change the item loop at
2910 from `for (const item of overflowing)` to `for (const item of groupTabEls)`. A
non-overflowing group now has a menu row too; clicking it switches, exactly as its tab
does, which is harmless and consistent.

**(c) Each row carries a hide control.** Inside that loop, after the count chip:

```js
                    // The non-destructive verb. The tab's × now ends processes, so
                    // "forget the label, keep the terminals running" needs its own
                    // reachable home — and the overflow menu is the only surface in
                    // the strip with room for a word.
                    const hideBtn = document.createElement('button');
                    hideBtn.type = 'button';
                    hideBtn.className = 'group-tab-overflow-hide';
                    hideBtn.textContent = 'hide';
                    hideBtn.title = `Hide ${g.name} — terminals keep running`;
                    hideBtn.setAttribute('aria-label', hideBtn.title);
                    hideBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        deleteGroup(g.id);
                        menu.style.display = 'none';
                    });
                    menuItem.appendChild(hideBtn);
```

The divider gate at 2928 becomes `if (groupTabEls.length > 0 && hasHiddenGroups)` to match
(a).

The restore entry's text at 2937 reads "N deleted groups — restore all". Retitle to
"N hidden group(s) — restore all", and its `title` to 'Restore every hidden derived group',
so the two words stop disagreeing now that *delete* and *hide* are separate verbs.

### 4. `src/webview/terminals.html` — style the new overflow control

Add beside the existing `.group-tab-overflow-item` rules (`terminals.html:826-844`):

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
            font-family: inherit;
            cursor: pointer;
        }
        .group-tab-overflow-hide:hover {
            background: rgba(255, 255, 255, 0.08);
            color: var(--text-primary);
        }
```

`.group-tab-overflow-item` is already a flex row (it lays out name + count), so
`margin-left: auto` parks the control at the right edge without a layout change.
`font-family: inherit` matches the sibling `.group-tab-delete` rule at `terminals.html:762`
— buttons do not inherit the panel font otherwise.

### 5. `src/test/terminal-sidebar-groupings-contract.test.js` — the three assertions this change invalidates

**(a) `:272-275`** currently reads:

```js
    assert.ok(
        strip.includes('deleteGroup(g.id)') && !strip.includes("'hide'"),
        'every tab must render one delete wired at deleteGroup — no source branch, no hide label'
    );
```

Both halves invert. The tab now wires `closeGroup`, and `'hide'` is a required label.
Replace with an assertion of the split itself:

```js
    // The verbs split: the tab's × ENDS PROCESSES (closeGroup); the » menu's hide
    // entry forgets the label and leaves them running (deleteGroup). One glyph, one
    // meaning — the old single verb made the × a dead click on a 9-terminal group.
    assert.ok(
        strip.includes('closeGroup(g.id)') && !strip.includes('deleteGroup(g.id)'),
        "the tab's × must wire closeGroup — deleteGroup only forgets the label, which is the reported bug"
    );
    assert.ok(
        strip.includes("hideBtn.textContent = 'hide'") && strip.includes('deleteGroup(g.id);'),
        'the non-destructive verb must stay reachable as an explicit hide entry'
    );
    assert.ok(
        strip.includes('for (const item of groupTabEls)'),
        'the » menu must list EVERY group, not only the overflowing ones — hide is otherwise reachable on no normal strip'
    );
    assert.ok(
        /delBtn\.title = memberCount > 0/.test(strip),
        'the × must state its consequence — the member count is the mitigation instead of a confirm gate'
    );
```

**(b) `:600-602`** asserts `render.includes('deleted group')`. Retitle:

```js
    assert.ok(
        render.includes('hidden group') && render.includes('groupPrefs.hidden = []'),
        'the strip must surface a count of hidden derived groups and a restore-all'
    );
```

**(c) Add one test for the new verb**, alongside the existing
`'deleteGroup handles every source and re-seats when the deleted group was locked'`
(`:512`):

```js
test('closeGroup ends the processes, refetches BEFORE re-seating, and never hides a derived group', () => {
    const fn = block(terminalsJs, 'async function closeGroup(id) {', 'function toggleTerminalSelection(');
    assert.ok(
        /for \(const name of members\) \{[\s\S]*await closeTerminalInner\(name\)/.test(fn),
        'closeGroup must close members SEQUENTIALLY via closeTerminalInner — parallel closes fire one fleet refetch each, and every one re-parents every live xterm'
    );
    assert.ok(!/Promise\.all/.test(fn), 'no Promise.all — the shared refetch is the point of the inner variant');
    const fetchAt = fn.indexOf('await fetchTerminalList();');
    const seatAt = fn.indexOf('clearGroupLock();');
    assert.ok(fetchAt !== -1 && seatAt !== -1, 'closeGroup must refetch and must re-seat when the closed group was locked');
    assert.ok(
        fetchAt < seatAt,
        'the refetch must PRECEDE the re-seat: closeTerminalInner does not remove rows from fleetList, so clearGroupLock on the stale list sizes the grid via smallestLayoutFitting for the terminals just killed and persists an empty NxN'
    );
    assert.ok(
        (fn.match(/await fetchTerminalList\(\);/g) || []).length === 1,
        'exactly one refetch for the whole batch'
    );
    assert.ok(
        !/groupPrefs\.hidden/.test(fn),
        'a derived group must NOT be pushed onto groupPrefs.hidden by the close path — its members are gone so it stops materialising, and a hidden id would suppress the tab the next time the operator opens terminals of that role'
    );
    assert.ok(
        !/pinnedPanes/.test(fn),
        'the empty-slot pin clear stays centralised in sanitizePaneAssignments, which the shared refetch runs'
    );
    assert.ok(!/\bconfirm\s*\(/.test(fn), 'no confirm gate — confirm() is a silent no-op in a VS Code webview');
    assert.ok(
        /failed > 0/.test(fn),
        'the toast must report a partial sweep honestly rather than claiming terminals it did not end'
    );
});
```

> Runner note: these contract files are plain Node scripts (hand-rolled `test()` helper,
> trailing `process.exit()`), wired as `npm run test:contract:terminal-sidebar-groupings`
> and `npm run test:contract:terminal-pane-pinning` (`package.json:918-919`). They are not
> mocha specs. Running them is outside this plan's verification steps per the dispatch
> directive; the source-inspection checks below cover the same assertions.

## Verification Plan

### Source inspection

1. `grep -n "pinnedPanes" src/webview/terminals.js` — no hit inside `closeTerminalInner`,
   `closeTerminal`, or `closeGroup`. The only writers stay `sanitizePaneAssignments`,
   `clearGroupLock`, `seatActiveGroupPage` and the unassign handler.
2. In `closeGroup`: `await fetchTerminalList();` appears exactly once and at a lower index
   than `clearGroupLock();`.
3. In `closeGroup`: no `groupPrefs.hidden`, no `Promise.all`, no `confirm(`.
4. In `renderGroupTabStrip`: the tab `×` wires `closeGroup(g.id)`; `deleteGroup(g.id)`
   appears only in the hide handler; the menu item loop reads
   `for (const item of groupTabEls)`.
5. `grep -n "deleted group" src/webview/terminals.js` — no hits; the restore entry says
   "hidden group".
6. `node --check src/webview/terminals.js` clean.

### Manual (installed VSIX, Terminals panel)

7. **Nine-terminal manual group, unlocked.** Open nine planner terminals, select them,
   save as a group. Click the group tab's `×` **without** switching to the group. Expect:
   all nine processes end (sidebar rows gone, `ptyListTerminals` returns none of them), the
   tab disappears, a toast reads `Closed 9 terminals in <name>`, and the grid re-seats from
   whatever remains.
8. **Same, but locked — the ordering check.** Switch to the group first, then click `×`.
   Expect the same, plus the lock drops and **the layout shrinks to fit the survivors**. If
   the grid stays a large empty NxN, the refetch is running after the re-seat.
9. **Derived group.** With three coders open (at or above `groupPrefs.threshold`), click
   `×` on the `Coders` tab. Expect all three to end and the tab to vanish. Then open a new
   coder terminal and confirm the `Coders` tab **reappears** once the threshold is met —
   this is the assertion that the close path did not write `groupPrefs.hidden`. Inspect the
   persisted `terminals.groupPrefs` setting to confirm `hidden` is unchanged.
10. **Pinned member.** Pin a member into pane 2, then close the group. Confirm the pane
    accepts a sidebar click afterwards (no reserved empty seat) — the clear comes from the
    refetch's `sanitizePaneAssignments`, not from the close loop.
11. **Empty group.** Create a manual group, close its terminals individually from the
    sidebar, then click the tab `×`. Expect the group to be removed and the toast to read
    `<name> removed (no live terminals)`.
12. **Single refetch.** With the network tab open, close a five-member group and count
    `POST /terminals/verb/ptyListTerminals` calls attributable to the action. Expect one
    from `closeGroup`, not five.
13. **Hide verb, no overflow required.** With exactly two groups on a wide strip (nothing
    overflowing), the `»` button is present. Open it: both groups are listed, each with a
    `hide` control. Click `hide` on one. Expect the terminals to keep running, the group to
    disappear from the strip, and the restore entry to read `1 hidden group — restore all`.
    Click restore; the group returns.
14. **Hide a manual group.** Same gesture on a manual group: the tab goes, the terminals
    stay, and the group does **not** come back from restore-all (manual records are
    removed, not suppressed — restore-all only clears `groupPrefs.hidden`). This is the
    existing `deleteGroup` semantic and is unchanged.
15. **The × is honest.** Hover the `×` on a 4-member tab → tooltip reads
    `Close <name> — ends 4 terminals`. Hover it on a 0-member tab → `Remove <name> (no live
    terminals)`.
16. **No confirm gate.** Grep the diff for `confirm(`, `showWarningMessage`, and any
    two-click/armed-state pattern in the changed functions. Expect zero hits.
17. **Single-terminal close unchanged.** Close one terminal from its sidebar row `×`.
    Expect behaviour identical to today, including the pin on its slot clearing.

## Recommendation

Complexity 4 → **Send to Coder.**
