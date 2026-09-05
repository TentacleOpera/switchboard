# The Backlog View Cannot Be Exited in Standalone

kanbanColumn: CREATED

## Goal

Toggling between New and Backlog repaints the column in both hosts. Today it repaints in the extension only, and a standalone operator has to kill the server to get out.

### Problem analysis

**Observed 2026-09-05.** On the standalone host, switching the New column into Backlog view could not be undone. The toggle button did not restore the column; the server had to be killed and restarted, which forces a full page load and rebuilds the columns from scratch.

**BACKLOG is a display mode of CREATED**, not a column of its own (`agentConfig.ts:218`). Toggling it moves no cards — it changes only how one column renders.

**The state lives on the host.** The client posts `toggleBacklogView` and waits to be told the new value; it does not flip its own flag. The handler is correct and symmetric (`KanbanProvider.ts:12840-12844`): it inverts `_showingBacklog`, posts `backlogViewState`, and refreshes.

**Two client paths set the flag, and only one repaints:**

```js
// backlogViewState (kanban.html:11316) — the toggle's own reply
showingBacklog = event.data.showing;
renderColumns();              // repaints the column and its mode
renderBoard(currentCards);
updateAllColumnAgents();

// updateBoard (kanban.html:10973) — the refresh that follows
if (typeof msg.showingBacklog !== 'undefined') {
    showingBacklog = msg.showingBacklog;
}
                              // no renderColumns()
```

`renderBoard` is further gated on the card signature changing. Toggling a display mode moves no cards, so the signature is identical and even that repaint is skipped.

**In standalone the repainting path never arrives.** `KanbanProvider.postMessage` has no route to the browser client — a repo-wide search finds no `postMessage` wiring in `bootstrap.ts`, only a comment referring to one. So the browser receives the `updateBoard` path alone: the variable flips, nothing redraws, and the column keeps rendering its previous mode until the page is reloaded.

**This is a composition-root divergence, the fourth found on 2026-09-05** alongside the managed-block refresh, the protocol scaffolder and auto-archive. In each, a capability is wired in `extension.ts`, absent from `bootstrap.ts`, and silent — nothing errors, so no gate catches it. `CLAUDE.md` opens by naming this exact trap.

## Metadata

- **Complexity:** 3
- **Tags:** kanban, webview, standalone-parity, bugfix

## User Review Required

None.

## Proposed Changes

### 1. Route `KanbanProvider.postMessage` to the browser client in standalone

This is the fix. `backlogViewState` is one message among many on that channel, so anything else the provider pushes is equally lost today — the toggle is the symptom that happened to be noticed.

Establish what else uses that path before assuming this is the only casualty.

### 2. The `updateBoard` path must repaint the column when the mode changes

Defence in depth, and correct regardless of the transport. If `showingBacklog` differs from what the column is currently rendering, `renderColumns()` has to run — a state change with no repaint is a lie on screen.

Do not make it repaint unconditionally; that would repaint on every board refresh. Gate it on the value actually changing.

### 3. Do not fix this by having the client flip its own flag

The client asking the host and being told is the right shape — it keeps one owner of the state. A client that toggles optimistically and then disagrees with the host is a worse bug than the one being fixed.

## Edge-Case & Dependency Audit

1. **`renderBoard` is gated on the card signature.** Any fix that relies on it running will not fire, because a display-mode toggle moves no cards. `renderColumns()` is the call that matters.
2. **The extension path must not regress.** `backlogViewState` already works there; the change is to make standalone match, not to replace the working path.
3. **Check what else `postMessage` carries.** If the channel is dead in standalone, the toggle is unlikely to be its only user.
4. **A page reload masks it**, which is why this reads as intermittent — anything that reloads the board appears to fix it.
5. **DISPATCH is the other display mode** (`DISPLAY_MODE_COLUMNS`, of PLAN REVIEWED). It almost certainly has the same defect; check it in the same pass.

## Verification Plan

1. On standalone, toggling to Backlog and back repaints the column both ways, with no reload.
2. The same toggle still works on the extension host.
3. Toggling with no cards on the board still repaints — the fix does not depend on the card signature.
4. The DISPATCH display mode toggles correctly in both hosts.
5. Whatever else `KanbanProvider.postMessage` carries reaches the standalone client.
