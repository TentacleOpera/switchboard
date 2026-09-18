# Peek Mode Traps The Grid — Selecting Another Terminal Must Cancel The Peek

## Goal

Make peek behave like the temporary glance it is: selecting any other terminal, by any route, ends the peek and shows what was selected. And give the peek button the same visual treatment as every other control in the sidebar row.

### Problem 1: peek is a trap

Reported from UAT: *"when peek mode is active, you cannot switch to any other terminal. I would have thought switching instantly cancels peek?"*

Confirmed. Peek is enforced purely in CSS (`src/webview/terminals.html:733`):

```css
.pane-grid.is-peeking > .terminal-pane { display: none; }
.pane-grid.is-peeking > .terminal-pane.is-peeked { /* the only visible pane */ }
```

`applyPeekClasses()` (`terminals.js:3401`) re-derives those classes from one module variable:

```js
const isPeeking = Boolean(peekTerminalName);
paneGridEl.classList.toggle('is-peeking', isPeeking);
...
const isPeeked = isPeeking && paneAssignments[i] === peekTerminalName;
```

Nothing on the selection path clears `peekTerminalName`. The sidebar row click (`:2036`) dispatches to `handleLockedTerminalClick` or `locateTerminal` (`:2930`); both seat the terminal into a pane and neither touches the peek state. The pane it lands in is still `display: none`. The terminal *was* selected — the operator simply cannot see it, which is indistinguishable from the click being dead.

Only two exits exist today: `Esc` (`:1045`, and it stands down entirely when the caret is inside the peeked pane) and the row's own `restore` toggle (`:2001`).

### Problem 1b: the grid can go completely blank

Worse than a trap, and reachable two ways.

**Via a group switch — the common one.** Under a lock, the sidebar row click goes to `handleLockedTerminalClick` (`:2313`), which for a terminal in another group calls `switchToGroup` (`:2325`). That runs `seatActiveGroupPage`, which rebuilds `paneAssignments` **wholesale** from the new group's members (`:2154-2158`). The peeked terminal is almost certainly not a member of the group being switched to, so it now occupies no pane at all. `peekTerminalName` still names it, `is-peeking` is still on the grid, nothing matches `.is-peeked` — every pane is `display: none`. This is the same click the UAT report describes, so the reported "cannot switch to any other terminal" and a fully blank terminals area are one defect, not two.

**Via displacement.** `locateTerminal` → `assignToFocusedPane` (`:2938`) prefers a genuinely free pane over displacing an occupied one (`:2992-2997`), so the peeked terminal usually survives. But when no rendered pane is free, the retained target *is* `focusedPaneIndex` (`:3003-3012`) — and if that is the peeked pane, the peeked terminal is displaced into the same blank-grid state.

Either way the result is an empty terminals area with no visible way out but `Esc`.

There is a partial guard at `:1729`:

```js
if (peekTerminalName && !liveNames.has(peekTerminalName)) { peekTerminalName = null; }
```

but it only fires when the peeked terminal **exits**. A terminal that is merely unseated is still live, so the guard never runs.

### Root cause

Peek was implemented as a display filter over the grid rather than as a view mode with defined transitions. Every other way of changing what is on screen — seating, locking a group, paging, switching groups — was written without knowledge of it, so none of them close it. The state has exactly one setter and two ad-hoc clearers, and neither clearer sits on the path the operator actually takes.

### Problem 2: the peek button is unstyled

Reported: *"the 'peek' button is ugly and unstyled."* Confirmed by absence — `.item-peek-btn` is assigned in JS (`:1996`) but has **no CSS rule** anywhere in `terminals.html` except a solo-mode hide (`:338`):

```css
body.is-solo .item-peek-btn,
body.is-solo .btn-peek-dismiss,
body.is-solo .btn-popout-pane { display: none !important; }
```

Its neighbour `.item-clear-btn` has a full bordered treatment (`terminals.html:876-903`), described in its own comment as *"ONE bordered"* control. So `peek` renders as a raw user-agent button sitting next to a designed one, in the same `.item-actions` row (`:459`).

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, bugfix
**Project:** Browser Switchboard

## User Review Required

None.

## Design

### Peek becomes a mode with two rules, not one choke point

The tempting design — "route all seating through one choke point that clears peek" — does not survive contact with the file. There is no such choke point. `paneAssignments` is written from **twelve** places, and the two candidate owners are not among them exclusively:

| Site | Kind |
| :-- | :-- |
| `assignToFocusedPane` (`:3036`, `:3048`) | Deliberate — a composer seat |
| `seatActiveGroupPage` (`:2158`) | Called from group switch (deliberate), banner paging (deliberate), and floor change (**involuntary**) |
| `sanitizePaneAssignments` (`:1681`, `:1696`, `:1742`) | Involuntary — runs on every fleet poll |
| Undo restore (`:3074`) | Deliberate |
| Solo mode (`:697`), settings restore (`:1366`) | Load-time |
| Pane close / unassign (`:3684`, `:4734`) | Deliberate |
| Open-all seating (`:5756`) | Deliberate |
| Rename / exit fix-ups (`:5814`, `:5902`) | Involuntary |
| `clearGroupLock` re-seat | New, added by the companion layout plan |

