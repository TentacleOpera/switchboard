# Dispatch Surface Must Be Request Context, Not a Threaded Flag

## Metadata

**Complexity:** 6
**Tags:** bugfix, refactor, backend, reliability, infrastructure
**Project:** Browser Switchboard

## Goal

Make "which terminals can this caller actually see?" a fact derived **once** at the HTTP boundary and read at the point of delivery, instead of a boolean hand-forwarded through every layer of every dispatch chain. Today that boolean (`allowPtyFleet` / `apiOriginated`) is threaded by convention across 92 sites in four provider files, defaults to the wrong value for browser callers, and fails **silently and positively** — a dropped flag delivers the prompt to a `vscode.Terminal` the browser cannot render and returns `true`.

### Problem analysis and root cause

**Observed symptom (2026-08-07).** In the browser cockpit served by the extension host (`http://switchboard.localhost:62210/#board`): drag-and-drop on the board dispatches correctly to the PTY fleet; the send-to-terminal **buttons on the same page** do nothing visible. Copy-prompt buttons work. The terminals-pane drag works.

**It is not the transport.** Both the drag and the buttons call `postKanbanMessage` → `transport.js` → `POST /kanban/verb/<verb>`. Same page, same `data-panel`, same `routePrefix` (`transport.js:26`), same shim. Verified live: `/kanban/verb/*` reaches the provider, the PTY fleet is healthy (`ptyListTerminals` returns 4 active role-matched terminals on the correct `parentRoot`), and a direct `POST /taskViewer/verb/sendAnalystMessage` **did** deliver into `analyst-1`.

**It is the delivery chain.** The transport carries only a verb name. That name selects a different arm, and the arms reach the one delivery primitive by different routes:

```
drag:   triggerAction → dispatchConfiguredKanbanColumnAction → _handleTriggerAgentAction → … → _dispatchExecuteMessage
button: sendDispatchToCoder → dispatchCustomPromptToRole ──────────────────────────────────→ _dispatchExecuteMessage
```

Both terminate at `TaskViewerProvider._dispatchExecuteMessage` (`src/services/TaskViewerProvider.ts:18953`):

```typescript
private async _dispatchExecuteMessage(
    workspaceRoot: string,
    targetAgent: string,
    payload: string,
    metadata: Record<string, any>,
    sender: string = 'sidebar',
    allowPtyFleet: boolean = false      // ← the surface decision
): Promise<boolean> {
```

The surface decision is the **sixth positional parameter, defaulting to `false`**. Every wrapper in every chain must remember to forward it. Miss it at any hop and `_attemptDirectTerminalPush` resolves a `vscode.Terminal`, delivers successfully, and returns `true` — no error, no log, no UI signal. The prompt lands in a terminal the browser tab cannot display.

**Why drag works and buttons do not, exactly.** At `HEAD` — the commit state a VSIX is built from — the two chains differ in whether the parameter exists at all:

| | `HEAD` (installed build) | Working tree (uncommitted) |
|---|---|---|
| `dispatchConfiguredKanbanColumnAction` | forwards `apiOriginated` (`TaskViewerProvider.ts:4880`) | same |
| `dispatchCustomPromptToRole` | `(role, prompt, workspaceRoot)` — **parameter absent** | `(role, prompt, workspaceRoot, options?: { apiOriginated?: boolean })` |

`_tryFleetDeliveryForRole` and the pair-programming path landed 2026-08-05 (`47dd90f2`, `1c7de0f6`). The `dispatchCustomPromptToRole` threading — described in `browser-send-to-terminal-dispatch-parity` as *"the highest-traffic single method in the feature: seven user-facing buttons funnel through it"* — is still uncommitted. So the shipped build has the drag chain surface-aware and the button chain structurally unable to be.

