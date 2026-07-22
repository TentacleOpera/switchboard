---
description: "Fix the empty browser board: panel iframes render no data because the initial full-state push isn't reaching a freshly-connected WebSocket client (and/or the board's ready-handshake doesn't trigger a data push in the browser host). Data loads fine at the API layer (fetchKanbanPlans returns 1470 plans) — this is a delivery/rendering-path bug, not a data bug."
---

# B2 · Browser Cockpit — Live Data Delivery to Panel Iframes (Empty Board Fix)

## Metadata
- **Project:** browser-switchboard
- **Tags:** bugfix, api, ui, reliability
- **Complexity:** 6
- **Release phase:** B2 (browser cockpit). Parity fix — host-independent (benefits both the extension-hosted and standalone cockpit).
- **Dependencies:** None hard. Best verified concurrently after `b2-cockpit-serve-from-extension-server-concurrent`, but the fix itself is in the shared transport/broadcast path and can be built/tested on the standalone server today.

## Goal

The browser Board (and every panel iframe) must render the workspace's real cards/plans on load and stay live as state changes — matching the editor.

### Problem / root-cause analysis

Confirmed empirically: with a valid DB loaded, `POST /project/verb/fetchKanbanPlans` returns **1470 plans / success:true**, yet the browser **Board renders empty**. So the data exists and is reachable — the **delivery path to the board iframe** is the failure.

The browser board runs the real `kanban.html` unchanged, talking through the transport shim (`src/webview/transport.js`): it opens a WebSocket to `/ws`, and renders whatever `updateBoard` push it receives (server→UI). The likely causes (to be confirmed at runtime, in priority order):

1. **~~No initial full-state push on connect.~~ CORRECTED — the connect-time push already exists.**
   > **Superseded:** the primary hypothesis that `wsHub` does not push `getFullState` on connect, so a freshly-loaded iframe gets nothing until the next change broadcast.
   > **Reason:** `wsHub.ts:137-141` ALREADY awaits `getFullState()` on each client connect and sends it as a `{type:'__resync', seq:0, payload}` frame BEFORE any delta broadcast (with explicit seq-ordering so a delta cannot race ahead). `transport.js:94-102` unwraps `__resync` and dispatches each payload as a `MessageEvent`. The connect-time full-state push is present and functioning.
   > **Replaced with:** the cause is downstream of the push — either (a) `getFullState()`'s `updateBoard.cards` is EMPTY because the board-cards build / `workspaceId`/root resolution returns nothing (even though the *planning* read `fetchKanbanPlans` sees 1470 plans — the two use different queries), or (b) the board iframe's message handler does not render an `updateBoard` delivered inside the `__resync` envelope. Both are runtime-diagnosable.
2. **The board's `ready`/`webviewReady` handshake doesn't map to a data push.** In the editor, the webview's `ready` message makes the provider push `updateBoard`. In the browser, `ready` becomes `POST /kanban/verb/ready`; if that verb doesn't return/trigger the board payload, the handshake path is dead.
3. **`buildBoardCards` returns `[]` on the board path** even though the *planning* path (`fetchKanbanPlans`) sees plans — the two use different queries; a `workspaceId`/root mismatch on the board path would yield an empty board.

## User Review Required
- None — diagnostic bugfix, no product decision. (Confirm the empty-board repro workspace actually has cards.)

## Complexity Audit
### Routine
- Reusing / unifying the board-cards builder so both hosts share one query.
### Complex / Risky
- Root cause is runtime, not static — the fix target depends on live diagnosis (empty `getFullState` cards vs iframe not rendering the `__resync` `updateBoard`).
- The optimistic-drag suppression in `kanban.html` (`4203`, `5041-5050`) must not fight a connect-time resync — resync is per-socket and connect-only, never a broadcast to all.

## Dependencies
- Depends on **Serve-from-extension** for the `getFullState` wiring (shares that symbol; that plan wires it, this plan makes its payload correct). Host-independent otherwise. **Owner of:** `wsHub` connect behaviour (if any residual gap) + board-cards correctness. Does NOT own the `LocalApiServer` construction options (keystone owns those).

