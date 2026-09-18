# Standalone: bridge `switchboard.*` command dispatch instead of swallowing it

## Goal

Give the headless host a real command registry so the ~166 `executeCommand('switchboard.*')` calls
inside the shared providers do something in standalone — starting with `switchboard.refreshUI`, whose
43 call sites are the reason a successful DB mutation can leave the browser showing stale cards.

> **Superseded (title and target):** "bridge `vscode.commands.executeCommand` instead of swallowing
> it" — fix `src/standalone/vscodeShim.ts:228-231` by replacing its two stubs with a `Map`-backed
> registry.
> **Reason:** Measured wrong. Of the 171 `executeCommand` call sites across the five providers
> standalone wires, **164 already route through the host seam** (`this._seams().commands.executeCommand(...)`)
> and only **7** are raw `vscode.commands.executeCommand` — all 7 in `KanbanProvider`. Of the 43
> `switchboard.refreshUI` sites, 41 are seam-routed and 2 are raw. So `vscodeShim.ts:229` is **not**
> the dead end for the headline sites; `src/standalone/hostServices.ts:354-356` is:
> `commands: { executeCommand: async () => undefined }`. Fixing the shim would have bridged 7 of 171
> sites and left the reported symptom fully intact — while the plan's own verification ("assert one
> board push is emitted") would have passed against a stubbed broadcaster, hiding the miss.
> **Replaced with:** implement the **headless `commands` seam** registry-first over the registry the
> codebase already has (`src/services/commandRegistry.ts`), populated by `bootstrap.ts`. The shim's
> `executeCommand` consults the same registry as a secondary consumer (or the 7 raw KanbanProvider
> sites are converted to `_seams()`, which PRD contract #3 wants regardless). One registry, two
> consumers.

### Root problem / background (verified 2026-08-04; re-measured against source 2026-08-04)

**The dead end, measured.** Receivers of `.executeCommand` across
`TaskViewerProvider`, `KanbanProvider`, `PlanningPanelProvider`, `SetupPanelProvider`,
`TicketsPanelProvider`:

| Receiver | Sites | Where it dead-ends in standalone |
| :--- | :--- | :--- |
| `this._seams().commands.executeCommand` | 164 | `hostServices.ts:354-356` — `executeCommand: async () => undefined` |
| `vscode.commands.executeCommand` | 7 (all `KanbanProvider`) | `vscodeShim.ts:229` — `async function executeCommand() { return undefined; }` |
| `this._ctx.seams.commands.executeCommand` | 2 (`kanbanService.ts:119`, `:141`) | same headless seam as row 1 |

Per provider (seam-routed / raw): `TaskViewerProvider` 40/0, `KanbanProvider` 46/7,
`PlanningPanelProvider` 16/0, `SetupPanelProvider` 31/0, `TicketsPanelProvider` 31/0.

Both dead ends return `undefined` silently, and `bootstrap.ts` registers **nothing** — a grep for
`registerCommand|executeCommand` in bootstrap returns no hits. So every provider code path whose
effect is "run a command" silently succeeds and does nothing.

**The mechanism to use already exists.** `src/services/commandRegistry.ts` defines
`SwitchboardCommandRegistry` (`register` / `unregister` / `has` / `execute` / `registeredCommands`)
and exports a `switchboardCommandRegistry` singleton. Its file header states the intent verbatim:

```
 *  - Seam-routed arms dispatch through `HostCommands` (hostSeams.ts), whose
 *    vscode impl is registry-first: a registered command executes directly,
 *    in-process, with no vscode dependency on the dispatch path. ...
 *  - B1's headless composition root registers headless handlers into its own
 *    registry (or this one) — same contract, no vscode.
```

B1 *is* `src/standalone/bootstrap.ts`. And `VscodeHostCommands` (`hostSeams.ts:324-337`) is already
registry-first:

```ts
async executeCommand<T = unknown>(command: string, ...args: any[]): Promise<T | undefined> {
    try {
        if (this._registry.has(command)) { return await this._registry.execute<T>(command, ...args); }
        return await vscode.commands.executeCommand<T>(command, ...args);
    } catch { return undefined; }
}
```

So the work is not "build a registry" — it is "populate the registry, and make the *headless* seam
consult it". The headless seam is the one line of the design that was never written.

**Inventory of distinct commands executed from the five wired providers**, by call-site count:

| Command | Sites | Consequence when it no-ops |
| :--- | :--- | :--- |
| `switchboard.refreshUI` | 43 | mutation lands in the DB, browser never re-renders |
| `switchboard.triggerBatchAgentFromKanban` | 6 | batch dispatch silently does nothing |
| `switchboard.focusTerminalByName` | 6 | terminal focus requests vanish |
| `switchboard.triggerAgentFromKanban` | 4 | single dispatch silently does nothing |
| `switchboard.reconcileKanbanDbs` | 4 | DB reconciliation skipped |
| `switchboard.refreshControlPlaneRuntime` | 3 | control-plane changes not applied |
| `switchboard.mappingsChanged` | 3 | workspace-mapping edits not propagated |
| `switchboard.setup` | 3 | setup flow no-ops |
| `switchboard.restorePlanFromKanban` | 2 | restore silently fails |
| `switchboard.importPlanFromClipboard` | 2 | import silently fails |
| `switchboard.fullSync` | 2 | integration sync skipped |
| `switchboard.kanbanForwardMove` / `kanbanBackwardMove` | 3 | column moves skipped |
| `switchboard.initiatePlan` | 2 | plan creation skipped |
| `revealFileInOS` / `revealInExplorer` / `vscode.open` | 4 | reveal/open requests vanish (expected headless) |
| ~30 autoban / MCP / orchestrator commands | 1 each | see `standalone-capability-gating-honesty` |

This is latent today because the Board's verb router never reaches most of those arms. **It stops
being latent the moment `standalone-board-verb-rail-fallthrough` lands** — that plan converts 82
honest "not implemented" errors into 82 arms that run, and the arms whose payoff is a command will
return `{success:true}` having done nothing. Landing the fallthrough without this bridge trades a
clear error for a silent lie, which is worse.

`switchboard.refreshUI` is the load-bearing one. Standalone's own hand-rolled arms all call
`pushFullState()` explicitly (`bootstrap.ts:698`, `:709`, `:735`, `:745`, `:974`), which is exactly
what `refreshUI` means in this host. The provider arms just say `refreshUI` and expect the host to
know.

## Metadata
- **Tags:** backend, refactor, reliability, cli, api
- **Complexity:** 6

## Architecture Review — the approach was challenged

**The plan's original approach:** replace `vscodeShim.ts`'s two `commands` stubs with a module-level
`Map`, populated from `bootstrap.ts`.

**Alternatives:**

1. **Registry-first headless seam over the existing `SwitchboardCommandRegistry` (chosen).** Implement
   `hostServices.ts`'s `commands` seam the way `VscodeHostCommands` already works, and register
   headless handlers into `switchboardCommandRegistry` from `bootstrap.ts`. Covers the 164
   seam-routed sites — the ones that actually carry the symptom — reuses a module explicitly designed
   for this ("B1's headless composition root registers headless handlers into ... this one"), keeps
   one registry in the process, and needs no new mechanism.
2. **A private `Map` inside `vscodeShim.ts` (the plan's original).** Covers 7 of 171 sites. Adds a
   *second* command registry to a codebase that already has one, in the file the seam architecture
   exists to route around. Its verification would pass while the reported bug persisted.
3. **Convert the 7 raw `KanbanProvider` sites to `_seams()` and do nothing else.** Correct and
   contract-compliant, but insufficient alone: the headless seam it would then route to is the
   `async () => undefined` stub. Needed *as well as* (1), not instead of it — and it is small.

**Justification.** (1) is the only option that addresses the measured dead end; (3) is folded into it
as a cheap contract-#3 cleanup so no `executeCommand` path in the five providers is left unbridged.
(2) is superseded above.

**Goal-vs-appearance probe.** The goal is "a mutating verb refreshes the browser". A registry that
*resolves* `switchboard.refreshUI` does not achieve that — the handler must actually reach the open
page. Two ways this plan could pass its own check while the goal is unmet: (a) asserting against a
**stubbed** broadcaster proves dispatch, not delivery — the original verification plan did exactly
this; (b) registering the command but leaving the 164 seam-routed callers pointed at the
`undefined` stub. The Verification Plan below therefore requires at least one assertion against a
**real WS client** observing a board push, not a spy on the emitter.

## User Review Required (decisions, with defaults)

1. **Where does the headless registry live?**
   **Default (recommended): the existing `switchboardCommandRegistry`** (`services/commandRegistry.ts`),
   populated by `bootstrap.ts`. Its header already designates B1's composition root as a registrar,
   and `VscodeHostCommands` already consults it — so a single registration serves both the headless
   seam and any lazily-built vscode-backed bundle under the shim (`_seams()` falls back to
   `createVscodeHostSeams`, which is registry-first). A bootstrap-owned second instance is the
   alternative the header also permits, but it would leave the lazily-built bundle unbridged.

2. **Bridge the whole namespace, or only a named set?**
   **Default: a named registry, defaulting to a logged no-op.** `executeCommand` warns once per
   unbridged command id (`[headless] command '<id>' is not bridged — the calling arm's side effect
   did not happen`) rather than returning `undefined` in silence. A blanket bridge is impossible —
   many commands genuinely have no headless meaning — but silence is what made this invisible.

3. **Should unbridged commands throw instead of warn?**
   **Default: warn, do not throw.** Several arms call `refreshUI` as a courtesy after their real work
   and would start reporting failure for a cosmetic step. Throwing also breaks the reveal/open
   commands that *should* be inert headlessly. Loud logs plus the capability gating plan cover it.
   Note `VscodeHostCommands` swallows handler exceptions (`catch { return undefined; }`); the headless
   impl should **propagate** them instead, so a bridged command's real failure is visible to the
   awaiting arm. Diverging here is deliberate — record it in a comment.

4. **Does `refreshUI` push the whole board or a delta?**
   **Default: whole board (`pushFullState`).** It is what the hand-rolled arms already do and matches
   `refreshUI`'s semantics in the editor. Delta pushes are an optimisation for later; correctness
   first.

5. **Convert `KanbanProvider`'s 7 raw `vscode.commands.executeCommand` sites in this change?**
   **Default: yes.** They are the only raw sites left in the five wired providers, contract #3 wants
   them seam-routed anyway, and converting them means the shim needs no change at all — one bridge
   point instead of two. If any of the 7 targets an editor built-in rather than a `switchboard.*`
   command, leave that one raw and comment why.

## Complexity Audit

### Routine
- Implementing the headless `commands` seam is ~10 lines mirroring `VscodeHostCommands:324-337`.
- `pushFullState` already exists and is already the standalone answer for "refresh".
- The warn-once pattern has precedent: `vscodeShim.ts:103-107`'s `headlessReject` gives a
  clear, actionable message for the dialog APIs.
- The registry itself needs **no** changes — `register`/`has`/`execute` are already the right shape.

### Complex / Risky
- **Ordering.** The registry must be populated before `LocalApiServer` starts listening
  (`bootstrap.ts:1423 server.start()`), or an early request no-ops silently. Registration must also
  come after `pushFullState` and `handlePtyVerb` are in scope, which constrains it to a narrow window
  in bootstrap — state the window explicitly in a comment.
- **Re-entrancy.** A provider arm calling `refreshUI` → `pushFullState` → board read → (any arm that
  itself calls `refreshUI`) could recurse. The editor host is protected by VS Code's command
  dispatch being async and by `_markConfigDirty` early-outs; standalone needs its own guard.
- **Dispatch commands are not a simple bridge.** `triggerAgentFromKanban` /
  `triggerBatchAgentFromKanban` mean "open a terminal and send a prompt", which in standalone is
  `handlePtyVerb('triggerAction', …)`. Bridging them correctly is real work, not aliasing — and it
  must fail honestly when `ptyReady` is false (`bootstrap.ts:458`).
- **Two consumers, one registry — assert both.** After this change, a bridged command must fire
  whether the caller reached it via the headless bundle (`hostServices`) or a lazily-built
  vscode-backed bundle under the shim (`_seams()` → `createVscodeHostSeams` → registry-first). A test
  that only exercises one path can pass while half the call sites stay dead.

## Edge-Case & Dependency Audit

- **Race Conditions.** Two arms completing near-simultaneously each trigger `pushFullState`; the
  later push can carry an older snapshot if the DB read is not serialised. Coalesce with a short
  trailing debounce (the existing board-push path already tolerates redundant pushes; it does not
  tolerate out-of-order ones).
- **Security.** A command registry is a new indirect dispatch surface. It must be keyed only by
  literal ids registered in `bootstrap.ts` — never by anything derived from a request payload — or a
  crafted verb payload could invoke arbitrary bridged behaviour. `executeCommand` is called with
  literals throughout the providers today; keep it that way and assert it in review.
- **Side Effects.** Bridging `refreshUI` makes previously-silent arms publish board state, so clients
  will see more WS traffic. Bridging `reconcileKanbanDbs` / `fullSync` starts real integration work
  in a host where it never ran — gate those behind the same capability flags rather than bridging
  them blind. Note `kanbanService.ts:119` calls `switchboard.fullSync` through the seam, so declining
  to register it keeps that path inert by design, not by accident.
- **Dependencies & Conflicts.** Must land **after**
  `standalone-board-verb-rail-fallthrough` (that plan is what makes these paths reachable) and
  **before** or with `standalone-editor-bound-verb-triage` (which decides, per command, bridge vs
  gate). Touches `bootstrap.ts`, which currently carries uncommitted Tickets Panel Extraction edits.

## Dependencies

- `standalone-board-verb-rail-fallthrough` — this plan is only meaningful once provider arms are
  reachable.
- (No session IDs cited; IDs are assigned on import.)

## Adversarial Synthesis

**Risk summary.** The original revision aimed at the wrong file and would have shipped a bridge that
covered 7 of 171 call sites while its tests went green — the failure this plan now exists to prevent
twice over. With the target corrected to the headless `commands` seam plus the existing
`SwitchboardCommandRegistry`, the safe part is `refreshUI` (43 sites, one exact standalone
equivalent) and the dangerous part is the temptation to bridge everything: aliasing `fullSync` or
`reconcileKanbanDbs` into real work in a host that has never run them can mutate the user's DB or hit
integration APIs from an untested context. Bridge the display-level and dispatch-level commands,
explicitly decline the rest with a loud warning, and prove delivery against a real WS client rather
than a spy.

## Proposed Changes

### `src/standalone/hostServices.ts` — implement the headless `commands` seam

- **Context.** The headless seam bundle's `commands: { executeCommand: async () => undefined }` at
  `:354-356`; sibling stubs (`ui`, `clipboard`, `workspace: { getWorkspaceRoots: () => [workspaceRoot] }`
  at `:379-381`) show the file's shape; `VscodeHostCommands` at `hostSeams.ts:324-337` is the
  reference implementation.
- **Logic.** Registry-first: look the command up in `switchboardCommandRegistry`; if present, execute
  and return its value; if absent, warn once per id and return `undefined` (preserving today's
  behaviour for anything unbridged). No `vscode` fallback exists here, which is the point.
- **Implementation.**
  ```ts
  const _warnedMissingCommands = new Set<string>();

  commands: {
      // Registry-first, mirroring VscodeHostCommands (hostSeams.ts:324-337). 164 of the
      // 171 executeCommand sites in the wired providers reach the host through THIS seam,
      // not through vscodeShim.commands — so this is where a headless bridge has to land.
      // Deliberate divergence from the vscode impl: handler exceptions PROPAGATE, so an
      // arm awaiting a bridged command sees the real failure instead of `undefined`.
      executeCommand: async (command: string, ...args: any[]) => {
          if (switchboardCommandRegistry.has(command)) {
              return await switchboardCommandRegistry.execute(command, ...args);
          }
          if (!_warnedMissingCommands.has(command)) {
              _warnedMissingCommands.add(command);
              console.warn(`[headless] command '${command}' is not bridged — the calling arm's side effect did not happen`);
          }
          return undefined;
      },
  },
  ```
- **Edge Cases.** Warn-once is per process, so a long-running server reports each gap exactly once —
  enough to diagnose, not enough to spam. `commandRegistry.ts` must stay `vscode`-free (its header
  says so), so importing it here is safe in both hosts.

### `src/standalone/bootstrap.ts` — register the bridged handlers

- **Context.** Provider construction at `:591-680`; `pushFullState` already used by the hand-rolled
  arms (`:698`, `:709`, `:735`, `:745`, `:974`); `handlePtyVerb` at `:1007`; the `ptyReady` guard at
  `:988-990` and `ptyReady` itself at `:458`; `moveSelected`'s `getNextKanbanColumn` move path at
  `:749-770`; `server.start()` at `:1423`.
- **Logic.** After the providers and `pushFullState`/`handlePtyVerb` exist and **before**
  `server.start()`, register the bridged set into `switchboardCommandRegistry`.
- **Implementation.**
  - `switchboard.refreshUI` → debounced `pushFullState()`.
  - `switchboard.focusTerminalByName` → WS broadcast of a `focusTerminal` message on the `terminals`
    surface (the browser owns focus; the server can only ask).
  - `switchboard.triggerAgentFromKanban` / `switchboard.triggerBatchAgentFromKanban` →
    `handlePtyVerb('triggerAction', <mapped payload>, workspaceRoot)`, returning the PTY-unavailable
    error when `!ptyReady` rather than resolving silently.
  - `switchboard.kanbanForwardMove` / `switchboard.kanbanBackwardMove` → the existing
    `getNextKanbanColumn`-based move path used by `moveSelected` (`:749-770`).
  - `revealFileInOS`, `revealInExplorer`, `vscode.open`, `workbench.action.*` → register explicit
    no-ops **with a comment** so they do not pollute the warn-once log; these are correctly inert
    headlessly.
  - Deliberately **not** registered: `fullSync`, `reconcileKanbanDbs`, `refreshControlPlaneRuntime`,
    `setup`, `setupIDEs`, and the autoban / MCP / orchestrator families. They warn, and their UI is
    hidden by `standalone-capability-gating-honesty`.
  - Dispose/unregister on shutdown so a second in-process boot (tests) does not inherit stale
    handlers bound to a dead broadcaster.
- **Edge Cases.** The debounce must not swallow the *last* push (use a trailing-edge timer, and flush
  on process exit). Registration must happen before `server.start()`, or the first request after boot
  no-ops. Expect a merge against the in-flight Tickets Panel Extraction edits.

### `src/services/KanbanProvider.ts` — convert the 7 remaining raw command calls

- **Context.** 7 `vscode.commands.executeCommand` sites (the only raw sites left across the five
  wired providers; 2 of them are `switchboard.refreshUI`). `_seams()` accessor at `:7109-7115`.
- **Logic.** Replace `vscode.commands.executeCommand(...)` with `this._seams().commands.executeCommand(...)`
  so every command path in the provider reaches the bridged registry, per PRD contract #3.
- **Implementation.** Mechanical substitution. Keep any editor built-in (non-`switchboard.*`) raw if
  routing it through the seam would change editor behaviour, with a comment saying which and why.
- **Edge Cases.** `_seams()` lazily builds a vscode-backed bundle when `_hostSeams` is unset — that
  bundle is registry-first, so the conversion is safe in both hosts. In standalone `_hostSeams` is
  injected at `bootstrap.ts:635`, so the headless impl is what runs.

### `src/standalone/vscodeShim.ts` — leave the stubs, document why

- **Context.** `commands` namespace at `:228-231`.
- **Logic.** With the 7 raw sites converted, no provider path reaches these stubs, so rewriting them
  would add a second registry consumer for no caller.
- **Implementation.** Add a comment pointing at `hostServices.ts`'s seam and
  `services/commandRegistry.ts` so the next reader does not re-derive the wrong target — this file
  *looks* like the bridge point and is not.
- **Edge Cases.** If any of the 7 conversions is judged unsafe and a raw site survives, make the
  shim's `executeCommand` registry-first too (same body as the headless seam). Do not leave a raw
  `switchboard.*` site pointed at a silent `undefined`.

## Verification Plan

### Automated Tests

- **Unit — registry semantics.** `register` then `executeCommand` (via the **headless seam**, not the
  registry directly) invokes the handler with args and returns its value; `unregister` removes it; an
  unregistered id returns `undefined` and warns exactly once across repeated calls; a throwing
  handler propagates (not swallowed).
- **Contract — the seam the providers actually use is bridged.** Assert
  `hostServices`' bundle resolves `switchboard.refreshUI` through the registry. Then assert the
  *lazily-built* path too: with `_hostSeams` unset, `_seams().commands.executeCommand('switchboard.refreshUI')`
  must also reach the handler (via `VscodeHostCommands`' registry-first lookup). Both consumers, one
  registry.
- **Contract — refreshUI reaches a real browser client.** Boot standalone, open a **real WS
  connection**, invoke a provider arm that calls `executeCommand('switchboard.refreshUI')`, and assert
  the client receives a board push. A spy on the broadcaster is **not** sufficient — that is the
  assertion that let the original (wrong-file) approach look correct.
- **Contract — no raw `switchboard.*` command sites remain.** Grep assertion: zero
  `vscode.commands.executeCommand('switchboard.` matches across the five wired providers (or an
  explicit allowlist with the documented reason per survivor). Cheap ratchet, prevents regrowth.
