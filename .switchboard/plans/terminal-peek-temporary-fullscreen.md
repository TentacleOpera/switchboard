# Terminal Peek: Temporary Full-Pane View That Restores Exactly

## Goal

Add a per-row control in the terminals sidebar that shows one terminal on its own, filling the pane area, and returns to the previous view untouched when dismissed. No new window, no change to the user's layout, no loss of pins or scrollback.

### The problem

There is no way to look at one terminal closely without either destroying the current arrangement or leaving the window:

- **Compose it into a 1-pane layout** — mutates `currentLayout` and `paneAssignments`, both persisted. Getting back means rebuilding the arrangement by hand.
- **Solo / pop-out** — solo is driven by a URL parameter (`soloTerminalName = urlParams.get('solo')`, `src/webview/terminals.js:76`; all line references verified against the working tree on 2026-08-08) and opens a separate shell window. It is a different surface with its own lifecycle, which is explicitly not what is wanted here.

So the common case — "let me read this one agent's output for ten seconds, then go back to what I was doing" — has no cheap gesture.

### Root cause

Every existing way to make a terminal big is a **mutation of persisted state**. `currentLayout`, `paneAssignments`, and `pinnedPanes` are all saved via `saveLayoutSettings()` (lines 793-805), so any temporary change is indistinguishable from a deliberate one and survives reload. Nothing in the UI models "show me this, briefly."

### The seam that already exists

The codebase already separates user intent from what is rendered (lines 5-9):

```js
let currentLayout = '1'; // what the USER picked (persisted)
// What is actually RENDERED. Diverges from currentLayout only when the pane-size floor
// trips. Every render path reads this, never currentLayout, so a floored layout cannot
// silently revert on the next re-render (which would leave the banner lying).
let effectiveLayout = '1';
```

The responsive pane-size floor already uses this to override the rendered layout without disturbing the user's choice. Solo uses the same variable (`effectiveLayout = '1'`, line 427) to show one terminal — but in a separate window.

> **Superseded:** "A peek is a second reason for the same divergence — which means restoring is not a feature to build, it is what happens automatically when the override is dropped." Peek was to be implemented as a new *input to layout resolution*, alongside the pane-size floor, setting the rendered layout to a single pane.
> **Reason:** `effectiveLayout` does not merely style the grid — it determines how many pane **elements exist**. `renderPaneGrid` (line 2073) computes `slotCount = getSlotCount(effectiveLayout)` and then destroys the surplus:
>
> ```js
> while (paneGridEl.children.length > slotCount) {
>     paneGridEl.removeChild(paneGridEl.lastElementChild);
> }
> ```
>
> Peeking from a 3×3 would therefore delete eight pane elements and detach eight live xterm containers, and dismissing would re-append them all. That is exactly the churn the in-place reconcile was written to eliminate — its own header (lines 2054-2072) says the old teardown "detached and re-appended every live xterm on every render," that xterm's `RenderService` "pauses on non-intersection and PARKS the renderer resize plus the full repaint while paused," and that a fit landing on the wrong side of the IntersectionObserver delivery "leaves the buffer at the new size and the canvas at the old one — and `FitAddon.fit()` then short-circuits on matching cols/rows forever after, so the pane can never recover." It also directly contradicts this plan's own "Do not unmount the hidden panes" requirement, which cannot both be honoured and routed through `effectiveLayout`.
> **Replaced with:** Peek is a **render-time presentation override**, strictly downstream of layout resolution. `effectiveLayout` keeps its single meaning (floor-resolved slot count), `renderPaneGrid` keeps rendering that many panes, and peek only changes which of them are *visible*. See "Peek is presentation, not layout" below. Restore is still free and exact — it is the removal of two CSS classes rather than the dropping of a layout override.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, ux, feature

## User Review Required

None. The three genuine forks — Esc handling while a terminal has the caret, who owns single-terminal pop-out windows, and what peeking an unseated terminal does — are all decided below.

## Reconcile Before Building

The terminals sidebar is being actively reworked locally — `terminals.js`, `terminals.html` and `shell.js` all carry uncommitted changes as of 2026-08-08, and the line numbers cited in the previously-written version of this plan had drifted by 100-200 lines. Re-grep the symbols rather than trusting any line number here, and build peek on whatever the current layout-resolution path is.

