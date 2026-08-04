# PTY Dispatch Raises a Spurious VS Code "Terminal Not Found" Warning: Make the Pre-Dispatch Focus Fleet-Aware

## Goal

Stop a browser-originated dispatch that correctly lands in a PTY terminal from also attempting a VS Code terminal reveal — an attempt that always fails, because the PTY fleet is invisible to VS Code, and which ends in a user-facing warning toast. After this change a PTY dispatch produces exactly one outcome (the prompt in the PTY) and zero VS Code notifications; a VS Code dispatch behaves exactly as it does today.

### Problem

Dispatching a plan from the browser board (either by dragging a card into a coding column, or via the Dispatch/trigger button on a card) delivers the prompt to the target PTY terminal correctly. But if VS Code is running, a warning toast also appears in VS Code, reading as if Switchboard tried to send the same prompt to a VS Code terminal and failed. No prompt text is delivered to any VS Code terminal — the second "delivery" is a *focus* attempt, not a send, and its only artefact is the warning.

The symptom is surface-specific and therefore easy to misread as a routing regression in the PTY/VS Code split. It is not: the routing is correct. The prompt goes exactly where it should. What leaks is a reveal-the-terminal side effect on the dispatch path that predates the PTY fleet and was never taught that a target agent might not be a `vscode.Terminal`.

### Root cause

**The pre-dispatch focus call is not fleet-aware, and the command it invokes warns on a miss.**

`switchboard.focusTerminalByName` (`src/extension.ts:2822-2866`) resolves a terminal by searching, in order:

1. the in-memory `registeredTerminals` map (exact key, then suffixed key, then normalized case-insensitive), and
2. `vscode.window.terminals`, by live name or `creationOptions.name`.

Both are VS Code-only surfaces. PTY terminals are in neither: they live in `PtyFleetService`, which runs **in the pty host child process**, reachable from the extension host only over HTTP (`_ptyHostVerb` → `POST 127.0.0.1:<port>/api/pty/<verb>`, `src/services/TaskViewerProvider.ts:362-395`). This is the same structural gap already documented for `sendToTerminal` (`src/services/TaskViewerProvider.ts:12713-12733`) and for role resolution (`src/services/TaskViewerProvider.ts:8115-8121`). So for a PTY target both lookups miss and the command falls through to its terminal statement:

```ts
// src/extension.ts:2865
vscode.window.showWarningMessage(`Terminal '${terminalName}' not found. It may have been closed.`);
```

> **Superseded:** "PTY terminals live in `PtyFleetService` — they are neither in `registeredTerminals` nor in `vscode.window.terminals`", framed as though `PtyFleetService` were an in-process field the extension host could query.
> **Reason:** Correct about the *gap*, wrong about the *topology*, and the difference decides the shape of the fix. `TaskViewerProvider` has no `_ptyFleetService` field — `src/test/pty-route-surface-contract.test.js:210-229` actively forbids one ("the extension host forwards pty verbs to the child process, never to an in-process fleet", asserting `!/new\s+PtyFleetService\s*\(/` against `TaskViewerProvider.ts`). Every fleet question from the extension host is an **async HTTP round-trip**. A fix written against a synchronous in-process fleet would not compile and would violate a CI-enforced contract.
> **Replaced with:** the root cause stands unchanged — a VS Code-only lookup, reached from a dispatch whose target may be a PTY, that warns on miss. Only the *mechanism available to detect a PTY target* changes: cross-process, async, or via the cached fleet snapshot the host already keeps (`_ptyTerminalNames`, `TaskViewerProvider.ts:533-541`).

Name shape guarantees the miss rather than making it merely likely: `PtyFleetService.create` names terminals `` `${role}-${counter}` `` (`src/standalone/ptyFleetService.ts:73-79`), i.e. `coder-1`, `planner-1`. The command's `normalizeName` maps that to `coder 1`, which matches no VS Code agent terminal name. There is no `PTY_IDE_NAME` suffix on the friendly name to disambiguate on either.

Three dispatch paths call this command unconditionally with the resolved target agent name, before delivery:

| Call site | Reached by |
| :--- | :--- |
| `src/services/TaskViewerProvider.ts:19008` (`_handleTriggerAgentActionInternal`, method opens at `:18842`) | single-card drag **and** the Dispatch/trigger button — both user-reported triggers |
| `src/services/TaskViewerProvider.ts:5264` (`handleKanbanBatchTrigger`, method `:5153`, inside `dispatchToGroup` at `:5231`) | multi-card batch dispatch — one warning **per group** |
| `src/services/TaskViewerProvider.ts:4535` (`dispatchCustomPromptToRole`, method `:4506`) | custom prompt dispatched to a role |

All three are fire-and-forget (`executeCommand` without `await`), so the warning surfaces asynchronously *alongside* a successful dispatch — which is precisely why it reads as a second, failed send rather than as a failed focus.

The `allowPtyFleet` / `apiOriginated` discriminator that governs the actual delivery split (`_attemptDirectTerminalPush`, `src/services/TaskViewerProvider.ts:18685-18739`; the gate is `allowPtyFleet && this._ptyHostPort` at `:18698`) was threaded through resolution and delivery, but the focus side effect sitting between them was missed. The delivery path already resolves the PTY handle correctly; the focus path throws the same name at a VS Code-only lookup.

**Refinement established during the improve pass:** only the first two call sites can actually produce the reported symptom. `dispatchCustomPromptToRole` (`:4535`) resolves its target with `_resolveAgentTerminalForPlan(role, root)` — `allowPtyFleet` defaults to `false` — and dispatches with `_dispatchExecuteMessage(...)` at its default `allowPtyFleet = false`, so it can never target or reach a PTY. It is still in scope, but for the *second* half of the fix (duplicate reporting on a dead VS Code terminal), not the PTY half.

### Context

- The dispatch path already reports its own delivery failures, with better messages, at `src/services/TaskViewerProvider.ts:18635-18637` (`'…' is a browser terminal…` / `Could not deliver prompt to '…'`). A focus miss on that path is therefore never the user's only signal and never actionable on its own — it is duplicate noise even when the target *is* a dead VS Code terminal.
- The warning is correct and wanted for the *explicit* focus surfaces, which must not change: `src/services/kanbanService.ts:141` (the `focusTerminal` verb), `src/services/KanbanProvider.ts:10010`, `src/extension.ts:2890` (`focusAllTerminals`), `src/extension.ts:3305`, and the two guarded sites at `src/services/TaskViewerProvider.ts:12100-12102` and `:19228-19230` (each already gated behind a successful `_focusTerminalByName` probe). There the user asked to reveal a terminal, and "not found" is the answer.
- There is currently **no** way to reveal a PTY tab in the browser Terminals panel: `src/webview/terminals.js` has no focus/reveal frame handler, and `TerminalWsGateway` emits none. Adding one is a genuine improvement but a separate deliverable — see Out of scope.
- `HostCommands.executeCommand(command, ...args)` (`src/services/hostSeams.ts:320-336`) is varargs and dispatches registry-first; `SwitchboardCommandRegistry.execute(command, ...args)` (`src/services/commandRegistry.ts:51-57`) spreads into the handler, and `registerSwitchboardCommand` (`src/extension.ts:54-57`) registers the *same* handler function into both the registry and `vscode.commands`. A second `options` argument therefore reaches the handler identically on both paths, and the handler's return value propagates back through both. Verified, not assumed.

### Assumption — resolved

> **Superseded:** "The user reports that 'the two were decoupled yesterday' and is unsure whether that change has been pushed. This plan is written against the tree at `claude/switchboard-cloud-5gas61` (HEAD `3218126`). Before editing, re-read `src/extension.ts:2818-2861` and the three call sites above: if a decoupling change has landed that already moved or guarded the pre-dispatch focus, reconcile against it rather than reapplying."
> **Reason:** The question has now been answered by reading the tree, so leaving it open as a coder-time instruction wastes a step and invites a second, divergent reconciliation.
> **Replaced with:** **No decoupling landed.** Re-verified on `main` @ `7aebaf5` (which contains `3218126` as an ancestor): all three dispatch-path call sites are still bare, unguarded, fire-and-forget `executeCommand('switchboard.focusTerminalByName', <target>)` calls, and `src/extension.ts:2865` still warns unconditionally on miss. Every line number in this plan was re-read at that commit. `src/extension.ts` and `src/services/TaskViewerProvider.ts` are both clean in the working tree, so a coder starting from `main` will find the code exactly as quoted here.

