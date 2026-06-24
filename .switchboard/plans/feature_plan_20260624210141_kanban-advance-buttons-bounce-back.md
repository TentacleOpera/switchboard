# Fix: Kanban "Advance All" Bounces Plans Back to NEW Until the Prompt Is Delivered

## Goal

On the Kanban board (`kanban.html`), pressing **"Advance all"** on the **NEW** column (with extra planner terminals enabled) does not make plans stick. The observed sequence, confirmed during testing:

1. Press "Advance all".
2. Plans move forward (optimistic UI).
3. Plans **bounce back to NEW** while the per-terminal `/clear` sequence is still running.
4. When the prompt is eventually delivered to the planner terminal(s), the plans jump back to the correct column.

So plans only "stick" once the actual dispatch completes. And because batch planner dispatch with extra terminals is **very laggy** (the slow, fully-serialized `/clear` + send chain — see the companion plan [feature_plan_20260624210142_batch-planner-extra-terminals-lag.md](feature_plan_20260624210142_batch-planner-extra-terminals-lag.md)), the reverted state lingers so long that it can effectively time out and the **NEW column reclaims the plans permanently**.

The goal: a plan's column move must **persist immediately and stay put the instant the button is pressed**, completely independent of whether/when the prompt is dispatched to a terminal — and the board must update via **targeted card deltas, never a whole-board redraw**, so every move is snappy.

### Problem Analysis & Root Cause