**Land Terminals Sidebar Groups first** if both are in flight — it defines the locked-view state peek must restore back into, and both edit `terminals.js`, which the project PRD requires be a single agent stream.

## Design

### Peek is presentation, not layout

Add transient state — `peekTerminalName` — that is read **after** the grid has been rendered and never by layout resolution. It must never write to `currentLayout`, `effectiveLayout`, `paneAssignments`, or `pinnedPanes`.

**This is the whole plan.** Get it right and restore is free and exact; get it wrong and every bug below appears at once.

Mechanically:

- `renderPaneGrid` is unchanged: it still builds `getSlotCount(effectiveLayout)` pane elements and updates them in place.
- A peek toggles `pane-grid.is-peeking` on the grid container and `.terminal-pane.is-peeked` on the one pane whose `paneAssignments[index] === peekTerminalName`.
- CSS does the rest: under `.is-peeking`, sibling panes are `display: none` and the peeked pane spans the whole grid area. No element is created, removed, or re-parented in either direction.
- On both enter and exit, call the existing `batchFitVisiblePanes()` (line 3513) rather than a bare `fit()`. That is the settle ladder (`FIT_SETTLE_DELAYS_MS`, `readRenderedGrid`, `inspectPaneFit`) built precisely for "the box changed, and the renderer may not have caught up." Hidden panes measure zero, so `isRendered` (line 170) returns false and `inspectPaneFit` skips them; on dismiss they measure again and the ladder converges them. Do not hand-roll a fit here — the ladder exists because the naive version is the documented trap.

Do not persist peek. `saveLayoutSettings()` must not record it, and a reload while peeking returns to the real arrangement rather than resuming a transient view. A peek that survives a restart is indistinguishable from the user having chosen a 1-pane layout, which is the confusion this feature exists to avoid. (This is the deliberate opposite of the group lock, which *does* persist — a lock is durable intent, a peek is a glance.)

### The trap: pins are sanitized against assignments

There is an enforced invariant (lines 16-18):

> `pinnedPanes[i]` is never true while `paneAssignments[i]` is null. A pin on an empty seat reserves a slot nothing can fill, and it is persisted... `sanitizePaneAssignments` enforces this on every list refresh.

Confirmed at lines 1075-1077, which clear any pin whose slot is empty on every refresh. So an implementation that peeks by *emptying* `paneAssignments` down to one entry will have every pin silently cleared by the next list refresh — and un-peeking restores the layout with the pins gone. The user loses durable state to a gesture they expected to be free. Route peek entirely around `paneAssignments`; do not clear and restore it. The presentation-only design above satisfies this by construction.

### Do not unmount the hidden panes

`renderPaneGrid` deliberately "reconcile[s] the pane grid IN PLACE" (line 2055), and a grid resize already "invalidates the WebGL glyph model" (line 199). Tearing down and remounting xterm instances on every peek would cost scrollback and glyph state and make the gesture feel heavy.

Hide the other panes (CSS) and render the peeked terminal at full size. Entering and leaving a peek should be visually instant and lose nothing.

### Peeking a terminal that is not seated

A terminal that occupies no pane has nothing to peek. With nine terminals in a floored two-slot grid this is the common case, not an edge case, and a silent no-op there is a dead click on the most-used gesture.

**Decision: seat, then peek.** Peeking an unseated terminal first runs the ordinary seating path (`locateTerminal`, line 1752 — the same thing a plain row click already does), then peeks the slot it landed in. Peek itself still mutates nothing; the seating is the pre-existing, visible, persisted action the user would otherwise have performed manually one click earlier. Dismissing leaves that terminal seated, because reverting a seating the user watched happen would be a hidden mutation-and-rollback and strictly more surprising than keeping it.

Under a locked group this case is already covered by the group plan's promote-into-view rule; peek composes with whatever that path leaves seated.

### Naming — do not call it "focus"

