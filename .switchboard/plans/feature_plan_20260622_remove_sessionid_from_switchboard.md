# Remove sessionId from Switchboard Extension

## Goal

Fully eradicate `sessionId` / `session_id` from the switchboard extension. Every plan is already uniquely identified by `(plan_file, workspace_id)` or `plan_id`. The `session_id` column is a legacy artefact from when Claude's process session ID was used as the plan primary key. It is the source of orphan-plan bugs, duplicate-row bugs, and fallback-ID generation bugs. This plan removes it completely with no compatibility shims left behind.

---

## Context: Why It Keeps Surviving

Agents kill one surface and leave three others. The surfaces are:

1. **The `sess_` fallback generator** — `TaskViewerProvider.ts:12779` and `:12799`. When no Claude session ID is found in `state.json`, code fabricates `sess_${Date.now()}`. This creates orphan DB rows with garbage primary keys.
2. **~20 `sessionId`-keyed DB methods on `KanbanDatabase`** — `getPlanBySessionId`, `updateColumn(sessionId)`, `movePlan(sessionId)`, `deletePlan(sessionId)`, `updateComplexity(sessionId)`, `updateTags(sessionId)`, `updateStatus(sessionId)`, `updateLastAction(sessionId)`, `updateTopic(sessionId)`, `updatePlanFile(sessionId)`, `updateBrainPaths(sessionId)`, `isOwnedActive(sessionId)`, `updateColumnTransaction(sessionIds[])`, `updateSessionId`, `hasPlan(sessionId)`, `getPlanFilePath(sessionId)`, `reviveDeletedPlans(sessionIds[])`, `completeMultiple(sessionIds[])`, `appendPlanEvent(sessionId)`, `getPlanEvents(sessionId)`, `getRunSheet(sessionId)`, `migrateSessionEvents(sessionId)`, `deletePlanEvents(sessionId)`, `updateDispatchInfo(sessionId)`, `updateLinearIssueId(sessionId)`, `updateClickUpTaskId(sessionId)`.
3. **The `session_id` SQL column** — present in the `plans`, `plan_events`, and `activity_log` tables. Can't be removed without a DB migration.
4. **All callers** across six service files + two webview JS files + `extension.ts` command registrations.
5. **The `sessionId` field on interfaces** — `KanbanPlanRecord`, `KanbanDispatchCard`, `LiveSyncState`, `PlanningPanelProvider` local type, `ArchiveManager` local type, `NotionBackupService` local type, `SessionActionLog` sheet shape.
6. **`_lastSessionId`** — private field on `TaskViewerProvider`, used to resume tracking after IDE restart. Must be replaced by `_lastPlanFile`.
7. **The `_planRegistry`** — one code path still indexes by `sheet.sessionId` at line `11080`.

All `ByPlanFile` and `ByPlanId` replacement methods already exist in `KanbanDatabase`. Five methods have no `ByPlanId` variant yet and need to be added before callers can be migrated (Phase 1).

---

## What Already Exists (Do Not Re-Create)

These replacement methods are live in `KanbanDatabase.ts` and must be used:

| Old method | Replacement |
|---|---|
| `hasPlan(sessionId)` | `hasPlanByPlanFile(planFile, workspaceId)` |
| `updateColumn(sessionId, col)` | `updateColumnByPlanFile(planFile, workspaceId, col)` |
| `movePlan(sessionId, col)` | `movePlanByPlanFile(planFile, workspaceId, col)` |
| `updateComplexity(sessionId, c)` | `updateComplexityByPlanFile(planFile, workspaceId, c)` or `updateComplexityByPlanId(planId, c)` |
| `updateTags(sessionId, t)` | `updateTagsByPlanFile(planFile, workspaceId, t)` |
| `updateStatus(sessionId, s)` | `updateStatusByPlanFile(planFile, workspaceId, s)` |
| `updateLastAction(sessionId, a)` | `updateLastActionByPlanFile(planFile, workspaceId, a)` |
| `updateTopic(sessionId, t)` | `updateTopicByPlanFile(planFile, workspaceId, t)` |
| `deletePlan(sessionId)` | `deletePlanByPlanFile(planFile, workspaceId)` or `deletePlanByPlanId(planId)` |
| `reviveDeletedPlans(sessionIds[])` | `reviveDeletedPlansByPlanFile(entries[])` |
| `completeMultiple(sessionIds[])` | `completeMultipleByPlanFile(entries[])` |
| `getPlanBySessionId(sessionId)` | `getPlanByPlanFile(planFile, workspaceId)` or `getPlanByPlanId(planId)` |
| `getPlanFilePath(sessionId)` | `getPlanFilePathByPlanFile(planFile, workspaceId)` |
| `appendPlanEvent(sessionId, e)` | `appendPlanEventByPlanId(planId, e)` |
| `getPlanEvents(sessionId)` | `getPlanEventsByPlanId(planId)` |
| `getRunSheet(sessionId)` | `getRunSheetByPlanId(planId)` |
| `deletePlanEvents(sessionId)` | `deletePlanEventsByPlanId(planId)` |
| `updateDispatchInfo(sessionId, i)` | `updateDispatchInfoByPlanFile(planFile, workspaceId, i)` |
| `updateLinearIssueId(sessionId, id)` | `updateLinearIssueIdByPlanFile(planFile, workspaceId, id)` |
| `updateClickUpTaskId(sessionId, id)` | `updateClickUpTaskIdByPlanFile(planFile, workspaceId, id)` |

