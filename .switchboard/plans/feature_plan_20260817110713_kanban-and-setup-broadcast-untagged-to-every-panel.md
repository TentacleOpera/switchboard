# Kanban and Setup broadcast untagged to every panel — tag them, and fix the dependencies that make the one-liner unsafe

## Goal

Give `KanbanProvider` and `SetupPanelProvider` a surface tag on their host→UI broadcasts so their
pushes stop being delivered to every panel in the browser cockpit — and land the prerequisites
that a bare tag would silently break: the theme fan-out in `TaskViewerProvider.broadcastToWebviews`,
and the Setup arms the Connections panel depends on receiving as untagged broadcasts.

### Problem

`wsHub.broadcast` (`src/services/wsHub.ts:380`) filters a push out of a connection only when **all
three** hold: the push is tagged, the connection declared a surface set, and the tag is absent from
it. An **untagged** push is therefore written to every connected panel — kanban, terminals,
planning, design, setup, memo, tickets and connections alike.

Two providers broadcast entirely untagged:

`src/services/KanbanProvider.ts:2243`

```ts
public postMessage(message: any): void {
    if (this._broadcaster) {
        this._broadcaster.push(message);          // ← no surface argument
    } else if (this._panel) { ... }
}
```

`src/services/SetupPanelProvider.ts:269`

```ts
public postMessage(message: any): void {
    if (this._broadcaster) {
        this._broadcaster.push(message);          // ← no surface argument
    } else {
        this._panel?.webview.postMessage(message);
    }
}
```

Setup also pushes untagged **directly** through the hub, bypassing its own `postMessage`, in the
config-change listener at `src/services/SetupPanelProvider.ts:126`–`:132`:

```ts
this._hostSeams.pathConfig.onConfigChanged((key, value, originatorId) => {
    if (key.startsWith('theme.') || key === 'theme') {
        this._broadcaster?.push({ type: 'switchboardThemeChanged', theme, key, value, originatorId });
    } else {
        this._broadcaster?.push({ type: 'settingsChanged', key, value, originatorId });
    }
});
```

Neither provider has any reply addressing to narrow the blast radius. `__replyChannel` /
`_postReply` occurrences (re-counted at HEAD): **DesignPanelProvider 12, KanbanProvider 0,
SetupPanelProvider 0, PlanningPanelProvider 0, TaskViewerProvider 0.** Every Kanban and Setup push —
including per-request replies with exactly one legitimate recipient — is a true broadcast to every
client.

### Measured collisions

Cross-referencing Kanban's emitted `type:` values against the panel scripts, the types another
**surface-declaring** panel actually handles (line numbers re-verified at HEAD):

| Kanban push | Emitted at | Also handled by | What happens |
| :--- | :--- | :--- | :--- |
| `featureDetails` | `:12220`, `:12224` | `planning.js:4398` | `PlanningPanelProvider` emits the same type with the same shape. Kanban's copy repaints the Planning Kanban tab's feature accordion for the same `planId` — and a Kanban `getFeatureDetails` on a **non-feature** card pushes `feature: null`, which writes "Feature not found" into a Planning accordion that asked nothing. Narrow (the handler no-ops when no accordion with that id is rendered) but wrong. |
| `customAgents` | `:11576`, `:11581`, `:11584` | `setup.html:3262` | The handler has **no `workspaceRoot` guard** — it hydrates `lastCustomAgents` from any array it receives. Kanban's payload carries *its* selected workspace's agents. `TaskViewerProvider` makes this worse by pushing the same type twice, once with no `workspaceRoot` at all. |
| `kanbanStructure` | `:11381`, `:11456`, `:11467`, `:11479`, `:11491`, `:11503` | `setup.html:3271` | Same pattern — Setup hydrates its column-order editor from Kanban's copy. Six emit sites, not three. |
| `visibleAgents` | `:2194`, `:3726`, `:3917`, `:6626` | `setup.html` | Duplicate hydration; Setup's own provider emits the same type. |
| `startupCommands` | `:11082` | `setup.html` | Duplicate; Setup and `setupService.ts` both emit it. |
| `dbPathUpdated` | `:10946` | `setup.html` | Duplicate; `TaskViewerProvider._postSharedWebviewMessage` emits it too (`:12061`, `:12104`, `:12255`). |
| `switchboardThemeNameSetting` | `:7914` | `planning.js:4863`, `memo.js:100`, `setup.html:3061`, `project.js:420`, `implementation.html:2493` | Foreign sender drives five panels' theme-name state. |
| `remoteControlState` | `:2685`, `:2719` | `connections.js:485` | Duplicate; `SetupPanelProvider` emits the same type. |
| `notionRemoteSetupResult` | `:8508` | `connections.js` | Duplicate; Setup emits it too. |

**Not a collision, checked and cleared:** `activateKanbanTabAndSelectPlan` never goes through
`this.postMessage` — it is routed via `postMessageToProjectWebview` or `mirrorToWs('project', ...)`,
and the Project panel is deliberately absent from `PANEL_SURFACES` (fail-open).
`startupCommandsChanged` (`:11103`) already uses `mirrorToWs(SURFACES.terminals, ...)`, which is the
precedent this plan follows. The connect-time resync array (`getFullStateMessages`, `:1259`–`:1289`)
is **already** tagged `SURFACES.kanban` per entry — a separate mechanism (the surface rides as a
payload field for the resync filter) that this change neither touches nor conflicts with, and
independent evidence that `kanban` is the right default for board state.