## Metadata

- **Complexity:** 4
- **Tags:** bugfix, ui, reliability

> **Superseded:** **Complexity:** 3.
> **Reason:** The corrected shape spans three files plus CI wiring (`src/extension.ts`, `src/services/TaskViewerProvider.ts`, a new `src/test/*.test.js`, `package.json`, `.github/workflows/integration-tests.yml`), and the one judgement call — how to detect a PTY target without a cross-process round-trip on the dispatch hot path — is a real design decision rather than a mechanical edit. Still routine, but sitting at the top of routine, not the middle.
> **Replaced with:** **Complexity:** 4 → route to Coder rather than Intern.

## Complexity Audit

### Routine

- One root cause, one behavioural change, three call sites, no data-model or protocol change, no migration (nothing persisted changes shape).
- The command-signature change is backward compatible by construction: `options` is optional, so every untouched caller keeps today's behaviour.
- The two existing tests that pin untouched call sites keep passing without edits (see Edge-Case audit item 5).
- No new dependency, no new IPC verb, no change to the delivery path that actually works today.

### Complex / Risky

- **Cross-process fleet membership is not synchronously knowable.** Any "is this target a PTY?" question from the extension host is either an async HTTP round-trip or a read of a cached snapshot. Choosing wrongly either adds latency to every dispatch or acts on stale data. Settled below: use the cached snapshot, and make the fix correct *without* depending on the predicate being right.
- **Over-reach into the working delivery path.** The tempting DRY move — refactor `_attemptDirectTerminalPush` so the focus guard and the delivery path share one resolver — puts a cosmetic fix's hands on the one code path that currently works. Explicitly rejected below.
- **Scope creep.** Also fixing the missing browser-side reveal, or making `focusTerminalByName` internally PTY-aware, are both wrong for this plan — see Out of scope.

## Edge-Case & Dependency Audit

**Race Conditions**

1. **Stale fleet snapshot.** `_ptyTerminalNames` (`TaskViewerProvider.ts:541`) is refreshed on every `ptyListTerminals` forward and cleared when the pty host dies (`:1862`, `:21361`). A PTY created since the last poll is absent; a PTY that just exited may linger. Both failure directions are benign **because the predicate is only an optimisation** — the `{ silent: true }` flag, not the predicate, is what suppresses the toast. Worst case: a pointless (silent) lookup, or a skipped reveal of a VS Code terminal whose normalized name collides with a dead PTY's.
2. **Fire-and-forget ordering.** The focus call is deliberately not awaited, so it can resolve after delivery starts. That is unchanged and desirable — do **not** convert these three sites to `await`; doing so would put an HTTP-backed command on the critical path of every dispatch.
3. **Batch dispatch multiplies the symptom.** `handleKanbanBatchTrigger` focuses once per group (`:5264`, inside `dispatchToGroup`), so a mixed-feature batch to PTYs produces N toasts today. The fix must be applied inside the per-group body, not once before the loop.

**Security**

- None. No new input surface, no new path segment, no new network listener. Target names are already validated by `_isValidAgentName` before the focus call at all three sites (`:18999-19003`, `:5199`, `:4534`).

**Side Effects**

4. **A dead VS Code target still needs one report, not zero.** Silencing the focus warning must not silence the dispatch failure. `_dispatchExecuteMessage` already warns at `:18635-18637`; verify that path still fires when the VS Code terminal is gone.
5. **Existing tests pin the untouched call sites — do not break them.**
   - `src/test/verb-engine-kanban-headless.test.js:273-280` asserts `deepStrictEqual(recorders.executedCommands, [{ command: 'switchboard.focusTerminalByName', args: ['Lead'] }])` for the `focusTerminal` verb. That is the `kanbanService.ts:141` site, which this plan leaves alone. Adding an options argument *there* would fail this test. It runs in CI (`test:contract:verb-engine-kanban`, `.github/workflows/integration-tests.yml:127`).
   - `src/test/analyst-direct-dispatch-regression.test.js:69-75` pins the `_focusTerminalByName` → fallback shape at `TaskViewerProvider.ts:19228-19231`. Leave that block byte-identical. **Caveat established during the improve pass:** that assertion is *already failing* on `main` and has been since the seam migration — its regex requires `vscode\.commands\.executeCommand\('switchboard\.focusTerminalByName', targetAgent\)`, but `TaskViewerProvider.ts` now contains **zero** `vscode.commands.executeCommand(` calls; the site reads `this._seams().commands.executeCommand(...)`. The file is also not referenced by `package.json` or any CI workflow, i.e. it is an orphan. Do not report "analyst test passes" as evidence for this change; see Verification.
