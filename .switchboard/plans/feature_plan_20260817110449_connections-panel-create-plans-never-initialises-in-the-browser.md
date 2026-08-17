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
`/connections/verb/<verb>`. `LocalApiServer.ts:3821` resolves the verb against the generated
allowlists and calls `_handlePlanningVerb` (`LocalApiServer.ts:2084`) **directly** —
`ConnectionsPanelProvider` is not in the browser path at all. The three arms are push-only and fall
out of the switch on `break` with no typed return:

> **Superseded:** `LocalApiServer.ts:3759` names the `/connections/verb/` branch.
> **Reason:** Verified against HEAD — the branch starts at `LocalApiServer.ts:3821`; 3759 is inside
> the `/health` / `/metadata` block. A wrong anchor sends the coder to the wrong `else if` chain.
> **Replaced with:** `LocalApiServer.ts:3821` (branch), `LocalApiServer.ts:2084` (`_handlePlanningVerb`).

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

`_handlePlanningVerb` serialises `result ?? { success: true }` (`LocalApiServer.ts:2104`), so a
`break` reaches the browser as a bare, **untyped** `{"success":true}`. `transport.js:410` only
re-dispatches a response body that carries a `type` — a body without one is dropped silently. This
is the documented browser return-contract; `DesignPanelProvider` already obeys it
(`return { success: true, type: 'designReadyComplete', ... }`), as does this provider's own
`fetchPreview` arm (`PlanningPanelProvider.ts:2999`).

**Channel 2 — the WebSocket push.** `postMessageToWebview` (`PlanningPanelProvider.ts:927`) tags
every push `'planning'`:

```ts
this._broadcaster.push(message, 'planning');
```

The Connections cockpit page connects with `surfaces=connections,common`
(`PANEL_SURFACES.connections` in `wsHub.ts:78`, mirrored as `PANEL_SURFACES_MAP` in
`transport.js:120`), so `wsHub.broadcast` (`wsHub.ts:393`) skips the connection:

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

### The Create Plans UI now lives ONLY in the Connections panel

Load-bearing fact for everything below, verified at HEAD: the Web Agents / Create Plans UI **moved**
out of the Planning panel. `planning.html:3862` is a signpost div ("Web Agents has moved") with no
controls and no handlers; the live UI is `connections.html:490` driven by `connections.js:400–466`.
`createPlansInit` / `createPlansState` / `createPlansFolderPicked` / `createPlansPasteBackResult`
appear in **`connections.js` and nowhere else** under `src/webview/`.

So the Connections panel is the **only** consumer of these three payloads. The `'planning'`-tagged
push has exactly one live delivery path left — the editor's monkey-patched forward — and zero WS
subscribers that do anything with it.

## Metadata

- **Complexity:** 4
- **Tags:** bugfix, backend, frontend, ui
- **Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine

- Three arms gain a typed return value. No new mechanism, no state, no migration — the
  return-contract they need is already used by sibling providers (`fetchPreview` in this same file)
  and already understood by `transport.js`.
- The verb allowlist, `protocol-catalog.json` verb sets, and `verbSchemas.ts` are all unchanged: the
  six `createPlans*` verbs are already in `PLANNING_VERBS` (`src/generated/verbAllowlist.ts:9`) and
  in `CATALOG.providers.Planning.verbs`. Verbs with no schema pass through by design
  (`PlanningPanelProvider.ts:143`).
- Registering one command handler in the standalone bootstrap alongside the ~20 already there
  (`src/standalone/bootstrap.ts:894–970`), reusing the existing `createAndIngestPlan` helper (`:595`).

### Complex / Risky

- **Standalone `createPlansPasteBack` currently lies if you only add the return.** In the standalone
  host `switchboard.importPlanFromClipboard` is registered **only in `src/extension.ts:1150`** —
  `switchboardCommandRegistry` in `bootstrap.ts` never registers it. The seam falls through to
  `vscodeShim.executeCommand` (`src/standalone/vscodeShim.ts:244`), which warns once and returns
  `undefined` **without throwing**. The arm therefore takes its success branch. Today that produces
  a silent no-op; add the return and it produces `ok: true` — "Plan card created" rendered over a
  plan that was never created. This is the exact "stub that fakes success" PRD contract #6 forbids,
  and it is a regression **introduced by this plan**, so this plan must close it (change D).
