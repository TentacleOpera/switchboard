# PTY Dispatch Raises a Spurious VS Code "Terminal Not Found" Warning: Make the Pre-Dispatch Focus Fleet-Aware

## Goal

Stop a browser-originated dispatch that correctly lands in a PTY terminal from also attempting a VS Code terminal reveal — an attempt that always fails, because the PTY fleet is invisible to VS Code, and which ends in a user-facing warning toast. After this change a PTY dispatch produces exactly one outcome (the prompt in the PTY) and zero VS Code notifications; a VS Code dispatch behaves exactly as it does today.

### Problem

Dispatching a plan from the browser board (either by dragging a card into a coding column, or via the Dispatch/trigger button on a card) delivers the prompt to the target PTY terminal correctly. But if VS Code is running, a warning toast also appears in VS Code, reading as if Switchboard tried to send the same prompt to a VS Code terminal and failed. No prompt text is delivered to any VS Code terminal — the second "delivery" is a *focus* attempt, not a send, and its only artefact is the warning.

The symptom is surface-specific and therefore easy to misread as a routing regression in the PTY/VS Code split. It is not: the routing is correct. The prompt goes exactly where it should. What leaks is a reveal-the-terminal side effect on the dispatch path that predates the PTY fleet and was never taught that a target agent might not be a `vscode.Terminal`.

### Root cause

**The pre-dispatch focus call is not fleet-aware, and the command it invokes warns on a miss.**

`switchboard.focusTerminalByName` (`src/extension.ts:2818-2861`) resolves a terminal by searching, in order:

1. the in-memory `registeredTerminals` map (exact key, then suffixed key, then normalized case-insensitive), and
2. `vscode.window.terminals`, by live name or `creationOptions.name`.

Both are VS Code-only surfaces. PTY terminals live in `PtyFleetService` — they are neither in `registeredTerminals` nor in `vscode.window.terminals` (this is the same structural gap already documented at `src/services/TaskViewerProvider.ts:12525-12529` for `sendToTerminal`, and at `:7932-7936` for role resolution). So for a PTY target both lookups miss and the command falls through to its terminal statement:

```ts
// src/extension.ts:2860
vscode.window.showWarningMessage(`Terminal '${terminalName}' not found. It may have been closed.`);
```

Name shape guarantees the miss rather than making it merely likely: `PtyFleetService.create` names terminals `` `${role}-${counter}` `` (`src/standalone/ptyFleetService.ts:73-79`), i.e. `coder-1`, `planner-1`. The command's `normalizeName` maps that to `coder 1`, which matches no VS Code agent terminal name. There is no `PTY_IDE_NAME` suffix on the friendly name to disambiguate on either.

Three dispatch paths call this command unconditionally with the resolved target agent name, before delivery:

| Call site | Reached by |
| :--- | :--- |
| `src/services/TaskViewerProvider.ts:18796` (`_handleTriggerAgentActionInternal`) | single-card drag **and** the Dispatch/trigger button — both user-reported triggers |
| `src/services/TaskViewerProvider.ts:5079` (`handleKanbanBatchTrigger`) | multi-card batch dispatch — one warning **per group** |
| `src/services/TaskViewerProvider.ts:4350` (`dispatchCustomPromptToRole`) | custom prompt dispatched to a role |

All three are fire-and-forget (`executeCommand` without `await`), so the warning surfaces asynchronously *alongside* a successful dispatch — which is precisely why it reads as a second, failed send rather than as a failed focus.

The `allowPtyFleet` / `apiOriginated` discriminator that governs the actual delivery split (`_attemptDirectTerminalPush`, `src/services/TaskViewerProvider.ts:18485-18527`) was threaded through resolution and delivery, but the focus side effect sitting between them was missed. The delivery path already resolves the PTY handle correctly; the focus path throws the same name at a VS Code-only lookup.

### Context

- The dispatch path already reports its own delivery failures, with better messages, at `src/services/TaskViewerProvider.ts:18435-18437` (`'…' is a browser terminal…` / `Could not deliver prompt to '…'`). A focus miss on that path is therefore never the user's only signal and never actionable on its own — it is duplicate noise even when the target *is* a dead VS Code terminal.
- The warning is correct and wanted for the *explicit* focus surfaces, which must not change: `src/services/kanbanService.ts:141` (the `focusTerminal` verb), `src/services/KanbanProvider.ts:10004`, `src/extension.ts:2886` (`focusAllTerminals`), `src/extension.ts:3301`, and the two guarded sites at `src/services/TaskViewerProvider.ts:11914` and `:19018` (each already gated behind a successful `_focusTerminalByName` probe). There the user asked to reveal a terminal, and "not found" is the answer.
- There is currently **no** way to reveal a PTY tab in the browser Terminals panel: `src/webview/terminals.js` has no focus/reveal frame handler, and `TerminalWsGateway` emits none. Adding one is a genuine improvement but a separate deliverable — see Out of scope.

### Assumption to confirm before coding

