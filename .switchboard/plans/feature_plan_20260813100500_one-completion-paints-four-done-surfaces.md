# One Completion Notice, In One Window — Cut the Terminals Panel's Four DONE Surfaces to Two

## Goal

Make an agent completion produce **one notice, in the cockpit**, instead of four
simultaneous surfaces in every open browser window. Two defects compose into the same
complaint and are fixed together because they live in the same two functions:

1. **Too many surfaces.** A single completion lights the shell rail, the Terminals sidebar
   row, the pane header inside the terminal frame, and a toast. Three of the four are inside
   the same panel, visible in the same glance.
2. **Too many windows.** Every `?solo=<name>` terminal pop-out is a full second copy of the
   Terminals panel document, so it renders the same notice the cockpit does — for every
   completion in the workspace, including terminals that pop-out does not display.

Pop three terminals out, finish one agent, and the operator gets a rail pulse, a sidebar
chip, a pane chip and a toast **in the cockpit**, plus a pane chip and a toast in each of
three pop-out windows. This plan cuts that to a rail pulse, a sidebar chip and one toast, in
the cockpit only.

This plan owns **`src/webview/terminals.js` and `src/webview/shell.js` outright** — every
webview change in the Completion Signalling feature is here, so no second stream ever edits
`handleAgentCompleted` or `showCompletionToast` concurrently. It touches no backend file.

### The problem — surfaces

Finish one agent turn and the browser Switchboard produces, all at once:

1. A pulsing ring on that terminal's icon in the **shell rail** (left strip).
2. A `DONE` chip on that terminal's row in the **Terminals sidebar**.
3. A `DONE` chip in the **pane header** of the terminal's own frame in the grid.
4. A **toast** in the Terminals panel's toast container.

Items 2, 3 and 4 are inside the same panel, visible in the same glance. Item 3 is the worst
of them: it sits on the chrome of the terminal the operator is *already watching*, on a
header row that is width-critical, and it tells them nothing the live output below it does
not already show. With a nine-terminal run finishing in a rolling sequence, the panel becomes
a wall of `DONE` chips over live terminals — and the toasts stack, because
`showCompletionToast` appends without a cap.

### The problem — windows

