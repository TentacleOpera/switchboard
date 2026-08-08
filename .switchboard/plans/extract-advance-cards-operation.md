# Extract One `advanceCards` Operation — Eighteen Copies of the Same Routine

## Metadata

**Complexity:** 8
**Tags:** refactor, bugfix, backend, reliability, test

## Goal

Replace the eighteen hand-written copies of the kanban "advance these cards" routine with a single operation that every UI affordance calls. Today each button and the drag handler open-codes the same nine-step sequence, so any change to dispatch semantics has to be made eighteen times — and the most recent one was made once.

### Problem analysis and root cause

> **Note (2026-08-08):** the analysis below describes the tree **before commit `ea1077da`**, which landed an explicitly-interim fix for the reported symptom. It is preserved verbatim because it is the reason this plan exists. See **Status at HEAD** at the end of this section for what is now true, and which of the conclusions below have been superseded.

**The observed bug (verified live, 2026-08-07).** In the browser cockpit served by the extension host, board drag-and-drop dispatches correctly to the PTY fleet while the advance-selected buttons on the same page fail with a VS Code "terminal not found" toast. Same page, same transport, same verb rail, same provider.

**The mechanism.** `switchboard.triggerAgentFromKanban` (`src/extension.ts:1651`) takes the calling surface as its **sixth positional argument**:

```typescript
registerSwitchboardCommand('switchboard.triggerAgentFromKanban',
    async (role, sessionId, instruction?, workspaceRoot?, targetTerminalOverride?, apiOriginated?, bypassTriggerGate?) =>
        taskViewerProvider.handleKanbanTrigger(role, sessionId, instruction, workspaceRoot,
            { targetTerminalOverride, persistColumnOnError: true, apiOriginated: !!apiOriginated, ... }));
```

That command had **18 call sites in `src/services/KanbanProvider.ts`**. Exactly **one** passed the sixth argument:

| Site | Path | Surface argument |
|---|---|---|
| `:8243` | `triggerAction` — the drag | ✅ `!!msg?.apiOriginated` |
| `:9075` `:9077` | `moveSelected` — advance selected | ❌ |
| `:9148` `:9150` `:9219` `:9221` | `moveAll` — advance all | ❌ |
| `:2706` `:5634` `:5706` `:8361` `:9019` `:9292` `:9671` `:10068` `:10145` `:10147` `:10181` | everything else | ❌ |

`moveSelected` (`:9074-9078`) calls it with four arguments. `apiOriginated` arrives `undefined`, `allowPtyFleet` resolves `false`, `_resolveAgentTerminalForPlan` skips the fleet branch entirely (`TaskViewerProvider.ts:8347`), a VS Code terminal is resolved instead, and the browser user gets a toast about a terminal they cannot see.

Worse: `switchboard.triggerBatchAgentFromKanban` (`extension.ts:1664`) has **no `apiOriginated` parameter at all** — its signature ends at `targetTerminalOverride`. Batch advance is structurally incapable of reaching the fleet, so threading arguments at the call sites cannot fix it.

> **Superseded:** "`switchboard.triggerBatchAgentFromKanban` has no `apiOriginated` parameter at all … batch advance is structurally incapable of reaching the fleet."
> **Reason:** No longer true at HEAD. Commit `ea1077da` added the parameter — `src/extension.ts:1675` is now `(role, sessionIds, instruction?, workspaceRoot?, targetTerminalOverride?, apiOriginated?, analysisScope?)`.
> **Replaced with:** Batch advance *can* now carry a surface, and 16 of the 17 remaining call sites pass it. The structural impossibility is gone; the duplication that caused it is not.

**Why the flag was only ever added once.** `browser-send-to-terminal-dispatch-parity` audited direct callers of `_dispatchExecuteMessage` — seven of them — and threaded those correctly. Board buttons do not call it directly; they go through the **command registry**, a layer that audit never covered. The single command call site anyone fixed was the drag, because the drag was the thing under test.

**The root cause is the duplication, not the missing argument.** `moveSelected` (`:9028`, and again at `:9110`) and `moveAll` (`:9180`, `:9250`) are near-identical copies of one routine, and `triggerAction` / `triggerBatchAction` / `sendDispatchToCoder` are further variants of it:

```
_filterUnknownComplexitySessions → _partitionByComplexityRoute → _getVisibleAgents
→ _targetColumnForDispatchRole → _columnToRole → moveCardToColumn (per sid)
→ recordRunSheetForColumnMove → _collectAllMovedSessionIds
→ postMessage('moveCards') → if (_cliTriggersEnabled) → triggerAgentFromKanban
```

There is no shared "advance cards" operation. Threading the surface argument into the remaining seventeen sites fixes today's symptom and guarantees that the nineteenth site, written next month, repeats it — because nothing prevents it.

**Why the copies exist: the webview↔backend contract differs per affordance.** This is the reason the sequence could not simply be shared, and it must be resolved rather than preserved:

| | Webview sends | Backend does |
|---|---|---|
| Drag | the **target** column (the user dropped it there) | `_resolveKanbanDispatchSpec(targetColumn)` → dispatch. **No complexity routing.** |
| Advance button | the **source** column | computes the target itself, including per-card complexity routing → dispatch |

Same user intent, two divisions of labour, therefore two input shapes, therefore no shared code. Each affordance's author picked a split; nobody ever defined one contract.

**The intended rule (three cases, not two).** Complexity routing is not a button-only concern — it is a property of *which target the user chose*:

| User action | Target | Complexity routing? |
|---|---|---|
| Drag onto a specific coder column (`LEAD CODED` / `CODER CODED` / `INTERN CODED`) | that column | **No** — the user picked it |
| Drag onto the synthetic collapsed `CODED_AUTO` column | "you decide" | **Yes** |
| Advance-selected / advance-all from PLAN REVIEWED | computed next stage | **Yes** |

`CODED_AUTO` is the aggregate the three coder columns collapse into (`kanban.html:4269-4280`, `:5553`). Dropping a card on it means "route this to the right coder", which is exactly the complexity decision. Dropping on an expanded, specific coder column means "put it here" and must stay unrouted.

**The real defect: complexity routing is implemented twice, and the two disagree.**

| | Client — `resolveCodedAutoTarget` (`kanban.html:7250`) | Backend — `_resolveComplexityRoutedRole` (`KanbanProvider.ts:7044`) |
|---|---|---|
| Reached by | drag onto `CODED_AUTO` | advance buttons |
| Routing disabled → | `'LEAD CODED'` | `'lead'` (equivalent) |
| Complexity source | `card.complexity` from the board payload | `planFile` read from the DB, with a run-sheet fallback |
| **Unscored / `NaN` complexity →** | **`'CODER CODED'`** | **`'lead'` → `LEAD CODED`** (`parseComplexityScore('Unknown')` → `NaN`, matches no routing-map array, falls through to `'lead'` at `:1360-1379`) |
| Coder column hidden but occupied → | falls back to `'CODER CODED'` unconditionally | `_validateOrDegradeCodingColumn` (`:7166`) walks to the **nearest visible** role |

So the same card lands in a different column depending on which affordance the user reached for. Same decision, two implementations, two answers — and the client's copy reads a payload field while the server's reads the database.

> **Superseded:** "an unscored card dragged onto `CODED_AUTO` lands in `CODER CODED`, while the same card advanced via the button is refused with an 'unknown complexity' notice."
> **Reason:** `_allowUnknownComplexityAutoMove` **defaults to `true`** (`KanbanProvider.ts:448`, `:811`), which makes `_filterUnknownComplexitySessions` (`:7127`) an early-return no-op. So on a default install the button does **not** refuse an unscored card — it routes it, via `_resolveComplexityRoutedRole` → `NaN` → `'lead'` → `LEAD CODED`. The refusal only happens for users who deliberately turned the setting off.
> **Replaced with:** The default-path divergence is **`CODER CODED` (drag) vs `LEAD CODED` (button)** — a wrong-column landing, not a refused move. The refusal-vs-move divergence is the *non-default* case. Both must be closed, but the wrong-column one is the common one and the one users will actually have hit.

That is the divergence the extraction must close: routing belongs on the server, once. The webview should send **intent** (`CODED_AUTO` = "route this"), never a pre-resolved target, and `resolveCodedAutoTarget` should be deleted.

### Status at HEAD — interim fix landed (2026-08-08)

Commit `ea1077da` ("fix: thread apiOriginated through kanban dispatch command call sites") landed the throwaway fix this plan's *Unblocking note* described. Verified at HEAD:

- **16 of 17** command call sites in `KanbanProvider.ts` now pass the surface: `:5700`, `:5772` (`_distributePlannerDispatch`, via `!!options?.apiOriginated`), `:8317` (`triggerAction`), `:8435` (`triggerBatchAction`), `:9093` (`julesLowComplexity`), `:9149` `:9151` `:9222` `:9224` (`moveSelected`), `:9293` `:9295` `:9366` (`moveAll`), `:9745` (`julesSelected`), `:10155` (`dispatchAnalyze`), `:10235` `:10237` (`sendDispatchToCoder`).
- The **one** remaining 4-argument site is `_remoteDispatchColumnAgent` (`:2748`) — a private helper, not a `_handleMessage` arm, deliberately unchanged because remote-control and plan-import paths have no browser surface.
- `switchboard.triggerBatchAgentFromKanban` (`extension.ts:1675`) now has the `apiOriginated` parameter.
- `kanbanService.focusTerminal` (`src/services/kanbanService.ts:147`) now passes `{ silent: true }`.
- The count is **17**, not 18. Every line number in the pre-fix table above has shifted by roughly 50–100 lines.

**What this changes about the plan.** The reported symptom is fixed; this plan is no longer a bugfix for it. It is now (a) the extraction that stops the seventeen copies regrowing, (b) the closure of the client/server complexity-routing divergence, which is still live and still wrong, and (c) three residual defects the interim fix did not touch:

1. **`focusTerminal` still focuses PTY targets.** Only the `{ silent: true }` half landed; the plan's other half — skip the focus entirely for a PTY target, matching `TaskViewerProvider.ts:19415` — did not. Five further non-silent `switchboard.focusTerminalByName` call sites remain: `KanbanProvider.ts:10446`, `TaskViewerProvider.ts:12407`, `:19661` (both reached only after `_focusTerminalByName` returns `false`), `extension.ts:3050`, `:3465`.
2. **Standalone drops `targetTerminalOverride` on the single-card path.** `src/standalone/bootstrap.ts:826` registers `switchboard.triggerAgentFromKanban` with a signature that ends at `targetRoot` — the 5th argument `targetTerminalOverride` that `triggerAction` (`KanbanProvider.ts:8317`) passes is silently discarded under `npx switchboard`. The batch registration at `:832` *does* keep `terminalName`. So a drag with an explicit terminal override works in the extension host and in standalone-batch, but not in standalone-single.
3. **Six verb schemas dereference `apiOriginated` without declaring it.** Post-`ea1077da`, `triggerBatchAction` (`verbSchemas.ts:249`), `moveCardForward` (`:257`), `moveCardBackwards` (`:264`), `moveSelected` (`:271`), `moveAll` (`:278`) and `sendDispatchToCoder` (`:370`) all read `msg?.apiOriginated`; only `triggerAction` (`:240`) declares it. Not a live break — `validateVerbPayload` ignores undeclared fields — but it violates PRD contract #5 ("field-accurate") and the declaration is the only machine-readable record that the field exists.

## User Review Required

None.

## Complexity Audit

### Routine
- Mechanical replacement of the seventeen call sites once the operation exists.
- Declaring `apiOriginated` in the six verb schemas that already read it.
- Adding `typescript` to `devDependencies` for the guard script.

