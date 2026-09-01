# The Command Surface Receives The Board Push Instead Of Fetching Its Own Copy

## Goal

Delete the command surface's private copy of the board. It is the only panel in `src/webview/` that fetches card data over HTTP, and the only one that polls. Put it on the `updateBoard` broadcast every other panel already receives, remove `fetchBoardCards` and the five-second `setInterval` entirely, and fix the rendering that makes each update expensive.

**This was an explicit instruction that was overruled during implementation.** The surface was not supposed to fetch its own copy. The plan below is not "make the fetch smaller" — the fetch goes.

### Problem Analysis & Root Cause

**Every other panel is pushed. This one asks.**

A grep of `src/webview/` for board-data fetches:

```
kanban.html: 0    project.js: 0    tickets.js: 0    planning.js: 0
shell.js:    0    mission-control.js: 0    command.js: 2
```

The host reads the board once and fans it out — `KanbanProvider.ts:1400` sends `{ type: 'updateBoard', cards, ... }` through `broadcastHub`, which routes every push to **both** the VS Code webview and the WebSocket hub. Panels receive it and never ask for anything: `kanban.html:10744 case 'updateBoard':`, `project.js:465 case 'kanbanPlansReady':`, with deltas after that (`kanban.html:10639 case 'moveCards':`).

`command.js` sits outside all of it. `fetchBoardCards` (`command.js:291`) GETs `/kanban/plans`, and `command.js:110` re-runs it on a timer:

```js
setInterval(() => {
    if (!document.hidden && !activeTerminalWs) { pollBackgroundState(); }
}, 5000);
```

**Why it happened.** The surface was written from scratch as a new page (`0b91aa16`, 2026-08-31) rather than as a panel on the existing transport. The author was not unaware of WebSockets — the same commit wires one for the read-only terminal viewer (`/ws/terminal`) — and the panel *is* registered in `getPanelsManifest`.

> **Superseded:** It simply never loads `transport.js`, so it has no push channel for board data and hand-rolled HTTP fetches instead.
> **Reason:** `headlessPanelHtml.ts:544` calls `injectTransportShim(content, nonce, '<!-- SHARED_DEFAULTS_SCRIPT -->', ...)` which injects `transport.js` into command.html via the marker comment at `command.html:988`. The WebSocket IS connected. Pushes ARE arriving as `MessageEvent`s on `window`. The bug is not "no transport" — it is "transport loaded, ears closed." `command.js` has zero `message` event listeners (confirmed by grep), so every push lands and is ignored.
> **Replaced with:** `transport.js` is already loaded and the WS is already connected. The defect is that `command.js` never subscribes to the push — it has no `window.addEventListener('message', ...)` handler. The fix is to add that handler for `updateBoard` and `moveCards`, delete the HTTP fetch/poll, and add the `command` panel to `PANEL_SURFACES_MAP` (transport.js:112) and `PANEL_SURFACES` (wsHub.ts:70) so the surface declares `['kanban', 'common']` instead of receiving the entire firehose fail-open.

That choice contradicted an explicit instruction not to make the surface fetch its own board.

**What it costs.** Measured on the home lab box, 2026-09-01:

| measurement | value |
|---|---|
| `GET /kanban/plans` served locally | 0.13 s |
| the same request over the tailnet | **2.9 – 3.6 s** |
| payload | 2,753,018 bytes, uncompressed |
| board size | 2,446 rows / 306 features |
| poll interval | 5 s, **no in-flight guard** |

A three-second fetch on a five-second timer is a permanent download loop, and each completion triggers a full re-render. This is the direct answer to "the kanban loaded but the phone never did": they are on two different data paths.

**Rendering is a second, independent defect** and survives the transport fix, because the push carries the whole `cards` array too:

- `renderAllViews()` (`command.js:409`) renders all four views, including panes that are not on screen.
- `createCardItemElement` (`command.js:613`) builds ~8 elements and 3 listeners per card — roughly 19,600 nodes and 7,300 listeners for this board.
- `renderMissionView` (`command.js:799`) rebuilds a `<select>` with one `<option>` per card — all 2,446, unfiltered.
- Selecting a card calls `renderDispatchView()` again, rebuilding the whole list to move one CSS class.
- The dispatch filter at `command.js:473` excludes `'done' | 'completed' | 'archived'`; the board's real ids are `CREATED`, `PLAN REVIEWED`, `CODE REVIEWED`, `COMPLETED`, `BACKLOG` and so on. Wrong case, wrong names — **it removes zero rows**, so the list renders all 2,446 cards, 1,992 of them already CODE REVIEWED.
- `command.js:638` counts each feature's subtasks with `allCards.filter`: 306 × 2,446 = 748,476 comparisons per render. Measured at 22 ms. Real but minor — **do not start here.**

**Host reach.** `/command` is served by the shared `LocalApiServer` route (`LocalApiServer.ts:8353`) and is not host-gated, so one fix reaches both hosts. `broadcastHub` already fans to the webview and the WS hub, so the push path exists in both as well.

