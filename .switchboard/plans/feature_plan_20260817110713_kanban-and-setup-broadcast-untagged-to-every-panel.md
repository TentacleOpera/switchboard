# Kanban and Setup broadcast untagged to every panel — tag them, and fix the two dependencies that make the one-liner unsafe

## Goal

Give `KanbanProvider` and `SetupPanelProvider` a surface tag on their host→UI broadcasts so their
pushes stop being delivered to every panel in the browser cockpit — and land the two prerequisites
that a bare tag would silently break: the theme fan-out in `TaskViewerProvider.broadcastToWebviews`,
and the seven Setup arms the Connections panel depends on receiving as untagged broadcasts.

### Problem

`wsHub.broadcast` (`src/services/wsHub.ts:393`) filters a push out of a connection only when **all
three** hold: the push is tagged, the connection declared a surface set, and the tag is absent from
it. An **untagged** push is therefore written to every connected panel — kanban, terminals,
planning, design, setup, memo, tickets and connections alike.

Two providers broadcast entirely untagged:

`src/services/KanbanProvider.ts:2231`

```ts
public postMessage(message: any): void {
    if (this._broadcaster) {
        this._broadcaster.push(message);          // ← no surface argument
    } else if (this._panel) { ... }
}
```

`src/services/SetupPanelProvider.ts:271`

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
config-change listener at `src/services/SetupPanelProvider.ts:129`–`:131`:

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
`_postReply` occurrences: **DesignPanelProvider 12, KanbanProvider 0, SetupPanelProvider 0,
PlanningPanelProvider 0.** Every Kanban and Setup push — including per-request replies with exactly
one legitimate recipient — is a true broadcast to every client.

### Measured collisions

Cross-referencing Kanban's 66 emitted `type:` values against the panel scripts, the types another
**surface-declaring** panel actually handles:

| Kanban push | Emitted at | Also handled by | What happens |
| :--- | :--- | :--- | :--- |
| `featureDetails` | `:12171`, `:12175` | `planning.js:4398` | `PlanningPanelProvider:3848–3860` emits the same type with the same shape. Kanban's copy repaints the Planning Kanban tab's feature accordion for the same `planId` — and a Kanban `getFeatureDetails` on a **non-feature** card pushes `feature: null`, which writes "Feature not found" into a Planning accordion that asked nothing. Narrow (the handler no-ops when no accordion with that id is rendered) but wrong. |
| `customAgents` | `:11562`, `:11567` | `setup.html:3262` | The handler has **no `workspaceRoot` guard** — it hydrates `lastCustomAgents` from any array it receives. Kanban's payload carries *its* selected workspace's agents. `TaskViewerProvider:7382–7383` makes this worse by pushing the same type twice, once with no `workspaceRoot` at all. |
| `kanbanStructure` | `:11367`, `:11442`, `:11453` | `setup.html:3271` | Same pattern — Setup hydrates its column-order editor from Kanban's copy. |
| `visibleAgents` | `:2180`, `:3712`, `:3903` | `setup.html` | Duplicate hydration; Setup's own provider emits the same type. |
| `startupCommands` | `:11090` | `setup.html` | Duplicate; Setup and `setupService.ts:44` both emit it. |
| `dbPathUpdated` | `:10954` | `setup.html` | Duplicate; Setup emits it too. |
| `switchboardThemeNameSetting` | `:7922` | `planning.js`, `memo.js`, `setup.html` | Foreign sender drives three panels' theme-name state. |
| `remoteControlState` | `:2671`, `:2705` | `connections.js` | Duplicate; `SetupPanelProvider` emits the same type. |
| `notionRemoteSetupResult` | `:8516` | `connections.js` | Duplicate; Setup emits it too. |

**Not a collision, checked and cleared:** `activateKanbanTabAndSelectPlan` (`:361`, `:10470`) never
goes through `this.postMessage` — it is routed via `postMessageToProjectWebview` or
`mirrorToWs('project', ...)`, and the Project panel is deliberately absent from `PANEL_SURFACES`
(fail-open). `startupCommandsChanged` (`:11111`) already uses
`mirrorToWs(SURFACES.terminals, ...)`, which is the precedent this plan follows.

