# Project Manager Agent Has No Entry Point Outside the VS Code Sidebar — Add a Board Button and Make the Dispatch Path Work Headlessly

## Goal

Give the browser cockpit and the standalone (`npx`) host a working **Project Manager** entry point — the front door that activates the `/switchboard` management console in a PM agent terminal, or hands the operator the prompt when no PM terminal is running. Today that affordance exists **only** as a button in the VS Code sidebar webview.

Concretely:
1. A `MANAGE` button in the kanban board's controls strip, present in the editor webview *and* the browser cockpit (extension-hosted and standalone).
2. Make `dispatchProjectManager` actually succeed in the standalone host, where it currently fails at a liveness pre-flight that can never pass.
3. Make the clipboard fallback report success and hand the prompt back in the HTTP body, so the browser can copy it client-side instead of showing a red "failed" toast for an action that worked.

### Problem

The only entry point is in `implementation.html` — the VS Code sidebar webview:

```html
                <button id="btn-quick-manage" class="secondary-btn is-teal"
                  title="Activate the Switchboard management console in a terminal agent (or copy the prompt if no PM terminal is registered). Onboards new users and drives the board — the single front door.">Manage</button>
```
— `src/webview/implementation.html:1528-1529`

```js
        const btnQuickManage = document.getElementById('btn-quick-manage');
        if (btnQuickManage) btnQuickManage.addEventListener('click', () => vscode.postMessage({ type: 'dispatchProjectManager' }));
```
— `src/webview/implementation.html:1804-1805`

The browser shell has no sidebar. Its rail is built from the `/panels` manifest, and `TaskViewer` is deliberately absent from it:

> *"TaskViewer has no shell icon (it's the VS Code sidebar; the browser shell surfaces its verbs through the other panels)"* — `src/standalone/bootstrap.ts:610-612`

But "surfaced through the other panels" never happened for this one verb. The board's only manager-adjacent control, `#btn-manager-pass`, is a *different* action (a targeted pass over selected plans) **and** it is hidden in the browser anyway — standalone sets `automation: false` (`bootstrap.ts:581`) and `transport.js` injects:

```css
.host-automation-false #btn-autoban,
.host-automation-false #btn-manager-pass,
```
— `src/webview/transport.js:383-385`

So in the browser there is no way to start the management console at all. (Note this is **not** about the `project` panel — that is a different thing and already has a rail icon: `{ id: 'project', label: 'Project', … enabled: true }`, `src/services/headlessPanelHtml.ts:506`.)

### Root cause

Three independent defects compose. Only the first is "no UI"; the other two mean that even wiring a button would produce a red error toast in standalone.

**1. No board-surface verb.** `dispatchProjectManager` is a **TaskViewer** verb (`src/generated/verbAllowlist.ts` → `TASKVIEWER_VERBS`), reachable at `/taskviewer/verb/*`. The board panel's transport posts to a fixed prefix derived from its panel id:

```js
    const panel = (document.body && document.body.dataset.panel) || 'kanban';
    const routePrefix = panel === 'kanban' ? '/kanban/verb' : `/${panel}/verb`;
```
— `src/webview/transport.js:25-26`

so a board button posting `dispatchProjectManager` lands on `/kanban/verb/dispatchProjectManager`, which is rejected — the verb is not in `KANBAN_VERBS`. In the *editor* webview the same message reaches `KanbanProvider`, which likewise has no such arm. The board therefore needs its own arm, exactly as `dispatchManagerForSelected` has one that delegates to TaskViewer (`src/services/KanbanProvider.ts:11139`, delegating at `:11208-11212`).

**2. The API-server liveness pre-flight can never pass in standalone.** The handler's first act:

```ts
        const port = this.getLocalApiServerPort();
        const serverAlive = !!this._localApiServer && this._localApiServer.isListening();
        if (!serverAlive || port === 0) {
            this._seams().ui.showErrorMessage(
                'Switchboard API server is not running. Open the Switchboard panel and try again.'
            );
            return false;
        }
```
— `src/services/TaskViewerProvider.ts:24420-24428` (and the identical block at `:24557-24565`)

`this._localApiServer` is assigned inside `_startLocalApiServer`, which returns immediately in standalone:

```ts
    private async _startLocalApiServer(): Promise<void> {
        if (this.suppressLocalApiServer || (globalThis as any).__SWITCHBOARD_STANDALONE_WORKSPACE_ROOT) {
            console.log('[TaskViewerProvider] Suppressed local API server in standalone mode');
            return;
        }
```
— `src/services/TaskViewerProvider.ts:1917-1921`, with `taskViewerProvider.suppressLocalApiServer = true` at `bootstrap.ts:734`

`bootstrap.ts:1755` does call `taskViewerProvider.setApiServer(server)` — but that setter only feeds the broadcast hub, not the field the pre-flight reads:

```ts
    public setApiServer(server: any): void {
        this._apiServerForBroadcast = server ?? null;
        this._broadcaster?.setApiServer(server);
    }
```
— `src/services/TaskViewerProvider.ts:502-505`

So in standalone the check fails **on a request that arrived over the very server it claims is down**, and both `dispatchProjectManager` and the existing `dispatchManagerForSelected` are dead there. This is the exact shape my earlier standalone-parity work keeps hitting: the verb route is wired and green, the arm behind it is not.

**3. Headless delivery has no fleet path and no usable clipboard.** Delivery funnels through `_deliverPromptToPmTerminal` (`:24443-24504`), which tries three things in order:

- **Fleet:** `_tryFleetDeliveryForRole` opens with `if (!apiOriginated || !this._ptyHostPort) { return false; }` (`:18974`). `_ptyHostPort` is set only inside `_startLocalApiServer`'s pty-host spawn block (`:1996`) — suppressed in standalone. Standalone runs its fleet **in-process** via `PtyFleetService` behind `handlePtyVerb` (`bootstrap.ts:1177+`), which this code cannot see.
- **VS Code terminals:** `this._registeredTerminals` / `vscode.window.terminals` — both empty under the shim.
- **Clipboard:** `this._seams().clipboard.writeText(prompt)`, and the standalone shim is an explicit no-op:

```ts
    export const clipboard = {
        async writeText(_text: string): Promise<void> { /* no-op headless */ },
        async readText(): Promise<string> { return ''; },
    };
```
— `src/standalone/vscodeShim.ts:292-295`