## Metadata
**Topic:** Command surface joins the board broadcast instead of polling its own copy
**Tags:** webview, architecture, performance, mobile, command-surface, bugfix

**Complexity:** 6

## User Review Required

None.

## Complexity Audit

### Routine
- Adding a `window.addEventListener('message', ...)` handler — every other panel has one.
- Deleting `fetchBoardCards`, `pollBackgroundState`, and the `setInterval` — straight removal.
- Removing `fetchBoardCards()` calls from `executeDispatch`/`executeMove`/`toggleCardStar`.
- Scoping the mission member picker to the filtered set instead of `allCards`.
- Precomputing subtask counts into a `Map`.

### Complex / Risky
- Adding `command` to `PANEL_SURFACES_MAP` (transport.js) and `PANEL_SURFACES` (wsHub.ts) — touches shared routing that every panel depends on. A wrong entry would silently drop pushes for the command surface or, worse, affect other panels if the maps drift out of sync.
- Optimistic ledger reconciliation against the push — the push handler must clear `pendingMoves`/`pendingStars` when server state confirms the change, or the optimistic state lives forever and shadows real state.
- `renderAllViews()` → render-active-only refactor — `switchView` must still trigger the correct render, and views that were previously pre-rendered (mission, teams) must still populate on navigation.

## Edge-Case & Dependency Audit

**Race Conditions:**
- The push may arrive before the HTTP response for `executeDispatch`/`executeMove`/`toggleCardStar`. The optimistic ledger (`pendingMoves`/`pendingStars`) is set before the fetch; the push handler must not clobber it with stale server state if the push arrives mid-action. Clear pending entries only when the push confirms the change (server state matches optimistic state).
- Reconnect after WS drop: `transport.js` dispatches `sbTransportReconnected` on reopen. The resync snapshot will re-populate `allCards`. No special handling needed — the `updateBoard` handler already sets `allCards` from `msg.cards`.

**Security:** No new attack surface. The push channel is already authenticated via WS upgrade auth. Removing the HTTP fetch reduces the attack surface (one fewer endpoint called from the client).

**Side Effects:**
- `extractWorkspaceProjects` is currently called inside `fetchBoardCards`. After deletion, it must be called from the `updateBoard` handler instead, or the workspace-project `<select>` will never populate.
- `fetchColumns` and `fetchMissionsState`/`fetchTeamsState` remain as HTTP fetches — they are not board data and are not pushed. `refreshAllData` should keep calling those three but drop `fetchBoardCards`.

**Dependencies & Conflicts:**
- Shares the Dispatch column picker (change 6) with the layout-study subtask (departure 1). Whichever lands second inherits the picker; it must not be built twice.
- `PANEL_SURFACES_MAP` (transport.js:112) and `PANEL_SURFACES` (wsHub.ts:70) must be updated together — they are mirrored by hand and a drift breaks surface filtering silently.

## Dependencies

- Shares defect 1 (the missing Dispatch column picker) with **The Command Surface Is Rebuilt To The Approved Layout Study**. Whichever lands second inherits the picker rather than adding it twice — coordinate, do not duplicate.

## Adversarial Synthesis

Key risks: (1) surface filter change touches shared routing — a wrong `PANEL_SURFACES_MAP` entry could silently drop pushes for the command surface or desync the two mirrored maps; (2) optimistic ledger reconciliation — if the push handler doesn't clear `pendingMoves`/`pendingStars` on confirmation, optimistic state shadows real state indefinitely; (3) `extractWorkspaceProjects` migration — if it's not moved from `fetchBoardCards` to the `updateBoard` handler, the workspace-project select stays empty. Mitigations: update both maps atomically in the same commit; clear pending entries only when server state matches; move `extractWorkspaceProjects` into the push handler explicitly.

## Proposed Changes

**1. Subscribe to the push (transport.js is already loaded).** `transport.js` is injected into command.html by `injectTransportShim` (`headlessPanelHtml.ts:544`) via the `<!-- SHARED_DEFAULTS_SCRIPT -->` marker (`command.html:988`). The WebSocket is already connected. Add a `window.addEventListener('message', handler)` in `command.js` that handles `updateBoard` and `moveCards` the way `kanban.html` does (`kanban.html:10744` / `kanban.html:10639`), writing into the existing `allCards`. For `updateBoard`: set `allCards = msg.cards`, extract workspace projects, and re-render the active view only. For `moveCards`: update each named card's `kanbanColumn` in `allCards` and re-render the active view — this is a SIMPLE handler (update + re-render), not a copy of kanban.html's 100-line optimistic-drag reconciliation, which the command surface does not need.

**2. Delete the fetch and the poll.** Remove `fetchBoardCards` (`command.js:291`), the `setInterval` (`command.js:110`), and `pollBackgroundState`. No polling replacement, no in-flight guard, no smaller fetch. There must be no `GET /kanban/plans` from this surface when the work is done. Also remove the three `await fetchBoardCards()` calls inside action functions — `executeDispatch` (`command.js:1050`), `executeMove` (`command.js:1092`), and `toggleCardStar` (`command.js:1123`) — which re-fetch the whole board after each successful action. The push will deliver the update; the optimistic ledger (`pendingMoves`/`pendingStars`) bridges the gap. The push handler must clear pending optimistic state when it confirms the change (e.g. on `updateBoard`, delete `pendingMoves`/`pendingStars` entries for cards whose server state matches the optimistic state).