The user reports that "the two were decoupled yesterday" and is unsure whether that change has been pushed. This plan is written against the tree at `claude/switchboard-cloud-5gas61` (HEAD `3218126`). Before editing, re-read `src/extension.ts:2818-2861` and the three call sites above: if a decoupling change has landed that already moved or guarded the pre-dispatch focus, reconcile against it rather than reapplying. The root cause (VS Code-only lookup + warn-on-miss reached from a PTY dispatch) is what must be gone; the exact line numbers may have shifted.

## Metadata

- **Complexity:** 3
- **Tags:** bugfix, ui, reliability

## Complexity Audit

**Routine.** One root cause, one behavioural change, three call sites, no data model or protocol change, no migration (nothing persisted changes shape). The only judgement calls are (a) where to put the PTY predicate so it cannot drift from the delivery path, and (b) which focus call sites keep their warning — both settled above.

The risk is not in the edit but in over-reaching: it is tempting to also fix the missing browser-side reveal, or to make `focusTerminalByName` PTY-aware internally. Both are wrong for this plan — see Out of scope.

## Edge-Case & Dependency Audit

1. **Predicate drift.** A second, hand-copied PTY-lookup in the focus guard will eventually disagree with the one in `_attemptDirectTerminalPush` (they already differ subtly: `get(name)` does not filter by status, `listActive()` does). Mitigation: extract one private resolver and have **both** the delivery path and the focus guard call it. Do not duplicate the predicate.
2. **`_ptyFleetService` may be undefined.** The fleet is only constructed when `ptyHostReady()` (see `pty-route-surface-contract.test.js`, "gates capabilities on the constructed fleet"). The resolver must return `undefined` — not throw — when the service is absent, so a no-PTY install keeps today's behaviour exactly.
3. **A dead VS Code target still needs one report, not zero.** Silencing the focus warning must not silence the dispatch failure. `_dispatchExecuteMessage` already warns at `:18435`; verify that path still fires when the VS Code terminal is gone.
4. **`registerSwitchboardCommand` arg passthrough.** `HostCommands.executeCommand(command, ...args)` (`src/services/hostSeams.ts:320-336`) is varargs and forwards to the registry, so a second `options` argument reaches the handler in both the registry and `vscode.commands` paths. Confirm the registry's `execute` signature is varargs too before relying on it.
5. **Existing tests pin the untouched call sites — do not break them.**
   - `src/test/verb-engine-kanban-headless.test.js:277-279` asserts `deepStrictEqual(executedCommands, [{ command: 'switchboard.focusTerminalByName', args: ['Lead'] }])` for the `focusTerminal` verb. That is the `kanbanService.ts:141` site, which this plan leaves alone. Adding an options argument *there* would fail this test.
   - `src/test/analyst-direct-dispatch-regression.test.js:71` pins the exact `_focusTerminalByName` → fallback shape at `TaskViewerProvider.ts:19016-19019`. Leave that block byte-identical.
6. **Batch dispatch multiplies the symptom.** `handleKanbanBatchTrigger` focuses once per group, so a mixed-feature batch to PTYs produces N toasts today. The fix must be applied inside the per-group loop, not once before it.
7. **Name collision both ways.** A PTY named `coder-1` and a VS Code terminal that normalizes to `coder 1` can coexist. The guard must key on "is the *resolved dispatch target* a live PTY", using the same handle the delivery path will use — not on "does a PTY with a similar name exist".
8. **Standalone host is unaffected but must not regress.** `src/standalone/vscodeShim.ts:128` makes `createTerminal` throw and `window.terminals` is `[]`; the standalone dispatch arms (`src/standalone/bootstrap.ts:1027`, `:1106`) are PTY-only and never call this command. Confirm no new import pulls `vscode` into a standalone path.

## Proposed Changes

### 1. `src/extension.ts` — let the caller opt out of the miss warning

In the `switchboard.focusTerminalByName` handler (`:2818`):

- Accept a second parameter: `async (terminalName: string, options?: { silent?: boolean })`.
- Return `true` from each of the four success branches and `false` from the fall-through, so callers can react instead of guessing.
- Gate the final toast: `if (!options?.silent) { vscode.window.showWarningMessage(...); }`.

Behaviour with no second argument is unchanged, so every existing caller and the two tests above keep working.

### 2. `src/services/TaskViewerProvider.ts` — one shared PTY resolver

Add a private helper next to `_attemptDirectTerminalPush`, lifting the predicate that already lives at `:18500-18503`:

```ts
/**
 * Resolve the live PTY handle a dispatch to `agentName` would land in, or
 * undefined. Single source of truth for "is this target a PTY?" — the
 * delivery path (_attemptDirectTerminalPush) and the pre-dispatch focus
 * guard must agree, or one will act on a fleet the other ignored.
 */
private _resolveActivePtyHandle(agentName: string) {
    if (!this._ptyFleetService) { return undefined; }
    const normalized = this._normalizeAgentKey(this._stripIdeSuffix(agentName));
    const handle = this._ptyFleetService.get(agentName)
        || this._ptyFleetService.listActive().find(t =>
            this._normalizeAgentKey(this._stripIdeSuffix(t.friendlyName)) === normalized);
    return handle && handle.status === 'active' ? handle : undefined;
}
```