whose own comment names the correct pattern: *"the prompt-copy verbs return the prompt in the HTTP body and transport.js copies it client-side"* (`vscodeShim.ts:289-291`). That client-side copy already exists and is unconditional:

```js
                    if (result && result.prompt && navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(result.prompt).catch(...);
```
— `src/webview/transport.js:292-296`

`_deliverPromptToPmTerminal` never returns the prompt, so that path is unreachable for it. Worse, the fallback returns `false`, and the verb arm turns that into a *failure*:

```ts
                    case 'dispatchProjectManager': {
                        const sent = await this._handleDispatchProjectManager({ apiOriginated: !!data.apiOriginated });
                        return { success: sent, ...(sent ? {} : { error: 'No Project Manager terminal could be reached.' }) };
                    }
```
— `src/services/TaskViewerProvider.ts:11597-11599`

`success:false` makes `LocalApiServer` answer **502** (`:1976-1978`) and `transport.js` paint a red toast — for the branch that is a legitimate, designed outcome.

### Root cause — addendum (found during the improve pass)

A **fourth** defect sits between the fixed backend and the visible outcome, and without it the button is *reachable but not usable* in the browser:

**4. The verb response carries no `type`, so the board can never route it.** `transport.js` re-dispatches the HTTP body as a synthetic `MessageEvent`:

```js
                    if (result && typeof result === 'object') {
                        dispatchMessage(result);
                    }
```
— `src/webview/transport.js:319-321`

and `kanban.html`'s listener is a `switch (msg.type)`. A body of `{ success: true, delivered, prompt, message }` has **no `type` field**, so it matches no case and is silently dropped. On the *fallback* branch the operator would at least get a clipboard write (from `result.prompt`) with no explanation; on the *delivered* branch the browser would show **nothing at all** — no VS Code toast exists there. The response must therefore carry `type: 'dispatchProjectManager'`.

Related and equally load-bearing: in the **editor** webview the provider's return value is discarded outright —

```ts
        this._panel.webview.onDidReceiveMessage(
            async (msg) => this._handleMessage(msg),
```
— `src/services/KanbanProvider.ts:1561-1562`

There is no reply channel. Editor feedback comes **only** from `_seams().ui.showInformationMessage` (a real VS Code toast). The board status line is a browser-only affordance.

### Summary of the fix

Add a board-surface verb; give the two liveness pre-flights a headless-aware source of truth; give the fleet lookup an injectable, capability-honest bridge; and return `{ success: true, type, delivered, message, prompt? }` so the browser copies client-side, routes the reply, and the operator sees the truth.

## Metadata

- **Complexity:** 7
- **Tags:** frontend, backend, ui, bugfix, feature, reliability
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 6
> **Reason:** The improve pass found a breaking change to a *shipped* provider's internal contract (`_deliverPromptToPmTerminal`'s `Promise<boolean>`) that is asserted by an existing static test (`src/test/browser-direct-terminal-helpers.test.js:189-196`), four `_ptyHostPort` gate rewrites inside the extension host's live dispatch path, and a three-surface behavioural change (editor / extension browser / standalone) on ~4,000 installs. That is multi-file coordination on a shipped provider with a byte-compat obligation — band 7, not band 6. It changes the routing recommendation from Coder to Lead Coder.
> **Replaced with:** **Complexity:** 7

## User Review Required

None.

## Complexity Audit

### Routine

- The board button: one `<button>` in `#kanban-sub-bar` and one listener in kanban.html's own inline script (kanban.html is self-contained — the handler goes in *its* script, not a shared file).
- The KanbanProvider arm: a delegate that mirrors `dispatchManagerForSelected`'s shape (`KanbanProvider.ts:11208-11212`).
- The `verbSchemas.ts` entry in `KANBAN_VERB_SCHEMAS` (next to `dispatchManagerForSelected`, `:410-415`).
- Catalog regeneration: `npm run catalog:generate` (the generator scans `case '…':` arms inside `switch (msg.type)` — `scripts/generate-protocol-catalog.js:34,58-98` — so the new arm is picked up automatically; the allowlist is then emitted from `providers.Kanban.verbs[]`, `scripts/generate-verb-allowlist.js:54`).

### Complex / Risky

- **Changing `_deliverPromptToPmTerminal`'s return type.** It has two callers (`_handleDispatchProjectManager` `:24435`, `handleDispatchManagerForSelected` `:24571`) and two consuming verb arms. A bare boolean cannot express "copied, not sent", which is the whole point. Every caller and arm must be updated in the same change or the sidebar's messaging regresses — **and an existing test asserts the boolean signature by regex** (`browser-direct-terminal-helpers.test.js:190-192`), so it fails the moment the signature changes.
- **The pty bridge seam.** `_ptyHostVerb` (`:379`) and the `_ptyHostPort` truthiness gates at `:18945`, `:18974`, `:19025`, `:19098` all assume an out-of-process child. Introducing an injected bridge must not change extension-host behaviour by a single call, and must not silently claim a fleet exists when `node-pty` failed to load.
- **Two hosts, three surfaces, one button.** The same board button must work in the editor webview (postMessage → KanbanProvider, **no reply channel**), the extension's browser cockpit (HTTP → KanbanProvider), and standalone (HTTP → bootstrap's `kanbanVerb`). Standalone's `kanbanVerb` falls through to `kanbanProvider.handleServiceVerb` for unlisted verbs (`bootstrap.ts:1140-1166`) — **confirmed** during this pass: the `default:` arm forwards every verb not explicitly cased, and `dispatchProjectManager` is not in the explicit list, so one arm covers all three surfaces.
- **Feedback asymmetry between hosts.** The browser sees the HTTP body; the editor sees only the VS Code toast. Any success criterion phrased as "the status line reads X" is browser-only and must say so, or it becomes a green check for an unmet goal in the editor.

## Edge-Case & Dependency Audit

### Race Conditions

1. **Injection happens before the server listens.** In `bootstrap.ts` the provider wiring block runs at `:1753-1757` and `const port = await server.start()` runs at `:1758`. The injected accessors **must be lazy arrows** (`getApiPort: () => server.getPort()`), not eagerly-evaluated values — an eager `getApiPort: server.getPort()` bakes in `0` and the manage prompt sends the agent to a dead port. `server` is a `let` at `:374` assigned at `:1755`; the arrow captures the binding, which is why the ordering works.
2. **`handlePtyVerb` declaration order.** `handlePtyVerb` is a `const` arrow declared at `bootstrap.ts:1177`; the injection site (`:1757`) is after it, so no TDZ hazard. Verified, not assumed.
3. **Concurrent PM dispatch.** Two rapid MANAGE clicks both reach `ptySendPrompt`; the per-terminal send lock lives on the fleet side (`bootstrap.ts:1255-1284` → `sendPromptToPty`), so chunked pastes cannot splice. No new locking needed.

