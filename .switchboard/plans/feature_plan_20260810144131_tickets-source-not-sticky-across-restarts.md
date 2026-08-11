# Tickets Tab Source Selection Not Sticky Across Restarts in Browser/Standalone

## Goal

### Problem Analysis

In the browser/standalone Switchboard UI, the Tickets tab does not restore the user's
last-selected source (integration provider, ClickUp space/folder/list, or Linear project)
across restarts. The user must manually re-navigate to their desired list/space every time
they start up Switchboard.

### Background Context

The Tickets panel was extracted from the Planning panel into a standalone webview panel
(plan `tickets-panel-2-extract-tickets-tab-into-standalone-panel`). The extraction moved
the tickets UI into `tickets.html` / `tickets.js` and the backend into
`TicketsPanelProvider.ts`. The state persistence mechanism was partially migrated:

- **Saving works**: `saveTicketsState()` in `tickets.js` calls `persistTab('tickets', state, root)`
  which sends a `persistTabState` message to the provider. The provider stores it in
  `PanelStateStore` (backed by `vscode.Memento` in the extension, or a file-backed memento
  in standalone mode writing to `standalone-state.json`).
- **Restoring does NOT work**: The `TicketsPanelProvider.fetchRoots` handler (line 1128)
  only sends `rootsFetched` with workspace items. It never sends `restoredTabState` — the
  message that `tickets.js` line 6780 is designed to handle. The code comment at line 392
  explicitly acknowledges this: *"a later slice wires the TicketsPanelProvider push; until
  then the read is a no-op."* That later slice was never implemented.

### Root Cause

Two bugs in `TicketsPanelProvider.ts`:

1. **`fetchRoots` never sends `restoredTabState`** (line 1128-1133): The handler returns
   `{ type: 'rootsFetched', items }` and nothing else. The `restoredTabState` handler in
   `tickets.js` (line 6780) is dead code — it is never triggered because no message is
   sent. The `PlanningPanelProvider.fetchRoots` (line 2552-2564) does send
   `restoredTabState` with tickets tab keys, but that message goes to the planning panel's
   webview (surface `'planning'`), not the tickets panel's webview (surface `'tickets'`).

2. **`persistTabState` ignores `workspaceRoot`** (line 1122-1127): The handler always
   calls `setPanelState` (panel-level storage), even when `workspaceRoot` is present. The
   `PlanningPanelProvider.persistTabState` (line 2619-2626) correctly distinguishes:
   `setRootState` when `workspaceRoot` is present, `setPanelState` when it is not. Because
   the tickets handler stores per-root state as panel-level state, even if `restoredTabState`
   were sent, `getAllStates` would return the state in `panel` (not `byRoot`), but the
   `tickets.js` `restoredTabState` handler reads from `byRoot` via
   `getRestoredState('tickets', root)` — so the state would still not be applied.

**Why it works in the extension (partially)**: `retainContextWhenHidden: true` keeps the
webview's JS state alive across tab switches within a session. Module-level variables
(`clickUpSelectedSpaceId`, `clickUpSelectedListId`, etc.) survive hide/show. But across
VS Code restarts, the state is lost for the same reason — `restoredTabState` is never sent.

**Why it fails completely in browser/standalone**: Every page load is a cold start. There
is no `retainContextWhenHidden`. The `vscode.getState()` / localStorage path only
preserves `ticketsWorkspaceRoot` (via `persistTicketsRoot`), not the source selection
state. The source state is persisted to `standalone-state.json` but never read back.

## Metadata

**Complexity:** 4
**Tags:** frontend, backend, bugfix, ui, ux
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- Adding `restoredTabState` push to `TicketsPanelProvider.fetchRoots` — the exact pattern
  already exists in `PlanningPanelProvider.fetchRoots` (lines 2552-2564). Copy the shape.
- Fixing `persistTabState` to handle `workspaceRoot` — the exact pattern already exists in
  `PlanningPanelProvider.persistTabState` (lines 2619-2626). Copy the shape.
- Modifying `rootsFetched` handler in `tickets.js` to process embedded `restoredTabState`
  data — the `restoredTabState` handler already exists (line 6780); just route to it.

**Complex/Risky:**
- **Standalone roots**: In standalone mode, `_getWorkspaceRoots()` returns `[]` because
  `vscode.workspace.workspaceFolders` is `[]` (see `vscodeShim.ts` line 189). The
  workspace root arrives via `msg.workspaceRoot` (set by the standalone bootstrap's
  `ticketsVerb` wrapper). `getAllStates` must be passed this root so it can find per-root
  state. Without it, `byRoot` would be empty even after the `persistTabState` fix.
- **Browser HTTP response delivery**: In browser mode, `transport.js` dispatches the HTTP
  response body as a single `MessageEvent`. The `fetchRoots` response has
  `type: 'rootsFetched'`. A separate `restoredTabState` WebSocket push may arrive before
  the WebSocket is connected (the `__resync` only carries kanban full-state, not tickets
  panel state). So the `restoredTabState` data must also be embedded in the `fetchRoots`
  HTTP response body, and the `rootsFetched` handler must detect and process it.