`focusedPaneIndex` already exists and means something else entirely: per the comment at line 1787, "the focused pane is where the caret happens to be (it moves every time the operator types into a pane), which is far too volatile to decide durable seating." Overloading "focus" for a full-pane view would collide with load-bearing existing vocabulary in both code and UI.

Use **Peek** (or Expand). Reserve "focus" for the caret.

### Controls

- A peek control on each sidebar row. The row's action cluster is currently `clear`, `rename`, `close` (lines 1271-1300), with `close` carrying `is-danger` and destroying the process. Insert peek **leftmost**, before `clear` — a misfire next to `close` is destructive and there are no confirm dialogs in this project by rule. It must also be distinct from the row's primary click, which seats (or navigates, once the groups plan lands).
- Toggle: the same control dismisses. Also offer a dismiss affordance in the peeked pane's own header — a user who peeked from the sidebar may be looking at the pane, not the list.
- The peeked terminal is marked in the sidebar so the state is legible when the list is long.

#### Esc dismisses only when the caret is not in a terminal

**Esc is a terminal key.** A peeked agent running vim, a TUI, or any readline prompt needs Esc delivered to the pty, and xterm's textarea will already have consumed it before any document-level handler could act on it usefully. A global Esc-dismisses-peek binding would make peek unusable for exactly the long-running interactive sessions it exists to inspect.

Bind Esc at the document level but **no-op when the active element is inside the peeked pane's terminal** — i.e. when `paneGridEl.contains(document.activeElement)` and the peeked pane owns it. Esc then works when the user is reading (the normal case: peek from the sidebar leaves the caret where it was) and stays out of the way when they are typing. The pane-header dismiss control and the sidebar toggle are the unconditional exits, so peek is never inescapable.

### Composition with everything else

- **Group lock** (`terminals-sidebar-groups-and-grids-ia.md`): peeking does not drop the lock; dismissing returns to the locked group's view. Automatic, because peek mutates nothing and the lock lives in `activeGroupId`, which peek never touches.
- **Pane-size floor**: peek is downstream of the floor and never fights it. `applyLayoutFloor` may recompute `effectiveLayout` mid-peek (e.g. a window resize) and re-render the grid; the peek classes must be **re-applied after every render**, not set once, or a resize mid-peek silently drops the peek. Reassert them at the end of `renderPaneGrid`/`applyLayoutFloor` from `peekTerminalName`, which is the single source of truth.
- **Solo / pop-out**: unchanged and separate. Peek is in-window only; it neither opens nor closes pop-outs. Suppress the peek control entirely under `body.is-solo` — a one-terminal window has nothing to peek out of.
- **Peeked terminal closes while peeked**: dismiss automatically and restore. Never leave a peek pointing at a dead terminal. `sanitizePaneAssignments` is the hook — if `peekTerminalName` is no longer in `liveNames`, clear it there.
- **Rename while peeked**: peek must survive it. `renameTerminal` (line 3845) already re-keys `terminalsMap` and fixes up `paneAssignments`; `peekTerminalName` must be fixed up in the same place, or the peek silently points at a name that no longer exists.
- **`focusedPaneIndex`**: entering and leaving a peek must not change it. Clicking *into* the peeked pane fires `mousedown → setFocusedPane(index)` (line 2271) and legitimately does change it — that is an ordinary user action, not a peek side effect.

## Shell strip icons become peek shortcuts

### What they do today

Each terminal icon in the shell's left strip opens a whole new browser window (`src/webview/shell.js:371-379`):

```js
const popoutUrl = `/terminals?solo=${encodeURIComponent(t.name)}`;
popout = window.open(popoutUrl, popoutName, features);
```

That loads the **entire terminals webview from scratch** — full page boot, fresh socket connections, every xterm instance re-created — to show one terminal. The latency is inherent to the approach, not a tuning problem.

### This resolves a compromise the code already records

The strip click used to call `focusTerminal`, and was deliberately changed. From `terminals.js:605-610`:

> Acknowledge-only sibling of `focusTerminal`. The strip's click now pops the terminal out into its own window, so the user HAS seen the completion — but the cockpit's pane layout must not be rearranged behind their back, which is exactly what `focusTerminal` would do. Without this arm the DONE light burns forever on the happy path, because `assignToFocusedPane` is never reached.

