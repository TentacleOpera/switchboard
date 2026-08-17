# Connections panel Create Plans section never initialises in the browser — three push-only Planning arms are tagged for the wrong surface

## Goal

Make the three `createPlans*` arms that the Connections panel calls deliver their payload to the
Connections panel in the browser cockpit, by returning a typed body instead of pushing on the
`planning` surface.

### Problem

Open the Connections panel in the browser cockpit (`/connections`). The **Create Plans** section
renders its chrome and then stays inert:

- The "include extras" checkbox never reflects whether managed docs exist, and the saved public
  URL / platform / platform-reference fields come up blank even after they were saved.
- "Pick folder" opens the picker, the user chooses a folder, and the panel never shows which folder
  was picked.
- "Paste back" imports the plan but the panel never reports success or failure.

The same section works in the VS Code Connections webview panel.

### Root cause

`connections.js:27` posts `createPlansInit` on load and handles the reply at `connections.js:557`
(`createPlansState`, `createPlansFolderPicked`, `createPlansPasteBackResult`). Those three payloads
never arrive in the browser, because **neither of the two delivery channels carries them**.

**Channel 1 — the HTTP return body.** The browser Connections page POSTs to
`/connections/verb/<verb>`. `LocalApiServer.ts:3759` resolves the verb against the generated
allowlists and calls `_handlePlanningVerb` **directly** — `ConnectionsPanelProvider` is not in the
browser path at all. The three arms are push-only and fall out of the switch on `break` with no
typed return:

`src/services/PlanningPanelProvider.ts:3019` (`createPlansInit`)

```ts
this.postMessageToWebview({
    type: 'createPlansState',
    hasDocs, publicUrl: ..., platform: ..., platformRef: ...
});
break;                                   // ← no return value
```

`:3060` (`createPlansPickFolder`) does the same with `createPlansFolderPicked`; `:3108`
(`createPlansPasteBack`) with `createPlansPasteBackResult` on all three of its exits.

`transport.js` only re-dispatches a response body that carries a `type` — a body without one is
dropped silently. This is the documented browser return-contract; `DesignPanelProvider` already
obeys it (`return { success: true, type: 'designReadyComplete', ... }`).

**Channel 2 — the WebSocket push.** `postMessageToWebview` (`PlanningPanelProvider.ts:927`) tags
every push `'planning'`:

```ts
this._broadcaster.push(message, 'planning');
```

The Connections cockpit page connects with `surfaces=connections,common`
(`PANEL_SURFACES.connections` in `wsHub.ts`, mirrored in `transport.js`), so `wsHub.broadcast`
(`wsHub.ts:393`) skips the connection:

```ts
if (surface && meta.surfaces && !meta.surfaces.has(surface)) { continue; }
```

Both channels drop the payload, so the section is permanently uninitialised. The editor panel is
unaffected: `ConnectionsPanelProvider._forwardToTargetProvider` (`:146`) monkey-patches
`postMessageToWebview` for the duration of the call and writes straight to the Connections webview,
so the editor gets the push regardless of the tag.

### Why the fix is "return a typed body", not "widen the subscription"

Adding `SURFACES.planning` to `PANEL_SURFACES.connections` would also make it work — and is the
wrong trade. The Connections panel would then receive **every** Planning push (doc trees, previews,
`restoredTabState`, `workspaceItemsUpdated`, ticket listings), which is precisely the
over-delivery the surface filter exists to stop, and the Connections handler switch would start
seeing message types it was never written for. The return-contract fix is targeted, needs no map
edit in two files, and matches how the Design panel's equivalent arms were already resolved.

## Metadata

- **Complexity:** 3
- **Tags:** bugfix, backend, frontend, ui
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine.** Three arms gain a typed return value. No new mechanism, no state, no migration — the
return-contract they need is already used by sibling providers and already understood by
`transport.js`.

**Risky bits, and why they are contained:**

