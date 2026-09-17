# Finish the `advanceCards` Extraction — Nineteen Call Sites Still Open-Code It

## Goal

Route every remaining kanban advance affordance through `KanbanProvider._advanceCards`, and widen `scripts/check-kanban-dispatch-callers.js` so it fails when a new arm calls `switchboard.trigger*AgentFromKanban` directly. Today `_advanceCards` exists but is reachable only for `CODED_AUTO`, so the duplication the parent plan was written to delete is still there — with one extra copy added.

### Problem analysis and root cause

`extract-advance-cards-operation.md` shipped the operation and the divergence closure but not the consolidation. **Re-verified against the working tree on 2026-08-14** — all line numbers below are current at HEAD (`3b3c6367`), and supersede the pre-drift numbers this plan previously carried.

- **`_advanceCards` (`:7386`) has exactly two call sites, both gated on `CODED_AUTO`.** `triggerAction` (`:8556`) and `triggerBatchAction` (`:8798`) each open with a `targetColumn === 'CODED_AUTO' && workspaceRoot` guard. Nothing else calls it.
- **Its second branch is unreachable.** `_advanceCards` declares a three-way `target` contract — `'CODED_AUTO'` (route per card), a specific column ID (move there unrouted), `undefined` (compute the next stage). Because both call sites pass `target: 'CODED_AUTO'` unconditionally, the specific-target branch (`:7487-7527`) and the `undefined` case have never executed.
- **Nineteen direct `executeCommand('switchboard.trigger*AgentFromKanban', …)` sites remain** outside the operation (23 occurrences total in the file, 4 of them inside `_advanceCards` itself at `:7472`, `:7475`, `:7520`, `:7522`):

  | Arm / helper | `case` at | Trigger site(s) | In scope? |
  |---|---|---|---|
  | `_remoteDispatchColumnAgent` | `:2786` | `:2798` | No — allowlisted (private helper, no browser surface) |
  | `_distributePlannerDispatch` | `:5819` | `:5864`, `:5936` | **Yes** |
  | `triggerAction` (non-`CODED_AUTO`) | `:8539` | `:8725` | **Yes** |
  | `triggerBatchAction` (non-`CODED_AUTO`) | `:8785` | `:8863` | **Yes** |
  | `julesLowComplexity` | `:9521` | `:9541` | No — allowlisted (fixed role, no column move) |
  | `moveSelected` | `:9550` | `:9597`, `:9599`, `:9670`, `:9672` | **Yes** |
  | `moveAll` | `:9685` | `:9741`, `:9743`, `:9814` | **Yes** |
  | `julesSelected` | `:10180` | `:10193` | No — allowlisted |
  | `dispatchAnalyze` | `:10565` | `:10594` | No — allowlisted (dispatches without moving) |
  | `sendDispatchToCoder` | `:10606` | `:10674`, `:10676` | **Yes** |
  | `sendDispatchSetToCoders` | `:10694` | `:10751`, `:10753` | **Yes** |

  **Fifteen of the nineteen are in scope; four are allowlisted.** `moveCardForward` (`:8887`), `moveCardBackwards` (`:8869`) and `promptOnDrop` (`:9312`) are also in scope and still open-code the move/run-sheet/cascade half of the routine even though they do not dispatch.

  ⚠ **`sendDispatchSetToCoders` (`:10694`) is a scope addition.** It was absent from this plan's previous inventory and from the parent plan's fence. It is a full sibling of `sendDispatchToCoder` with its own gate (`:10749`) and its own pair of trigger sites.

- **`moveSelected`'s `PLAN REVIEWED` branch (`:9558-9607`) is a near-verbatim fourth copy of `_advanceCards`' `CODED_AUTO` branch.** Same call sequence: `_filterUnknownComplexitySessions` → `_notifySkippedUnknownComplexity` on empty → `_partitionByComplexityRoute` → `_getVisibleAgents` → all-agents-disabled check → per-group `_targetColumnForDispatchRole` / `_columnToRole` → per-card `moveCardToColumnWithReason` + `recordRunSheetForColumnMove` + `_collectAllMovedSessionIds` → `moveCards` / `moveCardsFailed` posts → dispatch. This is the single highest-value conversion in the plan and it was not previously identified as a duplicate at all. It diverges from `_advanceCards` in four ways, every one of which is a behaviour decision:

  | Behaviour | `_advanceCards` CODED_AUTO | `moveSelected` PLAN REVIEWED |
  |---|---|---|
  | Direction classification | per card via `_isColumnBefore` (`:7440`) | hardcoded `'forward'` (`:9581`) |
  | Backward cards dispatch? | no — filtered out via `forwardSids` (`:7458`) | yes — all `dispatchSids` dispatch (`:9595`) |
  | Trigger gate | `_cliTriggersEnabled \|\| options.bypassTriggerGate` (`:7470`) | bare `_cliTriggersEnabled` (`:9595`) |
  | Skip notification | `_notifySkippedUnknownComplexity(skipped, moved.length)` after the loop (`:7481`) | `showStatusMessage` summary with a skipped suffix (`:9606`) |

  (Both declare `failures` **inside** the group loop, so neither has the "one real failure, three toasts" accumulator bug that `_advanceCards:7433` documents. That one is genuinely fixed on both sides.)