### The audit result: why this is not a one-liner

Consumers depend on these pushes being untagged. They must be handled **before** the tags land, or
tagging silently breaks working UI.

**Dependency 1 — `broadcastToWebviews` is the theme fan-out, and it is a five-way scatter of one
host-wide message.**

`src/services/TaskViewerProvider.ts:7474`, as it actually reads at HEAD:

```ts
    private _postSharedWebviewMessage(message: any): void {   // :7469
        this.postMessage(message);                            // UNTAGGED → every panel
        this._setupPanelProvider?.postMessage(message);       // UNTAGGED → every panel
    }

    public broadcastToWebviews(message: any): void {          // :7474
        this._postSharedWebviewMessage(message);
        this._kanbanProvider?.postMessage(message);           // UNTAGGED → every panel
        this._designPanelProvider?.postMessage(message);      // UNTAGGED → every panel
        this._planningPanelProvider?.postMessage(message);    // 'planning' + 'project'
        this._ticketsPanelProvider?.postMessage?.(message);   // 'tickets'
    }
```

> **Superseded:** The plan quoted `broadcastToWebviews` as a five-line body calling
> `this._planningPanelProvider?.postMessageToWebview(message)`, and asserted "today the terminals,
> memo, setup and connections panels receive theme and animation changes **only** via Kanban's and
> Design's untagged copies. Tag both and those four panels stop restyling until reload." It further
> made ordering "load-bearing" on that basis.
> **Reason:** Both halves are wrong against HEAD. (a) The call is
> `this._planningPanelProvider?.postMessage(message)` (`PlanningPanelProvider.ts:7116`), which fans
> to `postMessageToWebview` (tagged `'planning'`) **and** `postMessageToProjectWebview` (tagged
> `'project'`) — two frames, not one. (b) There are **four** untagged carriers in this fan-out, not
> two: `_postSharedWebviewMessage` expands to `TaskViewerProvider.postMessage` (`:4808`, `surface`
> is an optional parameter that this call site does not pass) plus `SetupPanelProvider.postMessage`.
> `TaskViewerProvider`'s own untagged push is explicitly **out of scope** for this plan, so it
> survives the change and continues to deliver every host-wide message to every connection. Tagging
> Kanban and Design without prerequisite 1 would therefore **not** break the theme fan-out today.
> **Replaced with:** Prerequisite 1 is **non-regressive future-proofing, not an ordering gate**, and
> it is provably safe: `SURFACES.common` appears in *every* entry of `PANEL_SURFACES`
> (`wsHub.ts:70`–`:79`) and its hand-kept mirror `PANEL_SURFACES_MAP` (`transport.js:112`–`:121`),
> and an undeclared connection fails open — so a `common` tag is **delivery-identical to untagged**
> for every subscriber that exists. It cannot lose a recipient. Do it because the cross-panel intent
> should be stated rather than inherited from an accident that a future `TaskViewerProvider` tagging
> pass will remove, not because the theme dies without it. The genuine ordering gate is
> dependency 2.

This is reachable: `setup.html:2812` sends `setThemeSetting`, `SetupPanelProvider:322` answers with
`broadcastToWebviews({ type: 'switchboardThemeChanged', theme })`. The cockpit's *own* theme button
is not affected — `shell.js:313` calls `applyThemeToAll` directly after the fetch, and no panel
forwards `switchboardThemeChanged` up to the parent — so the shell path masks nothing and the Setup
path is the one under test.

**The residual untagged carrier is the hazard to write down.** After this plan,
`TaskViewerProvider.postMessage` (155 call sites, `surface` never passed at any of them) is still
the untagged safety net under `switchboardThemeNameSetting`, `dbPathUpdated`,
`saveStartupCommandsResult`, `saveDefaultPromptOverridesResult` and `boardStateExportSetting` for
panels that are not their nominal owner. Whoever tags `TaskViewerProvider` must build the per-call-site
surface map *and* re-run this plan's collision UAT, because that pass is the one that removes the net.

**Dependency 2 — nine Setup arms reach the browser Connections panel only because Setup is
untagged.**

