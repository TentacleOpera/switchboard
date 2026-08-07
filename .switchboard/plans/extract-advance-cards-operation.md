# Extract One `advanceCards` Operation — Eighteen Copies of the Same Routine

## Metadata

**Complexity:** 7
**Tags:** refactor, bugfix, backend, reliability

## Goal

Replace the eighteen hand-written copies of the kanban "advance these cards" routine with a single operation that every UI affordance calls. Today each button and the drag handler open-codes the same nine-step sequence, so any change to dispatch semantics has to be made eighteen times — and the most recent one was made once.

### Problem analysis and root cause

**The observed bug (verified live, 2026-08-07).** In the browser cockpit served by the extension host, board drag-and-drop dispatches correctly to the PTY fleet while the advance-selected buttons on the same page fail with a VS Code "terminal not found" toast. Same page, same transport, same verb rail, same provider.

**The mechanism.** `switchboard.triggerAgentFromKanban` (`src/extension.ts:1644`) takes the calling surface as its **sixth positional argument**:

```typescript
registerSwitchboardCommand('switchboard.triggerAgentFromKanban',
    async (role, sessionId, instruction?, workspaceRoot?, targetTerminalOverride?, apiOriginated?, bypassTriggerGate?) =>
        taskViewerProvider.handleKanbanTrigger(role, sessionId, instruction, workspaceRoot,
            { targetTerminalOverride, persistColumnOnError: true, apiOriginated: !!apiOriginated, ... }));
```

That command has **18 call sites in `src/services/KanbanProvider.ts`**. Exactly **one** passes the sixth argument:

| Site | Path | Surface argument |
|---|---|---|
| `:8243` | `triggerAction` — the drag | ✅ `!!msg?.apiOriginated` |
| `:9075` `:9077` | `moveSelected` — advance selected | ❌ |
| `:9148` `:9150` `:9219` `:9221` | `moveAll` — advance all | ❌ |
| `:2706` `:5634` `:5706` `:8361` `:9019` `:9292` `:9671` `:10068` `:10145` `:10147` `:10181` | everything else | ❌ |

`moveSelected` (`:9074-9078`) calls it with four arguments. `apiOriginated` arrives `undefined`, `allowPtyFleet` resolves `false`, `_resolveAgentTerminalForPlan` skips the fleet branch entirely (`TaskViewerProvider.ts:8347`), a VS Code terminal is resolved instead, and the browser user gets a toast about a terminal they cannot see.

Worse: `switchboard.triggerBatchAgentFromKanban` (`extension.ts:1664`) has **no `apiOriginated` parameter at all** — its signature ends at `targetTerminalOverride`. Batch advance is structurally incapable of reaching the fleet, so threading arguments at the call sites cannot fix it.

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

`CODED_AUTO` is the aggregate the three coder columns collapse into (`kanban.html:4222-4225`, `:5500`). Dropping a card on it means "route this to the right coder", which is exactly the complexity decision. Dropping on an expanded, specific coder column means "put it here" and must stay unrouted.

**The real defect: complexity routing is implemented twice, and the two disagree.**

| | Client — `resolveCodedAutoTarget` (`kanban.html:7176`) | Backend — `_resolveComplexityRoutedRole` (`KanbanProvider.ts`) |
|---|---|---|
| Reached by | drag onto `CODED_AUTO` | advance buttons |
| Routing disabled → | `'LEAD CODED'` | `'lead'` (equivalent) |
| Complexity source | `card.complexity` from the board payload | `planFile` read from the DB, with a run-sheet fallback |
| **Unscored / `NaN` complexity →** | **`'CODER CODED'` — the card moves** | **`_filterUnknownComplexitySessions` skips it — the card does not move**, unless `_allowUnknownComplexityAutoMove` |
| `INTERN CODED` hidden → | falls back to `'CODER CODED'` | `_targetColumnForDispatchRole(role, visibleAgents)` |

So an unscored card dragged onto `CODED_AUTO` lands in `CODER CODED`, while the same card advanced via the button is refused with an "unknown complexity" notice. Same decision, two implementations, two answers — and the client's copy reads a payload field while the server's reads the database.

That is the divergence the extraction must close: routing belongs on the server, once. The webview should send **intent** (`CODED_AUTO` = "route this"), never a pre-resolved target, and `resolveCodedAutoTarget` should be deleted.

## User Review Required

None.

## Complexity Audit

### Routine
- Mechanical replacement of eighteen call sites once the operation exists.
- Adding the missing `apiOriginated` parameter to `triggerBatchAgentFromKanban`.