- **Double delivery in the editor.** Keeping the existing `postMessageToWebview` call **and** adding
  a return means the editor Connections panel receives the payload twice (once via the
  monkey-patched push, once via `_forwardToTargetProvider`'s trailing
  `panel.webview.postMessage(result)` at `ConnectionsPanelProvider.ts:175`). Verified idempotent
  against `connections.js:430–465`: `createPlansState` only fills fields that are still empty
  (`if (urlInput && !urlInput.value && …)`) and sets a `disabled` flag; `createPlansFolderPicked`
  assigns a label and a `disabled` flag; `createPlansPasteBackResult` clears the textarea and writes
  a status line. A second identical render is invisible.

  > **Superseded:** "Keep the push: removing it would break the Planning panel's own Create Plans
  > section, which is a legitimate consumer on the `planning` surface."
  > **Reason:** Factually wrong at HEAD. The Planning panel's Create Plans tab is a "Web Agents has
  > moved" signpost (`planning.html:3862`) with no handler for any of these three types; the only
  > consumer in `src/webview/` is `connections.js`. Keeping the push for a consumer that does not
  > exist is a reason that will not survive the next reader, and it also produced a Verification
  > Plan step that tests a UI that isn't there.
  > **Replaced with:** Keep the push because PRD contract #4 makes it the standing shape — "every
  > verb arm **returns** its result in the HTTP body; the webview push stays additive" — and because
  > byte-compatibility on ~4,000 shipped installs (contract #2) says an in-place return-contract fix
  > does not also delete a shipped push. Removing the push is a separate, deliberate decision with
  > its own push-routing consequences; it is not this plan's business.

- **`createPlansPasteBack` has three exit points** (empty input, oversize input, success/failure).
  Every one of them must return the same shape it pushes, or the browser silently loses exactly the
  error case the user needs to see.
- **`createPlansPickFolder` cannot fire in standalone.** `createHeadlessHostSeams` /
  `vscodeShim` supply `showOpenDialog: async () => undefined`
  (`src/standalone/hostServices.ts:433`), so `picked` is `undefined`, `folder` is `''`, and the arm
  returns nothing. Return the payload only when a folder was actually picked; returning an empty
  `folder` would blank a previously-picked label **and** fake a pick that never happened. The button
  therefore stays a dead click under `npx` — see the Edge-Case audit for why that is deliberately
  not fixed here.

## Edge-Case & Dependency Audit

**Race Conditions.**

- The editor's double delivery (push, then return-post) is two synchronous `postMessage` calls on
  the same webview microseconds apart, in a fixed order — no interleaving window a user can reach.
- `ConnectionsPanelProvider` already serialises forwards on `_forwardChain`
  (pinned by `connections-routing-contract.test.js`), so the `postMessageToWebview` monkey-patch
  cannot interleave with the 15 s `getRemoteHealth` poll. Adding a return value does not touch that.
- `createPlansInit` fires once on panel load (`connections.js:27`); there is no repeat-init loop to
  amplify.

**Security.**

- No new verb, no new route, no widened allowlist, no new secret read. The three arms already run
  behind `_checkAuth` (`LocalApiServer.ts:2085`) and the `PLANNING_VERBS` guard
  (`PlanningPanelProvider.ts:139`).
- The returned bodies carry no credentials: `hasDocs` (bool), a user-entered public URL, a platform
  name, a platform reference, a picked folder path, and an import status. The folder path is one the
  *host user* chose in a host dialog, so it discloses nothing the caller did not already trigger.
- `markdown` is still capped at 200 KB before it reaches the importer; that cap is unchanged.

**Side Effects.**

- The push stays, so WS clients tagged `planning` keep receiving these three types. Nothing
  subscribes to them today, so the observable effect is nil — but the ratchet, the push-routing
  check and the shipped-install contract all prefer additive over subtractive here.
- Converting `break` → `return` lowers `PlanningPanelProvider`'s residual `break` count. The ratchet
  (`npm run verb-returns:check`) only fails on an **excess** over the ceiling, so it will not go red
  — but PRD "Enforcement" says the win is locked by ratcheting the ceiling down in the same change.
  Do that with `npm run verb-returns:baseline` (change G); do not hand-edit the JSON, and never
  force a ceiling to 0.
- `protocol-catalog.json` records each arm's **line number** (`createPlansInit` → 3019,
  `createPlansPickFolder` → 3060, `createPlansPasteBack` → 3108). Editing the arms shifts later
  lines, so re-run `npm run catalog:generate` to keep the catalog honest even though the **verb
  sets** are unchanged. `npm run parity:check` compares allowlists ≡ catalogs, not line numbers, so
  a stale catalog will not fail CI — regenerate it anyway rather than leaving drift for the next
  reader.

