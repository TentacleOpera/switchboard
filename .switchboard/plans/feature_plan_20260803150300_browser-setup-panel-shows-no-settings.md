# Browser Setup panel renders every setting unselected — SetupPanelProvider drops the LocalApiServer reference

## Goal

Make the browser-served Setup panel (`/setup`) hydrate with the same settings state the VS Code SETUP webview shows, so toggles, radios, dropdowns and integration status reflect what is actually configured instead of rendering at their unset defaults.

### Observed problem

Opening the browser Switchboard while the VS Code extension is running and navigating to the Setup panel shows a fully-rendered UI with **no data**: every tab's toggles are off/unselected, theme radios unset, DB paths blank, integration status empty — even though those same settings are correctly selected in the VS Code SETUP panel. It is not a rendering failure (the panel HTML, CSS and tabs all come up); it is a data-arrival failure.

### Root cause

Setup state reaches a panel exclusively as a **host→UI push**, never in an HTTP response body. `SetupPanelProvider.handleServiceVerb` documents this explicitly (`src/services/SetupPanelProvider.ts:60-65`): the read arms still push their result over the broadcaster and `break`, so an HTTP caller gets only the route layer's `{success:true}` ack with no payload. On load, `setup.html:5697` posts `{type:'ready'}`, which routes `POST /setup/verb/ready` → `_handleMessage` → `TaskViewerProvider.postSetupPanelState()` (`src/services/TaskViewerProvider.ts:6183-6298`), which fires ~25 `this._setupPanelProvider.postMessage({...})` calls. Each lands in `SetupPanelProvider.postMessage` (`src/services/SetupPanelProvider.ts:231-237`) → `this._broadcaster.push(message)` → `BroadcastHub.push` → webview fan-out **and** `mirrorToWs` (`src/services/broadcastHub.ts:100-105`).

`mirrorToWs` is a no-op unless `this._target.apiServer` is set. For `SetupPanelProvider` it never is:

- `SetupPanelProvider.setApiServer` (`src/services/SetupPanelProvider.ts:135-137`) is **stateless** — it does `this._broadcaster?.setApiServer(server)` and stores nothing.
- The extension calls it at activation time, before any Setup panel or Setup verb has existed: `TaskViewerProvider.setSetupPanelProvider` (`:3496-3501`) and the LocalApiServer wiring block (`:2334-2346`). At that moment `_broadcaster` is `undefined`, so the optional chain swallows the call and the server reference is discarded.
- When `_initSetupService()` finally runs (first `handleServiceVerb`, or `open()`), it constructs the hub with the server hard-coded off: `new BroadcastHub({ webview: this._panel?.webview, apiServer: null })` (`src/services/SetupPanelProvider.ts:93-97`). Nothing ever calls `setApiServer` again.

Net effect: every Setup push goes to the VS Code webview only. The browser panel's WebSocket is connected and subscribed (`transport.js` `PANEL_SURFACES_MAP.setup`), the verbs dispatch and succeed, and the panel simply never receives a single state message.

`DesignPanelProvider` and `PlanningPanelProvider` do not have this bug — both cache the server (`DesignPanelProvider.ts:208-212`) and re-apply it at hub-construction time (`:131-138`). `SetupPanelProvider` is the odd one out. The standalone `npx switchboard` host is unaffected because `bootstrap.ts` pre-assigns `_broadcaster` before calling `setupProvider.setApiServer(server)` (`src/standalone/bootstrap.ts:1396`), which is why this only reproduces against the extension-hosted server.

## Metadata

- **Complexity:** 3
- **Tags:** bugfix, backend, ui, reliability

## Complexity Audit (Routine vs Complex/Risky)

**Routine.** Three small edits inside one file, adopting a pattern already proven in two sibling providers in the same codebase.

- The change is additive: storing a reference and passing it into a constructor that already accepts the field. No message shapes, verb signatures, or wire formats change.
- No migration, no schema, no persisted state.
- The standalone host already supplies the server before the first push; the fix must preserve that (it does — `setApiServer` on an existing hub still forwards immediately).

**Risk worth naming:** once the WS mirror starts working, Setup pushes reach *all* WS clients, because `SetupPanelProvider.postMessage` calls `push(message)` with no `surface` argument and `wsHub.broadcast` only filters when a surface is supplied (`src/services/wsHub.ts:312`). This matches how `TaskViewerProvider.postMessage` already behaves, and the other panels' message handlers ignore unknown `type`s, so it is noise rather than breakage. Tagging Setup pushes with the `'setup'` surface is a worthwhile follow-up but is deliberately **out of scope** here — it would change delivery for the working VS Code path too, and this plan is scoped to the missing-data defect.

