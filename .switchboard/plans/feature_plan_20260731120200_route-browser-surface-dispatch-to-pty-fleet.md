# Route Browser-Surface Dispatch to the PTY Fleet Instead of Refusing It

## Goal

Make every dispatch that arrives from a browser panel deliver into the PTY fleet those panels can actually display, so that "send to terminal" / drag-dispatch / trigger-agent work when the fleet lives in the browser Terminals panel and VS Code holds no terminals of its own — eliminating the `Could not deliver prompt to '<name>'. The terminal is not running in VS Code.` failure.

### Problem

With PTY terminals running in the browser Terminals panel and nothing open in VS Code, dispatch fails with:

```
Could not deliver prompt to 'planner-1'. The terminal is not running in VS Code.
```

`planner-1` **is** the PTY terminal's name. The system resolved the correct target and then refused to deliver to it. The PTY fleet was supposed to be decoupled from VS Code's terminal host; the delivery path did not get the memo.

### Root cause

Two defects, both in the per-surface routing discriminator.

**Defect A — the discriminator is never set on the browser's transport rails.**

`ConfiguredKanbanDispatchOptions.apiOriginated` (`src/services/TaskViewerProvider.ts:196-210`) is the flag that decides which terminal fleet a dispatch may use. Its own doc comment states the obligation:

> OBLIGATION: any NEW HTTP dispatch entry point added later MUST set this, or its dispatches silently route to VS Code terminals the caller cannot see.

Exactly one caller honours it — `POST /kanban/dispatch` (`src/services/LocalApiServer.ts:1212`):

```js
await kanbanVerb('triggerAction', { sessionId, targetColumn, workspaceRoot, apiOriginated: true }, workspaceRoot);
```

Every browser panel, however, reaches the extension through the **generic per-verb rails**, not `/kanban/dispatch`. The webview transport shim (`src/webview/transport.js:222-246`) posts the raw `postMessage` payload to `/{panel}/verb/{type}`:

```js
const body = Object.assign({}, message);
const url = `${routePrefix}/${encodeURIComponent(verb)}`;
fetch(url, { method: 'POST', credentials: 'same-origin', ... body: JSON.stringify(body) });
```

and the rails forward that body verbatim — `_handleKanbanVerb` (`src/services/LocalApiServer.ts:1665-1701`), `_handlePlanningVerb` (`:1703-1728`), and `_handleTaskViewerVerb` (`src/services/LocalApiServer.ts:1810-1835`) all do only `delete body.type` and pass it on. None stamps `apiOriginated`. (There are exactly **three** generic verb rails — no `_handleProjectVerb` exists; `/project/verb/*` requests are routed into `_handlePlanningVerb` at `src/services/LocalApiServer.ts:3378-3381`.) The webview HTML never sets it either (by design — `KanbanProvider.ts:7968-7970` comments "The webview never sets apiOriginated"). Result: **a dispatch from a browser panel is indistinguishable from an in-process VS Code sidebar dispatch**, so `allowPtyFleet` is false at `src/services/TaskViewerProvider.ts:4975` and `:18710`, and the PTY fleet is skipped.

**Defect B — target *resolution* and target *delivery* apply different eligibility rules.**

`PtyFleetService.updateRegistryState()` (`src/standalone/ptyFleetService.ts`) writes every PTY into the shared `runtime.terminals` registry tagged `ideName: 'switchboard-pty'`, `purpose: 'pty'`. Two consumers read that registry with different filters:

- `_findTerminalNameByWorktreePathAndRole` filters them out unless opted in: `const isEligible = (info) => allowPtyFleet || !(info?.purpose === 'pty' || info?.ideName === PTY_IDE_NAME);` (`src/services/TaskViewerProvider.ts:7936`).
- `_getAgentNameForRole` has **no filter at all** — it returns the first `state.terminals` entry whose `role` matches, PTY or not.

So with no worktree path in play, `_resolveAgentTerminalForPlan` → `_getAgentNameForRole` happily returns `planner-1` even with `allowPtyFleet === false`. That name is then handed to `_attemptDirectTerminalPush` (`src/services/TaskViewerProvider.ts:18437`), which — because `allowPtyFleet` is false — skips its PTY branch entirely, finds no VS Code terminal by that name, returns `false`, and `_dispatchExecuteMessage` emits the warning at `src/services/TaskViewerProvider.ts:18389`. **The name the user saw in the error is proof of the asymmetry: resolution said yes, delivery said no.**