6. **Name collision both ways.** A PTY named `coder-1` and a VS Code terminal that normalizes to `coder 1` can coexist. Under the corrected design a collision can still cause a VS Code terminal to be revealed during a PTY dispatch — exactly as today, no worse — because the guard is advisory. It cannot cause a *toast*, which is the reported bug.
7. **Standalone host is unaffected but must not regress.** `src/standalone/vscodeShim.ts:128` makes `createTerminal` throw and `window.terminals` is `[]`; the standalone dispatch arms are PTY-only and never call this command. Confirm no new import pulls `vscode` into a standalone path — the corrected design adds no import at all.

**Dependencies & Conflicts**

8. **`_ptyHostPort` may be undefined.** The fleet exists only when the pty host child booted (`ptyHostReady()`, `TaskViewerProvider.ts:1896`; capability gating pinned by `src/test/pty-route-surface-contract.test.js:193-207`). The predicate must short-circuit to `false` — never throw — when the port is absent, so a no-PTY install keeps today's behaviour exactly.
9. Files touched: `src/extension.ts`, `src/services/TaskViewerProvider.ts`, new `src/test/pty-dispatch-focus-contract.test.js`, `package.json`, `.github/workflows/integration-tests.yml`. Both source files are clean in the working tree on `main` @ `7aebaf5`.
10. `src/test/pty-route-surface-contract.test.js` runs in CI (`.github/workflows/integration-tests.yml:67`) and asserts the extension host owns no in-process fleet. The corrected design stays inside that contract; the original design would have contradicted it.

## Dependencies

- None — no prior session output is required to execute this plan.

## Adversarial Synthesis

**Risk Summary.** The user-visible defect is a single unconditional `showWarningMessage` reachable from three fire-and-forget dispatch-path focus calls, so the minimal correct fix is an opt-out flag on the command plus three call-site updates — everything beyond that is optional polish. The main risks are architectural rather than behavioural: an in-process PTY resolver would not compile and would violate the CI-enforced "no in-process fleet in the extension host" contract, and refactoring `_attemptDirectTerminalPush` to share a predicate would put a cosmetic fix's hands on the one delivery path that currently works. Mitigations: keep the delivery path untouched, make `{ silent: true }` (not the PTY predicate) the correctness mechanism, implement the predicate as an advisory read of the existing `_ptyTerminalNames` snapshot, and pin all of it with a source-text contract test wired into CI — not just into `package.json`, which is how the analyst regression test rotted unnoticed.

## Proposed Changes

### 1. `src/extension.ts` — let the caller opt out of the miss warning

In the `switchboard.focusTerminalByName` handler (`:2822`):

- Accept a second parameter: `async (terminalName: string, options?: { silent?: boolean })`.
- Return `true` from each of the four success branches and `false` from the fall-through, so callers can react instead of guessing.
- Gate the final toast: `if (!options?.silent) { vscode.window.showWarningMessage(...); }` — then `return false` regardless.

Behaviour with no second argument is unchanged, so every existing caller and both tests in Edge-Case item 5 keep working. Arg and return-value passthrough is verified on both dispatch paths (see Context, final bullet).

### 2. `src/services/TaskViewerProvider.ts` — an advisory PTY predicate, no delivery-path surgery