Open the browser Switchboard, pop three terminals out into their own windows (the strip
button, or a pane's **Pop out** button). When any agent finishes, four toasts appear
simultaneously: one in the cockpit and one in each of the three pop-outs. A pop-out showing
`coder-1` announces the completion of `planner-2`, which it does not display and cannot act
on. With a nine-terminal run and several pop-outs open, one completion produces a wall of
identical notices across every window on the screen.

### Root cause — surfaces

There is one signal and four independent renderers, all keyed off the same map. The signal
is set once, in `handleAgentCompleted` (`src/webview/terminals.js:7865`):

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

*Sidebar row* (`renderTerminalRow`, `:2134-2138`):

```js
if (terminalBadges.has(item.friendlyName)) {
    const badge = document.createElement('span');
    badge.className = 'pane-badge';
    badge.textContent = terminalBadges.get(item.friendlyName).label;
    info.appendChild(badge);
}
```

*Pane header* (`updatePaneElement`, `:4571-4576`) — the same map, the same class, a second
time:

```js
if (terminalBadges.has(assignedName)) {
    const badgeSpan = document.createElement('span');
    badgeSpan.className = 'pane-badge';
    badgeSpan.textContent = terminalBadges.get(assignedName).label;
    titleEl.appendChild(badgeSpan);
}
```

*Shell rail* (`postFleetStateToShell` → `shell.js` `renderTerminalSection`, `:487-504`):

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

There is also a comment in `shell.js` (`:508-513`) that names all three durable surfaces as
intentional, which is how the stack survived review:

> A terminal that completed a minute ago wears no ring — the sidebar DONE chip and the
> pane badge in the Terminals panel remain the durable record of an unacknowledged
> completion.

That comment is the rationale for the state this plan removes. It is a rationale, not a
constraint — the pane badge is being deleted, so the comment goes with it.

### Root cause — windows

A pop-out is not a lightweight view — it is a **full second copy of the Terminals panel
document**. `shell.js` opens it as:

```js
const popoutUrl = `/terminals?solo=${encodeURIComponent(data.name)}`;
popout = window.open(popoutUrl, popoutName, features);
```

That route is served by the same `headlessPanelHtml` getter as the cockpit's Terminals
iframe, with the same `data-panel="terminals"` body attribute. `soloTerminalName` is read
from the query string (`terminals.js:134-140`) and CSS (`body.is-solo`) hides the sidebar,
toolbar and tab strip — but the JavaScript is unchanged. Every pop-out therefore:

1. Runs `transport.js`, which reads `document.body.dataset.panel` and subscribes to
   `surfaces=terminals,common`.
2. Installs the same `window.addEventListener('message', …)` handler, including the
   `agentCompleted` arm at `:987`.
3. Runs the full `handleAgentCompleted` body — badge write, two re-renders, a fleet refetch,
   and the toast.

The broadcast itself is correct and is meant to be workspace-wide: `SURFACES.common` is
delivered to every subscribed connection by design — that is how a panel that was not focused
still learns the state changed. The defect is not the fan-out; it is that **every recipient
renders a user-facing notification**, with no concept of which document owns the notification
surface.

There is a second, smaller half of the same defect. Each pop-out's `handleAgentCompleted`
also runs the state half — `terminalBadges.set(...)`, `renderSidebarList()`,
`renderPaneGrid()`, `postFleetStateToShell()` and an unconditional `fetchTerminalList()` —
for terminals it does not show. In a solo document the sidebar is `display:none` and the
grid holds exactly one pane, so the renders are wasted, and the refetch means one completion
triggers N+1 `ptyListTerminals` round trips instead of one.

### Background context

- `showTerminalErrorToast` (`:7937`) is **not** affected and must not be changed: it fires
  from `ws.onmessage` on a specific terminal's own socket, so it only reaches documents
  actually attached to that terminal. That is already the correct scoping.
- `showPaneToast` is local action feedback (unassign undo, popup blocked, all-panes-pinned).
  It is only ever called from a user gesture in that document. Also unaffected.
- `handleAgentCompleted`'s badge is the durable record of an unacknowledged completion, and
  the shell rail reads it via `postFleetStateToShell`. The badge belongs to the **cockpit**,
  which is the document whose sidebar and grid actually render it.
- The sibling backend subtask adds a `planCount` field to the `agentCompleted` payload (the
  size of the agent's whole turn, so a six-subtask feature dispatch reports six plans rather
  than naming one). Rendering it is this plan's job, and the renderer must tolerate its
  absence.

### The resulting design

| Surface | Keep? | Why |
| :--- | :--- | :--- |
| Shell rail pulse | **Keep** | The only completion signal visible when the operator is on another panel (Kanban, Tickets, Project). Already self-expiring after 2.2 s. |
| Sidebar row `DONE` chip | **Keep** | The durable, per-terminal record of an *unacknowledged* completion, and the thing the operator scans when returning to the panel. Clears on focus/peek/acknowledge. |
| **Pane header `DONE` chip** | **Remove** | On the chrome of a terminal the operator is already looking at; duplicates the sidebar row four inches away; competes for a width-critical header row. |
| Toast | **Keep, one at a time, cockpit only** | The transient announcement. Currently unbounded (N completions stack N toasts) and rendered in every open window. |

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## User Review Required

None. The one judgement call — *which* document owns the notification — is decided: the
cockpit panel (`!soloTerminalName`). A pop-out is a viewport onto one terminal that the
operator is already watching; it is the surface with the least need for a notice about a
different terminal, and the cockpit is guaranteed to exist whenever a pop-out does (pop-outs
are opened from it).

## Complexity Audit

### Routine

- One early-return guard at the top of one function.
- One render block deleted; the block immediately after it left intact.
- One toast function rewritten: a `querySelectorAll` sweep, a dwell constant, one extra
  parameter.
- One stale comment corrected in `shell.js`.

### Complex / Risky

- `terminalBadges` is also the **badge-clearing** trigger. `assignToFocusedPane`,
  `locateTerminal`, the `focusTerminal` message arm and the `clearTerminalBadge` message arm
  all delete from it and then call `renderPaneGrid()`. Removing the pane render must not
  remove those `renderPaneGrid()` calls — they exist for other reasons (seating, peek,
  plan-strip refresh) and the sidebar re-render is the one that matters for the badge.
- The solo guard sits above the badge write, so it changes what a pop-out *stores*, not just
  what it *shows*. Confirm nothing else in a solo document reads `terminalBadges` (the rail
  is a shell concern and a pop-out has no shell parent).
- Four edits land in two functions that a previous version of this feature had three separate
  plans editing concurrently. Consolidating them here is deliberate — do not split them back
  out across streams.

## Edge-Case & Dependency Audit

### Side Effects

1. **The `GAP` badge shares the render site and the class.** `terminalReplayGaps` renders a
   `.pane-badge.is-gap` chip immediately below the `DONE` block in `updatePaneElement`
   (`:4577-4583`). It must **stay** — it reports that scrollback was evicted while the pane
   was disconnected, which is information about *this pane's buffer* and has no other
   surface. Delete only the `terminalBadges` block.
2. **`.pane-badge` CSS must survive.** It styles the `GAP` chip and the sidebar `DONE` chip.
   Do not remove the rule; only the `.pane-badge` usage inside `updatePaneElement`'s
   `terminalBadges` block goes.
3. **Badge clearing still needs the pane re-render.** Every clear site pairs
   `renderSidebarList()` with `renderPaneGrid()`. Leave both — the grid re-render also
   retires the plan strip and refreshes the pane title, which is not badge work.
4. **The rail's `doneStamp` is read from `terminalBadges`.** Untouched by this change, so the
   pulse-resume arithmetic in `shell.js` keeps working exactly as it does.
5. **Toast stacking.** `showCompletionToast` appends a fresh node to `toastContainerEl` with
   an 8 s timer and no cap. Six completions in a rolling sequence stack six toasts, which is
   the same spam complaint in different pixels. Cap the container at one completion toast: a
   new completion replaces the standing one. Terminal-error toasts
   (`.completion-toast.is-error`) are a different class and must not be evicted by a
   completion.
6. **8 s is long for a notice that also has two durable surfaces.** Reduce the completion
   toast's dwell to 4 s. Leave the error toast at 8 s — an error is not redundant with
   anything.
7. **Do not touch the shell rail's pulse behaviour.** It is already one-shot and
   self-expiring; it is the only cross-panel signal. Changing it would remove the completion
   notice for an operator sitting on the Kanban board. Only the *comment* changes.
8. **Do not write anything into a terminal buffer.** The alternative "put it in the terminal"
   is explicitly prohibited in this file and would corrupt a TUI's screen model.
9. **`showCompletionToast` has no `toastContainerEl` guard** today (`:7900`), unlike
   `showTerminalErrorToast` (`:7938`). Add one while rewriting the function — the new
   `querySelectorAll` call would throw on a null container.

### Dependencies & Conflicts

10. **A pop-out showing the terminal that just completed.** It gets no toast under this
    change. That is correct: the operator is looking at that terminal's live output, which is
    a stronger signal than a toast summarising it. The cockpit still toasts, and the cockpit's
    badge/rail state is unchanged.
11. **Cockpit closed, pop-out open.** Not reachable in practice — a pop-out is opened by
    `shell.js` from the cockpit, and closing the cockpit tab leaves the pop-out with no
    notifier. Accepted: the terminal's own output is in front of the operator. Do not add a
    "promote a pop-out to notifier" election; it would need cross-document coordination for a
    case that costs the operator nothing.
12. **The panel loaded by direct navigation to `/terminals`** (no shell, no `solo` param).
    `soloTerminalName` is null, so it behaves as a cockpit and toasts. Correct — it is the
    only Terminals surface open.
13. **The extension-host webview.** Never solo (`?solo=` is a browser-shell URL), so
    behaviour there is unchanged.
14. **State vs. notification in a solo document.** The badge, the re-renders and the refetch
    are skipped in a solo document too, but for a different reason (waste, not duplication).
    Skipping them must not break the one thing a solo document needs from this message:
    nothing. Its single pane is driven by its own WebSocket, and `fetchTerminalList` still
    runs on the 5 s poll and on `terminalsChanged`.
15. **`postFleetStateToShell()` from a pop-out.** A pop-out has no shell parent
    (`window.parent === window`), so this is already a no-op there; removing the call from the
    solo path removes a wasted call, not a behaviour.
16. **Older clients.** A cached webview from a previous version has no `soloTerminalName`
    guard and will keep toasting in pop-outs until reload. Acceptable — no persisted state is
    involved, so a reload is the whole migration.
17. **`planCount` may be absent.** An older host, a host that has not yet landed the sibling
    backend subtask, or a single-plan turn all produce no field. The renderer falls through to
    the plain title. This plan can therefore land **before or after** the backend subtask;
    only the rendered text differs.
18. **Cross-feature contention (do not dispatch concurrently).** This plan deletes a block
    from `updatePaneElement`'s title row. The *Pane Fidelity* feature's **Pane Header No
    Longer Shows the Agent Role** subtask rewrites that same block. A textual conflict is
    near-certain.
19. **`agentCompleted` has exactly one consumer.** Grep `src/webview/` before and after —
    `terminals.js` is the only file that handles the message, so no other panel loses a
    notice.

### Race Conditions

20. **Toast eviction mid-render.** The `querySelectorAll(...).forEach(el => el.remove())`
    sweep runs synchronously before the new node is appended, so a completion arriving while
    a previous toast's 4 s timer is pending simply removes the node early; the pending
    `setTimeout` then finds `toast.parentNode` null and no-ops. No leak, no double-remove.

### Security

- No new input is rendered. `planCount` is coerced with `Number(...)` and interpolated into
  `textContent`, never `innerHTML`.

## Dependencies

- None blocking. The sibling backend subtask supplies `planCount`; its absence is tolerated.

## Adversarial Synthesis

**Risk Summary.** The real risks are surgical rather than architectural: deleting the wrong
`.pane-badge` block (the `GAP` chip lives one line below and has no other surface), and
letting the solo guard's early return strip a `renderPaneGrid()` that other badge-clearing
paths depend on. Both are covered by targeted verification steps. The one behavioural
judgement — the cockpit owns the notice, a pop-out gets nothing — is deliberate and is safe
because a pop-out is by construction opened from a cockpit that is still watching.

## Proposed Changes

### 1. `src/webview/terminals.js` — the cockpit owns the completion notice

Guard `handleAgentCompleted` (`:7865`) at the top. Both halves — the badge/render state and
the toast — belong to the cockpit.

```js
    /**
     * Workspace-wide completion push. Delivered to EVERY subscribed connection by
     * design (SURFACES.common), which includes every `?solo=<name>` pop-out — each one
     * is a full second copy of this document, not a lightweight view. Without this
     * guard, one completion produced one toast per open window, and each pop-out also
     * ran a badge write, two re-renders and a ptyListTerminals refetch for a terminal
     * it does not display.
     *
     * The COCKPIT owns this notice. It is the document that renders the sidebar DONE
     * chip and relays the rail state, and it is guaranteed to exist whenever a pop-out
     * does (shell.js opens pop-outs from it). A pop-out showing the completed terminal
     * has the terminal's own output in front of the operator, which is a stronger
     * signal than a toast summarising it.
     *
     * Deliberately NOT applied to showTerminalErrorToast: that fires from a specific
     * terminal's own socket, so it only reaches documents attached to that terminal —
     * already correctly scoped.
     */
    function handleAgentCompleted(msg) {
        if (soloTerminalName) { return; }
        const { planTitle, role, terminalName, worktreePath } = msg;
        // … unchanged body …
        showCompletionToast(planTitle || 'Agent Task', role || 'Agent', targetTerm, msg.planCount);
    }
```

Placing the guard at the function top (rather than only around `showCompletionToast`) is
deliberate — it removes the wasted badge write, the two re-renders and the extra
`fetchTerminalList()` from every pop-out on the same line.

### 2. `src/webview/terminals.js` — delete the pane-header `DONE` badge

In `updatePaneElement` (`:4571`), remove the `terminalBadges` block and leave the
`terminalReplayGaps` block immediately after it intact.

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

### 3. `src/webview/terminals.js` — one toast at a time, shorter dwell, turn-aware text

```js
    /** Completion toasts do not stack: a rolling batch would otherwise fill the
     *  container with identical notices, which is the same spam in different pixels.
     *  Error toasts (.is-error) are a different signal and are never evicted here. */
    function showCompletionToast(title, role, termName, planCount) {
        if (!toastContainerEl) { return; }
        toastContainerEl
            .querySelectorAll('.completion-toast:not(.is-error)')
            .forEach(el => el.remove());

        const toast = document.createElement('div');
        toast.className = 'completion-toast';
        …
        const bodyEl = document.createElement('div');
        bodyEl.className = 'toast-body';
        // planCount is the size of the agent's whole TURN, supplied by the engine.
        // Additive on the wire — an older host omits it, and a single-plan turn is the
        // common case, so both fall through to the plain title.
        const n = Number(planCount);
        const scope = Number.isFinite(n) && n > 1 ? `${title} +${n - 1} more` : title;
        bodyEl.textContent = scope + (termName ? ` (${termName})` : '');
        …
        toastContainerEl.appendChild(toast);

        // 4s, not 8s. The sidebar chip is the durable record and the rail carries the
        // cross-panel signal, so the toast only has to be SEEN, not read twice.
        setTimeout(() => {
            if (toast.parentNode) { toast.parentNode.removeChild(toast); }
        }, 4000);
    }
```

Leave `showTerminalErrorToast`'s 8 s timer and its own container guard alone.

### 4. `src/webview/shell.js` — correct the comment that justified the removed surface

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

### Automated Tests

*(Not executed in this planning session — the dispatching prompt carried SKIP TESTS and SKIP
COMPILATION. The coder runs them.)*

1. `node --check src/webview/terminals.js` and `node --check src/webview/shell.js` clean.
2. Grep the diff for `term.write` — expect zero additions (nothing may be written into a
   terminal buffer).
3. Grep `src/webview/` for `agentCompleted` — confirm `terminals.js` remains the only
   consumer, so no other panel silently lost the message.

### Manual

4. **The reported repro — surfaces.** Trigger one agent completion with the completed
   terminal seated in a visible pane. Expect exactly three signals: a rail pulse, a sidebar
   row chip, and a toast. Expect **no** `DONE` chip on the pane header.
5. **The reported repro — windows.** Pop three terminals out, then trigger a completion.
   Expect exactly **one** toast, in the cockpit, and none in any pop-out.
6. **Pop-out showing the completed terminal.** Pop out `coder-1`, dispatch to `coder-1`, let
   it complete. Expect no toast in that pop-out and one in the cockpit. Confirm the cockpit
   still shows the sidebar `DONE` chip and the shell rail still pulses.
7. **No wasted refetch.** With the network panel open in a pop-out, trigger a completion.
   Expect zero `POST /terminals/verb/ptyListTerminals` calls attributable to the completion in
   that window (the 5 s poll still runs — count only the burst at completion time).
8. **Direct navigation.** Open `/terminals` directly (no shell, no `solo` param). Trigger a
   completion. Expect a toast — this surface is a cockpit, not a pop-out.
9. **`GAP` badge survives.** Disconnect a terminal's socket long enough for the gateway ring
   to evict output, then reconnect. Expect the `GAP` chip in the pane header as before. This
   is the assertion that the deletion was surgical.
10. **Sidebar chip survives and still clears.** Confirm the chip appears on the row, then
    click the row. Confirm it clears from the sidebar and the rail pulse stops on the next
    push.
11. **Rail acknowledge path.** With a pop-out already open for the completed terminal, click
    its rail icon. Confirm the `clearTerminalBadge` arm still clears the sidebar chip — this
    path calls `renderPaneGrid()` and must not have been made a no-op.
12. **Toast coalescing.** Dispatch and complete four terminals in quick succession. Expect at
    most one completion toast on screen at any moment, showing the most recent.
13. **Error toasts are not evicted.** Force a terminal error, then trigger a completion within
    4 s. Expect the error toast to remain while the completion toast appears and expires.
14. **Error toasts still reach pop-outs.** Kill a pty a pop-out is attached to. Expect that
    pop-out's terminal-error toast to still appear — the guard must not have leaked into
    `showTerminalErrorToast`.
15. **Local toasts unaffected.** In a pop-out, trigger a `showPaneToast` path (e.g. paste an
    oversized image). Expect the toast to appear in that window.
16. **Turn-aware text.** With the sibling backend subtask landed, confirm a six-plan turn
    renders `<first plan title> +5 more (coder-1)` and a one-plan turn renders exactly what it
    does today. Without it landed, confirm the plain title still renders.
17. **Terse layouts.** In a `3x3` grid, confirm the pane header now has room for its title
    without ellipsising as early as before — the removed chip was `flex-shrink: 0` and was
    taking width from `.pane-title-name`.

---

**Recommendation:** Complexity 4 → **Send to Coder.**

## Implementation Summary

Implemented completion notice consolidation across terminals webview and shell. Added a `soloTerminalName` guard to `handleAgentCompleted` in `src/webview/terminals.js` so solo pop-out windows do not duplicate badges, refetches, or toasts. Removed the redundant `terminalBadges` DONE chip rendering from `updatePaneElement` while preserving the `GAP` badge. Updated `showCompletionToast` to deduplicate active completion toasts, incorporate optional `planCount` turn-aware formatting, and reduce dwell time from 8s to 4s. Updated the rationale comment in `src/webview/shell.js` to match the two-surface model.