### Complex / Risky
- **The target contract is three-way, and getting it wrong moves cards for every affordance at once.** `target: <columnId>` → move there, no routing. `target: 'CODED_AUTO'` → complexity-route per card. `target: undefined` → compute the next stage (which for PLAN REVIEWED means routing). Collapsing this to a boolean "explicit vs computed" loses the distinction between "I dropped it on LEAD CODED" and "I dropped it on the collapsed coder column", and would start routing drops the user made deliberately.
- **Moving routing server-side changes behaviour for unscored cards — deliberately.** Today the client's `resolveCodedAutoTarget` sends an unscored card to `CODER CODED`, while the backend refuses to advance it. Once the server owns the decision, one of those wins. **Recommended: the server's** — `_filterUnknownComplexitySessions` exists so unscored work is not silently dispatched to a coder, and `_allowUnknownComplexityAutoMove` is the user's opt-out. That means a drag onto `CODED_AUTO` will start skipping unscored cards with the same notice the button gives. Release-note it; it will look like a regression to anyone who relied on the drag.
- **Deleting `resolveCodedAutoTarget` (`kanban.html:7176`) is part of the change, not a follow-up.** Leaving it means the client can still pre-resolve a target and the two implementations persist. The webview must send `CODED_AUTO` as intent and let the server route.
- **`KanbanProvider.ts` is ~13,000 lines and this touches eighteen call sites across it.** One agent stream on this file (project PRD orchestration discipline); no parallel work in it while this lands.
- **Byte-compatibility for ~4,000 installs.** Every existing affordance must behave identically in the editor after the extraction. The only intended behaviour changes are (a) browser-originated dispatches now reaching the fleet, and (b) whatever the complexity-routing decision above resolves to.
- **The `_cliTriggersEnabled` gate is currently read independently in each copy.** Centralising it is correct but changes when it is evaluated for batch paths; verify a toggle mid-batch cannot produce a partially-dispatched selection.
- **Cascade ids and run sheets.** `_collectAllMovedSessionIds` (feature subtask cascade) and `recordRunSheetForColumnMove` are invoked per-card inside each copy, sometimes in slightly different order relative to the `moveCards` push. Normalising the order is required, and it is exactly the kind of change that silently alters what the board renders mid-move. Pin the order with a test before refactoring.

## Edge-Case & Dependency Audit

**Race Conditions**
- The optimistic-move path in `kanban.html` deliberately does *not* pre-move PLAN REVIEWED batches (mixed complexity would bounce). The extraction must keep the backend as the source of truth for those targets and keep emitting the same `moveCards` / `moveCardsFailed` deltas, or the board will visibly bounce cards.
- Partial failure: `moveCardToColumn` can fail per card. Today each copy accumulates its own `failures[]` and posts `moveCardsFailed`. One implementation must preserve per-card partial success — an all-or-nothing rewrite would be a regression.

**Security** — no new verb, endpoint or allowlist change.

**Side Effects**
- Browser-originated advance buttons begin dispatching to fleet terminals instead of failing. That is the fix.
- If the complexity-routing divergence is resolved in favour of routing, some drags will land cards in a different column than before. Release-note it.

**Dependencies & Conflicts**
- Interacts with `delete-allowptyfleet-resolve-terminals-by-name.md`: **do this first.** After extraction the surface argument exists in one place, so deleting it later is a one-site change rather than a ninety-two-site sweep. Landing the deletion first would mean deleting the flag from eighteen copies and then extracting them anyway.
- `kanbanService.focusTerminal` (`src/services/kanbanService.ts:138-143`) is a separate defect in the same symptom: it calls `switchboard.focusTerminalByName` with no PTY guard and **no `{ silent: true }`**, so a *successful* fleet dispatch still raises "Terminal 'X' not found. It may have been closed." (`extension.ts:3010`). Fix it in this change — it is what makes a working dispatch look broken. Five further non-silent call sites exist (`KanbanProvider.ts:10348`, `TaskViewerProvider.ts:12361`, `:19615`, `extension.ts:3039`, `:3454`); audit each for whether a PTY target can reach it.

## Dependencies

None (hard).

**Unblocking note.** The immediate symptom can be cleared without this plan: thread `!!msg?.apiOriginated` into the seventeen call sites, add the missing parameter to `triggerBatchAgentFromKanban`, and silence `focusTerminal`. That is throwaway work this plan deletes, and it is the right thing to do first if a working build is needed before the refactor lands.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is that collapsing eighteen call sites into one operation changes where cards land — the extraction forces a decision on the drag/button complexity-routing divergence that has been quietly inconsistent, and resolving it in the wrong direction moves cards for every user, in the editor as well as the browser. The second risk is ordering within the routine: cascade-id collection, run-sheet recording and the `moveCards` push happen in slightly different orders across the copies, and normalising them can alter what the board renders mid-move. Mitigations: pin current per-affordance behaviour with tests *before* refactoring, make the explicit-vs-computed-target contract an explicit parameter rather than an inferred one, and land the CI guard in the same change so the eighteen sites cannot silently regrow.

## Proposed Changes

