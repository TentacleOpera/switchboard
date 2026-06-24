# Fix: Epic Subtasks Leak Into Column-Batch Ops & Backlogging an Epic Orphans Its Subtasks

## Goal

In the Kanban board, "Advance All" (and the other column-batch actions) must operate **only** on the cards a user can actually see in that column. Today an epic's subtasks — which are hidden under their epic card — get swept into column-batch operations because each subtask carries its own `kanban_column`, independent of the epic's column. The deeper cause is that **moving an epic to BACKLOG (or back to CREATED) does not cascade to its subtasks**, so subtasks get stranded in an active column while their epic sits in BACKLOG.

Concretely: a BACKLOG epic ("design html code improvements") had 13 subtasks whose own `kanban_column` was still `CREATED`. "Advance All" on CREATED dispatched 3 of those subtasks to the planner terminals instead of the loose feature plans the user had just authored — and the limit-to-terminals + oldest-first sort meant the user's fresh plans were the ones held back.

### Problem Analysis & Root Cause

Two defects compound:

1. **Display-vs-data divergence (the leak).** The board webview hides subtasks from the main columns — `src/webview/kanban.html` (~L5086): `displayCards = displayCards.filter(card => !card.epicId)`. But the backend `_lastCards` is a flat list built from every active row (subtasks included), each tagged with its own `kanban_column` — `src/services/KanbanProvider.ts` (~L1194-L1210). Column-batch handlers selected source cards with `_lastCards.filter(card => card.column === column)` and **no `!card.epicId` exclusion**, so they re-admitted the subtasks the board had hidden.

2. **Missing backlog/activate cascade (the root cause).** `moveCardToColumn` (`KanbanProvider.ts` ~L4423-L4427) already cascades an epic move to its subtasks via `db.updateColumnWithEpicCascade(...)`. But the right-click actions `sendToBacklog` (~L6257) and `sendToNew` (~L6269) bypass it — they call `db.updateColumn(epicSessionId, ...)` directly on just the epic. So backlogging an epic moves only the epic; its subtasks stay where they were (CREATED), orphaned and free to be picked up by Advance All.

A model note that resolves the underlying tension: **at board level the epic is one unit (moves cascade to subtasks); inside epic-focus mode subtasks progress independently.** This fix enforces the board-level half (cascade + hide subtasks from loose columns); focus-mode independence is preserved by making column ops focus-aware (below).

## Metadata

- **Tags:** `bug`, `kanban`, `epics`, `subtasks`, `dispatch`, `backend`
- **Complexity:** 4/10

## Complexity Audit

Routine. No schema changes — `updateColumnWithEpicCascade` and `getSubtasksByEpicId` already exist and are used by `moveCardToColumn`. The work is (a) a one-line-each reroute of `sendToBacklog`/`sendToNew` through the cascade, (b) a shared source-card helper that mirrors the webview's display contract, and (c) a focus-aware tweak so focus-mode Advance All still targets the focused epic's subtasks.

## Edge-Case & Dependency Audit

- **Subtask carries its own column independent of the epic** — by design (subtasks can progress in focus mode). The fix does NOT force-sync columns; it only (i) excludes subtasks from loose-column ops and (ii) cascades the *container* moves (backlog/activate).
- **Epic-focus mode (worktree-gated today).** In focus mode the board shows the focused epic's subtasks as column cards, and the per-column Advance-All button is shown. A blanket `!card.epicId` exclusion would make focus-mode Advance All a no-op. Must be focus-aware: when focused, column buttons send explicit subtask IDs through the selection-based path (same mechanism already used for `CODED_AUTO` at `kanban.html` ~L4737-L4738), which trusts IDs and does not exclude subtasks.
- **Selection-based handlers must NOT exclude subtasks.** Explicit `msg.sessionIds` / `_cardMatchesIds` handlers (drag-drop move, `moveSelected`, `promptSelected`, chat copy, lead pair-programming) trust the IDs the user picked. Leave them untouched.
- **Epic card itself is not a subtask** (`epicId` empty, `isEpic` true), so `!card.epicId` keeps epic cards in column ops; advancing a column containing an epic still cascades via `moveCardToColumn`.
- **Completed subtasks** carry `epicId` too and are correctly excluded from active-column ops.
- **`sendToNew` symmetry.** Activating an epic out of BACKLOG should also bring its subtasks back to CREATED, otherwise un-backlogging leaves subtasks behind in BACKLOG. Cascade both directions.
- **Cross-workspace / ghost plans** — out of scope; pre-existing behavior unchanged.