### The audit result: why this is not a one-liner

Two consumers depend on these pushes being untagged. Both must be fixed **before** the tags land, or
tagging silently breaks working UI.

**Dependency 1 — `broadcastToWebviews` is the theme fan-out, and Kanban is one of only two untagged
carriers.**

`src/services/TaskViewerProvider.ts:7329`:

```ts
public broadcastToWebviews(message: any): void {
    this._postSharedWebviewMessage(message);
    this._kanbanProvider?.postMessage(message);      // untagged  → every panel
    this._designPanelProvider?.postMessage(message); // untagged  → every panel
    this._planningPanelProvider?.postMessageToWebview(message); // tagged 'planning'
    this._ticketsPanelProvider?.postMessage?.(message);         // tagged 'tickets'
}
```

One host-wide message is fanned through five providers. Today the terminals, memo, setup and
connections panels receive theme and animation changes **only** via Kanban's and Design's untagged
copies. Tag both and those four panels stop restyling until reload.

This is reachable: `setup.html:2812` sends `setThemeSetting`, `SetupPanelProvider:322` answers with
`broadcastToWebviews({ type: 'switchboardThemeChanged', theme })`. The cockpit's *own* theme button
is not affected — `shell.js:313` calls `applyThemeToAll` directly after the fetch, and no panel
forwards `switchboardThemeChanged` up to the parent — so the shell path masks nothing and the Setup
path is the one that breaks.

**Dependency 2 — seven Setup arms reach the browser Connections panel only because Setup is
untagged.**

`connections.js` calls these SETUP_VERBS. Each one **pushes** its payload and returns a body with no
`type`, and `transport.js` drops a body without one — so the WS push is the only delivery channel:

| Setup arm | Line | Pushes | Returns |
| :--- | :--- | :--- | :--- |
| `getRemoteConfig` | `:1279` | `remoteConfig` | `{ success: true }` |
| `getRemoteHealth` | `:1308` | `remoteSyncHealth` | `{ success: true }` |
| `setRemoteConfig` | `:1284` | `remoteConfig` | `{ success: true }` |
| `runNotionRemoteSetup` | `:1289` | `notionRemoteSetupResult` | `{ success: true }` |
| `copyLinearAgentSkill` | `:1313` | `linearAgentSkillText` | `{ success: true }` |
| `regenerateSparkContext` | `:384` | `sparkContextResult` | `{ success: true, ...res }` (no `type`) |
| `getIntegrationSetupStates` | `:399` | `integrationSetupStates` | `{ success: true, ...states }` (no `type`) |

The browser Connections page POSTs `/connections/verb/<verb>`, which `LocalApiServer.ts:3759` routes
straight to `_handleSetupVerb` — `ConnectionsPanelProvider` is not on the browser path. The
Connections connection declares `surfaces=connections,common`. The moment Setup's pushes are tagged
`setup`, all seven are filtered out and the entire Remote Control / integration section of the
browser Connections panel goes dead.

### Root cause, stated once

Surface tagging was rolled out producer-by-producer. Planning, Tickets and (per the Design plan)
Design were converted; Kanban and Setup were not, and the fan-out and reply shapes above quietly
came to depend on their untagged state.

## Metadata

- **Complexity:** 6
- **Tags:** bugfix, backend, reliability, performance
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Complex/risky**, and it is the dependencies rather than the diff that make it so. The tags
themselves are two defaulted parameters; the work is the two prerequisites and the verification that
nothing downstream was living off the untagged fan-out.

- *Ordering is load-bearing.* Prerequisites 1 and 2 must land **before** the tags, in the same
  change or an earlier one. Reversed, the theme stops propagating and the Connections panel dies —
  both silent, both only visible in the browser host.
- *The failure mode is silence.* A mis-tag produces no error, no console warning and no failing
  unit test — just a panel that stops updating. Every claim in the collision table above was
  verified by reading the emitter and the handler; the UAT steps below re-verify the ones that could
  regress.