### Complex / Risky
- **The target contract is three-way, and getting it wrong moves cards for every affordance at once.** `target: <columnId>` → move there, no routing. `target: 'CODED_AUTO'` → complexity-route per card. `target: undefined` → compute the next stage (which for PLAN REVIEWED means routing). Collapsing this to a boolean "explicit vs computed" loses the distinction between "I dropped it on LEAD CODED" and "I dropped it on the collapsed coder column", and would start routing drops the user made deliberately.
- **Deleting `resolveCodedAutoTarget` (`kanban.html:7250`) removes the input to four other client decisions, not one.** This is the largest single under-estimate in the original plan. The resolved target feeds:
  1. **Forward-vs-backward direction** — `tgtIdx < srcIdx` decides `moveCardBackwards` vs a dispatch (`kanban.html:7309-7317`). A card in `COMPLETED` dragged onto the collapsed coder column is a *backward* move; one from `PLAN REVIEWED` is forward; a single drop can contain both. Without a client-resolved target the webview cannot classify direction, so `advanceCards` must own it — meaning the operation spans `moveCardBackwards` too, not just the forward family.
  2. **Agent-availability fallback** — `isColumnAgentAvailable(group.targetColumn)` (`:7401`) decides whether to dispatch or degrade to a bare `moveCardForward`. Also server-side work.
  3. **Prompt-mode grouping** — the group key is `${dispatchType}::${resolvedTarget}::${sourceColumn}` (`:7318-7320`) and `promptOnDrop` (`:7390-7397`) carries both columns. The `promptOnDrop` arm (`KanbanProvider.ts:8864`) must therefore accept `CODED_AUTO` intent as well, or prompt-mode drops keep a second routing implementation.
  4. **Optimistic model mutation and the render guard** — `card.column = resolvedTarget` (`:7357`), then `buildBoardSignature(currentCards)` and `armOptimisticGuard(draggedEntries)` (`:7372-7374`). These need a target per card.

  **The mitigating fact that makes this tractable:** while the coder columns are collapsed, the DOM destination for *every* routed target is the same container, `col-CODED_AUTO`. So optimistic **DOM placement** needs no client-side target; only the **model** mutation and the guard do, and those can be driven by the operation's returned/pushed targets. Deferring them costs one round-trip of visual authority on a `CODED_AUTO` drop — acceptable, but it must be a deliberate decision, not a discovery during implementation.
- **`src/test/kanban-coded-auto-batching-regression.test.js` pins the exact block being deleted, by source text.** Its `getCodedAutoDropBlock()` anchors on the literal comment `// Handle drops onto the synthetic CODED_AUTO column — route each card to its real column` (`kanban.html:7293`) and then asserts eight substrings inside it: `columnDragDropModes['CODED_AUTO'] || 'cli'`, `new Map()` grouping, `type: 'triggerBatchAction'`, `type: 'moveCardBackwards'` + `sessionIds: groupedIds`, `type: 'promptOnDrop'` + `sourceColumn: group.sourceColumn`, the prompt group-key shape, and two negative assertions. Removing the block hard-fails the test at its anchor assertion. Rewriting this test to pin the *new* contract is part of the change, and it is the single best place to state what the new client→server payload is.
- **Moving routing server-side changes behaviour for unscored cards — deliberately.** On a default install (`_allowUnknownComplexityAutoMove: true`) the change is a **landing-column change**: unscored cards dragged onto `CODED_AUTO` move to `LEAD CODED` instead of `CODER CODED`. For users who turned the setting off, it additionally becomes a **refusal**: the drag starts skipping unscored cards with the same notice the button gives. **Recommended: the server wins in both cases** — `_filterUnknownComplexitySessions` exists so unscored work is not silently dispatched to a coder, and `_allowUnknownComplexityAutoMove` is the strictness opt-in. Release-note both effects; the landing-column change is the one most users will see.
- **The hidden-column degradation rules differ and neither is a superset.** `_filterDynamicColumns` (`KanbanProvider.ts:3854`) keeps a hidden-agent column in the payload when it is **occupied**, so `columnDefinitions` is not a visibility list. The client's check (`columnDefinitions.some(d => d.id === 'INTERN CODED')`, `kanban.html:7259-7261`) therefore routes into an occupied-but-agentless `INTERN CODED`, and its fallback is an unconditional `'CODER CODED'` — which can itself be hidden. The server's `_validateOrDegradeCodingColumn` (`:7166`) walks `lead → coder → intern` to the nearest *visible* role. Server-side is correct; the client's is a latent dead-column dispatch.
- **`KanbanProvider.ts` is ~13,000 lines and this touches seventeen call sites across it.** One agent stream on this file (project PRD orchestration discipline); no parallel work in it while this lands.
- **Byte-compatibility for ~4,000 installs.** Every existing affordance must behave identically in the editor after the extraction. The only intended behaviour changes are (a) the complexity-routing convergence above, and (b) the residual defects listed in *Status at HEAD*.
- **The `_cliTriggersEnabled` gate is currently read independently in each copy.** Centralising it is correct but changes when it is evaluated for batch paths; verify a toggle mid-batch cannot produce a partially-dispatched selection. Note the gate is *not* uniform today: `moveSelected`'s custom-user branch checks `dispatchSpec.dragDropMode === 'prompt' || this._cliTriggersEnabled` (`:9171`) while its general branch checks `this._cliTriggersEnabled && role` (`:9219`). One operation must pick one rule and the characterisation tests must show which affordances change.
- **Cascade ids and run sheets.** `_collectAllMovedSessionIds` (feature subtask cascade) and `recordRunSheetForColumnMove` are invoked per-card inside each copy, sometimes in slightly different order relative to the `moveCards` push. Normalising the order is required, and it is exactly the kind of change that silently alters what the board renders mid-move. Pin the order with a test before refactoring.

