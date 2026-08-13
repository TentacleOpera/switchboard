# One Completion Paints Four "DONE" Surfaces at Once — Remove the One on the Terminal Frame

## Goal

Cut the completion notice down to the two surfaces that earn their place, and **remove the
`DONE` badge from the terminal pane header entirely**. A single agent completion currently
lights four separate places simultaneously: the shell rail, the Terminals sidebar row, the
pane header inside the terminal frame, and a toast. Three of them say the same word in the
same panel at the same moment.

### The problem

Finish one agent turn and the browser Switchboard produces, all at once:

1. A pulsing ring on that terminal's icon in the **shell rail** (left strip).
2. A `DONE` chip on that terminal's row in the **Terminals sidebar**.
3. A `DONE` chip in the **pane header** of the terminal's own frame in the grid.
4. A **toast** in the Terminals panel's toast container.

Items 2, 3 and 4 are inside the same panel, visible in the same glance. Item 3 is the worst
of them: it sits on the chrome of the terminal the operator is *already watching*, on a
header row that is width-critical, and it tells them nothing the live output below it does
not already show. With a nine-terminal run finishing in a rolling sequence, the panel
becomes a wall of `DONE` chips over live terminals.

### Root cause

There is one signal and four independent renderers, all keyed off the same map. The signal
is set once, in `handleAgentCompleted`:

```js
if (targetTerm) {
    terminalBadges.set(targetTerm, { label: 'DONE', stamp: ++badgeStampSeq });
    renderSidebarList();
    renderPaneGrid();
    postFleetStateToShell();
    fetchTerminalList();
}
showCompletionToast(planTitle || 'Agent Task', role || 'Agent', targetTerm);
```

`terminalBadges` then feeds three of the four surfaces:

*Sidebar row* (`renderTerminalRow`):

```js
if (terminalBadges.has(item.friendlyName)) {
    const badge = document.createElement('span');
    badge.className = 'pane-badge';
    badge.textContent = terminalBadges.get(item.friendlyName).label;
    info.appendChild(badge);
}
```

*Pane header* (`updatePaneElement`) — the same map, the same class, a second time:

```js
if (terminalBadges.has(assignedName)) {
    const badgeSpan = document.createElement('span');
    badgeSpan.className = 'pane-badge';
    badgeSpan.textContent = terminalBadges.get(assignedName).label;
    titleEl.appendChild(badgeSpan);
}
```

*Shell rail* (`postFleetStateToShell` → `shell.js` `renderTerminalSection`):

```js
} else if (terminalBadges.has(t.friendlyName)) {
    light = 'done';
    doneStamp = terminalBadges.get(t.friendlyName).stamp;
}
```

and the fourth, the toast, is a direct call on the same event.

No layer ever asked whether a *second* renderer had already reported it. Each was added for
a defensible reason in isolation — the rail is visible from other panels, the sidebar row is
the durable record, the toast is the transient announcement — and the pane header simply
inherited the badge because it renders from the same map with the same class name and
nobody weighed it against the other three.

There is also a comment in `shell.js` that names all three of the durable surfaces as
intentional, which is how the stack survived review:

> A terminal that completed a minute ago wears no ring — the sidebar DONE chip and the
> pane badge in the Terminals panel remain the durable record of an unacknowledged
> completion.

That comment is the rationale for the state this plan removes. It is a rationale, not a
constraint — the pane badge is being deleted, so the comment goes with it.

### The resulting design

| Surface | Keep? | Why |
| :--- | :--- | :--- |
| Shell rail pulse | **Keep** | The only completion signal visible when the operator is on another panel (Kanban, Tickets, Project). Already self-expiring after 2.2 s. |
| Sidebar row `DONE` chip | **Keep** | The durable, per-terminal record of an *unacknowledged* completion, and the thing the operator scans when returning to the panel. Clears on focus/peek/acknowledge. |
| **Pane header `DONE` chip** | **Remove** | On the chrome of a terminal the operator is already looking at; duplicates the sidebar row four inches away; competes for a width-critical header row. |
| Toast | **Keep, one at a time** | The transient announcement. Currently unbounded — N completions stack N toasts. |

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, ux
- **Project:** Browser Switchboard

## Complexity Audit

**Routine.** Deleting one render block and one CSS-adjacent behaviour, plus a small
coalescing change to the toast container. No state model change — `terminalBadges` keeps its
shape, its writers and its clear paths, so the rail and the sidebar are untouched.

The one thing to be careful about: `terminalBadges` is also the **badge-clearing** trigger.
`assignToFocusedPane`, `locateTerminal`, the `focusTerminal` message arm and the
`clearTerminalBadge` message arm all delete from it and then call `renderPaneGrid()`.
Removing the pane render must not remove those `renderPaneGrid()` calls — they exist for
other reasons (seating, peek, plan-strip refresh) and the sidebar re-render is the one that
matters for the badge.

## Edge-Case & Dependency Audit

1. **The `GAP` badge shares the render site and the class.** `terminalReplayGaps` renders a
   `.pane-badge.is-gap` chip immediately below the `DONE` block in `updatePaneElement`. It
   must **stay** — it reports that scrollback was evicted while the pane was disconnected,
   which is information about *this pane's buffer* and has no other surface. Delete only the
   `terminalBadges` block.

2. **`.pane-badge` CSS must survive.** It styles the `GAP` chip and the sidebar `DONE` chip.
   Do not remove the rule; only `.pane-badge` usages inside `updatePaneElement`'s
   `terminalBadges` block go.

3. **Badge clearing still needs the pane re-render.** Every clear site pairs
   `renderSidebarList()` with `renderPaneGrid()`. Leave both — the grid re-render also
   retires the plan strip and refreshes the pane title, which is not badge work.