---

## Phase 1 — Add the Five Missing `ByPlanId` Methods to `KanbanDatabase`

File: `src/services/KanbanDatabase.ts`

These five methods have no planId/planFile variant. Add them before touching any callers.

### 1.1 `updatePlanFileByPlanId(planId: string, newPlanFile: string, skipTimestampUpdate?: boolean): Promise<boolean>`

The existing `updatePlanFile(sessionId, planFile)` does a sessionId lookup then updates by `plan_id`. Just add an overload that accepts `planId` directly and calls the same SQL (`UPDATE plans SET plan_file = ?, updated_at = ? WHERE plan_id = ?`).

### 1.2 `updateBrainPathsByPlanId(planId: string, brainSourcePath: string, mirrorPath: string): Promise<boolean>`

The existing `updateBrainPaths(sessionId, ...)` does sessionId→planId lookup then `UPDATE plans SET brain_source_path = ?, mirror_path = ?, updated_at = ? WHERE session_id = ?`. New version uses `WHERE plan_id = ?` directly.

### 1.3 `isOwnedActiveByPlanId(planId: string, workspaceId: string): Promise<boolean>`

The existing `isOwnedActive(sessionId, workspaceId)` runs `SELECT 1 FROM plans WHERE session_id = ? AND workspace_id = ? AND status = 'active'`. New version: `WHERE plan_id = ?`.

### 1.4 `updateColumnTransactionByPlanId(planIds: string[], targetColumn: string): Promise<boolean>`

The existing `updateColumnTransaction(sessionIds[], targetColumn)` is a bulk UPDATE via `session_id IN (...)`. New version does the same via `plan_id IN (...)`. The method body at line 3648 can serve as the template.

### 1.5 `migrateSessionEventsByPlanId(planId: string, events: any[]): Promise<number>`

The existing `migrateSessionEvents(sessionId, events)` inserts into `plan_events` using the `plan_id` FK (migration V20 moved `plan_events` to `plan_id` FK). New version just takes `planId` directly — no sessionId lookup needed. Check lines 5299–5350 of `KanbanDatabase.ts` for the insert logic.

---

## Phase 2 — Remove the `sess_` Fallback ID Generator

File: `src/services/TaskViewerProvider.ts`, lines ~12766–12820

The block currently reads (simplified):

```ts
let sessionId: string | undefined;
if (fs.existsSync(statePath)) { /* read state.json → sessionId */ }
if (!sessionId) {
    sessionId = `sess_${Date.now()}`;  // ← DELETE THIS BRANCH
} else {
    // collision check that assigns sess_${Date.now()}_${random} ← DELETE THIS BLOCK
}
```

**Replace with:** if no Claude session ID is found in `state.json`, do **not** fabricate one. The plan is identified by its `planFile` alone. The runsheet and DB row should be created/found by `planFile` + `workspaceId` from that point forward in the function. The `sessionId` local variable itself can be removed from this code path — callers downstream in the same function that pass `sessionId` to DB methods should already be on `ByPlanFile` variants after Phase 3.

The `sess_` watcher-created-row cleanup code in `KanbanDatabase.ts` (lines 3405–3430, 3535–3570) can be removed once the generator is gone. Leave it in for now (Phase 5 cleanup).