- *Two hosts, different exposure.* In the editor, each provider's `BroadcastHub` writes to its own
  bound webview regardless of surface, so tagging changes nothing there. Every symptom and every
  regression risk in this plan is browser/cockpit-only. Do not conclude "it works" from an editor
  test.
- *No migration.* Nothing on disk, in settings, or in the DB changes. A client predating the
  `surfaces` parameter sends none, `meta.surfaces` is `undefined`, and the guard fails open — the
  installed base cannot be starved by this change.

## Edge-Case & Dependency Audit

- **No Kanban type needs a non-kanban surface.** Every cross-panel type in the collision table is
  either a duplicate of a push the receiving panel's own provider already emits (`customAgents`,
  `visibleAgents`, `startupCommands`, `kanbanStructure`, `dbPathUpdated`, `remoteControlState`,
  `notionRemoteSetupResult`, `featureDetails`) or part of the theme quartet handled by prerequisite
  1. That is the audit's conclusion: once `broadcastToWebviews` is fixed, `SURFACES.kanban` is safe
  as a blanket default.
- **`saveDefaultPromptOverridesResult` is served by TaskViewer, not Kanban.**
  `saveDefaultPromptOverrides` is in `KANBAN_VERBS` and `TASKVIEWER_VERBS` but **not** `SETUP_VERBS`;
  `setup.html:3320` is fed by `TaskViewerProvider`, which this plan does not tag. It keeps working.
- **`settingsChanged` (`SetupPanelProvider:131`) is consumed by `design.js` and `setup.html`.** It is
  a genuine cross-panel notification and must be tagged `SURFACES.common`, not `SURFACES.setup`.
- **`TaskViewerProvider` is deliberately NOT tagged here.** It has 155 `this.postMessage(...)` call
  sites and exactly 3 tagged pushes (`:2639`, `:2900`, `:11356`), and its `postMessage(message,
  surface?)` parameter is never passed at any call site. That is not the same defect: TaskViewer is a
  genuinely multi-panel backend — its types map to setup.html, memo.js, tickets.js, kanban.html and
  terminals across the board — so it needs a per-call-site surface map, not a default. Sized here so
  it is not mistaken for done; out of scope.
- **The Connections `createPlans*` arms are a separate plan.** The Planning-side equivalents of
  dependency 2 are already broken today (Planning *is* tagged) and are fixed independently. This plan
  neither depends on nor blocks that one; they touch different files.
- **`ConnectionsPanelProvider`'s editor-path monkey-patch (`:140`–`:149`) is untouched.** It writes
  straight to the Connections webview and mirrors with its own explicit tags, so it neither causes
  nor is affected by the browser-path bug.
- **Use the shared constant.** `ws-surface-scoping-contract.test.js` already enforces
  "producers use the shared constant, not string literals". Import `SURFACES` from `./wsHub` in both
  providers.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — one common-tagged push, not a five-way fan-out

`broadcastToWebviews` exists to reach *every* surface. Say that once instead of hoping two untagged
providers cover it. Line 7329:

```ts
    /**
     * Host-wide notification (theme, animation and scanline settings) — genuinely
     * cross-panel, which is what SURFACES.common means. This used to fan the same
     * message through five providers' postMessage; two of them happened to be
     * untagged, and that accident was the only thing delivering it to the terminals,
     * memo, setup and connections panels. One tagged push replaces all of it.
     */
    public broadcastToWebviews(message: any): void {
        this._postSharedWebviewMessage(message);        // the sidebar view
        // Each panel's BOUND webview still needs its own copy in the editor host,
        // where the WS mirror is not the delivery path.
        this._kanbanProvider?.postMessage(message, SURFACES.common);
        this._designPanelProvider?.postMessage(message, SURFACES.common);
        this._planningPanelProvider?.postMessageToWebview(message);
        this._ticketsPanelProvider?.postMessage?.(message);
    }
```

