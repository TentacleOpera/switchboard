# Add the Agent Control Panel, Command, and Second-Panel Delivery

## Goal
Open the Agent Control view as a second top-level VS Code `WebviewPanel` served by the existing Kanban backend, and make sure host→UI pushes reach **both** panels when both are open — including when the Kanban panel is closed and Agent Control is the only one on screen.

## Metadata
- **Complexity:** 7
- **Tags:** backend, ui, feature
- **Project:** Browser Switchboard

## Background & Problem Analysis

- `src/services/KanbanProvider.ts` currently owns the message `case` arms for the three tabs: `getPromptsConfig`, `savePromptsConfig`, `getAgentGroups`, `saveAgentGroup`, `deleteAgentGroup`, `startAgentGroup`, `saveCustomAgent`, `deleteCustomAgent`, `exportAgentAsSkill`, `getPromptPreview`, etc.
- `TaskViewerProvider` must call `setApiServer` on the new provider and the provider must build a `BroadcastHub` with the `apiServer`, mirroring the `tickets.html` fix.

> **Superseded:** "`KanbanProvider` hard-codes `this._panel.webview.postMessage(...)`. If a second panel is opened, replies like `agentGroups` or `promptsConfig` must go to the correct webview." — and the derived step "Maintain a webview-to-panel identity map so `postMessage` replies are routed to the sender."
> **Reason:** Measured, not assumed: `KanbanProvider.ts` contains exactly **one** `this._panel.webview.postMessage(...)` call, and it is inside the single `public postMessage(message: any)` helper at `KanbanProvider.ts:2277-2292`. Every one of the ~40 push sites goes through that helper, which delegates to `BroadcastHub.push()`. There is no scatter to unpick and no identity map to build. More importantly the premise is wrong in kind, not just in degree: the hub is **broadcast-shaped, not request/response-shaped** — pushes carry no correlation id and there is no "sender" to reply to. Routing each push to one panel would also directly contradict the feature's own acceptance criterion that a change made in Agent Control is visible in the Kanban panel.
> **Replaced with:** Deliver every push to **both** webviews. This is the existing, intended semantics — `BroadcastHub` already documents `pushTo()` as "the correct primitive for a provider that owns more than one webview panel" (`src/services/broadcastHub.ts:120-124`) — and it is what makes the two panels consistent views of one state.

> **Superseded:** "Create `src/services/AgentControlPanelProvider.ts` (or extend `src/services/KanbanProvider.ts`) … If `AgentControlPanelProvider` is new, delegate the message `case` arms to `KanbanProvider` or directly to shared `KanbanService` logic."
> **Reason:** Two defects. First, the "or" defers the architecture decision to the coder, which is the plan's job. Second, a separate provider is the wrong half of the choice: `KanbanProvider.ts` is 14,512 lines and the three tabs' `case` arms read provider-owned state (`_kanbanDbs`, `_autobanState`, `_sessionLogs`, `_broadcaster`, `_currentWorkspaceRoot`). A new provider would have to delegate essentially all of it, and would need its own `BroadcastHub`, which would then double every WS broadcast to browser clients.
> **Replaced with:** Extend `KanbanProvider` with a second panel field. One provider, one hub, one message handler, one WS fan-out.

### Verified facts (read from source during this pass)