---

## Phase 3 — Migrate All Callers in Service Files

For each file: find every call that passes a `sessionId`, switch to the `planFile`/`planId` variant. The key is that by the time any service method is called, the caller already has the `KanbanPlanRecord` (which contains both `planFile` and `planId`). Use those. Do not do a secondary `getPlanBySessionId` lookup to get the planFile — the record is already in scope.

### 3.1 `src/services/ContinuousSyncService.ts` (~116 references)

- The `_states: Map<planFile, LiveSyncState>` is already keyed by `planFile`. Good.
- The `_syncQueue: Array<{ sessionId: string; priority: number }>` must change to `{ planFile: string; priority: number }`.
- All method signatures `pausePlan(sessionId)`, `resumePlan(sessionId)`, `checkForConflicts(sessionId)`, `getState(sessionId)`, `_maybeSync(sessionId)`, `_executeSync(sessionId)`, `_showConflictDialog(sessionId)`, `_bumpEpoch(sessionId)`, `_isCurrentEpoch(sessionId)`, `_createInitialState(sessionId)`, `_getPlanRecord(sessionId)`, `_getPlanTopicSafe(sessionId)` — replace `sessionId: string` with `planFile: string` throughout. Update the single `_getPlanRecord` call that calls `db.getPlanBySessionId(sessionId)` → `db.getPlanByPlanFile(planFile, workspaceId)`.
- `LiveSyncState` in `src/models/LiveSyncTypes.ts` line 11: remove `sessionId: string`.

### 3.2 `src/services/TaskViewerProvider.ts` (~366 references)

This is the largest file. Work through it by callsite cluster:

- **`_lastSessionId` field** (line 341): rename to `_lastPlanFile: string | null`. Update all reads/writes at lines 1562, 1567, 1790, 16271, 16286.
- **`selectSession(sessionId)` method** (line 1789): rename to `selectPlan(planFile)`. Update the VSCode command handler in `extension.ts` at line 691.
- **`_resolveWorkspaceRootForSession(sessionId)`** (line 1049): rename to `_resolveWorkspaceRootForPlan(planFile)`. The DB call inside at line 1072 becomes `db.getPlanByPlanFile(planFile, workspaceId)` (workspaceId must be threaded through or resolved from the planFile path).
- **`KanbanDispatchCard.sessionId`** (line 106): remove the field. The primary identifier is `planId`. Update `_dispatchCardId(card)` at line 317 to return `card.planId` only.
- **`_planRegistry.entries[sheet.sessionId]`** at line 11080: change to `_planRegistry.entries[planId]` — the registry is already indexed by `planId` everywhere else.
- **Batch trigger / forward/backward move handlers**: these receive `sessionIds: string[]` as arguments (and as command parameters in `extension.ts`). Change to `planIds: string[]`.
- **All `db.updatePlanFile(plan.sessionId, ...)`** calls (e.g. line 2736): use `db.updatePlanFileByPlanId(plan.planId, ...)` from Phase 1.
- **`handleKanbanCompletePlan(sessionId)`**, **`handleDeletePlanFromReview(sessionId)`**: change to `handleKanbanCompletePlan(planId)` and `handleDeletePlanFromReview(planId)`. Update call sites in webviews.
- **The `currentColumnBySession.set(row.planId || row.sessionId, ...)`** fallbacks at lines 2383 and 6826: use `row.planId` only.
- **`routedSessions[role].push({ sessionId: card.sessionId, ... })`** at line 7709: remove `sessionId` from the pushed shape.
- **`handleKanbanRestorePlan(data.sessionId)`** at line 8851: use `data.planId`.
- **Any webview message with `{ sessionId: ... }`**: update the message shape to use `planId` or `planFile`. See lines 2569, 2605, 2677, 2696, 2763 in `PlanningPanelProvider.ts`.

### 3.3 `src/services/PlanningPanelProvider.ts`

- Local interface at line 43 includes `sessionId: string` — remove.
- Message handlers at lines 2569, 2605, 2677, 2696, 2763 extract `sessionId` from `msg.sessionId` — switch to `msg.planId` or `msg.planFile`.
- Line 3330: `db.updatePlanFile(plan.sessionId, newRelative)` → `db.updatePlanFileByPlanId(plan.planId, newRelative)`.
- Line 7416: `sessionId: r.sessionId || ''` in serialized response — remove field.
- Line 1797: `sessionId: msg.sessionId || ''` — remove.

