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
  (`:59`, 300 ms debounce) which sends a `persistTabState` message to the provider. The
  provider stores it in `PanelStateStore` (backed by `vscode.Memento` in the extension, or a
  file-backed memento in standalone mode writing to `standalone-state.json`).
- **Restoring does NOT work**: The `TicketsPanelProvider.fetchRoots` handler (`:1338`)
  only sends `rootsFetched` with workspace items. It never sends `restoredTabState` — the
  message that `tickets.js` (`:6972`) is designed to handle. The code comment at `:391`
  explicitly acknowledges this: *"read back via getRestoredState('tickets', …) once the host
  pushes"*. That later slice was never implemented.

### Root Cause

Two bugs in `src/services/TicketsPanelProvider.ts`:

1. **`fetchRoots` never sends `restoredTabState`** (`:1338`–`:1343`): The handler returns
   `{ type: 'rootsFetched', items }` and nothing else. The `restoredTabState` handler in
   `tickets.js` (`:6972`) is dead code — it is never triggered because no message is
   sent. `PlanningPanelProvider.fetchRoots` (`:2547`–`:2564`) does send `restoredTabState`
   with tickets tab keys, but that message goes to the planning panel's webview (surface
   `'planning'`), not the tickets panel's webview (surface `'tickets'`).

2. **`persistTabState` ignores `workspaceRoot`** (`:1332`–`:1337`): The handler always
   calls `setPanelState` (panel-level storage), even when `workspaceRoot` is present.
   `PlanningPanelProvider.persistTabState` (`:2619`–`:2628`) correctly distinguishes:
   `setRootState` when `workspaceRoot` is present, `setPanelState` when it is not. Because
   the tickets handler stores per-root state as panel-level state, even if `restoredTabState`
   were sent, `getAllStates` would return the state in `panel` (not `byRoot`), but the
   `tickets.js` `restoredTabState` handler reads from `byRoot` via
   `getRestoredState('tickets', root)` (`:77`) — so the state would still not be applied.

**Why it works in the extension (partially)**: `retainContextWhenHidden: true` keeps the
webview's JS state alive across tab switches within a session. Module-level variables
(`clickUpSelectedSpaceId`, `clickUpSelectedListId`, etc.) survive hide/show. But across
VS Code restarts, the state is lost for the same reason — `restoredTabState` is never sent.

**Why it fails completely in browser/standalone**: Every page load is a cold start. There
is no `retainContextWhenHidden`. The `vscode.getState()` / localStorage path only
preserves `ticketsWorkspaceRoot` (via `persistTicketsRoot`), not the source selection
state. The source state is persisted to `standalone-state.json` but never read back.

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, bugfix, ui, ux
**Project:** Browser Switchboard

> **Superseded:** Complexity 4.
> **Reason:** the restore body now has **three** entry points to keep in step (`restoredTabState`, the embedded-in-`rootsFetched` browser path, and the pre-existing `ticketsDefaultRoot` arm at `:7029`), so the change grew a shared-helper extraction; and the `restoredTabState` push is broadcast to every connected tickets surface, which requires the root-stamp/guard pattern already established for `ticketsAutoSyncChanged`. Still routine work, with two moderate well-scoped risks.
> **Replaced with:** Complexity 5.

## User Review Required

None. The orphaned panel-level state from the current bug is left in place (harmless, rebuilt on the next save) — that call is made in this plan, not deferred.

## Complexity Audit

### Routine
- Adding a `restoredTabState` push to `TicketsPanelProvider.fetchRoots` — the exact pattern
  already exists in `PlanningPanelProvider.fetchRoots` (`:2552`–`:2564`). Copy the shape.
- Fixing `persistTabState` to handle `workspaceRoot` — the exact pattern already exists in
  `PlanningPanelProvider.persistTabState` (`:2619`–`:2626`). Copy the shape.
- Routing the `rootsFetched` handler in `tickets.js` (`:6959`) at the embedded restore data.

### Complex / Risky
- **Standalone roots**: In standalone mode, `_getWorkspaceRoots()` (`:175`) returns `[]`
  because `vscode.workspace.workspaceFolders` is `[]` (`src/standalone/vscodeShim.ts:189`).
  The workspace root arrives via `msg.workspaceRoot` (set by the standalone bootstrap's
  `ticketsVerb` wrapper, `bootstrap.ts:1873`). `getAllStates` must be passed this root so it
  can find per-root state. Without it, `byRoot` would be empty even after the
  `persistTabState` fix.