## Edge-Case & Dependency Audit

**Race Conditions**
- The optimistic-move path in `kanban.html` deliberately does *not* pre-move PLAN REVIEWED batches (mixed complexity would bounce). The extraction must keep the backend as the source of truth for those targets and keep emitting the same `moveCards` / `moveCardsFailed` deltas, or the board will visibly bounce cards.
- Partial failure: `moveCardToColumn` can fail per card. Today each copy accumulates its own `failures[]` and posts `moveCardsFailed`. One implementation must preserve per-card partial success — an all-or-nothing rewrite would be a regression.
- **New:** once the client stops resolving `CODED_AUTO` targets, `armOptimisticGuard` is armed from the *returned* targets rather than before the round-trip. Between the drop and the reply there is a window in which a debounced `_refreshBoard` (`_scheduleBoardRefresh`, 100 ms, `:3868`) can render the pre-move state. Either arm the guard with the `CODED_AUTO` container as the target (which is where the card already visually is while collapsed) or suppress the refresh for the in-flight ids.

**Security** — no new verb, endpoint or allowlist change.

**Side Effects**
- If the complexity-routing divergence is resolved in favour of the server, some drags will land cards in a different column than before — specifically unscored cards move to `LEAD CODED` instead of `CODER CODED` on a default install. Release-note it.
- Closing the standalone `targetTerminalOverride` gap changes which terminal a standalone single-card drag delivers to. That is a fix, but it is a delivery-target change under `npx`.

**Dependencies & Conflicts**
- Interacts with `delete-allowptyfleet-resolve-terminals-by-name.md`: **do this first.** After extraction the surface argument exists in one place, so deleting it later is a one-site change rather than a ninety-two-site sweep. Landing the deletion first would mean deleting the flag from seventeen copies and then extracting them anyway.
- `kanbanService.focusTerminal` (`src/services/kanbanService.ts:147`) is a separate defect in the same symptom. The `{ silent: true }` half landed in `ea1077da`; the PTY-skip half did not. Finish it here — a PTY target has no VS Code terminal to reveal, so the focus call is pure waste even when silent. Five further non-silent call sites exist (`KanbanProvider.ts:10446`, `TaskViewerProvider.ts:12407`, `:19661`, `extension.ts:3050`, `:3465`); audit each for whether a PTY target can reach it.
- `_isLikelyPtyDispatchTarget` (`TaskViewerProvider.ts:18944`) reads the `_ptyTerminalNames` snapshot, refreshed only as a side effect of `_ptyHostVerb('ptyListTerminals')` (`:431`) and cleared on reload (`:1985`, `:21804`). It is cold after a reload while delivery uses a live list — so the guard can disagree with the delivery it is guarding. Refresh before consulting, or read live.
- `scripts/check-kanban-dispatch-callers.js` does not exist; it is new here. `typescript` is in neither `dependencies` nor `devDependencies` at HEAD — it resolves only as a transitive hoist, so the guard must declare it.

## Dependencies

None (hard).

**Unblocking note.** ✅ **Done — landed as `ea1077da` (2026-08-07).** The immediate symptom was cleared without this plan: thread `!!msg?.apiOriginated` into the remaining call sites, add the missing parameter to `triggerBatchAgentFromKanban`, and silence `focusTerminal`. That is throwaway work this plan deletes. Its presence means this plan is **no longer urgent** — but it is also the reason the plan must now be judged as a refactor plus divergence closure, not as a fix for a live browser bug.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is that collapsing the copies into one operation changes where cards land — the extraction forces a decision on the drag/button complexity-routing divergence that has been quietly inconsistent, and on a default install the convergence moves unscored cards from `CODER CODED` to `LEAD CODED` for every user, in the editor as well as the browser. The second risk is that deleting `resolveCodedAutoTarget` is not a one-line deletion: the resolved target is also the input to the webview's forward/backward classification, its agent-availability fallback, its prompt-mode grouping and its optimistic model mutation, so the operation must absorb `moveCardBackwards` and `promptOnDrop` intent or a second routing implementation survives — and a source-text regression test (`kanban-coded-auto-batching-regression.test.js`) pins the exact block being removed. Mitigations: pin current per-affordance behaviour with characterisation tests *before* refactoring, make the three-way target an explicit parameter rather than an inferred one, rewrite the batching regression test to pin the new client→server payload in the same change, and land the CI guard in the same change so the copies cannot silently regrow.