**Dependencies & Conflicts.**

- **`ConnectionsPanelProvider` needs no change.** It is not on the browser path, and its editor path
  already works. Its WS mirror at `:148` (`b.mirrorToWs('planning', msg, ...)`) is correctly scoped
  for what it does — it exists so a *remote* Planning client stays in step, not to feed the
  Connections panel.
- **Do not "fix" this by making `postMessageToWebview` untagged.** Untagged pushes go to every
  connection (`wsHub.broadcast`), which is the class of defect that puts Design's file content in
  the Planning panel's Docs pane. The tag is correct; the missing return is the bug.
- **Do not retag these three pushes `'connections'` either.** It is technically available
  (`_pushTo(panel, surface, msg)` exists for per-message surfaces) and would work now that Planning
  has no consumer — but it delivers over a fire-and-forget rail with no request/response
  correlation, and PRD contract #4 mandates the body anyway. The body is the answer; the tag is not.
- **`_stateStore` reads in `createPlansInit` are panel-scoped.** In the standalone host every panel
  shares one `PanelStateStore` keyed `'standalone'` (`src/standalone/bootstrap.ts:753`), so
  `createPlans.publicUrl` / `.platform` / `.platformRef` are already whatever the last writer left.
  That is pre-existing and out of scope here — this plan changes delivery, not storage.
- **Standalone "Pick folder" stays a dead click, deliberately.** The honest fix for a host that
  cannot open a folder dialog is capability-gating the control (PRD contract #6: "absent or
  disabled, never a control that dead-clicks"), which means plumbing a host capability into
  `connections.html` — a new mechanism with its own design surface. Faking a folder or emitting a
  "cancelled" toast would both be worse. Decision: not fixed here; raise it against the `/panels`
  capability work.
- **`createPlansCopyPrompt` and `createPlansImproveSource` have a real but different browser gap.**

  > **Superseded:** "The other three `createPlans*` arms are fine. `createPlansCopyPrompt` and
  > `createPlansImproveSource` are clipboard+notification only (no payload to deliver)."
  > **Reason:** "No payload to deliver" is the wrong reading. `this._seams().clipboard.writeText`
  > writes the **host's** clipboard (`hostSeams.ts`; standalone logs and discards —
  > `src/standalone/hostServices.ts:442`), and `showTemporaryNotification` raises a **VS Code
  > toast** (standalone: `console.log`, `hostServices.ts:428`). In a browser tab the user sees no
  > confirmation at all, and the guard exits ("Enter the platform reference first") are invisible —
  > a dead click. `transport.js:371` already bridges a `result.prompt` field to the *browser*
  > clipboard, which is precisely the missing return here.
  > **Replaced with:** These arms have the same root cause but a different symptom and a different
  > return shape (`{ success: true, prompt }`, plus a typed status body for the guard exits). They
  > are **out of scope for this plan** — it is scoped to the three arms that leave the section
  > uninitialised — and are recorded as a follow-up plan, not declared "fine".