> **Superseded:** Add a private `_resolveActivePtyHandle(agentName)` helper that reads `this._ptyFleetService.get(agentName) || this._ptyFleetService.listActive().find(...)`, and **rewrite `_attemptDirectTerminalPush`'s PTY branch to call it** so the two cannot diverge.
> **Reason:** Three independent problems. (a) It does not compile: `TaskViewerProvider` has no `_ptyFleetService` — the fleet is in the pty host child process and is reachable only via `_ptyHostVerb('ptyListTerminals')`, an async HTTP call. (b) It contradicts a CI-enforced contract: `src/test/pty-route-surface-contract.test.js:210-229` asserts the extension host never holds an in-process fleet. (c) The drift it prevents is self-inflicted — the duplication only exists because the guard was given its own resolution logic in the first place — and paying for it by rewriting `_attemptDirectTerminalPush` puts the fix's hands on the delivery path that currently works, trading a cosmetic bug for a regression risk in the one thing users depend on. A DRY argument is not worth an outage in dispatch.
> **Replaced with:** leave `_attemptDirectTerminalPush` **byte-identical**. Add a small, clearly-advisory predicate that reads the fleet snapshot the host already maintains, and make the fix's correctness rest on `{ silent: true }` rather than on the predicate being right.

Add next to the other PTY helpers:

```ts
/**
 * Advisory: is a dispatch to `agentName` LIKELY to land in a browser (PTY) terminal
 * rather than a vscode.Terminal? Used only to skip a pointless pre-dispatch reveal —
 * never to route delivery. _attemptDirectTerminalPush remains the sole authority on
 * where a prompt actually goes, and it asks the pty host directly.
 *
 * Reads the `_ptyTerminalNames` snapshot (refreshed on every ptyListTerminals
 * forward) instead of issuing its own round-trip: this sits on the dispatch hot path,
 * the call it guards is fire-and-forget, and a stale answer costs nothing in either
 * direction — a false negative is one silent no-op lookup, a false positive is one
 * un-revealed terminal. The toast itself is suppressed by `silent`, not by this.
 *
 * `allowPtyFleet` mirrors the delivery gate: a caller that cannot deliver to a PTY
 * cannot be targeting one, so it must never skip its reveal.
 */
private _isLikelyPtyDispatchTarget(agentName: string, allowPtyFleet: boolean): boolean {
    if (!allowPtyFleet || !this._ptyHostPort) { return false; }
    const normalized = this._normalizeAgentKey(this._stripIdeSuffix(agentName));
    if (!normalized) { return false; }
    return this._ptyTerminalNames.some(name =>
        this._normalizeAgentKey(this._stripIdeSuffix(name)) === normalized);
}
```

No change to `_attemptDirectTerminalPush`, `_dispatchExecuteMessage`, or `_focusTerminalByName`.

### 3. `src/services/TaskViewerProvider.ts` — guard the three dispatch-path focus calls

Two independent layers, in priority order: **`silent: true` is the fix**; the predicate is a cheap extra that avoids a pointless reveal when we already believe the target is a PTY.

At `:19008` (`_handleTriggerAgentActionInternal`), where `allowPtyFleet` is already in scope from `:18970`:

```ts
// A PTY has no VS Code terminal to reveal; the browser Terminals panel owns its own
// tab focus. `silent` is what fixes the reported bug: a focus miss on the dispatch
// path is never the user's only signal — _dispatchExecuteMessage reports delivery
// failure itself (:18635) — so the "Terminal not found" toast is pure duplicate
// noise here, and next to a dispatch that in fact succeeded it reads as a second,
// failed send. The predicate is advisory: skip the lookup entirely when we already
// believe the target is a browser terminal.
if (!this._isLikelyPtyDispatchTarget(targetAgent, allowPtyFleet)) {
    this._seams().commands.executeCommand('switchboard.focusTerminalByName', targetAgent, { silent: true });
}
```

At `:5264` (inside `dispatchToGroup`), identical but with `group.targetAgent` and the `allowPtyFleet` already resolved in `handleKanbanBatchTrigger` (used at `:5198`, `:5212`, `:5268`). Keep it inside the per-group body so a mixed batch is covered group by group.

At `:4535` (`dispatchCustomPromptToRole`), which has no `allowPtyFleet` and can never reach a PTY, pass the flag only:

```ts
// silent: this path reports its own delivery failure via _dispatchExecuteMessage.
// No PTY predicate — dispatchCustomPromptToRole resolves and delivers with
// allowPtyFleet=false, so its target is always a vscode.Terminal.
this._seams().commands.executeCommand('switchboard.focusTerminalByName', targetAgent, { silent: true });
```