### `src/services/KanbanProvider.ts`
- **Context:** Owns every kanban `_handleMessage` arm and all eighteen dispatch call sites.
- **Logic:** Add one operation:

  ```
  advanceCards(sessionIds, {
      sourceColumn,
      target?,             // <columnId>   → move there, NO routing   (drag onto a real column)
                           // 'CODED_AUTO' → complexity-route per card (drag onto the collapsed column)
                           // undefined    → compute next stage; PLAN REVIEWED ⇒ route (advance buttons)
      apiOriginated,
      instruction?, targetTerminalOverride?, bypassTriggerGate?
  })
  ```

  It owns the whole routine: unknown-complexity filtering, complexity partition (computed-target path only), visible-agent resolution, target-column resolution, per-card `moveCardToColumn`, run-sheet recording, cascade-id collection, the `moveCards` / `moveCardsFailed` pushes, the `_cliTriggersEnabled` gate, and the single dispatch call. Rewrite `moveSelected`, `moveAll`, `triggerAction`, `triggerBatchAction`, `sendDispatchToCoder` and the remaining arms as thin callers.
- **Edge Cases:** Preserve per-card partial failure and the exact delta messages the board consumes; preserve emission order.

### `src/extension.ts`
- **Logic:** Add `apiOriginated?: boolean` to `switchboard.triggerBatchAgentFromKanban` (`:1664`) and forward it into `handleKanbanBatchTrigger` — batch dispatch currently cannot receive a surface at all.
- **Edge Cases:** Trailing optional parameter; existing callers keep working.

### `src/services/kanbanService.ts`
- **Logic:** `focusTerminal` — skip the focus entirely for a PTY target and pass `{ silent: true }` otherwise, matching the drag path's guard (`TaskViewerProvider.ts:19369`).
- **Edge Cases:** `_isLikelyPtyDispatchTarget` reads the `_ptyTerminalNames` snapshot, refreshed only as a side effect of `_ptyHostVerb('ptyListTerminals')` (`TaskViewerProvider.ts:428-431`). It is cold after a reload, while delivery uses a live list — so the guard can disagree with the delivery it is guarding. Refresh before consulting, or read live.

### `scripts/check-kanban-dispatch-callers.js` (new) + `package.json` + `.github/workflows/integration-tests.yml`
- **Logic:** AST guard failing if any `_handleMessage` arm calls `switchboard.triggerAgentFromKanban` / `triggerBatchAgentFromKanban` directly instead of going through `advanceCards`. This is the ratchet that stops the eighteen copies regrowing.
- **Edge Cases:** Must fail on the pre-refactor tree. Declare `typescript` in `devDependencies` — it currently resolves only as a transitive hoist.

## Verification Plan

### Automated
1. Characterisation tests written **before** the refactor, pinning current behaviour of `moveSelected`, `moveAll`, `triggerAction`, `triggerBatchAction` and `sendDispatchToCoder`: target columns chosen, delta messages emitted, and their order.
2. A mixed-complexity selection in PLAN REVIEWED splits across `lead` / `coder` / `intern` and dispatches each group to its own column — unchanged before and after.
3. Partial failure: one card fails `moveCardToColumn`; the rest still move and `moveCardsFailed` carries only the failure.
4. Target contract, all three cases: a real column id moves there unrouted; `'CODED_AUTO'` routes per card; `undefined` computes the next stage and routes out of PLAN REVIEWED.
4a. An unscored card is handled identically whether dragged onto `CODED_AUTO` or advanced by button — the divergence at `kanban.html:7176` vs `_filterUnknownComplexitySessions` is closed.
4b. `resolveCodedAutoTarget` no longer exists in `kanban.html`; the webview sends `CODED_AUTO` as intent.
5. An api-originated advance resolves a fleet terminal; an editor-originated advance resolves a VS Code terminal. Same operation, both directions.
6. Batch advance from the browser reaches the fleet (impossible today — the command has no parameter for it).
7. Guard fails when an arm calls the trigger command directly.

### Manual (browser cockpit + editor)
1. **The reported bug:** advance-selected in a column dispatches to the visible fleet terminal, with no VS Code "terminal not found" toast.
2. Advance-all, drag single, drag batch, send-to-coder — all dispatch correctly from the browser.
3. All of the above in the editor deliver to VS Code terminals exactly as before.
4. Mixed-complexity PLAN REVIEWED selection still splits across columns correctly in both hosts.
5. Drag a card onto a specific coder column — it lands **there**, unrouted, regardless of complexity.
5a. Drag the same card onto the collapsed `CODED_AUTO` column — it routes by complexity, matching what the advance button does for that card.
5b. Drag an **unscored** card onto `CODED_AUTO` — it is skipped with the same "unknown complexity" notice the button gives (behaviour change; see Complexity Audit), and moves normally with `_allowUnknownComplexityAutoMove` on.
6. Toggle CLI triggers off — advance moves cards without dispatching, in both hosts.
7. Feature cards: cascade still moves subtasks and the board renders one coherent update.

## Recommendation

Complexity 7 → **Send to Lead Coder.** The operation itself is not hard, but it consolidates eighteen independently-evolved copies inside a ~13,000-line provider, it forces a decision on a live drag-vs-button behaviour divergence, and it must stay byte-compatible for ~4,000 editor installs while changing browser behaviour deliberately. Characterisation tests before the refactor are not optional here.