- **Timing**: `restoredTabState` may arrive before or after `rootsFetched`. The existing
  `restoredTabState` handler already handles both orderings (it checks
  `_workspaceItems.some(...)` and uses `_pendingTicketsRestore`). Embedding the data in
  `rootsFetched` guarantees the data is available when `rootsFetched` is processed,
  eliminating the race.

## Edge-Case & Dependency Audit

1. **Empty workspace roots in standalone**: `_getWorkspaceRoots()` returns `[]`. Must
   merge `msg.workspaceRoot` into the roots array for `getAllStates`. Use
   `[...new Set([...this._getWorkspaceRoots(), ...(msg.workspaceRoot ? [msg.workspaceRoot] : [])])]`.

2. **Root no longer exists**: The `restoredTabState` handler in `tickets.js` (line 6785)
   already checks `_workspaceItems.some(item => item.workspaceRoot === restoredRoot)`. If
   the root is gone, it falls through. In standalone mode with empty `_workspaceItems`,
   this check would fail. But `ticketsWorkspaceRoot` is already restored from
   localStorage (line 8086) before `fetchRoots` returns, so the `else` branch at line 6793
   handles this case via `_pendingTicketsRestore`.

3. **Provider not yet set**: If `lastIntegrationProvider` is null when
   `restoreTicketsStateForRoot` runs, it sets the module variables but
   `loadActiveTicketSource()` won't fire (it checks `!lastIntegrationProvider`). The
   `ticketsDefaultRoot` message (sent by `restoreTicketsState()`) resolves the provider
   afterward, and its handler at line 6838 adopts the provider and calls
   `loadActiveTicketSource()`.

4. **Multiple roots (extension mode)**: The `persistTabState` fix stores per-root state
   correctly. `getAllStates` with all roots returns state for each root. Switching roots
   restores the correct state for that root.

5. **Backward compatibility**: Existing `standalone-state.json` files have state stored
   as panel-level (due to the current bug). After the fix, new saves go to per-root
   storage. Old panel-level state becomes orphaned but harmless — it is never read by the
   `restoredTabState` handler (which reads from `byRoot`). No migration needed; the state
   is rebuilt on the next `saveTicketsState()` call.

6. **Debounce**: `persistTab` debounces by 300ms. The `persistTabState` handler is async
   but the file-backed memento's `update` is synchronous internally. No race condition.

7. **`restoredTabState` push in extension mode**: `_pushTo(targetPanel, 'tickets', ...)`
   sends to the tickets webview panel. In the extension, this is a direct
   `webview.postMessage`. In standalone, it goes through the BroadcastHub (WebSocket).
   Both paths work.

## Proposed Changes

### 1. `src/services/TicketsPanelProvider.ts` — Fix `persistTabState` handler (line 1122)

**Current:**
```typescript
case 'persistTabState': {
    if (msg.tabKey) {
        this._stateStore.setPanelState(msg.tabKey, msg.state);
    }
    return { success: true };
}
```

**Change to:**
```typescript
case 'persistTabState': {
    const { tabKey, workspaceRoot: root, state } = msg;
    if (tabKey) {
        if (root) {
            await this._stateStore.setRootState(tabKey, root, state);
        } else {
            await this._stateStore.setPanelState(tabKey, state);
        }
    }
    return { success: true };
}
```

This matches `PlanningPanelProvider.persistTabState` (line 2619-2626) exactly. Per-root
state (the `tickets` tab key with a `workspaceRoot`) is stored via `setRootState`;
panel-level state (the `tickets.root` tab key without a `workspaceRoot`) is stored via
`setPanelState`.

### 2. `src/services/TicketsPanelProvider.ts` — Fix `fetchRoots` handler (line 1128)

**Current:**
```typescript
case 'fetchRoots': {
    const items = buildWorkspaceItems(this._getWorkspaceRoots());
    const res = { type: 'rootsFetched', items };
    this._pushTo(targetPanel, 'tickets', res);
    return { ...res, success: true };
}
```

**Change to:**
```typescript
case 'fetchRoots': {
    const allRoots = [...new Set([
        ...this._getWorkspaceRoots(),
        ...(msg.workspaceRoot ? [msg.workspaceRoot] : []),
    ])];
    const items = buildWorkspaceItems(allRoots);
    const tabKeys = ['tickets', 'tickets.root'];
    const statePayload = this._stateStore.getAllStates(tabKeys, allRoots);
    const res = { type: 'rootsFetched', items };
    this._pushTo(targetPanel, 'tickets', res);
    // Push restoredTabState as a separate message (extension webview + browser WebSocket).
    this._pushTo(targetPanel, 'tickets', {
        type: 'restoredTabState',
        panel: statePayload.panel,
        byRoot: statePayload.byRoot,
    });
    // Embed restoredTabState data in the HTTP response body for browser mode, where
    // transport.js dispatches the response as a single MessageEvent. The rootsFetched
    // handler in tickets.js detects these fields and routes them through the
    // restoredTabState logic.
    return { ...res, success: true, panel: statePayload.panel, byRoot: statePayload.byRoot };
}
```