4. **The rail's `doneStamp` is read from `terminalBadges`.** Untouched by this change, so
   the pulse-resume arithmetic in `shell.js` keeps working exactly as it does.

5. **Toast stacking.** `showCompletionToast` appends a fresh node to `toastContainerEl` with
   an 8 s timer and no cap. Six completions in a rolling sequence stack six toasts, which is
   the same spam complaint in a different pixel. Cap the container at one completion toast:
   a new completion replaces the standing one. Terminal-error toasts
   (`.completion-toast.is-error`) are a different class and must not be evicted by a
   completion.

6. **8 s is long for a notice that also has two durable surfaces.** Reduce the completion
   toast's dwell to 4 s. Leave the error toast at 8 s — an error is not redundant with
   anything.

7. **Do not touch the shell rail.** The pulse is already one-shot and self-expiring; it is
   the only cross-panel signal. Changing it would remove the completion notice for an
   operator sitting on the Kanban board.

8. **Do not write anything into a terminal buffer.** The alternative "put it in the
   terminal" is explicitly prohibited in this file and would corrupt a TUI's screen model.

## Proposed Changes

### 1. `src/webview/terminals.js` — delete the pane-header `DONE` badge

In `updatePaneElement`, remove the `terminalBadges` block and leave the `terminalReplayGaps`
block immediately after it intact.

```js
-            if (terminalBadges.has(assignedName)) {
-                const badgeSpan = document.createElement('span');
-                badgeSpan.className = 'pane-badge';
-                badgeSpan.textContent = terminalBadges.get(assignedName).label;
-                titleEl.appendChild(badgeSpan);
-            }
+            // No DONE badge here. One completion used to paint four surfaces at once —
+            // the shell rail pulse, the sidebar row chip, THIS chip, and a toast — three
+            // of them inside the same panel in the same glance. This one was the least
+            // useful of the four: it sits on the chrome of a terminal the operator is
+            // already watching, duplicates the sidebar row a few inches away, and
+            // competes for a header row where .pane-title-name is the only shrinkable
+            // child. terminalBadges is unchanged and still drives the sidebar chip and
+            // the rail; do not re-add a reader here.
             if (terminalReplayGaps.has(assignedName)) {
                 const gapBadge = document.createElement('span');
                 gapBadge.className = 'pane-badge is-gap';
                 gapBadge.textContent = 'GAP';
                 …
```

### 2. `src/webview/terminals.js` — one completion toast at a time, shorter dwell

```js
    /** Completion toasts do not stack: a rolling batch would otherwise fill the
     *  container with identical notices, which is the same spam in different pixels.
     *  Error toasts (.is-error) are a different signal and are never evicted here. */
    function showCompletionToast(title, role, termName) {
        if (!toastContainerEl) { return; }
        toastContainerEl
            .querySelectorAll('.completion-toast:not(.is-error)')
            .forEach(el => el.remove());

        const toast = document.createElement('div');
        toast.className = 'completion-toast';
        …
        toastContainerEl.appendChild(toast);

        // 4s, not 8s. The sidebar chip is the durable record and the rail carries the
        // cross-panel signal, so the toast only has to be SEEN, not read twice.
        setTimeout(() => {
            if (toast.parentNode) { toast.parentNode.removeChild(toast); }
        }, 4000);
    }
```

### 3. `src/webview/shell.js` — correct the comment that justified the removed surface

```js
             // The done ring is a one-shot ANIMATION, not a state class: it plays for
             // DONE_PULSE_MS from the push that carried a new completion stamp, and is
             // simply absent on every push after that window closes. A terminal that
-            // completed a minute ago wears no ring — the sidebar DONE chip and the
-            // pane badge in the Terminals panel remain the durable record of an
-            // unacknowledged completion.
+            // completed a minute ago wears no ring — the sidebar DONE chip in the
+            // Terminals panel is the durable record of an unacknowledged completion.
+            // (The pane-header badge that used to be the second durable surface was
+            // removed: three simultaneous DONE surfaces inside one panel is spam.)
```

## Verification Plan

1. **The reported repro.** Trigger one agent completion with the completed terminal seated
   in a visible pane. Expect exactly three signals: a rail pulse, a sidebar row chip, and a
   toast. Expect **no** `DONE` chip on the pane header.
2. **`GAP` badge survives.** Disconnect a terminal's socket long enough for the gateway ring
   to evict output, then reconnect. Expect the `GAP` chip to appear in the pane header as
   before. This is the assertion that the deletion was surgical.
3. **Sidebar chip survives and still clears.** Confirm the chip appears on the row, then
   click the row. Confirm it clears from the sidebar and the rail pulse stops on the next
   push.
4. **Rail acknowledge path.** With a pop-out already open for the completed terminal, click
   its rail icon. Confirm the `clearTerminalBadge` arm still clears the sidebar chip — this
   path calls `renderPaneGrid()` and must not have been made a no-op.
5. **Toast coalescing.** Dispatch and complete four terminals in quick succession. Expect at
   most one completion toast on screen at any moment, showing the most recent.
6. **Error toasts are not evicted.** Force a terminal error, then trigger a completion within
   4 s. Expect the error toast to remain while the completion toast appears and expires.
7. **Terse layouts.** In a `3x3` grid, confirm the pane header now has room for its title
   without ellipsising as early as before — the removed chip was `flex-shrink: 0` and was
   taking width from `.pane-title-name`.
8. **Nothing written to a buffer.** Grep the diff for `term.write` — expect zero additions.
9. `node --check src/webview/terminals.js` and `node --check src/webview/shell.js` clean.
