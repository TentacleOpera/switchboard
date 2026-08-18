# Phone-a-Friend Never Reaches a PTY Fleet Seat — Three Breaks in One Signal Path

## Goal

When a coding seat finishes a batch with the Phone-a-Friend add-on enabled, the configured Phone-a-Friend terminal must receive the second-pass prompt — whether that terminal lives in the VS Code terminal panel, in the Terminals cockpit fleet, or in the browser host. Today the signal dies in three separate places and the operator sees nothing at all, with no error on screen.

### Problem analysis — trace the whole path

The feature is a three-hop handshake:

1. **Directive** — `PHONE_A_FRIEND_DIRECTIVE(port, role, originTerminal, dispatchId)` (`src/services/agentPromptBuilder.ts:742-750`) is appended to the coder/lead/intern prompt, telling the agent to `curl -X POST http://127.0.0.1:<port>/phone-a-friend` when it finishes the batch. It is emitted only when **both** `phoneAFriendEnabled` and `apiPort` are truthy (`agentPromptBuilder.ts:1531`).
2. **Endpoint** — `POST /phone-a-friend` (`src/services/LocalApiServer.ts:2791-2832`) validates the body and calls `this._options.onPhoneAFriend`. With no callback wired it answers **503**.
3. **Dispatch** — `TaskViewerProvider._dispatchPhoneAFriend` (`src/services/TaskViewerProvider.ts:5680-5798`) resolves the target terminal and sends the second-pass prompt.

Every hop has a hole.

### Root cause 1 — the dispatcher can only see VS Code terminals

`_dispatchPhoneAFriend` resolves the target **name** correctly (per-terminal override → role default `'*'` → `_getAgentNameForRole('phone_a_friend', …)`, which reads the `state.terminals` registry and *does* include fleet seats — `_isFleetTerminalInfo`, `TaskViewerProvider.ts:9518`). It then tries to turn that name into a terminal **object**, and only two lookups exist:

```ts
let terminal: vscode.Terminal | undefined;
if (this._registeredTerminals) {
    terminal = this._registeredTerminals.get(agentName) || this._registeredTerminals.get(suffixedKey);
}
if (!terminal) {
    const openTerminals = vscode.window.terminals || [];
    terminal = openTerminals.find(t => this._normalizeAgentKey(t.name) === strippedTarget);
}
if (!terminal || terminal.exitStatus !== undefined) {
    this._apiServerDiagnosticsChannel.appendLine(`[Phone-a-Friend] … no terminal running, dropped.`);
    return;
}
```

Both are `vscode.Terminal` registries. The PTY fleet lives in a **child process** and is reachable only through `_ptyHostVerb('ptyListTerminals' | 'ptySendPrompt', …)`. A Phone-a-Friend seat opened from the Terminals cockpit, from a team, or from the browser is therefore invisible here: the name resolves, the object lookup fails, and the request is silently dropped to a diagnostics channel nobody has open.

`notifyTurnEnd` (`TaskViewerProvider.ts:1501-1577`) is the reference implementation of the correct pattern in this same file: list via `ptyListTerminals`, filter `status === 'active'`, deliver via `ptySendPrompt`, and log every no-delivery branch.

### Root cause 2 — the standalone/browser host wires no callback at all

`onPhoneAFriend` is passed to `LocalApiServer` in exactly one place: `TaskViewerProvider.ts:3511`. Under the standalone host `taskViewerProvider.suppressLocalApiServer = true` (`src/standalone/bootstrap.ts:882`), so that server is never constructed; bootstrap builds its own options object (`bootstrap.ts:2337-2522`) and **`onPhoneAFriend` does not appear anywhere in that file**. The endpoint therefore answers `503 {"error":"Phone-a-Friend dispatch not available"}` — and the directive tells the agent the request "will still succeed silently", so the agent does not report the failure either.

### Root cause 3 — under the standalone host the directive is never even emitted

`apiPort` comes from `this._taskViewerProvider?.getLocalApiServerPort() ?? 0` (`KanbanProvider.ts:5304`), and that accessor reads the suppressed field:

```ts
public getLocalApiServerPort(): number {
    return this._localApiServer?.getPort() ?? 0;   // TaskViewerProvider.ts:3708
}
```