**Third, narrower gap:** the `sendToTerminal` verb arm (`src/services/TaskViewerProvider.ts:12486-12541`) never consults the PTY fleet under any flag. It checks `_registeredTerminals`, then the `HostTerminal` seam, then fails with `terminal '<name>' not found or not local`. In the extension host, PTYs live in `_ptyFleetService`, not in either of those, so this verb cannot reach a PTY at all. (The standalone/no-extension host has its own PTY-backed arm at `src/standalone/bootstrap.ts:1092`, which is why this only breaks in the extension-running configuration.)

**Why `apiOriginated: true` cannot simply be stamped on every rail:** the flag is overloaded. Besides fleet selection it also **bypasses the CLI-triggers gate** (`src/services/KanbanProvider.ts:7970`):

```js
if (!this._cliTriggersEnabled && !msg?.apiOriginated) { return { success: false, error: 'CLI triggers are disabled' }; }
```

That gate exists to stop a webview *drag-drop* from auto-dispatching. Stamping the flag on the generic rails would make a browser drag-drop bypass a setting the user deliberately turned off. The two concerns must be separated before the stamp is safe.

## Metadata

- **Complexity:** 7
- **Tags:** backend, api, bugfix, reliability, ui

## User Review Required

- **Semantics of an overloaded flag are being split in a hot path.** `apiOriginated` stops bypassing the CLI-triggers gate; only the new `bypassTriggerGate` does, and only `POST /kanban/dispatch` sets it. A mistake here either re-breaks PTY delivery or silently disables the user's CLI-triggers setting for the whole browser cockpit — the two quadrants are verification items, not assumptions.
- **Failure-message change.** The old `The terminal is not running in VS Code.` warning becomes two distinct messages (browser-terminal misroute vs. no live terminal). Users or scripts pattern-matching the old string would notice.
- **Sidebar resolution narrows.** With only PTYs alive, a VS Code sidebar dispatch now resolves to *nothing* and fails with an actionable message instead of being handed a PTY name it refuses. Same user-visible outcome (failure), different message — confirm this is the desired trade (chosen over silently delivering into a window the sidebar user cannot see).

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- Adding a `bypassTriggerGate` field alongside `apiOriginated` and re-pointing the one gate check at it.
- Stamping `apiOriginated: true` inside the three generic verb rails.
- Adding a PTY lookup arm to the `sendToTerminal` verb.

**Complex / Risky**
- **Splitting an overloaded flag with two live consumers.** `apiOriginated` currently means both "may use the PTY fleet" and "is an explicit command, skip the drag-drop gate". `POST /kanban/dispatch` needs both; a browser drag-drop needs only the first. Getting the split wrong either re-breaks PTY delivery or silently disables the CLI-triggers setting. Both meanings must be asserted by tests, not by reading.
- **Resolve/deliver symmetry.** Fixing only Defect A leaves the asymmetry latent for any future non-HTTP caller. `_getAgentNameForRole` must take the same `allowPtyFleet` eligibility filter its sibling already has, so a `false` surface can never be *handed* a PTY name it will then refuse. This changes what `_getAgentNameForRole` returns for genuinely sidebar-only dispatches — verify the sidebar still finds its VS Code terminals when PTYs are also present.
- **Last-resort fallback vs. silent misrouting.** After the eligibility fix, a sidebar dispatch with only PTYs alive resolves to *nothing* and should fail with an actionable message. The temptation is a blanket "if no VS Code terminal matched, try the PTY anyway". That reintroduces the black hole the flag exists to prevent (delivering into a window the sidebar user is not looking at). Prefer failing with a message that names the PTY and tells the user to open the Terminals panel — not a silent redirect.
- **Ordering inside `_attemptDirectTerminalPush`.** The PTY branch is deliberately checked **first**, not as a not-found fallback, because a PTY and a VS Code terminal can normalize to the same agent key (`src/services/TaskViewerProvider.ts:18443-18450`). Do not reorder it.
- **Verb-rail blast radius.** `_handleKanbanVerb` / `_handleTaskViewerVerb` serve *every* verb, not just dispatch ones. Stamping a field onto every body means non-dispatch arms receive an extra key. They ignore unknown keys today, but `verbSchemas.ts` validation must be checked for `additionalProperties: false` on any arm that would now reject the request.

