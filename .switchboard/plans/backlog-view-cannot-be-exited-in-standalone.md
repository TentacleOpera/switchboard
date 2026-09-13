# The Backlog View Cannot Be Exited in Standalone

kanbanColumn: CREATED

## Goal

Toggling between New and Backlog repaints the column in both hosts. Today it repaints in the extension only, and a standalone operator has to kill the server to get out.

### Problem analysis

**Observed 2026-09-05.** On the standalone host, switching the New column into Backlog view could not be undone. The toggle button did not restore the column; the server had to be killed and restarted, which forces a full page load and rebuilds the columns from scratch.

**BACKLOG is a display mode of CREATED**, not a column of its own (`agentConfig.ts:218`). Toggling it moves no cards — it changes only how one column renders.

**The state lives on the host.** The client posts `toggleBacklogView` and waits to be told the new value; it does not flip its own flag. The handler is correct and symmetric (`KanbanProvider.ts:12990-12994`): it inverts `_showingBacklog`, posts `backlogViewState`, and calls `refresh()`.

**Two client paths set the flag, and only one repaints:**

```js
// backlogViewState (kanban.html:12132) — the toggle's own reply
showingBacklog = event.data.showing;
renderColumns();              // repaints the column and its mode
renderBoard(currentCards);
updateAllColumnAgents();

// updateBoard (kanban.html:11789) — the refresh that follows
if (typeof msg.showingBacklog !== 'undefined') {
    showingBacklog = msg.showingBacklog;
}
                              // no renderColumns()
```

`renderBoard` is further gated on the card signature changing. Toggling a display mode moves no cards, so the signature is identical and even that repaint is skipped.

> **Superseded:** The original analysis concluded: "In standalone the repainting path never
> arrives. `KanbanProvider.postMessage` has no route to the browser client — a repo-wide
> search finds no `postMessage` wiring in `bootstrap.ts`, only a comment referring to one."
> **Reason:** The search looked for the literal string `postMessage` in `bootstrap.ts` and
> found nothing — but the wiring is via the broadcaster, not a literal `postMessage` call.
> `headlessBroadcaster = new BroadcastHub(...)` at `bootstrap.ts:1499` is assigned to
> `kanbanProvider._broadcaster` at `:1632`. `kanbanProvider.setApiServer(server)` at `:5155`
> wires the WS hub. `KanbanProvider.postMessage` (`:2507`) checks `if (this._broadcaster)`
> FIRST — in standalone, it is set — so `postMessage` → `_broadcaster.push()` →
> `mirrorToWs()` → `apiServer.broadcastWs()` → `wsHub.broadcast()`. The `backlogViewState`
> message passes no surface tag, and `wsHub.broadcast` (`wsHub.ts:471`) delivers untagged
> pushes to ALL connections (`if (surface && meta.surfaces && !meta.surfaces.has(surface))
> continue` — surface is undefined, so the skip is bypassed). The `backlogViewState` message
> reaches the browser, and the handler at `kanban.html:12132` calls `renderColumns()` — it
> repaints.
>
> Furthermore, `refresh()` at `KanbanProvider.ts:2072` is `if (this._panel) { ... }` —
> standalone has no panel, so `refresh()` is a **no-op**. No `updateBoard` follows the
> toggle. The repaint from `backlogViewState` is the only thing that happens, and it is
> correct.
>
> **Replaced with:** The `postMessage` → broadcaster → WS route IS wired in standalone.
> Change 1 ("Route `KanbanProvider.postMessage` to the browser client in standalone") is
> based on a false premise — the route already exists. The plan must first verify whether
> the bug still reproduces. If it does, the root cause is elsewhere (a race, a WS connection
> timing issue, or a different message path). Change 2 (make `updateBoard` repaint on mode
> change) remains valid as defence-in-depth regardless of the root cause.

## Metadata

- **Complexity:** 3
- **Tags:** kanban, webview, standalone-parity, bugfix

## User Review Required

None.

## Complexity Audit

### Routine
- Making the `updateBoard` handler call `renderColumns()` when `showingBacklog` changes (Change 2) — a small, gated addition to an existing handler.