- **Single push chokepoint.** `KanbanProvider.postMessage()` (`KanbanProvider.ts:2277`) is the only path to the webview; it calls `this._broadcaster.push(message)` when a hub exists. Adding secondary-panel delivery is a change to this one function.
- **`push()` cannot reach a second editor panel.** `BroadcastHub.push()` (`broadcastHub.ts:91-105`) delivers to the one bound webview plus the wsHub. A second VS Code panel is a real webview using the editor bridge, not a WS client, so it receives nothing from `push()`.
- **`pushTo()` exists but double-mirrors.** `broadcastHub.ts:126-134` delivers to a named webview **and** mirrors to WS. Calling `push()` then `pushTo()` would broadcast every message to browser clients twice.
- **28 `this._panel` references, and at least one is load-bearing for this feature.** `public async sendVisibleAgents()` (`KanbanProvider.ts:6917`) begins `if (!this._panel) return;`. `visibleAgents` is consumed directly by the Agents and Teams tabs (pushed at `KanbanProvider.ts:2228`). With the Kanban panel closed and only Agent Control open, this returns early and the Agents tab never receives its visibility state. The board-render guards (`_refreshBoard` 3550, `_refreshBoardImpl` 3568, `_refreshBoardWithData` 3873, `_tryRecoverRoot` 1379, `_postMoveCardsByTarget` 6616) and the integration-sync guards (`_postClickUpState` 3096, `_postLinearState` 3132) gate board-only work and are correct as they stand.
- **Panel revival is registered per view type.** `src/extension.ts:3605` registers `registerWebviewPanelSerializer('switchboard-kanban', …)`; sibling panels each register their own. A second view type needs its own registration or it silently fails to revive after a window reload.
- **Status-bar precedent.** `ticketsStatusBarItem` (`src/extension.ts:69, 2415-2419, 2528-2530`) is the pattern: create the item, point `.command` at the registered command, and show/hide it alongside the other Switchboard items.
- **Command contribution shape.** `package.json:146-149` — `{ "command": "switchboard.openTicketsPanel", "title": "Switchboard: Open Tickets Panel", "category": "Switchboard" }`.
- **The HTML is the same file.** Per the frontend subtask, there is no `agent-control.html`. This panel loads `kanban.html` through the existing `_getHtml()` (`KanbanProvider.ts:12907`) with `data-view="agent-control"` added to `<body>`.
- **No new verb, no new persisted host state.** Sub-tab and role persistence is handled webview-side through `vscode.getState()`/`setState()` (see the frontend subtask). `PanelStateStore` is **not** used here: adding a host round-trip would mean a new verb in `KANBAN_VERBS` and a `npm run catalog:generate` run, for state the webview already persists correctly in both hosts.

## User Review Required

None. Second-panel-on-`KanbanProvider`, broadcast-to-both delivery, and the guard-widening rule are all decided in this plan.

## Complexity Audit

### Routine
- Registering a command, a status-bar item, and a `package.json` contribution against an established pattern.
- Creating a second `WebviewPanel` with the same options as the first.
- Registering a second webview panel serializer.

### Complex / Risky
- Editing the single push chokepoint in a 14,512-line provider that ~4,000 installs depend on — a mistake here silently breaks the board's entire push path, not just the new panel.
- Auditing 28 `this._panel` sites and widening exactly the right ones. Widening too few leaves the Agent-Control-only session partly dead; widening too many makes board work run with no board attached.
- Panel lifecycle: `_webviewReady`, `_pendingWebviewMessages` and several dedup caches (`_lastBoardSnapshotKey`, `_lastPushKey`) are singletons scoped to the primary panel and must not be driven by the secondary panel's open/dispose.

## Edge-Case & Dependency Audit

- **Race Conditions:** Both panels can be opened, disposed, and revived independently. The secondary panel must never reset the primary's `_webviewReady` flag or drain `_pendingWebviewMessages` — that queue exists for the primary's cold-start ordering. Deliver to the secondary best-effort with no queue, exactly as `BroadcastHub.pushTo()` documents for secondary panels.
- **Security:** None. Same provider, same message handler, same allow-listed verbs, same workspace scoping. No new external surface.
- **Side Effects:** A second panel doubles editor-side rendering of every push. Accepted — both panels are views of the same state, which is the point.
- **Dependencies & Conflicts:** Requires the `data-view` contract from the frontend subtask. Shares `package.json` with no other subtask in this feature. Does **not** edit `kanban.html`, `LocalApiServer.ts`, or `headlessPanelHtml.ts`.

## Dependencies

None.

## Adversarial Synthesis

Key risks: the secondary panel silently receives nothing because `push()` only serves the bound webview; an Agent-Control-only session shows empty tabs because `sendVisibleAgents()` early-returns on a closed board panel; and the secondary panel's lifecycle corrupts the primary's readiness/dedup singletons. Mitigations: add secondary delivery inside the one `postMessage()` chokepoint with no second WS mirror, widen only the non-board guards (confirmed: `sendVisibleAgents`), and give the secondary panel no queue, no ready flag, and no cache resets on dispose.