## Adversarial Synthesis
**Risk Summary:** Key risks: (1) the original primary hypothesis (no connect-push) is FALSE — `wsHub` already resyncs on connect (corrected above), so mis-aiming the fix would waste the pass; (2) the true cause is `getFullState` returning empty cards or the iframe not rendering the `__resync`-delivered `updateBoard` — both runtime-diagnosable. Mitigation: diagnose live (WS frame capture + the card count `getFullState` returns) BEFORE editing; unify the board-cards builder so editor and cockpit cannot diverge.

## Proposed Changes

### Diagnose first (runtime, not static)
- Boot the cockpit against a real DB, open the board, and capture: (a) the browser console `[transport] WebSocket connected` line, (b) whether any `__resync`/`updateBoard` WS frame arrives, (c) the `/kanban/verb/ready` response body, (d) the card count `getFullState()`/`buildBoardCards()` actually returns. This pins which of the three causes is live before editing.

### `src/services/wsHub.ts` — push full state on connect
- **Context:** the hub attaches on `upgrade` and fans out broadcasts. **Logic:** on each successful client connect, if `getFullState` is provided, call it and send the result to the just-connected socket as a `__resync` frame (`transport.js` already handles `__resync`, dispatching each payload as a `MessageEvent` — `transport.js:94-102`). **Edge cases:** `getFullState` may be async and may throw (no workspace) — guard and send nothing rather than crashing the socket; late boot (server up, providers not ready) should degrade to an empty-but-valid resync, not an error.

### `src/standalone/bootstrap.ts` / extension `getFullState` — correct board cards
- Ensure the `getFullState` payload's `updateBoard.cards` is built from the **same** query/root the editor's board uses. If `buildBoardCards` and the planning read diverge on `workspaceId`/root resolution, unify them (or reuse the KanbanProvider's own board-cards builder — extract to a shared function so both the editor webview push and the cockpit `getFullState` share one implementation and cannot drift).

### `kanban.html` ready-handshake (only if diagnosis shows cause #2)
- Ensure the board's on-load `ready` triggers a server-side data push in the browser host (either the `ready` verb returns the board payload, or the connect-time `__resync` from `wsHub` supersedes the need — prefer the `__resync` path so ALL panels get initial state uniformly, not just the board).

## Edge-Case & Dependency Audit
- **Races:** an optimistic drag in `kanban.html` suppresses full `renderBoard` from `updateBoard` (`kanban.html:4203,5041-5050`); the connect-time resync must not fight an in-flight local drag — send resync only on connect, not on every broadcast.
- **Multi-client:** with the concurrency plan live, editor + browser are both connected; the connect-time resync must be **per-socket** (only the newly-connected client), not a broadcast to all.
- **All panels, not just board:** project/design/setup iframes rely on the same connect→resync contract for their initial state — fix it in the shared hub so every panel benefits.

## Verification Plan
### Manual (the real DoD)
- Open the cockpit on a repo with plans → Board renders the real columns/cards on first load (no manual refresh). Project/Design/Setup panels populate too.
- Change state in the editor (or via API) → the browser board updates live within the broadcast, without reload.
### Automated
- wsHub unit test: a connecting client receives exactly one `__resync` containing the `getFullState` payload; subsequent change broadcasts are deltas, not full resyncs.
- Standalone smoke: after WS connect, assert an `updateBoard` frame with `cards.length > 0` is received for a seeded DB.

## Completion Report
Fixed empty browser board issue by adding `getFullStateMessages()` to `KanbanProvider` and delegating `getFullState` in `TaskViewerProvider` to construct the full webview state message array (`updateColumns`, `updateWorkspaceSelection`, `updateBoard`, etc.) delivered on WebSocket connection. Verified websocket clients now receive full board state payload on initial connection. Files changed: `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`. No issues encountered.