- **Related but separate:** the Setup-side arms the Connections panel calls (`getRemoteConfig`,
  `getRemoteHealth`, `setRemoteConfig`, `runNotionRemoteSetup`, `copyLinearAgentSkill`,
  `regenerateSparkContext`, `getIntegrationSetupStates`) have the *same* push-only shape but
  currently work in the browser by accident, because `SetupPanelProvider.postMessage` is untagged.
  They are covered by the Kanban/Setup surface-tagging plan, which cannot land until they are
  converted. Not fixed here.

## Dependencies

- None — no session in flight owns these arms. `PlanningPanelProvider.ts` is a single-stream file
  per PRD "Orchestration discipline"; confirm no other agent is editing it before starting.

## Adversarial Synthesis

**Risk Summary.** The delivery fix itself is low risk — three arms gain a typed return, the push
stays additive per PRD contract #4, and every payload is idempotent so the editor's resulting double
render is invisible. The two real risks are honesty risks the naive version of this change *creates*:
in the standalone host `switchboard.importPlanFromClipboard` is unbridged, so returning `ok: true`
would report "Plan card created" over a no-op, and the originally proposed source-regex test already
matches 18 times at HEAD, so it would go green without the fix ever landing. Mitigations: bridge the
command in `bootstrap.ts` reusing the existing `createAndIngestPlan` helper, and verify with
behavioural headless tests that assert the returned **body carries data** (the existing
`verb-engine-planning-headless.test.js` harness) rather than with a source-text count.

## Proposed Changes

### A. `src/services/PlanningPanelProvider.ts` — `createPlansInit` (line 3019)

Build the payload once, push it, and return it:

```ts
            case 'createPlansInit': {
                const cpRoot = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
                // hasDocs now reports whether managed extras (constitution / PRDs /
                // README) exist — it gates the "include extras" checkbox, not the zip.
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

### B. `src/services/PlanningPanelProvider.ts` — `createPlansPickFolder` (line 3060)

Return only when a folder was chosen. The `break` on the no-folder path is deliberate: it is the
cancelled/headless case, and an empty `folder` would blank a previously-picked label.

```ts
                const folder = picked && picked.length > 0 ? picked[0] : '';
                if (folder) {
                    const pickedMsg = { type: 'createPlansFolderPicked', folder };
                    this.postMessageToWebview(pickedMsg);
                    return { success: true, ...pickedMsg };
                }
                break;
```

### C. `src/services/PlanningPanelProvider.ts` — `createPlansPasteBack` (line 3108)

All three exits return the payload they push:

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
                    return { ...res, success: false };
                }
```

`success` and `ok` are different axes. The two validation exits return `success: true` because the
verb **did** run correctly — `ok: false` is the domain result the panel renders inline, and a
`success: false` there makes `transport.js:377` raise a red rail banner on top of an input-validation
message the panel already shows.

> **Superseded:** "Note the `success: true` on the error exits" — applied uniformly to all three
> failure paths, including the `catch`.
> **Reason:** The `catch` is not input validation; it is the import genuinely failing, and PRD
> contract #4 is explicit that "failure branches — **including the aggregate `catch`** — return
> `{success:false, error}` so an HTTP caller sees the failure, never a false success". Returning
> `success: true` there also makes `_handlePlanningVerb` answer HTTP 200 for a failed import, which
> is what a scripted caller reads. `transport.js:402` still re-dispatches a **typed** failure body,
> so the inline status line renders either way — this is exactly the shape this provider's own
> `fetchPreview` arm already uses (`PlanningPanelProvider.ts:3001`: `return { ...res, success: false }`
> for `previewError`).
> **Replaced with:** validation exits keep `success: true, ok: false`; the `catch` exit returns
> `{ ...res, success: false }`.

### D. `src/standalone/bootstrap.ts` — bridge `switchboard.importPlanFromClipboard`