Then **rewrite `_attemptDirectTerminalPush`'s PTY branch (`:18498-18503`) to call it**, so the two cannot diverge. The `allowPtyFleet` gate stays on the delivery side — the resolver answers "is this a PTY", the caller decides whether it is allowed to use one.

### 3. `src/services/TaskViewerProvider.ts` — guard the three dispatch-path focus calls

At each of `:18796`, `:5079` (inside the per-group `dispatchToGroup` body), and `:4350`, replace the bare call with:

```ts
// A PTY has no VS Code terminal to reveal; the browser Terminals panel owns
// its own tab focus. Calling through would always miss and pop a misleading
// "Terminal not found" toast next to a dispatch that in fact succeeded.
// `silent` covers the VS Code case too: a focus miss here is never the only
// signal — _dispatchExecuteMessage reports delivery failure itself.
if (!this._resolveActivePtyHandle(targetAgent)) {
    this._seams().commands.executeCommand('switchboard.focusTerminalByName', targetAgent, { silent: true });
}
```

(using `group.targetAgent` at `:5079`). Two independent layers: PTY targets skip the call entirely; VS Code targets still get focused but no longer double-report a miss.

Leave every other `focusTerminalByName` call site untouched.

### 4. `src/test/pty-dispatch-focus-contract.test.js` — new source-text contract

Follow the established pattern (`pty-route-surface-contract.test.js`, `analyst-direct-dispatch-regression.test.js`) — the failure mode is a silent toast, not a thrown error, so pin it structurally:

- Each of the three dispatch-path focus calls is wrapped in a `!this._resolveActivePtyHandle(...)` guard and passes `{ silent: true }`.
- `_attemptDirectTerminalPush` resolves its PTY handle via `_resolveActivePtyHandle` and contains no second inline `listActive().find(` predicate (drift guard).
- `switchboard.focusTerminalByName` gates its `showWarningMessage` on `!options?.silent`.
- The explicit-focus sites (`kanbanService.ts:141`, `KanbanProvider.ts:10004`, `extension.ts` `focusAllTerminals`) pass **no** options object — the warning is intended there.
- Register the test in `package.json` alongside the other `test:contract:*` scripts.

## Out of scope

- **Revealing the PTY tab in the browser Terminals panel.** The right end-state is a `revealTerminal` WS frame from `TerminalWsGateway` that `src/webview/terminals.js` handles by activating that tab, so a browser dispatch focuses the terminal it dispatched to. Neither side exists today; it is a feature, not part of stopping the false warning. File separately.
- **Making `focusTerminalByName` itself PTY-aware.** It is a `vscode.Terminal` reveal command; teaching it about a fleet it cannot show would push the fix into the wrong layer and give it a return value that lies.
- **The `planner`-role resolution gap.** `TaskViewerProvider.ts:18763` and `:4330` resolve planner targets via `getRoleTerminalSet` → `_getAliveAutobanTerminalRegistry`, which by its own comment (`:7934-7936`) cannot hold PTY rows — so an api-originated planner dispatch can resolve a VS Code terminal even when a live PTY planner exists. That is a real, separate defect on the *routing* side (wrong target, not a spurious toast). It is not what was reported here; file it as its own plan.

## Verification Plan

**Manual — the reported bug.** With VS Code running and the browser board open from the in-extension button, a live PTY coder (`coder-1`) and **no** registered VS Code coder terminal:
1. Drag a card into the coder coding column. Expect: prompt appears in `coder-1`; **no** VS Code toast.
2. Press the Dispatch/trigger button on a card. Same expectation.
3. Multi-select two cards spanning two features and batch-dispatch. Expect: each group's PTY receives its prompt; zero toasts (today: one per group).

**Manual — no regression on the VS Code surface.**
4. Register a VS Code coder terminal; drag a card from the **sidebar** board. Expect: that terminal is revealed and receives the prompt, exactly as before.
5. Close that terminal without unregistering it, then drag from the sidebar. Expect: exactly **one** warning — the dispatch-failure message from `_dispatchExecuteMessage` (`:18435-18437`) — and not also "Terminal '…' not found".
6. Click a terminal name in the terminal grid / invoke the `focusTerminal` verb for a name that does not exist. Expect: "Terminal '…' not found. It may have been closed." still shown — the explicit surfaces keep their warning.

**Automated.**
7. `node src/test/pty-dispatch-focus-contract.test.js` passes.
8. `src/test/verb-engine-kanban-headless.test.js` still passes (its exact-args assertion on the `focusTerminal` verb proves the untouched sites stayed untouched).
9. `src/test/analyst-direct-dispatch-regression.test.js` still passes (the `:19016` block is byte-identical).
10. `src/test/pty-route-surface-contract.test.js` still passes (no routing surface moved).
11. `npx tsc --noEmit -p tsconfig.json` clean — the new optional command parameter and the resolver's return type are the only type-surface changes.