## Proposed Changes

### `src/services/KanbanProvider.ts`
- **Context:** Owns every kanban `_handleMessage` arm and all seventeen dispatch call sites.
- **Logic:** Add one operation:

  ```
  advanceCards(sessionIds, {
      sourceColumn,
      target?,             // <columnId>   → move there, NO routing   (drag onto a real column)
                           // 'CODED_AUTO' → complexity-route per card (drag onto the collapsed column)
                           // undefined    → compute next stage; PLAN REVIEWED ⇒ route (advance buttons)
      direction?,          // 'forward' | 'backward' | undefined → derive per card from resolved target
      mode?,               // 'cli' | 'prompt' | 'move' → replaces the per-copy _cliTriggersEnabled read
      apiOriginated,
      instruction?, targetTerminalOverride?, bypassTriggerGate?
  }): Promise<{
      success: boolean;
      moved: Array<{ id: string; targetColumn: string }>;   // resolved per card — the client's optimism input
      failures: Array<{ id: string; sourceColumn: string; reason: string }>;
      skippedUnknownComplexity: number;
      dispatched: boolean;
      error?: string;
  }>
  ```

  It owns the whole routine: unknown-complexity filtering, complexity partition (routed-target paths only), visible-agent resolution, target-column resolution *and degradation*, per-card forward/backward classification, per-card `moveCardToColumn`, run-sheet recording, cascade-id collection, the `moveCards` / `moveCardsFailed` pushes, the `_cliTriggersEnabled` gate, and the single dispatch call.

  **Returning `moved[]` is not optional** — PRD contract #4 requires the arm to return its result in the body, and `moveSelected` currently returns `{ success: true, column }`, which tells an HTTP caller nothing about where the cards went. `moved[]` is simultaneously the contract fix and the payload that lets the webview arm its optimistic guard without re-implementing routing.

  **Scope fence — which arms become thin callers.** The advance family: `triggerAction` (`:8152`), `triggerBatchAction` (`:8377`), `moveCardForward` (`:8459`), `moveCardBackwards` (`:8441`), `moveSelected` (`:9102`), `moveAll` (`:9237`), `sendDispatchToCoder` (`:10167`), `promptOnDrop` (`:8864`), and the `_distributePlannerDispatch` helper (`:5700`, `:5772`). **Explicitly out of scope**, and allowlisted in the guard: the two fixed-role Jules arms (`julesLowComplexity` `:9073`/`:9093`, `julesSelected` `:9732`/`:9745` — no column move, no routing), `dispatchAnalyze` (`:10126`/`:10155` — dispatches without moving), and `_remoteDispatchColumnAgent` (`:2748` — not an arm, no browser surface). Naming the fence in the plan is what stops the operation growing a `kind` discriminator with five branches.
- **Edge Cases:** Preserve per-card partial failure and the exact delta messages the board consumes; preserve emission order. Reconcile the two different `_cliTriggersEnabled` readings at `:9171` and `:9219` explicitly and record which affordance's behaviour changed.

### `src/webview/kanban.html`
- **Logic:** Delete `resolveCodedAutoTarget` (`:7250-7266`). The `CODED_AUTO` drop block (`:7293-7421`) sends `target: 'CODED_AUTO'` as intent for every card in the drop, in one message, and takes `moved[]` from the response to mutate `currentCards`, rebuild `lastBoardSignature`, and arm `armOptimisticGuard`.
- **Edge Cases:** Direction, agent-availability fallback and prompt-mode grouping all move server-side with the routing — see the Complexity Audit bullet. Optimistic **DOM** placement is unaffected while coders are collapsed (`col-CODED_AUTO` is the destination for every routed target); only the model mutation defers. Guard against the 100 ms `_scheduleBoardRefresh` (`KanbanProvider.ts:3868`) landing in the pre-reply window.