So the strip has had two options and both were bad: rearrange the layout behind the user's back, or be slow. **Peek is the third option** — instant *and* non-destructive. Pointing the strip at it is what the existing comment was working around the absence of.

### The panel-activation mechanism already exists — reuse it

The strip click already contains an in-cockpit path, used when the popup is blocked (`shell.js:382-393`):

```js
const fallbackToInCockpit = () => {
    selectPanel('terminals');
    const termFrame = frames.get('terminals');
    if (termFrame && termFrame.contentWindow) {
        termFrame.contentWindow.postMessage({ type: 'focusTerminal', name: t.name }, location.origin);
    }
};
```

`selectPanel('terminals')` is the panel switch, and the origin-scoped `postMessage` into the terminals iframe is the transport. Do not build a second bridge — **replace `focusTerminal` with a peek message in this exact function and make it the primary click path**, deleting the `window.open` branch, the `popoutWindows.add`, and the 100ms focus re-check that exists only to detect a failed pop-out.

**Panel activation is required, not optional.** The strip is visible while other panels are active, so a peek message alone would change a panel the user cannot see and read as a dead click. Switch first, then peek — which is the order `fallbackToInCockpit` already uses.

Preserve the `event.origin !== location.origin` guard on the new message exactly as the existing `focusTerminal` and `clearTerminalBadge` arms do (lines 592, 611).

### The bug this will cause if missed

The `clearTerminalBadge` arm exists precisely because the pop-out path never reaches `assignToFocusedPane`, which is what normally clears a terminal's DONE badge. **Peek is another such path** — under the presentation-only design it does not call the seating path at all when the terminal is already seated. If the strip triggers peek without clearing the badge, the DONE light burns forever on the happy path — the exact regression that comment describes, reintroduced.

Peek must clear the badge for the terminal it shows, whether entered from the strip or from the sidebar. In both cases the user has now seen the terminal. Clear it **before** anything that can early-return, matching the ordering `shell-terminal-strip.test.js` already asserts for the `focusTerminal` arm ("the badge must be cleared BEFORE delegating, to survive the early-return path").

### The strip click becomes plain peek — no modifier

A separate-window path already exists at panel granularity: `btn-new-window` (`terminals.js:474-492`) opens `/terminals` in its own window, sheds the shell sidebar, and carries its own grid — so a second monitor is served by popping out the *panel* and arranging (or peeking) inside it. The strip's `?solo=` pop-out is the only thing that windows a *single* terminal, and it is not worth preserving a modifier gesture for.

So: strip click peeks, unconditionally. No modifier, no context menu.

### Single-terminal pop-out moves into the pane frame — but the shell keeps owning the window

The `?solo=` mode keeps a UI entry point — it just moves to where it belongs. Add a pop-out control to each terminal pane's header, opening `/terminals?solo=<name>` for **that pane's** terminal.

This is a better home than the strip: you pop out the terminal you are already looking at, rather than picking one from a list of icons. It also composes naturally with peek — a peeked pane is already full-size, so its header button reads as "promote this to a real window."

`.pane-actions` already exists inside `.pane-header` (built in `createPaneElement`, lines 2279-2365, re-read by `updatePaneElement` at line 2429), so there is a container to add to.

> **Superseded:** The pane-header control calls `window.open('/terminals?solo=<name>')` directly from the terminals panel.
> **Reason:** Single-terminal pop-out windows are tracked in `shell.js`'s `popoutWindows` set (line 203) and that set is what `applyThemeToAll` (lines 205-226) iterates to push theme changes into open pop-outs. Today the strip opens them *from the shell*, so they land in the set. Opening them from inside the terminals iframe means the shell never learns the window exists, and every single-terminal pop-out silently stops following the cockpit theme — a regression introduced by relocating a button.
> **Replaced with:** The pane-header control posts `{ type: 'popoutTerminal', name }` to `window.parent` (the same direction and origin discipline `postFleetStateToShell` already uses, line 684); the shell performs the `window.open`, adds the result to `popoutWindows`, and — on a blocked or closed window — posts `{ type: 'popoutBlocked', name }` back so the panel can show its toast. One owner for pop-out windows, and theme fan-out keeps working unchanged.