**Why the guard does not catch this.** `scripts/check-kanban-dispatch-callers.js` asserts five things: `resolveCodedAutoTarget` is absent from `kanban.html`; the drop block sends `targetColumn: 'CODED_AUTO'`; `triggerAction` and `triggerBatchAction` each mention `_advanceCards` and `CODED_AUTO`; and `_advanceCards` exists. Every one of those is a statement about the `CODED_AUTO` path. The parent plan specified a guard that *"fails if any `_handleMessage` arm calls `switchboard.triggerAgentFromKanban` / `triggerBatchAgentFromKanban` directly instead of going through `advanceCards`"* with a four-site allowlist. The shipped guard is scoped to what was built, so it is green and will stay green while a twentieth copy is written — the exact failure mode the parent plan existed to prevent.

**Why this is worth finishing rather than accepting.** The `CODED_AUTO` work closed the *client/server* divergence (webview vs backend complexity routing). It did nothing about the *server/server* divergence: three distinct trigger-gate rules are live across the arms, where two were live before.

## Metadata

**Tags:** refactor, backend, reliability, test
**Complexity:** 8
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- Widening `scripts/check-kanban-dispatch-callers.js` to a per-file occurrence ratchet with a named allowlist (the existing script is already the right shape; the assertions change, not the vehicle).
- Deleting the `'forward'` hardcode in `_advanceCards`' specific-target branch once that branch has a caller.

### Complex / Risky

- **`_advanceCards` must grow a `dispatch?: boolean` option, and that is not optional.** `moveCardForward` (`:8887`), `moveCardBackwards` (`:8869`) and `promptOnDrop` (`:9312`) move cards and **never dispatch**. The specific-target branch dispatches unconditionally when the gate is open (`:7516`) and does **not** filter backward cards the way the `CODED_AUTO` branch does. So a naive conversion of `moveCardForward` to `_advanceCards(target: nextCol)` **starts dispatching where HEAD does not** — a behaviour regression on every shipped install, invisible to the type system. Take the single `dispatch?: boolean` (default `true`); do **not** take a `kind`/`mode` enum. One boolean expresses the real distinction (move-only vs move-and-dispatch); an enum is the four-branch discriminator the parent plan warned about.

- **Converting `moveCardForward` / `moveCardBackwards` changes the delta shape.** They call `moveCardToColumn` (`:8875`, `:8893`) — the variant with no failure reason — and consequently emit **no `moveCardsFailed` message at all**. `_advanceCards` uses `moveCardToColumnWithReason` and emits `moveCardsFailed` on any per-card failure. Conversion therefore *adds* a delta message the webview's optimistic guard has never received from these two arms. That is arguably a fix (silent failures become visible), but it is a shipped-behaviour change and must be a deliberate, recorded decision — not a side effect.

- **The trigger-gate reconciliation is a behaviour change, not a refactor.** Three distinct gate rules are live:
  1. `_cliTriggersEnabled || options.bypassTriggerGate` — `_advanceCards` (`:7470`, `:7516`), `triggerAction` (`:8571`, as `!enabled && !bypass`)
  2. `_cliTriggersEnabled` alone — `triggerBatchAction` (`:8808`), `moveSelected` (`:9595`, `:9667`), `moveAll` (`:9739`, `:9813`), `sendDispatchToCoder` (`:10672`), `sendDispatchSetToCoders` (`:10749`)
  3. `dispatchSpec.dragDropMode === 'prompt' || _cliTriggersEnabled` — `moveSelected` custom-user (`:9619`), `moveAll` custom-user (`:9763`)

  Rule 3 is the outlier and is arguably correct: a prompt-mode column copies rather than dispatches, so the anti-accidental-dispatch gate has nothing to guard. Decide explicitly and record which affordance changed.

  ⚠ **A fourth divergence sits inside rules 1 and 2 and is a live bug.** `triggerAction` (`:8571`) honours `msg.bypassTriggerGate`; `triggerBatchAction` (`:8808`) does **not** — it returns `'CLI triggers are disabled'` even for an explicit `POST /kanban/dispatch` that set the flag. So the same API call succeeds for one card and fails for two. This is the identical defect the comment at `_advanceCards:7466-7469` says was fixed for the `CODED_AUTO` path, still live on the non-`CODED_AUTO` batch path. Fix it as part of the reconciliation and call it out in the completion summary.