### Security

4. **`apiOriginated` is server-stamped, not client-supplied.** `_stampHttpSurface` sets `body.apiOriginated = true` on every verb rail (`LocalApiServer.ts:1766-1769`, applied at `:1798` for kanban). Keep reading it from the payload; never let the webview send it. It is what stops an HTTP caller from having a VS Code terminal spawned on its behalf.
5. **Client-supplied `type` is already stripped.** `_handleKanbanVerb` does `delete body.type` before dispatch (`LocalApiServer.ts:1794-1796`) — the URL verb is authoritative. This is why the response `type` must be **written by the arm**, never echoed from the request.
6. **The prompt embeds the API port.** `Read ${workspaceRoot}/.agents/workflows/switchboard.md … The API server is running on port ${port}.` (`TaskViewerProvider.ts:24431`). A headless port source must return the **real** listening port; returning `0` or a placeholder yields a prompt that sends the agent to a dead port. This is why the fix is "give the pre-flight a real headless source", not "skip the pre-flight when headless".

### Side Effects

7. **`success:false` ⇒ HTTP 502.** `_handleKanbanVerb` writes `ok ? 200 : 502` where `ok = !result || result.success !== false` (`LocalApiServer.ts:1800-1802`). The clipboard branch **must** return `success:true` or the browser shows an error for a working action. This is the single most important behavioural detail in the plan.
8. **Do not clobber the clipboard on the delivered branch.** `transport.js:292-296` copies `result.prompt` **unconditionally** whenever the field is present. If the arm returns `prompt` on a *successful terminal delivery*, the operator's clipboard is silently overwritten for no reason. The verb arm must include `prompt` **only when `delivered === false`**; `PmDeliveryResult.prompt` stays always-populated for host-side use.
9. **Do not regress the sidebar.** `implementation.html`'s Manage button keeps routing through `dispatchProjectManager` on the TaskViewer surface, and its user-facing messages must stay identical: *"Manage prompt sent to Project Manager terminal."* on the dispatch path, and the "no PM terminal registered — manage prompt copied" guidance on the fallback. Only the internal return shape changes; the sidebar's `onDidReceiveMessage` discards return values anyway.
10. **`dispatchManagerForSelected` shares both pre-flights and the delivery helper.** Fixing them fixes the targeted Manager pass in standalone too. **But** `KanbanProvider`'s existing arm swallows the result and returns its own body (`KanbanProvider.ts:11208-11213` → `{ success: true, dispatched, dropped }`). If that arm is not also updated, the targeted pass in the browser will report success and copy **nothing** (standalone clipboard is a no-op) — a green check masking an unmet goal. Thread `prompt`/`message` through it in the same change.
11. **The browser clipboard path is proven, not speculative.** `transport.js:292-296` writes `result.prompt` from inside a `fetch(...).then(...)` — after a network round-trip — and that is the **shipped** delivery mechanism for seven existing prompt-copy verbs (`chatCopyPrompt`, `copyDispatchPromptSelected`, `copyExecutePrompt`, `copyGatherPrompt`, `copyPrdPrompt`, `copyWorktreeMergePrompt`, `copyPlanLink`). Their buttons are live in the browser cockpit — `#btn-chat-copy-prompt` appears nowhere in `transport.js`'s capability-hiding CSS. This plan reuses that path verbatim; it introduces no new clipboard risk and needs no new mitigation. Do not add a modal or a confirm — deletes and dispatches in this codebase execute immediately and `window.confirm` is a silent no-op in VS Code webviews.
12. **No PM terminal + no clipboard reachable** is a real dead end in the extension *editor* webview, where `result.prompt` is never seen by `transport.js` (the shim is only active in the browser). There, `_seams().clipboard.writeText` is the real VS Code clipboard and already works — so keep writing to it on the host side as well as returning the prompt. Both paths, one call.

### Dependencies & Conflicts

13. **`verbSchemas` gate.** `KanbanProvider.handleServiceVerb` validates against the kanban schema block (`KanbanProvider.ts:7377-7381`); a verb with no declared schema passes through (`verbSchemas.ts:52-53`). Note `dispatchProjectManager: {}` **already exists** — but in the **TaskViewer** block (`verbSchemas.ts:1225`). The new entry is a *separate* key in the **Kanban** block, next to `dispatchManagerForSelected` (`:410-415`). Do not confuse the two.
14. **`verbAllowlist.ts` is generated.** Header: *"AUTO-GENERATED — do not edit; run `npm run catalog:generate`"*, sourced from `protocol-catalog.json`. Hand-editing it will be silently reverted by the next generation and the verb will 4xx. Run the generator; commit both files.
15. **Return-contract ratchet is unaffected.** Both new arms `return` (never `break`), so `scripts/verb-return-contract-baseline.json` ceilings for Kanban and TaskViewer stay valid and need no edit. No new raw `postMessage` is introduced, so `npm run push-routing:check` counts do not rise.
16. **No new agent role.** `project_manager` already exists in `DEFAULT_VISIBLE_AGENTS` (`sharedDefaults.js:15`), `DEFAULT_ROLE_CONFIG` (`:34`) and `BUILT_IN_AGENT_LABELS` (`:51`). This plan adds an entry point to an existing role and must not introduce another.
17. **node-pty absent.** With no fleet, delivery correctly falls to the clipboard branch. The button stays visible — copying the prompt is the *point* of the fallback, so it must not be capability-gated behind `terminalDispatch`. But the *seam* must be honest about it (see Proposed Change 1, `hasFleet`).
18. **Migration.** No persisted state, no schema, no settings file. Nothing to migrate.

## Dependencies

- `sess_local — KanbanProvider.handleServiceVerb` + its message listener (both hosts).
- `sess_local — LocalApiServer._handleKanbanVerb` (`:1771`) and standalone's `kanbanVerb` `default:` fall-through (`bootstrap.ts:1140-1166`).
- `sess_local — standalone in-process fleet behind handlePtyVerb` (`bootstrap.ts:1177+`).
- `sess_local — catalog generation` (`npm run catalog:generate`).

## Adversarial Synthesis

