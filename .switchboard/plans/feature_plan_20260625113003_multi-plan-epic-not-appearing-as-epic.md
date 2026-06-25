# Multi-Plan Epic Creation Does Not Appear as Epic on Board

## Goal

### Problem
When an epic is created from **multiple selected plans** on the kanban board (`kanban.html`), the resulting epic card does not appear as an epic on the board — it renders as a regular plan card without the `EPIC · N subtasks` badge. The user must select the new card and press the `PROMOTE TO EPIC` button a **second time** to turn it into an actual epic.

The single-plan promotion path (`promoteToEpic`) works correctly — only the multi-plan path (`createEpic`) is affected.

### Background Context
The kanban board has two epic creation paths:
1. **Single plan** → `promoteToEpic` message → `KanbanProvider.ts` line 7426: marks the existing plan as `is_epic=1` in-place, moves its file to `epics/`. Works correctly.
2. **Multiple plans** → `createEpic` message → `KanbanProvider.ts` line 7469: creates a **new** plan record + file in `epics/`, links subtasks via `updateEpicStatus`. This is the broken path.

### Root Cause Analysis
The `createEpic` handler (`KanbanProvider.ts` lines 7469–7562) does the following in order:

1. `upsertPlan({ isEpic: 1, ... })` — INSERT new record with `is_epic=1` (line 7516)
2. `updateEpicStatus(planId, 1, '')` — re-sets `is_epic=1` (line 7545)
3. `writeFile(epicPath, epicContent)` — writes the epic file (line 7554), with `registerPendingCreation` (line 7553)
4. For each subtask: `updateEpicStatus(st.planId, 0, planId)` — links subtasks (line 7558)
5. `_regenerateEpicFile(workspaceRoot, planId, db)` — rewrites the file with subtask section (line 7560), with `registerPendingCreation` (line 8066)
6. `_refreshBoard(workspaceRoot)` — refreshes the board (line 7561)

The `registerPendingCreation` call (line 7553/8066) sets a **3-second timeout** that makes the `GlobalPlanWatcherService` skip the file (line 449–451). After 3 seconds, the entry is deleted (line 43–45).

**The race:** On macOS, `fsevents` can batch and delay file-watch notifications. If the watcher event for the epic file fires **after** the 3-second `registerPendingCreation` window expires, the watcher's `_handlePlanFile` runs. It calls `db.getPlanByPlanFile(relativePath, workspaceId)` (line 469). If the plan is found (it should be, from step 1), the watcher takes the "existing plan" branch (line 584) and calls `insertFileDerivedPlan` (line 593). The `insertFileDerivedPlan` conflict update (lines 1328–1334) does **not** touch `is_epic` — it only updates `topic`, `complexity`, `tags`, `project`, `project_id`, `updated_at`. So `is_epic` is preserved.

**However**, the more likely failure mode is that `getPlanByPlanFile` does **not** find the record due to a `plan_file` path normalization mismatch between the `upsertPlan` path (which uses `path.join('.switchboard', 'epics', ...)`) and the watcher's `getPlanByPlanFile` (which uses `path.relative(workspaceRoot, uri.fsPath)`). If the record is not found, the watcher does a **fresh INSERT** via `insertFileDerivedPlan` (line 1322–1327), which sets `kanban_column='CREATED'` and leaves `is_epic` at its schema default of **0**. Lines 577–579 then check `if (relativePath.startsWith('.switchboard/epics/'))` and call `updateEpicStatus(newRecord.planId, 1, '')` — but `newRecord.planId` is a **newly generated UUID** (line 576's `insertFileDerivedPlan` uses the record's planId, which for a fresh import is derived from the file). This creates a **second** record or conflicts on `(plan_file, workspace_id)`, and the `is_epic=1` update targets the wrong `planId`.

The net effect: after the watcher fires, the epic's `is_epic` flag may be 0 in the DB, causing the board to render it as a regular plan card. Pressing `PROMOTE TO EPIC` a second time calls `promoteToEpic`, which sets `is_epic=1` and moves the file (which is already in `epics/`), fixing the display.

## Metadata
- **Tags:** kanban, epic, file-watcher, race-condition, backend
- **Complexity:** 6/10

## Complexity Audit
**Complex/Risky.** This involves the file watcher (`GlobalPlanWatcherService`), which has subtle timing behavior and path normalization concerns. The fix must not break the single-plan promotion path or the existing watcher import logic. A defensive approach is preferred over relying on timing.

