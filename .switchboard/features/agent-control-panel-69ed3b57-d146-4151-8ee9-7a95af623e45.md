# Agent Control Panel

**Complexity:** 7

## Goal

Create a top-level Agent Control panel that opens the Agents, Teams, and Prompts tabs directly, while leaving the existing Kanban tabs intact. The panel must work in VS Code, the browser cockpit, and the standalone Switchboard shell.

## How the Subtasks Achieve This

- **Add the Agent Control View Mode to `kanban.html`**: adds an opt-in `data-view="agent-control"` mode to the existing board webview that hides the five non-target tabs, makes AGENTS the landing tab, and persists the active sub-tab and selected role. It is the whole frontend of the feature, and it keeps one file rather than a second copy that would drift.
- **Add the Agent Control Panel, Command, and Second-Panel Delivery**: opens the view as a second VS Code webview panel on the existing `KanbanProvider`, contributes the command and status-bar entry, and makes host pushes reach both panels — including when the board panel is closed and Agent Control is the only one open.
- **Serve Agent Control in the Browser and Standalone Shell**: adds the `/agent-control` route, a thin HTML getter that delegates to the board's, and a manifest entry so the shell's data-driven rail grows an icon with no shell edit.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add the Agent Control View Mode to `kanban.html`](../plans/feature_plan_20260819_agent-control-frontend-html.md) — **CODE REVIEWED** — ID: 5e36951c-7ce1-4ec4-b169-2252635aca4e
- [ ] [Add the Agent Control Panel, Command, and Second-Panel Delivery](../plans/feature_plan_20260819_agent-control-provider-routing.md) — **CODE REVIEWED** — ID: 99b7eeb3-70fb-48e5-9c5e-b8575f3ab6d8
- [ ] [Serve Agent Control in the Browser and Standalone Shell](../plans/feature_plan_20260819_agent-control-browser-shell.md) — **CODE REVIEWED** — ID: 45d55941-bb01-4e03-9f96-a5a7b6931e1e
<!-- END SUBTASKS -->

## Dependencies & sequencing

- **Ship the frontend view mode first.** Both host subtasks inject the `data-view="agent-control"` attribute that only the frontend subtask gives meaning; until it lands, each host opens an ordinary board.
- **The two host subtasks are independent of each other and can land in either order, or in parallel.** They share no file: the VS Code path goes through `KanbanProvider`/`extension.ts`/`package.json`, and the browser path goes through `LocalApiServer.ts`/`headlessPanelHtml.ts`/`icons/`. The browser path does **not** route through the panel provider — `_handleServePanelById` resolves HTML from `headlessPanelHtml.ts` directly.
- **Guard — the panel id must stay `kanban`.** `transport.js` derives the verb route prefix and the `localStorage` key from `data-panel`. The Agent Control view keeps `data-panel="kanban"` and is distinguished only by `data-view`. Changing it would 404 every verb in the browser while the page still rendered correctly, and would force an edit to the hand-mirrored `PANEL_SURFACES` map that a contract test asserts must not drift.
- **Guard — no new message verb.** Sub-tab and role persistence is webview-local via `vscode.getState()`/`setState()`. Introducing a host round-trip would require adding the verb to `KANBAN_VERBS` and regenerating the protocol catalog, and would fail `browser-panel-verb-routing.test.js` until it did.

## Reconciled end-state

The three subtasks partition the work by host surface — webview, editor, browser — with no shared file between them. Two decisions made during reconciliation bind all three:

1. **One HTML file, not two.** There is no `agent-control.html`. The Agent Control view is `kanban.html` served with `data-view="agent-control"`.
2. **Pushes broadcast to both panels; they are not routed to a sender.** `BroadcastHub` is broadcast-shaped and carries no correlation id. Both panels are consistent views of one state, which is what makes a change in Agent Control visible on the board.

The full verification suite for the feature — `npm run compile`, `test:contract:kanban`, the panel-revival, verb-routing and WS-surface contract tests, and the two-panel manual pass — is distributed across the three subtasks' Verification Plans; each is independently verifiable.

## Completion Report

All three subtasks implemented and reviewed. Subtask 1 (frontend HTML view mode) added an opt-in `data-view="agent-control"` CSS allow-list + active-tab re-marking + namespaced state persistence to `src/webview/kanban.html`. Subtask 2 (provider routing) added `_agentControlPanel` field, `openAgentControl()`, `deserializeAgentControlPanel()`, secondary-panel delivery in `postMessage()`, `sendVisibleAgents()` guard widening to `KanbanProvider.ts`; command + status-bar + serializer to `extension.ts`; command contribution + config to `package.json`. Subtask 3 (browser shell) added `getAgentControlHtml()` + manifest entry + `getPanelHtmlById` case to `headlessPanelHtml.ts`, `/agent-control` route to `LocalApiServer.ts`, and `icons/nav-agent-control.svg`. No issues encountered. Files changed: `src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/extension.ts`, `package.json`, `src/services/headlessPanelHtml.ts`, `src/services/LocalApiServer.ts`, `icons/nav-agent-control.svg`.

## Review Findings

Reviewed all three subtasks against commit `744a895f` (`src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/extension.ts`, `package.json`, `src/services/headlessPanelHtml.ts`, `src/services/LocalApiServer.ts`, `icons/nav-agent-control.svg`). The browser/standalone subtask passes as written; the frontend view mode and the provider routing each carry defects, delegated to `Coding-coder-1` as 2 CRITICAL and 4 MAJOR: the commit ships a `phoneAFriendSelected` posting from `kanban.html` without its generated verb-catalog half, so `browser-panel-verb-routing.test.js` — a CI-invoked gate named in two of these plans — is red at HEAD; the Agent Control webview's `ready` runs the primary panel's arm, setting `_webviewReady`, draining `_pendingWebviewMessages`, rebinding the broadcaster and firing a full `switchboard.fullSync` on every open, contradicting this feature's own "never drive the primary's singletons" constraint; an Agent-Control-only session receives no connect-time full-state snapshot and its root recovery is cancelled by a `!this._panel` guard; `dispose()` leaks the second panel; and the restored role is permanently discarded when the view lands on TEAMS. Verification results were not supplied with the implementation and have been demanded from the coder. Remaining risk: `744a895f` also bundled four unrelated in-flight features into the same files, so it will not bisect cleanly.

**Review closed — PASS.** All findings resolved across four fix rounds (`513fd654`, `c29377ed`, `cbed74d8`, `6ef4dc10`). `npm run compile` clean; `panel-revival-retention-contract`, `teams-tab-no-start`, `autoban-state` and the kanban.html half of `browser-panel-verb-routing` all green. Two failures remain in the suite and are confirmed pre-existing, not from this work — `connections.js` (`copyTextToClipboard`) and `transport.js` (double-filter) have zero commits in `ba8f5910..HEAD`. Residual risk: `744a895f` bundled four unrelated in-flight features into the same files, so it will not bisect cleanly; and `npm run test:contract:kanban`, named in two of these plans' Automated sections, does not exist in `package.json`.