- *Double delivery in the editor.* Keeping the existing `postMessageToWebview` call **and** adding a
  return means the editor Connections panel receives the payload twice (once via the monkey-patched
  push, once via `_forwardToTargetProvider`'s trailing `panel.webview.postMessage(result)` at
  `ConnectionsPanelProvider.ts:175`). All three payloads are idempotent renders — `createPlansState`
  sets field values, `createPlansFolderPicked` sets a label, `createPlansPasteBackResult` sets a
  status line — so a second identical render is invisible. Keep the push: removing it would break
  the Planning panel's own Create Plans section, which is a legitimate consumer on the `planning`
  surface.
- *`createPlansPasteBack` has three exit points* (empty input, oversize input, success/failure).
  Every one of them must return the same shape it pushes, or the browser silently loses exactly the
  error case the user needs to see.
- *`createPlansPickFolder` may not fire at all in standalone* — it depends on the
  `showOpenDialog` seam, which is a no-op in a headless host. Return the payload only when a folder
  was actually picked; returning an empty `folder` would blank a previously-picked label.

## Edge-Case & Dependency Audit

- **The verb allowlist is unchanged.** All six `createPlans*` verbs are already in `PLANNING_VERBS`
  (`src/generated/verbAllowlist.ts`); no `npm run catalog:generate` run is needed.
- **The other three `createPlans*` arms are fine.** `createPlansCopyPrompt` and
  `createPlansImproveSource` are clipboard+notification only (no payload to deliver);
  `createPlansDownloadZip` is a separate download path. Do not touch them.
- **`ConnectionsPanelProvider` needs no change.** It is not on the browser path, and its editor path
  already works. Its WS mirror at `:148` (`b.mirrorToWs('planning', msg, ...)`) is correctly scoped
  for what it does — it exists so a *remote* Planning client stays in step, not to feed the
  Connections panel.
- **Do not "fix" this by making `postMessageToWebview` untagged.** Untagged pushes go to every
  connection (`wsHub.broadcast`), which is the class of defect that puts Design's file content in
  the Planning panel's Docs pane. The tag is correct; the missing return is the bug.
- **`_stateStore` reads in `createPlansInit` are panel-scoped.** In the standalone host every panel
  shares one `PanelStateStore` keyed `'standalone'` (`src/standalone/bootstrap.ts:685`), so
  `createPlans.publicUrl` / `.platform` / `.platformRef` are already whatever the last writer left.
  That is pre-existing and out of scope here — this plan changes delivery, not storage.
- **Related but separate:** the Setup-side arms the Connections panel calls (`getRemoteConfig`,
  `getRemoteHealth`, `setRemoteConfig`, `runNotionRemoteSetup`, `copyLinearAgentSkill`,
  `regenerateSparkContext`, `getIntegrationSetupStates`) have the *same* push-only shape but
  currently work in the browser by accident, because `SetupPanelProvider.postMessage` is untagged.
  They are covered by the Kanban/Setup surface-tagging plan, which cannot land until they are
  converted. Not fixed here.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts` — return what these arms push

**`createPlansInit` (line 3019).** Build the payload once, push it, and return it:

```ts
            case 'createPlansInit': {
                const cpRoot = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                let hasDocs = false;
                try { hasDocs = cpRoot ? (await this._collectExtraDocSources(cpRoot)).length > 0 : false; } catch { hasDocs = false; }
                // The browser Connections panel reaches this arm through
                // /connections/verb → _handlePlanningVerb, so the WS push (tagged
                // 'planning') never reaches it — transport.js re-dispatches the RETURN
                // body, and only when it carries a `type`. Push AND return.
                const cpState = {
                    type: 'createPlansState',
                    hasDocs,
                    publicUrl: this._stateStore.getPanelState<string>('createPlans.publicUrl') || '',
                    platform: this._stateStore.getPanelState<string>('createPlans.platform') || 'Notion',
                    platformRef: this._stateStore.getPanelState<string>('createPlans.platformRef') || ''
                };
                this.postMessageToWebview(cpState);
                return { success: true, ...cpState };
            }