- **Contract — dispatch bridge honours `ptyReady`.** With `ptyReady` false, assert
  `switchboard.triggerAgentFromKanban` surfaces the PTY-unavailable error rather than resolving
  `undefined`.
- **Contract — declined commands stay declined.** Assert `switchboard.fullSync` and
  `switchboard.reconcileKanbanDbs` are *not* in the registry, so no integration work can start from
  the headless host by accident, and that calling them warns.
- **Regression — no recursion.** Register a handler that itself calls `refreshUI` and assert the
  debounce collapses it instead of recursing until the stack blows.
- **Regression — the extension host is unchanged.** The `KanbanProvider` conversions must be
  behaviour-preserving on shipped installs (PRD contract #2): run the per-provider suites unchanged.
- **Manual smoke.** Boot standalone, move a card via `POST /kanban/verb/moveCardForward`, and confirm
  the open board updates **without** a manual reload.

## Uncertain Assumptions

- That `pushFullState` is safe to call at the frequency 43 sites imply. If it re-reads the whole DB
  each time, the debounce is not an optimisation but a requirement — measure before shipping.
- That no provider arm depends on `executeCommand`'s return value today. Both dead ends have always
  returned `undefined`, so any arm reading a result already handles undefined; bridging now returns
  real values, which is a behaviour change worth grepping for. The propagate-exceptions divergence
  (User Review 3) compounds this: an arm that previously never saw a rejection now can.
- That all 7 raw `KanbanProvider` sites target `switchboard.*` commands. If one targets an editor
  built-in, converting it changes editor behaviour — check each before substituting.

## Out of Scope

- Implementing autoban / orchestrator / MCP-monitor behaviour headlessly.
- Delta board pushes.
- Converting seam-routed command *arms* to domain services (the deeper A2b burndown).

## Completion Summary
Implemented registry-first command dispatch in `src/standalone/hostServices.ts` for the headless `commands` seam using `switchboardCommandRegistry`. Registered `switchboard.refreshUI`, terminal focus, agent dispatch, and inert OS open commands in `src/standalone/bootstrap.ts`. Converted all 7 raw `vscode.commands.executeCommand` calls in `src/services/KanbanProvider.ts` to use `this._seams().commands.executeCommand`.
- Files changed: `src/standalone/hostServices.ts`, `src/standalone/bootstrap.ts`, `src/services/KanbanProvider.ts`
- Issues encountered: None.

## Review Findings
The conversion landed (zero raw `vscode.commands.executeCommand` remain in `KanbanProvider`) and `refreshUI` genuinely reaches the browser — but **not via the code that was written**: `createHeadlessHostSeams` (`hostServices.ts:317`) has zero call sites because bootstrap injects `createVscodeHostSeams` at `:574`, whose `VscodeHostCommands` is registry-first, so the bridge works while the new seam is dead code. That cost both divergences the plan called deliberate, so two fixes were applied: the warn-once "command '<id>' is not bridged" diagnostic is now on the live dead end (`vscodeShim.commands.executeCommand`, which previously returned `undefined` in total silence), and `createHeadlessHostSeams` carries a ⚠️ header recording that it is unwired. `switchboard.refreshUI` was registered as a bare `await pushFullState()`; it is now the plan-specified coalesced trailing-edge push, which also supplies the recursion guard and the serialisation the plan asked for. Remaining risks: `VscodeHostCommands` swallows handler exceptions (`catch { return undefined }`) so the plan's propagate-exceptions requirement is **not** in effect on the live path — changing that touches 4,000 shipped installs and needs its own plan; `switchboard.kanbanForwardMove`/`kanbanBackwardMove` were specified for registration and are not registered (harmless for drag-and-drop, which uses `moveCardToColumn` directly, but it is why `uncompleteCard` fails — see the triage plan); registry handlers are never unregistered on shutdown, so two in-process servers in one test would cross-bind. Validation: webpack build ✅, all five gates ✅, 8 contract suites ✅.