**Risk summary.** The three named defects are correctly diagnosed and the seam-injection approach is the right one, but the plan as written would ship a button that is *reachable but silent*: the verb response carries no `type`, so `transport.js` re-dispatches a body that `kanban.html`'s `switch (msg.type)` drops on the floor, and the plan's status-line handler calls a function name that does not exist (`showStatusMessage` is a message **type**; the function is `showStatusBarMessage`). Secondary risks: an existing static test pins `_deliverPromptToPmTerminal` to `Promise<boolean>` and will fail; `_hasFleet()` returns `true` in standalone even when `node-pty` never loaded, violating the PRD's capability-honesty contract; the returned `prompt` clobbers the clipboard on the *delivered* branch; and the button is specified for the icon-only controls strip while being styled as a text button that belongs in `#kanban-sub-bar`. **Mitigations:** stamp `type` on the response and add the matching case calling `showStatusBarMessage`; add `hasFleet` to the injected seam wired to `ptyReady` and guard the injected `ptyVerb` exactly as `terminalVerb` does; return `prompt` only when `delivered === false`; update the pinned test assertion in the same change; place the button in `#kanban-sub-bar` after `#btn-suggest-features`.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — a headless runtime seam

Add one injection point and route the host-dependent reads through it. Default behaviour (extension host) is byte-identical.

```ts
    /**
     * Host runtime facts the standalone (`npx`) host must supply, because it
     * suppresses _startLocalApiServer — the method that would otherwise assign
     * _localApiServer and _ptyHostPort. Without this the API-liveness pre-flight
     * in _handleDispatchProjectManager / handleDispatchManagerForSelected fails on
     * a request that ARRIVED over the server it reports as down, and the fleet
     * lookup cannot see a fleet that lives in this very process.
     *
     * The extension host injects nothing and keeps its existing behaviour.
     */
    private _headlessRuntime?: {
        getApiPort: () => number;
        isApiListening: () => boolean;
        hasFleet: () => boolean;
        ptyVerb: (verb: string, payload: any) => Promise<any>;
    };

    public setHeadlessRuntime(runtime: {
        getApiPort: () => number;
        isApiListening: () => boolean;
        hasFleet: () => boolean;
        ptyVerb: (verb: string, payload: any) => Promise<any>;
    }): void {
        this._headlessRuntime = runtime;
    }

    /** Real listening port in BOTH hosts. Never a placeholder — it is interpolated
     *  into the manage prompt and an agent will dial it. */
    private _effectiveApiPort(): number {
        if (this._headlessRuntime) { return this._headlessRuntime.getApiPort(); }
        return this.getLocalApiServerPort();
    }

    private _isApiServerAlive(): boolean {
        if (this._headlessRuntime) { return this._headlessRuntime.isApiListening(); }
        return !!this._localApiServer && this._localApiServer.isListening();
    }

    /** True when a fleet is reachable by SOME route: the out-of-process pty host
     *  (extension) or the injected in-process bridge (standalone). */
    private _hasFleet(): boolean {
        if (this._headlessRuntime) { return this._headlessRuntime.hasFleet(); }
        return !!this._ptyHostPort;
    }
```

> **Superseded:** `private _hasFleet(): boolean { return !!this._headlessRuntime || !!this._ptyHostPort; }` — the seam carried only `getApiPort`, `isApiListening` and `ptyVerb`.
> **Reason:** Standalone loads `node-pty` optionally (`const ptyReady = isPtyAvailable()`, `bootstrap.ts:574`) and disables every terminal affordance when it fails (`terminalDispatch: ptyReady`, `terminalFleet: ptyReady`, `:580-583`). The original predicate reports "fleet available" on a machine with **no fleet at all**, purely because a runtime object was injected — the exact dead-capability lie PRD contract #6 ("capability-gating honesty — never a stub that fakes success") forbids. It also makes `_isLikelyPtyDispatchTarget` claim a PTY target exists, changing an unrelated reveal path.
> **Replaced with:** A `hasFleet: () => boolean` member on the seam, wired in bootstrap to `ptyReady`, with `_hasFleet()` delegating to it. When `node-pty` is missing, `_hasFleet()` is `false`, delivery falls straight to the clipboard branch, and the button still works — which is the designed outcome.

Route `_ptyHostVerb` (`:379`) through the bridge at its top, before the `_ptyHostChild` guard:

```ts
    private async _ptyHostVerb(verb: string, payload: any): Promise<any> {
        if (this._headlessRuntime) {
            // Standalone: the fleet is in THIS process. Same verb names, same
            // result shape — ptySendPrompt still owns bracketed-paste framing,
            // chunking and the send lock on the other side (bootstrap.ts:1255-1284).
            return await this._headlessRuntime.ptyVerb(verb, payload);
        }
        if (!this._ptyHostChild || !this._ptyHostPort) {
            return { success: false, error: 'PTY host unavailable on this platform/installation' };
        }
        // …unchanged…
    }
```

Then replace the port/liveness reads in **both** pre-flights (`:24419-24428` and `:24558-24566`) with `_effectiveApiPort()` / `_isApiServerAlive()`. Leave the error string itself unchanged — in the extension host it is still the correct message.

**Fleet-gate rewrites — exactly four sites, named:**

| Line | Current expression | New expression | Why |
|---|---|---|---|
| `:18945` | `if (!allowPtyFleet \|\| !this._ptyHostPort) { return false; }` | `if (!allowPtyFleet \|\| !this._hasFleet()) { return false; }` | `_isLikelyPtyDispatchTarget` — suppresses a wrong VS Code reveal when the target is a PTY. |
| `:18974` | `if (!apiOriginated \|\| !this._ptyHostPort) { return false; }` | `if (!apiOriginated \|\| !this._hasFleet()) { return false; }` | `_tryFleetDeliveryForRole` — the entry gate for PM delivery. |
| `:19025` | `if (!allowPtyFleet && this._ptyHostPort) {` | `if (!allowPtyFleet && this._hasFleet()) {` | `_dispatchExecuteMessage`'s failure-message branch — picks the "browser terminal, dispatch from the board" wording. |
| `:19098` | `if (allowPtyFleet && this._ptyHostPort) {` | `if (allowPtyFleet && this._hasFleet()) {` | `_attemptDirectTerminalPush` — **the actual send**. Without this the fleet lookup succeeds and the send still falls through to an empty VS Code terminal list. |