Leave every other `focusTerminalByName` call site untouched.

### 4. `src/test/pty-dispatch-focus-contract.test.js` — new source-text contract

Follow the established pattern (`pty-route-surface-contract.test.js`, `analyst-direct-dispatch-regression.test.js`) — the failure mode is a silent toast, not a thrown error, so pin it structurally:

- Each of the three dispatch-path focus calls passes `{ silent: true }`.
- The two `allowPtyFleet`-bearing sites (`_handleTriggerAgentActionInternal`, `dispatchToGroup`) wrap the call in a `!this._isLikelyPtyDispatchTarget(` guard.
- `_isLikelyPtyDispatchTarget` returns `false` when `!allowPtyFleet || !this._ptyHostPort`, and reads `_ptyTerminalNames` — it must **not** contain `_ptyHostVerb(` (no round-trip on the dispatch hot path) and must **not** reference `_ptyFleetService` (no in-process fleet, reinforcing `pty-route-surface-contract.test.js`).
- `_attemptDirectTerminalPush` is unchanged: it still contains its own `_ptyHostVerb('ptyListTerminals'` resolution and does **not** call `_isLikelyPtyDispatchTarget` — the delivery path stays the single authority, and the advisory predicate must never grow into a router.
- `switchboard.focusTerminalByName` gates its `showWarningMessage` on `!options?.silent` and returns a boolean from every branch.
- The explicit-focus sites (`kanbanService.ts:141`, `KanbanProvider.ts:10010`, `extension.ts` `focusAllTerminals`) pass **no** options object — the warning is intended there.
- Register the test in `package.json` as `test:contract:pty-dispatch-focus`, **and add a run step to `.github/workflows/integration-tests.yml`.** A `package.json` entry alone does not execute in CI — that is exactly how `analyst-direct-dispatch-regression.test.js` drifted into a permanently-red orphan (Edge-Case item 5).

## Out of scope

- **Revealing the PTY tab in the browser Terminals panel.** The right end-state is a `revealTerminal` WS frame from `TerminalWsGateway` that `src/webview/terminals.js` handles by activating that tab, so a browser dispatch focuses the terminal it dispatched to. Neither side exists today; it is a feature, not part of stopping the false warning. File separately.
- **Making `focusTerminalByName` itself PTY-aware.** It is a `vscode.Terminal` reveal command; teaching it about a fleet it cannot show would push the fix into the wrong layer and give it a return value that lies.
- **The `planner`-role resolution gap.**
  > **Superseded:** "`TaskViewerProvider.ts:18763` and `:4330` resolve planner targets via `getRoleTerminalSet` → `_getAliveAutobanTerminalRegistry`, which by its own comment (`:7934-7936`) cannot hold PTY rows — so an api-originated planner dispatch can resolve a VS Code terminal even when a live PTY planner exists."
  > **Reason:** Half of this has already been fixed and the claim as written now overstates the gap. `_resolveAgentTerminalForPlan` (`:8107-8132`) *does* consult the fleet directly for api-originated dispatch, ahead of `_getAgentNameForRole` — the comment the plan cites (now `:8115-8121`) is the explanation of that fix, not of an outstanding hole.
  > **Replaced with:** the gap survives only in the **planner rotation branch**: `_handleTriggerAgentActionInternal:18975-18987` and `dispatchCustomPromptToRole:4514-4524` try `getRoleTerminalSet('planner', …)` first, which reads `_getAliveAutobanTerminalRegistry` (`:5387-5411`, VS Code-only) and returns a VS Code terminal whenever the planner pool is non-empty — the fleet-aware fallback at `:18986` / `:4527` only runs when that pool is empty. Still a real, separate defect on the *routing* side (wrong target, not a spurious toast), still not what was reported here; file it as its own plan.

## Verification Plan

**Manual — the reported bug.** With VS Code running and the browser board open from the in-extension button, a live PTY coder (`coder-1`) and **no** registered VS Code coder terminal:

1. Drag a card into the coder coding column. Expect: prompt appears in `coder-1`; **no** VS Code toast.
2. Press the Dispatch/trigger button on a card. Same expectation.
3. Multi-select two cards spanning two features and batch-dispatch. Expect: each group's PTY receives its prompt; zero toasts (today: one per group).