**Why this is not scope creep.** Without it, change C converts a silent standalone no-op into a
rendered false success. The plan's own goal is that paste-back "reports success or failure"; a
report that is wrong is worse than no report, and PRD contract #6 forbids a stub that fakes success.

Register alongside the existing handlers (`bootstrap.ts:894–970`), reusing `createAndIngestPlan`
(`:595`) and mirroring the title/split/cap rules the `importFromClipboard` kanban arm already
implements at `:1050–1085`:

```ts
    // PlanningPanelProvider's createPlansPasteBack arm (Connections → Web Agents)
    // calls this command through the commands seam. It is registered in
    // src/extension.ts:1150 for the extension host ONLY; unregistered here the seam
    // falls through to vscodeShim.executeCommand, which warns and returns undefined
    // WITHOUT throwing — so the arm reports a success for a plan that was never
    // written. Bridge it to the same ingest path the board's own clipboard import uses.
    switchboardCommandRegistry.register('switchboard.importPlanFromClipboard', async (markdownText?: string, _options?: { projectName?: string }) => {
        const md = typeof markdownText === 'string' ? markdownText : '';
        if (!md.trim()) {
            throw new Error('Clipboard import needs markdown from the browser; none was provided (headless has no server-side clipboard access).');
        }
        if (md.length > 200_000) {
            throw new Error('Clipboard content too large (>200 KB). Aborting import.');
        }
        const extractTitle = (text: string): string => {
            const h1 = text.match(/^#\s+(.+)$/m); if (h1) { return h1[1].trim(); }
            const h2 = text.match(/^##\s+(.+)$/m); if (h2) { return h2[1].trim(); }
            const h3 = text.match(/^###\s+(.+)$/m); if (h3) { return h3[1].trim(); }
            return 'Imported Plan';
        };
        const hasMulti = /^---\s*PLAN\s*---\s*$/m.test(md);
        const chunks = hasMulti
            ? md.split(/^---\s*PLAN\s*---\s*$/m).map((s: string) => s.trim()).filter(Boolean)
            : [md.trim()];
        for (const chunk of chunks) {
            await createAndIngestPlan(workspaceRoot, extractTitle(chunk), chunk);
        }
        await pushFullState();
    });
```

Throwing (rather than returning an error object) is what makes change C's `catch` fire, so the
browser gets `ok: false` with the real reason instead of a false success.

`_options.projectName` is intentionally ignored: `createAndIngestPlan` has no project parameter, and
every other standalone plan-creation route (`createPlan` at `:1033`, `importFromClipboard` at
`:1079`) already relies on the importer stamping the board's active project. Honouring the pin here
would be a second, different project-assignment path — out of scope, and the plan lands assignable on
the board either way. `connections.js:457` already renders the "unassigned — assign on the board"
branch when `projectName` is null.

### E. `src/test/verb-engine-planning-headless.test.js` — behavioural proof (primary)

> **Superseded:** the sole new test was a source-text assertion in
> `src/test/connections-routing-contract.test.js` counting `type: '<Type>'` pushes against a global
> `return { success: true, ...\w+ }` regex.
> **Reason:** Three defects, and the plan instructed the coder to "confirm it fails at HEAD", which
> it cannot. (1) `planningProviderCode` is never defined in that file — it reads `connections.js`,
> `LocalApiServer.ts`, `ConnectionsPanelProvider.ts`, `transport.js` and the catalog, not
> `PlanningPanelProvider.ts`. (2) The regex already matches **18 times at HEAD**
> (`PlanningPanelProvider.ts:1664, 2002, 2812, 2825, 3585, …`), so `returns > 0` is true before any
> change — a permanently green assertion that proves nothing. (3) The count is file-global while the
> loop is per-type, so the three iterations assert the identical fact three times and no individual
> arm is ever checked. A green metric that counts unrelated arms as "done" is exactly the
> goal-vs-appearance failure this fix is about.
> **Replaced with:** behavioural tests in the existing headless harness, plus a correctly-scoped
> structural guard (change F). PRD Enforcement requires "a headless test must assert the returned
> **body carries data** (not just `success`)" — a source-text count cannot satisfy that.