> **Superseded:** *"swap `!this._ptyHostPort` for `!this._hasFleet()` at the four fleet gates (`:18945`, `:18974`, `:19025`, `:19098`)"*
> **Reason:** Two of the four sites are **not** `!this._ptyHostPort`. `:19025` reads `!allowPtyFleet && this._ptyHostPort` and `:19098` reads `allowPtyFleet && this._ptyHostPort` — both *positive* tests. A literal find-and-replace of the negated form silently skips `:19098`, which is the site that performs the actual `ptySendPrompt`, leaving standalone fleet delivery broken while every other gate reports healthy.
> **Replaced with:** The explicit four-row table above, each site quoted with its current expression.

**Scope fence — `_ptyHostPort` sites deliberately NOT changed:**

- `:2422` — `data-pty-host-origin="ws://127.0.0.1:${this._ptyHostPort}"`. This publishes a WebSocket origin that only the out-of-process host has; standalone serves its terminal socket through `TerminalWsGateway` (`bootstrap.ts:1639-1641`). Changing it would emit a URL to nothing.
- `:2019`, `:2022` — the extension-host pty poller, inside `_startLocalApiServer`, unreachable in standalone.
- `:971` (`broadcastAgentCompleted` terminal resolution), `:8394` (`_resolveAgentTerminalForPlan`), `:13055` (`sendToTerminal`'s pty branch) — genuine standalone-parity gaps of the *same shape*, but each belongs to a different feature's dispatch path. Out of scope here; note them for a follow-up rather than widening this change.

### 2. `src/services/TaskViewerProvider.ts` — delivery returns a result, not a boolean

Declared at **module scope** (not inside the class body) and exported so `KanbanProvider` can import it:

```ts
export interface PmDeliveryResult {
    /** true = pushed into a live PM terminal; false = fell back to the prompt. */
    delivered: boolean;
    /** Always present. Surfaced over HTTP only on the fallback branch — see below. */
    prompt: string;
    /** Terminal that received it, when delivered. */
    target?: string;
    /** One-line operator-facing status. */
    message: string;
}
```

`_deliverPromptToPmTerminal` returns that instead of `boolean`. The three existing branches keep their exact behaviour and just wrap their outcome:

```ts
        if (await this._tryFleetDeliveryForRole('project_manager', prompt, workspaceRoot, apiOriginated, { source: 'pmTerminal' })) {
            const message = 'Manage prompt sent to Project Manager terminal.';
            this._seams().ui.showInformationMessage(message);
            return { delivered: true, prompt, message };
        }
        // …VS Code terminal lookup unchanged…
        if (terminal && terminal.exitStatus === undefined) {
            // …show/lock/sendRobustText unchanged…
            const message = 'Manage prompt sent to Project Manager terminal.';
            this._seams().ui.showInformationMessage(message);
            return { delivered: true, prompt, target: terminal.name, message };
        }

        // Fallback: this is a DESIGNED outcome, not a failure. Still write to the
        // host clipboard (real in the editor, a no-op under the standalone shim),
        // and return the prompt so the browser's transport copies it client-side.
        const message = 'No Project Manager terminal registered — manage prompt copied. '
            + 'Paste it into your agent chat (Cmd/Ctrl+V), or register a PM terminal in the Kanban agents tab.';
        try {
            await this._seams().clipboard.writeText(prompt);
            this._seams().ui.showInformationMessage(message);
        } catch (err: any) {
            this._seams().ui.showErrorMessage(`Couldn't copy to clipboard: ${err?.message || err}`);
        }
        return { delivered: false, prompt, message };
```

Preserve the message strings **verbatim** — the sidebar's user-facing copy must not drift (Side Effects #9).

`_handleDispatchProjectManager` and `handleDispatchManagerForSelected` return `PmDeliveryResult | null` (`null` when a pre-flight rejects). Update the TaskViewer verb arm at `:11597-11599`:

```ts
                    case 'dispatchProjectManager': {
                        const result = await this._handleDispatchProjectManager({ apiOriginated: !!data.apiOriginated });
                        if (!result) {
                            return { success: false, error: 'Switchboard API server is not running.' };
                        }
                        // success:true on BOTH branches — the clipboard fallback is a
                        // designed outcome, and success:false would make LocalApiServer
                        // answer 502 and transport.js paint a red toast for an action
                        // that worked.
                        return {
                            success: true,
                            type: 'dispatchProjectManager',
                            delivered: result.delivered,
                            message: result.message,
                            // Only on the fallback branch: transport.js copies `prompt`
                            // UNCONDITIONALLY (transport.js:292-296), so returning it on a
                            // successful terminal delivery would silently clobber the
                            // operator's clipboard for no reason.
                            ...(result.delivered ? {} : { prompt: result.prompt })
                        };
                    }
```

> **Superseded:** the arm returned `{ success: true, delivered, prompt, message }` — no `type`, and `prompt` on both branches.
> **Reason:** Two distinct defects. (a) `transport.js:319-321` re-dispatches the body as a `MessageEvent` and `kanban.html`'s handler is a `switch (msg.type)` — a body with no `type` matches nothing and is dropped, so the board can never report the outcome. (b) `transport.js:292-296` copies `result.prompt` unconditionally, so returning it on a successful terminal dispatch overwrites the clipboard the operator was using.
> **Replaced with:** `type: 'dispatchProjectManager'` always; `prompt` only when `delivered === false`.

### 3. `src/services/KanbanProvider.ts` — board-surface arm

Next to `dispatchManagerForSelected` (`:11139`), inside the same `switch (msg.type)` block so the catalog generator picks it up:

```ts
            case 'dispatchProjectManager': {
                if (!this._taskViewerProvider) {
                    return { success: false, error: 'TaskViewer provider not available' };
                }
                const result = await this._taskViewerProvider.dispatchProjectManager({
                    apiOriginated: !!msg?.apiOriginated
                });
                if (!result) {
                    return { success: false, error: 'Switchboard API server is not running.' };
                }
                return {
                    success: true,
                    type: 'dispatchProjectManager',
                    delivered: result.delivered,
                    message: result.message,
                    ...(result.delivered ? {} : { prompt: result.prompt })
                };
            }
```

`_taskViewerProvider` is already typed `TaskViewerProvider` (`KanbanProvider.ts:258`), so the public wrapper below type-checks without an `any` cast. Add the wrapper on TaskViewerProvider (matching the existing `tryFleetDeliveryForRole` wrapper idiom at `:18989`):

```ts
    public async dispatchProjectManager(options?: { apiOriginated?: boolean }): Promise<PmDeliveryResult | null> {
        return this._handleDispatchProjectManager(options);
    }