**Why the terminals-pane drag is immune.** `src/webview/terminals.js:2056-2098` does not use the dispatcher at all. It issues two explicit `fetch` calls — `/kanban/verb/promptSelected` to read the prompt out of the response body, then `/terminals/verb/ptySendPrompt` with an explicit `name` — so there is no role resolution and therefore no surface decision to get wrong. It is the only browser path that never asks the question.

**The root cause is the shape, not the missing argument.** Threading the flag through the button chain fixes today's symptom and preserves the mechanism that produced it. `apiOriginated` currently appears 51× in `TaskViewerProvider.ts`, 18× in `KanbanProvider.ts`, 18× in `PlanningPanelProvider.ts`, 5× in `LocalApiServer.ts` — 92 hand-written forwards, each an independent opportunity to silently break the browser, none of them checkable.

And the information is already correct at the boundary: `LocalApiServer._stampHttpSurface` sets `apiOriginated` on the request for the kanban, planning, tickets and taskViewer rails (design/setup were added by the same feature). The system derives the right answer once, at the only place that can know it — then discards the scope and makes every downstream layer re-carry it as data.

**Nothing guards it.** `parity:check` compares allowlists to catalogs. `push-routing:check` counts raw `postMessage`. `verb-returns:check` counts `break` statements. None can observe a dispatch that succeeded into the wrong terminal, because at the type level and the test level it is indistinguishable from success.

## User Review Required

None.

## Complexity Audit

### Routine
- Deleting the `allowPtyFleet` parameter from one function and its call sites.
- Removing the `options?: { apiOriginated?: boolean }` forwarding from intermediate wrappers.

### Complex / Risky
- **No `AsyncLocalStorage` precedent in this codebase.** `grep` finds no `async_hooks` usage anywhere in `src/`. This introduces an ambient-context mechanism where none exists, so the module must be small, single-purpose and explicitly documented, or it becomes a second confusing way to pass data.
- **Timer-originated dispatches have no request to inherit from.** The orchestrator wake fires from a timer, which is exactly why `_orchestratorApiOriginated` exists as remembered run-state (`TaskViewerProvider.ts:9466`, `:11026`). Ambient context cannot cover these. They need an explicit, **named and enumerated** `runWithSurface(...)` wrapper at the point the background work is scheduled — not a silent default. Getting this wrong replaces a visible threaded flag with an invisible missing scope, which is worse.
- **The pair-programming path crosses a command boundary.** `KanbanProvider._dispatchWithPairProgrammingIfNeeded` delivers via `this._seams().commands.executeCommand('switchboard.dispatchToCoderTerminal', …)`. Whether ambient context survives that hop depends on the command registry being a synchronous in-process call rather than anything that defers across the event loop into a fresh context. This must be **proven**, not assumed — see Uncertain Assumptions.
- **The editor path must stay byte-identical.** ~4,000 installs. A webview-originated dispatch runs with no ambient scope, so `currentSurface()` must resolve to `editor` and select a `vscode.Terminal` exactly as today. Fail-closed remains the default; only the *carrier* changes.
- **Two entry points remain by design.** `dispatchConfiguredKanbanColumnAction` (config-driven: drag-drop mode, trigger prompt, planner rotation, terminal override) and `dispatchCustomPromptToRole` (ready-made prompt → role) do genuinely different resolution work and must not be merged. This plan unifies *the surface decision*, not the entry points. A reviewer proposing to collapse them has misread the defect.

## Edge-Case & Dependency Audit

**Race Conditions**
- Concurrent HTTP dispatches from different surfaces must not read each other's context. `AsyncLocalStorage` is per-async-execution-context, so this is safe by construction — but assert it with a test that interleaves an editor-originated and an HTTP-originated dispatch and checks each resolves its own surface.
- A dispatch that outlives its request (fire-and-forget `void` continuation after the HTTP response is sent) still holds its context in `AsyncLocalStorage`, since the context follows the async chain rather than the response lifecycle. Verify rather than assume for any `void`-returning dispatch path.