`src/test/verb-engine-planning-headless.test.js` already drives `handleServiceVerb` end-to-end under
a booby-trapped `vscode` module with an in-memory seam bundle, and records pushes
(`buildHeadlessPlanningProvider` returns `{ provider, seams, recorders, stateStore, pushes, projectPushes }`).
`createHeadlessTestSeams` accepts `showOpenDialogResult` and records `recorders.executedCommands`, so
all three arms are drivable there. Add, following the file's existing
"RETURNS in-body … and keeps push additive" pattern:

```js
    await test('createPlansInit RETURNS the createPlansState body and keeps push additive', async () => {
        const { provider, pushes, stateStore } = buildHeadlessPlanningProvider(tmpRoot);
        await stateStore.setPanelState('createPlans.publicUrl', 'https://docs.example/plan');
        await stateStore.setPanelState('createPlans.platformRef', 'DOC-42');
        const result = await provider.handleServiceVerb('createPlansInit', { workspaceRoot: tmpRoot });
        assert.strictEqual(result.success, true);
        // The body must carry DATA, not just an ack — this is the whole fix.
        assert.strictEqual(result.type, 'createPlansState');
        assert.strictEqual(typeof result.hasDocs, 'boolean');
        assert.strictEqual(result.publicUrl, 'https://docs.example/plan');
        assert.strictEqual(result.platform, 'Notion');
        assert.strictEqual(result.platformRef, 'DOC-42');
        assert.ok(pushes.find(p => p.type === 'createPlansState'), 'webview push stays additive');
    });

    await test('createPlansPickFolder RETURNS the picked folder, and returns nothing when cancelled', async () => {
        const picked = buildHeadlessPlanningProvider(tmpRoot, { showOpenDialogResult: [path.join(tmpRoot, 'docs')] });
        const ok = await picked.provider.handleServiceVerb('createPlansPickFolder', { workspaceRoot: tmpRoot });
        assert.strictEqual(ok.type, 'createPlansFolderPicked');
        assert.strictEqual(ok.folder, path.join(tmpRoot, 'docs'));
        assert.ok(picked.pushes.find(p => p.type === 'createPlansFolderPicked'), 'webview push stays additive');

        // Cancelled / headless: showOpenDialog resolves undefined. Returning an empty
        // `folder` here would blank a previously-picked label in the panel.
        const cancelled = buildHeadlessPlanningProvider(tmpRoot, { showOpenDialogResult: undefined });
        const none = await cancelled.provider.handleServiceVerb('createPlansPickFolder', { workspaceRoot: tmpRoot });
        assert.ok(!none || none.type !== 'createPlansFolderPicked', 'a cancelled pick must not fabricate a folder');
    });

    await test('createPlansPasteBack RETURNS a typed body on every exit', async () => {
        const empty = buildHeadlessPlanningProvider(tmpRoot);
        const r1 = await empty.provider.handleServiceVerb('createPlansPasteBack', { workspaceRoot: tmpRoot, markdown: '   ' });
        assert.strictEqual(r1.type, 'createPlansPasteBackResult');
        assert.strictEqual(r1.ok, false);
        assert.match(r1.error, /Paste a markdown plan first/);
        // Input validation is not a transport failure — a success:false here makes
        // transport.js raise a rail banner over the panel's own inline message.
        assert.strictEqual(r1.success, true);

        const big = buildHeadlessPlanningProvider(tmpRoot);
        const r2 = await big.provider.handleServiceVerb('createPlansPasteBack', { workspaceRoot: tmpRoot, markdown: 'x'.repeat(200_001) });
        assert.strictEqual(r2.ok, false);
        assert.match(r2.error, /too large/);

        const okRun = buildHeadlessPlanningProvider(tmpRoot);
        const r3 = await okRun.provider.handleServiceVerb('createPlansPasteBack', { workspaceRoot: tmpRoot, markdown: '# A plan\n\nbody' });
        assert.strictEqual(r3.type, 'createPlansPasteBackResult');
        assert.strictEqual(r3.ok, true);
        assert.ok(okRun.recorders.executedCommands.some(c => c.command === 'switchboard.importPlanFromClipboard'),
            'the success branch must be reached through the import command, not by falling through');
        assert.ok(okRun.pushes.find(p => p.type === 'createPlansPasteBackResult'), 'webview push stays additive');
    });
```