Keeping the per-provider calls preserves editor delivery (each hub writes to its own webview); the
`SURFACES.common` tag on the two that reach the shared hub restores the WS reach the untagged calls
used to provide. Planning and Tickets keep their own tags — their WS copies are redundant with the
`common` one but harmless, and narrowing them is a separate change.

> If `DesignPanelProvider.postMessage` has not yet gained its `surface` parameter (see the Design
> panel leak plan), add it here rather than blocking — the two plans converge on the same signature.

### 2. `src/services/SetupPanelProvider.ts` — make the seven Connections-facing arms return their payload

Each of the seven arms in the dependency-2 table must return the payload it pushes, so the browser
Connections panel is served by the HTTP return body rather than by an accident of tagging. Pattern,
applied to each:

```ts
                case 'getRemoteConfig': {
                    const payload = await this._remoteConfigPayload(message);
                    if (payload) { this.postMessage(payload); }
                    // The browser Connections panel reaches this arm via
                    // /connections/verb → _handleSetupVerb and subscribes to
                    // ['connections','common'] — a 'setup'-tagged push never reaches it,
                    // and transport.js only re-dispatches a RETURN body carrying a `type`.
                    return payload ? { success: true, ...payload } : { success: true };
                }
```

`getIntegrationSetupStates` (`:399`) and `regenerateSparkContext` (`:384`) already spread their data
into the return — they need only the `type` field added:

```ts
                    return { success: true, type: 'integrationSetupStates', ...states };
...
                    return { success: true, type: 'sparkContextResult', path: res.path, skippedSections: res.skippedSections };
```

Keep every existing push: the editor Connections panel and the Setup panel itself are legitimate
consumers on their own surfaces, and these payloads are idempotent renders.

### 3. `src/services/SetupPanelProvider.ts` — tag the broadcast

```ts
import { SURFACES } from './wsHub';
...
    /**
     * `surface` defaults to the panel's own. Pass SURFACES.common for pushes that are
     * genuinely cross-panel. An UNTAGGED push is written to every WS connection
     * (wsHub.broadcast), which is what this default replaces.
     */
    public postMessage(message: any, surface: string = SURFACES.setup): void {
        if (this._broadcaster) {
            this._broadcaster.push(message, surface);
        } else {
            this._panel?.webview.postMessage(message);
        }
    }
```

And the direct hub pushes in the config listener (`:129`–`:131`) — both are cross-panel:

```ts
                    this._broadcaster?.push({ type: 'switchboardThemeChanged', theme, key, value, originatorId }, SURFACES.common);
                } else {
                    this._broadcaster?.push({ type: 'settingsChanged', key, value, originatorId }, SURFACES.common);
```

### 4. `src/services/KanbanProvider.ts` — tag the broadcast

```ts
import { SURFACES } from './wsHub';   // already imported for mirrorToWs at :11111
...
    public postMessage(message: any, surface: string = SURFACES.kanban): void {
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

No call-site exceptions: the audit found no Kanban push that another panel legitimately needs once
prerequisite 1 is in place. The existing `mirrorToWs(SURFACES.terminals, ...)` at `:11111` stays as
it is — that is the pattern to reach for if a future exception appears.

### 5. `src/test/ws-surface-scoping-contract.test.js` — pin all three

```js
test('Kanban and Setup tag their broadcasts', () => {
    assert.ok(/surface: string = SURFACES\.kanban/.test(kanbanProviderCode),
        'untagged, all 66 Kanban push types reach every panel — customAgents and kanbanStructure '
        + 'hydrate setup.html with no workspaceRoot guard, featureDetails repaints Planning accordions');
    assert.ok(/surface: string = SURFACES\.setup/.test(setupProviderCode),
        'the Setup panel own surface is the default; cross-panel pushes opt into common explicitly');
    const listener = block(setupProviderCode, 'onConfigChanged((key, value, originatorId)', '};');
    assert.ok((listener.match(/SURFACES\.common/g) || []).length === 2,
        'switchboardThemeChanged AND settingsChanged are both cross-panel — design.js and setup.html '
        + 'each consume settingsChanged');
});