## Edge-Case & Dependency Audit

| Case | Behaviour after fix |
| :--- | :--- |
| `setApiServer` called before `_initSetupService()` (extension activation order — the actual bug) | Server cached on `_apiServer`; hub is constructed with it. Pushes mirror to WS. |
| `setApiServer` called after the hub already exists (standalone `bootstrap.ts:1396`) | Unchanged — forwarded straight to the live hub, exactly as today. |
| `_initSetupService()` early-returns because `_hostSeams` is already set (`:75-84`) | Must also re-apply `_apiServer`, otherwise a server wired between the first seam derivation and a later verb is still dropped. Covered by the third edit. |
| VS Code SETUP panel closed, browser panel open | Hub's `webview` is null so webview pushes queue in `_pendingWebviewMessages`; the WS fan-out is independent and still fires. Browser hydrates. |
| VS Code SETUP panel open **and** browser panel open | Both receive the same state. `_broadcaster.setWebview` re-pointing on panel reopen (`:82`) is untouched. |
| No workspace root resolved | `_initSetupService()` clears `_hostSeams`/`_broadcaster` and returns (`:85-91`); `_apiServer` stays cached for the next attempt. Panel stays empty — same as today, correctly, since there is no workspace to report on. |
| Secret-write verbs from the browser | Unchanged: `_handleSetupVerb` still rejects them unless `allowSecretWritesOverHttp` (`src/services/LocalApiServer.ts:1792-1806`). The extension host leaves that false, so tokens are still editor-only; only their *configured/not-configured* status arrives, which is what `integrationSetupStates` already carries. |
| Multiple browser tabs on `/setup` | All connected WS clients receive the push; each hydrates independently. |

**Dependencies:** `BroadcastHub` (`src/services/broadcastHub.ts`), `LocalApiServer.broadcastWs` → `wsHub`, `TaskViewerProvider.postSetupPanelState`, `webview/transport.js` WS dispatch. None require changes.

## Proposed Changes

### 1. `src/services/SetupPanelProvider.ts` — cache the API server

Add the field alongside the other broadcaster state (near `:151-153`) and make `setApiServer` stateful, mirroring `DesignPanelProvider.ts:208-212`.

```ts
    private _hostSeams?: HostSeams;
    private _broadcaster?: BroadcastHub;
    private _setupService?: SetupService;
    /**
     * Cached because the extension wires the server at activation — before any
     * Setup panel or Setup verb has forced `_initSetupService()` to build the hub.
     * A stateless `this._broadcaster?.setApiServer(server)` silently discarded it,
     * so every push from postSetupPanelState() reached the VS Code webview only and
     * the browser Setup panel rendered every setting unset. Mirrors
     * DesignPanelProvider/PlanningPanelProvider, which cache for the same reason.
     */
    private _apiServer?: any;
```

```ts
    public setApiServer(server: any): void {
        this._apiServer = server;
        this._broadcaster?.setApiServer(server);
    }
```

### 2. `src/services/SetupPanelProvider.ts` — construct the hub with the cached server

`_initSetupService()` (`:92-97`), replacing the hard-coded `apiServer: null`:

```ts
        this._hostSeams = createVscodeHostSeams(workspaceRoot);
        if (!this._broadcaster) {
            this._broadcaster = new BroadcastHub({ webview: this._panel?.webview, apiServer: this._apiServer ?? null });
        } else {
            this._broadcaster.setWebview(this._panel?.webview);
            if (this._apiServer) {
                this._broadcaster.setApiServer(this._apiServer);
            }
        }
```

### 3. `src/services/SetupPanelProvider.ts` — re-apply on the seams-already-derived path

The early return at `:75-84` re-points the webview but skips the server. Add the same re-apply so a server wired after the first seam derivation is not lost:

```ts
        if (this._hostSeams) {
            // Seams already derived (prior verb call or test-harness injection).
            // Do NOT re-derive workspace root, but DO re-point the broadcaster
            // at the current panel webview — otherwise a tab close/reopen cycle
            // leaves the broadcaster pointing at a dead webview and every
            // postMessage() silently drops. Mirrors KanbanProvider's
            // _initKanbanService(), which has no early-return and always re-points.
            this._broadcaster?.setWebview(this._panel?.webview);
            // Same reasoning for the WS target: a server wired between the first
            // seam derivation and this call would otherwise never reach the hub.
            if (this._apiServer) {
                this._broadcaster?.setApiServer(this._apiServer);
            }
            return;
        }
```