Placement rules:

- **Only on terminal-mode panes with an assignment.** Panes can render a kanban column instead of a terminal (`paneModes[index] === 'kanban'`, handled at line 2443), and empty slots render a placeholder. Neither has a terminal to pop out.
- **Suppress in solo.** A `?solo=` window offering to pop itself out again is nonsense; the existing `is-solo` body-class check (line 2438) is the test to use.
- **Not adjacent to the pane's close/destructive controls**, for the same misclick reason as the sidebar row. The current order is pin, clear, model, unassign, mode (lines 2359-2363).
- **Dismiss the peek when popping out from a peeked pane.** Otherwise the user is peeking a terminal that now lives in another window.

**Handle popup blocking.** `btn-new-window` already does this and the reasoning applies verbatim (lines 483-490): on a blocked or closed window it shows a toast and briefly disables the button, because "a console warning is invisible to users who never open devtools." With the shell owning `window.open`, the panel reacts to the `popoutBlocked` message and calls `showPaneToast` — do not fail silently.

Keep `soloTerminalName`, the URL-param path, and `src/test/terminal-solo-popout-contract.test.js` intact and passing — this change relocates the entry point, it does not retire the mode. That test asserts solo's `saveSetting` suppression, the `sanitizePaneAssignments` exemption, `init`'s forcing of `currentLayout = '1'`, the websocket exit-frame semantics, and the not-found state; none of those are touched here, so it must pass **unmodified**.

`src/test/shell-terminal-strip.test.js` is a different matter: it statically asserts the strip's current behaviour and the `focusTerminal` / `clearTerminalBadge` arms, including that "locateTerminal seats the terminal AND gives it the caret" and that the badge clear precedes the seating delegation. Those assertions must be **rewritten to the peek contract, not deleted** — the badge-ordering assertion in particular is the guard on the "DONE light burns forever" regression and must survive in its peek form.

If a `?solo=` window is already open for that terminal when the strip is clicked, focus that window rather than peeking — two live views of one terminal across two surfaces is confusing, and the open window is the stronger signal of intent. The shell can answer this because it owns `popoutWindows`; the panel cannot.

## Complexity Audit

### Routine

- The peek state variable, the two CSS classes, and the grid CSS that hides siblings and spans the peeked pane.
- Sidebar row control placement and the peeked-row marker.
- Reusing `batchFitVisiblePanes()` on both transitions rather than writing a fit path.
- Suppressing the control under `body.is-solo` and on kanban-mode / empty panes.

### Complex / Risky

- **Re-applying the peek classes after every render.** `applyLayoutFloor` and `renderPaneGrid` run from resize, poll refreshes, badge changes and seating. A peek asserted once rather than derived from `peekTerminalName` on every render silently evaporates.
- **Esc arbitration with xterm's textarea.** Getting this wrong makes peek hostile to any interactive TUI.
- **Moving pop-out ownership to the shell.** Cross-frame round trip (`popoutTerminal` → `window.open` → `popoutBlocked`), origin guards on a new message in both directions, and the `popoutWindows` theme fan-out that motivated it.
- **`shell-terminal-strip.test.js`** is a static source-scanning contract test over both files; every strip assertion changes and the badge-ordering guard must be preserved in its new form.
- Badge clearing on a path that no longer calls the seating function — the documented "DONE light burns forever" trap.

## Edge-Case & Dependency Audit

### Race Conditions

- A window resize mid-peek re-runs `applyLayoutFloor` → `renderPaneGrid`; peek classes must be re-derived, not assumed.
- `fetchTerminalList` polls; a peeked terminal exiting between renders must clear `peekTerminalName` in `sanitizePaneAssignments` rather than leaving a peek on a dead pane.
- The strip's fleet-state push rebuilds every strip button (`renderTerminalSection`, `shell.js:274+`) — a click landing during a rebuild must not act on a stale terminal name. The existing `hideStripTooltip()` guard shows the rebuild is already known to be hostile to in-flight interaction.
- `renameTerminal` re-keys `terminalsMap` and `paneAssignments`; `peekTerminalName` must be updated in the same synchronous block or a rename mid-peek strands it.