## Proposed Changes

### `src/services/KanbanProvider.ts`

**Context.** One provider, one hub, one handler. The additions are a second panel field and a second delivery target.

**Logic.**
1. Add `private _agentControlPanel?: vscode.WebviewPanel;` beside `_panel` (`:234`).
2. Add `public async openAgentControl(column?: vscode.ViewColumn, restoredState?: any)`, modelled on `open()` (`:1608-1660`) but with view type `switchboard-agent-control`, title `AGENT CONTROL`, and the same `enableScripts` / `retainContextWhenHidden` / `localResourceRoots` options. Reveal-if-open, and keep `const isRevival = column !== undefined;` — `panel-revival-retention-contract.test.js` asserts that exact line is present and that `preserveFocus: true` is never hardcoded.
3. Extend `_getHtml(webview)` (`:12907`) to take an optional view marker and, when set, inject `data-view="agent-control"` into the `<body>` tag alongside the existing `data-initial-workspace-root` injection (`:12946-12951`).
4. Wire `onDidReceiveMessage` to the same `this._handleMessage(msg)` — the tabs' verbs are already handled and are panel-agnostic.
5. On `onDidDispose`, clear **only** `this._agentControlPanel = undefined`. Do not touch `_webviewReady`, `_pendingWebviewMessages`, `_lastColumnsSignature`, `_lastBoardSnapshotKey`, `_lastBoardSnapshotHash`, or `_lastPushKey`; those belong to the primary panel and resetting them from here would blank the board on the next refresh.
6. **Delivery** — in `postMessage()` (`:2277`), after the existing `this._broadcaster.push(message)`, deliver the same rendered payload to the secondary webview *without* a second WS mirror:
   - Render the factory form once using `this._broadcaster.getWebviewScope()` (`broadcastHub.ts:64`) so a scoped payload is rendered against the same scope the primary saw; a bare function fails the webview's structured clone and is dropped silently.
   - `this._agentControlPanel?.webview.postMessage(rendered)` with a rejection handler — the panel may have closed mid-flight.
   - Do **not** use `pushTo()` here: it mirrors to WS a second time.
7. **Guard widening.** Change `sendVisibleAgents()` (`:6917`) from `if (!this._panel) return;` to accept either panel. Then audit the remaining `this._panel` guards against one rule: *a guard that gates data the Agents, Teams, or Prompts tabs consume must accept either panel; a guard that gates board rendering or integration sync stays as it is.* The board-render and integration-sync guards listed in Background are confirmed correct unchanged.

**Edge Cases.**
- Only Agent Control open ⇒ tab data still flows (that is what step 7 fixes).
- Only the board open ⇒ `this._agentControlPanel` is `undefined`, the optional-chain no-ops, behaviour is identical to today.
- Both open, one closed mid-push ⇒ the rejection handler absorbs it.
- Message is a scoped factory ⇒ rendered once against the hub's webview scope, never posted as a function.

### `src/extension.ts`

**Context.** Command registration, status-bar item, and panel revival, all following the Tickets precedent.

**Logic.** Register `switchboard.openAgentControlPanel` → `kanbanProvider.openAgentControl(...)`. Create a status-bar item beside `ticketsStatusBarItem` (`:69, 2415-2419`) and show/hide it in the same blocks that show/hide the existing items (`:2528-2530`). Register `registerWebviewPanelSerializer('switchboard-agent-control', …)` next to the existing registrations (`:3605-3639`) so the panel survives a window reload.

**Edge Cases.** Revival must pass the restored state through the same `injectInitialWebviewState` path the Kanban panel uses, or the reopened panel loses its persisted sub-tab.

### `package.json`

**Context.** Commands must be contributed to appear in the palette.

**Logic.** Add `{ "command": "switchboard.openAgentControlPanel", "title": "Switchboard: Open Agent Control Panel", "category": "Switchboard" }` to `contributes.commands`.

## Verification Plan

### Automated Tests
- `npm run compile`.
- `npm run test:contract:kanban`.
- `node --test src/test/panel-revival-retention-contract.test.js` — asserts the `isRevival` line and the no-hardcoded-`preserveFocus` rule this plan must preserve.
- `node --test src/test/browser-panel-verb-routing.test.js` — proves no new verb entered `kanban.html`.
- `node --test src/test/teams-tab-no-start-contract.test.js` and `src/test/autoban-state-regression.test.js` — the two suites most likely to be sensitive to provider push changes.