## Edge-Case & Dependency Audit
- **`registerPendingCreation` 3-second window:** The fix should not rely on extending this window indefinitely — that would suppress legitimate user edits to the epic file.
- **`promoteToEpic` path:** Must remain unaffected — it modifies an existing record, not creating a new file.
- **`_regenerateEpicFile`:** Writes the file a second time (line 8067). Each write resets the `registerPendingCreation` timer. The fix must account for both writes.
- **`insertFileDerivedPlan` conflict behavior:** On conflict, it preserves `is_epic`, `kanban_column`, `epic_id`, `status`. On fresh insert, it defaults `is_epic=0`, `kanban_column='CREATED'`.
- **Subtask linking:** The subtask `updateEpicStatus` calls (line 7558) set `epic_id` on subtasks. If the epic's `is_epic` gets reset to 0 by a watcher re-import, the subtasks remain linked but the epic card loses its badge.
- **`getPlanByPlanFile` path matching:** The `_ensureRelativePlanFile` helper (used in `upsertPlan`) and `path.relative` (used in watcher) must produce identical strings. Any trailing slash, backslash, or case difference on macOS would cause a miss.

## Proposed Changes

### `src/services/KanbanProvider.ts` — `createEpic` handler (lines 7469–7562)

**Change 1: Move `updateEpicStatus(planId, 1, '')` to AFTER all file writes.**

Currently, `updateEpicStatus` is called at line 7545 (before file writes). Move it to after `_regenerateEpicFile` and before `_refreshBoard`, so it is the **last DB write** before the board refresh. This ensures that even if a watcher re-import resets `is_epic=0`, the final `updateEpicStatus` call re-asserts `is_epic=1`:

```typescript
// REMOVE the updateEpicStatus call at line 7545 (before writeFile)

// ... existing writeFile, subtask linking, _regenerateEpicFile ...

// AFTER all file writes — re-assert is_epic=1 as the final DB state
await db.updateEpicStatus(planId, 1, '');
await this._refreshBoard(workspaceRoot);
```

**Change 2: Add a defensive `registerPendingCreation` re-registration after `_regenerateEpicFile`.**

Since `_regenerateEpicFile` writes the file (resetting the 3s timer), and `_refreshBoard` is called immediately after, add an explicit `registerPendingCreation` call for the epic path right before `_refreshBoard` to maximize the suppression window:

```typescript
await this._regenerateEpicFile(workspaceRoot, planId, db);
// Re-register to suppress any delayed watcher event from the regenerate write
GlobalPlanWatcherService.registerPendingCreation(epicPath);
await db.updateEpicStatus(planId, 1, '');
await this._refreshBoard(workspaceRoot);
```

**Change 3: Add diagnostic logging to confirm the epic's `is_epic` state after creation.**

After the final `updateEpicStatus`, verify the DB state:

```typescript
await db.updateEpicStatus(planId, 1, '');
const verifyEpic = await db.getPlanByPlanId(planId);
console.log(`[KanbanProvider] createEpic: verify is_epic=${verifyEpic?.isEpic}, kanbanColumn=${verifyEpic?.kanbanColumn}, planFile=${verifyEpic?.planFile}`);
```

### `src/services/GlobalPlanWatcherService.ts` — `_handlePlanFile` (lines 447–601)

**Change 4: Make the epic-path `is_epic` re-assertion robust.**

Lines 594–596 currently only set `is_epic=1` if `!plan.isEpic`. Change this to **always** re-assert `is_epic=1` for files in `.switchboard/epics/`, regardless of the current DB state:

```typescript
if (relativePath.startsWith('.switchboard/epics/')) {
    if (!plan.isEpic) {
        await db.updateEpicStatus(plan.planId, 1, '');
    }
    updatedRecord.isEpic = 1;
}
```

This is already the behavior, but the guard `!plan.isEpic` means if `plan.isEpic` is already 1, it skips. That's correct. The real fix is in Change 1 — ensuring the `createEpic` flow re-asserts `is_epic` as the last DB operation.

## Verification Plan
1. **Reproduce the original bug first** (before applying the fix): Select 2+ plans on the kanban board, create an epic via the modal, and confirm the epic card appears without the EPIC badge.
2. **Apply the fix** and reload the extension.
3. Select 2+ plans, create an epic via the modal. Confirm the epic card appears **immediately** with the `EPIC · N subtasks` badge.
4. Wait 5+ seconds (past the `registerPendingCreation` window) and trigger a board refresh. Confirm the epic **still** shows the EPIC badge (no watcher re-import reset it).
5. Select the new epic card alone — confirm the EPIC button is **disabled** (proving `isEpic=true` in the card data). If the button were enabled, it would mean `isEpic=false`.
6. Verify the single-plan `promoteToEpic` path still works: select 1 plan, promote it, confirm it shows the EPIC badge.
7. Check the debug console for the diagnostic log line confirming `is_epic=1` after creation.