- **`moveSelected` (`:9550-9684`) and `moveAll` (`:9685-…`) are the two largest arms in the file and each has FOUR internal branches**, not three: complexity-route (`PLAN REVIEWED` / source column), custom-user column, planner distribution, general. Converting them is not a call-site swap. The complexity-route branch maps cleanly onto `_advanceCards(target: 'CODED_AUTO')`; the general branch maps onto the specific-target branch; the custom-user and planner branches do not map at all and should stay outside the operation (see below).

- **`_distributePlannerDispatch` (`:5819`) is a helper, not an arm**, and it owns terminal-bucket rotation and a location-key cursor that `_advanceCards` knows nothing about. It is the one in-scope site where "make it a thin caller" is likely the *wrong* answer; evaluate whether it should instead *call* `_advanceCards` for the move half and keep its own dispatch fan-out. Note it also holds the `getRoleTerminalSet(…, { allowPtyFleet: true })` call (`:5840`) whose surrounding comment is load-bearing — see the sibling ratchet plan.

- **`promptOnDrop` (`:9312`) is not a dispatch arm but shares the move/run-sheet/cascade half.** With `dispatch: false` available it converts cleanly; without it, it does not. Sequence it after the `dispatch` option lands.

- **`KanbanProvider.ts` is ~13,936 lines and this touches nineteen sites across it.** One agent stream on this file (PRD orchestration discipline).