### 4. `src/test/setup-panel-ws-hydration-contract.test.js` — new regression test

The defect is invisible to every existing test because the verb still returns `{success:true}` and the VS Code path still works. Pin the contract at the source level so a future refactor cannot re-introduce a stateless `setApiServer` or an `apiServer: null` literal.

```js
'use strict';
/**
 * Contract: SetupPanelProvider must survive `setApiServer` being called BEFORE
 * its BroadcastHub exists.
 *
 * The extension wires the LocalApiServer at activation (TaskViewerProvider
 * setSetupPanelProvider / the LocalApiServer construction block), which is long
 * before the first Setup verb or panel open builds the hub in _initSetupService().
 * A stateless setter dropped the reference on the floor and every push from
 * postSetupPanelState() went to the VS Code webview only — the browser /setup
 * panel rendered with every setting unset. Source-level because there is no
 * in-process way to stand up a vscode host here.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'SetupPanelProvider.ts'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

test('setApiServer caches the server rather than only forwarding it', () => {
    const m = SRC.match(/public setApiServer\(server: any\): void \{([\s\S]*?)\n    \}/);
    assert.ok(m, 'setApiServer not found');
    assert.match(m[1], /this\._apiServer\s*=\s*server/,
        'setApiServer must cache — it is called before the hub exists, so a bare ' +
        'this._broadcaster?.setApiServer(server) is a silent no-op');
});

test('the BroadcastHub is constructed with the cached server, never a null literal', () => {
    assert.ok(!/new BroadcastHub\(\{[^}]*apiServer:\s*null[^}]*\}\)/.test(SRC),
        'apiServer: null hard-codes the WS mirror off for the whole session');
    assert.match(SRC, /new BroadcastHub\(\{[^}]*apiServer:\s*this\._apiServer/,
        'the hub must be built with the cached server');
});

test('the seams-already-derived early return re-applies the server', () => {
    const m = SRC.match(/if \(this\._hostSeams\) \{([\s\S]*?)\n            return;/);
    assert.ok(m, '_initSetupService early-return branch not found');
    assert.match(m[1], /setApiServer\(this\._apiServer\)/,
        'a server wired after the first seam derivation would otherwise never reach the hub');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
```

## Verification Plan

1. **Static:** `npx tsc --noEmit -p tsconfig.json` — no new type errors.
2. **New regression test:** `node src/test/setup-panel-ws-hydration-contract.test.js` — 3 passing.
3. **Existing suites unaffected:** `node src/test/setup-panel-refresh-regression.test.js` and `node src/test/setup-panel-migration.test.js` still pass.
4. **Manual, extension host (the reported repro):**
   - Build and sync to the installed extension folder, then reload the window (the running extension loads from `~/.<ide>/extensions/turnzero.switchboard-*/dist/`, not the repo `dist/`).
   - In VS Code SETUP, set several distinctive values across tabs: theme = claudify, "Exclude reviewed backlog" on, scanlines off, a status-bar toggle off, and note the Control Plane DB path.
   - Open the browser Switchboard at the port in `.switchboard/api-server-port.txt`, navigate to **Setup**.
   - **Expected:** every one of those values is reflected on load — theme radio on claudify, the toggles in the states set above, DB path populated, integration status chips rendered. Before the fix all render unset.
   - Devtools → Network → WS: the `/ws` frames now include `startupCommands`, `switchboardThemeNameSetting`, `gitIgnoreConfig`, `controlPlaneStatus`, `integrationSetupStates` shortly after load.
5. **Tab-switch hydration:** switch to the Theme, Database and Mappings tabs in the browser panel; each fires its own `get*` verbs and must now populate (before the fix these were also silent).
6. **No regression in the editor:** with the browser panel open, change a toggle in the VS Code SETUP panel — the VS Code panel still updates immediately, and the browser panel picks up the `settingsChanged` push.
7. **Standalone host unchanged:** run `npx switchboard` against a workspace with the extension stopped, open `/setup`, confirm it hydrates exactly as it did before this change.
8. **Secrets still editor-only:** in the browser panel, confirm token inputs remain disabled with the "Set this in the editor…" hint and that `POST /setup/verb/applyClickUpConfig` still returns 403 from the extension-hosted server.