### `src/extension.ts`
- **Logic:** No signature change needed — `switchboard.triggerBatchAgentFromKanban` (`:1675`) already carries `apiOriginated` as of `ea1077da`. Audit `switchboard.focusTerminalByName` call sites `:3050` and `:3465` for whether a PTY target can reach them.

> **Superseded:** "Add `apiOriginated?: boolean` to `switchboard.triggerBatchAgentFromKanban` (`:1664`) and forward it into `handleKanbanBatchTrigger` — batch dispatch currently cannot receive a surface at all."
> **Reason:** Landed in `ea1077da`. The parameter exists at `src/extension.ts:1675`.
> **Replaced with:** No change required in `extension.ts` for the surface argument; the remaining `extension.ts` work is the two non-silent `focusTerminalByName` sites.

### `src/standalone/bootstrap.ts`
- **Logic:** `switchboard.triggerAgentFromKanban` (`:826`) is registered as `(role, sessionId, instruction?, targetRoot?)` and silently discards the 5th argument `targetTerminalOverride` that `triggerAction` passes. Add it and forward it to `handlePtyVerb` as `terminalName`, matching the batch registration at `:832`.
- **Edge Cases:** `apiOriginated` is legitimately ignored in standalone (`_apiOriginated` at `:832`) — the PTY fleet is the only backend there, so there is no fleet gate to open. Keep it ignored and keep the underscore; do not "fix" it into a live gate.

### `src/services/kanbanService.ts`
- **Logic:** `focusTerminal` (`:147`) — finish the fix. `{ silent: true }` landed; add the PTY guard so the focus is skipped entirely for a PTY target, matching the drag path (`TaskViewerProvider.ts:19415`).
- **Edge Cases:** See the `_isLikelyPtyDispatchTarget` staleness note in the Dependency Audit — the snapshot is cold after a reload.

### `src/services/verbSchemas.ts`
- **Logic:** Declare `apiOriginated: { type: 'boolean' }` on the six schemas whose arms already read it — `triggerBatchAction` (`:249`), `moveCardForward` (`:257`), `moveCardBackwards` (`:264`), `moveSelected` (`:271`), `moveAll` (`:278`), `sendDispatchToCoder` (`:370`). Add the new intent field (`target`) wherever the webview starts sending it.
- **Edge Cases:** Permissive and field-accurate per PRD contract #5 — `target` is optional on every arm (its absence is the "compute next stage" case). `validateVerbPayload` (`:` the exported validator) ignores undeclared fields, so this is an accuracy fix, not a break-fix; do not add `required: true` to anything.

### `src/test/kanban-coded-auto-batching-regression.test.js`
- **Logic:** Rewrite. Its `getCodedAutoDropBlock()` anchor comment and all eight substring assertions describe the block being deleted. The replacement pins the new contract: one message per drop carrying `target: 'CODED_AUTO'`, no client-side complexity read, no `resolveCodedAutoTarget` symbol anywhere in `kanban.html`, and `moved[]` consumed from the response.
- **Edge Cases:** Keep it a source-text test (it is cheap and it is what caught this); just re-anchor it. Check the sibling `kanban-coded-auto-drag-out-regression.test.js` and `kanban-coded-auto-prompt-mode-regression.test.js` — both assert on `handleDragStart` / `columnDragDropModes` rather than the drop block, so they should survive, but verify rather than assume.

### `scripts/check-kanban-dispatch-callers.js` (new) + `package.json` + `.github/workflows/integration-tests.yml`
- **Logic:** AST guard failing if any `_handleMessage` arm calls `switchboard.triggerAgentFromKanban` / `triggerBatchAgentFromKanban` directly instead of going through `advanceCards`. This is the ratchet that stops the copies regrowing. Allowlist the four out-of-scope sites named in the scope fence, by name, with the reason inline.
- **Edge Cases:** Must fail on the pre-refactor tree. Declare `typescript` in `devDependencies` — it is in neither `dependencies` nor `devDependencies` at HEAD and currently resolves only as a transitive hoist.

## Verification Plan