### 3. `src/webview/tickets.js` — Fix `rootsFetched` handler (line 6767)

**Current:**
```javascript
case 'rootsFetched': {
    _workspaceItems = message.items || [];
    if (ticketsWorkspaceRoot && !_workspaceItems.some(item => item.workspaceRoot === ticketsWorkspaceRoot)) {
        ticketsWorkspaceRoot = '';
    }
    ensureTicketsRootDefault();
    if (ticketsWorkspaceRoot) {
        persistTicketsRoot();
    }
    break;
}
```

**Change to:**
```javascript
case 'rootsFetched': {
    _workspaceItems = message.items || [];
    if (ticketsWorkspaceRoot && !_workspaceItems.some(item => item.workspaceRoot === ticketsWorkspaceRoot)) {
        ticketsWorkspaceRoot = '';
    }
    ensureTicketsRootDefault();
    if (ticketsWorkspaceRoot) {
        persistTicketsRoot();
    }
    // Browser mode: restoredTabState data is embedded in the fetchRoots HTTP response
    // body (transport.js dispatches it as part of this MessageEvent). If present, route
    // it through the restoredTabState handler so the source selection is restored.
    // In the extension, restoredTabState arrives as a separate push message.
    if (message.panel || message.byRoot) {
        const restoreMsg = { type: 'restoredTabState', panel: message.panel || {}, byRoot: message.byRoot || {} };
        // Fall through to the restoredTabState case by re-dispatching.
        _restoredPanelState.panel = restoreMsg.panel;
        _restoredPanelState.byRoot = restoreMsg.byRoot;
        if (!ticketsWorkspaceRoot) {
            const restoredRoot = _restoredPanelState.panel['tickets.root'];
            if (restoredRoot && _workspaceItems.some(item => item.workspaceRoot === restoredRoot)) {
                ticketsWorkspaceRoot = restoredRoot;
                ensureTicketsWatcherArmed();
                const restoredState = getRestoredState('tickets', restoredRoot);
                if (restoredState) {
                    restoreTicketsStateForRoot(restoredState);
                }
            }
        } else {
            if (_pendingTicketsRestore) {
                _pendingTicketsRestore = false;
                const restoredState = getRestoredState('tickets', ticketsWorkspaceRoot);
                if (restoredState) {
                    restoreTicketsStateForRoot(restoredState);
                }
            }
        }
    }
    break;
}
```

Note: The inline restoration logic duplicates the `restoredTabState` case body. This is
intentional rather than refactoring to a shared function — the `restoredTabState` case
is a `switch` branch, not a standalone function, and extracting it would change the
control flow of the message handler. The duplication is small (15 lines) and the
`restoredTabState` case still handles the extension-mode separate-push path.

## Verification Plan

1. **Unit test — `persistTabState` stores per-root state**:
   - Call `handleServiceVerb('persistTabState', { tabKey: 'tickets', workspaceRoot: '/foo', state: { clickUpSelectedListId: 'bar' } })`.
   - Assert `_stateStore.getRootState('tickets', '/foo')` returns `{ clickUpSelectedListId: 'bar' }`.
   - Assert `_stateStore.getPanelState('tickets')` returns `undefined`.

2. **Unit test — `persistTabState` stores panel-level state without root**:
   - Call `handleServiceVerb('persistTabState', { tabKey: 'tickets.root', state: '/foo' })`.
   - Assert `_stateStore.getPanelState('tickets.root')` returns `'/foo'`.

3. **Unit test — `fetchRoots` returns `restoredTabState` data**:
   - Pre-seed `_stateStore` with `setRootState('tickets', '/foo', { clickUpSelectedListId: 'bar' })` and `setPanelState('tickets.root', '/foo')`.
   - Call `handleServiceVerb('fetchRoots', { workspaceRoot: '/foo' })`.
   - Assert the return value has `panel` and `byRoot` fields.
   - Assert `byRoot['tickets']['/foo']` contains `{ clickUpSelectedListId: 'bar' }`.
   - Assert `panel['tickets.root']` equals `'/foo'`.

4. **Integration test — tickets.js `rootsFetched` processes embedded restore data**:
   - Add a test asserting that `tickets.js` contains the `if (message.panel || message.byRoot)` check inside `case 'rootsFetched':`.
   - Verify it calls `restoreTicketsStateForRoot` when restored state is present.

5. **Manual test — browser/standalone**:
   - Start standalone Switchboard.
   - Open the Tickets tab, select a ClickUp space/folder/list (or Linear project).
   - Restart standalone Switchboard.
   - Open the Tickets tab.
   - Verify the previously selected source is restored automatically (no manual re-navigation needed).

6. **Manual test — extension**:
   - Open VS Code with Switchboard.
   - Open the Tickets panel, select a source.
   - Close the panel, reopen it.
   - Verify the source is restored.
   - Restart VS Code, open the Tickets panel.
   - Verify the source is restored.
