# Browser Setup panel renders every setting unselected — SetupPanelProvider drops the LocalApiServer reference

## Goal

Make the browser-served Setup panel (`/setup`) hydrate with the same settings state the VS Code SETUP webview shows, so toggles, radios, dropdowns and integration status reflect what is actually configured instead of rendering at their unset defaults.

### Observed problem

Opening the browser Switchboard while the VS Code extension is running and navigating to the Setup panel shows a fully-rendered UI with **no data**: every tab's toggles are off/unselected, theme radios unset, DB paths blank, integration status empty — even though those same settings are correctly selected in the VS Code SETUP panel. It is not a rendering failure (the panel HTML, CSS and tabs all come up); it is a data-arrival failure.

### Root cause

Setup state reaches a panel exclusively as a **host→UI push**, never in an HTTP response body. `SetupPanelProvider.handleServiceVerb` documents this explicitly (`src/services/SetupPanelProvider.ts:59-68`): the read arms still push their result over the broadcaster and `break`, so an HTTP caller gets only the route layer's `{success:true}` ack with no payload. On load, `setup.html:5698` posts `{type:'ready'}`, which routes `POST /setup/verb/ready` → `_handleMessage` → `TaskViewerProvider.postSetupPanelState()` (`src/services/TaskViewerProvider.ts:6219-6334`), which fires ~25 `this._setupPanelProvider.postMessage({...})` calls. Each lands in `SetupPanelProvider.postMessage` (`src/services/SetupPanelProvider.ts:231-237`) → `this._broadcaster.push(message)` → `BroadcastHub.push` → webview fan-out **and** `mirrorToWs` (`src/services/broadcastHub.ts:99-104`).

`mirrorToWs` is a no-op unless `this._target.apiServer` is set. For `SetupPanelProvider` it never is:

- `SetupPanelProvider.setApiServer` (`src/services/SetupPanelProvider.ts:135-137`) is **stateless** — it does `this._broadcaster?.setApiServer(server)` and stores nothing.
- The extension calls it at activation time, before any Setup panel or Setup verb has existed: `TaskViewerProvider.setSetupPanelProvider` (`:3528-3531`) and the LocalApiServer wiring block (`:2366-2372`). At that moment `_broadcaster` is `undefined`, so the optional chain swallows the call and the server reference is discarded.
- When `_initSetupService()` finally runs (first `handleServiceVerb`, or `open()`), it constructs the hub with the server hard-coded off: `new BroadcastHub({ webview: this._panel?.webview, apiServer: null })` (`src/services/SetupPanelProvider.ts:92-97`). Nothing ever calls `setApiServer` again.

Net effect: every Setup push goes to the VS Code webview only. The browser panel's WebSocket is connected and subscribed (`transport.js` `PANEL_SURFACES_MAP.setup`, declared because `headlessPanelHtml.ts:348` stamps `data-panel="setup"` onto the served body), the verbs dispatch and succeed, and the panel simply never receives a single state message.

`DesignPanelProvider` and `PlanningPanelProvider` do not have this bug — both cache the server (`DesignPanelProvider.ts:208-212`, `PlanningPanelProvider.ts:148-153`) and re-apply it at hub-construction time (`DesignPanelProvider.ts:131-138`, `PlanningPanelProvider.ts:138-145`). `SetupPanelProvider` is the odd one out. The standalone `npx switchboard` host is unaffected because `bootstrap.ts` pre-assigns `_broadcaster` (a shared headless hub, `bootstrap.ts:591-593`) before calling `setupProvider.setApiServer(server)` (`src/standalone/bootstrap.ts:1419`), which is why this only reproduces against the extension-hosted server.

### Second defect found during review — the push can still land on nobody

Repairing the reference is **necessary but not sufficient**. Even with the hub correctly pointed at the LocalApiServer, first-load hydration races the WebSocket handshake:

- `setup.html:5698` posts `{type:'ready'}` inline during script parse, while the socket opened by `transport.js` (`connectWs()` at parse time) is still handshaking.
- `wsHub` deliberately adds a connection to its broadcast set **only after** the full-state resync resolves — "Subscribe-AFTER-snapshot" (`src/services/wsHub.ts:242-267`). In the extension host `getFullState` runs a kanban `db.getBoard()` query (`TaskViewerProvider.ts:2346-2363`).
- If that DB read outlasts the `ready` HTTP round-trip, `postSetupPanelState()`'s ~25 pushes are broadcast to a connection set that does not yet contain this client. They are dropped with no queue and no replay — the panel renders exactly as blank as it does today.
- There is no recovery path: `setup.html` registers no `sbTransportReconnected` listener (`design.js:40` is the only panel that does), so a dropped socket also leaves the panel permanently stale.

This is why the fix must also give the panel a deterministic "I am now subscribed" signal to re-request state on. See Proposed Changes 4 and 5.

## Metadata

- **Complexity:** 4
- **Tags:** bugfix, backend, ui, reliability

## User Review Required

- **Scope of the race fix (Proposed Changes 4 + 5).** The reference repair alone (changes 1-3) is a three-line, single-file fix. Closing the handshake race adds a shared-transport change (`transport.js`) and a `setup.html` listener. Reviewer decision: land both together (recommended — without them the fix is intermittent), or land 1-3 first and accept flaky first-load hydration until a follow-up.
- **Cost of the re-request.** Change 5 causes the browser panel to run the mount-time verbs twice per load (once inline, once on subscribe), i.e. roughly 50 pushes instead of 25. `postSetupPanelState()` is a pure re-read + re-push with no side effects, so this is CPU/frame cost only. Confirm that is acceptable rather than gating the inline post behind host detection.
- **Cross-panel noise stays out of scope.** Setup pushes remain untagged and therefore reach every WS client. One concrete, already-live collision is documented under Side Effects. Confirm the follow-up framing rather than expanding this plan.

## Complexity Audit

### Routine

> **Superseded:** "Three small edits inside one file, adopting a pattern already proven in two sibling providers in the same codebase."
> **Reason:** Correct for the reference repair, but the review found that the repair alone does not deterministically achieve the plan's goal — the handshake race (root-cause section above) can still swallow every push on first load. The work is now four files, not one.
> **Replaced with:** Three small edits in `SetupPanelProvider.ts` adopting a pattern already proven in two sibling providers, plus a shared-transport event and a `setup.html` listener to close the mount-time subscribe race, plus a source-level regression test. Complexity raised 3 → 4.

- The provider change is additive: storing a reference and passing it into a constructor that already accepts the field. No message shapes, verb signatures, or wire formats change.
- No migration, no schema, no persisted state.
- The standalone host already supplies the server before the first push; the fix must preserve that (it does — `setApiServer` on an existing hub still forwards immediately).
- The transport addition is a new `CustomEvent` dispatch on an existing code path (`__resync` handling), mirroring the existing `sbTransportReconnected` dispatch. Panels that do not listen are unaffected; the VS Code webview host never loads `transport.js` at all, so the editor path is untouched by changes 4 and 5.

### Complex / Risky

- **Subscribe-ordering dependency.** Change 5 relies on the contract that `wsHub` sends `__resync` and adds the connection to `_connections` with no `await` between the two statements (`wsHub.ts:257-267`), which makes *receipt of `__resync`* the first client-observable moment at which a broadcast is guaranteed to be delivered. If a future refactor inserts an await there, the signal weakens back to a race. This must be called out in the code comment so the coupling is visible from both ends.
- **Resync availability.** The signal only exists because both hosts wire `getFullState` (`TaskViewerProvider.ts:2346`, `bootstrap.ts:1399`). A host that omits it sends no `__resync`, and the panel falls back to inline-`ready`-only behaviour — degraded to today's race, not worse.
- **Untagged fan-out becomes live.** Once the WS mirror starts working, Setup pushes reach *all* WS clients, because `SetupPanelProvider.postMessage` calls `push(message)` with no `surface` argument and `wsHub.broadcast` only filters when a surface is supplied (`src/services/wsHub.ts:314`). This matches how `TaskViewerProvider.postMessage` already behaves. It is mostly noise, but one concrete collision was found — see Side Effects.