**Read this before trusting the green.** The test seam's `executeCommand` records and resolves, so
the success case passes here *whether or not* the command is bridged in a real headless host. That
is precisely the standalone false-success hole, and it is why change D carries its own assertion in
change F rather than relying on this file.

### F. `src/test/connections-routing-contract.test.js` — structural guards (secondary)

This file already owns "the Connections panel's verbs must behave the same in both hosts", so both
guards belong here. It does not currently read `PlanningPanelProvider.ts` or `bootstrap.ts` — add the
reads:

```js
const PLANNING = fs.readFileSync(path.join(ROOT, 'src', 'services', 'PlanningPanelProvider.ts'), 'utf8');
const BOOTSTRAP = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'bootstrap.ts'), 'utf8');

// Scope each assertion to its own arm. A file-global `return { success: true, ... }`
// count is useless: PlanningPanelProvider already has 18 of them, so a global check
// is green before the fix lands and stays green if the fix is reverted.
function armBody(verb) {
    const start = PLANNING.indexOf(`case '${verb}': {`);
    assert.ok(start >= 0, `arm '${verb}' not found`);
    const next = PLANNING.indexOf("            case '", start + 10);
    return PLANNING.slice(start, next > start ? next : start + 4000);
}

test('Connections-consumed createPlans arms return their typed body, not just a push', () => {
    for (const [verb, type] of [
        ['createPlansInit', 'createPlansState'],
        ['createPlansPickFolder', 'createPlansFolderPicked'],
        ['createPlansPasteBack', 'createPlansPasteBackResult'],
    ]) {
        const body = armBody(verb);
        assert.ok(body.includes(`type: '${type}'`), `${verb} must still build a ${type} payload`);
        assert.match(body, /return \{[^}]*success[^}]*\}/,
            `${verb} must RETURN its payload: the browser Connections panel reaches it via `
            + `/connections/verb → _handlePlanningVerb, the 'planning'-tagged push never reaches a `
            + `connections-subscribed client, and transport.js drops an untyped body`);
        assert.ok(body.includes('this.postMessageToWebview('),
            `${verb} must keep its push — PRD contract #4 keeps the webview push additive`);
    }
});