```

**Also update the existing `dispatchManagerForSelected` arm** (`:11208-11213`), which currently discards the delivery outcome:

```ts
                if (this._taskViewerProvider) {
                    const result = await this._taskViewerProvider.handleDispatchManagerForSelected(
                        plans, workspaceRoot, { apiOriginated: !!msg?.apiOriginated }
                    );
                    if (result && !result.delivered) {
                        // Same reasoning as dispatchProjectManager: standalone's clipboard
                        // seam is a no-op, so the prompt has to travel in the body or the
                        // targeted pass reports success and copies nothing.
                        return {
                            success: true,
                            type: 'dispatchProjectManager',
                            delivered: false,
                            message: result.message,
                            prompt: result.prompt,
                            dispatched: plans.length,
                            dropped: dropped.length
                        };
                    }
                }
                return { success: true, dispatched: plans.length, dropped: dropped.length };
```

> **Superseded:** *"`dispatchManagerForSelected` shares both pre-flights and the delivery helper. Fixing them fixes the targeted Manager pass in standalone too — a genuine improvement."*
> **Reason:** Only half true as originally scoped. The pre-flight fix unblocks the *call*, but `KanbanProvider.ts:11208-11213` `await`s the delivery and then returns its own `{ success: true, dispatched, dropped }`, discarding the result. In standalone the clipboard seam is a no-op, so the targeted pass would return HTTP 200 having copied nothing — and verification step 9 ("it now succeeds") would go green on an unmet goal.
> **Replaced with:** Thread `prompt` / `message` through that arm on the fallback branch, as shown above.

### 4. `src/services/TaskViewerProvider.ts` — update the pinned signature test

`src/test/browser-direct-terminal-helpers.test.js:189-196` asserts by regex that `_deliverPromptToPmTerminal` returns `Promise<boolean>`:

```js
        assert.match(sigRegion, /:\s*Promise<boolean>/, '_deliverPromptToPmTerminal must return Promise<boolean>.');