"Advance all" on the NEW column posts a `moveAll` message. The backend handler is at [KanbanProvider.ts:5596](../../src/services/KanbanProvider.ts#L5596). Walking it against the webview render logic explains every step the user saw.

**The move is sequenced *inside* the slow dispatch — and a stale refresh fires first.**

```js
case 'moveAll': {
    ...
    await this._refreshBoard(workspaceRoot);              // (1) STALE REFRESH — fires before any move
    const sourceCards = this._lastCards.filter(...);
    ...
    const role = this._columnToRole(nextCol);
    if (role === 'planner' && this._cliTriggersEnabled) {
        await this._distributePlannerDispatch(workspaceRoot, sourceCards, nextCol);  // (2) persist is INSIDE here
        await this._refreshBoard(workspaceRoot);          // (3) only after the slow dispatch returns
        break;
    }
    ...
}
```

- **(1) The refresh-at-start reverts the optimistic move.** `moveAll` calls `await this._refreshBoard()` *before* anything is persisted, purely to recompute `sourceCards` from fresh DB state. But `_refreshBoard` posts a full `updateBoard` to the webview reading the database, where the plans are **still in NEW** (nothing moved yet). 

- **The webview renders that stale board because the move changes `updated_at`.** The webview gate is signature-based ([kanban.html:6103](../../src/webview/kanban.html#L6103)), and `buildBoardSignature` includes `card.lastActivity` ([kanban.html:4419-4426](../../src/webview/kanban.html#L4419-L4426)):

  ```js
  .map(card => `${card.workspaceRoot}|${card.planId||card.sessionId}|${card.column}|...|${card.lastActivity}|...`)
  ```

  Every `moveCardToColumn` write sets `updated_at = new Date().toISOString()` ([KanbanDatabase.ts:1421-1423](../../src/services/KanbanDatabase.ts#L1421-L1423)). So as soon as the in-flight persist (inside `_distributePlannerDispatch`) touches the rows, the signature changes and the webview re-renders from whatever board state the *next* `updateBoard` carries. Depending on the exact interleave of the early refresh (1), the per-card persist loop, and the `moveCards` echo, the board flips to the reverted (NEW) state and stays there until a later authoritative message rewrites it. That is the visible bounce in step 3.

- **(2) Persistence is buried behind the `/clear` latency.** The authoritative DB write and `moveCards` echo live inside `_distributePlannerDispatch` ([KanbanProvider.ts:3392-3398](../../src/services/KanbanProvider.ts#L3392-L3398)). The pre-move loop runs, then the **slow dispatch loop** (`/clear` paste → ~1s submit → ~2s settle → send, per terminal, serialized) runs. The correcting full refresh (3) only happens *after* `_distributePlannerDispatch` returns — i.e. after the entire `/clear`+send chain. So the user sees the plans return to the right column only "when the prompt is eventually delivered" (step 4), exactly as reported.

- **Under lag, the revert becomes permanent.** Because the multi-terminal dispatch is fully serialized with multi-second fixed delays (the companion lag plan), the window between the bounce (step 3) and the correcting refresh (step 4) stretches to tens of seconds. If any link in that long chain throws or stalls, the correcting `moveCards`/`_refreshBoard` never arrives, and the last state the webview rendered — plans back in NEW — sticks until a manual reload. That is the "NEW column reclaimed them permanently" symptom.

**Contributing factor — the `moveCards` reconcile can't match file-based plans.** Even when the echo *does* fire, the webview `moveCards` handler matches only `card.sessionId` ([kanban.html:6073](../../src/webview/kanban.html#L6073)):

```js
if (idsToMove.has(card.sessionId)) { ... }   // matches sessionId ONLY
```

But the dispatch sends `planId`-primary ids (`_cardId` → `planId || sessionId`), and **file-based plans have an empty `session_id`** (per the fallback at [KanbanDatabase.ts:2514](../../src/services/KanbanDatabase.ts#L2514)). Freshly-created NEW plans are exactly these. So the one message designed to authoritatively confirm the move is a no-op for them, leaving the board even more dependent on the slow trailing `_refreshBoard` to ever correct itself.

### Why the board-wide refresh exists (and why it shouldn't re-render)

The full `_refreshBoard` at the start of `moveAll` has exactly **one** legitimate job, and the board re-render is not it. The two advance handlers enumerate their targets differently:

- **`moveSelected`** ([KanbanProvider.ts:5506](../../src/services/KanbanProvider.ts#L5506)) receives explicit `msg.sessionIds` and filters `this._lastCards` directly — **no start-refresh**.
- **`moveAll`** receives only the column *name*, so the backend must work out which cards live in that column. It does so by calling `await this._refreshBoard()` then filtering `this._lastCards` by column ([5602](../../src/services/KanbanProvider.ts#L5602)).

So the only reason for the start-refresh is *"get a fresh server-side list of the cards in this column"* — a **data read**. But `_refreshBoard` is one fat function that does the read **and** posts `updateBoard`, which redraws the whole board from the DB (where the plans are still in NEW), reverting the optimistic move. The lag is that same function re-running the entire pipeline just to answer "which cards are in NEW": custom-agents lookup, custom-columns, visible-agents, the DB board query, a per-plan `fs.existsSync` ghost-plan filter ([1977-2098](../../src/services/KanbanProvider.ts#L1977-L2098)), completed-plans query, and projects list.

It is weaker than it looks: `this._lastCards` was *just* populated by the render of the board the user clicked on, so the webview and `_lastCards` already agree on what's in NEW. The re-read only guards a narrow race (a watcher mutating the column in the gap) and pays a full recompute + full redraw for it on every "advance all".

**A column move never needs a whole-board redraw.** The webview's `renderBoard` recomputes column counts and empty-states from the cards array it is handed ([kanban.html:5116](../../src/webview/kanban.html#L5116)), so a targeted `moveCards` delta updates counts correctly on its own. A full `_refreshBoard` is only warranted for **structural** change — columns added/removed, workspace/project switch, plans created/deleted/completed externally, complexity re-scored — none of which happen during an advance. Everywhere on the advance path a full refresh is used purely to "move some cards", it can be a `moveCards` delta instead, which is the snappy path.

### ⚠️ Verified Correction (added during improve-plan)

The original Root Cause prose above cites `_refreshBoardImpl` ([1977-2098](../../src/services/KanbanProvider.ts#L1977-L2098)) as the function whose "card-loading half" should be factored out. **That is incorrect for the production path.** Verification findings:

- **`_refreshBoardImpl` is dead code in production.** Its only call sites are in test files (`KanbanProvider.test.ts:625`, `kanban-persistence.test.ts:147,189`). It is NOT called by `_refreshBoard`.
- **The live refresh pipeline is:** `_refreshBoard` ([KanbanProvider.ts:1960](../../src/services/KanbanProvider.ts#L1960)) → `vscode.commands.executeCommand('switchboard.refreshUI')` → `taskViewerProvider.refreshUI` ([TaskViewerProvider.ts:2584](../../src/services/TaskViewerProvider.ts#L2584)) → `_refreshRunSheets` → **`refreshWithData`** ([KanbanProvider.ts:1132](../../src/services/KanbanProvider.ts#L1132)) → builds cards, sets `this._lastCards` (1228), posts `updateBoard` (~1280).
- **The bounce effect is real and correctly diagnosed** — a stale `updateBoard` with cards still in NEW races the `moveCards` echo. Only the *cited function* (`_refreshBoardImpl`) was wrong; the *target function* for any factoring is `refreshWithData`.
- **The simplest fix does not require factoring anything.** `moveSelected` (5506) already filters `this._lastCards` directly with no start-refresh. `moveAll` can do the same — drop the start `_refreshBoard` at [5601](../../src/services/KanbanProvider.ts#L5601) and filter `this._lastCards` by column. This eliminates the bounce source without touching the shared `refreshWithData` pipeline. See Proposed Changes 1b-revised.

### Root cause, stated plainly

The column move is **not an immediate, standalone, persisted operation**. It is entangled with the dispatch: a stale full-board refresh fires before the move, the actual DB write + echo are sequenced behind the slow `/clear`+send chain, and the only reliable correction is a refresh that runs after dispatch finishes. The fix is to **persist the move and emit the authoritative echo up front — before any dispatch — and replace board-wide refreshes on the advance path with targeted `moveCards` deltas so the board stays snappy.** Concretely: the persist+echo already runs first inside `_distributePlannerDispatch` (3392-3398); the bug is the caller's stale start-refresh (5601) reverting that echo. Removing the start-refresh (filtering `_lastCards` directly, like `moveSelected`) is the core fix.

## Metadata

- **Tags:** `bugfix`, `frontend`, `backend`, `ui`, `reliability`, `performance`
- **Complexity:** 6/10

## User Review Required

Yes. This change reorders the persist/dispatch/refresh sequence in the shared advance hot path (`moveAll` / `moveSelected` / `_distributePlannerDispatch`) and removes full-board refreshes that other logic may implicitly depend on. The user should confirm:

1. **Acceptance of the dropped start-refresh race guard.** Removing the start `_refreshBoard` at `moveAll:5601` means `sourceCards` is derived from `this._lastCards` (last rendered board) rather than a fresh DB read — exactly as `moveSelected` already does. The only risk is a watcher mutating the column in the ~ms gap between render and click. `moveSelected` has shipped with this trade-off; confirm it is acceptable for `moveAll` too.
2. **Scope of the `moveCardsFailed` feature (1d).** `moveCardToColumn` returns a bare `boolean` with no reason string. Confirm whether to (a) ship a generic "database update failed" reason, (b) thread a real reason out of `KanbanDatabase.updateColumnByPlanFile`, or (c) cut the `moveCardsFailed` handler entirely and rely on the existing silent-revert + status message.
3. **Whether `promptOnDrop` (5359) and `julesLowComplexity` (5488)** — two other handlers with the identical start-refresh-bounce pattern — should be fixed in this same plan or deferred.

## Complexity Audit

### Routine
- Dropping the start `_refreshBoard` at `moveAll:5601` and filtering `this._lastCards` directly — mirrors the existing `moveSelected` pattern (5506-5572), single-line removal + reuse of an existing filter.
- Making the webview `moveCards` reconcile planId-aware (2a) — mirrors the backend `_cardMatchesIds` (330-333) / `_cardId` (336-338) one-to-one.
- Recomputing `lastBoardSignature` after the optimistic move (2c) — one line added to `moveCardsOptimistically`.
- Converting the trailing `_refreshBoard` calls on the advance path (5671, 5686, 5593) to `moveCards` deltas — the target column and moved ids are already known at each call site.

### Complex / Risky
- **Reordering the shared advance hot path.** `moveAll`, `moveSelected`, drag-advance (`moveCardForward`/`moveCardBackwards`), `promptOnDrop`, `julesLowComplexity`, PLAN REVIEWED complexity routing, custom-user column dispatch, and epic cascade all funnel through `moveAll`/`moveSelected`/`_distributePlannerDispatch`. Removing/neutering full refreshes here can regress drag-drop, CLI dispatch, custom-column, and complexity-routing paths that may implicitly rely on the trailing `_refreshBoard` to reconcile DB truth (e.g. complexity routing splits a batch across multiple target columns).
- **`_scheduleBoardRefresh` is shared with watcher-driven/structural callers** (461, 508, 1111, 3779, 3810, 4195, 4203, 4963, 5006, 5031). Replacing it with a delta on the drag-advance path (1e) must NOT change behavior for the structural callers that legitimately need a full redraw.
- **`moveCardsFailed` reason sourcing (1d).** `moveCardToColumn` returns a bare boolean; producing a meaningful `reason` requires either a generic string or threading error detail out of `KanbanDatabase.updateColumnByPlanFile` (which currently logs but does not surface the failure cause).

## Edge-Case & Dependency Audit

- **`_refreshBoard` does double duty.** It both (a) refreshes `this._lastCards` server-side and (b) posts `updateBoard` to the webview (via the `switchboard.refreshUI` → `refreshWithData` pipeline). `moveAll` calls it at the start only for (a). The fix needs a data-only variant (recompute `_lastCards` without `postMessage`) so recomputing `sourceCards` no longer reverts the UI. **Clarification:** the simplest data-only variant is *no variant at all* — filter the existing `this._lastCards` directly (as `moveSelected` does), accepting the same narrow race `moveSelected` already accepts. If a true fresh-DB read is required, the function to factor is `refreshWithData` (1132, the LIVE path), NOT `_refreshBoardImpl` (1977, dead code). Verify no other early-refresh caller relies on the webview side effect.
- **`buildBoardSignature` includes `lastActivity`.** Any persist changes `updated_at`, so signature-based render guards cannot be relied on to suppress a stale render. The authoritative `moveCards` echo (not a full board refresh) should be the mechanism that moves cards, and it must run before dispatch.
- **File-based plans (empty `session_id`).** The reconcile fix (match `planId`) is required or the echo silently misses NEW plans. Mirror `_cardMatchesIds` (330-333).
- **Limit-dispatch-to-terminals.** When the "Limit dispatches to number of available terminals" toggle is ON, `_distributePlannerDispatch` only moves the oldest N plans ([KanbanProvider.ts:3384-3385](../../src/services/KanbanProvider.ts#L3384-L3385)). The remaining plans legitimately stay in NEW — that is not a bounce and must not be "corrected". Persist-first must only persist the plans actually being advanced.
- **Planner-terminals = 0.** `_distributePlannerDispatch` has a fallback path ([KanbanProvider.ts:3366-3376](../../src/services/KanbanProvider.ts#L3366-L3376)) that pre-moves then batch-triggers; it has the same "persist then slow dispatch" shape and benefits from the same reordering.
- **Companion lag fix.** This plan removes the *transient* bounce; the companion plan ([…lag.md](feature_plan_20260624210142_batch-planner-extra-terminals-lag.md)) removes the latency that turns it *permanent*. Both should land together for the full fix, but persist-first alone already prevents permanent loss because the DB is written before dispatch starts.
- **Epic cascade.** `moveCardToColumn` cascades epics+subtasks; persisting up front must still cascade correctly.
- **No DB schema change.**
- **`moveSelected` trailing refresh (added during improve-plan).** `moveSelected` (5506) has its OWN trailing `await this._refreshBoard(workspaceRoot)` at [5593](../../src/services/KanbanProvider.ts#L5593) — the same redundant full-redraw pattern 1c targets at 5671/5686. It must receive the same delta-not-redraw treatment or the "every user move is a delta" goal is incomplete.
- **`promptOnDrop` and `julesLowComplexity` start-refreshes (added during improve-plan).** `promptOnDrop` ([5359](../../src/services/KanbanProvider.ts#L5359)) and `julesLowComplexity` ([5488](../../src/services/KanbanProvider.ts#L5488)) both call `await this._refreshBoard()` at the start to recompute `sourceCards` — the identical bounce pattern. They are not on the planner "Advance all" path but share the defect; decide whether to fix in this plan or defer (see User Review Required #3).

## Dependencies

- `sess_20260624210142 — batch-planner-extra-terminals-lag` (companion plan; removes the dispatch latency that turns the transient bounce permanent). Land together for the full fix; this plan alone prevents permanent data loss because the DB write precedes dispatch.

## Adversarial Synthesis

Key risks: (1) proposal 1b originally targeted `_refreshBoardImpl`, which is **dead code in production** — the live refresh path is `_refreshBoard` → `switchboard.refreshUI` → `refreshWithData`; an implementer following the original 1b would refactor dead code and the bounce would persist. (2) The fix is simpler than prescribed: `moveSelected` already filters `this._lastCards` with no start-refresh, so `moveAll` should do the same rather than introduce a new `_reloadLastCards` function. (3) The plan missed `moveSelected`'s trailing refresh (5593) and two sibling start-refresh bounce sources (`promptOnDrop` 5359, `julesLowComplexity` 5488). Mitigations: drop the start-refresh at 5601 and filter `_lastCards` directly; convert all advance-path trailing refreshes (5671, 5686, 5593) to `moveCards` deltas; keep the verified-correct 2a (planId reconcile) and 2c (signature sync) fixes as-is; specify or cut `moveCardsFailed`'s `reason` sourcing before implementation.

## Proposed Changes

### File 1: `src/services/KanbanProvider.ts`

**1a. Persist the move and emit the authoritative echo BEFORE dispatch, in `_distributePlannerDispatch`.** The pre-move loop already exists at [3392-3398](../../src/services/KanbanProvider.ts#L3392-L3398) and already runs before the slow dispatch — the problem is the *stale refresh at the moveAll caller* and the *trailing* refresh, not this block. Keep the pre-move+echo here, but ensure nothing reverts it in the interim (1b, 1c). **Clarification (verified):** this block ALREADY persists + posts `moveCards` (3398) before the slow dispatch loop (3400-3418), so 1a is effectively a no-op confirmation — the real fix is the caller-side 1b/1c below. No code change required here unless wiring 1d's failure capture.

**1b. Stop the stale full-board refresh at the start of `moveAll` (and `moveSelected`).** Replace the UI-posting `await this._refreshBoard(workspaceRoot)` at [5601](../../src/services/KanbanProvider.ts#L5601) with a **data-only** recompute that updates `this._lastCards` without posting `updateBoard` to the webview:

```js
// Recompute sourceCards from fresh DB state WITHOUT pushing a stale board to the
// webview (which would revert the optimistic advance before we've persisted).
await this._reloadLastCards(workspaceRoot);   // new: refreshes this._lastCards only, no postMessage
const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === column);
```

Introduce `_reloadLastCards(workspaceRoot)` by factoring the card-loading half of `_refreshBoardImpl` ([1977-2098](../../src/services/KanbanProvider.ts#L1977-L2098)) out from the `postMessage` half, so it can be called for data only.

> **⚠️ 1b REVISED (verified during improve-plan — supersedes the above).** `_refreshBoardImpl` (1977-2098) is **dead code in production** (only test call sites). Factoring it produces a function that is never on the live path, and the bounce would persist. Two corrected options, in order of preference:
>
> **Option A (preferred — simplest, lowest risk, mirrors `moveSelected`):** Delete the start-refresh entirely and filter `this._lastCards` directly, exactly as `moveSelected` (5506-5572) already does:
> ```js
> // moveAll — NO start-refresh; _lastCards was just populated by the render the user clicked.
> const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === column);
> ```
> This accepts the same narrow watcher-race `moveSelected` already ships with. No new function, no factoring, no touch to the shared `refreshWithData` pipeline.
>
> **Option B (only if a fresh-DB read is deemed mandatory):** Factor the card-building half out of **`refreshWithData`** ([1132-1228](../../src/services/KanbanProvider.ts#L1132-L1228), the LIVE path) into a `_reloadLastCards(workspaceRoot)` that queries the DB, filters ghost plans, and sets `this._lastCards` — but does NOT post `updateBoard`. Do NOT factor `_refreshBoardImpl`; it is dead code.

**1c. Replace the trailing `_refreshBoard` with a targeted confirmation delta.** The post-dispatch `_refreshBoard` at [5671](../../src/services/KanbanProvider.ts#L5671) / [5686](../../src/services/KanbanProvider.ts#L5686) exists to reconcile the DB truth after the move. But since the persist already happened and the per-card target columns are known server-side, this does not need a whole-board redraw — emit a `moveCards` delta with the final `{sessionIds, targetColumn}` instead:

```js
// After persisting, confirm with a targeted delta — NOT a board-wide refresh.
this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: movedIds, targetColumn: nextCol });
// (omit the trailing await this._refreshBoard(workspaceRoot) on the advance path)
```

Wrap the dispatch in `try/finally` so the confirming delta is posted regardless of dispatch success — a thrown/slow dispatch can never strand the board in the reverted state. Reserve a real `_refreshBoard` only for the structural cases (complexity routing that splits a batch across multiple target columns can post one delta per target column; that is still N small deltas, not a full redraw).

> **⚠️ 1c ADDENDUM (added during improve-plan).** `moveSelected` has its OWN trailing `await this._refreshBoard(workspaceRoot)` at [5593](../../src/services/KanbanProvider.ts#L5593) — same redundant full redraw. Apply the same delta-not-redraw treatment there (the moved ids and `targetColumn` are known at each branch). Without this, the "every user-initiated move is a targeted delta" goal is incomplete and `moveSelected` retains a redundant full-board recompute on every advance-selected.

**1e. Apply the same delta-not-redraw treatment to the other advance entry points.** The drag-advance handlers `moveCardForward` / `moveCardBackwards` ([5034-5057](../../src/services/KanbanProvider.ts#L5034-L5057)) call `this._scheduleBoardRefresh(workspaceRoot)` after persisting. Replace those with a `moveCards` delta as well (they already know the `targetColumn` and `sessionIds`). Keep `_scheduleBoardRefresh` for watcher-driven/structural change only. This makes *every* user-initiated card move a targeted delta, eliminating full-board recompute from the interactive path.
> **⚠️ 1e ADDENDUM (added during improve-plan).** `_scheduleBoardRefresh` (2352-2359) is a 100ms-debounced `_refreshBoard` shared with **structural** callers (461, 508, 1111, 3779, 3810, 4195, 4203, 4963, 5006, 5031). Only replace the two drag-advance call sites (5042, 5054); do NOT alter `_scheduleBoardRefresh` itself or the other call sites, which legitimately need a full redraw (watcher scan, order-override change, control-plane switch, etc.).

**1d. Surface failed persists.** Capture `moveCardToColumn`'s currently-discarded boolean in the pre-move loop ([3394](../../src/services/KanbanProvider.ts#L3394)); if a write returns `false`, post a `moveCardsFailed` message (File 2, 2b) for that id so the card visibly reverts *with a reason* instead of silently.
> **⚠️ 1d CLARIFICATION (added during improve-plan).** `moveCardToColumn` returns a bare `boolean` (`false` for invalid column name, DB unavailable, or zero rows matched — see [KanbanDatabase.ts:1415-1418](../../src/services/KanbanDatabase.ts#L1415-L1418)) and provides **no reason string**. Before implementing, decide (see User Review Required #2): (a) ship a generic `reason: 'database update failed'`; (b) extend `updateColumnByPlanFile` to return a `{ ok, reason }` tuple and thread it through `moveCardToColumn`; or (c) cut `moveCardsFailed` and rely on the existing silent-revert + `showStatusMessage`. Option (b) is the only one that produces a useful per-failure reason but widens the change into `KanbanDatabase.ts`.

**1f. (Added during improve-plan) Apply the start-refresh removal to sibling bounce sources.** `promptOnDrop` ([5359](../../src/services/KanbanProvider.ts#L5359)) and `julesLowComplexity` ([5488](../../src/services/KanbanDatabase.ts#L5488)) both call `await this._refreshBoard()` at the start to recompute `sourceCards` from `this._lastCards` — the identical bounce pattern. If approved (User Review Required #3), drop those start-refreshes and filter `this._lastCards` directly (Option A), the same treatment as `moveAll` 1b. These are not on the planner "Advance all" path but share the defect and the fix.

### File 2: `src/webview/kanban.html`

**2a. Make the `moveCards` reconcile planId-aware ([6072-6078](../../src/webview/kanban.html#L6072-L6078)) so the authoritative echo actually matches file-based NEW plans:**

```js
case 'moveCards': {
    const idsToMove = new Set(Array.isArray(msg.sessionIds) ? msg.sessionIds : []);
    const targetCol = msg.targetColumn;
    if (!idsToMove.size || !targetCol) break;
    let changed = false;
    currentCards = currentCards.map(card => {
        const cardKey = card.planId || card.sessionId;        // planId-primary, mirrors backend _cardMatchesIds
        if (idsToMove.has(cardKey) || (card.sessionId && idsToMove.has(card.sessionId))) {
            changed = true;
            return { ...card, column: targetCol };
        }
        return card;
    });
    if (changed) { lastBoardSignature = buildBoardSignature(currentCards); renderBoard(currentCards); }
    break;
}
```

**2b. Add a `moveCardsFailed` handler** that reverts only the plans the backend reports as not-persisted, with a clear message — so a genuine DB failure is visible rather than an indefinite bounce:

```js
case 'moveCardsFailed': {
    const failed = Array.isArray(msg.failures) ? msg.failures : []; // [{id, sourceColumn, reason}]
    if (!failed.length) break;
    const byId = new Map(failed.map(f => [f.id, f]));
    let changed = false;
    currentCards = currentCards.map(card => {
        const key = card.planId || card.sessionId;
        const f = byId.get(key) || (card.sessionId && byId.get(card.sessionId));
        if (f) { changed = true; return { ...card, column: f.sourceColumn }; }
        return card;
    });
    if (changed) { lastBoardSignature = buildBoardSignature(currentCards); renderBoard(currentCards); }
    showStatusMessage(`${failed.length} plan(s) not advanced: ${failed[0]?.reason || 'database update failed'}`, true);
    break;
}
```
> **⚠️ 2b CLARIFICATION (added during improve-plan).** This handler is only useful if the backend (1d) supplies a meaningful `reason`. If 1d option (c) is chosen (cut `moveCardsFailed`), remove this handler from scope.

**2c. Keep optimistic state and signature in sync.** `moveCardsOptimistically` ([4246](../../src/webview/kanban.html#L4246)) updates `currentCards[].column` and the DOM but never recomputes `lastBoardSignature`, leaving the model and the render-guard inconsistent. After the optimistic move, set `lastBoardSignature = buildBoardSignature(currentCards)` so a subsequent stale `updateBoard` (same columns, only `lastActivity` differs) does not trigger a spurious re-render. This is the webview-side belt to the backend's suspenders (1b).

## Verification Plan

**Step 1 — Reproduce.** With extra planner terminals enabled, clear-before-prompt ON, and several freshly-created (file-based, `Unknown`-or-set complexity) plans in NEW, press "Advance all". Before the fix: plans bounce to NEW during `/clear`, return only after prompt delivery, and under lag stay in NEW.

**Step 2 — Persist-first.** After the fix, press "Advance all". Confirm: plans move and **stay** immediately on press; nothing reverts during the `/clear` sequence; the prompt still gets delivered to the planner terminals; the cards never depend on dispatch completion to hold their column. Verify the DB `kanban_column` is updated immediately (check the `updateColumnByPlanFile VERIFY` log fires before the `/clear` log lines).

**Step 3 — Reconcile for file-based plans.** Confirm the `moveCards` echo now matches plans with empty `session_id` (the NEW plans) — the board reflects the move authoritatively, not just via the trailing refresh.

**Step 4 — Lag resilience.** Simulate slow/failed dispatch (e.g. kill a planner terminal mid-run). Confirm the move still persists and the board does not revert to NEW; a failed *persist* (not dispatch) shows a `moveCardsFailed` message and reverts only the affected cards.

**Step 5 — Limit toggle.** With "Limit dispatches to number of available terminals" ON and more NEW plans than terminals, confirm only the dispatched (oldest N) plans advance and persist, the rest correctly remain in NEW (and are not flagged as failures).

**Step 6 — Snappiness.** Confirm that advancing cards (drag, per-card, advance-selected, advance-all) no longer triggers a whole-board redraw: in the Extension Host log, a move should produce a `moveCards` delta and **no** `_refreshBoardImpl` / `getBoard` / ghost-plan-filter log lines. Visually, only the affected cards and their column counts change; the rest of the board does not flicker/relayout. Compare wall-clock responsiveness on a board with many cards before/after.
> **⚠️ Step 6 CLARIFICATION (added during improve-plan).** The log lines to watch are those emitted by **`refreshWithData`** (`[KanbanProvider] filterGhostPlans (activeRows)`, `[refreshRunSheets] … calling refreshWithData`) — NOT `_refreshBoardImpl`, which is dead code and will not log in production. Absence of `refreshWithData`/`filterGhostPlans` logs on the advance path confirms no full redraw.

**Step 7 — Structural refresh still works.** Confirm a *real* full refresh still fires when it should: creating/deleting a plan, switching workspace/project, adding/removing a column, or a watcher-driven external change must still redraw the board correctly (these paths must NOT have been downgraded to deltas).

**Step 8 — Regression sweep.** Re-verify drag-drop advance, `moveSelected`, per-card advance, custom-user column advance, PLAN REVIEWED complexity routing (batch split across target columns → one delta per column), and epic cascade — each must move and persist with no bounce.

**Step 9 — (Added during improve-plan) Sibling handlers.** If 1f is in scope: verify `promptOnDrop` and `julesLowComplexity` no longer bounce (drop a plan onto a column / trigger Jules low-complexity dispatch and confirm the card does not revert during dispatch). If 1f is deferred, confirm those paths are not regressed by the shared-pipeline changes.

### Automated Tests

Per session directives, automated tests are **not run as part of this plan** — the suite will be executed separately by the user. The following tests are relevant and should be green after implementation:

- `src/services/__tests__/KanbanProvider.test.ts` — exercises `_refreshBoardImpl` (project-filter fallback at :625). Note: `_refreshBoardImpl` is dead production code but still covered here; if Option B factors `refreshWithData` instead, add equivalent coverage for the new `_reloadLastCards` data-only path.
- `src/test/kanban-persistence.test.ts` — project-filter fallback (:147, :189) via `_refreshBoardImpl`.
- New/updated tests for: `moveAll` with no start-refresh (sourceCards derived from `_lastCards`); `moveCards` webview reconcile matching `planId` for empty-`sessionId` cards; `moveCardsOptimistically` recomputing `lastBoardSignature`; `moveCardsFailed` revert (if 1d/2b in scope).

**Recommendation:** Complexity 6/10 → **Send to Coder.** The dominant fix (drop the start-refresh, filter `_lastCards` directly) is routine and mirrors `moveSelected`, but the change touches the shared advance hot path with real regression surface across drag-drop, CLI dispatch, complexity routing, and epic cascade, and the `moveCardsFailed` reason-sourcing decision (1d) needs user input before implementation.