test("createPlansPasteBack's import command is bridged in BOTH hosts", () => {
    // Registered in extension.ts for the extension host. In standalone an unbridged
    // command falls through to vscodeShim.executeCommand, which warns and returns
    // undefined WITHOUT throwing — so the arm takes its success branch and the panel
    // renders "Plan card created" for a plan that was never written.
    assert.match(BOOTSTRAP, /switchboardCommandRegistry\.register\(\s*'switchboard\.importPlanFromClipboard'/,
        'standalone must bridge switchboard.importPlanFromClipboard or paste-back reports a false success');
});
```

### G. `scripts/verb-return-contract-baseline.json` — ratchet the win down

Changes A and C remove `break`s from the Planning switch (currently ceilinged at 152). Regenerate
rather than hand-editing:

```
npm run verb-returns:baseline    # scripts/check-verb-return-contract.js --write
```

The tool refuses to raise a ceiling, so this can only lock the gain. Commit the updated JSON in the
same change. Never force a ceiling to 0 — `break` inside inner switches/loops is legitimate control
flow and Planning floors well above 0.

## Verification Plan

### Automated Tests

1. **New behavioural tests fail at HEAD, pass after.** Add change E first and run
   `npm run test:contract:verb-engine-planning`. At HEAD `result` is `undefined` for all three arms,
   so `result.type` throws / mismatches — confirm that, then confirm green after A–C.
   Do the same for change F's two assertions via `npm run test:contract:connections-routing`
   (arm-scoped `return`, and the bootstrap bridge). Neither can pass before the change lands.
2. **Existing suites unchanged** — `npm run test:contract:connections-routing`,
   `npm run test:contract:verb-engine-planning` must be fully green, not just the new cases.
3. **Compile/lint** — `npm run compile-tests` and `npm run lint`.
4. **Gates** — `npm run verb-returns:check` (after change G, no regression), `npm run parity:check`,
   `npm run push-routing:check` (raw `postMessage` count must not rise — this change adds none).
5. **Catalog freshness** — `npm run catalog:generate`; the diff must be line-number-only, with the
   verb sets in `protocol-catalog.json` and `src/generated/verbAllowlist.ts` byte-identical.

### Manual / UAT

6. **Browser UAT (the reported path)** — open the cockpit's Connections panel from the installed
   VSIX's browser host:
   - On load, the Create Plans section must populate: the extras checkbox reflects whether managed
     docs exist, and a previously saved public URL / platform / reference come back.
   - Click "Pick folder", choose a folder → the panel shows the chosen folder.
   - Paste an empty box and submit → the inline error "Paste a markdown plan first." appears (not a
     rail banner).
   - Paste a valid plan and submit → the success line appears and the plan lands on the board.
7. **Editor UAT (no regression, and no visible double render)** — open the Connections panel in
   VS Code and repeat step 6. Each action must render exactly once as far as the user can tell.
8. **Standalone UAT (the false-success guard)** — run `npx switchboard`, open `/connections`, paste a
   valid plan and submit. The plan file must actually appear in `.switchboard/plans/` and the card on
   the board; the status line must match reality. Then check the server console: the
   `[headless] command 'switchboard.importPlanFromClipboard' is not bridged` warning must **not**
   appear. "Pick folder" is expected to do nothing under `npx` (no folder dialog in a headless host)
   — confirm it does not fabricate a folder label or blank a previously chosen one.
9. **Planning panel — confirm it is still a signpost** — open the Planning panel's WEB AGENTS tab.
   It must still show only the "Web Agents has moved" notice. Nothing to exercise there; the check is
   that this change did not resurrect or break the moved UI.

   > **Superseded:** "Planning panel UAT (the other legitimate consumer) — open the Planning panel's
   > Create Plans surface and confirm init, folder pick and paste-back still behave."
   > **Reason:** That surface does not exist. `planning.html:3862` is a static "Web Agents has moved"
   > div; the controls and handlers live only in `connections.html` / `connections.js`. A tester
   > following the old step would find nothing to click and either skip it or record a false pass.
   > **Replaced with:** step 9 above — verify the signpost is intact, nothing more.

10. **Network check** — with the browser devtools Network tab open on the Connections page, confirm
    the `POST /connections/verb/createPlansInit` response body now carries
    `"type":"createPlansState"` alongside real field values. That single line is the whole fix; if it
    is absent, nothing else in this plan matters.

---

**Recommendation: Send to Coder** (complexity 4).

## Completion Summary

Implemented typed response body returns for `createPlansInit`, `createPlansPickFolder`, and `createPlansPasteBack` verb arms in `PlanningPanelProvider.ts` while keeping webview push notifications additive. Bridged the `switchboard.importPlanFromClipboard` command in `src/standalone/bootstrap.ts` to prevent false successes during headless paste-back imports. Added behavioural test coverage in `src/test/verb-engine-planning-headless.test.js` and structural contract assertions in `src/test/connections-routing-contract.test.js`, regenerated the protocol catalog, and ratcheted the baseline break ceiling down in `scripts/verb-return-contract-baseline.json`. Files modified: `src/services/PlanningPanelProvider.ts`, `src/standalone/bootstrap.ts`, `src/test/verb-engine-planning-headless.test.js`, `src/test/connections-routing-contract.test.js`, `scripts/verb-return-contract-baseline.json`, and `protocol-catalog.json`. No issues encountered.