```

**`createPlansPickFolder` (line 3060).** Return only when a folder was chosen:

```ts
                const folder = picked && picked.length > 0 ? picked[0] : '';
                if (folder) {
                    const pickedMsg = { type: 'createPlansFolderPicked', folder };
                    this.postMessageToWebview(pickedMsg);
                    return { success: true, ...pickedMsg };
                }
                break;
```

**`createPlansPasteBack` (line 3108).** All three exits return the payload they push:

```ts
                if (!markdown.trim()) {
                    const res = { type: 'createPlansPasteBackResult', ok: false, error: 'Paste a markdown plan first.' };
                    this.postMessageToWebview(res);
                    return { success: true, ...res };
                }
                if (markdown.length > 200_000) {
                    const res = { type: 'createPlansPasteBackResult', ok: false, error: 'Plan is too large (>200 KB).' };
                    this.postMessageToWebview(res);
                    return { success: true, ...res };
                }
                ...
                try {
                    await this._seams().commands.executeCommand(...);
                    const res = { type: 'createPlansPasteBackResult', ok: true, projectName: cpProject };
                    this.postMessageToWebview(res);
                    return { success: true, ...res };
                } catch (err) {
                    const res = { type: 'createPlansPasteBackResult', ok: false, error: err instanceof Error ? err.message : String(err) };
                    this.postMessageToWebview(res);
                    return { success: true, ...res };
                }
```

Note the `success: true` on the error exits: `ok: false` is the *domain* result the panel renders;
`success` is the transport-level verb outcome, and a `success: false` body makes `transport.js`
surface a red rail banner instead of the inline error the panel is written to show.

### `src/test/connections-routing-contract.test.js` — pin the return contract

The suite already exists (`npm run test:contract:connections-routing`). Add a source-text assertion
that each push-only arm consumed by the Connections panel also returns a typed body:

```js
test('Connections-consumed createPlans arms return a typed body, not just a push', () => {
    ['createPlansState', 'createPlansFolderPicked', 'createPlansPasteBackResult'].forEach(type => {
        const pushes = (planningProviderCode.match(new RegExp(`type: '${type}'`, 'g')) || []).length;
        const returns = (planningProviderCode.match(
            new RegExp(`return \\{ success: true, \\.\\.\\.\\w+ \\}`, 'g')) || []).length;
        assert.ok(pushes > 0, `${type} must still be built`);
        assert.ok(returns > 0,
            `the browser Connections panel reaches these arms via /connections/verb → `
            + `_handlePlanningVerb; the 'planning'-tagged push never reaches a `
            + `connections-subscribed client, so the RETURN body is the only channel`);
    });
});
```

## Verification Plan

1. **Contract tests** — `npm run test:contract:connections-routing` and
   `npm run test:contract:verb-engine-planning`. Add the new assertion first and confirm it fails at
   HEAD for the stated reason, then passes after the change.
2. **Compile/lint** — `npm run compile-tests` and `npm run lint`.
3. **Browser UAT (the reported path)** — open the cockpit's Connections panel from the installed
   VSIX's browser host:
   - On load, the Create Plans section must populate: the extras checkbox reflects whether managed
     docs exist, and a previously saved public URL / platform / reference come back.
   - Click "Pick folder", choose a folder → the panel shows the chosen folder.
   - Paste an empty box and submit → the inline error "Paste a markdown plan first." appears (not a
     rail banner).
   - Paste a valid plan and submit → the success line appears and the plan lands on the board.
4. **Editor UAT (no regression, and no visible double render)** — open the Connections panel in
   VS Code and repeat step 3. Each action must render exactly once as far as the user can tell.
5. **Planning panel UAT (the other legitimate consumer)** — open the Planning panel's Create Plans
   surface and confirm init, folder pick and paste-back still behave; the `planning`-tagged push is
   what serves it and must be untouched.
6. **Network check** — with the browser devtools Network tab open on the Connections page, confirm
   the `POST /connections/verb/createPlansInit` response body now carries
   `"type":"createPlansState"`. That single line is the whole fix; if it is absent, nothing else in
   this plan matters.