## Edge-Case & Dependency Audit

**Dependencies**
- `src/services/LocalApiServer.ts` — the three generic verb rails plus the existing `/kanban/dispatch` handler.
- `src/services/TaskViewerProvider.ts` — `ConfiguredKanbanDispatchOptions`, `_getAgentNameForRole`, `_resolveAgentTerminalForPlan`, `_attemptDirectTerminalPush`, `_dispatchExecuteMessage`, the `sendToTerminal` verb arm, and the `triggerAgentAction` verb arm (`:11949`, which currently passes no options at all).
- `src/services/KanbanProvider.ts` — the `triggerAction` gate at `:7970` and the two `apiOriginated` pass-throughs at `:8031` and `:8116`.
- `src/services/verbSchemas.ts` — `triggerAction` already declares `apiOriginated: { type: 'boolean' }` (`:231`); a new field needs the same treatment.
- `src/standalone/ptyFleetService.ts` — read-only here (`PTY_IDE_NAME`, `listActive()`, `get()`).
- Unaffected: `src/standalone/bootstrap.ts`. The standalone host already routes `triggerAction`/`sendToTerminal` straight into the PTY fleet (`:1105-1110`, `:1092`). This plan fixes the **extension-running** configuration only.

**Edge cases**
- **A PTY and a VS Code terminal share a normalized name.** For an api-originated dispatch the PTY wins (existing, deliberate). Confirm that still holds after the split — the browser surface is the one that can display it.
- **CLI triggers disabled + browser drag-drop.** Must still be refused with `CLI triggers are disabled`. This is the regression the flag split exists to prevent.
- **CLI triggers disabled + `POST /kanban/dispatch`.** Must still succeed (explicit manager command).
- **Sidebar dispatch with only PTYs alive.** Must fail with a message that says the terminal is in the browser Terminals panel — never silently deliver there, and never claim "no agent assigned" when one plainly exists.
- **Exited PTY.** `_attemptDirectTerminalPush` requires `ptyHandle.status === 'active'` (`:18455`); `listActive()` filters. Dispatching to a dead PTY must fall through to the warning, not throw.
- **Worktree-routed dispatch.** `_findTerminalNameByWorktreePathAndRole` runs first when `worktreePath` is set. Its `strictRole: false` path-only fallback means any worktree terminal matches — with PTYs now eligible, confirm a browser dispatch for role `reviewer` in a worktree does not land in that worktree's `coder-1` PTY when a `reviewer` PTY exists. (Role-matched loop runs first, so it should not; assert it.)
- **`/kanban/dispatch` pre-flight liveness check.** It fails 409 when no terminal is live (`src/services/LocalApiServer.ts:1205`) using `getRegisteredTerminals()`, which already includes active PTYs (`src/services/TaskViewerProvider.ts:1768-1773`). No change needed — verify it does not regress.
- **Non-dispatch verbs on the stamped rails.** `getSetting`, `viewPlan`, `memoLoad` etc. now receive an extra body key. Audit `verbSchemas.ts` for strict-shape arms.
- **Prompt framing on the PTY path.** Delivery must keep going through `sendPromptToPty`, which owns bracketed-paste framing, 256-byte chunking, the per-terminal send lock and the confirm CR (`src/services/TaskViewerProvider.ts:18469-18472`). A raw `pty.write(payload + '\r')` submits a multi-line prompt line-by-line and the agent runs fragments.

## Dependencies

- None — no prior session output required. Independent of the two webview siblings in this feature (they touch `src/webview/terminals.*`; this plan touches `src/services/*` and `src/extension.ts`). Can land in any position in the feature's shipping order.

## Adversarial Synthesis

Key risks: the flag split re-wires a security-adjacent gate in the dispatch hot path; the resolve/deliver symmetry fix narrows what sidebar dispatches can resolve (a deliberate behavioural change); and stamping every verb rail widens the body shape seen by ~all verb arms. Mitigations: `bypassTriggerGate` is stripped from client bodies at the rail and set only by `/kanban/dispatch`; the eligibility filter is applied at both the local *and* global resolution loops so no surface is handed a name it will refuse; and `verbSchemas.ts` gains the new field explicitly rather than relying on unknown-key tolerance.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — split the overloaded flag

