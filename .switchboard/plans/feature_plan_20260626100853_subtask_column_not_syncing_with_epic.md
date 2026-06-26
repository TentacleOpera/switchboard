# Bug: Kanban Subtask Column Status Never Syncs With Epic on Move

## Goal

Fix `moveCardToColumnByPlanFile` so that when an epic is moved via the plan-file
path (project panel dropdown, Linear/ClickUp remote control, manual script), its
subtasks cascade to the same column atomically — mirroring the behavior already
present in the drag-and-drop path (`moveCardToColumn`).

### Problem
When an epic is dragged to a new kanban column (e.g. from "Coded" to "Code
Reviewed"), its subtasks remain stuck in the column where the epic originated
(e.g. "New" / "Planned"). The subtask column status never updates in line with
the epic.

### Background
The Switchboard kanban board supports epic → subtask relationships. An epic is a
parent plan with child subtask plans linked via `epic_id`. When an epic moves
through workflow columns (Created → Plan Reviewed → Coded → Code Reviewed → Done),
its subtasks should move with it so the board reflects the epic's overall state.

There are **two** code paths that move a kanban card to a column:
1. `moveCardToColumn` — used by drag-and-drop on the kanban board
   (`moveCardForward` / `moveCardBackwards` message handlers). This path **IS**
   epic-aware and cascades the column change to all subtasks atomically.
2. `moveCardToColumnByPlanFile` — used by remote control, Linear/ClickUp
   integration sync, the manual `move-card.js` fallback script, and the
   `switchboard.moveKanbanCardByPlanFile` command (consumed by the project panel's
   column dropdown). This path is **NOT** epic-aware and only moves the single
   plan.

### Root Cause
`moveCardToColumnByPlanFile` in `src/services/KanbanProvider.ts` (lines 4822-4853)
does not check whether the plan is an epic and does not cascade the column change
to its subtasks. It calls only `db.updateColumnByPlanFile(planFile, workspaceId,
targetColumn)`, which updates a single row:

```typescript
public async moveCardToColumnByPlanFile(
    workspaceRoot: string,
    planFile: string,
    targetColumn: string
): Promise<boolean> {
    try {
        const db = this._getKanbanDb(workspaceRoot);
        if (!await db.ensureReady()) return false;
        const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
        const previousRecord = await db.getPlanByPlanFile(planFile, workspaceId);
        if (targetColumn === 'ORCHESTRATING' && !(previousRecord && previousRecord.isEpic)) {
            return false;
        }
        const sessionId = previousRecord?.sessionId || null;
        if (targetColumn === 'CODE REVIEWED') {
            if (sessionId) {
                await this._autoCommitIfCodeReviewTransition(workspaceRoot, sessionId, targetColumn);
            }
        }
        const moved = await db.updateColumnByPlanFile(planFile, workspaceId, targetColumn);
        if (moved) {
            await this.queueIntegrationSyncForPlanFile(workspaceRoot, planFile, targetColumn);
        }
        return moved;
    } catch (err) {
        console.error(`[KanbanProvider] moveCardToColumnByPlanFile failed for ${planFile}:`, err);
        return false;
    }
}
```

Compare with the epic-aware `moveCardToColumn` (lines 4775-4807) which retrieves
subtasks via `db.getSubtasksByEpicId(plan.planId)` and calls
`db.updateColumnWithEpicCascade(sessionId, subtaskSessionIds, targetColumn)`.

The atomic cascade helper already exists:
`KanbanDatabase.updateColumnWithEpicCascade` (lines 3757-3783) moves the epic +
all subtasks in one transaction. It just isn't called from the
`moveCardToColumnByPlanFile` path.

**Bug status: STILL PRESENT** (verified in source). The drag-and-drop path works
correctly; the plan-file-based path (project panel dropdown, integrations, manual
script) does not.

### Callers of `moveCardToColumnByPlanFile` (all benefit from the fix)
1. **`PlanningPanelProvider.moveKanbanPlanColumn`** (line 2662) — project panel
   column dropdown. Calls via `switchboard.moveKanbanCardByPlanFile` command.
2. **`_remoteApplyColumnMove`** (line 1489) — Linear/ClickUp remote control
   column-move handler. Calls `moveCardToColumnByPlanFile` directly, then
   dispatches the destination column's agent.
3. **Orchestrator teleport fallback** (line 3175) — used when an epic has no
   `sessionId` (file-watcher-imported epics). The primary path already uses
   `moveCardToColumn` (epic-aware); this is the fallback.

## Metadata
**Tags:** bugfix, backend, database
**Complexity:** 5

## User Review Required
Yes — the integration sync fan-out for subtasks (Change 2) should be reviewed to
confirm that subtask status changes in Linear/ClickUp are desired on epic moves.
If the integration sync already derives subtask status from the epic upstream,
the fan-out would be redundant (harmless but wasteful).

## Complexity Audit

### Routine
- Add an epic-detection + subtask-cascade branch to
  `moveCardToColumnByPlanFile`, mirroring `moveCardToColumn`.
- The atomic cascade helper `updateColumnWithEpicCascade` already exists — no
  new DB code needed.
- The manual fallback script `move-card.js` calls `db.updateColumn` directly;
  update it to use the cascade path for epics.
- `updateColumnTransaction` already exists (lines 3735-3754) for the
  null-sessionId bulk-subtask fallback — no new DB code needed.

### Complex / Risky
- **`sessionId` may be null for the epic.** `moveCardToColumnByPlanFile`
  resolves the record by plan file, and `previousRecord.sessionId` can be null
  for plans that haven't been dispatched yet. `updateColumnWithEpicCascade`
  takes an `epicSessionId` — if null, the cascade must fall back to
  `updateColumnByPlanFile` for the epic alone and `updateColumnTransaction`
  for subtasks by session_id. Must handle the null-sessionId epic case.
- **Integration sync fan-out.** `queueIntegrationSyncForPlanFile` is called once
  for the epic's plan file. After cascading subtasks, the subtasks' integration
  sync (Linear/ClickUp) should also fire so external systems reflect the
  subtask status change. Must fan out `queueIntegrationSyncForSession` for each
  subtask with a sessionId, using `Promise.allSettled` for parallelism.
- **Board refresh gap.** `moveCardToColumnByPlanFile` does NOT call
  `_refreshBoard`, and its primary caller (project panel dropdown) doesn't
  either. After the fix, subtasks move in the DB but the kanban board won't
  visually update until the next explicit refresh. Must add a `_refreshBoard`
  call after a successful move.
- **`CODE REVIEWED` auto-commit.** The existing path runs
  `_autoCommitIfCodeReviewTransition` for the epic only. Subtasks don't need
  auto-commit (they're not independently committed), so this is fine — but
  verify no subtask auto-commit side effect is expected.

## Edge-Case & Dependency Audit

- **Race Conditions:** If two column moves for the same epic arrive concurrently
  (e.g. user drags while a remote sync fires), both paths now use atomic
  transactions (`updateColumnWithEpicCascade` / `updateColumnTransaction`).
  SQLite serializes writes, so the last writer wins. This is the same behavior
  as the existing `moveCardToColumn` path — no new race risk.
- **Security:** No new attack surface. All inputs are existing plan files and
  column names already validated by `VALID_KANBAN_COLUMNS` /
  `SAFE_COLUMN_NAME_RE` in `updateColumnByPlanFile`.
- **Side Effects:**
  - Integration sync fan-out will trigger N additional Linear/ClickUp API calls
    (one per subtask with a sessionId). This is desired behavior but increases
    API load for large epics.
  - Board refresh after every plan-file move adds a `_refreshBoard` call. This
    is lightweight (single DB read + webview postMessage) and matches the
    pattern used by drag-and-drop handlers.
- **Dependencies & Conflicts:**
  - `getSubtasksByEpicId` queries by `epic_id` with `status = 'active'`, not
    by workspace. In a multi-workspace setup, subtasks always share the epic's
    workspace DB (same assumption as `moveCardToColumn`).
  - `move-card.js` requires from `'../../../out/services/KanbanDatabase'`
    (compiled output). The methods used (`getPlanBySessionId`,
    `getSubtasksByEpicId`, `updateColumnWithEpicCascade`) are all public on
    `KanbanDatabase` and available in compiled output.
- **Epic with zero subtasks:** `getSubtasksByEpicId` returns `[]`.
  `updateColumnWithEpicCascade` skips the subtask UPDATE when the array is empty
  (line 3768: `if (subtaskSessionIds.length > 0)`). The cascade degrades to a
  single-plan update — equivalent to current behavior.
- **Subtask with no `sessionId`:** `subtaskSessionIds` filters out falsy
  sessionIds (`.filter(Boolean)`). Subtasks without sessions are skipped by the
  cascade SQL — acceptable, they have no kanban card to move.

## Dependencies
- None — this plan is self-contained. It reuses existing cascade helpers
  (`updateColumnWithEpicCascade`, `updateColumnTransaction`) and existing
  integration sync methods (`queueIntegrationSyncForSession`).

## Adversarial Synthesis

Key risks: (1) the original plan's null-sessionId fallback used `db.run()` which
does not exist as a public method on `KanbanDatabase` — would fail to compile;
corrected to use `db.updateColumnTransaction()`. (2) Board refresh gap —
`moveCardToColumnByPlanFile` never calls `_refreshBoard`, so the kanban board
would show stale subtask positions after an epic move via the dropdown; fix adds
a refresh call. (3) Integration sync fan-out must use `Promise.allSettled` to
avoid sequential API calls blocking the move. Mitigations: all three are
addressed in the revised Proposed Changes below.

## Proposed Changes

### File: `src/services/KanbanProvider.ts`

**Change 1 — Add epic cascade to `moveCardToColumnByPlanFile` (around line 4844).**

Replace:
```typescript
const moved = await db.updateColumnByPlanFile(planFile, workspaceId, targetColumn);
if (moved) {
    await this.queueIntegrationSyncForPlanFile(workspaceRoot, planFile, targetColumn);
}
return moved;
```

With:
```typescript
// Epic-aware cascade: mirror moveCardToColumn's logic for the plan-file path.
let moved: boolean;
let subtaskSessionIds: string[] = [];
if (previousRecord && previousRecord.isEpic) {
    const subtasks = await db.getSubtasksByEpicId(previousRecord.planId);
    subtaskSessionIds = subtasks.map(st => st.sessionId).filter(Boolean) as string[];
    const epicSessionId = previousRecord.sessionId || '';
    if (epicSessionId) {
        // Atomic: move epic + all subtasks in one transaction.
        moved = await db.updateColumnWithEpicCascade(epicSessionId, subtaskSessionIds, targetColumn);
    } else {
        // Epic has no sessionId yet — move the epic by plan file, then bulk-move subtasks.
        moved = await db.updateColumnByPlanFile(planFile, workspaceId, targetColumn);
        if (moved && subtaskSessionIds.length > 0) {
            await db.updateColumnTransaction(subtaskSessionIds, targetColumn);
        }
    }
} else {
    moved = await db.updateColumnByPlanFile(planFile, workspaceId, targetColumn);
}

if (moved) {
    await this.queueIntegrationSyncForPlanFile(workspaceRoot, planFile, targetColumn);
    // Fan out integration sync for subtasks (parallel, non-blocking).
    if (subtaskSessionIds.length > 0) {
        await Promise.allSettled(
            subtaskSessionIds.map(sid =>
                this.queueIntegrationSyncForSession(workspaceRoot, sid, targetColumn)
            )
        );
    }
    // Refresh the kanban board so subtask positions update visually.
    await this._refreshBoard(workspaceRoot);
}
return moved;
```

**Key corrections from the original plan:**
- **`db.run()` → `db.updateColumnTransaction()`:** The original plan used
  `await db.run(...)` for the null-sessionId fallback. `db.run` is NOT a public
  method on `KanbanDatabase` — it's only on the internal `_db` object (type
  definition at line 90). Using it would cause a compilation error.
  `updateColumnTransaction` (lines 3735-3754) is the correct public method: it
  takes `sessionIds: string[]` + `targetColumn`, does a BEGIN/UPDATE/COMMIT
  transaction, and returns `Promise<boolean>`.
- **Single subtask fetch:** Subtasks are fetched once and the session IDs are
  reused for both the cascade and the integration sync fan-out. The original
  plan re-fetched subtasks in Change 2 — redundant DB round-trip.
- **`Promise.allSettled` for sync fan-out:** The original plan used a sequential
  `for` loop with `await`, which would block for N sequential API calls.
  `Promise.allSettled` matches the pattern used inside
  `queueIntegrationSyncForSession` itself (line 4717).
- **Board refresh:** Added `await this._refreshBoard(workspaceRoot)` after a
  successful move. The original plan omitted this — without it, the kanban board
  shows stale subtask positions after an epic move via the project panel
  dropdown. The drag-and-drop path's callers already refresh; the plan-file
  path's callers do not.

**Note on `isEpic` type:** `KanbanPlanRecord.isEpic` is `number` (0/1), not
boolean. The truthy check `previousRecord.isEpic` works (0 is falsy, 1 is
truthy) and is consistent with the existing `moveCardToColumn` pattern (line
4791: `if (plan && plan.isEpic)`).

### File: `.agents/skills/kanban_operations/move-card.js`

> **Path correction:** The original plan referenced
> `/Users/patrickvuleta/Documents/Gitlab/.agents/skills/kanban_operations/move-card.js`.
> The actual path is
> `/Users/patrickvuleta/Documents/GitHub/switchboard/.agents/skills/kanban_operations/move-card.js`.

**Change 2 — Make the manual fallback epic-aware (around line 22).**

Replace:
```javascript
const columnSuccess = await db.updateColumn(sessionId, targetColumn);
```

With:
```javascript
const plan = await db.getPlanBySessionId(sessionId);
let columnSuccess;
if (plan && plan.isEpic) {
    const subtasks = await db.getSubtasksByEpicId(plan.planId);
    const subtaskSessionIds = subtasks.map(st => st.sessionId).filter(Boolean);
    columnSuccess = await db.updateColumnWithEpicCascade(sessionId, subtaskSessionIds, targetColumn);
} else {
    columnSuccess = await db.updateColumn(sessionId, targetColumn);
}
```

**Note:** `move-card.js` requires from `'../../../out/services/KanbanDatabase'`
(compiled output). All methods used (`getPlanBySessionId`, `getSubtasksByEpicId`,
`updateColumnWithEpicCascade`) are public on `KanbanDatabase` and available in
compiled output. No import changes needed.

## Verification Plan

### Automated Tests
> **Session note:** Compilation and automated tests are skipped for this session
> per user directive. They will be run separately by the user.

1. **Type check:** Run `npm run compile` (webpack) to confirm no TypeScript
   errors — especially that `db.updateColumnTransaction` is used correctly
   (replaces the invalid `db.run` from the original plan).
2. **Unit tests:** Run existing kanban test suite to confirm no regressions in
   column-move logic.

### Manual Verification Steps

1. **Repro on current build:** Create an epic with 2 subtasks on the kanban
   board. Use the project panel's column dropdown (which uses
   `moveCardToColumnByPlanFile`) to move the epic to "Code Reviewed". Confirm
   subtasks stay in their original column (bug).
2. **Apply the fix** and rebuild.
3. **Project panel dropdown test:** Move an epic via the column dropdown.
   Confirm all subtasks move to the same column atomically. Confirm the kanban
   board visually updates (board refresh).
4. **Drag-and-drop regression test:** Move an epic via drag-and-drop on the
   kanban board. Confirm subtasks still cascade (no regression in the working
   path).
5. **Integration sync test:** With Linear/ClickUp integration enabled, move an
   epic via the plan-file path. Confirm subtask statuses update in the external
   system.
6. **Manual script test:** Run `move-card.js` against an epic. Confirm subtasks
   cascade.
7. **Zero-subtask epic test:** Move an epic with no subtasks. Confirm it moves
   without error.
8. **Null-sessionId epic test:** Move an epic that has never been dispatched
   (no sessionId). Confirm the epic + any subtasks with sessions move correctly.
9. **Remote control test:** Trigger a Linear/ClickUp remote column move for an
   epic. Confirm subtasks cascade (verifies the `_remoteApplyColumnMove` caller
   at line 1489).

## Recommendation
Complexity 5 → **Send to Coder**
