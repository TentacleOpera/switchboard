# Terminal Peek: Temporary Full-Pane View That Restores Exactly

## Goal

Add a per-row control in the terminals sidebar that shows one terminal on its own, filling the pane area, and returns to the previous view untouched when dismissed. No new window, no change to the user's layout, no loss of pins or scrollback.

### The problem

There is no way to look at one terminal closely without either destroying the current arrangement or leaving the window:

- **Compose it into a 1-pane layout** — mutates `currentLayout` and `paneAssignments`, both persisted. Getting back means rebuilding the arrangement by hand.
- **Solo / pop-out** — solo is driven by a URL parameter (`soloTerminalName = urlParams.get('solo')`, `src/webview/terminals.js:76`) and opens a separate shell window. It is a different surface with its own lifecycle, which is explicitly not what is wanted here.

So the common case — "let me read this one agent's output for ten seconds, then go back to what I was doing" — has no cheap gesture.

### Root cause

Every existing way to make a terminal big is a **mutation of persisted state**. `currentLayout`, `paneAssignments`, and `pinnedPanes` are all saved via `saveLayoutSettings()`, so any temporary change is indistinguishable from a deliberate one and survives reload. Nothing in the UI models "show me this, briefly."

### The seam that already exists

The codebase already separates user intent from what is rendered:

```js
let currentLayout = '1'; // what the USER picked (persisted)
// What is actually RENDERED. Diverges from currentLayout only when the pane-size floor
// trips. Every render path reads this, never currentLayout, so a floored layout cannot
// silently revert on the next re-render (which would leave the banner lying).
let effectiveLayout = '1';
```

The responsive pane-size floor already uses this to override the rendered layout without disturbing the user's choice. **A peek is a second reason for the same divergence** — which means restoring is not a feature to build, it is what happens automatically when the override is dropped. Solo already proves the mechanism works (`effectiveLayout = '1'`, line 419; "solo mode forces effectiveLayout = '1' so this covers pop-outs too", line 2391); it just does it in a separate window.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, feature

## Reconcile Before Building

The terminals sidebar is being actively reworked locally. Check for unpushed work touching pane rendering, layout resolution, or sidebar rows first, and build peek on whatever the current layout-resolution path is.

## Design

### Peek is a derivation, never a mutation

Add transient state — `peekTerminalName` — that is an *input* to layout resolution, alongside the existing pane-size floor. It must never write to `currentLayout`, `paneAssignments`, or `pinnedPanes`.

**This is the whole plan.** Get it right and restore is free and exact; get it wrong and every bug below appears at once.

Do not persist peek. `saveLayoutSettings()` must not record it, and a reload while peeking returns to the real arrangement rather than resuming a transient view. A peek that survives a restart is indistinguishable from the user having chosen a 1-pane layout, which is the confusion this feature exists to avoid.

### The trap: pins are sanitized against assignments

There is an enforced invariant (lines 16-18):

> `pinnedPanes[i]` is never true while `paneAssignments[i]` is null. A pin on an empty seat reserves a slot nothing can fill, and it is persisted... `sanitizePaneAssignments` enforces this on every list refresh.

So an implementation that peeks by *emptying* `paneAssignments` down to one entry will have every pin silently cleared by the next list refresh — and un-peeking restores the layout with the pins gone. The user loses durable state to a gesture they expected to be free. Route peek entirely around `paneAssignments`; do not clear and restore it.

### Do not unmount the hidden panes

`renderPaneGrid` deliberately "reconcile[s] the pane grid IN PLACE" (line 1910), and a grid resize already "invalidates the WebGL glyph model" (line 191). Tearing down and remounting xterm instances on every peek would cost scrollback and glyph state and make the gesture feel heavy.

Hide the other panes (CSS) and render the peeked terminal at full size. Entering and leaving a peek should be visually instant and lose nothing.

### Naming — do not call it "focus"

`focusedPaneIndex` already exists and means something else entirely: per the comment at line 1650, "the focused pane is where the caret happens to be (it moves every time the operator types into a pane), which is far too volatile to decide durable seating." Overloading "focus" for a full-pane view would collide with load-bearing existing vocabulary in both code and UI.

Use **Peek** (or Expand). Reserve "focus" for the caret.

### Controls

- A peek control on each sidebar row, distinct from the row's primary click (which navigates/seats per the sidebar plan) and from `close`. It must not be adjacent to `close` — a misfire there is destructive and there are no confirm dialogs in this project by rule.
- Toggle: the same control dismisses. Also dismiss on **Esc**, and offer a dismiss affordance in the peeked pane's own header — a user who peeked from the sidebar may be looking at the pane, not the list.
- The peeked terminal is marked in the sidebar so the state is legible when the list is long.

### Composition with everything else

- **Group lock** (`terminals-sidebar-groups-and-grids-ia.md`): peeking does not drop the lock; dismissing returns to the locked group's view. Automatic, because peek mutates nothing.
- **Pane-size floor**: peek renders one pane, and `LAYOUTS['1']` has zero minimums (line 1655), so the floor cannot fight it. On dismiss the floor recomputes normally — including re-flooring if the window was resized *during* the peek, which is correct.
- **Solo / pop-out**: unchanged and separate. Peek is in-window only; it neither opens nor closes pop-outs.
- **Peeked terminal closes while peeked**: dismiss automatically and restore. Never leave a peek pointing at a dead terminal.
- **Rename while peeked**: peek must survive it. Prefer whatever stable handle the pane grid uses over the friendly name.

## Verification Plan

1. **Unit — no mutation.** Snapshot `currentLayout`, `paneAssignments`, and `pinnedPanes`; peek; assert all three are byte-identical during and after.
2. **Unit — pins survive.** Pin two panes, peek, trigger a list refresh (so `sanitizePaneAssignments` runs), dismiss; assert both pins are intact. This is the regression that a naive implementation fails.
3. **Unit — not persisted.** Peek, then assert `saveLayoutSettings()` writes no peek state; simulate reload and assert the real arrangement returns, not a 1-pane view.
4. **Unit — exact restore.** With a 2×3 layout, specific assignments, pins, and a focused pane, peek and dismiss; assert layout, assignments, pins, and `focusedPaneIndex` all match the pre-peek snapshot.
5. **Unit — no remount.** Assert hidden panes' xterm instances are the same objects after dismiss (not torn down and rebuilt), and that scrollback is retained.
6. **Unit — toggle and Esc.** Both dismiss; assert dismissing twice is a no-op rather than an error.
7. **Unit — terminal closes while peeked.** Close the peeked terminal; assert peek exits and the previous view is restored.
8. **Unit — rename while peeked.** Rename the peeked terminal; assert the peek still shows it.
9. **Unit — group lock preserved.** Lock a group, peek a member, dismiss; assert the lock is still active and the group's view is restored.
10. **Unit — resize during peek.** Shrink the window past a floor threshold while peeked, then dismiss; assert the floor is applied correctly on restore and the fallback banner state is accurate.
11. **Unit — control separation.** Assert the peek control is not adjacent to `close` in the row, and that no `confirm(` / `window.confirm(` is introduced.
12. **Manual (VSIX).** With a 3×3 grid of planners, two panes pinned: peek several terminals in succession, confirm each is instant, confirm scrollback is preserved in the hidden panes, and confirm dismissing returns to the exact grid with pins intact.

## Dependencies

- **Terminals Sidebar: Logical Groups That Lock the View** (`terminals-sidebar-groups-and-grids-ia.md`) — shares the sidebar row surface and the layout-resolution path. Either can land first; if peek lands first, the sidebar plan must preserve its control placement.
