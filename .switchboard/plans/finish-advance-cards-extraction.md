# Finish the `advanceCards` Extraction — Seventeen Call Sites Still Open-Code It

## Goal

Route every remaining kanban advance affordance through `KanbanProvider._advanceCards`, and widen `scripts/check-kanban-dispatch-callers.js` so it fails when a new arm calls `switchboard.trigger*AgentFromKanban` directly. Today `_advanceCards` exists but is reachable only for `CODED_AUTO`, so the duplication the parent plan was written to delete is still there — with one extra copy added.

### Problem analysis and root cause

`extract-advance-cards-operation.md` shipped the operation and the divergence closure but not the consolidation. Verified in the working tree on 2026-08-10:

- **`_advanceCards` has exactly two call sites, both gated on `CODED_AUTO`.** `triggerAction` (`KanbanProvider.ts:8339`) and `triggerBatchAction` (`:8580`) each open with `if (targetColumn === 'CODED_AUTO' && workspaceRoot …)`. Nothing else calls it.
- **Its second branch is unreachable.** `_advanceCards` (`:7186`) declares a three-way `target` contract — `'CODED_AUTO'` (route per card), a specific column ID (move there unrouted), `undefined` (compute the next stage). Because both call sites pass `target: 'CODED_AUTO'` unconditionally, the specific-target branch (`:7280-7320`) and the `undefined` case have never executed. The unrouted branch also hardcodes `'forward'` in its `recordRunSheetForColumnMove` call, which is wrong for any backward move — a latent bug that is invisible precisely because the branch is dead.
- **Seventeen direct `executeCommand('switchboard.trigger*AgentFromKanban', …)` sites remain**, spread across the arms the parent plan's scope fence named as thin callers:

  | Arm / helper | Line(s) | In parent plan's fence? |
  |---|---|---|
  | `_remoteDispatchColumnAgent` | `:2748` | No — allowlisted (no browser surface) |
  | `_distributePlannerDispatch` | `:5695`, `:5767` | **Yes** |
  | `triggerAction` (non-CODED_AUTO) | `:8508` | **Yes** |
  | `triggerBatchAction` (non-CODED_AUTO) | `:8646` | **Yes** |
  | `julesLowComplexity` | `:9304` | No — allowlisted (fixed role, no move) |
  | `moveSelected` | `:9360`, `:9362`, `:9433`, `:9435` | **Yes** |
  | `moveAll` | `:9504`, `:9506`, `:9577` | **Yes** |
  | `julesSelected` | `:9956` | No — allowlisted |
  | `dispatchAnalyze` | `:10366` | No — allowlisted (dispatches without moving) |
  | `sendDispatchToCoder` | `:10446`, `:10448` | **Yes** |

  Eleven of the seventeen are inside fenced arms. `moveCardForward` (`:8670`) and `moveCardBackwards` (`:8652`) and `promptOnDrop` (`:9075`) are also fenced and still open-code the move/run-sheet/cascade half of the routine even where they do not dispatch.

**Why the guard does not catch this.** `scripts/check-kanban-dispatch-callers.js` asserts four things: `resolveCodedAutoTarget` is absent from `kanban.html`; the drop block sends `targetColumn: 'CODED_AUTO'`; `triggerAction` and `triggerBatchAction` mention `_advanceCards` and `CODED_AUTO`; and `_advanceCards` exists. Every one of those is a statement about the `CODED_AUTO` path. The parent plan specified a guard that *"fails if any `_handleMessage` arm calls `switchboard.triggerAgentFromKanban` / `triggerBatchAgentFromKanban` directly instead of going through `advanceCards`"* with a four-site allowlist. The shipped guard is scoped to what was built, so it is green and will stay green while a nineteenth copy is written — the exact failure mode the parent plan existed to prevent.