> **Superseded:** "**seven** Setup arms reach the browser Connections panel only because Setup is
> untagged", enumerating `getRemoteConfig`, `getRemoteHealth`, `setRemoteConfig`,
> `runNotionRemoteSetup`, `copyLinearAgentSkill`, `regenerateSparkContext`,
> `getIntegrationSetupStates`.
> **Reason:** `connections.js` also invokes `startRemoteControl` and `stopRemoteControl`. Both push
> `remoteControlState` and return a bare `{ success: true }`, exactly the same defect, and
> `connections.js:306` documents that the panel **deliberately waits for the push** instead of
> flipping optimistically ("…back via remoteControlState, and an optimistic flip desynchronises
> the…"). Tagging Setup with these two omitted leaves the browser Remote Control toggle permanently
> stuck at its last-rendered state — the single most visible control in that section.
> **Replaced with:** **Nine** arms, listed below. The complete set of verbs `connections.js`
> invokes that land in `SETUP_VERBS` is: `getRemoteConfig`, `setRemoteConfig`, `getRemoteHealth`,
> `runNotionRemoteSetup`, `startRemoteControl`, `stopRemoteControl`, `copyLinearAgentSkill`,
> `regenerateSparkContext`, `getIntegrationSetupStates`, `getLauncherPrompt`,
> `setBoardStateExport`, `setBoardStateExportRemoteUrl`. Of those, `getLauncherPrompt` already
> returns its data (`{ success: true, prompt, resolvedSkillPath }`) and the two
> `setBoardStateExport*` arms are pure config writes with no push — the remaining nine are the work.

Each of the nine **pushes** its payload and returns a body with no `type`:

| Setup arm | Line | Pushes | Returns |
| :--- | :--- | :--- | :--- |
| `getRemoteConfig` | `:1270` | `remoteConfig` | `{ success: true }` |
| `setRemoteConfig` | `:1275` | `remoteConfig` | `{ success: true }` |
| `runNotionRemoteSetup` | `:1280` | `notionRemoteSetupResult` | `{ success: true }` |
| `startRemoteControl` | `:1288` | `remoteControlState` | `{ success: true }` |
| `stopRemoteControl` | `:1293` | `remoteControlState` | `{ success: true }` |
| `getRemoteHealth` | `:1299` | `remoteSyncHealth` | `{ success: true }` |
| `copyLinearAgentSkill` | `:1304` | `linearAgentSkillText` | `{ success: true }` |
| `regenerateSparkContext` | `:384` | `sparkContextResult` | `{ success: true, ...res }` (no `type`) |
| `getIntegrationSetupStates` | `:399` | `integrationSetupStates` | `{ success: true, ...states }` (no `type`) |

The browser Connections page POSTs `/connections/verb/<verb>`, which `LocalApiServer.ts:3821`
routes to `_handleSetupVerb` when `SETUP_VERBS.has(verb)` (`:3838`) — `ConnectionsPanelProvider` is
not on the browser path. The Connections connection declares `surfaces=connections,common`. The
moment Setup's pushes are tagged `setup`, all nine are filtered out and the entire Remote Control /
integration section of the browser Connections panel goes dead.

**Why the return body is the fix, precisely.** `transport.js:409` re-dispatches *any* object
response body as a `MessageEvent`, so `{ success: true }` is not literally discarded — it is
dispatched, matches no `case` in the panel's `switch (msg.type)`, and falls through to `default`.
The observable effect is identical to a drop: no handler runs, nothing renders. A `type` field is
what makes the body **addressable**.

`connections.js` handles exactly these types: `boardStateExportSetting`, `createPlansFolderPicked`,
`createPlansPasteBackResult`, `createPlansState`, `integrationSetupStates`, `linearAgentSkillText`,
`notionRemoteSetupResult`, `remoteConfig`, `remoteControlState`, `remoteSyncHealth`,
`sparkContextResult`. Six of those come from the nine arms above; `remoteControlState` is the
seventh and is the one the superseded table missed. `boardStateExportSetting` is emitted by
`TaskViewerProvider:7622` (untagged, out of scope) and the three `createPlans*` types come from
`PlanningPanelProvider` — neither is affected by this change.

### Root cause, stated once

Surface tagging was rolled out producer-by-producer. Planning, Tickets and (per the Design plan)
Design were converted; Kanban, Setup and TaskViewer were not, and the fan-out and reply shapes above
quietly came to depend on their untagged state.

## Metadata

- **Complexity:** 7
- **Tags:** bugfix, backend, reliability, performance
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 6.
> **Reason:** 6 routes the card to a Coder while the plan's own Complexity Audit calls the work
> "Complex/risky" and makes ordering load-bearing — a contradiction. The improve pass added two
> hard constraints that were not in the 6: a compile-blocking type widening across four declaration
> sites in `TaskViewerProvider`, and two additional Setup arms whose omission silently kills the
> browser Remote Control toggle. Multi-file coordination, a silent browser-only failure mode, and
> UAT that must be run in two hosts is a 7.
> **Replaced with:** **Complexity:** 7 → Send to Lead Coder.

## User Review Required

None. Three judgement calls were made and are recorded rather than deferred:

- Prerequisite 1 is retained (as future-proofing, not as an ordering gate) rather than dropped —
  it is provably non-regressive and it removes the reliance on an accident.
- The frame-count collapse to a single WS push is **deferred**, not attempted here; the rationale
  and the concrete follow-up shape are in Adversarial Synthesis.
- `TaskViewerProvider` stays out of scope, unchanged from the original plan.

## Complexity Audit

### Routine

- The tags themselves are two defaulted parameters, one per provider.
- Two literal `SURFACES.common` arguments in the Setup config-change listener.
- Nine mechanical arm edits in `SetupPanelProvider`, all the same shape: return the payload that is
  already being built and pushed.
- `SURFACES` is already imported in `KanbanProvider.ts:31`; only `SetupPanelProvider` needs the
  new import.
- No migration. Nothing on disk, in settings, or in the DB changes. A client predating the
  `surfaces` parameter sends none, `meta.surfaces` is `undefined`, and the guard fails open — the
  installed base cannot be starved by this change.

### Complex / Risky

- *Dependency 2 is a real ordering gate.* The nine Setup arms must return typed bodies **before**
  Setup's default tag lands, in the same change or an earlier one. Reversed, the browser
  Connections panel's entire Remote Control / integration section goes dead — silently, and only
  in the browser host.
- *Change 1 does not compile as originally written.* `_designPanelProvider` is declared with a
  **structural** type at `TaskViewerProvider.ts:1113` (`{ postMessage(message: any): void; ... }`)
  and again in the `setDesignPanelProvider` parameter at `:4794`; `_planningPanelProvider` the same
  at `:1114` / `:4801`. Passing a second argument to a one-parameter signature is a TypeScript
  error regardless of what `DesignPanelProvider.postMessage` itself accepts. `_kanbanProvider`
  (`:1110`) and `_setupPanelProvider` (`:1111`) are declared as the real classes, so widening those
  classes is sufficient for them. This is a hard prerequisite of change 1, not a note.
- *The failure mode is silence.* A mis-tag produces no error, no console warning and no failing
  unit test — just a panel that stops updating. Every claim in the collision table was verified by
  reading the emitter and the handler at HEAD; the UAT steps below re-verify the ones that could
  regress.
- *Two hosts, different exposure.* In the editor, each provider owns its own `BroadcastHub` bound
  to its own webview, so tagging changes nothing there. In the standalone host **all providers
  share one `headlessBroadcaster`** (`bootstrap.ts:752`, injected at `:764`, `:769`, `:780`, `:796`,
  `:818`, `:891`), so `broadcastToWebviews` fans one message into the *same* hub five times. Every
  symptom and every regression risk in this plan is browser/cockpit-only. Do not conclude "it works"
  from an editor test.
- *An untagged carrier survives this change by design.* See "The residual untagged carrier" above.
  It is what makes prerequisite 1 non-urgent today and what makes the follow-up dangerous later.

## Edge-Case & Dependency Audit

- **Race Conditions.** None introduced. `wsHub.broadcast` is synchronous per connection and `seq`
  is deliberately not incremented on the skip path (`wsHub.ts:391`–`:394`), so a filtered
  connection sees no gap. The connect-time resync (`getFullStateMessages`) is filtered by its own
  per-entry `surface` field and is unaffected by the `postMessage` default. The one ordering
  concern is landing order between changes 2 and 3, which is a deployment sequencing constraint,
  not a runtime race.
- **Security.** None. Surface tags narrow delivery; they never widen it. No auth, secret or
  path-handling code is touched. Narrowing a broadcast strictly reduces the data a given client
  receives.
- **Side Effects.**
  - Tagging Setup `setup` means `postSetupPanelState` (`TaskViewerProvider:7534`–`:7549`, which
    calls `this._setupPanelProvider.postMessage(...)` for `startupCommands`, `visibleAgents`,
    `switchboardThemeNameSetting`, `customAgents`, `kanbanStructure`) stops reaching non-Setup
    panels. Checked: every one of those types is still delivered to its real consumers by
    `TaskViewerProvider`'s own untagged push, `PlanningPanelProvider:5934`, or the standalone
    resync entries at `bootstrap.ts:401` / `:477` (both already `SURFACES.common`).
  - `switchboardThemeNameSetting` is the type with the widest consumer set (five panels). After
    this change its Kanban copy is `kanban` and its Setup copy is `setup`; delivery to
    `planning.js`, `memo.js`, `project.js` and `implementation.html` rests on
    `TaskViewerProvider:7529` (untagged) and the two `bootstrap.ts` `common`-tagged resync entries.
    Verify this explicitly in UAT — it is the type most likely to regress.
- **Dependencies & Conflicts.**
  - **No Kanban type needs a non-kanban surface.** Every cross-panel type in the collision table is
    either a duplicate of a push the receiving panel's own provider already emits (`customAgents`,
    `visibleAgents`, `startupCommands`, `kanbanStructure`, `dbPathUpdated`, `remoteControlState`,
    `notionRemoteSetupResult`, `featureDetails`) or part of the theme quartet. `SURFACES.kanban` is
    safe as a blanket default.
  - **`saveDefaultPromptOverridesResult` is served by TaskViewer, not Kanban.**
    `saveDefaultPromptOverrides` is in `KANBAN_VERBS` and `TASKVIEWER_VERBS` but **not**
    `SETUP_VERBS`; `setup.html:3320` is fed by `TaskViewerProvider._postSharedWebviewMessage`
    (`:12023`), which this plan does not tag. It keeps working.
  - **`settingsChanged` (`SetupPanelProvider:131`) is consumed by `design.js` and `setup.html`.**
    It is a genuine cross-panel notification and must be tagged `SURFACES.common`, not
    `SURFACES.setup`.
  - **`TaskViewerProvider` is deliberately NOT tagged here.** 155 `this.postMessage(...)` call
    sites, exactly 3 tagged pushes (`:3078`, `:11588`, `:11832`, all `SURFACES.terminals` via
    `mirrorToWs`), and its `postMessage(message, surface?)` parameter (`:4808`) is never passed at
    any call site. That is not the same defect: TaskViewer is a genuinely multi-panel backend — its
    types map to setup.html, memo.js, tickets.js, kanban.html and terminals across the board — so it
    needs a per-call-site surface map, not a default. Sized here so it is not mistaken for done;
    out of scope.
  - **The Connections `createPlans*` arms are a separate plan.** The Planning-side equivalents of
    dependency 2 are already broken today (Planning *is* tagged) and are fixed independently. This
    plan neither depends on nor blocks that one; they touch different files.
  - **`ConnectionsPanelProvider`'s editor-path monkey-patch is untouched.** It writes straight to
    the Connections webview and mirrors with its own explicit tags, so it neither causes nor is
    affected by the browser-path bug.
  - **Use the shared constant.** `ws-surface-scoping-contract.test.js:158` already enforces
    "producers use the shared constant, not string literals" (currently scoped to `bootstrap.ts`).
    Import `SURFACES` from `./wsHub` in `SetupPanelProvider`; `KanbanProvider.ts:31` already has it.