### 3.4 `src/services/GlobalPlanWatcherService.ts`

- Line 503: `sessionId: ''` in upsert object — remove field.
- Line 552: `sessionId: plan.sessionId` in upsert object — remove field.

### 3.5 `src/services/KanbanMigration.ts`

- Line 5: `sessionId: string` in local interface — remove.
- Line 58: `db.updateColumn(row.sessionId, remappedColumn)` → `db.updateColumnByPlanFile(row.planFile, row.workspaceId, remappedColumn)`.

### 3.6 `src/services/NotionBackupService.ts`

- Line 105: `columnUpdates: Array<{ sessionId: string; column: string }>` → `Array<{ planId: string; column: string }>`.
- Line 129: `columnUpdates.push({ sessionId: plan.sessionId, ... })` → `{ planId: plan.planId, ... }`.
- Line 276: `'Session ID': { rich_text: [{ text: { content: plan.sessionId } }] }` — remove this Notion property entirely (it was only ever written for debugging and is not used on restore).
- Line 304: `sessionId: getRichText(p['Session ID'])` — remove.

### 3.7 `src/services/PipelineOrchestrator.ts`

- Line 17: `DispatchCallback` type includes `sessionId: string` parameter — remove.
- Line 223: `const sessionId: string = sheet.sessionId` — change to use `planId` or `planFile` from the sheet.

### 3.8 `src/services/ArchiveManager.ts`

- Line 12: `sessionId: string` in local interface — remove.
- Line 32: same — remove.
- Line 158: DuckDB INSERT includes `plan.sessionId` — remove that column from the archive schema (it was only ever written for debugging; there is no FK use in DuckDB).
- Line 278: similar — remove `sessionId` from the outcome INSERT.

### 3.9 `src/services/LinearAutomationService.ts` and `ClickUpAutomationService.ts`

- Line 475 (Linear) and 332 (ClickUp): `_buildWriteBackSummary(planContent, plan.sessionId, rule.name)` — the `sessionId` parameter in `_buildWriteBackSummary` is used for display only (not written to DB). Replace with `plan.planId`.
- Line 478 (Linear) and 336 (ClickUp): `db.updateLastAction(plan.sessionId, ...)` → `db.updateLastActionByPlanFile(plan.planFile, plan.workspaceId, ...)`.

### 3.10 `src/services/SessionActionLog.ts`

- Line 464: `_composeHydratedSheet(sessionId, ...)` — this is the runsheet read/write layer. Check how `sessionId` is used as the runsheet file key. If it's used as the filename on disk, replace with `planId`. If it's only used as an in-memory map key, replace with `planId`. The `_writeLocks` map at line 478 should be keyed by `planId`.
- Lines 477–506: `createRunSheet(sessionId, data)` — rename to `createRunSheetByPlanId(planId, data)`.
- Line 491–492: the fallback `normalized.sessionId = planFile` is compensating for missing IDs. With the generator gone (Phase 2), all sheets have real planIds. Remove the fallback; throw instead if planId is missing.
- Line 538: `updateRunSheet(sessionId, updater)` → `updateRunSheetByPlanId(planId, updater)`.

### 3.11 `src/services/agentPromptBuilder.ts`

- Line 17: `sessionId?: string` in the options type — remove.

### 3.12 `src/extension.ts`

- Line 691: `switchboard.selectSession` command → rename to `switchboard.selectPlan`. Update webview callers.
- Lines 1111–1122: `switchboard.triggerAgentFromKanban`, `switchboard.analystMapFromKanban`, `switchboard.analystMapFromKanbanBatch` — parameters change from `sessionId: string` / `sessionIds: string[]` to `planId: string` / `planIds: string[]`.
- Lines 1131, 1141, 1146, 1151, 1161, 1166: same for batch trigger, backward/forward move, complete, delete, copy commands.

### 3.13 Webviews: `src/webview/project.js` and `src/webview/planning.js`

Search for `sessionId` in both files and update all message sends to use `planId` or `planFile` instead. These are the messages the webview sends back to the extension host — they must match the command parameter changes in 3.12.

---