**Security** — no new endpoint, no new verb, no allowlist change. Surface is a routing hint, not an authorization decision; it must not be used to gate anything privileged.

**Side Effects**
- Buttons that currently deliver to an invisible VS Code terminal will start delivering to the browser's PTY fleet. That is the fix, and it is a visible behaviour change for anyone who had adapted to reading the VS Code terminal.
- Deleting 92 `apiOriginated` forwards touches four large provider files. Each deletion is mechanical, but the diff is broad — review by grepping for residual references rather than by reading the whole diff.

**Dependencies & Conflicts**
- Supersedes the uncommitted `dispatchCustomPromptToRole` threading in the working tree. Do not commit that as the durable fix; keep it as the **reference list** of which paths need coverage, then delete it as part of this change.
- One agent stream per provider file (project PRD orchestration discipline). This plan touches `TaskViewerProvider.ts`, `KanbanProvider.ts`, `PlanningPanelProvider.ts` and `LocalApiServer.ts`, so it must not run in parallel with other work in those files.

## Dependencies

None (hard).

**Unblocking note:** the working-tree threading already fixes the observed symptom. Committing it and rebuilding/reinstalling the VSIX restores the buttons immediately. That is the right short-term move; this plan is the durable one. Sequence them — do not block a broken button on a refactor.

## Adversarial Synthesis

**Risk Summary.** The chief risk is trading a visible, greppable threaded flag for an invisible missing scope: any dispatch that begins outside a request (orchestrator wake, scheduler, autoban) has no ambient context, and if the fallback is silent the failure mode becomes harder to find than the one being fixed. Mitigations: enumerate every background-originated dispatch explicitly with a named `runWithSurface(...)` wrapper, make `currentSurface()` distinguish "explicitly editor" from "never established", and add a CI guard that fails on any reintroduction of a surface parameter. Secondary risk is the `executeCommand` boundary in the pair-programming path, which must be proven to preserve context before the threaded flag is deleted from it.

## Proposed Changes

### `src/services/dispatchSurface.ts` (new)
- **Context:** Single-purpose ambient context for the dispatch surface. No other use.
- **Logic:** Wrap `AsyncLocalStorage<{ surface: 'api' | 'editor' }>`. Export `runWithSurface(surface, fn)` and `currentSurface()`. `currentSurface()` returns `'editor'` when no scope is established, preserving today's fail-closed default.
- **Edge Cases:** Keep it ~30 lines. Do not let it accumulate unrelated request data — a general-purpose request context is a different, larger decision.

### `src/services/LocalApiServer.ts`
- **Logic:** Where `_stampHttpSurface` currently annotates the payload, additionally (and ultimately instead) execute the verb dispatch inside `runWithSurface('api', …)` so the whole handler chain inherits it. Applies to all rails uniformly — including `_handleDesignVerb` and `_handleSetupVerb`, which historically did not stamp.
- **Edge Cases:** The scope must wrap the **await** of the verb handler, not just its synchronous invocation.

### `src/services/TaskViewerProvider.ts`
- **Logic:** `_dispatchExecuteMessage` and `_attemptDirectTerminalPush` drop the `allowPtyFleet` parameter and call `currentSurface()` directly. `_resolveAgentTerminalForPlan`, `_getAgentNameForRole` and `_isLikelyPtyDispatchTarget` do the same. Remove the now-dead `options?: { apiOriginated?: boolean }` from `dispatchCustomPromptToRole`, `dispatchConfiguredKanbanColumnAction`, `_handleTriggerAgentAction` and every intermediate wrapper.
- **Edge Cases:** `_orchestratorApiOriginated` is replaced by wrapping the orchestrator kickoff *and* wake in `runWithSurface('api', …)` at the scheduling site. Enumerate every such background entry point; do not leave one relying on an absent scope.