- **Browser HTTP response delivery**: In browser mode, `transport.js` dispatches the HTTP
  response body as a single `MessageEvent`. The `fetchRoots` response has
  `type: 'rootsFetched'`. A separate `restoredTabState` WebSocket push may arrive before
  the WebSocket is connected (the `__resync` only carries kanban full-state, not tickets
  panel state). So the `restoredTabState` data must **also** be embedded in the `fetchRoots`
  HTTP response body, and the `rootsFetched` handler must detect and process it. This is
  additive to the return-in-body verb contract, not a violation of it.
- **The push is a broadcast.** `_pushTo` (`:199`) routes through `BroadcastHub`, which fans
  out to the editor webview **and every connected browser tab**. `restoredTabState` carries
  root-scoped state, so an unstamped push lets tab A's restore steer tab B's root — the
  cross-talk class documented in `_scoped` (`:208`, "Verified 2026-08-05: a panel showing a
  3-ticket list received a foreign 67-ticket payload"). The precedent for a root-scoped,
  scope-less push already exists: `ticketsAutoSyncChanged` (`:1400`, webview arm `:7009`),
  which stamps `workspaceRoot` and is guarded by a **workspaceRoot match alone**, explicitly
  *not* `_isForThisPanel()` — that predicate ends in a `listId` comparison and rejects every
  scope-less reply once a list is selected.
- **Three restore entry points.** `restoredTabState` (`:6972`), the new embedded path in
  `rootsFetched`, and the existing `ticketsDefaultRoot` arm (`:7029`–`:7064`) all call
  `getRestoredState` + `restoreTicketsStateForRoot` with slightly different surrounding
  conditions. Duplicating a fourth copy is how these drift.
- **Timing**: `restoredTabState` may arrive before or after `rootsFetched`. The existing
  handler already tolerates both orderings (it checks `_workspaceItems.some(...)` and uses
  `_pendingTicketsRestore`, set at `:7062`). Embedding the data in `rootsFetched` guarantees
  the data is available when `rootsFetched` is processed, eliminating the race.

## Edge-Case & Dependency Audit

1. **Empty workspace roots in standalone**: `_getWorkspaceRoots()` returns `[]`. Must
   merge `msg.workspaceRoot` into the roots array for `getAllStates`. Use
   `[...new Set([...this._getWorkspaceRoots(), ...(msg.workspaceRoot ? [msg.workspaceRoot] : [])])]`.

2. **`byRoot` key shape.** `PanelStateStore.setRootState` / `getRootState` key the memento
   map by `path.resolve(root)` (`PanelStateStore.ts:9`, `:15`), but `getAllStates` emits
   `byRoot[tabKey][root]` keyed by the **raw string it was passed** (`:27`–`:40`), and the
   webview looks it up with its own raw `ticketsWorkspaceRoot`. Persist and restore therefore
   agree only while the two strings are textually identical. A trailing slash, a differently-
   cased drive letter, or a symlinked path sent on one run and not the other produces a silent
   miss that looks exactly like "restore is still broken". Mitigation: pass the roots to
   `getAllStates` in the same form the webview sends them (`msg.workspaceRoot` verbatim,
   merged with `_getWorkspaceRoots()`), which is what change 2 does — and assert it in the
   unit test with a trailing-slash variant.

3. **Root no longer exists**: The `restoredTabState` handler already checks
   `_workspaceItems.some(item => item.workspaceRoot === restoredRoot)`. If the root is gone,
   it falls through. In standalone mode with empty `_workspaceItems`, this check would fail.
   But `ticketsWorkspaceRoot` is already restored from localStorage before `fetchRoots`
   returns, so the `else` branch handles this case via `_pendingTicketsRestore`.

4. **Provider not yet set**: If `lastIntegrationProvider` is null when
   `restoreTicketsStateForRoot` (`:4474`) runs, it sets the module variables but
   `loadActiveTicketSource()` won't fire. The `ticketsDefaultRoot` message (sent by
   `restoreTicketsState()`, `:4584`) resolves the provider afterward, and its handler at
   `:7029` adopts the provider and calls `loadActiveTicketSource()`.

5. **Multiple roots (extension mode)**: The `persistTabState` fix stores per-root state
   correctly. `getAllStates` with all roots returns state for each root. Switching roots
   restores the correct state for that root.