## Proposed Changes

### 1. Shared source-card helper — `src/services/KanbanProvider.ts` — DONE (this session)

Added `_visibleColumnCards(workspaceRoot, column)` returning `_lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === column && !card.epicId)`, with a doc comment tying it to the webview display contract. Applied at all six column-batch sites:
- `batchPlannerPrompt` (CREATED), `batchLowComplexity` + Jules dispatch (PLAN REVIEWED low-complexity), `moveAll`, `promptAll`, `completeAll`.
Also added `if (c.epicId) return false;` to the two per-role prompt-preview filters so previews match what dispatch sends. Regression test: `src/test/kanban-subtask-column-leak-regression.test.js` (passing).

### 2. Backlog/activate cascade — `src/services/KanbanProvider.ts` — PENDING

Reroute `sendToBacklog` and `sendToNew` so an epic move cascades to its subtasks, mirroring `moveCardToColumn`:

```ts
case 'sendToBacklog': {
    // ...resolve root + sessionId...
    const ok = await this.moveCardToColumn(resolvedRoot, resolvedSessionId, 'BACKLOG');
    // moveCardToColumn already does the isEpic → updateColumnWithEpicCascade branch
    this.refresh();
    break;
}
```

Same for `sendToNew` with `'CREATED'`. This replaces the direct `db.updateColumn(...)` calls. Keep the `_schedulePlanStateWrite` mirror behavior consistent (verify whether `moveCardToColumn` already persists the file-state mirror for subtasks; if not, fold the cascade's subtask IDs into the state-write so the on-disk mirror matches the DB).

> Decision point: confirm `moveCardToColumn` performs the same side effects `sendToBacklog`/`sendToNew` did (state-write mirror, integration sync). If it diverges, factor a small `moveEpicOrPlan(root, sid, col)` that both paths share.

### 3. Focus-aware column buttons — `src/webview/kanban.html` — PENDING

In the column-action click handler (`moveAll`/`promptAll`/etc., ~L4724), when `currentFocusedEpicId` is set, send the explicit IDs through the selection path instead of the column path:

```js
if (currentFocusedEpicId) {
    postKanbanMessage({ type: 'moveSelected', column: backendColumn, sessionIds: ids });
} else if (column === 'CODED_AUTO') {
    postKanbanMessage({ type: 'moveSelected', column: backendColumn, sessionIds: ids });
} else {
    postKanbanMessage({ type: 'moveAll', column: backendColumn });
}
```

`getAllInColumn` already returns the subtask IDs visible in that column while focused. The backend `moveSelected` path trusts IDs and does not exclude subtasks, so focus-mode Advance All keeps working. (This is a no-op for users who never enter focus mode.)

## Verification Plan

1. **Build:** `npm run compile` — no new TS errors (pre-existing `ArchiveManager` module-resolution error is unrelated).
2. **Regression test:** `node src/test/kanban-subtask-column-leak-regression.test.js` (already passing); extend if practical to assert `sendToBacklog`/`sendToNew` route through `moveCardToColumn`.
3. **Manual (installed VSIX):**
   - Create an epic with several subtasks; subtasks land in CREATED, epic in CREATED.
   - Send the epic to BACKLOG → confirm **all** subtasks follow it to BACKLOG (DB: `SELECT kanban_column FROM plans WHERE epic_id=?`).
   - Send the epic back to New → subtasks return to CREATED.
   - With the epic in BACKLOG and 2 loose standalone plans in CREATED, click **Advance All** on CREATED → only the 2 standalone plans dispatch; no subtasks.
   - (Worktree users) Link a worktree, focus the epic, Advance All a column → that epic's subtasks advance.
4. **DB cross-check** for the original repro (epic `3051b25c`): after backlog, no subtask of that epic should remain in CREATED/PLAN REVIEWED.

## Status

- §1 (exclusion + previews + test) — **implemented** in working tree.
- §2 (backlog/activate cascade) — **pending**.
- §3 (focus-aware column buttons) — **pending**.

Depends-on: none. Blocks: `kanban-epic-focus-worktree-decouple.md` (that plan makes focus always-available, which relies on §3 being in place).
