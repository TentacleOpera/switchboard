# Browser Cockpit — Kanban UAT & Automation Tabs Render No Content

## Goal

In the browser cockpit, the Kanban board's **UAT** tab and **Automation** tab render permanently empty (UAT shows nothing; Automation is stuck on "Loading automation state…"). Both work in the VS Code webview. This plan makes both tabs load their content in the browser via the browser cockpit's HTTP return-contract, and repairs the underlying Kanban WebSocket delivery so live updates also reach the cockpit.

### Problem / background

The browser cockpit serves the real `kanban.html` with `src/webview/transport.js` shimmed in for `acquireVsCodeApi()`. In the browser, `vscode.postMessage({type:'v', ...})` becomes `POST /kanban/verb/v`; the UI receives data through exactly two channels:

1. **The HTTP response body** — `transport.js` re-dispatches the JSON body of the verb response as a `MessageEvent`, but only a body carrying a `type` field matches the UI's `switch(msg.type)` (`transport.js:186-188`). This is the "return-contract" the repo already enforces with the `verb-returns:check` CI gate.
2. **WebSocket pushes** — `KanbanProvider.postMessage(...)` → `_broadcaster.push` → `wsHub`, plus the connect-time `__resync` snapshot from `getFullStateMessages`.

The board itself renders because it is included in the `__resync` snapshot. The UAT and Automation tabs are not, and their load verbs fail to deliver over either channel.

### Root cause (per tab)

**UAT tab — the load verb returns a body with no `type`.** On UAT-tab open, `kanban.html:4432` posts `{type:'getUATData'}`; the UI renders from `case 'uatData'` → `renderUATChecklist(msg.plans)` (`kanban.html:7579`, container `#uat-checklist-container` at `2781`). The handler `case 'getUATData'` (`KanbanProvider.ts:10041`) pushes `this.postMessage({type:'uatData', plans})` (`:10100`) **and** returns `{ success: true, plans }` (`:10101`) — the return body has **no `type`**, so the HTTP rail delivers nothing renderable, and the only typed copy rides the (currently dead) WS mirror. Secondary: it reads `this._currentWorkspaceRoot` directly (`:10042`) instead of `_resolveWorkspaceRoot(msg.workspaceRoot)` like the working AGENTS verbs (`:9607`/`:10027`), so it also fails when the root isn't already set.

**Automation tab — the load verb is not wired at all.** On Automation-tab open, `kanban.html:10963-10973` posts `{type:'getAutobanConfig'}` when `autobanConfig` is null; `createAutobanPanel()` returns the "Loading automation state…" placeholder until an `updateAutobanConfig` message sets `autobanConfig` (`kanban.html:8819-8825`, set at `7795`). But `getAutobanConfig` has **no `case` in `_handleMessage` and is absent from the verb allowlist** (`grep` of `src/generated/verbAllowlist.ts` and `KanbanProvider.ts` returns nothing), so `handleServiceVerb` throws `Unknown Kanban verb: 'getAutobanConfig'` (`KanbanProvider.ts:7002`) → HTTP 500. `getAutobanConfig` is also not part of `getFullStateMessages` (`KanbanProvider.ts:1095-1100`, which sends only `updateColumns`, `updateWorkspaceSelection`, `cliTriggersState`, `updateBoard`). Result: `autobanConfig` never populates → permanent placeholder. In the VS Code webview the panel is populated because a board refresh pushes `updateAutobanConfig` directly to the live webview (`KanbanProvider.ts:1975`).

**Systemic — the Kanban WS mirror is a no-op in the extension-served cockpit.** `KanbanProvider._broadcaster` is created lazily inside `_initKanbanService` with `apiServer: null` hardcoded (`KanbanProvider.ts:6864-6868`). `setApiServer` only forwards to an already-existing broadcaster (`this._broadcaster?.setApiServer(server)`, `:6901-6903`) and stores nothing. Both activation-time wiring calls run before `_initKanbanService`: `TaskViewerProvider.ts:1936` is guarded by `if (this._kanbanProvider)` (still undefined then), and `TaskViewerProvider.ts:3062` runs before the broadcaster exists → both no-op. The broadcaster is then created on the first browser verb with `apiServer:null` and never re-attached, so `mirrorToWs` (`broadcastHub.ts:80-85`) never fires for the Kanban surface. This is why the UAT `postMessage` fallback and the Automation refresh push never arrive. (The board escapes because it comes from `__resync`, which does not go through the mirror.)