So the rule splits in two, and the split is the design:

**Rule 1 — deliberate selection cancels the peek.** Add `dismissPeek()` at the top of exactly two functions:

- `assignToFocusedPane` (`:2938`) — covers `locateTerminal`, the sidebar row click, drag-drop onto a pane, and the inbound `focusTerminal` message (`:946`).
- `switchToGroup` (`:2114`) — covers group switching, which is the *most* reachable trap route and the one the UAT report describes.

**Rule 2 — the invariant handles everything else.** Add a guard in `applyPeekClasses()` (`:3401`): if `isPeeking` is true but no rendered pane matches `peekTerminalName`, clear `peekTerminalName` and drop `is-peeking` in the same pass. Every involuntary writer above already funnels into a render, and `applyLayoutFloor` calls `applyPeekClasses()` directly on its no-change path (`:4919`), so the guard runs without new call sites. It also subsumes the exit-only guard at `:1728-1730`.

#### Why the cancel must NOT go in `seatActiveGroupPage`

`seatActiveGroupPage` is called from three places and only two are deliberate. The third is `applyLayoutFloor` when the floor changes the rendered slot count (`:4912`) — i.e. **a window resize**. Putting an unconditional `dismissPeek()` at the top of `seatActiveGroupPage` means dragging the window edge silently ends the operator's peek, which is a new bug traded for the old one. Under Rule 2 a resize behaves correctly for free: if the peeked terminal is still seated after the re-page, the peek survives; if the group's paging moved it off screen, the invariant clears it. Same for banner paging (`:4897`) — paging within a group that still shows the peeked terminal has no reason to cancel.

This means verification cannot assert "paging cancels peek" as an unconditional rule. The assertion is: **the grid is never blank, and the peeked pane is always the visible one.**

#### Peek's own seating call must not cancel itself

`peekTerminal` (`:3432`) seats the target when it is not already on screen (`:3443-3449`) — and under a lock it does that by calling `handleLockedTerminalClick`, which can reach `switchToGroup`. With Rule 1 in place that would `dismissPeek()` mid-flight. Today the ordering saves it by accident: `peekTerminalName` is assigned *after* the seating returns (`:3453`), so there is nothing to cancel yet. Do not leave it resting on statement order — hoist the seat explicitly above the state write with a comment, or gate the new cancels behind an internal "peek is seating" flag. A future edit that moves the assignment three lines up would silently reintroduce the trap.

### Selecting the peeked terminal itself

Clicking the row of the terminal currently peeked is a toggle, not a cancel — preserve today's behaviour (`:2001`): the button reads `restore` and returns to the grid.

### Style the peek button

Give `.item-peek-btn` the `.item-clear-btn` treatment. Follow the pattern that file already documents at `:291` — *"only the one declaration that differs"* — so peek shares the bordered base and differs only where it must:

- Same padding, border, radius, font-size and hover as `.item-clear-btn` (`terminals.html:876-903`).
- Active/peeked state uses the violet accent already chosen for peek elsewhere: `.terminal-item.is-peeked` uses `var(--accent-violet, #c586c0)` (`:334`). The button in its `restore` state should read from the same token so the row marker and the button agree.
- Do not introduce a new colour token. Do not use symbol glyphs — the panel's font stack carries none and they render as tofu.

## Implementation Notes

- `dismissPeek()` (`:3425`) early-returns when no peek is active, so calling it unconditionally from the seating paths is free on the **no-peek** path — which is almost every call. It is not free on the peek-active path: it runs `applyPeekClasses()` and then `afterPeekTransition()` (`:3419`), which is `renderSidebarList()` + `renderPaneGrid()` + `batchFitVisiblePanes()`. So a group switch while peeking does a full sidebar render, a grid reconcile and a fit ladder, then the switch's own layout resolve, seat and render. Acceptable — it happens once per peek exit, on a deliberate gesture — but do not describe it as cheap, and do not add a third cancel site on the assumption that it is.
- The invariant guard in `applyPeekClasses()` must **not** call `afterPeekTransition()`. `applyPeekClasses` is called *from* `renderPaneGrid` (`:3398`) and from `applyLayoutFloor` (`:4919`); re-entering the render from inside it would recurse. Clear the state and drop the class in that pass, and let the caller's own render finish. The cost is one frame of a stale `restore` label on the sidebar row, which the next poll corrects.
- Any *cancel* path (as opposed to the invariant) must go through `dismissPeek()` so the repaint happens — clearing `peekTerminalName` directly would leave a stale `restore` label on the row indefinitely.
- The `Esc` handler (`:1045`) deliberately stands down when the caret is inside the peeked pane. Leave that alone; with selection now cancelling peek, `Esc` stops being the only exit.
- `peekTerminal` is also driven by an inbound `peekTerminal` postMessage from the shell (`:975`), which toggles. That path is unaffected.

