# Refresh-to-Delta (Part 1 of 2): Interactive Hot Path — Prompt & Dispatch Handlers

## Goal

Make the Kanban board snappy on the **frequent interactive actions** by replacing whole-board refreshes with targeted `moveCards` deltas on the prompt-advance and dispatch handlers. Each `_refreshBoard` re-runs the full pipeline (custom-agents, custom-columns, visible-agents, the DB `getBoard` query, a per-plan `fs.existsSync` ghost-plan filter, completed-plans, projects) and forces the webview to relayout **every card in every column**. The webview already has a lightweight `moveCards` delta ([kanban.html:6067](../../src/webview/kanban.html#L6067)) that updates only the affected cards and recomputes counts from the array `renderBoard` is handed ([kanban.html:5116](../../src/webview/kanban.html#L5116)). For a card move, the full refresh is pure overhead.

This is **Part 1** of a two-part split. It covers the high-value, low-risk hot path: the remaining prompt-advance handlers and the dispatch handlers. **Part 2** ([feature_plan_20260624212730_kanban-refresh-to-delta-backlog.md](feature_plan_20260624212730_kanban-refresh-to-delta-backlog.md)) is backlogged and covers complete/recover/archive (needs new delta infra) and documents the structural refreshes that must stay.

### Dependency & scope note (read first)

This plan **depends on and follows** [feature_plan_20260624210141_kanban-advance-buttons-bounce-back.md](feature_plan_20260624210141_kanban-advance-buttons-bounce-back.md), which is being implemented first. That plan already:

- introduces the **data-only `_reloadLastCards(workspaceRoot)`** helper (refreshes `this._lastCards` with no `postMessage`),
- makes the webview `moveCards` reconcile **planId-primary** so deltas match file-based plans, and
- downgrades the core advance handlers to deltas: **`moveAll`, `moveSelected`, `moveCardForward`, `moveCardBackwards`**.

So those four are **already done** by the time this plan starts and are **explicitly out of scope here** to avoid collision. What remains for the hot path is split into the two tiers below.

## Metadata

- **Tags:** `performance`, `refactor`, `kanban`, `KanbanProvider`, `kanban.html`, `optimistic-ui`
- **Complexity:** 4/10
- **Depends on:** `feature_plan_20260624210141_kanban-advance-buttons-bounce-back.md` (must land first)

## Complexity Audit

**Routine, leaning trivial for Tier 1.** Tier 1 is largely *deleting* a redundant `await this._refreshBoard()` that runs right after a `moveCards` the webview already acted on — no new code, just removal. Tier 2 swaps a refresh for a delta in handlers that already compute a target column to dispatch to. The only care points are: (a) batches that split across multiple target columns must emit one delta per group, and (b) any handler that removed its refresh but still reads `this._lastCards` later in the same function must use the `_reloadLastCards` data-only helper instead.

## Edge-Case & Dependency Audit

- **`_reloadLastCards` must exist.** Provided by the prerequisite plan. If a Tier 2 handler relies on fresh `_lastCards` for its own subsequent logic (not just the webview), call `_reloadLastCards` — never a webview-posting refresh.
- **Multi-target batches.** PLAN REVIEWED / complexity-routed dispatch sends different cards to different columns. A single `moveCards` can't express that — emit one `{sessionIds, targetColumn}` delta per group (the grouping loops already exist).
- **planId-primary reconcile.** Relies on the prerequisite plan's `moveCards` fix so deltas match plans with empty `session_id` (file-based). Do not start this plan before that fix is in.
- **Dispatch must still fire.** Removing the refresh must not remove the actual prompt copy / CLI trigger / terminal send — only the board redraw. Verify the dispatch side effect remains.
- **Double-render today.** `promptSelected` / `promptAll` already post `moveCards` *and then* `_refreshBoard` — the card moves, then the whole board redraws. Removing the trailing refresh is the safest possible change.
- **`promptOnDrop` has no success delta.** It currently relies on `_refreshBoard` for the visual move and separately posts `promptOnDropResult` for status. It needs a `moveCards` added when the refresh is removed.
- **Structural refreshes are NOT touched here.** Anything that changes columns, projects, epic membership, worktree badges, or the completed list stays on full refresh (Part 2 / keep-list).

## Call-Site Scope

Line numbers are the `_refreshBoard` call sites in `KanbanProvider.ts`.

### Tier 1 — Redundant trailing refresh after an already-posted `moveCards` (near-zero risk)

Scoped to what the prerequisite plan does **not** already cover:

| Handler | Site(s) | Treatment |
|---|---|---|
| `promptSelected` | 5722 body (trailing `_refreshBoard`) | Drop trailing refresh; keep the `moveCards` it already posts |
| `promptAll` | 5804 body (trailing `_refreshBoard`) | Drop trailing refresh; keep its `moveCards` |
| `promptOnDrop` | 5359, 5385, 5425 | Replace refresh with a `moveCards` delta; keep `promptOnDropResult` |

(Already handled by the prerequisite plan — listed only so they are not re-touched: `moveAll` 5601/5635/5671/5686, `moveSelected` 5593, `moveCardForward` 5054, `moveCardBackwards` 5042.)

### Tier 2 — Dispatch handlers that move cards (low–moderate risk; high value)

| Handler | Site(s) | Treatment |
|---|---|---|
| `triggerAction` | 4963, 5006 | post `moveCards` to dispatched target; drop refresh |
| `triggerBatchAction` | 5031 | post `moveCards`; drop refresh |
| `batchPlannerPrompt` | 5435, 5445 | post `moveCards` per target group; drop refresh |
| `batchDispatchLow` | 5462 | post `moveCards`; drop refresh |
| `batchLowComplexity` | 5474, 5488 | post `moveCards`; drop refresh |
| `julesLowComplexity` | 5502 | post `moveCards`; drop refresh |
| `julesSelected` | 5911 | post `moveCards`; drop refresh |
| `splitterSelected` | 5938 | post `moveCards`; drop refresh |
| `rePlanSelected` / `codeMapSelected` | 6284-region | post `moveCards`; drop refresh |
| `testingFailed` | 6284, 6340 | post `moveCards` to the failure target column; drop refresh |

For each, confirm the handler knows the final target column server-side (it computes one to dispatch), then post `{type:'moveCards', sessionIds, targetColumn}` in place of the refresh; emit one delta per group for batches that split across columns.

## Proposed Changes

### File: `src/services/KanbanProvider.ts`

1. **Tier 1.** In `promptSelected` and `promptAll`, delete the trailing `await this._refreshBoard(workspaceRoot)` (the `moveCards` they already post is sufficient). In `promptOnDrop`, replace each `await this._refreshBoard(...)` with:
   ```js
   this._panel?.webview.postMessage({ type: 'moveCards', sessionIds, targetColumn: effectiveTargetColumn });
   ```
   keeping the existing `promptOnDropResult` post.

2. **Tier 2.** In each dispatch handler, after the persist/dispatch, replace `await this._refreshBoard(...)` with a `moveCards` delta to the resolved target column:
   ```js
   this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: movedIds, targetColumn: targetCol });
   ```
   For grouped/split batches, emit one delta per group inside the existing loop.

3. **Data-only reload where needed.** If a handler removed its refresh but still reads `this._lastCards` afterward, call `await this._reloadLastCards(workspaceRoot)` (from the prerequisite plan) instead of a webview-posting refresh.

No webview changes are required in Part 1 — the `moveCards` handler (with the prerequisite plan's planId-primary fix) already covers every case here.

## Verification Plan

**Step 1 — Tier 1.** Use the per-card "Copy advance prompt" button and the column-header prompt-all/prompt-selected buttons. Confirm: the card advances and stays, the prompt is copied, and the Extension Host log shows a `moveCards` delta with **no** `_refreshBoardImpl` / `getBoard` / ghost-plan-filter lines. Only affected cards + counts change; no full-board relayout. Repeat for drag-in-prompt-mode (`promptOnDrop`).

**Step 2 — Tier 2.** Run each dispatch handler (single + batch, including a PLAN REVIEWED batch that splits across target columns). Confirm cards land in the correct column(s) via delta, counts are right, the actual dispatch/trigger still fires, and no full redraw occurs.

**Step 3 — Reconcile correctness.** With file-based plans (empty `session_id`), confirm the deltas match (relies on the prerequisite plan's planId-primary fix) — cards move authoritatively, not just optimistically.

**Step 4 — Structural untouched.** Confirm project/workspace/epic/worktree/column actions STILL trigger a full refresh and render correctly (not regressed by this plan).

**Step 5 — Snappiness.** On a board with 50+ cards, compare advance/dispatch responsiveness before vs after. Interactive moves should feel instant with no relayout of unrelated columns.

**Step 6 — Build & install.** Build, reload, re-run Steps 1–2 against the installed extension (not `dist/`).