**Manual — no regression on the VS Code surface.**

4. Register a VS Code coder terminal; drag a card from the **sidebar** board. Expect: that terminal is revealed and receives the prompt, exactly as before.
5. Close that terminal without unregistering it, then drag from the sidebar. Expect: exactly **one** warning — the dispatch-failure message from `_dispatchExecuteMessage` (`:18635-18637`) — and not also "Terminal '…' not found".
6. Click a terminal name in the terminal grid / invoke the `focusTerminal` verb for a name that does not exist. Expect: "Terminal '…' not found. It may have been closed." still shown — the explicit surfaces keep their warning.
7. **No pty host** (installation where the child never booted, `_ptyHostPort` undefined): dispatch from the sidebar to a live VS Code terminal. Expect: revealed and delivered exactly as today — the predicate must short-circuit, not throw.

Reminder: the running extension loads from the installed extension folder, not this repo's `dist/`. Rebuild and sync/reload before trusting any manual result.

### Automated Tests

8. `node src/test/pty-dispatch-focus-contract.test.js` passes, and `npm run test:contract:pty-dispatch-focus` is present in `package.json` **and** invoked by `.github/workflows/integration-tests.yml`.
9. `npm run test:contract:verb-engine-kanban` still passes — its exact-args assertion on the `focusTerminal` verb proves the untouched sites stayed untouched.
10. `npm run test:contract:pty-route-surface` still passes — no routing surface moved, and the extension host still holds no in-process fleet.
11. `src/test/analyst-direct-dispatch-regression.test.js`:
    > **Superseded:** "`src/test/analyst-direct-dispatch-regression.test.js` still passes (the `:19016` block is byte-identical)."
    > **Reason:** It does not pass today, so "still passes" is an unachievable exit criterion that would either block the change or be quietly waived. Its focus-fallback assertion pins `vscode.commands.executeCommand(...)`, a form `TaskViewerProvider.ts` no longer contains anywhere (the site now reads `this._seams().commands.executeCommand(...)`), and the file is wired into neither `package.json` nor CI.
    > **Replaced with:** the requirement is **structural, not green-checkmark**: leave `TaskViewerProvider.ts:19228-19231` byte-identical (verify with `git diff` — that block must not appear). Optionally, and only if the user agrees to the extra scope, repair the stale regex to `this\._seams\(\)\.commands\.executeCommand` and wire the file into `package.json` + CI so it stops rotting. Do **not** cite this file as evidence that the change is safe.
12. `npx tsc --noEmit -p tsconfig.json` clean — the new optional command parameter, its boolean return, and the predicate's signature are the only type-surface changes.

---

**Recommendation: Send to Coder** (Complexity 4).

---

## Completion Summary

Implemented the fleet-aware pre-dispatch focus fix. `switchboard.focusTerminalByName` (`src/extension.ts`) now accepts an optional `{ silent?: boolean }` second argument, returns `true`/`false` from every branch, and gates its `showWarningMessage` on `!options?.silent`; the standalone handler (`src/standalone/bootstrap.ts`) accepts the same arg for signature parity. Added advisory `_isLikelyPtyDispatchTarget` (`src/services/TaskViewerProvider.ts`) — a snapshot read of `_ptyTerminalNames` (no `_ptyHostVerb` round-trip, no in-process fleet) that short-circuits to `false` when `!allowPtyFleet || !this._ptyHostPort` — and guarded the two `allowPtyFleet`-bearing dispatch-path focus calls (`_handleTriggerAgentActionInternal`, `dispatchToGroup` inside `handleKanbanBatchTrigger`) with it; the third (`dispatchCustomPromptToRole`, allowPtyFleet=false always) passes `{ silent: true }` only. `_attemptDirectTerminalPush` and the two `_focusTerminalByName` fallback sites left byte-identical. Added `src/test/pty-dispatch-focus-contract.test.js` (11 source-text assertions, all passing), wired as `test:contract:pty-dispatch-focus` in `package.json` and as a CI step in `.github/workflows/integration-tests.yml`. Verified: new contract test passes, `test:contract:verb-engine-kanban` and `test:contract:pty-route-surface` still pass, `tsc --noEmit` shows only pre-existing unrelated import-extension errors. No issues encountered.