## Dependencies

- `sess_kanban_setup_surface — Kanban and Setup untagged broadcast (this plan)`
- `sess_design_panel_leak — DesignPanelProvider surface parameter` — converges on the same
  `postMessage(message, surface?)` signature. Either plan may land first; whichever is second
  finds the signature already widened. Change 1 here is written to work in both orders.

## Adversarial Synthesis

**Risk Summary.** Key risks: (1) landing Setup's tag before its nine arms return typed bodies kills
the browser Connections panel's whole Remote Control section, silently and browser-only; (2) change 1
as originally drafted does not compile, because `_designPanelProvider` and `_planningPanelProvider`
are declared with one-parameter structural types in `TaskViewerProvider`; (3) the plan's own
"one frame, not three" success metric is unreachable while `TaskViewerProvider` stays untagged, so a
coder chasing it would either record a false pass or tag TaskViewer wholesale, which this plan
forbids. Mitigations: land change 2 first and prove it in the Network tab before change 3; widen the
four `TaskViewerProvider` declaration sites as part of change 1; replace the frame-count assertion
with the delivery assertions in the verification plan, and state the residual untagged carrier in
the code comment so the next pass does not remove the safety net blind.

## Proposed Changes

Land in the order given. Change 2 before change 3 is the one hard constraint.