Amend `ConfiguredKanbanDispatchOptions` (currently `src/services/TaskViewerProvider.ts:196-210`):

```ts
    /**
     * Per-surface fleet discriminator. True when this dispatch arrived over HTTP —
     * i.e. from a browser panel, a CLI script or the orchestrator — rather than from
     * the in-process VS Code sidebar webview.
     *
     * It selects the terminal FLEET only: an api-originated dispatch may resolve and
     * deliver to a PTY (visible in the browser Terminals panel); an in-process
     * dispatch may not (the sidebar cannot display a PTY, so delivering there is a
     * silent black hole).
     *
     * Set centrally by LocalApiServer's verb rails — every HTTP entry point gets it
     * for free. Do NOT re-derive it per call site; that is what left the browser
     * panels routing into VS Code terminals they could not see.
     */
    apiOriginated?: boolean;
    /**
     * Bypass the CLI-triggers gate (KanbanProvider `_cliTriggersEnabled`). That gate
     * exists to stop an ACCIDENTAL drag-drop from auto-dispatching; it must still
     * apply to a browser drag-drop, which is the same accident on a different surface.
     *
     * Only an explicit manager command sets this — today just POST /kanban/dispatch.
     * Deliberately separate from `apiOriginated`: a browser drag IS api-originated
     * (it may use the PTY fleet) but is NOT an explicit command (the gate still binds).
     */
    bypassTriggerGate?: boolean;
```

### 2. `src/services/KanbanProvider.ts` — gate reads the new flag only

At `src/services/KanbanProvider.ts:7963-7971`:

```js
-                if (!this._cliTriggersEnabled && !msg?.apiOriginated) {
+                // Gate on bypassTriggerGate, NOT apiOriginated. Every browser-panel verb
+                // is api-originated now (LocalApiServer stamps it for fleet selection);
+                // reading that flag here would silently disable the user's CLI-triggers
+                // setting for the whole browser cockpit.
+                if (!this._cliTriggersEnabled && !msg?.bypassTriggerGate) {
                     return { success: false, error: 'CLI triggers are disabled' };
                 }
```

Both pass-throughs keep forwarding `apiOriginated` and additionally forward the new flag — `:8031`:

```js
                             apiOriginated: !!msg?.apiOriginated,
+                            bypassTriggerGate: !!msg?.bypassTriggerGate
```

and `:8116` (the `switchboard.triggerAgentFromKanban` command), whose signature gains a trailing parameter in `src/extension.ts:1484-1486`:

```ts
    const triggerFromKanbanDisposable = registerSwitchboardCommand('switchboard.triggerAgentFromKanban',
        async (role, sessionId, instruction?, workspaceRoot?, targetTerminalOverride?, apiOriginated?, bypassTriggerGate?) => {
        return await taskViewerProvider.handleKanbanTrigger(role, sessionId, instruction, workspaceRoot,
            { targetTerminalOverride, persistColumnOnError: true, apiOriginated: !!apiOriginated, bypassTriggerGate: !!bypassTriggerGate } as any);
    });
```

### 3. `src/services/LocalApiServer.ts` — stamp the surface once, at the transport boundary

Add a shared helper and call it from all three generic rails. This is the change that discharges the "OBLIGATION" comment structurally instead of per-caller.

```ts
    /**
     * Every body arriving on a verb rail is, by definition, NOT the in-process VS Code
     * sidebar — it came over HTTP from a browser panel, a CLI script or the orchestrator,
     * all of which can display a PTY. Stamping here (rather than per entry point) is what
     * makes the discriminator impossible to forget; the previous per-caller convention
     * left every browser panel dispatching into invisible VS Code terminals.
     *
     * Note this sets ONLY the fleet-selection flag. `bypassTriggerGate` stays opt-in per
     * endpoint so a browser drag-drop still honours the CLI-triggers setting.
     */
    private _stampHttpSurface(body: any): any {
        body.apiOriginated = true;
        return body;
    }
```

> **Superseded:** In `_handleKanbanVerb` (:1687-1692), `_handleTaskViewerVerb` (:1823-1826), and the equivalent lines in `_handlePlanningVerb` and `_handleProjectVerb`.
> **Reason:** `_handleProjectVerb` does not exist — verified against `src/services/LocalApiServer.ts`. There are three generic rails; `/project/verb/*` requests route into `_handlePlanningVerb` (`:3378-3381`), so stamping it covers the project surface too.
> **Replaced with:** In `_handleKanbanVerb` (`src/services/LocalApiServer.ts:1689-1692`), `_handlePlanningVerb` (`:1716-1719`, which also serves the `/project` verb prefix), and `_handleTaskViewerVerb` (`:1810-1835`, same body shape):