`bootstrap.ts:2529` calls `taskViewerProvider.setApiServer(server)`, which only assigns `_apiServerForBroadcast` (`TaskViewerProvider.ts:939-941`) — `_localApiServer` stays null. So under standalone `apiPort === 0`, `phoneAFriendBlock` is `''`, and the coder is never told to call anything.

### Answering "where are the standing orders?"

Standing orders are a different mechanism and are not the reason nothing happened. They are applied at delivery time by `applyStandingOrders` inside the `ptySendPrompt` path (`TaskViewerProvider.ts:631`, `bootstrap.ts:368-371`) and are what makes a **team member report to its head**. Phone-a-Friend is not a standing order — it is a prompt directive plus an HTTP endpoint, and it is orthogonal to team membership. An intern in a team gets its team standing order *and* (when enabled) the Phone-a-Friend directive; the order was working, the directive's return path was not.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, backend, reliability, api
- **Project:** Browser Switchboard

## User Review Required

No user decision needed — the three root causes are verified against the live codebase, the fix follows the existing `notifyTurnEnd` pattern, and the standalone twin is the minimal viable dispatch path. The plan is ready to code.

## Complexity Audit

### Routine

- Adding an `onPhoneAFriend` entry to the standalone options object (`bootstrap.ts:2337-2522`). The standalone options object has no `on*` callback properties today (turn-end is wired via `ingestionEngine.setTurnEndNotifier`, dispatch via the `kanbanVerb` router), so this is a new property, not a copy of a neighbour.
- Replacing `_localApiServer?.getPort()` with a fallback to the assigned broadcast server.
- The fleet-first target lookup is a direct transcription of `notifyTurnEnd`'s already-shipped pattern.

### Complex / Risky

- **The callback must never throw.** `LocalApiServer._handlePhoneAFriend` turns a throw into a 500, and the endpoint's whole contract is best-effort (`LocalApiServer.ts:2823-2825`). Every new failure branch logs and returns.
- **Serialization must survive the rewrite.** `_phoneAFriendInFlight` chains dispatches per target so two batch-end POSTs cannot interleave `/clear` + prompt in one terminal (`TaskViewerProvider.ts:5744-5796`). The fleet branch has to sit *inside* that chained `run`, not beside it.
- **Self-dispatch guard must apply to fleet names too.** The existing `targetKey === originKey` refusal (`TaskViewerProvider.ts:5736-5741`) is computed before the terminal lookup, so it survives — but the fleet branch must not reintroduce a second path around it.
- **Do not gate dispatch on `addons.phoneAFriend === true`.** The existing comment at `TaskViewerProvider.ts:5728-5732` states why: in-flight prompts hardcode `originRole:"coder"` even when the add-on lives on lead/intern, and the flag governs the DIRECTIVE, never the dispatch. Preserve that.
- **Two hosts, two delivery APIs.** The extension sends via `sendRobustText` for vscode terminals and must use `_ptyHostVerb('ptySendPrompt')` for fleet seats; standalone has neither and must use its own `deliverPrompt`/`ptyFleetService`. Do not try to unify them into one call.

## Edge-Case & Dependency Audit