### Complex / Risky
- Verifying whether the reported bug still reproduces. The original root cause (missing `postMessage` wiring) is wrong — the broadcaster is wired. If the bug still reproduces, finding the real root cause may require investigating WS connection timing, message ordering, or a race between `backlogViewState` and other pushes.

## Adversarial Synthesis

Key risks: the plan's root cause is factually wrong — `postMessage` IS wired to the browser
in standalone via the broadcaster → WS path, so `backlogViewState` reaches the browser and
repaints; `refresh()` is a no-op (no panel), so no `updateBoard` follows to overwrite the
repaint. The plan may be chasing a bug that no longer exists, or whose root cause is
different. Mitigations: verify reproduction before implementing; keep Change 2 as
defence-in-depth (a state change with no repaint is a lie on screen regardless of transport).

## Proposed Changes

### 1. No code change — the bug is already fixed

> **Superseded:** The original Change 1 proposed: "Route `KanbanProvider.postMessage` to the
> browser client in standalone."
> **Reason:** The route already exists. `postMessage` → `_broadcaster.push()` →
> `mirrorToWs()` → `broadcastWs()` → `wsHub.broadcast()` delivers untagged pushes (like
> `backlogViewState`) to all WS connections, including the kanban browser panel. The
> `backlogViewState` handler at `kanban.html:12132` calls `renderColumns()` and repaints.
> `refresh()` is a no-op in standalone (no `_panel`), so no `updateBoard` follows.
> **Replaced with:** Reproduction confirmed the bug no longer reproduces — the
> `backlogViewState` message reaches the browser via the broadcaster → WS path and the
> handler repaints correctly. Change 2 (defence-in-depth) is the only code change in this
> plan.

### 2. The `updateBoard` path must repaint the column when the mode changes

Defence in depth, and correct regardless of the transport. If `showingBacklog` differs from
what the column is currently rendering, `renderColumns()` has to run — a state change with
no repaint is a lie on screen.

Do not make it repaint unconditionally; that would repaint on every board refresh. Gate it
on the value actually changing.

### 3. Do not fix this by having the client flip its own flag

The client asking the host and being told is the right shape — it keeps one owner of the state. A client that toggles optimistically and then disagrees with the host is a worse bug than the one being fixed.

## Edge-Case & Dependency Audit

1. **`renderBoard` is gated on the card signature.** Any fix that relies on it running will not fire, because a display-mode toggle moves no cards. `renderColumns()` is the call that matters.
2. **The extension path must not regress.** `backlogViewState` already works there; the change is to make standalone match, not to replace the working path.
3. **The `postMessage` route is wired.** The broadcaster (`bootstrap.ts:1632`) and the WS hub (`bootstrap.ts:5155`) are both set. Any future investigation should start from the WS delivery path, not from a missing-wiring assumption.
4. **A page reload masks it**, which is why this reads as intermittent — anything that reloads the board appears to fix it.
5. **DISPATCH is the other display mode** (`DISPLAY_MODE_COLUMNS`, of PLAN REVIEWED). It uses the same `renderColumns()` repaint path. If the `backlogViewState` route works, DISPATCH works too — but verify, do not assume.

## Dependencies

None — this plan is self-contained within `src/webview/kanban.html` and `src/services/KanbanProvider.ts`.

## Verification Plan

1. On standalone, toggling to Backlog and back repaints the column both ways, with no reload.
2. The same toggle still works on the extension host.
3. Toggling with no cards on the board still repaints — the fix does not depend on the card signature.
4. The DISPATCH display mode toggles correctly in both hosts.
5. The bug no longer reproduces — confirmed by the user. Change 2 (defence-in-depth) is the only code change.

### Goal Invariants

- Assert `KanbanProvider.postMessage` routes through `_broadcaster.push()` in standalone (the broadcaster is set at `bootstrap.ts:1632`).
- Assert the `updateBoard` handler in `src/webview/kanban.html` calls `renderColumns()` when `msg.showingBacklog` differs from the current `showingBacklog` value (Change 2).
- Assert the `backlogViewState` handler at `kanban.html:12132` calls `renderColumns()` (existing behaviour, must not regress).