## Phase 4 — Remove All Deprecated sessionId DB Methods

File: `src/services/KanbanDatabase.ts`

After all callers are migrated (Phase 3), delete the following methods entirely. No `@deprecated` stub, no empty shell — full deletion:

- `getPlanBySessionId(sessionId)`
- `hasPlan(sessionId)` (the sessionId overload; `hasPlanByPlanFile` is the only one needed)
- `updateColumn(sessionId, col)`
- `movePlan(sessionId, col)`
- `updateComplexity(sessionId, c)`
- `updateTags(sessionId, t)`
- `updateStatus(sessionId, s)`
- `updateLastAction(sessionId, a)`
- `updateTopic(sessionId, t)`
- `updatePlanFile(sessionId, planFile)` (replaced by `updatePlanFileByPlanId` from Phase 1)
- `updateBrainPaths(sessionId, ...)` (replaced by `updateBrainPathsByPlanId` from Phase 1)
- `isOwnedActive(sessionId, workspaceId)` (replaced by `isOwnedActiveByPlanId` from Phase 1)
- `updateColumnTransaction(sessionIds[])` (replaced by `updateColumnTransactionByPlanId` from Phase 1)
- `migrateSessionEvents(sessionId, events)` (replaced by `migrateSessionEventsByPlanId` from Phase 1)
- `updateSessionId(oldSessionId, newSessionId)` — delete, no replacement (concept no longer exists)
- `deletePlan(sessionId)`
- `reviveDeletedPlans(sessionIds[])`
- `completeMultiple(sessionIds[])`
- `appendPlanEvent(sessionId, event)`
- `getPlanEvents(sessionId)`
- `getRunSheet(sessionId)`
- `deletePlanEvents(sessionId)`
- `updateDispatchInfo(sessionId, info)`
- `updateLinearIssueId(sessionId, id)`
- `updateClickUpTaskId(sessionId, id)`
- `getPlanFilePath(sessionId)` (superseded by `getPlanFilePathByPlanFile`)

Also remove:
- The `sess_`-row deduplication helpers (lines ~3405–3430 and ~3535–3570) — these cleaned up rows that the now-deleted generator created.
- `getRunSheet(sessionId)` fallback path and `_writeLocks.get(sessionId)` in `SessionActionLog.ts`.

---

## Phase 5 — DB Schema Migration (V36 placeholder — verify at implementation time)

File: `src/services/KanbanDatabase.ts`

Add a new migration SQL constant and register it in the migration runner. The version number here is a placeholder — check the actual latest migration in `KanbanDatabase.ts` at implementation time and use the next one after that. As of plan-writing the DB is at V35 and another V36 plan is queued, so this will likely land as **V37**, but verify before writing the constant.

### 5.1 Drop `session_id` from `plans`

SQLite does not support `ALTER TABLE DROP COLUMN` in versions before 3.35. Use the safe copy-swap pattern:

```sql
-- 1. New plans table without session_id
CREATE TABLE plans_new (
    plan_id       TEXT PRIMARY KEY NOT NULL,
    topic         TEXT NOT NULL DEFAULT '',
    plan_file     TEXT NOT NULL DEFAULT '',
    kanban_column TEXT NOT NULL DEFAULT 'Created',
    status        TEXT NOT NULL DEFAULT 'active',
    complexity    TEXT DEFAULT '',
    tags          TEXT DEFAULT '',
    workspace_id  TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT '',
    updated_at    TEXT NOT NULL DEFAULT '',
    last_action   TEXT DEFAULT '',
    source_type   TEXT DEFAULT 'local',
    linear_issue_id    TEXT DEFAULT '',
    clickup_task_id    TEXT DEFAULT '',
    brain_source_path  TEXT DEFAULT '',
    mirror_path        TEXT DEFAULT '',
    epic_id       TEXT DEFAULT '',
    is_epic       INTEGER DEFAULT 0,
    project_id    TEXT DEFAULT '',
    project       TEXT DEFAULT '',
    routed_to     TEXT DEFAULT '',
    dispatched_agent   TEXT DEFAULT '',
    dispatched_ide     TEXT DEFAULT '',
    UNIQUE(plan_file, workspace_id)
);
-- 2. Copy all rows (exclude session_id)
INSERT INTO plans_new SELECT plan_id, topic, plan_file, kanban_column, status, complexity, tags,
    workspace_id, created_at, updated_at, last_action, source_type, linear_issue_id, clickup_task_id,
    brain_source_path, mirror_path, epic_id, is_epic, project_id, project,
    routed_to, dispatched_agent, dispatched_ide FROM plans;
-- 3. Swap
DROP TABLE plans;
ALTER TABLE plans_new RENAME TO plans;
```