> **Superseded:** "Tagging Setup pushes with the `'setup'` surface is a worthwhile follow-up but is deliberately **out of scope** here — it would change delivery for the working VS Code path too, and this plan is scoped to the missing-data defect."
> **Reason:** The stated rationale is factually wrong. `BroadcastHub.push` delivers to the bound webview **unconditionally** and passes `surface` only to `mirrorToWs` (`broadcastHub.ts:80-91`), so surface tagging cannot affect the VS Code webview path at all. The real reason to defer is different, and stronger: a blanket tag would *break* live cross-panel consumers, because `kanban.html`/`implementation.html`/`project.js` legitimately handle `switchboardThemeNameSetting`, `remoteControlState`, `visibleAgents`, `customAgents` and `startupCommands` emitted by this provider. Selective per-message tagging is required, which is a real design task, not a one-line change.
> **Replaced with:** Surface tagging stays out of scope, because it must be done **per message type**, not blanket: several Setup pushes are deliberately cross-panel. The follow-up must audit each of the 46 push types in `SetupPanelProvider` against the handlers in `kanban.html`, `implementation.html`, `project.js` and `design.js` before tagging any of them.

## Edge-Case & Dependency Audit

### Race Conditions

| Case | Behaviour after fix |
| :--- | :--- |
| `ready` POST completes before the WS connection joins `_connections` (first load, slow `getBoard()`) | The inline `ready`'s pushes are lost, exactly as today — but the `__resync` frame then fires `sbTransportSubscribed`, the panel re-posts `ready`, and the second fan-out lands on a subscribed connection. Panel hydrates. |
| `ready` POST completes after the WS join (fast path) | Panel hydrates from the inline `ready`; the subscribe-triggered re-post arrives shortly after and re-renders identical values. Idempotent. |
| WS drops and reconnects mid-session | `wsHub` sends a fresh `__resync` on every (re)connect, so `sbTransportSubscribed` fires again and the panel re-requests state. Fixes today's permanent-staleness-after-drop hole. |
| Host wires no `getFullState` (no `__resync` sent) | No `sbTransportSubscribed` event; behaviour degrades to inline-`ready`-only, i.e. today's race. Not worse than current. Both shipped hosts do wire it. |
| VS Code webview host (no `transport.js`) | The event never fires; only the inline `ready` runs. Editor path byte-for-byte unchanged. |

### Security

| Case | Behaviour after fix |
| :--- | :--- |
| Secret-write verbs from the browser | Unchanged: `_handleSetupVerb` still rejects them unless `allowSecretWritesOverHttp` (`src/services/LocalApiServer.ts:1822-1834`; the set includes `applyClickUpConfig`, `applyLinearConfig`, `applyNotionConfig`, `enableTriagePipeline`, `setApiToken`). The extension host never sets that option, so it is false and tokens stay editor-only; only their *configured/not-configured* status arrives, which is what `integrationSetupStates` already carries. |
| Newly-reachable data over WS | The fix delivers exactly the payloads `postSetupPanelState()` already builds for the VS Code webview — DB paths, toggle states, integration *status* booleans. No secret material is added to the wire. WS upgrade remains bearer/cookie-authorised (`authorizeWsUpgrade`, `wsHub.ts:182`). |

### Side Effects