- **Both kinds of terminal exist for one role.** A vscode terminal named `Phone-a-Friend` and a fleet seat of role `phone_a_friend` can coexist. Order the lookup **fleet first, vscode second**: the fleet is the surface the cockpit and teams create into, and it is the one currently unreachable. Log which surface won.
- **Hidden seats.** `ptyListTerminals` returns hidden seats in a sibling `hiddenTerminals` array (see `TaskViewerProvider.ts:557-572`). A hidden Phone-a-Friend seat is a real prompt target — search both arrays, as the seat-block resolver already does.
- **Exited seats.** Filter on `status === 'active'` before sending, mirroring `notifyTurnEnd`'s pre-check (`TaskViewerProvider.ts:1459`). `ptySendPrompt` also returns `{success:false}` in a 200 body rather than throwing — capture and log it, never discard.
- **`/clear` before prompt.** The vscode branch pastes `/clear` explicitly (`TaskViewerProvider.ts:5771-5780`). The fleet branch must NOT replicate that by hand — `ptySendPrompt` owns it via `clearBeforePrompt` / `clearBeforePromptDelayMs`. Pass the same config values (`terminal.clearBeforePrompt`, `terminal.clearBeforePromptDelay`) rather than issuing a separate clear.
- **Standing orders on the second-pass prompt.** The vscode branch passes `{ standingOrders: await this._resolveStandingOrdersForVsCode() }`. The fleet branch gets them for free (`ptySendPrompt` applies them unless `standingOrders: false`). This is a dispatched task, not a machine notice, so leave them ON.
- **Security:** no new endpoint, no new auth surface. `/phone-a-friend` already runs `_checkAuth` (`LocalApiServer.ts:2792`) and validates `planFile` against absolute paths and `..` traversal (`2817-2820`). Standalone inherits that unchanged.
- **Migration:** none. `phoneAFriendTargets` and the `'*'` default key are read-only here and keep their current semantics, including `null` meaning explicit off.
- **Observability:** the diagnostics channel is the only current record. Add a `console.log` alongside each `appendLine` so the browser/standalone host (which has no VS Code output channel) still reports drops.

## Dependencies