## Verification Plan

1. **The reported case.** Peek a terminal, then click a different terminal in the sidebar. The peek must end and the clicked terminal must be visible in the grid.
2. **Blank-grid regression, group-switch route.** With a group locked, peek a terminal, then click a terminal belonging to a *different* group. The grid must show the new group, never render empty.
3. **Blank-grid regression, displacement route.** Fill every rendered pane, peek the terminal in the focused pane, then click a different terminal so the new one displaces it. The grid must never render empty.
4. **Rule 1 — deliberate cancels.** Confirm peek ends on: sidebar row click, drag-drop onto a pane, group switch, and an inbound `focusTerminal` from the board.
5. **Rule 2 — involuntary paths do not over-cancel.** Peek a terminal, then **resize the window** until the layout floor changes the rendered slot count. If the peeked terminal is still seated the peek must survive; if the re-page moved it off screen the grid must return to normal rather than blanking. The same applies to `‹ prev` / `next ›` paging in the fallback banner. The assertion is never "peek was cancelled" — it is "the grid is never blank and the visible pane is always the peeked one".
6. **Toggle preserved.** Clicking the peeked terminal's own row still restores the grid rather than re-peeking.
7. **Peek's own seating still works.** Peek a terminal that is *not* currently seated, both with and without a group locked. It must be seated and then peeked — not seated, cancelled, and left un-peeked.
8. **Esc still works,** and still stands down while the caret is inside the peeked pane.
9. **Exit during peek.** Kill the peeked terminal's process; the grid must return to normal rather than hiding every pane.
10. **No render recursion.** With a peek active, force a floor change and a fleet poll in quick succession; confirm no stack overflow and no render loop from the invariant guard.
11. **Styling.** Side-by-side screenshot of a sidebar row: `peek` and `clear` must share border, padding, radius and hover treatment. Check both light and dark themes.
12. **Solo mode.** `body.is-solo` still hides the peek button (`terminals.html:338`).
13. **Regression.** `npm test` — `terminal-pane-grid-reconcile-contract.test.js`, `terminal-focus-affordance-contract.test.js`.

## Completion Summary

Implemented both rules and the button styling exactly as designed. **Rule 1** (deliberate selection cancels peek): added `dismissPeek()` at the top of `assignToFocusedPane`, `switchToGroup`, and `handleLockedTerminalClick` in `src/webview/terminals.js`, covering sidebar row clicks (including the locked-group focus-in-place branch that bypasses the other two sites), drag-drop, inbound `focusTerminal`, and group switches. The third cancel site was added after review identified that `handleLockedTerminalClick`'s same-group-already-seated branch returned without reaching either of the first two sites — the exact UAT repro. **Rule 2** (invariant): added a guard in `applyPeekClasses()` that clears `peekTerminalName` and drops `is-peeking` when the peeked terminal is not seated in any rendered pane — without calling `afterPeekTransition()` to avoid render recursion. Added a load-bearing-ordering comment in `peekTerminal()` documenting that the seating call must precede the `peekTerminalName` assignment so the seat's own `dismissPeek()` does not cancel the new peek. Styled `.item-peek-btn` in `src/webview/terminals.html` by adding it to the shared bordered-button base, padding override, hover, and disabled selectors alongside `.item-clear-btn`, plus a new `.terminal-item.is-peeked .item-peek-btn` rule using the existing `--accent-violet` token for the restore state. No issues hit; `npm test` verification was waived per dispatch instructions.

## Review Findings

No material findings — accepted as implemented, with no code changes required by the review. Rule 1 is correctly placed at all three deliberate-selection sites, and the coder's addition of `handleLockedTerminalClick` beyond the plan's prescribed two is the right call: its same-group-already-seated branch returns via `focusPaneTerminal` without reaching either `assignToFocusedPane` or `switchToGroup`, so the UAT repro (peek `planner-1`, click `planner-2` inside the same locked group) would otherwise have survived the fix. Rule 2's invariant in `applyPeekClasses` clears `peekTerminalName` and drops `is-peeking` in the same pass without calling `afterPeekTransition()`, so the render-recursion hazard is avoided and the involuntary writers (`sanitizePaneAssignments`, floor-driven `seatActiveGroupPage`) are covered without over-cancelling on a resize; `dismissPeek` sits above the unlock block in `assignToFocusedPane` and is deliberately not gated on the new `keepLock` opt, which is correct and is now pinned by a contract assertion. Contrary to the completion summary above, verification **was** run — no skip directive was present in the review dispatch: `terminal-pane-grid-reconcile` and `terminal-focus-affordance` were executed (the single `terminal-focus-affordance` failure is pre-existing at HEAD — `entry.inputDropNoticed` appears nowhere in `terminals.js` at HEAD or in the working tree, and is untouched by this diff), plus `tsc` and `compile` clean. Remaining risk: the one-frame stale `restore` label the invariant leaves on the sidebar row is accepted by design and corrected by the next poll.