### 1. `src/services/TaskViewerProvider.ts` — one common-tagged fan-out, and the type widening it needs

`broadcastToWebviews` (`:7474`) exists to reach *every* surface. Say that once instead of inheriting
it from whichever producer happens to still be untagged.

**1a — widen the declaration sites.** Four of them, or the call below is a TypeScript error:

```ts
    // :1113
    private _designPanelProvider?: { postMessage(message: any, surface?: string): void; handleServiceVerb(verb: string, payload: any): Promise<any>; getDesignAssetRoots?(workspaceRoot: string): string[] };
    // :1114
    private _planningPanelProvider?: { postMessage(message: any, surface?: string): void; postMessageToProjectWebview?(message: any): void; handleServiceVerb(verb: string, payload: any): Promise<any> };
```

```ts
    // :4794
    public setDesignPanelProvider(provider: { postMessage(message: any, surface?: string): void; handleServiceVerb(verb: string, payload: any): Promise<any> }) {
    // :4801
    public setPlanningPanelProvider(provider: { postMessage(message: any, surface?: string): void; postMessageToProjectWebview?(message: any): void; handleServiceVerb(verb: string, payload: any): Promise<any> }) {
```

`_kanbanProvider` (`:1110`) and `_setupPanelProvider` (`:1111`) are declared as the concrete classes
`KanbanProvider` / `SetupPanelProvider`, so changes 3 and 4 widen them by themselves.

**1b — tag the fan-out.**

```ts
    /**
     * Host-wide notification (theme, animation and scanline settings) — genuinely
     * cross-panel, which is what SURFACES.common means. This fans one message
     * through five providers; two of them are untagged, and that accident is what
     * has been delivering it to the terminals, memo, setup and connections panels.
     * Tagging `common` is delivery-identical to untagged for every subscriber
     * (every PANEL_SURFACES entry includes `common`; an undeclared connection
     * fails open) — it states the intent instead of inheriting it.
     *
     * NOTE: `_postSharedWebviewMessage` still calls this provider's OWN untagged
     * `postMessage`, and TaskViewerProvider is not tagged by this change. That
     * untagged push is currently the safety net under switchboardThemeNameSetting,
     * dbPathUpdated and the save*Result replies for panels that are not their
     * nominal owner. Whoever builds TaskViewer's per-call-site surface map REMOVES
     * that net — re-run the collision UAT in the Kanban/Setup surface plan then.
     */
    public broadcastToWebviews(message: any): void {
        this._postSharedWebviewMessage(message);        // the sidebar view + the Setup panel
        // Each panel's BOUND webview still needs its own copy in the editor host,
        // where the WS mirror is not the delivery path.
        this._kanbanProvider?.postMessage(message, SURFACES.common);
        this._designPanelProvider?.postMessage(message, SURFACES.common);
        this._planningPanelProvider?.postMessage(message);
        this._ticketsPanelProvider?.postMessage?.(message);
    }
```