test('the host-wide fan-out is tagged common, not left to an untagged producer', () => {
    const fanout = block(taskViewerCode, 'public broadcastToWebviews(', '\n    private');
    assert.ok((fanout.match(/SURFACES\.common/g) || []).length >= 2,
        'terminals/memo/setup/connections used to receive theme changes ONLY via the untagged '
        + 'Kanban and Design copies; tagging those without this leaves four panels frozen until reload');
});

test('Setup arms the Connections panel calls return a typed body', () => {
    ['remoteConfig', 'remoteSyncHealth', 'notionRemoteSetupResult',
     'linearAgentSkillText', 'sparkContextResult', 'integrationSetupStates'].forEach(type => {
        assert.ok(new RegExp(`type: '${type}'`).test(setupProviderCode),
            `${type} must still be built`);
    });
    assert.ok(!/case 'getRemoteConfig': \{[\s\S]{0,400}?return \{ success: true \};/.test(setupProviderCode),
        'a bare {success:true} return leaves the WS push as the only channel — and once Setup is '
        + 'tagged, the browser Connections panel (surfaces=connections,common) never receives it');
});
```

## Verification Plan

Land and verify in order — the prerequisites first, each proven before the tags go on.

1. **Prerequisite 1 in isolation.** Apply change 1 only. Run
   `npm run test:contract:ws-surface-scoping`. Then in the cockpit: open Setup, change the theme via
   the Setup panel's theme dropdown, and confirm **every** panel restyles — kanban, terminals,
   planning, design, tickets, memo, connections — with no reload. This is the behaviour the later
   tags must not lose.
2. **Prerequisite 2 in isolation.** Apply change 2 only. In the browser devtools Network tab on the
   Connections page, confirm `POST /connections/verb/getRemoteConfig` and
   `POST /connections/verb/getIntegrationSetupStates` now return bodies carrying
   `"type":"remoteConfig"` / `"type":"integrationSetupStates"`. Exercise Remote Control config load,
   save, health, the Notion remote setup, Copy Linear agent skill, and Regenerate Spark context —
   each must render its result.
3. **Apply the tags** (changes 3 and 4) and re-run steps 1 and 2 verbatim. Any regression here means
   a prerequisite was incomplete, not that the tag is wrong.
4. **Test suites** — `npm run test:contract:ws-surface-scoping`,
   `npm run test:contract:verb-engine-kanban`, `npm run test:contract:connections-routing`,
   `npm run test:contract:cross-client-scope`, `npm run test:contract:verb-engine`. Add the three new
   assertions first and confirm each fails at HEAD for its stated reason.
5. **Lint/compile** — `npm run lint`, `npm run compile-tests`.
6. **Collision UAT — the pushes that should now stop arriving.** With the cockpit open:
   - Expand a feature accordion in the **Planning** panel's Kanban tab, then expand a *different*
     feature on the **Kanban** board. Planning's accordion must not repaint or show "Feature not
     found".
   - Open the **Setup** panel's agents and column-order editors, then switch workspaces on the
     **Kanban** board. Setup's lists must keep showing the Setup panel's own workspace.
   - Open the **Connections** panel, then use Remote Control controls on the Kanban board. The
     Connections panel must not flicker between two senders' `remoteControlState`.
7. **Collision UAT — the pushes that must still arrive.** Setup's own agent list, column structure,
   startup commands, DB path and integration states must all still populate on Setup panel load;
   "Save default prompt overrides" must still report its result (it is TaskViewer-served and
   unaffected — confirm, do not assume).
8. **Editor no-op check.** Open Kanban, Setup, Planning, Design and Connections as VS Code panels
   with no browser client connected. Everything must behave exactly as before; the webview fan-out
   ignores surface entirely.
9. **Frame-count sanity.** With `localStorage['sb-debug-ws'] = '1'` set on the Planning page, change
   the theme from Setup and confirm Planning receives **one** `switchboardThemeChanged` frame, not
   three (Kanban's + Design's + Planning's). That collapse is the measurable win.