6. **Backward compatibility**: Existing `standalone-state.json` files have state stored
   as panel-level (due to the current bug) under the key `tickets.panel`
   (`setPanelState` appends `.panel`, `PanelStateStore.ts:23`). After the fix, new saves go
   to per-root storage under `tickets`. The old value becomes orphaned but harmless — it is
   never read by the `restoredTabState` handler (which reads `byRoot`). **No migration**:
   this is unreleased extraction-era state, the value is rebuilt on the next
   `saveTicketsState()` call, and the orphan costs a few bytes. Do not delete it either —
   an older build downgrade still reads it.

7. **Debounce**: `persistTab` debounces by 300 ms (`:64`–`:73`). The `persistTabState`
   handler is async but the file-backed memento's `update` is synchronous internally. No
   race condition.

8. **`restoredTabState` push in extension mode**: `_pushTo(targetPanel, 'tickets', …)` goes
   to the tickets webview panel. In the extension this is a direct `webview.postMessage`;
   in standalone it goes through the BroadcastHub (WebSocket). Both paths work. The push is
   required in the extension because webview→`_handleMessage` returns are discarded there —
   only the HTTP path sees the return value.

9. **Double application in the browser.** With both the embedded body **and** the WS push,
   a browser tab may apply the restore twice. `restoreTicketsStateForRoot` is idempotent
   (pure assignment from the state object plus `_applyTicketsSourceArrowState()`), so a
   second application is a no-op — but the shared helper must not re-fire
   `loadActiveTicketSource()` unconditionally, or the tab issues a duplicate source load.

**Security.** None. The payload is the user's own persisted navigation state, echoed back to their own panel.

**Side effects.** `fetchRoots` gains two fields on its return body. Any existing consumer that spreads the response (`{...res}`) sees `panel` / `byRoot` appear; no consumer keys off the absence of a field.

**Dependencies & conflicts:** `src/services/TicketsPanelProvider.ts`, `src/services/verbSchemas.ts` (one new permissive entry), `src/webview/tickets.js`. No DB, no schema migration, no protocol version change.

## Dependencies

- `feature_plan_20260810144300_tickets-sync-badge-…md` — **file-level only.** Both edit
  `src/services/TicketsPanelProvider.ts` and therefore serialise under the PRD's
  one-stream-per-provider-file rule. No shared symbols: that plan owns the cache-service
  binding sites and the heal loop; this one owns `persistTabState` (`:1332`) and `fetchRoots`
  (`:1338`).
- `verbSchemas.ts` is shared across all provider work — append the `fetchRoots` block inside
  `TICKETS_VERB_SCHEMAS` and serialise with any concurrent edit to that file.
- No session dependencies (`sess_…`) — none recorded for this work.

## Adversarial Synthesis

**Risk summary.** The two provider-side fixes are copy-the-sibling mechanical, so the real risks sit at the edges: a broadcast push that carries root-scoped state can steer the wrong browser tab unless it is stamped and guarded like `ticketsAutoSyncChanged`, and the `byRoot` map is keyed by a raw string on the way out while the memento resolves paths on the way in — so a textual mismatch produces a silent restore miss indistinguishable from "still broken". The third risk is drift: the restore body would have had four near-copies, which is mitigated by extracting one helper that all entry points call.

## Proposed Changes

### 1. `src/services/TicketsPanelProvider.ts` — fix the `persistTabState` handler (`:1332`)

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