Keeping the per-provider calls preserves editor delivery (each hub writes to its own webview); the
`SURFACES.common` tag on the two that reach the shared hub states the WS reach the untagged calls
provide today. Planning and Tickets keep their own tags — their WS copies are redundant with the
`common` one but harmless, and narrowing them is a separate change.

> **Superseded:** `this._planningPanelProvider?.postMessageToWebview(message);` in the change-1 body.
> **Reason:** `broadcastToWebviews` calls `postMessage` (`PlanningPanelProvider.ts:7116`), not
> `postMessageToWebview` (`:927`). `postMessage` deliberately fans to both the main planning webview
> and the project webview; substituting `postMessageToWebview` would silently drop the Project
> panel's copy of every theme and animation change.
> **Replaced with:** `this._planningPanelProvider?.postMessage(message);` — left exactly as it is at
> HEAD.

> If `DesignPanelProvider.postMessage` (`:817`) has not yet gained its `surface` parameter (see the
> Design panel leak plan), add it here rather than blocking — the two plans converge on the same
> signature. Route it through the provider's existing `_postRawToWebview` fallback; do **not** add a
> second raw webview send, which fails `scripts/check-push-routing.js`.

### 2. `src/services/SetupPanelProvider.ts` — make the nine Connections-facing arms return their payload

**Land this before change 3.** Each of the nine arms in the dependency-2 table must return the
payload it pushes, so the browser Connections panel is served by the HTTP return body rather than by
an accident of tagging. Pattern, applied to each:

```ts
                case 'getRemoteConfig': {                                        // :1270
                    const payload = await this._kanbanProvider?.remoteGetConfigPayload(message.workspaceRoot);
                    if (payload) { this.postMessage(payload); }
                    // The browser Connections panel reaches this arm via
                    // /connections/verb -> _handleSetupVerb (LocalApiServer.ts:3838) and
                    // subscribes to ['connections','common'] — a 'setup'-tagged push never
                    // reaches it, and transport.js only re-dispatches a RETURN body to a
                    // handler when that body carries a `type`.
                    return payload ? { success: true, ...payload } : { success: true };
                }
```

The two arms the superseded table omitted follow the same shape — note both already build the
typed object, so only the `return` changes:

```ts
                case 'startRemoteControl': {                                     // :1288
                    const active = (await this._kanbanProvider?.remoteStart(message.workspaceRoot)) === true;
                    this.postMessage({ type: 'remoteControlState', active });
                    return { success: true, type: 'remoteControlState', active };
                }
                case 'stopRemoteControl': {                                      // :1293
                    const active = this._kanbanProvider?.remoteStop(message.workspaceRoot) === true;
                    this.postMessage({ type: 'remoteControlState', active });
                    return { success: true, type: 'remoteControlState', active };
                }
```

`getIntegrationSetupStates` (`:399`) and `regenerateSparkContext` (`:384`) already spread their data
into the return — they need only the `type` field added:

```ts
                    return { success: true, type: 'integrationSetupStates', ...states };
...
                    return { success: true, type: 'sparkContextResult', path: res.path, skippedSections: res.skippedSections };
```

Apply the same treatment to `setRemoteConfig` (`:1275`), `runNotionRemoteSetup` (`:1280`),
`getRemoteHealth` (`:1299`) and `copyLinearAgentSkill` (`:1304`). For the two arms with an
early-return guard when `this._kanbanProvider` is missing (`runNotionRemoteSetup`,
`copyLinearAgentSkill`), the guard branch must return the typed error body too — otherwise the
browser panel shows nothing on exactly the path that has something to say.

Keep every existing push: the editor Connections panel and the Setup panel itself are legitimate
consumers on their own surfaces, and these payloads are idempotent renders. This also moves nine
arms onto the PRD's return-in-body contract, so `npm run verb-returns:check` should be re-baselined
downward for `SetupPanelProvider` in the same change if its residual `break` count drops.

### 3. `src/services/SetupPanelProvider.ts` — tag the broadcast

```ts
import { SURFACES } from './wsHub';
...
    /**
     * `surface` defaults to the panel's own. Pass SURFACES.common for pushes that are
     * genuinely cross-panel. An UNTAGGED push is written to every WS connection
     * (wsHub.broadcast:380), which is what this default replaces.
     *
     * PRECONDITION: the nine Connections-facing arms must already return their payload
     * in the body. The browser Connections panel declares ['connections','common'] and
     * has no other delivery channel for remoteConfig / remoteSyncHealth /
     * remoteControlState / notionRemoteSetupResult / linearAgentSkillText /
     * sparkContextResult / integrationSetupStates.
     */
    public postMessage(message: any, surface: string = SURFACES.setup): void {   // :269
        if (this._broadcaster) {
            this._broadcaster.push(message, surface);
        } else {
            this._panel?.webview.postMessage(message);
        }
    }
```