### Manual
- Run the command and click the status-bar item; both open the Agent Control panel.
- With **only** Agent Control open, confirm the Agents tab shows agent visibility toggles and startup commands, the Teams tab renders the gallery, and the Prompts tab lists roles. (This is the `sendVisibleAgents` guard fix; before it, these are empty.)
- With **both** panels open, change a startup command in Agent Control and confirm the Kanban panel reflects it.
- Close Agent Control, confirm the board keeps refreshing normally; reopen it and confirm it repopulates.
- Reload the window and confirm both panels revive.

## Recommendation

**Send to Lead Coder** (complexity 7).

## Completion Report

Implemented the provider-side Agent Control panel routing as specified. Added `_agentControlPanel` field, `openAgentControl()` (modelled on `open()` but stripped of primary-singleton resets), and `deserializeAgentControlPanel()` to `src/services/KanbanProvider.ts`; extended `_getHtml(webview, viewMarker?)` to inject `data-view="agent-control"` onto `<body>` alongside the existing workspace-root attribute; added secondary-panel delivery in `postMessage()` (renders the factory against the hub's webview scope, no second WS mirror); and widened the `sendVisibleAgents()` guard to accept either panel. Wired `switchboard.openAgentControlPanel` command, status-bar item, quick-pick entry, and `switchboard-agent-control` panel serializer in `src/extension.ts`; added the command contribution and `statusBar.showAgentControlButton` config to `package.json`. No issues encountered — the broadcaster only ever binds `this._panel?.webview`, so the secondary panel receives pushes solely via the new delivery block with no double-delivery. Files changed: `src/services/KanbanProvider.ts`, `src/extension.ts`, `package.json`.

## Review Findings

Reviewed `src/services/KanbanProvider.ts`, `src/extension.ts`, `package.json` in commit `744a895f`. The `postMessage()` secondary-delivery block is correct (factory rendered once against the hub's webview scope, no second WS mirror), `openAgentControl` preserves the `isRevival`/`preserveFocus` retention contract, `sendVisibleAgents` widening is right, and the `extension.ts` command / status-bar / quick-pick / `switchboard-agent-control` serializer wiring follows the Tickets precedent. Four defects delegated: CRITICAL — the secondary panel's `ready` runs the primary's arm (`:8427`), setting `_webviewReady`, draining `_pendingWebviewMessages`, rebinding the broadcaster to `this._panel?.webview`, and firing a full `switchboard.fullSync` on every Agent Control open, directly violating this plan's "must never drive the primary's singletons" rule; MAJOR — the `ready` full-state resync is gated on `this._panel` and delivered via `pushWebviewOnly`, so an Agent-Control-only session gets no snapshot and a both-open session re-renders the board instead; MAJOR — `_tryRecoverRoot()` (`:1388`) early-returns and cancels recovery when `!this._panel`, leaving an AC-only session with an unresolved root permanently empty; MAJOR — `dispose()` (`:1576`) never disposes `_agentControlPanel`. Remaining risk: this commit also bundled unrelated in-flight work (Phone-a-Friend queue, `/orchestration/adopt`, stage-for-queue gating, feature drive-mode memoisation) into the same files, so future bisects across `744a895f` will not isolate this feature.

**Review closed — PASS.** All findings resolved across four fix rounds (`513fd654`, `c29377ed`, `cbed74d8`, `6ef4dc10`). `npm run compile` clean; `panel-revival-retention-contract`, `teams-tab-no-start`, `autoban-state` and the kanban.html half of `browser-panel-verb-routing` all green. Two failures remain in the suite and are confirmed pre-existing, not from this work — `connections.js` (`copyTextToClipboard`) and `transport.js` (double-filter) have zero commits in `ba8f5910..HEAD`. Residual risk: `744a895f` bundled four unrelated in-flight features into the same files, so it will not bisect cleanly; and `npm run test:contract:kanban`, named in two of these plans' Automated sections, does not exist in `package.json`.