> **Important:** verify the exact column list by reading the current `plans` table schema from the latest migration in `KanbanDatabase.ts` before writing the INSERT. Do not guess column names.

### 5.2 Drop `session_id` from `plan_events`

Migration V20 already migrated `plan_events` to use `plan_id` FK. Confirm whether `session_id` column still physically exists in that table after V20 ran. If it does, use the same copy-swap pattern to drop it.

### 5.3 Drop `session_id` from `activity_log`

`activity_log` has `session_id TEXT` (nullable, no FK). Add it to the copy-swap for that table, or if SQLite ≥ 3.35 is guaranteed (check the bundled better-sqlite3/sql.js version), use `ALTER TABLE activity_log DROP COLUMN session_id`.

### 5.4 Drop orphaned indexes

```sql
DROP INDEX IF EXISTS idx_plans_session_id_unique;
DROP INDEX IF EXISTS idx_events_session;
DROP INDEX IF EXISTS idx_activity_session;
```

Recreate `idx_events_session` and `idx_activity_session` without the `session_id` column (or drop them entirely if nothing queries by session anymore).

---

## Phase 6 — Remove `sessionId` from All Interfaces and Types

After Phases 3–5 compile cleanly, remove the field declarations:

- `KanbanPlanRecord.sessionId: string` — the record shape used everywhere a DB row is returned
- `KanbanDispatchCard.sessionId: string` in `TaskViewerProvider.ts:106`
- `LiveSyncState.sessionId` in `src/models/LiveSyncTypes.ts:11`
- Local interface in `PlanningPanelProvider.ts:43`
- Local interfaces in `ArchiveManager.ts:12` and `:32`
- Local interface in `NotionBackupService.ts`
- `JulesSessionRecord.planSessionId` at `TaskViewerProvider.ts:120` — this was a sessionId alias; replace with `planId` if still needed
- `agentPromptBuilder.ts:17` options type

Also clean up `PLAN_COLUMNS` constant at `KanbanDatabase.ts:589` to remove `session_id` from the SQL select list after the column is dropped (Phase 5).

---

## Phase 7 — Tests

The following test files create/reference `sessionId`. Update them to use `planId` / `planFile`:

- `src/test/kanban-database-*.test.js` (all)
- `src/test/brain-session-dedupe.test.js`
- `src/test/continuous-sync-*.test.js`
- `src/test/pipeline-orchestrator-regression.test.js`
- `src/test/session-action-log.test.ts`
- `src/test/pair-programming-comprehensive.test.ts`
- `src/services/__tests__/KanbanDatabase.epicStatus.test.ts`
- `src/services/__tests__/KanbanProvider.test.ts`
- `src/services/__tests__/planMetadataUtils.test.ts`
- All integrations test harness files under `src/test/integrations/`

Do not add new tests for the removal itself. Update existing tests to construct `planId`/`planFile`-keyed fixtures instead of `sessionId`-keyed ones.

---

## Order of Execution

1. Phase 1 (add 5 new DB methods) — prerequisite for everything
2. Phase 2 (kill sess_ generator) — can be done alongside Phase 1
3. Phase 3 (migrate callers) — work file by file; compile after each file
4. Phase 4 (delete old DB methods) — only after Phase 3 compiles clean
5. Phase 5 (DB migration V21) — only after Phase 4
6. Phase 6 (clean interfaces) — only after Phase 5 compiles clean
7. Phase 7 (tests) — last

Do not skip ahead. Each phase is a compile gate for the next.

## Completion Criteria

- `grep -r "sessionId\|session_id\|sess_" src/` returns zero hits in non-test, non-comment source code
- All `@deprecated` method stubs are gone — nothing left behind
- DB schema has no `session_id` column in `plans`, `plan_events`, or `activity_log`
- The `sess_${Date.now()}` pattern does not exist anywhere in the codebase
- Extension compiles with `tsc --noEmit` with zero errors
- All existing tests pass (they will need updates per Phase 7)