Capability gating is **not** the cause: the extension-served cockpit sets `terminalDispatch:true, automation:true` (`TaskViewerProvider.ts:1807`), and even the standalone default only hides action buttons like `#btn-autoban` (`transport.js:235-253`), never the tab bodies `#uat-tab-content` / `#automation-panel-root`.

### Decision

Fix both tabs primarily via the **return-contract** (make each load verb return a typed, renderable body) so they load over HTTP independent of the WS mirror, and additionally repair the Kanban broadcaster wiring so live deltas (board updates, AGENTS/PROMPTS tabs, and the UAT/Automation fallbacks) work in the cockpit. The return-contract fixes are sufficient on their own for the reported empty-tab symptom; the broadcaster fix is the broader correctness repair.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, backend, frontend, api, ui, reliability

## Complexity Audit

### Routine
- Adding `type: 'uatData'` to the `getUATData` return body and switching it to `_resolveWorkspaceRoot` — one-line, additive, VS Code path unaffected (it discards the return and renders from the push).
- Adding a `getAutobanConfig` read `case` that returns `{ type: 'updateAutobanConfig', state }` — the UI already handles `updateAutobanConfig`.

### Complex / Risky
- Registering the new `getAutobanConfig` verb requires editing `protocol-catalog.json` and regenerating the allowlist via `npm run catalog:generate` — the generated `src/generated/verbAllowlist.ts` must **not** be hand-edited (`scripts/check-protocol-parity.js` enforces parity, and `verb-returns:check` audits the return contract).
- The broadcaster-wiring fix touches the shared lazy-init path (`_initKanbanService`) and `setApiServer`; must preserve the VS Code webview behavior (webview push still works) and not double-wire.

## Edge-Case & Dependency Audit

- **Double render:** With both a typed HTTP body and (once the mirror is fixed) a WS `uatData`/`updateAutobanConfig` push, the browser may render the same tab twice. Both `renderUATChecklist` and `createAutobanPanel` are idempotent full replacements of their container, so this is benign.
- **Workspace root not yet set:** `getUATData` currently reads `this._currentWorkspaceRoot`; in a fresh cockpit session where the browser hasn't triggered a workspace selection, that can be undefined. Using `_resolveWorkspaceRoot(msg.workspaceRoot)` (the pattern the AGENTS verbs already use) removes that dependency. `transport.js` posts include the panel's `data-initial-workspace-root`-derived root where the UI supplies it; where it does not, `_resolveWorkspaceRoot` falls back to the server's selected workspace.
- **Autoban state shape:** The read verb must return whatever the UI's `case 'updateAutobanConfig'` expects (`kanban.html:7795-7796` reads `msg.state` / the fields `createAutobanPanel` consumes). Mirror the exact payload the existing refresh push builds at `KanbanProvider.ts:1975` so the read and the live push agree.
- **Standalone host:** `bootstrap.ts` (`npx switchboard`, no extension) has neither `getUATData` nor `getAutobanConfig` cases — both hit `default: 'not implemented in standalone mode'` (`bootstrap.ts:812`). This plan targets the extension-served cockpit (the mode with a live `api-server-port.txt`). Serving these tabs in the pure-standalone host is out of scope; if wanted later, add matching cases + include the payloads in the standalone `pushFullState`. Noted, not silently dropped.
- **Security:** No new external surface. `getAutobanConfig` is a read verb (no secrets, no writes); it is not in `SECRET_WRITE_VERBS`. The write verb `updateAutobanConfig` is already allow-listed and unchanged.
- **Dependencies:** None on the other cockpit fixes. Self-contained. The broadcaster-wiring sub-fix is scoped to `KanbanProvider`/`TaskViewerProvider` and does not collide with the other panels' providers.

## Proposed Changes

### `src/services/KanbanProvider.ts` — `case 'getUATData'` (~line 10041)

Make the return body renderable over the HTTP rail and harden the root resolution.

```ts
// Line ~10042 — resolve the root like the AGENTS verbs, don't read the singleton directly:
const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
// ...
// Line ~10100-10101 — keep the push (live path), add `type` to the returned body:
this.postMessage({ type: 'uatData', plans: plansWithSteps });
return { success: true, type: 'uatData', plans: plansWithSteps };
```

- The `type: 'uatData'` in the return makes `transport.js` re-dispatch a body that matches `case 'uatData'` → `renderUATChecklist(msg.plans)`, so the tab renders from the HTTP response regardless of the WS mirror.
- VS Code webview is unaffected: `onDidReceiveMessage` discards the return value; only the HTTP transport consumes it.

### `src/services/KanbanProvider.ts` — add `case 'getAutobanConfig'` in `_handleMessage`