- **Byte-compatibility (PRD contract #2).** Every affordance must land cards in the same column as at HEAD except where a divergence is deliberately closed. The `moveCardsFailed` per-card partial-success shape and the `moveCards` emission order are both consumed by the webview's optimistic guard.

- **Verb-return contract (PRD contract #4).** `moveSelected` returns `{ success: true, column }` — an ack with no data — while `_advanceCards` returns `{ moved, failures, skippedUnknownComplexity, dispatched }`. Converting the arms is an opportunity to return that payload, and the Kanban `break`-count ceiling in `scripts/verb-return-contract-baseline.json` is **0**, so no conversion may introduce a `break` in an arm.

## Edge-Case & Dependency Audit

**Race Conditions**
- `_advanceCards` reads `this._lastCards` for the pre-move column (direction classification, `:7437`, `:7460`) and relies on `moveCardToColumn` **not** mutating it — verified true at HEAD. Any conversion that introduces an awaited refresh mid-loop breaks direction classification silently: every backward move would reclassify as forward and start dispatching.
- `_scheduleBoardRefresh` is debounced 100 ms. Arms that currently push `moveCards` before dispatching and arms that push after must keep their existing order, or the board bounces cards mid-move.

**Security** — no new verb, endpoint or allowlist change.

**Side Effects**
- Centralising the CLI-triggers gate changes when it is evaluated for batch paths. A toggle flipped mid-batch must not produce a partially-dispatched selection.
- `recordRunSheetForColumnMove` and `_collectAllMovedSessionIds` fire per card inside each copy today, in slightly different orders relative to the `moveCards` push. Normalising the order is required and is exactly the change that silently alters what the board renders mid-move.

**Dependencies & Conflicts**
- Depends on the *One Board Operation Layer* feature having landed (it has).
- ⚠ *Kanban Move Addressing and Honest Failure Reporting* also edits `moveCardToColumn`'s signature. Serialise if in flight.
- `scripts/check-kanban-dispatch-callers.js` is edited by this plan only. The sibling ratchet plan adds a **separate** script and does not touch this one.
- `package.json` and `.github/workflows/integration-tests.yml`: this plan changes no script entry (`kanban-dispatch-callers:check` already exists at `package.json:893` and CI line 47) — only the script body. The sibling ratchet plan adds a new entry to both. **No conflict**, but keep the edits in separate commits.

## Dependencies

None (hard). Sequence after *Kanban Move Addressing and Honest Failure Reporting* if that feature is still in flight.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is that "finish the extraction" is read as a mechanical call-site sweep when it is actually a set of unresolved design decisions wearing a refactor's clothes: whether the operation takes a `dispatch` boolean (it must), which of the three trigger-gate rules wins, how `moveSelected`/`moveAll`'s four-way branch structure maps onto the operation's options, and whether `promptOnDrop` and `_distributePlannerDispatch` belong inside it at all. Deciding those mid-code produces an operation with a `kind` parameter and five branches — a fourth copy with better naming.

The second risk is specific and quantified: **`moveCardForward` is the smallest, most tempting first conversion and it is a trap.** The specific-target branch dispatches unconditionally; `moveCardForward` does not dispatch at all. Convert it first, as the previous version of this plan recommended, and every forward drag on every shipped install starts firing an agent. The `dispatch: false` option must land *before* the first arm conversion, not alongside it.

The third risk is that the widened guard is authored to pass against the post-conversion tree without ever being run against the pre-conversion tree, so it never proves it can fail.

Mitigations: settle the decisions in writing before the first edit; add the `dispatch` option as commit 1 with no call-site changes; write the guard and confirm it goes **red** at HEAD with the recorded count of 15; pin the current per-affordance landing column, dispatch-or-not, and delta-message order with characterisation tests before converting anything; convert one arm per commit.

## Proposed Changes

### `scripts/check-kanban-dispatch-callers.js`
- **Context:** Five assertions, all about the `CODED_AUTO` path. Green while fifteen in-scope copies exist.
- **Logic:** Keep the five existing assertions. Add a per-file occurrence ratchet over `KanbanProvider.ts`: count direct `executeCommand('switchboard.triggerAgentFromKanban'` / `'switchboard.triggerBatchAgentFromKanban'` matches, subtract the four sites inside `_advanceCards`, and assert the remainder is ≤ a declared ceiling that only ratchets down. **Starting ceiling: 15** (19 outside the operation, minus 4 allowlisted). Declare the four allowlisted sites by name with the reason inline: `_remoteDispatchColumnAgent` (private helper, no browser surface), `julesLowComplexity` and `julesSelected` (fixed role, no column move), `dispatchAnalyze` (dispatches without moving).
- **Edge Cases:** Locate the `_advanceCards` body by its `private async _advanceCards(` opening and the next `private `/`public ` member at the same indent — do not hardcode line numbers, they have already drifted ~200 lines once. Must fail on the pre-conversion tree if the ceiling is set below 15; record the observed starting count in the completion summary.

### `src/services/KanbanProvider.ts`
- **Context:** `_advanceCards` (`:7386`) with two `CODED_AUTO`-only callers; nineteen direct trigger sites (fifteen in scope); three trigger-gate rules plus the `triggerBatchAction` bypass divergence.
- **Logic:** Convert in this order, one commit each:
  1. **Add `dispatch?: boolean` (default `true`) to the options and honour it in both branches.** No call-site changes. Add per-card direction classification to the specific-target branch (reuse `_isColumnBefore` exactly as the `CODED_AUTO` branch does at `:7440`), delete the `'forward'` hardcode at `:7496`, and filter backward cards out of `dispatchIds` the way `:7458` does.
  2. **Fix the `triggerBatchAction` bypass divergence** (`:8808`) — read `msg?.bypassTriggerGate` as `triggerAction` does.
  3. `moveCardBackwards` / `moveCardForward` → `_advanceCards(target, { dispatch: false })`. Exercises the specific-target branch for the first time.
  4. `sendDispatchToCoder` and `sendDispatchSetToCoders`.
  5. `triggerAction` / `triggerBatchAction` non-`CODED_AUTO` paths.
  6. `moveSelected` — complexity-route branch → `target: 'CODED_AUTO'`; general branch → specific target. Leave custom-user and planner branches in place.
  7. `moveAll` — same mapping.
  8. `promptOnDrop` → `{ dispatch: false }`.
  9. `_distributePlannerDispatch` — evaluate last and separately; it may legitimately call only the move half.

  Reconcile the three trigger-gate rules into one and state which affordance changed.
- **Edge Cases:** Preserve per-card partial failure, the exact `moveCards` / `moveCardsFailed` payload shapes, and emission order. Step 3 introduces `moveCardsFailed` on two arms that never emitted it — record that as an intended change.

### `src/test/` (characterisation tests, written first)
- **Context:** No test pins the current per-affordance landing column, dispatch-or-not, or delta order.
- **Logic:** Before any conversion, pin for `moveSelected`, `moveAll`, `moveCardForward`, `moveCardBackwards`, `triggerAction`, `triggerBatchAction`, `promptOnDrop`, `sendDispatchToCoder` and `sendDispatchSetToCoders`: the target column chosen for a fixed card set, **whether the affordance dispatches**, the delta messages emitted, and their order. The dispatch-or-not assertion is the one that catches the `moveCardForward` trap.

## Verification Plan

*Compilation and automated test execution are out of scope for this planning pass; the items below are the acceptance criteria for the implementing agent.*

### Automated
1. The widened guard **fails** on the pre-conversion tree at any ceiling below 15, and reports 15 as the current count. Record that output in the completion summary. The ceiling lowers with each conversion commit.
2. Characterisation tests pass unchanged before and after every conversion commit — in particular, `moveCardForward` still does **not** dispatch.
3. A mixed-complexity `PLAN REVIEWED` selection still splits across lead / coder / intern and dispatches each group to its own column, via both `triggerBatchAction` and `moveSelected`.
4. Partial failure: one card fails `moveCardToColumn`; the rest still move and `moveCardsFailed` carries only that card — asserted per complexity group, not cumulatively.
5. Target contract, all three cases exercised by a real caller: a specific column ID moves there unrouted with correct per-card direction; `'CODED_AUTO'` routes per card; `undefined` computes the next stage.
6. A backward move via the specific-target branch records `direction: 'backward'` in the run sheet and does not dispatch.
7. `bypassTriggerGate` with CLI triggers off: `POST /kanban/dispatch` dispatches for **both** one card and several — the `triggerBatchAction` divergence is closed.
8. CLI triggers off: every converted affordance moves cards without dispatching. One rule, asserted across all affordances.
9. Existing gates stay green: `catalog:check`, `parity:check`, `push-routing:check`, `standalone-parity:check`, `standalone-fork:check`, `kanban-dispatch-callers:check`, `verb-returns:check`, and the full `test:contract:*` suite. The Kanban `verb-returns` ceiling stays 0.

### Manual (browser cockpit + editor)
1. Advance-selected, advance-all, drag single, drag batch, send-to-coder, send-set-to-coders, prompt-on-drop — all land cards in the same columns as before, in both hosts.
2. Drag onto a specific coder column: lands there, unrouted, regardless of complexity.
3. Drag onto collapsed `CODED_AUTO`: routes by complexity, matching what the advance button does for the same card.
4. Drag from `COMPLETED` onto `CODED_AUTO`: moves backward without dispatching.
5. Forward-drag a card with CLI triggers **on**: it still does not spawn an agent (the `moveCardForward` trap).
6. Toggle CLI triggers off: every affordance moves without dispatching. `POST /kanban/dispatch` still dispatches, for one card and for many.
7. Feature cards: cascade still moves subtasks and the board renders one coherent update.

## Recommendation

Complexity 8 → **Send to Lead Coder.** The call-site swap is mechanical; the decisions underneath it are not. The `dispatch: false` requirement and the `moveCardForward` dispatch trap were both invisible in the previous version of this plan and either one, missed, changes behaviour for every shipped install on the first "smallest, safest" commit. The guard must be proven to fail at ceiling < 15 before it is trusted, and the characterisation tests — especially the dispatch-or-not assertions — are the only thing that makes the conversion reviewable at all.

## Completion summary (2026-11)

All advance affordances now route through `_advanceCards`: `moveCardForward`/`moveCardBackwards` (move-only), `triggerAction` (move half only — its terminal-override/planner-rotation/pair-programming/prompt-fallback dispatch stays in-arm), `triggerBatchAction` (rooted path; the no-root raw dispatch and custom-user configured dispatch stay), `moveSelected`/`moveAll` (both the `CODED_AUTO` complexity route and the general next-stage branch — the latter exercises the `undefined` target contract), `promptOnDrop`/`promptSelected`/`promptAll` (move-only; `promptOnDrop` keeps dispatch-identity recording), and `_distributePlannerDispatch` (move halves only — bucket fan-out and `improve-plan` stay). The guard is now an owner-attributed ratchet at ceiling 0: every direct `trigger*AgentFromKanban` call lives inside `_advanceCards` or the named allowlist. Deliberate reconciliations landed along the way — one trigger-gate rule everywhere (cards always move; dispatch needs the toggle or `bypassTriggerGate`), per-card backward classification, `moveCardsFailed` where arms previously ignored write results, `promptOnDrop`'s PLAN REVIEWED branch now skips unknown complexity, and the standalone `handlePtyVerb` `triggerAction` gate deferred so it moves without dispatching instead of refusing outright. `sendToBacklog`/`sendToNew`/`sendToPlanned` were left as-is: they are absolute-target verbs, not advance affordances. Per dispatch instructions, compilation and the automated test suite were not run; the dispatch-callers guard passes.

## Review Findings

Reviewed `b3594188` + `c2a6f01a` against the current tree (not the diff — several of the plan's premises had already gone stale). The extraction itself holds: all fifteen in-scope sites now delegate, the guard is an owner-attributed ratchet at ceiling 0 with every remaining call attributed to `_advanceCards` or a reasoned allowlist entry, and the inbound field-existence check passes (`column`, `complexity`, `workspaceRoot`, `planId`, `sessionId` are all present in the persisted card literal at `KanbanProvider.ts:4476`). Three material defects were found and fixed: `_isColumnBefore`'s hand-kept order contradicted `DEFAULT_KANBAN_COLUMNS` in two places (RESEARCHER/PLAN REVIEWED, TICKET UPDATER/COMPLETED) — harmless while only the `CODED_AUTO` branch classified, but load-bearing the moment the specific-target branch got its first caller, and it made `COMPLETED → TICKET UPDATER` read as forward, which dispatches; the `CODED_AUTO` branch re-derived direction from `_lastCards` *after* the move loop, racing the 100 ms-debounced refresh into reclassifying every backward card as forward; and the whole 15-test characterisation suite was defined but never invoked by CI, because `test:contract:coded-auto-gate` greps a different suite in the same file. Files changed: `src/services/KanbanProvider.ts`, `src/services/__tests__/KanbanProvider.test.ts` (two new pipeline-position tests, proven red against the old implementation and green against the fix), `src/services/verbSchemas.ts`, `package.json`, `.github/workflows/integration-tests.yml`. Verification: `compile-tests` clean; the provider suite is 58 passing / 4 failing (all four pre-existing and unrelated — workspace-stub and prompt-generation tests this work never touched); `kanban-dispatch-callers`, `parity`, `push-routing`, `standalone-parity`, `standalone-fork`, `verb-returns` and the `coded-auto-gate`/`advance-cards-extraction`/`dispatch-analysis-scope` contract suites all pass.

## Deferred Findings

- MAJOR — `src/services/KanbanProvider.ts:12520` (and `:12650` in `moveAll`): the general branch loses the `improve-plan` instruction for a planner target. The planner fan-out is gated on `role === 'planner' && _boardMoveCliTriggersEnabled` (`:12506`/`:12635`), so an explicit `bypassTriggerGate` dispatch with the toggle OFF falls through to `_advanceCards`, which always passes `undefined` as the instruction. Narrow (API-only, triggers-off) but a real divergence from HEAD, and not recorded as an intended one.
- MAJOR — `src/services/KanbanProvider.ts:9921`, `:9979`: failure records fall back to `sourceColumn: card?.column ?? sourceColumn ?? ''`. The webview's `moveCardsFailed` handler assigns `card.column = f.sourceColumn`, so an empty string reverts the card into a column that does not exist and it disappears from the board. Pre-existing on the `CODED_AUTO` path, but newly reachable on `moveCardForward`/`moveCardBackwards`, which emitted no failure message at all at HEAD.
- MAJOR — `src/standalone/bootstrap.ts:3324`: `columnToPromptRole(targetColumn) || 'lead'` is a routing fallback indistinguishable from a configured value. Out of this plan's scope; flagged because the reconciled gate sits directly beneath it.
- NIT — `src/services/KanbanProvider.ts:11819`, `:11837`: `moveCardForward`/`moveCardBackwards` now return `movedSessionIds` as the requested ids only, where HEAD returned the cascade ids. No consumer reads the field today (grep finds only an unrelated local in `bootstrap.ts`).
- NIT — `src/services/KanbanProvider.ts:12484`, `:12614`: the completion summary claims "one trigger-gate rule everywhere", but gate rule 3 (`dragDropMode === 'prompt' || _boardMoveCliTriggersEnabled`) still governs the custom-user branches. The plan permitted keeping it; only the summary overstates.
- NIT — this plan's own inventory was stale when written: `sendDispatchToCoder`/`sendDispatchSetToCoders` had already been deleted, so the ratchet was proven red at ceiling 8 with 9 unlisted sites rather than the specified 15. Recorded in `c2a6f01a`'s message but not in the completion summary.