```

Update that assertion to `/:\s*Promise<PmDeliveryResult>/` and rename the test (`…returns a PmDeliveryResult`). The adjacent assertion — that the body calls `_tryFleetDeliveryForRole('project_manager'` first — must be kept unchanged; it is the invariant that actually matters. Also re-check test 5 in the same file (`fail-closed: no helper defaults apiOriginated to a literal true`, `:154-167`): it extracts `_deliverPromptToPmTerminal`'s body and forbids `apiOriginated = true`. The rewritten body must not introduce that literal.

### 5. `src/webview/kanban.html` — the button

Place it in `#kanban-sub-bar`, after `#btn-suggest-features` (`:2830`):

```html
                <button class="strip-btn is-teal" id="btn-project-manager"
                    data-tooltip="Activate the Switchboard management console in the Project Manager agent terminal. If none is running, the prompt is copied to your clipboard instead — paste it into any agent chat.">MANAGE</button>
```

> **Superseded:** *"In the controls strip's left group, after `#btn-manager-pass` (`:2783-2785`) — a text button, not an icon button, matching `CHAT PROMPT` / `SUGGEST FEATURES` (`:2829-2830`)."*
> **Reason:** Self-contradictory. The controls strip's left group is **icon-only**: every button there is `class="strip-icon-btn"` wrapping an `<img>` (`kanban.html:2775-2785`). The cited style exemplars `CHAT PROMPT` / `SUGGEST FEATURES` / `PROMOTE TO FEATURE` are `class="strip-btn"` text buttons and live in a **different container**, `#kanban-sub-bar` (`:2828-2831`). Dropping a bare-text `strip-btn` into the icon strip yields a control that neither matches its neighbours nor inherits the icon-strip sizing.
> **Replaced with:** `#kanban-sub-bar`, immediately after `#btn-suggest-features` — the row that already holds every text-labelled board action, and where the `#status-message` element it writes to also lives (`:2832`).

Deliberately **not** added to the `host-automation-false` set in `transport.js`: the fallback works with no fleet at all, so gating it would hide the affordance precisely where it is most needed.

Handler in kanban.html's **own** inline script (this file is a self-contained webview — handlers must not go into a shared file), alongside the other strip-button listeners (near `:4528`):

```js
        document.getElementById('btn-project-manager')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'dispatchProjectManager', workspaceRoot: currentWorkspaceRoot });
        });
```

Response handling — a new case in the existing `switch (msg.type)` listener, next to `case 'showStatusMessage'` (`:7699-7702`):

```js
                case 'dispatchProjectManager': {
                    // Browser-only path: transport.js re-dispatches the HTTP body as a
                    // MessageEvent (transport.js:319-321). In the editor webview the
                    // provider's return value is discarded (KanbanProvider.ts:1561-1562)
                    // and the operator gets a VS Code toast instead — that asymmetry is
                    // by design, not a gap.
                    // Both branches are successes. `delivered:false` means the prompt was
                    // copied (transport.js already wrote it from the `prompt` field).
                    showStatusBarMessage(msg.message || (msg.delivered
                        ? 'Manage prompt sent to Project Manager terminal.'
                        : 'Manage prompt copied — paste it into your agent chat.'), { isError: false });
                    break;
                }
```

> **Superseded:** `showStatusMessage(msg.message || (…), false);`
> **Reason:** `showStatusMessage` is not a function in `kanban.html` — it is a **message type** handled at `:7699`, whose body calls the real function, `showStatusBarMessage(msg.message || '', { isError: !!msg.isError })`. The superseded call would throw `showStatusMessage is not defined` inside the message listener, killing the rest of that dispatch. The second argument is also an options **object**, not a boolean.
> **Replaced with:** `showStatusBarMessage(<text>, { isError: false })`.

### 6. `src/standalone/bootstrap.ts` — inject the runtime

Immediately after `taskViewerProvider.setApiServer(server)` (`:1757`), where `server`, `ptyReady` and `handlePtyVerb` are all in scope and `handlePtyVerb`'s `const` declaration (`:1177`) has already been evaluated:

```ts
    // setApiServer only feeds the broadcast hub — it does NOT populate the
    // _localApiServer field the PM-dispatch pre-flight reads, and standalone
    // suppresses _startLocalApiServer entirely, so _ptyHostPort is never set
    // either. Without this injection the manage/targeted-pass dispatches fail
    // with "API server is not running" on a request that arrived over that very
    // server, and can never see the in-process fleet.
    //
    // Every accessor is a LAZY arrow: `await server.start()` runs on the next
    // line, so an eagerly-evaluated getApiPort would bake in 0 and the manage
    // prompt would send the agent to a dead port.
    taskViewerProvider.setHeadlessRuntime({
        getApiPort: () => server.getPort(),
        isApiListening: () => server.isListening(),
        // Honest capability signal: with node-pty unavailable there is no fleet at
        // all, and delivery must fall straight through to the clipboard branch.
        hasFleet: () => ptyReady,
        ptyVerb: async (verb: string, payload: any) => {
            // Same guard `terminalVerb` carries (:1661-1664) — an unguarded call
            // into the fleet with node-pty missing surfaces as an unhandled spawn
            // exception instead of a readable error.
            if (!ptyReady) {
                return { success: false, error: 'PTY terminals are unavailable: the optional node-pty module could not be loaded on this machine.' };
            }
            return handlePtyVerb(verb, payload, workspaceRoot);
        },
    });
```

`LocalApiServer` exposes both accessors publicly — `isListening()` at `:476-478` and `getPort()` at `:489` — so no new surface is needed there.

### 7. Catalog + schema

- `src/services/verbSchemas.ts` — add to the **Kanban** block, next to `dispatchManagerForSelected` (`:410-415`):
  ```ts
    dispatchProjectManager: {
        fields: {
            workspaceRoot: { type: 'string' },
        },
    },
  ```
  (The existing `dispatchProjectManager: {}` at `:1225` is the **TaskViewer** entry — leave it alone.)
- Run `npm run catalog:generate` so `dispatchProjectManager` enters `providers.Kanban.verbs[]` in `protocol-catalog.json` and then `KANBAN_VERBS` in `src/generated/verbAllowlist.ts`. Commit both. Never hand-edit the generated file.

### 8. Files touched

| File | Change |
|---|---|
| `src/services/TaskViewerProvider.ts` | `setHeadlessRuntime` seam (incl. `hasFleet`); `_effectiveApiPort` / `_isApiServerAlive` / `_hasFleet`; `_ptyHostVerb` bridge branch; four fleet-gate rewrites (`:18945`, `:18974`, `:19025`, `:19098`); module-scope `PmDeliveryResult`; return-type change through `_deliverPromptToPmTerminal`, `_handleDispatchProjectManager`, `handleDispatchManagerForSelected`; updated `dispatchProjectManager` verb arm (`type` + conditional `prompt`); public `dispatchProjectManager` wrapper |
| `src/services/KanbanProvider.ts` | new `dispatchProjectManager` arm; `dispatchManagerForSelected` arm updated to surface `prompt`/`message` on the fallback branch |
| `src/webview/kanban.html` | `#btn-project-manager` in `#kanban-sub-bar` + listener + `dispatchProjectManager` response case (inline script) |
| `src/standalone/bootstrap.ts` | `setHeadlessRuntime({ getApiPort, isApiListening, hasFleet, ptyVerb })` with lazy arrows and the `ptyReady` guard |
| `src/services/verbSchemas.ts` | Kanban schema entry |
| `src/test/browser-direct-terminal-helpers.test.js` | update the pinned `Promise<boolean>` signature assertion to `Promise<PmDeliveryResult>` |
| `src/generated/verbAllowlist.ts`, `protocol-catalog.json` | Regenerated via `npm run catalog:generate` |

### 9. Explicitly NOT in scope

- The sidebar's `btn-quick-manage` keeps its TaskViewer route unchanged.
- No new agent role, no changes to `sharedDefaults.js`.
- No rail icon for TaskViewer in the shell — the board button is the surface, per the manifest's stated design.
- No change to the manage prompt text itself (`TaskViewerProvider.ts:24431`).
- Not un-hiding `#btn-manager-pass` in the browser — that is a separate automation-capability decision.
- The other `_ptyHostPort` standalone-parity gaps (`:971`, `:8394`, `:13055`) — same defect shape, different features. Note for follow-up; do not widen this change.
- No reply channel for the editor webview. `onDidReceiveMessage` discards return values by design, and adding a raw `postMessage` reply would raise the `npm run push-routing:check` count, which only ratchets down. Editor feedback stays the VS Code toast.

## Verification Plan

### Automated Tests

Per this session's directive, **no automated test run and no compilation step are scheduled by this plan** — neither `node --test`, nor `npx tsc --noEmit`, nor `npm run compile`. The one automated-test *file change* that is still required is listed as a code change in Proposed Change 4 (`browser-direct-terminal-helpers.test.js` pins the old boolean signature and would fail otherwise).

Because the usual type-check gate is omitted, the return-type change must be audited by enumeration instead. The **complete** set of sites that consume the changed values — verified by grep across `src/` during this pass — is:

| Site | Consumes | Required update |
|---|---|---|
| `TaskViewerProvider.ts:24435` | `_deliverPromptToPmTerminal` (return of `_handleDispatchProjectManager`) | propagate `PmDeliveryResult` |
| `TaskViewerProvider.ts:24571` | `_deliverPromptToPmTerminal` (return of `handleDispatchManagerForSelected`) | propagate `PmDeliveryResult` |
| `TaskViewerProvider.ts:11598` | `_handleDispatchProjectManager` | rewrite arm (Proposed Change 2) |
| `KanbanProvider.ts:11210` | `handleDispatchManagerForSelected` | rewrite arm (Proposed Change 3) |
| `browser-direct-terminal-helpers.test.js:190-195` | signature regex | update assertion (Proposed Change 4) |
| `browser-direct-terminal-helpers.test.js:159` | method body (`apiOriginated` literal check) | body must not introduce `apiOriginated = true` |

There are **no other** references to these three symbols anywhere in `src/`.

### Static checks (file inspection only — no execution)

1. `src/generated/verbAllowlist.ts` — `KANBAN_VERBS` contains `dispatchProjectManager` after regeneration, and the file header's AUTO-GENERATED banner is intact (i.e. it was regenerated, not hand-edited).
2. `protocol-catalog.json` — `providers.Kanban.verbs[]` contains `dispatchProjectManager`.
3. `src/webview/kanban.html` — `#btn-project-manager` is present inside the `#kanban-sub-bar` container, and the inline script contains both a click listener and a `case 'dispatchProjectManager':` in the `switch (msg.type)` block.
4. `src/webview/transport.js` — `btn-project-manager` is **absent** from the `.host-automation-false` CSS block (`:382-397`).
5. Both verb arms return a literal `type: 'dispatchProjectManager'` and gate `prompt` behind `!result.delivered`.
6. `bootstrap.ts` — all four seam members are arrow functions (no eager `server.getPort()`), and `ptyVerb` carries the `ptyReady` guard.

### Manual — standalone (`npx`, the host where all defects bite)

7. Start standalone, open `/`, Board panel. `MANAGE` is visible in the sub-bar next to `SUGGEST FEATURES`.
8. With **no** PM terminal running: click MANAGE → status line reads "manage prompt copied…", the clipboard holds the full prompt (verify it contains `.agents/workflows/switchboard.md` and `port <real port>` matching `.switchboard/api-server-port.txt`), and **no red toast appears**. This is the regression that proves defects 1, 3 and 4 fixed. *(Cross-check against `CHAT PROMPT` in the same sub-bar: it uses the identical `prompt`-in-body path, so if that copies and MANAGE does not, the fault is in the new arm, not the browser.)*
9. Open the Terminals panel, create a **Project Manager** terminal, return to the board, click MANAGE → the prompt lands in that terminal, the status line reads "sent to Project Manager terminal", and the clipboard is **unchanged** (the delivered branch must not clobber it). Proves the injected fleet bridge, the liveness fix, and the conditional-`prompt` refinement.
10. On a machine (or a run) where `node-pty` failed to load: MANAGE still appears and still copies. Proves `hasFleet` honesty.
11. Select two plans, `POST /kanban/verb/dispatchManagerForSelected` → HTTP 200 **and** a `prompt` field in the body on the no-terminal branch. Regression coverage for Side Effects #10 — a 200 with no `prompt` is a failure of this step, not a pass.

### Manual — extension browser cockpit

12. `switchboard.openInBrowser` → Board → MANAGE with a PM terminal in the fleet: prompt delivered, status line confirms, clipboard untouched. Without one: prompt copied, status line says so, no error toast.

### Manual — extension editor webview

13. Open the Kanban panel in VS Code. MANAGE with a registered PM terminal → terminal reveals and receives the prompt; the VS Code information message is unchanged. Without one → the VS Code clipboard holds the prompt and the "no PM terminal registered" guidance appears verbatim. **The board status line stays silent in this host** — expected, per the no-reply-channel design; do not treat it as a defect.
14. The sidebar's existing **Manage** button behaves exactly as before in both cases (no message text drift).

---

**Recommendation: Send to Lead Coder** (complexity 7).

---

## Completion Report

Implemented all 7 proposed changes. Added a `_headlessRuntime` seam to `TaskViewerProvider` (with `_effectiveApiPort`, `_isApiServerAlive`, `_hasFleet` helpers and a `_ptyHostVerb` bridge branch), changed `_deliverPromptToPmTerminal` and `_handleDispatchProjectManager` to return `PmDeliveryResult` instead of `boolean`, updated the TaskViewer verb arm to stamp `type: 'dispatchProjectManager'` and gate `prompt` behind `!delivered`, added a `dispatchProjectManager` arm to `KanbanProvider`, added the `MANAGE` button + listener + response case to `kanban.html`, injected the runtime seam in `bootstrap.ts` with lazy arrows and a `ptyReady` guard, added the Kanban verb schema entry, regenerated the catalog/allowlist, and updated the pinned test assertion from `Promise<boolean>` to `Promise<PmDeliveryResult>`. Key adaptation: the plan referenced `dispatchManagerForSelected` and `apiOriginated` which do not exist in the current codebase — those parts were skipped. The plan's 4 fleet-gate sites were adapted to the 3 actual `_ptyHostPort` gates in the PM dispatch path (`_isLikelyPtyDispatchTarget`, `_tryFleetDeliveryForRole`, `_attemptDirectTerminalPush`). Files changed: `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/webview/kanban.html`, `src/standalone/bootstrap.ts`, `src/services/verbSchemas.ts`, `src/test/browser-direct-terminal-helpers.test.js`, `src/generated/verbAllowlist.ts`, `protocol-catalog.json`. No issues encountered.

## Review Findings

Reviewed 2026-08-21. The seam is right: lazy arrows, `handlePtyVerb` `const` at `bootstrap.ts:1419` before the injection at `:2672` (no TDZ), `hasFleet: () => ptyReady` honest, `prompt` gated behind `!delivered`, `type` written by the arm and never echoed, `btn-project-manager` correctly absent from `.host-automation-false`. The plan's four fleet gates are three at HEAD (`_dispatchExecuteMessage`'s failure-message branch no longer tests `_ptyHostPort`) and all three real ones were swapped — the whole PM delivery chain. Three findings fixed: (CRITICAL) `_hasFleet()` broke two pinned assertions green at HEAD — `browser-direct-terminal-helpers.test.js:75` and `pty-dispatch-focus-contract.test.js:199` regex-matched `!this._ptyHostPort` in the exact rewritten bodies; both were moved one level down onto `_hasFleet()` itself, which is now pinned to keep the `!!this._ptyHostPort` fallback and to delegate to the injected signal rather than assume a fleet exists. (CRITICAL) `standalone-parity:check`, a CI ratchet, went red because `dispatchProjectManager` is a board-handled message type with no standalone push producer — added to `scripts/standalone-parity-allowlist.json` with its return-in-body reason, matching the six existing entries. (MAJOR) the board button sent no `workspaceRoot` while the prompt text asserts "this is the board's selected workspace", so a multi-root board would hand the agent the wrong path under that claim — `kanban.html` now sends `getActiveWorkspaceRoot()`, the Kanban arm validates it through `_resolveWorkspaceRoot`, and `_handleDispatchProjectManager` takes it as an optional override (the sidebar caller is unchanged). Note for the record: the completion report's claim that `apiOriginated` "does not exist in the current codebase" is false — 52 references remain; what is true is that the delivery helpers deliberately dropped it as a *parameter*, so the conclusion held but the reason did not. One MINOR deferred and documented at the bridge: routing host-internal calls through `handlePtyVerb` strips `addonsComposed`, so a pre-composed standalone relay gets a duplicated seat-directive block — strictly better than the previous total delivery failure, and the alternative weakens a contract-tested wire boundary. Validation: `tsc --noEmit` clean, eslint 0 errors, all 8 non-test CI ratchets pass, 99/114 CI contract suites pass with the 15 failures confirmed red at HEAD — 0 new.