**Why this is worth finishing rather than accepting.** The `CODED_AUTO` work closed the *client/server* divergence (webview vs backend complexity routing). It did nothing about the *server/server* divergence the parent plan documented: `moveSelected`'s custom-user branch gates on `dispatchSpec.dragDropMode === 'prompt' || this._cliTriggersEnabled` (`:9385`) while its general branch gates on `this._cliTriggersEnabled && role` (`:9431`) — two different gate rules for one user gesture, still live, still unreconciled. `_advanceCards` now embodies a third rule (`this._cliTriggersEnabled || options.bypassTriggerGate`). Three rules is worse than the two we started with.

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
- **The `_cliTriggersEnabled` reconciliation is a behaviour change, not a refactor.** Three rules exist today. Picking one changes at least one affordance for every install. The custom-user branch's `dragDropMode === 'prompt' || cliTriggersEnabled` is the outlier: it lets a prompt-mode column proceed with triggers off, which is arguably correct (a prompt-mode column copies rather than dispatches, so the anti-accidental-dispatch gate has nothing to guard). Decide explicitly and record which affordance changed; do not let the merge pick one by accident.
- **`moveSelected` and `moveAll` are the two largest arms in the file** (`:9313-9447` and `:9448-9589`) and each has three internal branches (custom-user column, planner distribution, general). Converting them is not a call-site swap — the branch structure has to be expressed as `_advanceCards` options, or the operation grows a discriminator, which is what the parent plan warned against.
- **`promptOnDrop` (`:9075`) is not a dispatch arm but shares the move/run-sheet/cascade half.** Either `_advanceCards` grows a `mode: 'prompt'` that returns the prompt instead of dispatching, or the shared half is extracted separately and both call it. The former risks the five-branch discriminator; the latter leaves two operations. Choose before coding.
- **`_distributePlannerDispatch` (`:5680`) is a helper, not an arm**, and it already owns terminal-bucket rotation that `_advanceCards` knows nothing about. It is the one fenced site where "make it a thin caller" may be the wrong answer; evaluate whether it should instead *call* `_advanceCards` for the move half and keep its own dispatch fan-out.
- **`KanbanProvider.ts` is ~13,000 lines and this touches seventeen sites across it.** One agent stream on this file (PRD orchestration discipline).
- **Byte-compatibility (PRD contract #2).** Every affordance must land cards in the same column as at HEAD except where a divergence is deliberately closed. The `moveCardsFailed` per-card partial-success shape and the `moveCards` emission order are both consumed by the webview's optimistic guard and must not change.

## Edge-Case & Dependency Audit

**Race Conditions**
- `_advanceCards` reads `this._lastCards` for the pre-move column (direction classification) and relies on `moveCardToColumn` **not** mutating it — verified true at HEAD. Any conversion that introduces an awaited refresh mid-loop breaks direction classification silently: every backward move would reclassify as forward and start dispatching.
- `_scheduleBoardRefresh` is debounced 100 ms. Arms that currently push `moveCards` before dispatching and arms that push after must keep their existing order, or the board bounces cards mid-move.

**Security** — no new verb, endpoint or allowlist change.

**Side Effects**
- Centralising the CLI-triggers gate changes when it is evaluated for batch paths. A toggle flipped mid-batch must not produce a partially-dispatched selection.
- `recordRunSheetForColumnMove` and `_collectAllMovedSessionIds` fire per card inside each copy today, in slightly different orders relative to the `moveCards` push. Normalising the order is required and is exactly the change that silently alters what the board renders mid-move.

**Dependencies & Conflicts**
- Depends on the *One Board Operation Layer* feature having landed (it has).
- ⚠ *Kanban Move Addressing and Honest Failure Reporting* also edits `moveCardToColumn`'s signature. Serialise.
- `scripts/check-kanban-dispatch-callers.js` is edited by this plan only.

## Dependencies

None (hard). Sequence after *Kanban Move Addressing and Honest Failure Reporting* if that feature is still in flight.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is that "finish the extraction" is read as a mechanical call-site sweep when it is actually three unresolved design decisions wearing a refactor's clothes: which of the three `_cliTriggersEnabled` rules wins, how `moveSelected`/`moveAll`'s three-way branch structure maps onto `_advanceCards`' options without growing a discriminator, and whether `promptOnDrop` and `_distributePlannerDispatch` belong inside the operation at all. Deciding those mid-code produces an operation with a `kind` parameter and five branches — a fourth copy with better naming. The second risk is that the widened guard is authored to pass against the post-conversion tree without ever being run against the pre-conversion tree, so it never proves it can fail. Mitigations: settle the three decisions in writing before the first edit; write the guard first and confirm it goes **red** at HEAD; pin the current per-affordance landing column and delta-message order with characterisation tests before converting anything; convert one arm per commit.

## Proposed Changes

### `scripts/check-kanban-dispatch-callers.js`
- **Context:** Four assertions, all about the `CODED_AUTO` path. Green while sixteen non-CODED_AUTO copies exist.
- **Logic:** Keep the four existing assertions. Add a per-file occurrence ratchet over `KanbanProvider.ts`: count direct `executeCommand('switchboard.triggerAgentFromKanban'` / `'switchboard.triggerBatchAgentFromKanban'` matches, subtract the sites inside `_advanceCards`, and assert the remainder is ≤ a declared ceiling that only ratchets down. Declare the four out-of-scope sites by name with the reason inline: `_remoteDispatchColumnAgent` (private helper, no browser surface), `julesLowComplexity` and `julesSelected` (fixed role, no column move), `dispatchAnalyze` (dispatches without moving).
- **Edge Cases:** Must fail on the pre-conversion tree — run it before converting anything and record the starting count in the plan's completion summary. A ceiling authored from the post-conversion tree proves nothing.

### `src/services/KanbanProvider.ts`
- **Context:** `_advanceCards` (`:7186`) with two `CODED_AUTO`-only callers; seventeen direct trigger sites; three different `_cliTriggersEnabled` readings.
- **Logic:** Convert the fenced arms to `_advanceCards` callers in this order, one per commit: `moveCardForward` / `moveCardBackwards` (smallest, exercise the specific-target branch and kill its `'forward'` hardcode) → `sendDispatchToCoder` → `triggerAction` / `triggerBatchAction` non-CODED_AUTO paths → `moveSelected` → `moveAll` → `promptOnDrop`. Reconcile the three `_cliTriggersEnabled` rules into one and state which affordance changed. Evaluate `_distributePlannerDispatch` last and separately — it may legitimately remain a caller of the move half only.
- **Edge Cases:** Preserve per-card partial failure, the exact `moveCards` / `moveCardsFailed` payload shapes, and emission order. `_advanceCards`' specific-target branch must classify direction per card rather than hardcoding `'forward'` once it has a real caller.

### `src/test/` (characterisation tests, written first)
- **Context:** No test pins the current per-affordance landing column or delta order.
- **Logic:** Before any conversion, pin for `moveSelected`, `moveAll`, `triggerAction`, `triggerBatchAction`, `promptOnDrop` and `sendDispatchToCoder`: the target column chosen for a fixed card set, the delta messages emitted, and their order. These are the tests that make the conversion reviewable.

## Verification Plan

### Automated
1. The widened guard **fails** on the pre-conversion tree (record the starting direct-call count) and passes after each conversion commit with a lowered ceiling.
2. Characterisation tests from Proposed Changes pass unchanged before and after every conversion commit.
3. A mixed-complexity `PLAN REVIEWED` selection still splits across lead / coder / intern and dispatches each group to its own column.
4. Partial failure: one card fails `moveCardToColumn`; the rest still move and `moveCardsFailed` carries only that card — asserted per complexity group, not cumulatively.
5. Target contract, all three cases exercised by a real caller: a specific column ID moves there unrouted with correct per-card direction; `'CODED_AUTO'` routes per card; `undefined` computes the next stage.
6. A backward move via the specific-target branch records `direction: 'backward'` in the run sheet and does not dispatch.
7. CLI triggers off: every converted affordance moves cards without dispatching, and `bypassTriggerGate` still dispatches. One rule, asserted across all affordances.
8. Existing gates stay green: `catalog:check`, `parity:check`, `push-routing:check`, `standalone-parity:check`, `standalone-fork:check`, `kanban-dispatch-callers:check`, `verb-returns:check`, and the full `test:contract:*` suite.

### Manual (browser cockpit + editor)
1. Advance-selected, advance-all, drag single, drag batch, send-to-coder, prompt-on-drop — all land cards in the same columns as before, in both hosts.
2. Drag onto a specific coder column: lands there, unrouted, regardless of complexity.
3. Drag onto collapsed `CODED_AUTO`: routes by complexity, matching what the advance button does for the same card.
4. Drag from `COMPLETED` onto `CODED_AUTO`: moves backward without dispatching.
5. Toggle CLI triggers off: every affordance moves without dispatching. `POST /kanban/dispatch` still dispatches.
6. Feature cards: cascade still moves subtasks and the board renders one coherent update.

## Recommendation

Complexity 8 → **Send to Lead Coder.** The call-site swap is mechanical; the three decisions underneath it are not, and getting any of them wrong moves cards for every affordance at once inside a ~13,000-line provider. The guard must be proven to fail before it is trusted, and the characterisation tests are the only thing that makes the conversion reviewable at all.