### Security

- The new `popoutTerminal` / `popoutBlocked` / peek messages cross the iframe boundary in both directions. Every arm must keep the `event.origin !== location.origin` check the existing arms use. The shell must treat the incoming terminal name as untrusted: resolve it against its own fleet list before building a URL, and keep the existing `replace(/[^A-Za-z0-9_-]/g, '_')` slug sanitisation for the window name.
- `encodeURIComponent` on the `?solo=` value stays.

### Side Effects

- Removing `window.open` from the strip means `popoutWindows` is populated only by the pane-header route. It stays meaningful (theme fan-out, the already-open check) but will usually be empty — do not delete it.
- Peek clearing the DONE badge is a real state mutation and is intended: acknowledgement is the point.
- Seat-then-peek for an unseated terminal writes `paneAssignments` and persists. Intended and visible; documented above.

### Dependencies & Conflicts

- **Shares `src/webview/terminals.js` with Terminals Sidebar Groups.** One agent stream per file (project PRD); do not code both in parallel.
- Shares the sidebar row action cluster with the groups plan — take the leftmost slot and leave `close` at the far end.
- Reads group lock state; never writes it.
- Shares `src/webview/shell.js` with nothing else in this feature.

## Dependencies

- **Terminals Sidebar: Logical Groups That Lock the View** (`terminals-sidebar-groups-and-grids-ia.md`) — shares the sidebar row surface and the same file. Land groups first; peek then places its control into the row layout groups defines. If peek must land first, groups must preserve peek's control placement.

## Adversarial Synthesis

Key risks: implementing peek through `effectiveLayout`, which deletes and re-parents every hidden pane and walks straight into the documented `FitAddon` short-circuit trap; a global Esc binding that steals the key from any interactive TUI in the peeked terminal; and losing theme propagation to single-terminal pop-outs by moving `window.open` inside the iframe, away from the shell's `popoutWindows` set. Mitigations: peek is a render-time CSS override re-derived on every render with the existing fit ladder driving convergence; Esc no-ops while the caret is inside the peeked terminal, with unconditional exits on the row toggle and the pane header; and the shell retains ownership of pop-out windows via a `popoutTerminal` / `popoutBlocked` message pair.

## Proposed Changes

### `src/webview/terminals.js`

- **Context:** Module state (lines 1-113), the message-handler arms (582-619), `sanitizePaneAssignments` (1044), sidebar row construction (1263-1314), `locateTerminal` (1752), `createPaneElement` / `updatePaneElement` (2263, 2417), `renderPaneGrid` (2073), `applyLayoutFloor` (3213), `batchFitVisiblePanes` (3513), `renameTerminal` (3845).
- **Logic:** Add `peekTerminalName`; apply/clear the peek classes at the end of every render; add the sidebar peek control and the pane-header dismiss and pop-out controls; add a `peekTerminal` message arm; clear the badge on peek; clear the peek when its terminal dies or is renamed.
- **Implementation:** Peek classes are set from `peekTerminalName` inside the render path, never by the click handler alone. Pop-out posts to `window.parent`; a `popoutBlocked` reply calls `showPaneToast`.
- **Edge cases:** Unseated target (seat then peek); kanban-mode and empty panes (no control); solo (no controls); resize mid-peek; dismiss-on-pop-out.

### `src/webview/terminals.html`

- **Context:** Pane grid CSS, `.pane-actions`, sidebar row action styling.
- **Logic:** `.pane-grid.is-peeking > .terminal-pane { display: none }` with `.is-peeked` spanning the full grid area; peeked-row marker styling; suppress peek controls under `body.is-solo`.
- **Edge cases:** The span rule must work for every layout mode's grid template, not just `3x3`.

### `src/webview/shell.js`

- **Context:** Strip button click handler (371-426), `popoutWindows` (203), `applyThemeToAll` (205), `selectPanel`, `renderTerminalSection` (274).
- **Logic:** Strip click becomes `selectPanel('terminals')` + peek message + badge clear; delete the `window.open` branch and the 100ms focus re-check; add a `popoutTerminal` listener that opens the window, tracks it, and replies `popoutBlocked` on failure; focus an already-open pop-out instead of peeking.
- **Edge cases:** Terminals panel not mounted (`frames.has('terminals')` is already the guard used by `renderTerminalSection`); untrusted incoming name; window closed between checks.