**3. Add `command` to the surface filter (currently fail-open).** `command` is absent from `PANEL_SURFACES_MAP` (transport.js:112) and `PANEL_SURFACES` (wsHub.ts:70). With no entry, `wsUrl()` (transport.js:138) sends no `surfaces` param, and the server reads `rawSurfaces === null` → `surfaces = undefined` (wsHub.ts:277-285) → fail-open: the command surface receives EVERY push in the system (kanban, terminals, planning, design, setup, memo, tickets, connections). Add `command: [SURFACES.kanban, SURFACES.common]` to both maps so the surface declares `surfaces=kanban,common` and receives only board + common pushes. No new surface id is needed — the command surface consumes the same `kanban`-tagged board data every other board panel does. Cold load works via the resync snapshot: `getFullStateMessages` (KanbanProvider.ts:1294) returns `updateBoard` tagged `surface: SURFACES.kanban` (line 1400), and `_filterResync` (wsHub.ts:210-215) passes it through for a `kanban`-subscribed connection.

**4. Render only the visible pane.** `renderAllViews()` renders the active view; the others render on `switchView`, which `setupNavigation` already calls.

**5. Selecting a card must not re-render the list.** Toggle the `selected` class on the outgoing and incoming rows only.

**6. Scope the list to one column.** Restore the column picker to the Dispatch view — the Move view already has one (`move-source-column-select`) — and filter the pushed cards by it. Delete the `command.js:473` filter outright rather than correcting its case; a hardcoded id list rots the moment a column is renamed. This is also departure 1 of the layout-study plan; whichever lands second inherits the picker.

**7. Build the mission member picker from the scoped set**, not `allCards`.

**8. Precompute subtask counts** into a `Map<featureId, count>` when the push lands. Last, and only after the above.

**Out of scope:** gzip on the read endpoints. It is worth doing for external API clients, but with the fetch gone it is no longer any part of this bug's fix, and folding it in here would disguise whether the transport change actually worked.

## Verification Plan

1. **No board fetch exists.** With the page open and idle for two minutes, the network panel shows **zero** `/kanban/plans` requests. This is the plan's primary assertion — if one appears, the fix did not land.
2. **`transport.js` is loaded** and a WebSocket is connected from `/command`.
3. **Pushes arrive.** Move a card on the desktop board; the phone reflects it without any request being issued. Star a card; same.
4. **Cold load.** Opening `/command` populates the list from the initial push, with no HTTP round trip for cards.
5. **Fan-out is not widened.** Confirm the command surface does not receive pushes intended for other surfaces, and that no other panel starts receiving duplicates. Check the other panels still work — this touches shared routing.
6. **Card count.** With `BACKLOG` selected the list holds 39 rows; no CODE REVIEWED card appears under Dispatch.
7. **Tap latency.** Selecting a card creates no new DOM subtree — verify in the profiler that the list is not rebuilt.
8. **Off-screen panes** hold no card nodes until navigated to.
9. **Real device over the tailnet** — the reporter's phone, not a resized desktop browser. Time from open to a populated list.
10. **Both hosts** — `/command` under `switchboard tailnet` and under the extension, since `broadcastHub` fans differently in each.
11. `src/test/mobile-command-route-contract.test.js` still passes; extend it to assert the surface issues no board fetch.

### Goal Invariants

- **Negative:** `command.js` contains zero occurrences of `fetchBoardCards` and zero occurrences of the string `/kanban/plans`.
- **Positive:** `command.js` contains a `window.addEventListener('message',` handler that processes `updateBoard`.
- **Negative:** `command.js` contains no `setInterval` call.
- **Positive:** `transport.js` `PANEL_SURFACES_MAP` contains a `command` key mapped to `['kanban', 'common']`.
- **Positive:** `wsHub.ts` `PANEL_SURFACES` contains a `command` key mapped to `[SURFACES.kanban, SURFACES.common]`.
- **Negative:** `command.js` contains zero `await fetchBoardCards()` calls inside `executeDispatch`, `executeMove`, or `toggleCardStar`.

## Implementation Summary

Replaced the command surface's private `/kanban/plans` HTTP polling with real-time push subscriptions to `updateBoard` and `moveCards` broadcasts. Added `command: ['kanban', 'common']` to `PANEL_SURFACES_MAP` in `transport.js` and `PANEL_SURFACES` in `wsHub.ts` to scope push traffic cleanly. Removed `fetchBoardCards`, `pollBackgroundState`, and periodic `setInterval` from `command.js`, along with post-action re-fetches. Added a column selector dropdown to the Dispatch view, scoped rendering strictly to the active view pane, and updated card selection to toggle DOM classes directly without full list re-renders. Subtask counts are now precomputed into a Map on board update, reducing render overhead.