- Sibling subtask "Phone-a-Friend Terminal Has No Brand Identity" touches `KanbanProvider.ts` and `terminals.js` only — no file overlap with this plan. The two subtasks are independent and can land in either order.
- `PHONE_A_FRIEND_SECOND_PASS_PROMPT` (Proposed Change #4) must land before or in the same change as Proposed Changes #1 and #3, since both reference it.

## Adversarial Synthesis

Key risks: (1) the `onDispatchResearch` reference in the original draft was a phantom — no such property exists in the standalone options object, corrected to state this is a new property; (2) `kanbanProvider?.getRoleConfig?.(...)` silently returned `undefined` because `getRoleConfig` is not public on `KanbanProvider` — corrected to `taskViewerProvider?.getRoleConfig?.(...)` which has the public method; (3) the prompt function name was inconsistent (`buildPhoneAFriendPrompt` vs `PHONE_A_FRIEND_SECOND_PASS_PROMPT`) — unified to the latter. Mitigations: all three are corrected in the plan text; the fleet branch sits inside the existing `_phoneAFriendInFlight` serialization chain; the self-dispatch guard is computed before the branch and survives unchanged.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — fleet-first target resolution in `_dispatchPhoneAFriend`

Inside the existing `run` closure, before the `_registeredTerminals` lookup:

```ts
const run = (async () => {
    if (prev) { try { await prev; } catch { /* prior dispatch failure is isolated */ } }

    const prompt = PHONE_A_FRIEND_SECOND_PASS_PROMPT(planFile, originRole, originTerminal, dispatchId); // hoisted, unchanged text

    // ── Fleet first ────────────────────────────────────────────────────
    // The PTY fleet lives in a child process; vscode.window.terminals and
    // _registeredTerminals cannot see it. A Phone-a-Friend seat opened from the
    // Terminals cockpit, a team, or the browser is ONLY reachable here. Same
    // pattern as notifyTurnEnd (line 1501-1577): list, filter active, send via
    // ptySendPrompt, log every no-delivery branch.
    // No withTerminalSendLock here (unlike the vscode branch) — ptySendPrompt
    // is serialized server-side in the pty host process, so concurrent calls
    // to the same seat are already ordered.
    if (this._ptyHostPort) {
        try {
            const listed = await this._ptyHostVerb('ptyListTerminals', {});
            const rows = [
                ...(Array.isArray(listed?.terminals) ? listed.terminals : []),
                ...(Array.isArray(listed?.hiddenTerminals) ? listed.hiddenTerminals : []),
            ].filter((t: any) => t.status === 'active');
            const match = rows.find((t: any) => t.friendlyName === agentName)
                || rows.find((t: any) => this._normalizeAgentKey(this._stripIdeSuffix(t.friendlyName || '')) === targetKey);
            if (match) {
                const cfg = vscode.workspace.getConfiguration('switchboard');
                const sendRes = await this._ptyHostVerb('ptySendPrompt', {
                    name: match.friendlyName,
                    data: normalizeNewlines(prompt),
                    clearBeforePrompt: cfg.get<boolean>('terminal.clearBeforePrompt', true),
                    clearBeforePromptDelayMs: resolvePtyClearDelay(cfg), // local function in TaskViewerProvider.ts:369
                });
                if (sendRes?.success === false) {
                    // ptySendPrompt reports delivery failure in a 200 body, never a throw.
                    this._apiServerDiagnosticsChannel.appendLine(`[Phone-a-Friend] fleet seat '${match.friendlyName}' rejected the prompt: ${sendRes.error || 'unknown'}.`);
                    console.warn(`[Phone-a-Friend] fleet delivery to '${match.friendlyName}' failed: ${sendRes.error || 'unknown'}`);
                } else {
                    this._apiServerDiagnosticsChannel.appendLine(`[Phone-a-Friend] origin=${originTerminal || '<unknown>'} → fleet seat '${match.friendlyName}'.`);
                }
                return;
            }
        } catch (err) {
            // Never rethrow: the endpoint contract is best-effort.
            console.warn('[Phone-a-Friend] fleet lookup failed, falling back to vscode terminals:', err);
        }
    }

    // ── vscode.Terminal fallback (unchanged from here down) ────────────
    const suffixedKey = this._suffixedName(agentName);
    …
})();
```

Hoist the existing prompt literal (`TaskViewerProvider.ts:5782`) above the branch so both paths send byte-identical text. Add `console.warn` beside the existing "no terminal running, dropped" `appendLine` so the drop is visible without the VS Code output channel.

### 2. `src/services/TaskViewerProvider.ts:3708` — report the port the host actually serves on

```ts
 public getLocalApiServerPort(): number {
-    return this._localApiServer?.getPort() ?? 0;
+    // `_localApiServer` is null under the standalone host (suppressLocalApiServer),
+    // which serves from its own server assigned via setApiServer(). Returning 0
+    // there silently omits every port-bearing prompt directive.
+    return this._localApiServer?.getPort()
+        ?? this._apiServerForBroadcast?.getPort?.()
+        ?? 0;
 }
```

### 3. `src/standalone/bootstrap.ts` — wire the callback

In the `LocalApiServer` options object (`bootstrap.ts:2337-2522`). The standalone options object has no `on*` callback properties today — add `onPhoneAFriend` as a new property:

```ts
onPhoneAFriend: async (planFile: string, originRole?: string, originTerminal?: string, dispatchId?: string) => {
    // Standalone twin of TaskViewerProvider._dispatchPhoneAFriend. Best-effort:
    // logs and returns on every failure — a throw becomes a 500 and breaks the signal.
    try {
        await dispatchPhoneAFriendStandalone(planFile, originRole || 'coder', originTerminal, dispatchId);
    } catch (err) {
        console.warn('[Phone-a-Friend] standalone dispatch failed:', err);
    }
},
```

and a local helper next to the other fleet helpers:

```ts
const dispatchPhoneAFriendStandalone = async (planFile: string, originRole: string, originTerminal?: string, dispatchId?: string) => {
    const roleConfig: any = taskViewerProvider?.getRoleConfig?.(`roleConfig_${originRole}`);
    const targets = roleConfig?.addons?.phoneAFriendTargets;
    const override = originTerminal ? targets?.[originTerminal] : undefined;
    if (override === null) {
        console.log(`[Phone-a-Friend] origin=${originTerminal || '<unknown>'} target=none (explicit off), dropped.`);
        return;
    }
    const name = (typeof override === 'string' && override.trim())
        || (typeof targets?.['*'] === 'string' && targets['*'].trim())
        || ptyFleetService.listActive().find(t => t.role === 'phone_a_friend')?.friendlyName
        || 'Phone-a-Friend';
    if (originTerminal && name === originTerminal) {
        console.log(`[Phone-a-Friend] target '${name}' is the origin — self-dispatch refused.`);
        return;
    }
    const handle = ptyFleetService.get(name);
    if (!handle || handle.status !== 'active') {
        console.log(`[Phone-a-Friend] target '${name}' is not a live seat — dropped (plan ${planFile}).`);
        return;
    }
    await deliverPrompt(handle, PHONE_A_FRIEND_SECOND_PASS_PROMPT(planFile, originRole, originTerminal, dispatchId), getPromptDeliveryOptions());
};
```

### 4. `src/services/agentPromptBuilder.ts` — export the second-pass prompt text once

The second-pass prompt is currently a literal inside `_dispatchPhoneAFriend` (`TaskViewerProvider.ts:5782`). Both hosts now need it, so lift it beside `PHONE_A_FRIEND_DIRECTIVE` (`agentPromptBuilder.ts:742`):

```ts
export const PHONE_A_FRIEND_SECOND_PASS_PROMPT = (
  planFile: string, originRole: string, originTerminal?: string, dispatchId?: string
) => `Read ${planFile} — this plan was just coded by another agent (origin role: ${originRole}, originTerminal: ${originTerminal || 'unknown'}, dispatch: ${dispatchId || 'none'}). Assume the implementation contains hidden bugs. Check the code against the plan, find and fix any issues you discover. Do NOT append a Stage Complete marker — you are a second-pass continuation, not a stage transition. GIT POLICY: stay on the current branch — do not switch or create branches, do not push to shared branches, and do not force-push. When done, summarize the bugs you found and the fixes you applied.`;
```

Replace the literal in `_dispatchPhoneAFriend` with a call to it — text must stay byte-identical.

## Verification Plan

### Automated Tests

- Unit test: `_dispatchPhoneAFriend` with a mocked `_ptyHostVerb` returning a fleet seat of role `phone_a_friend` — assert `ptySendPrompt` is called with the correct `name`, `data`, and `clearBeforePrompt` config. Verify the vscode fallback is NOT reached when the fleet match succeeds.
- Unit test: `_dispatchPhoneAFriend` with no fleet match and a mocked `_registeredTerminals` entry — assert the vscode path delivers via `sendRobustText`.
- Unit test: `getLocalApiServerPort()` returns the broadcast server's port when `_localApiServer` is null (standalone simulation).
- Unit test: `dispatchPhoneAFriendStandalone` with a mocked `ptyFleetService` — assert target resolution honours per-terminal override → `'*'` default → fleet fallback → literal name, and that self-dispatch is refused.
- Unit test: `PHONE_A_FRIEND_SECOND_PASS_PROMPT` output matches the original literal byte-for-byte (snapshot or string equality).

### Manual Verification

1. **Directive is emitted (extension host).** With Phone-a-Friend ticked for `intern` in the TEAMS/AGENTS tab, move a card to the Intern column and inspect the dispatched prompt: it must contain `PHONE-A-FRIEND:` and a non-zero port.
2. **Endpoint answers, both hosts.**
   ```
   PORT=$(cat .switchboard/api-server-port.txt)
   curl -s -o /dev/stderr -w '%{http_code}\n' -X POST http://127.0.0.1:$PORT/phone-a-friend \
     -H 'Content-Type: application/json' \
     -d '{"planFile":".switchboard/plans/example.md","originRole":"intern","originTerminal":"intern-1","dispatchId":"manual"}'
   ```
   Expect `200` under both the extension host and the npx standalone host. Before the fix, standalone returns `503`.
3. **Fleet seat receives it.** Open a `phone_a_friend` terminal in the Terminals cockpit (it is a selectable role — `visibleAgents.phone_a_friend`), run the curl above, and confirm the second-pass prompt lands in that pane. Before the fix, nothing arrives and the diagnostics channel logs "no terminal running, dropped."
4. **VS Code terminal still receives it.** With no fleet seat of that role and a vscode terminal named `Phone-a-Friend` open, repeat step 2 — the vscode fallback must still deliver.
5. **Self-dispatch still refused.** Send with `originTerminal` equal to the resolved target name; expect a refusal log and no delivery.
6. **Explicit off still honoured.** Set the role's `phoneAFriendTargets[<origin>] = null` and confirm the drop log fires and nothing is delivered.
7. **End-to-end.** With Phone-a-Friend on for `intern` and a live `phone_a_friend` fleet seat, move a card to the Intern column, let the intern finish the batch, and confirm the Phone-a-Friend seat wakes up with the second-pass prompt naming the plan file.
8. **Serialization.** Fire two curls back to back at the same target; the second prompt must land after the first completes, not interleaved with its `/clear`.