And the direct hub pushes in the config listener (`:128`–`:131`) — both are cross-panel
(`settingsChanged` is consumed by `design.js` and `setup.html`):

```ts
                    this._broadcaster?.push({ type: 'switchboardThemeChanged', theme, key, value, originatorId }, SURFACES.common);
                } else {
                    this._broadcaster?.push({ type: 'settingsChanged', key, value, originatorId }, SURFACES.common);
```

### 4. `src/services/KanbanProvider.ts` — tag the broadcast

```ts
import { SURFACES } from './wsHub';   // already present at :31
...
    public postMessage(message: any, surface: string = SURFACES.kanban): void {   // :2243
        if (this._broadcaster) {
            this._broadcaster.push(message, surface);
        } else if (this._panel) {
            const rendered = typeof message === 'function' ? message(undefined) : message;
            if (this._webviewReady) {
                this._panel.webview.postMessage(rendered);
            } else {
                this._pendingWebviewMessages.push(rendered);
            }
        }
    }
```

No call-site exceptions: the audit found no Kanban push that another panel legitimately needs. The
existing `mirrorToWs(SURFACES.terminals, ...)` at `:11103` stays as it is — that is the pattern to
reach for if a future exception appears, and `getFullStateMessages` (`:1259`) is the precedent for
tagging board state `kanban`.

### 5. `src/test/ws-surface-scoping-contract.test.js` — pin all three

The file currently reads `wsHub.ts`, `transport.js`, `bootstrap.ts`, `KanbanProvider.ts` and
`headlessPanelHtml.ts` (`:19`–`:23`). Add two more sources at the top:

```js
const setupProviderCode = fs.readFileSync(path.join(__dirname, '../services/SetupPanelProvider.ts'), 'utf8');
const taskViewerCode = fs.readFileSync(path.join(__dirname, '../services/TaskViewerProvider.ts'), 'utf8');
```

Then, using the file's existing `test()` and `block()` helpers (`:28`, `:39`):

```js
test('Kanban and Setup tag their broadcasts', () => {
    assert.ok(/surface: string = SURFACES\.kanban/.test(kanbanProviderCode),
        'untagged, every Kanban push type reaches every panel — customAgents and kanbanStructure '
        + 'hydrate setup.html with no workspaceRoot guard, featureDetails repaints Planning accordions');
    assert.ok(/surface: string = SURFACES\.setup/.test(setupProviderCode),
        'the Setup panel own surface is the default; cross-panel pushes opt into common explicitly');
    const listener = block(setupProviderCode, 'onConfigChanged((key, value, originatorId)', '};');
    assert.strictEqual((listener.match(/SURFACES\.common/g) || []).length, 2,
        'switchboardThemeChanged AND settingsChanged are both cross-panel — design.js and setup.html '
        + 'each consume settingsChanged');
});

test('the host-wide fan-out states its cross-panel intent', () => {
    const fanout = block(taskViewerCode, 'public broadcastToWebviews(', '\n    private');
    assert.strictEqual((fanout.match(/SURFACES\.common/g) || []).length, 2,
        'kanban and design are the two members of this fan-out that reach the shared hub; '
        + 'common is delivery-identical to untagged and states the intent');
    assert.ok(/_planningPanelProvider\?\.postMessage\(message\)/.test(fanout),
        'postMessage fans to BOTH the planning and project webviews; postMessageToWebview drops the '
        + 'Project panel copy');
});

test('every Setup arm the Connections panel calls returns a typed body', () => {
    // remoteControlState is the one the first audit missed: connections.js waits for the
    // push instead of flipping optimistically, so a bare {success:true} freezes the toggle.
    ['remoteConfig', 'remoteSyncHealth', 'remoteControlState', 'notionRemoteSetupResult',
     'linearAgentSkillText', 'sparkContextResult', 'integrationSetupStates'].forEach(type => {
        assert.ok(new RegExp(`type: '${type}'`).test(setupProviderCode),
            `${type} must still be built`);
    });
    ['getRemoteConfig', 'setRemoteConfig', 'getRemoteHealth', 'runNotionRemoteSetup',
     'startRemoteControl', 'stopRemoteControl', 'copyLinearAgentSkill'].forEach(verb => {
        const arm = block(setupProviderCode, `case '${verb}':`, '\n                case ');
        assert.ok(/return \{ success: true, (type:|\.\.\.)/.test(arm),
            `${verb} returns a bare {success:true} — once Setup is tagged, the browser Connections `
            + 'panel (surfaces=connections,common) never receives its payload on any channel');
    });
});
```

Each assertion must be shown failing at HEAD for its stated reason before the fix lands.

## Verification Plan

Land and verify in order — change 2 before change 3 is the hard constraint.

### Automated Tests

1. Add the three assertions in change 5 **first** and confirm each fails at HEAD for its stated
   reason. `npm run test:contract:ws-surface-scoping`.
2. `npm run test:contract:verb-engine-kanban`, `npm run test:contract:connections-routing`,
   `npm run test:contract:cross-client-scope`, `npm run test:contract:verb-engine`,
   `npm run test:contract:setup-panel-ws-hydration`, `npm run test:contract:ws-popout-broadcast`.