```js
             const body: any = (rawBody && typeof rawBody === 'object') ? { ...rawBody } : {};
             delete body.type;
+            // A client-supplied value is not trusted for either flag: apiOriginated is
+            // overwritten below, and bypassTriggerGate must never be settable by a page.
+            delete body.bypassTriggerGate;
+            this._stampHttpSurface(body);
             const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
```

And `/kanban/dispatch` (`src/services/LocalApiServer.ts:1212`) opts into the gate bypass explicitly:

```js
-            await kanbanVerb('triggerAction', { sessionId, targetColumn, workspaceRoot, apiOriginated: true }, workspaceRoot);
+            // Explicit manager command: both flags. The verb rails stamp apiOriginated for
+            // browser panels, but this endpoint does not go through them.
+            await kanbanVerb('triggerAction', { sessionId, targetColumn, workspaceRoot, apiOriginated: true, bypassTriggerGate: true }, workspaceRoot);
```

### 4. `src/services/TaskViewerProvider.ts` — make resolution use the same eligibility rule as delivery

`_getAgentNameForRole` gains the filter its sibling `_findTerminalNameByWorktreePathAndRole` already has, so no surface is ever handed a name it will refuse:

```ts
-    private async _getAgentNameForRole(role: string, workspaceRoot?: string): Promise<string | undefined> {
+    /**
+     * @param allowPtyFleet When false (in-process sidebar callers), `purpose:'pty'` rows
+     * are skipped. Previously this method had NO filter while its worktree-scoped sibling
+     * did — so a sidebar dispatch could resolve to a PTY name and then be refused by
+     * _attemptDirectTerminalPush, producing "The terminal is not running in VS Code" for a
+     * terminal that was running perfectly well, just not there.
+     */
+    private async _getAgentNameForRole(role: string, workspaceRoot?: string, allowPtyFleet: boolean = false): Promise<string | undefined> {
         const statePath = this._resolveStateFilePath(workspaceRoot);
         let localMatch: string | undefined = undefined;
+        const isEligible = (info: any) => allowPtyFleet || !(info?.purpose === 'pty' || info?.ideName === PTY_IDE_NAME);
         // ...
                     if (state.terminals) {
                         for (const [name, info] of Object.entries(state.terminals) as [string, any][]) {
+                            if (!isEligible(info)) { continue; }
                             if (info.role === role) { localMatch = name; break; }
                         }
                     }
```

`_resolveAgentTerminalForPlan` (`src/services/TaskViewerProvider.ts:7897-7918`) threads it through, and keeps its existing "prefer a live PTY of this role" branch:

```ts
-        return this._getAgentNameForRole(role, workspaceRoot);
+        return this._getAgentNameForRole(role, workspaceRoot, allowPtyFleet);
```

Audit and update the other `_getAgentNameForRole` call sites (`dispatchCustomPromptToRole` at `:4321`, `_handleAirlockSendToCoder` at `:20949`) — each must pass the surface flag it actually has rather than defaulting to `false` where the caller is HTTP-originated.