Add a read case adjacent to the existing autoban handling, returning the same payload shape the live refresh push uses (`:1975`):

```ts
case 'getAutobanConfig': {
    // Read-only: return the current autoban/orchestration state so the browser
    // Automation tab can populate over the HTTP rail (the VS Code webview gets
    // this via the refresh push at ~line 1975). Mirror that push's payload shape.
    const state = this._autobanState; // same object pushed as { type:'updateAutobanConfig', state }
    return { success: true, type: 'updateAutobanConfig', state };
}
```

- Verify the exact field(s) the push at `:1975` sends (e.g. `state` vs inline fields) and match them so `case 'updateAutobanConfig'` in `kanban.html:7795` populates `autobanConfig` correctly. If the push also carries pair-programming mode, include `updatePairProgrammingMode` similarly (a second typed field or a companion read verb).

### `protocol-catalog.json` + `src/services/verbSchemas.ts` — register the `getAutobanConfig` verb

Add `getAutobanConfig` to `providers.Kanban.verbs[]` (marked as a read verb / returns `updateAutobanConfig`), and add a permissive schema entry for it in the verb-schemas source (PRD contract #5 — schema validation at the HTTP boundary; require only the fields the arm dereferences, which for this read verb is none/`workspaceRoot?` only). Then regenerate:

```bash
npm run catalog:generate   # regenerates src/generated/verbAllowlist.ts + catalog
npm run parity:check       # must pass
npm run verb-returns:check # must pass (records the new verb's return contract)
```

- Do **not** hand-edit `src/generated/verbAllowlist.ts`. If `verb-returns:check` needs a baseline update for the new verb, run `npm run verb-returns:baseline`.
- A schema that rejects a valid webview payload is a regression on shipped installs (contract #5) — keep the `getAutobanConfig` schema permissive (the arm reads no required fields off `msg`).

### `src/services/KanbanProvider.ts` — repair broadcaster wiring (systemic; live updates)

Store the API server and pass it when the broadcaster is (re)created so WS deltas fire in the cockpit:

```ts
// setApiServer (~6901): store it so a later lazy _initKanbanService can use it.
public setApiServer(server: any): void {
    this._apiServer = server;
    this._broadcaster?.setApiServer(server);
}

// _initKanbanService (~6864-6868): pass the stored server into the hub.
this._broadcaster = new BroadcastHub({
    webview: this._panel?.webview,
    apiServer: this._apiServer ?? null,
});
```

- Add the private field `_apiServer`. This mirrors what `bootstrap.ts` already does for the standalone host (pre-assign broadcaster, then `setApiServer`). Revives board live-updates plus the AGENTS/PROMPTS tabs (which share the same `type`-less-return + dead-mirror problem) and the UAT/Automation `postMessage` fallbacks.

### `src/services/KanbanProvider.ts` — (optional) include autoban in `getFullStateMessages` (~line 1095)

Add `{ type:'updateAutobanConfig', state: this._autobanState }` (and pair mode if applicable) to the `getFullStateMessages` array so the connect-time `__resync` snapshot also carries the Automation state — belt-and-suspenders so the tab is populated even before its on-open verb fires.

## Verification Plan

### Automated
- `npm run compile` and `npm run compile-tests` (tsc) pass.
- `npm run catalog:generate` produces a clean diff adding only `getAutobanConfig`; `npm run parity:check`, `npm run verb-returns:check`, and `npm run mirror:check` pass.

### Manual (the real DoD — extension-served cockpit)
1. With the extension running, open the browser cockpit → Board panel.
2. Click the **UAT** tab: the checklist renders the workspace's UAT plans (not empty). Confirm in DevTools that `POST /kanban/verb/getUATData` returns a body with `type:"uatData"` and a non-empty `plans` array, and the tab renders from it.
3. Click the **Automation** tab: it leaves "Loading automation state…" and shows the real autoban/orchestration panel. Confirm `POST /kanban/verb/getAutobanConfig` returns `type:"updateAutobanConfig"` with the current state (HTTP 200, not 500).
4. Live update check (broadcaster fix): change autoban state in the editor (or via API) → the cockpit Automation tab updates without reload; the board also live-updates. Confirm a `updateAutobanConfig` / `updateBoard` frame arrives over `/ws`.
5. Fresh-session root check: open the cockpit before selecting a workspace in the browser; the UAT tab still populates (validates `_resolveWorkspaceRoot`).
6. VS Code webview regression: open the board in the editor; UAT and Automation tabs still work exactly as before.