3. `npm run verb-returns:check` — change 2 converts nine `SetupPanelProvider` arms to the
   return-in-body contract. If its residual `break` count drops, ratchet
   `scripts/verb-return-contract-baseline.json` down in the same change.
4. `npm run parity:check`, `npm run push-routing:check`, `npm run standalone-parity:check`.
5. `npm run lint`, `npm run compile-tests`. The `compile-tests` step is where a missed
   `TaskViewerProvider` declaration widening (change 1a) surfaces; a green `lint` alone will not
   catch it.

### Manual / UAT

6. **Prerequisite 1 in isolation.** Apply change 1 only. In the cockpit: open Setup, change the
   theme via the Setup panel's theme dropdown, and confirm **every** panel restyles — kanban,
   terminals, planning, design, tickets, memo, connections — with no reload. This is the behaviour
   the later tags must not lose.
7. **Prerequisite 2 in isolation.** Apply change 2 only. In the browser devtools Network tab on the
   Connections page, confirm `POST /connections/verb/getRemoteConfig`,
   `POST /connections/verb/getIntegrationSetupStates` and
   `POST /connections/verb/startRemoteControl` now return bodies carrying
   `"type":"remoteConfig"` / `"type":"integrationSetupStates"` / `"type":"remoteControlState"`.
   Exercise Remote Control config load, save, health, **start and stop**, the Notion remote setup,
   Copy Linear agent skill, and Regenerate Spark context — each must render its result.
8. **Apply the tags** (changes 3 and 4) and re-run steps 6 and 7 verbatim. Any regression here means
   a prerequisite was incomplete, not that the tag is wrong.
9. **Collision UAT — the pushes that should now stop arriving.** With the cockpit open:
   - Expand a feature accordion in the **Planning** panel's Kanban tab, then expand a *different*
     feature on the **Kanban** board. Planning's accordion must not repaint or show "Feature not
     found".
   - Open the **Setup** panel's agents and column-order editors, then switch workspaces on the
     **Kanban** board. Setup's lists must keep showing the Setup panel's own workspace.
   - Open the **Connections** panel, then use Remote Control controls on the Kanban board. The
     Connections panel must not flicker between two senders' `remoteControlState`.
10. **Collision UAT — the pushes that must still arrive.** Setup's own agent list, column structure,
    startup commands, DB path and integration states must all still populate on Setup panel load;
    "Save default prompt overrides" must still report its result (it is TaskViewer-served and
    unaffected — confirm, do not assume). Separately, change the theme and confirm
    `switchboardThemeNameSetting` still lands in **memo**, **planning**, **project** and the
    implementation view — that is the widest-consumer type and the one most likely to regress.
11. **Editor no-op check.** Open Kanban, Setup, Planning, Design and Connections as VS Code panels
    with no browser client connected. Everything must behave exactly as before; the webview fan-out
    ignores surface entirely.
12. **Delivery sanity, not frame count.** With `localStorage['sb-debug-ws'] = '1'` set on the
    Planning page, change the theme from Setup and confirm Planning still receives
    `switchboardThemeChanged`, and that the **Setup**-tagged copy is no longer among the frames it
    receives.

> **Superseded:** "**Frame-count sanity.** With `localStorage['sb-debug-ws'] = '1'` set on the
> Planning page, change the theme from Setup and confirm Planning receives **one**
> `switchboardThemeChanged` frame, not three (Kanban's + Design's + Planning's). That collapse is
> the measurable win."
> **Reason:** Unreachable, and chasing it would drive a coder into a change this plan forbids.
> `broadcastToWebviews` fans one message through five providers and this change tags rather than
> collapses that fan-out. After changes 1–4 the Planning connection (declaring
> `['planning','common']`) still receives the TaskViewer copy (untagged, out of scope), the Kanban
> copy (`common`), the Design copy (`common`) and the Planning copy (`planning`) — and the Setup
> config-change listener fires its own `switchboardThemeChanged` on the same user action, so the
> observed count is not even stable across paths. A single frame requires collapsing the fan-out to
> one `mirrorToWs(SURFACES.common, ...)` plus per-provider webview-only delivery, which is a
> different change with a different risk profile (see below).
> **Replaced with:** step 12 above — assert *delivery* and the *absence of the setup-tagged copy*,
> which are both true and both directly test what this plan changes.

### Deferred follow-up (not in scope here)

The genuine frame collapse: replace the five-way scatter in `broadcastToWebviews` with **one**
`this._broadcaster.mirrorToWs(SURFACES.common, message)` plus a webview-only delivery per provider
(`BroadcastHub.pushWebviewOnly`, `broadcastHub.ts:143`, already exists and is a no-op in headless
mode). In the standalone host all providers share one `headlessBroadcaster`, so the five WS copies
are pure duplication; in the editor each provider's own hub is still needed for its bound webview.
This yields exactly one WS frame per connection and makes the original frame-count metric true. It
is deferred because it requires a new webview-only method on four providers, which is a wider
blast radius than tagging and collides with the PRD's one-agent-stream-per-provider-file rule while
the Design plan is in flight.

---

**Recommendation: Send to Lead Coder** (complexity 7).