| Case | Behaviour after fix |
| :--- | :--- |
| `kanbanStructure` reaching kanban browser clients | **Real, contained regression.** `postSetupPanelState()` pushes `{type:'kanbanStructure', items}` (`TaskViewerProvider.ts:6240-6243`) while `kanban.html:8399-8403` reads `msg.structure \|\| []` and then `renderKanbanStructureList()` — so the shape mismatch blanks `#kanban-structure-list` (the kanban panel's Setup-tab column list) until the next `KanbanProvider` structure push. `lastKanbanStructure` is used nowhere else (`kanban.html:8400, 11412, 11454, 11457`), so the board itself is unaffected. This is **not new behaviour introduced by this plan** — the standalone host already shares one broadcaster across providers (`bootstrap.ts:587-593`) and therefore already exhibits it. Deferred to the surface-tagging follow-up. |
| Other untagged types reaching other panels | `startupCommands`, `visibleAgents`, `customAgents`, `switchboardThemeNameSetting`, `remoteControlState`, `multiRepoScaffoldResult` are handled elsewhere and carry the same shapes those handlers already expect (they originate from the same `handleGetStartupCommands`/`getVisibleAgents` reads) — redundant re-render, not corruption. |
| Double mount-time fan-out | Change 5 re-posts the three mount-time verbs, so a browser load runs `postSetupPanelState()` twice. All three are pure reads; cost is one extra fan-out. |

### Dependencies & Conflicts

| Case | Behaviour after fix |
| :--- | :--- |
| `setApiServer` called before `_initSetupService()` (extension activation order — the actual bug) | Server cached on `_apiServer`; hub is constructed with it. Pushes mirror to WS. |
| `setApiServer` called after the hub already exists (standalone `bootstrap.ts:1419`) | Unchanged — forwarded straight to the live hub, exactly as today. |
| `_initSetupService()` early-returns because `_hostSeams` is already set (`:75-84`) | Must also re-apply `_apiServer`, otherwise a server wired between the first seam derivation and a later verb is still dropped. Covered by the third edit. In standalone this branch re-applies the same server to the shared hub — a no-op. |
| VS Code SETUP panel closed, browser panel open | Hub's `webview` is null so webview pushes queue in `_pendingWebviewMessages`; the WS fan-out is independent and still fires. Browser hydrates. |
| VS Code SETUP panel open **and** browser panel open | Both receive the same state. `_broadcaster.setWebview` re-pointing on panel reopen (`:82`) is untouched. |
| No workspace root resolved | `_initSetupService()` clears `_hostSeams`/`_broadcaster` and returns (`:85-91`); `_apiServer` stays cached for the next attempt. Panel stays empty — same as today, correctly, since there is no workspace to report on. |
| Multiple browser tabs on `/setup` | All connected WS clients receive the push; each gets its own `__resync` and therefore its own re-request; each hydrates independently. |

**Dependencies:** `BroadcastHub` (`src/services/broadcastHub.ts`), `LocalApiServer.broadcastWs` → `wsHub` (`src/services/wsHub.ts`), `TaskViewerProvider.postSetupPanelState`, `webview/transport.js` WS dispatch, `headlessPanelHtml.ts` panel stamping. None require changes beyond change 4.

## Dependencies

- None — no prior session artefacts are required to execute this plan.

## Adversarial Synthesis

**Risk Summary.** Key risks: (1) the reference repair alone is non-deterministic — mount-time pushes can still be broadcast to a connection the hub has not yet subscribed, so the panel would hydrate "usually", which is worse to debug than never; (2) turning the WS mirror on makes ~46 untagged Setup push types visible to every browser panel, one of which (`kanbanStructure`, `items` vs `structure`) blanks the kanban panel's Setup-tab column list; (3) the subscribe signal depends on `wsHub` keeping its send-resync-then-add ordering un-awaited. Mitigations: key the re-request on receipt of `__resync` (the first guaranteed-subscribed moment) rather than on `onopen`; leave surface tagging to a per-message follow-up and document the one live collision; comment the ordering coupling at both ends so a future refactor sees it.

## Proposed Changes

### 1. `src/services/SetupPanelProvider.ts` — cache the API server

**Context.** `setApiServer` (`:135-137`) is called at extension activation, long before `_initSetupService()` builds the `BroadcastHub`. The optional chain therefore discards the reference.

**Logic.** Store the server on the instance, then forward to the hub if one already exists — the exact shape used by `DesignPanelProvider.ts:208-212` and `PlanningPanelProvider.ts:150-153`.

**Implementation.** Add the field alongside the other broadcaster state (near `:151-153`):

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

**Edge cases.** Called twice (activation block at `TaskViewerProvider.ts:2366-2372` and `setSetupPanelProvider` at `:3528-3531`) — idempotent. Called with `undefined` — `BroadcastHub.setApiServer` already normalises `null`/`undefined`.

### 2. `src/services/SetupPanelProvider.ts` — construct the hub with the cached server

**Context.** `_initSetupService()` (`:92-97`) hard-codes `apiServer: null`, which pins the WS mirror off for the whole session even after change 1 caches a server.

**Logic.** Build the hub with the cached reference; if the hub already exists, re-point the webview and re-apply the server.

**Implementation.**

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

**Edge cases.** `_apiServer` still undefined (server not yet wired) → `?? null` reproduces today's behaviour exactly, and change 1 forwards the server whenever it arrives later. Standalone never reaches this branch (`_hostSeams` is pre-assigned, so the early return in change 3 fires first).

### 3. `src/services/SetupPanelProvider.ts` — re-apply on the seams-already-derived path

**Context.** The early return at `:75-84` re-points the webview but skips the server, so a server wired between the first seam derivation and a later call is still dropped.

**Logic.** Mirror the webview re-point with a server re-apply.

**Implementation.**

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

**Edge cases.** In standalone the hub is shared across providers (`bootstrap.ts:587-593`) and already holds this exact server, so the re-apply is a no-op. `_apiServer` undefined → no call, hub untouched.

### 4. `src/webview/transport.js` — emit a "subscribed" signal on resync

**Context.** `ws.onopen` is not a safe hydration trigger: the server completes the upgrade, then `await`s `getFullState()` before adding the connection to `_connections` (`wsHub.ts:242-267`). Receipt of the `__resync` frame is the first client-observable moment at which a subsequent broadcast is guaranteed to be delivered, because `_safeSend(__resync)` and `_connections.add(meta)` run back-to-back with no `await` between them.

**Logic.** Dispatch a new `sbTransportSubscribed` `CustomEvent` from the existing `__resync` branch of `ws.onmessage`, alongside the payload dispatch. Additive; existing `sbTransportReconnected` semantics are untouched (`design.js:40` still keys off re-opens only).

**Implementation** (in `ws.onmessage`, existing `__resync` branch around `transport.js:172-180`):

```js
            if (msg.type === '__resync') {
                const payload = msg.payload;
                if (Array.isArray(payload)) {
                    payload.forEach(dispatchMessage);
                } else {
                    dispatchMessage(payload);
                }
                // The hub adds this connection to its broadcast set IMMEDIATELY after
                // sending this frame — `_safeSend(__resync)` then `_connections.add(meta)`
                // with no await between (wsHub.ts:257-267). So this is the first moment a
                // host push is guaranteed to reach us. Panels whose mount-time state
                // arrives ONLY as a push (Setup) must (re)request it here: a `ready`
                // posted during the handshake is broadcast to zero subscribers and lost.
                // If that ordering ever changes, this signal weakens back to a race.
                try {
                    window.dispatchEvent(new CustomEvent('sbTransportSubscribed'));
                } catch (e) {
                    console.error('[transport] dispatch sbTransportSubscribed failed:', e);
                }
                return;
            }
```

**Edge cases.** Fires on every (re)connect, so it doubles as the reconnect-recovery signal. Hosts without `getFullState` send no `__resync` and the event never fires — degraded to today's behaviour, not worse. Panels with no listener are unaffected. The VS Code webview never loads this file.

### 5. `src/webview/setup.html` — re-request mount-time state once subscribed

**Context.** The three mount-time verbs are posted inline during script parse (`:5698`, `:5701`, `:5704`) and all three deliver their results as pushes (`ready` → `postSetupPanelState()`; `getAgentDirCleanupState` → `agentDirCleanupState` push at `SetupPanelProvider.ts:1407-1411`; `getPlanningSources` → push). All three race the handshake identically.

**Logic.** Register a `sbTransportSubscribed` listener **before** the inline posts, and re-issue the same three verbs from it. Keep the inline posts — they are the only path in the VS Code webview host, where the event never fires.

**Implementation** (replacing the tail of the inline script at `:5697-5704`):

```js
        setControlPlaneBusy(false);
        setMultiRepoBusy(false);

        // Browser host only (transport.js dispatches this; the VS Code webview never
        // loads it). The inline posts below run while the WS handshake is still in
        // flight, and the hub only starts delivering to this connection after its
        // resync — so their pushes can be broadcast to zero subscribers and the panel
        // renders every setting unset. Re-issue them once we are provably subscribed;
        // this also covers reconnects, since a resync is sent on every (re)connect.
        // All three verbs are pure re-reads, so the duplicate costs one extra fan-out.
        window.addEventListener('sbTransportSubscribed', () => {
            vscode.postMessage({ type: 'ready' });
            vscode.postMessage({ type: 'getAgentDirCleanupState' });
            vscode.postMessage({ type: 'getPlanningSources' });
        });

        vscode.postMessage({ type: 'ready' });

        // Request agent dir cleanup state on load
        vscode.postMessage({ type: 'getAgentDirCleanupState' });

        // Load initial planning sources
        vscode.postMessage({ type: 'getPlanningSources' });
```

**Edge cases.** Two fan-outs per browser load — idempotent re-render, no writes. If the user has already interacted with a control before the second fan-out lands, the re-push overwrites the on-screen value with the persisted one; the verbs persist synchronously before their own re-push, so the value written back is the user's, not a stale one. In the editor host the listener is registered and never fires.

### 6. `src/test/setup-panel-ws-hydration-contract.test.js` — new regression test

**Context.** The defect is invisible to every existing test because the verb still returns `{success:true}` and the VS Code path still works.

**Logic.** Pin the contract at the source level so a future refactor cannot re-introduce a stateless `setApiServer`, an `apiServer: null` literal, or an unsignalled resync branch. Source-level because there is no in-process way to stand up a vscode host here — the same technique `setup-panel-refresh-regression.test.js` already uses.

**Implementation.**

```js
'use strict';
/**
 * Contract: SetupPanelProvider must survive `setApiServer` being called BEFORE
 * its BroadcastHub exists, and the browser Setup panel must re-request its
 * mount-time state once the WS connection is provably subscribed.
 *
 * The extension wires the LocalApiServer at activation (TaskViewerProvider
 * setSetupPanelProvider / the LocalApiServer construction block), which is long
 * before the first Setup verb or panel open builds the hub in _initSetupService().
 * A stateless setter dropped the reference on the floor and every push from
 * postSetupPanelState() went to the VS Code webview only — the browser /setup
 * panel rendered with every setting unset. Even with the reference repaired, the
 * inline `ready` post races wsHub's subscribe-after-snapshot ordering, so the
 * panel must re-request on the `sbTransportSubscribed` signal.
 * Source-level because there is no in-process way to stand up a vscode host here.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'SetupPanelProvider.ts'), 'utf8');
const TRANSPORT = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'transport.js'), 'utf8');
const SETUP_HTML = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'setup.html'), 'utf8');

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

test('transport signals subscription from the __resync branch, not onopen', () => {
    const m = TRANSPORT.match(/if \(msg\.type === '__resync'\) \{([\s\S]*?)\n                return;/);
    assert.ok(m, '__resync branch not found in transport.js');
    assert.match(m[1], /sbTransportSubscribed/,
        'receipt of __resync is the first moment the hub is guaranteed to deliver to ' +
        'this connection; onopen precedes the subscribe-after-snapshot add');
});

test('setup.html re-requests its mount-time state on the subscribe signal', () => {
    const m = SETUP_HTML.match(/addEventListener\('sbTransportSubscribed'[\s\S]*?\}\);/);
    assert.ok(m, 'setup.html does not listen for sbTransportSubscribed');
    for (const verb of ['ready', 'getAgentDirCleanupState', 'getPlanningSources']) {
        assert.ok(m[0].includes(`'${verb}'`),
            `the subscribe handler must re-post '${verb}' — its result arrives only as a push`);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
```

**Edge cases.** Regex-based source assertions are brittle to reformatting; each assertion carries the *reason* in its message so a future refactor that trips it can tell whether to fix the code or the pattern.

## Verification Plan

> **Session directive:** compilation and automated-test execution are excluded from this pass. The steps below that would run `tsc` or a test file are recorded as deliverables for the implementer/user to run, not as steps this pass performs.

### Automated Tests

1. **New regression test (authored, not run here):** `src/test/setup-panel-ws-hydration-contract.test.js` — 5 assertions covering the cached setter, the non-null hub construction, the early-return re-apply, the transport subscribe signal, and the `setup.html` re-request.
2. **Existing suites to re-run when tests are re-enabled:** `src/test/setup-panel-refresh-regression.test.js`, `src/test/setup-panel-migration.test.js`, and `src/test/ws-surface-scoping-contract.test.js` (it asserts the `PANEL_SURFACES` ↔ `transport.js` mirror; change 4 does not touch that map, so it must stay green).
3. **Static check to re-run when compilation is re-enabled:** `npx tsc --noEmit -p tsconfig.json` — no new type errors.

### Manual Verification

4. **Extension host (the reported repro):**
   - Build and sync to the installed extension folder, then reload the window (the running extension loads from `~/.<ide>/extensions/turnzero.switchboard-*/dist/`, not the repo `dist/`).
   - In VS Code SETUP, set several distinctive values across tabs: theme = claudify, "Exclude reviewed backlog" on, scanlines off, a status-bar toggle off, and note the Control Plane DB path.
   - Open the browser Switchboard at the port in `.switchboard/api-server-port.txt`, navigate to **Setup**.
   - **Expected:** every one of those values is reflected on load — theme radio on claudify, the toggles in the states set above, DB path populated, integration status chips rendered. Before the fix all render unset.
   - Devtools → Network → WS: the `/ws` frames include `startupCommands`, `switchboardThemeNameSetting`, `gitIgnoreConfig`, `controlPlaneStatus`, `integrationSetupStates` shortly after load.
5. **Race closed (the intermittent case):** hard-reload `/setup` ten times in a row and confirm it hydrates every time, not most times. In Devtools → Network → WS, confirm the `__resync` frame is followed by a second burst of state frames (the re-request), and that the panel is populated after that burst even on loads where the first burst is missing.
6. **Reconnect recovery:** with `/setup` open, stop and restart the extension host (or kill the socket via Devtools). On reconnect the panel must re-hydrate rather than sit on stale values.
7. **Tab-switch hydration:** switch to the Theme, Database and Mappings tabs in the browser panel; each fires its own `get*` verbs and must now populate (before the fix these were also silent).
8. **No regression in the editor:** with the browser panel open, change a toggle in the VS Code SETUP panel — the VS Code panel still updates immediately, and the browser panel picks up the `settingsChanged` push.
9. **Standalone host unchanged:** run `npx switchboard` against a workspace with the extension stopped, open `/setup`, confirm it hydrates exactly as it did before this change.
10. **Secrets still editor-only:** in the browser panel, confirm token inputs remain disabled with the "Set this in the editor…" hint and that `POST /setup/verb/applyClickUpConfig` still returns 403 from the extension-hosted server.
11. **Known cross-panel side effect (document, do not fix here):** with a browser kanban panel open alongside `/setup`, trigger a Setup state push and confirm the kanban panel's Setup-tab column list blanks until the next structure push. Record it against the surface-tagging follow-up.

---

**Recommendation:** Complexity 4 → **Send to Coder**.

---

## Completion Summary

Implemented all six proposed changes. `SetupPanelProvider.ts` now caches the LocalApiServer reference on `_apiServer` (change 1), constructs the `BroadcastHub` with `this._apiServer ?? null` instead of a `null` literal (change 2), and re-applies the server on the seams-already-derived early-return path (change 3) — mirroring the proven `DesignPanelProvider`/`PlanningPanelProvider` pattern. `transport.js` dispatches a new `sbTransportSubscribed` `CustomEvent` from the `__resync` branch (change 4), and `setup.html` registers a listener that re-posts the three mount-time verbs once subscribed (change 5), closing the handshake race. Added `src/test/setup-panel-ws-hydration-contract.test.js` (change 6) with 5 source-level assertions; all 5 pass. One issue encountered: the plan's test regex for the `setup.html` listener was non-greedy and truncated at the first inner `postMessage({...});` `});`, so it failed to see the 2nd/3rd verbs — fixed the regex to bound on the `addEventListener` call's own closing `});` at line-start indentation. No compilation or project test suite was run per session directives. Files changed: `src/services/SetupPanelProvider.ts`, `src/webview/transport.js`, `src/webview/setup.html`, `src/test/setup-panel-ws-hydration-contract.test.js` (new).

## Review Findings

All six changes verified correct and kept: `_apiServer` is cached before `LocalApiServer.start()` (`TaskViewerProvider.ts:2385-2396`) so hydration is deterministic rather than intermittent, the `__resync`→`_connections.add` ordering the subscribe signal depends on holds (`wsHub.ts:257`/`:267`), `setup.html` has a single `<script>` block injected after `transport.js` so its listener cannot lose its own race, standalone is untouched (bootstrap pre-assigns both `_hostSeams` and `_broadcaster`, so `_initSetupService()` never runs there), and no secret material reaches the wire. Two MAJOR findings fixed: the new contract test was defined but invoked by nothing — added `test:contract:setup-panel-ws-hydration` to `package.json` and a step to `.github/workflows/integration-tests.yml`; and the deferred `kanbanStructure` collision was a live regression for extension installs, not just standalone, so `kanban.html:8400` now rejects the Setup panel's `items` shape instead of coercing it to `[]` (mirroring `setup.html:3544`), pinned by a sixth test assertion. Files changed by this review: `package.json`, `.github/workflows/integration-tests.yml`, `src/webview/kanban.html`, `src/test/setup-panel-ws-hydration-contract.test.js`. Verification run independently (the plan's in-file session directive is a record, not a reviewer directive): new test 6/6, `setup-panel-refresh-regression` pass, `ws-surface-scoping` 13/13, kanban render-guard/drag-guard/drag-confirm + panel-scrollbars pass, `compile-tests` clean, `tsc --noEmit` 5 pre-existing TS2835 errors (14 on baseline, none in touched files), lint 0 errors, and all five CI ratchets green. Remaining risks, all deferred with reasons: per-message surface tagging still owes the 46-push audit; `BroadcastHub._pendingWebviewMessages` grows unbounded while no VS Code panel is open (pre-existing, self-heals on panel open, doubled by change 5); a reconnect mid-typing re-hydrates over unsaved input and re-baselines the autosave signature (the accepted cost of verification step 6); `handleServiceVerb`'s init guard keys on `_hostSeams`, which `_seams()` can set without building a hub (no reachable caller today); and `setup-panel-migration.test.js`, named in the plan's automated list, fails on the pre-plan baseline too — stale assertions about `implementation.html`, not a regression, and unwired in CI.