This matches `PlanningPanelProvider.persistTabState` (`:2619`–`:2626`) exactly. Per-root
state (the `tickets` tab key with a `workspaceRoot`) is stored via `setRootState`;
panel-level state (the `tickets.root` tab key without a `workspaceRoot`) is stored via
`setPanelState`. Keep the `return { success: true }` — Planning `break`s here, but the
Tickets arm is already return-in-body and must stay that way (PRD contract #4).

### 2. `src/services/TicketsPanelProvider.ts` — fix the `fetchRoots` handler (`:1338`)

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
    // Standalone has no vscode.workspace.workspaceFolders (vscodeShim.ts:189 → []),
    // so the only root the host ever learns is the one the webview sends. Merge it in
    // VERBATIM — getAllStates keys byRoot by the string it is handed, and the webview
    // looks the result up with its own ticketsWorkspaceRoot. Normalising here would
    // silently break the lookup.
    const allRoots = [...new Set([
        ...this._getWorkspaceRoots(),
        ...(msg.workspaceRoot ? [msg.workspaceRoot] : []),
    ])];
    const items = buildWorkspaceItems(allRoots);
    const tabKeys = ['tickets', 'tickets.root'];
    const statePayload = this._stateStore.getAllStates(tabKeys, allRoots);
    const res = { type: 'rootsFetched', items };
    this._pushTo(targetPanel, 'tickets', res);
    // Root-scoped push on a broadcast transport: stamp the root so other connected
    // tickets surfaces can ignore it (the cross-talk class recorded in _scoped).
    // Same shape as the ticketsAutoSyncChanged push at :1400.
    this._pushTo(targetPanel, 'tickets', {
        type: 'restoredTabState',
        panel: statePayload.panel,
        byRoot: statePayload.byRoot,
        workspaceRoot: msg.workspaceRoot || undefined,
    });
    // Embed the same data in the HTTP response body for browser mode, where
    // transport.js dispatches the response as a single MessageEvent and the WS may
    // not be connected yet. The rootsFetched handler in tickets.js detects these
    // fields and routes them through the same restore helper.
    return { ...res, success: true, panel: statePayload.panel, byRoot: statePayload.byRoot };
}
```

### 3. `src/services/verbSchemas.ts` — add a permissive `fetchRoots` schema

`fetchRoots` is in `TICKETS_VERBS` (`src/generated/verbAllowlist.ts`) but has **no** entry in
`TICKETS_VERB_SCHEMAS`, and `validateVerbPayload` returns `{ ok: true }` for any verb with no
schema (`verbSchemas.ts:55`). The new `workspaceRoot` field therefore passes today by
accident. PRD contract #5 requires validation at the HTTP boundary, so add the block —
**permissive and field-accurate**, no required fields, since the arm tolerates an absent root:

```ts
fetchRoots: {
    fields: {
        workspaceRoot: { type: 'string' },
    },
},
```

### 4. `src/webview/tickets.js` — one restore helper, three callers

> **Superseded:** "The inline restoration logic duplicates the `restoredTabState` case body. This is intentional rather than refactoring to a shared function — the `restoredTabState` case is a `switch` branch, not a standalone function, and extracting it would change the control flow of the message handler."
> **Reason:** the stated obstacle does not exist. The body of the `restoredTabState` case (`:6972`–`:6994`) is self-contained: it reads `message.panel` / `message.byRoot`, assigns `_restoredPanelState`, and ends in a plain `break` with no fall-through and no dependence on the surrounding `switch`. Extracting it to a function changes nothing about control flow. Meanwhile the restore body already has a near-copy in the `ticketsDefaultRoot` arm (`:7029`–`:7064`); adding a third copy inline in `rootsFetched` makes drift near-certain — a fix applied to one arm and missed in the others is a failure mode this file has already suffered (the shared applier `_applyTicketFilePayloadToSelected` at `:6886` exists for exactly that reason, with a comment saying so).
> **Replaced with:** extract one helper and call it from both arms.

```js
// Single application point for host-supplied panel state. Two transports deliver it:
// a `restoredTabState` push (extension webview, and browser once the WS is up) and the
// `fetchRoots` HTTP response body (browser cold start, before the WS connects). Both
// must behave identically, so neither gets its own copy of this logic.
function _applyRestoredTabState(panel, byRoot) {
    _restoredPanelState.panel = panel || {};
    _restoredPanelState.byRoot = byRoot || {};
    if (!ticketsWorkspaceRoot) {
        const restoredRoot = _restoredPanelState.panel['tickets.root'];
        if (restoredRoot && _workspaceItems.some(item => item.workspaceRoot === restoredRoot)) {
            ticketsWorkspaceRoot = restoredRoot;
            ensureTicketsWatcherArmed();
            const restoredState = getRestoredState('tickets', restoredRoot);
            if (restoredState) { restoreTicketsStateForRoot(restoredState); }
        }
        return;
    }
    // _pendingTicketsRestore is the "root arrived before the state did" latch set by the
    // ticketsDefaultRoot arm. Consuming it here is what makes the two orderings equivalent.
    if (_pendingTicketsRestore) {
        _pendingTicketsRestore = false;
        const restoredState = getRestoredState('tickets', ticketsWorkspaceRoot);
        if (restoredState) { restoreTicketsStateForRoot(restoredState); }
    }
}
```

**`restoredTabState` arm (`:6972`) becomes:**
```js
case 'restoredTabState': {
    // Root-scoped payload on a broadcast transport. Guard on the workspaceRoot match
    // ALONE — not _isForThisPanel(), which ends in a listId comparison and rejects every
    // scope-less reply once a ClickUp list is selected (see ticketsAutoSyncChanged, :7009).
    // Both sides must be truthy for the guard to bite, so a cold tab with no root still
    // receives the message that is supposed to give it one.
    if (message.workspaceRoot && ticketsWorkspaceRoot
            && message.workspaceRoot !== ticketsWorkspaceRoot) { break; }
    _applyRestoredTabState(message.panel, message.byRoot);
    break;
}
```

**`rootsFetched` arm (`:6959`) gains a tail:**
```js
case 'rootsFetched': {
    _workspaceItems = message.items || [];
    if (ticketsWorkspaceRoot && !_workspaceItems.some(item => item.workspaceRoot === ticketsWorkspaceRoot)) {
        ticketsWorkspaceRoot = '';
    }
    ensureTicketsRootDefault();
    if (ticketsWorkspaceRoot) {
        persistTicketsRoot();
    }
    // Browser mode: the restore payload is embedded in the fetchRoots HTTP response body
    // (transport.js dispatches it as part of this MessageEvent), because a separate
    // WebSocket push can arrive before the socket is connected. Same helper as the push
    // arm — applying it twice is a no-op.
    if (message.panel || message.byRoot) {
        _applyRestoredTabState(message.panel, message.byRoot);
    }
    break;
}
```

Note the ordering inside `rootsFetched`: `_workspaceItems` and `ensureTicketsRootDefault()`
run **first**, so by the time `_applyRestoredTabState` reads `_workspaceItems.some(...)` the
list is populated. That is why the restore tail goes at the end of the arm, not the top.

## Verification Plan

### Automated Tests

1. **Unit — `persistTabState` stores per-root state**:
   - Call `handleServiceVerb('persistTabState', { tabKey: 'tickets', workspaceRoot: '/foo', state: { clickUpSelectedListId: 'bar' } })`.
   - Assert `_stateStore.getRootState('tickets', '/foo')` returns `{ clickUpSelectedListId: 'bar' }`.
   - Assert `_stateStore.getPanelState('tickets')` returns `undefined`.

2. **Unit — `persistTabState` stores panel-level state without root**:
   - Call `handleServiceVerb('persistTabState', { tabKey: 'tickets.root', state: '/foo' })`.
   - Assert `_stateStore.getPanelState('tickets.root')` returns `'/foo'`.

3. **Unit — `fetchRoots` returns restore data**:
   - Pre-seed with `setRootState('tickets', '/foo', { clickUpSelectedListId: 'bar' })` and `setPanelState('tickets.root', '/foo')`.
   - Call `handleServiceVerb('fetchRoots', { workspaceRoot: '/foo' })`.
   - Assert the return body has `panel` and `byRoot`; `byRoot['tickets']['/foo']` contains `{ clickUpSelectedListId: 'bar' }`; `panel['tickets.root']` equals `'/foo'`.
   - Assert the pushed `restoredTabState` message carries `workspaceRoot: '/foo'`.

4. **Unit — key-shape guard (edge case 2)**: seed with `'/foo'`, call `fetchRoots` with `workspaceRoot: '/foo/'`, and assert the emitted `byRoot['tickets']` contains a key the webview can find using the same string it sent. This is the silent-miss case; if the assertion cannot be satisfied, normalise on both sides in one place and say so in the code.

5. **Static — `tickets.js` restore wiring**: assert `case 'rootsFetched':` contains an `if (message.panel || message.byRoot)` branch calling `_applyRestoredTabState`, that `case 'restoredTabState':` also calls it, and that the restore body (`getRestoredState('tickets'` + `restoreTicketsStateForRoot`) appears in exactly one function — the guard against a fourth copy.

6. **Schema — `fetchRoots` validates**: `validateVerbPayload('tickets', 'fetchRoots', { workspaceRoot: '/foo' })` is ok; `{ workspaceRoot: 42 }` is rejected; `{}` is **accepted** (permissive — the arm tolerates an absent root).

7. `npm run parity:check` and `npm run verb-returns:check` — both green. This plan removes no `break`s, so the `Tickets` ceiling is unchanged.

### Manual

8. **Browser/standalone**: start standalone Switchboard, open the Tickets tab, select a ClickUp space/folder/list (or Linear project). Restart. Open the Tickets tab. The previously selected source is restored automatically, with no manual re-navigation.

9. **Extension**: open VS Code with Switchboard, open the Tickets panel, select a source. Close and reopen the panel — restored. Restart VS Code, open the Tickets panel — restored.

10. **Two browser tabs**: open the panel in two tabs on different workspace roots. Confirm a `fetchRoots` in tab A does not move tab B's root or source selection (the stamp + guard in changes 2 and 4).

---

**Recommendation:** Complexity 5 → **Send to Coder**. Serialise with `feature_plan_20260810144300` (same provider file), either order.