> **Superseded:** The eligibility fix is applied to `_getAgentNameForRole` only.
> **Reason:** Incomplete. `_getAgentNameForRole` (`src/services/TaskViewerProvider.ts:7857`) falls through to `_getAgentNameForRoleGlobal` (`:7807-7855`) when no local state file matches, and the global loop has the **same missing filter** — a sidebar dispatch in a multi-root workspace can still be handed a PTY name from another root and then refuse it. Fixing only the local loop leaves Defect B half-alive on exactly the path it was meant to kill.
> **Replaced with:** thread `allowPtyFleet` into `_getAgentNameForRoleGlobal(role, skipStatePath, allowPtyFleet)` as well and apply the same `isEligible` skip in its `state.terminals` loop (and pass it from `_getAgentNameForRole`'s fallback call at `:7894`). The `state.chatAgents` loops need no filter — chat agents are never PTY rows.

### 5. `src/services/TaskViewerProvider.ts` — an actionable failure, not a misleading one

`_dispatchExecuteMessage` (`src/services/TaskViewerProvider.ts:18364-18391`) currently blames VS Code even when the target is a healthy PTY. Name the real situation:

```ts
         if (pushed) return true;

-        this._seams().ui.showWarningMessage(`Could not deliver prompt to '${targetAgent}'. The terminal is not running in VS Code.`);
+        // Distinguish "no such terminal anywhere" from "it exists, but on a surface this
+        // dispatch may not use". The second case used to render as the first, which read
+        // as a bug in the PTY fleet rather than a routing decision.
+        const ptyMatch = !allowPtyFleet && this._ptyFleetService
+            ? this._ptyFleetService.listActive().find(t =>
+                this._normalizeAgentKey(this._stripIdeSuffix(t.friendlyName))
+                === this._normalizeAgentKey(this._stripIdeSuffix(targetAgent)))
+            : undefined;
+        this._seams().ui.showWarningMessage(ptyMatch
+            ? `'${targetAgent}' is a browser terminal (Switchboard Terminals panel), so the VS Code sidebar cannot dispatch to it. Dispatch from the browser board, or open a VS Code agent terminal for this role.`
+            : `Could not deliver prompt to '${targetAgent}'. No live agent terminal with that name was found.`);
         return false;
```

### 6. `src/services/TaskViewerProvider.ts` — give `sendToTerminal` a PTY arm

In the `sendToTerminal` case (`src/services/TaskViewerProvider.ts:12486-12541`), before the `_registeredTerminals` lookup:

```ts
                         const { name, input, paced } = data;
                         // ... existing validation ...

+                        // PTY fleet first for HTTP-originated calls, mirroring
+                        // _attemptDirectTerminalPush. Without this arm the verb cannot reach
+                        // a PTY at all in the extension host: PTYs live in _ptyFleetService,
+                        // not in _registeredTerminals and not in the HostTerminal seam, so
+                        // every browser "send to terminal" failed as "not found or not local".
+                        if (data?.apiOriginated && this._ptyFleetService) {
+                            const normalized = this._normalizeAgentKey(this._stripIdeSuffix(name));
+                            const ptyHandle = this._ptyFleetService.get(name)
+                                || this._ptyFleetService.listActive().find(t =>
+                                    this._normalizeAgentKey(this._stripIdeSuffix(t.friendlyName)) === normalized);
+                            if (ptyHandle && ptyHandle.status === 'active') {
+                                // Raw write, NOT sendPromptToPty: this verb also carries control
+                                // input such as '/clear', and sendPromptToPty's clearBeforePrompt
+                                // would double-clear (the same reason this arm avoids
+                                // _attemptDirectTerminalPush — see the note below).
+                                ptyHandle.sendText(input, true);
+                                return { success: true };
+                            }
+                        }
                         let terminal: any;
```

Add `apiOriginated: { type: 'boolean' }` to the `sendToTerminal` schema in `src/services/verbSchemas.ts:1065` so the stamped field validates.

### 7. `src/services/TaskViewerProvider.ts` — the `triggerAgentAction` verb arm passes no options at all

At `src/services/TaskViewerProvider.ts:11949-11951` the verb forwards nothing, so even a stamped body loses the flag before it reaches the dispatcher:

```ts
                     case 'triggerAgentAction':
-                            await this._handleTriggerAgentAction(data.role, data.sessionFile, data.instruction);
+                            await this._handleTriggerAgentAction(data.role, data.sessionFile, data.instruction,
+                                data.workspaceRoot,
+                                { apiOriginated: !!data.apiOriginated } as any);
```

Sweep the sibling arms that dispatch (`sendAnalystMessage`, `dispatchProjectManager`, `linearImportAndSendToPlanner`) for the same dropped-options pattern and thread the flag through each.

## Verification Plan

**Automated**
- *Session directive: no compilation and no automated test runs in this verification plan.* Recommended follow-up coverage when tests are next run (not executed under this plan):
  - Flag-split quadrants: `apiOriginated: true, bypassTriggerGate: false` + `_cliTriggersEnabled: false` → refused with `CLI triggers are disabled`; `bypassTriggerGate: true` → dispatches; `apiOriginated: true` → `_resolveAgentTerminalForPlan` returns a PTY name and `_attemptDirectTerminalPush` takes the PTY branch; `apiOriginated: false` with **only** PTYs in `runtime.terminals` → `_getAgentNameForRole` (and its `_getAgentNameForRoleGlobal` fallback) returns `undefined`.
  - Rail test: `_handleKanbanVerb` / `_handlePlanningVerb` / `_handleTaskViewerVerb` each forward `apiOriginated: true`, and a client-supplied `bypassTriggerGate: true` in the request body is stripped.
  - Existing suite, with attention to `verb-engine-headless-seams.test.js` (exercises `sendToTerminal` payload validation) and the headless feature-management contract tests.

**Manual — the reported failure (primary)**
5. With the extension running, close every VS Code terminal. Confirm the sidebar shows no registered agents.
6. Open the browser Terminals panel and spawn a PTY named `planner-1` with role `planner`.
7. From the **browser** kanban board, drag a plan card into `PLAN REVIEWED` (or whichever column dispatches to `planner`). Confirm:
   - no `The terminal is not running in VS Code` warning;
   - the prompt appears in the `planner-1` pane in the browser Terminals panel;
   - the prompt arrives as **one** submission — a multi-line prompt must not be executed line-by-line (this is the bracketed-paste/`sendPromptToPty` contract).
8. Repeat with a `coder` PTY and a coder-dispatching column.
9. From the browser board, use the per-card "send to agent" / trigger action. Confirm delivery to the PTY.

**Manual — CLI-triggers gate must survive**
10. Turn CLI triggers **off**. Drag a card on the browser board. Confirm it is refused with `CLI triggers are disabled` and nothing is delivered to any PTY. *(This is the regression the flag split exists to prevent — if this passes silently by dispatching, the split is wrong.)*
11. With CLI triggers still off, run `POST /kanban/dispatch` for the same card via curl. Confirm it **does** dispatch.
12. Turn CLI triggers back on. Confirm the browser drag from step 10 now dispatches.

**Manual — sidebar behaviour unchanged**
13. Open a VS Code agent terminal for role `planner` **while** the `planner-1` PTY is also live. Dispatch from the **VS Code sidebar**. Confirm it lands in the VS Code terminal, not the PTY.
14. Dispatch the same role from the **browser** board. Confirm it lands in the PTY (browser surface prefers the fleet it can display).
15. Close the VS Code terminal, leaving only the PTY. Dispatch from the VS Code sidebar. Confirm the new message names the browser Terminals panel and tells the user where to dispatch from — and that nothing is silently delivered to the PTY.

**Manual — worktree routing**
16. Create a worktree with both a `coder` and a `reviewer` PTY. Dispatch a `reviewer`-role card from the browser board. Confirm it reaches the `reviewer` PTY, not the `coder` one (role-matched loop wins over the path-only fallback).

**Manual — `sendToTerminal` and lifecycle**
17. From a browser panel, trigger a `sendToTerminal` action against a live PTY. Confirm the text arrives.
18. Send `/clear` through the same path. Confirm the terminal clears **once** (no double-clear).
19. Kill `planner-1`, then dispatch to role `planner` from the browser board with no other planner terminal alive. Confirm a clean failure (no throw, no unhandled rejection in the extension host log) and an accurate message.
20. Check `POST /kanban/dispatch` liveness pre-flight with only PTYs alive: it must **not** return the 409 "No terminal agent is live right now".

**Manual — non-dispatch verbs on stamped rails**
21. Exercise a spread of non-dispatch verbs from the browser (`getSetting`, `viewPlan`, `memoLoad`, `fetchKanbanPlans`, a feature create). Confirm none reject on the extra `apiOriginated` key and no schema-validation errors appear in the extension host log.

**Manual — standalone host unaffected**
22. Boot the standalone CLI (no extension). Confirm browser dispatch and `sendToTerminal` still work — that host has its own PTY arms and must be untouched by this change.

## Completion Report

Routed HTTP/browser-surface dispatches to active PTY terminals by stamping `apiOriginated: true` on HTTP verb rails, introducing `bypassTriggerGate` for explicit manager endpoints, enabling `allowPtyFleet` filtering in global and local agent resolution, adding PTY support to `sendToTerminal`, and refining warning messages. Files changed: `src/services/LocalApiServer.ts`, `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/extension.ts`, and `src/services/verbSchemas.ts`. No issues encountered during implementation.

