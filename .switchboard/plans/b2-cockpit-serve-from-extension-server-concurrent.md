---
description: "Concurrency keystone: make the browser cockpit run AT THE SAME TIME as the VS Code extension by serving it from the extension's already-running LocalApiServer (single writer, one shared DB/state/broadcast), instead of spawning a second standalone server (which single-writer blocks). Adds the cockpit-serving options + a one-time-token minter + an 'Open in Browser' command to the extension host."
---

# B2 · Browser Cockpit — Serve From the Extension's LocalApiServer (Concurrent With the Editor)

## Metadata
- **Project:** browser-switchboard
- **Tags:** backend, api, architecture, ui
- **Complexity:** 7
- **Release phase:** B2 (browser cockpit). Concurrency keystone — the other B2 parity plans layer on top of the runtime this establishes.
- **Dependencies:** None (keystone). Unblocks concurrent-with-editor testing for `b2-cockpit-live-data-delivery-empty-board`, `b2-cockpit-real-icons-and-claudify-theming`, `b2-cockpit-complete-panel-set-artifacts-implementation`.

## Goal

Let a user open the full browser cockpit **while the VS Code extension is running on the same repo**, sharing one server, one DB, one live state stream — not a second process.

### Problem / root-cause analysis

The browser cockpit today is served **only** by the standalone (`npx`) `LocalApiServer` (`src/standalone/bootstrap.ts:923`). The extension runs its **own** `LocalApiServer` (`src/services/TaskViewerProvider.ts:1599`, the instance on `:51382`) for agent/skill access, but that construction **omits every cockpit-serving option** — no `serveStatic`, no `getBoardHtml`/`getProjectHtml`, no `consumeOneTimeToken`, no `getFullState`, no `panelsManifest`. Verified empirically: on the extension server, `GET /` → 503 and `/board`, `/panels` → 404, while the standalone server serves them 200.

Because a repo is **single-writer** (`bootstrap.ts` refuses to start a second instance when `.switchboard/api-server-port.txt` health-probes OK), the current design forces an either/or: editor **or** standalone browser, never both. The only correct way to run the browser "at the same time as the editor" is to **serve the cockpit from the server the editor already owns**, making the browser a *second client* of the live session. That also fixes several downstream complaints for free: the extension host has **real** `vscode` config + `globalState` (so theme/settings persist) and the **real** live DB + broadcast hub (so the board reflects the same state the editor sees, in real time).

## Proposed Changes

### `src/services/TaskViewerProvider.ts` (extension LocalApiServer construction, ~line 1599)
- **Context:** the `new LocalApiServer({...})` options object omits the cockpit block. **Logic:** add the same `serveStatic` + `consumeOneTimeToken` + `getFullState` + `panelsManifest` options the standalone path passes, reusing the **shared** getters so there is one source of truth for the HTML.
- **Implementation:**
  - Import the shared getters from `headlessPanelHtml`/the standalone board-html module (`sharedGetBoardHtml`, `sharedGetProjectHtml`, `sharedGetPanelHtmlById`, `getPanelsManifest`) — the same ones `bootstrap.ts:384-397` uses. Pass `repoRoot = context.extensionPath`/`extensionUri.fsPath` and `workspaceRoot = effectiveRoot`.
  - Add `serveStatic: { getBoardHtml, getProjectHtml, getPanelHtmlById, staticRoutes }` where `staticRoutes` maps `webview`/`icons`/`static` prefixes to the extension's on-disk asset dirs (mirror `bootstrap.ts`'s `staticRoutes`).
  - Add `panelsManifest: getPanelsManifest({ design: true, setup: true })` (all panels enabled — the extension host is fully capable).
  - Add `getFullState`: reuse the extension's existing board-state builder (the same data the KanbanProvider pushes to its webview) so a connecting browser client gets an initial `updateBoard` resync. If a builder isn't cleanly reusable, extract the KanbanProvider board-cards build into a shared function (see `b2-cockpit-live-data-delivery-empty-board`, which owns the data-delivery contract).
  - Add `consumeOneTimeToken`: wire to a new token store (below).
- **Edge cases:** the extension server binds to `effectiveRoot` via mappings — confirm the cockpit getters resolve the same root the KanbanProvider uses, or the browser board and the editor board diverge.

### One-time browser-launch token (extension host)
- **Context:** the standalone server mints `oneTimeToken` at boot and `consumeOneTimeToken` validates-once (`LocalApiServer.ts:550,602,656`). The extension has no minter. **Logic:** add a small token store on the extension side (a `Set<string>` of live tokens + `consume(token): boolean` that deletes on first hit, with a short TTL, e.g. 5 min). **Implementation:** expose `mintBrowserToken(): string` (crypto-random, matches the standalone token format) and pass its `consume` as `consumeOneTimeToken`. **Security:** the WS/HTTP Origin+token gating in `wsHub.ts` / `LocalApiServer` is unchanged and still applies — this only adds a valid-token source. Do NOT add an unauthenticated token endpoint.

### `src/extension.ts` + `package.json` — "Open in Browser" command
- Register `switchboard.openInBrowser`: mint a token, read the live port from `.switchboard/api-server-port.txt` (or the server instance), build `http://127.0.0.1:<port>/?token=<token>`, and `vscode.env.openExternal`. Contribute the command (title "Switchboard: Open in Browser") and, optionally, a board toolbar button that posts `{type:'openInBrowser'}` handled by the KanbanProvider → command.

### Standalone parity
- No behavioral change to `bootstrap.ts` — it keeps serving the cockpit for the no-editor case. The shared getters are now consumed by both construction sites, so the two hosts cannot drift.

## Edge-Case & Dependency Audit
- **Concurrency / single-writer:** there is still exactly ONE writer (the extension). The browser is a read/act **client** over HTTP+WS, exactly like the editor's own webview — no second writer is introduced, so the single-writer invariant holds. Do NOT start a standalone server when the extension owns the repo (the existing guard already prevents this).
- **Security:** token is single-use + TTL; Origin gating (DNS-rebinding mitigation) and the bearer-token WS upgrade remain the gate. No new unauthenticated surface.
- **Asset paths:** the extension runs from the installed extension folder, not the dev repo — `staticRoutes`/`repoRoot` MUST resolve against `context.extensionUri.fsPath`, never a hardcoded dev path.

## Verification Plan
### Manual (the real DoD)
1. With the extension running, invoke **Switchboard: Open in Browser** → browser opens the cockpit against `:51382` (the editor's port), token→cookie 303, `/`, `/board`, `/panels` all 200.
2. Move a card in the editor → it moves in the browser live (shared broadcast). Move one in the browser → it moves in the editor. (Board data delivery is finished in the sibling plan; this plan's DoD is that the routes/token/command work and both clients hit one server.)
3. Set a setting in the browser Setup → persists across a browser reload (real `vscode` config/globalState).
### Automated
- Unit-test the token store: `consume` returns true exactly once per token; expired tokens rejected.
- Extend the standalone smoke to also exercise the extension-host construction path (headless harness constructing the TaskViewer server with the cockpit options → `/panels` 200).