### `src/test/shell-terminal-strip.test.js`

- **Context:** Static assertions over the strip handler and the `focusTerminal` / `clearTerminalBadge` arms.
- **Logic:** Rewrite the strip assertions to the peek contract; keep an assertion that the badge is cleared before any early-return; keep the relay assertions untouched.
- **Edge cases:** The test reads source between marker strings — re-verify each marker still resolves after the handler is restructured.

## Verification Plan

### Automated Tests

1. **Unit — no mutation.** Snapshot `currentLayout`, `effectiveLayout`, `paneAssignments`, and `pinnedPanes`; peek an already-seated terminal; assert all four are byte-identical during and after.
2. **Unit — pins survive.** Pin two panes, peek, trigger a list refresh (so `sanitizePaneAssignments` runs), dismiss; assert both pins are intact. This is the regression that a naive implementation fails.
3. **Unit — not persisted.** Peek, then assert `saveLayoutSettings()` writes no peek state; simulate reload and assert the real arrangement returns, not a 1-pane view.
4. **Unit — exact restore.** With a 2×3 layout, specific assignments, pins, and a focused pane, peek and dismiss; assert layout, assignments, pins, and `focusedPaneIndex` all match the pre-peek snapshot. Scoped to peek/dismiss alone — a click *into* the peeked pane legitimately moves `focusedPaneIndex`.
5. **Unit — no remount.** Assert `renderPaneGrid` is not driven to a smaller `slotCount` by a peek, that `paneGridEl.children.length` is unchanged across peek and dismiss, and that the hidden panes' xterm container elements are the same object identities afterwards.
5b. **Unit — peek does not touch `effectiveLayout`.** Static assertion that no peek code path assigns `effectiveLayout`, `currentLayout`, `paneAssignments`, or `pinnedPanes`.
5c. **Unit — classes are re-derived, not set once.** Peek, then force a re-render (resize → `applyLayoutFloor`, and a list refresh → `renderPaneGrid`); assert the peek is still applied after each.
6. **Unit — toggle and Esc.** Both dismiss; assert dismissing twice is a no-op rather than an error.
6b. **Unit — Esc is not stolen from the terminal.** With the caret inside the peeked pane's terminal, assert Esc does **not** dismiss; with the caret outside the pane grid, assert it does. Assert the row toggle and the pane-header control dismiss regardless of caret position.
7. **Unit — terminal closes while peeked.** Close the peeked terminal; assert `peekTerminalName` is cleared (in `sanitizePaneAssignments`) and the previous view is restored.
8. **Unit — rename while peeked.** Rename the peeked terminal; assert the peek still shows it and `peekTerminalName` was re-keyed in the same block `paneAssignments` was.
8b. **Unit — peek an unseated terminal.** Peeking a terminal in no pane seats it via `locateTerminal` and then peeks that slot; assert it is never a no-op, and that dismissing leaves it seated.
9. **Unit — group lock preserved.** Lock a group, peek a member, dismiss; assert the lock is still active, `activeGroupId` is unchanged, and the group's view is restored.
10. **Unit — resize during peek.** Shrink the window past a floor threshold while peeked, then dismiss; assert the floor is applied correctly on restore, the fallback banner state is accurate, and the peek survived the intervening re-render.
11. **Unit — control separation.** Assert the peek control is leftmost in the sidebar row's action cluster and not adjacent to `close`; assert the pane-header pop-out is not adjacent to the pane's destructive controls; assert no `confirm(` / `window.confirm(` is introduced.
11b. **Unit — solo suppression.** Under `body.is-solo`, assert neither the sidebar peek control nor the pane pop-out control is rendered.
12. **Unit — strip click peeks, does not pop out.** Assert a plain strip-icon click issues `selectPanel('terminals')` + a peek message and calls no `window.open`; assert the 100ms focus re-check is gone.
13. **Unit — badge cleared on peek.** Give a terminal a DONE badge, peek it from both the strip and the sidebar; assert the badge clears in both cases, and that the clear precedes any early-return. This is the "DONE light burns forever" regression the `clearTerminalBadge` comment describes.
14. **Unit — panel activation.** With a non-terminals panel active, assert a strip click switches panels *before* peeking, and that the peek is visible without further interaction.
15. **Unit — origin guard.** Assert the new peek, `popoutTerminal`, and `popoutBlocked` messages are all rejected when `event.origin !== location.origin`, matching the existing arms.
16. **Unit — no modifier path.** Assert a plain strip click peeks and that no modifier variant opens a single-terminal window; assert `btn-new-window` still opens the whole panel unchanged.
17. **Regression — solo mode intact.** `src/test/terminal-solo-popout-contract.test.js` passes **unmodified**; assert `/terminals?solo=<name>` still renders solo when reached directly.
17b. **Unit — pane pop-out placement.** The control appears only on terminal-mode panes with an assignment; assert it is absent from kanban-mode panes, empty slots, and every pane in solo mode.
17c. **Unit — pane pop-out target.** Clicking it targets *that pane's* terminal, not the focused or active one — the bug a shared handler reading `activeTerminalName` would produce.
17d. **Unit — pop-out from a peek.** Popping out from a peeked pane dismisses the peek and restores the prior layout, leaving no peek pointing at a terminal now shown in another window.
17e. **Unit — popup blocked.** With the shell's `window.open` returning null, assert it posts `popoutBlocked`, the panel shows a toast via `showPaneToast`, and the control is briefly disabled — matching the `btn-new-window` behaviour and not failing silently.
17f. **Unit — pop-out windows stay theme-tracked.** Assert a pane-header pop-out lands in `shell.js`'s `popoutWindows` set and receives a `switchboardThemeChanged` message on the next theme toggle. This is the regression that relocating the button without relocating ownership would introduce.
18. **Unit — existing pop-out wins.** With a `?solo=` window already open for a terminal, assert a strip click focuses that window instead of peeking.
19. **Contract test rewritten, not weakened.** Assert `src/test/shell-terminal-strip.test.js` still contains a badge-clear-ordering assertion and a strip-click behaviour assertion; assertion count must not decrease.
20. **Manual (VSIX).** With a 3×3 grid of planners, two panes pinned: peek several terminals in succession, confirm each is instant, confirm scrollback is preserved in the hidden panes, and confirm dismissing returns to the exact grid with pins intact. Peek a terminal running an interactive TUI and confirm Esc reaches the program. Then from another panel, click a strip icon and confirm it switches panel, peeks, clears the DONE light, and dismisses back to the grid. Finally pop out from a pane header and toggle the theme; confirm the pop-out follows.