### Automated
1. Characterisation tests written **before** the refactor, pinning current behaviour of `moveSelected`, `moveAll`, `triggerAction`, `triggerBatchAction`, `promptOnDrop` and `sendDispatchToCoder`: target columns chosen, delta messages emitted, and their order.
2. A mixed-complexity selection in PLAN REVIEWED splits across `lead` / `coder` / `intern` and dispatches each group to its own column — unchanged before and after.
3. Partial failure: one card fails `moveCardToColumn`; the rest still move and `moveCardsFailed` carries only the failure.
4. Target contract, all three cases: a real column id moves there unrouted; `'CODED_AUTO'` routes per card; `undefined` computes the next stage and routes out of PLAN REVIEWED.
4a. An unscored card is handled identically whether dragged onto `CODED_AUTO` or advanced by button — asserted **twice**, once with `_allowUnknownComplexityAutoMove: true` (both land in `LEAD CODED`) and once with it `false` (both are skipped with the same notice). The default case is the one that changes for users.
4b. `resolveCodedAutoTarget` no longer exists in `kanban.html`; the webview sends `CODED_AUTO` as intent.
4c. A `CODED_AUTO` drop containing one card from `COMPLETED` and one from `PLAN REVIEWED` classifies the first as backward and the second as forward — direction resolution survived moving server-side.
4d. A `CODED_AUTO` drop with `columnDragDropModes['CODED_AUTO'] === 'prompt'` still reaches `promptOnDrop` with the correct `sourceColumn` per card, grouped by source column.
4e. An occupied-but-agent-hidden `INTERN CODED`: a card routed to `intern` degrades to the nearest **visible** role for both drag and button — the client's unconditional `CODER CODED` fallback is gone.
5. An api-originated advance resolves a fleet terminal; an editor-originated advance resolves a VS Code terminal. Same operation, both directions.
6. Batch advance from the browser reaches the fleet.
7. `advanceCards` returns `moved[]` with a resolved `targetColumn` per card, `failures[]`, and `skippedUnknownComplexity` — asserted on the **HTTP body**, not just the push (PRD contract #4).
8. Guard fails when an arm calls the trigger command directly; guard passes with the four allowlisted sites present.
9. Standalone single-card `triggerAction` with a `targetTerminalOverride` delivers to the named terminal (fails today at `bootstrap.ts:826`).
10. The rewritten `kanban-coded-auto-batching-regression.test.js` passes, and its two siblings still pass unmodified.

### Manual (browser cockpit + editor)
1. Advance-selected in a column dispatches to the visible fleet terminal, with no VS Code "terminal not found" toast. *(Already true at HEAD via `ea1077da` — this is a no-regression check now, not the fix.)*
2. Advance-all, drag single, drag batch, send-to-coder — all dispatch correctly from the browser.
3. All of the above in the editor deliver to VS Code terminals exactly as before.
4. Mixed-complexity PLAN REVIEWED selection still splits across columns correctly in both hosts.
5. Drag a card onto a specific coder column — it lands **there**, unrouted, regardless of complexity.
5a. Drag the same card onto the collapsed `CODED_AUTO` column — it routes by complexity, matching what the advance button does for that card.
5b. Drag an **unscored** card onto `CODED_AUTO` — it lands in `LEAD CODED`, the same column the button sends it to (behaviour change: was `CODER CODED`), and is skipped with the "unknown complexity" notice when `_allowUnknownComplexityAutoMove` is off.
5c. Drag a card from `COMPLETED` onto the collapsed `CODED_AUTO` column — it moves backward without dispatching.
5d. With the coder columns **expanded**, repeat 5/5a — the collapsed-only `CODED_AUTO` container is absent and the direct-column path is unaffected.
6. Toggle CLI triggers off — advance moves cards without dispatching, in both hosts.
7. Feature cards: cascade still moves subtasks and the board renders one coherent update.
8. `CODED_AUTO` drop feels no slower than before — the card stays in the collapsed container and does not flicker back while the round-trip completes.

## Recommendation

Complexity 8 → **Send to Lead Coder.** The operation itself is not hard, but it consolidates seventeen independently-evolved copies inside a ~13,000-line provider; it forces a decision on a live drag-vs-button routing divergence that changes the landing column for unscored cards on every default install; deleting the client's resolver pulls direction classification, agent-availability fallback and prompt-mode grouping across the wire with it; and a source-text regression test pins the exact block being removed. Characterisation tests before the refactor are not optional here. The urgency is gone — `ea1077da` cleared the symptom — so this can be sequenced deliberately, which is the right way to run it.