### `src/services/KanbanProvider.ts` / `src/services/PlanningPanelProvider.ts`
- **Logic:** Delete `apiOriginated` forwarding (18 sites each). Arms stop reading `msg.apiOriginated` for dispatch purposes.
- **Edge Cases:** `_dispatchWithPairProgrammingIfNeeded` delivers via `executeCommand('switchboard.dispatchToCoderTerminal', …)`; only remove its explicit flag once context propagation across that hop is proven.

### `scripts/check-dispatch-surface.js` (new) + `package.json` + `.github/workflows/integration-tests.yml`
- **Logic:** AST guard, in the shape of `check-push-routing.js`. Fails if (a) any function in the dispatch chain declares a parameter named `allowPtyFleet` / `apiOriginated`, or (b) `_dispatchExecuteMessage` / `_attemptDirectTerminalPush` is reachable from a background entry point not present in a reviewed, reason-carrying allowlist of `runWithSurface` wrap sites.
- **Edge Cases:** Must fail on the current tree before the refactor lands — a guard that passes on known-broken code is worthless. Declare `typescript` in `devDependencies`; it currently resolves only as a transitive hoist.

## Verification Plan

Compilation and automated test execution are out of scope for this planning session; the checks below are specified for the implementing change.

### Automated
1. HTTP-originated dispatch resolves a PTY fleet terminal; webview-originated dispatch (no scope) resolves a `vscode.Terminal`. Same code path, different context.
2. Interleaved concurrent dispatches from both surfaces each resolve their own surface — no cross-contamination.
3. A dispatch continuation that runs after the HTTP response has been sent still resolves `'api'`.
4. Orchestrator wake (timer-fired, no request) resolves `'api'` via its explicit wrapper.
5. Pair-programming dispatch through `executeCommand('switchboard.dispatchToCoderTerminal')` preserves surface across the command hop.
6. Guard: `check-dispatch-surface.js` fails on the pre-refactor tree and passes after.
7. Grep assertion: zero residual `allowPtyFleet` parameters; `apiOriginated` survives only at the boundary and in the enumerated background wrappers.

### Manual (browser cockpit, extension host)
1. **The reported bug.** On `/#board`, click each send-to-terminal button — the prompt appears in the browser's PTY terminal for that role, not in a VS Code terminal.
2. **Drag unchanged.** Board drag-drop still dispatches correctly (this is the path that works today; it must not regress).
3. **Copy-prompt unchanged.** Clipboard buttons still work.
4. **Terminals-pane drag unchanged.** Still delivers — it bypasses the dispatcher and must be unaffected.
5. **Orchestrator.** Start the orchestrator from the browser; confirm kickoff *and* a subsequent timer-fired wake both deliver to fleet terminals.
6. **Airlock / pair programming / Send to Planner** each deliver to the browser fleet.
7. **Editor host regression.** Repeat every dispatch path inside VS Code; all must deliver to VS Code terminals exactly as before.
8. **PTY-less install.** With `node-pty` unavailable, every path degrades to today's VS Code-only behaviour with no dead clicks.

## Uncertain Assumptions

The user was advised to run web research to confirm these before implementation:

- Whether `AsyncLocalStorage` context reliably propagates across the VS Code extension host's command-invocation boundary (`executeCommand`), and whether the extension host's activation/event model introduces any context-resetting hop.
- Whether `AsyncLocalStorage` context survives a `void`-continuation that outlives the HTTP response, and the current performance characteristics of `AsyncLocalStorage` on the Node version the extension host ships.
- Whether any bundling step (webpack) affects `node:async_hooks` resolution in a VSIX that ships no `node_modules`.

## Recommendation

Complexity 6 → **Send to Lead Coder.** The change is mostly deletion, but it introduces an ambient-context mechanism with no precedent in this codebase, must prove context survives a command boundary, must enumerate every background dispatch that has no request to inherit from, and must keep the editor path byte-identical for ~4,000 installs.