## Recommendation

Complexity 6 — **Send to Coder.**

## Review Findings

Reviewer pass fixed five defects. `peekTerminal` called `focusPaneTerminal(index)`, moving the caret into the peeked terminal — which both mutated focus state the plan requires unchanged and put the caret in exactly the position where the Esc exit stands down, making peek near-inescapable from the keyboard; removed. `applyPeekClasses` fitted only on enter, so the panes restored from `display:none` never re-converged, and neither `peekTerminal` nor `dismissPeek` re-rendered, so the pane-header **Restore** button (visibility set in `updatePaneElement`) never appeared and the sidebar row marker went stale — all three now route through a shared `afterPeekTransition()`. The peeked-pane CSS set `display: grid` on `.terminal-pane`, which is a flex column, collapsing its header/content stacking. In `shell.js` the already-open-pop-out branch returned without clearing the badge, reintroducing the documented "DONE light burns forever" regression. `shell-terminal-strip.test.js` was rewritten to the peek contract rather than left asserting `window.open` (it was red): 40 passing, up from 34, including badge-clear ordering on both branches, the no-layout-mutation invariant, the Esc caret gate, and pop-out ownership staying with the shell for theme fan-out. Validation: `tsc` clean; strip 40/40, solo-popout 11/11 unmodified, pinning 15/15. Remaining risk: no headless test exercises the real fit ladder across a peek — the "no remount / same xterm container identity" checks stay manual-VSIX.
