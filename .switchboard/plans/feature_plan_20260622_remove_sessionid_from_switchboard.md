# Remove sessionId from Switchboard Extension

## Goal

Fully eradicate `sessionId` / `session_id` from the switchboard extension. Every plan is already uniquely identified by `(plan_file, workspace_id)` or `plan_id`. The `session_id` column is a legacy artefact from when Claude's process session ID was used as the plan primary key. It is the source of orphan-plan bugs, duplicate-row bugs, and fallback-ID generation bugs. This plan removes it completely with no compatibility shims left behind.

**Root-Cause Analysis:** The `session_id` column was the original primary key for plans, derived from Claude's process session ID. When the architecture moved to `plan_id` (UUID) and `(plan_file, workspace_id)` as the natural key, `session_id` was left behind as a vestigial column. The `sess_${Date.now()}` fallback generator was added to handle cases where no Claude session ID was found in `state.json`, but this fabricated garbage primary keys that created orphan DB rows. Multiple deduplication helpers (`cleanupSpuriousMirrorPlans`, `cleanupDuplicateLocalPlans`) were added as band-aids to clean up the orphan rows, but they treat the symptom not the disease. The `session_id` column persists across `plans`, `activity_log`, and ~26 DB methods because agents migrate callers piecemeal and leave the old methods behind. This plan completes the eradication in a single coordinated pass.

---

## Metadata

**Tags:** [backend, refactor, database]
**Complexity:** 8
**Latest Migration:** V37 (as of 2026-06-23) — this plan's migration will be **V38**

---

## User Review Required

Yes — this plan touches the SQLite schema of a published extension with ~4,000 installs. The DB migration (Phase 5) is irreversible (copy-swap drops the old table). A failed migration on a user's machine could corrupt their kanban database. The user must review:
1. The Phase 5 copy-swap SQL (corrected below with the verified 28-column schema)
2. The runsheet filename transition strategy (Phase 3.10)
3. The decision to drop `session_id` from `activity_log` (Phase 5.3)

---

## Context: Why It Keeps Surviving

Agents kill one surface and leave three others. The surfaces are:

1. **The `sess_` fallback generator** — `TaskViewerProvider.ts` at lines ~13076–13100 (line numbers are approximate; search for `sess_${Date.now()}`). When no Claude session ID is found in `state.json`, code fabricates `sess_${Date.now()}`. This creates orphan DB rows with garbage primary keys.
2. **~20 `sessionId`-keyed DB methods on `KanbanDatabase`** — `getPlanBySessionId`, `updateColumn(sessionId)`, `movePlan(sessionId)`, `deletePlan(sessionId)`, `updateComplexity(sessionId)`, `updateTags(sessionId)`, `updateStatus(sessionId)`, `updateLastAction(sessionId)`, `updateTopic(sessionId)`, `updatePlanFile(sessionId)`, `updateBrainPaths(sessionId)`, `isOwnedActive(sessionId)`, `updateColumnTransaction(sessionIds[])`, `updateSessionId`, `hasPlan(sessionId)`, `getPlanFilePath(sessionId)`, `reviveDeletedPlans(sessionIds[])`, `completeMultiple(sessionIds[])`, `appendPlanEvent(sessionId)`, `getPlanEvents(sessionId)`, `getRunSheet(sessionId)`, `migrateSessionEvents(sessionId)`, `deletePlanEvents(sessionId)`, `updateDispatchInfo(sessionId)`, `updateLinearIssueId(sessionId)`, `updateClickUpTaskId(sessionId)`.
3. **The `session_id` SQL column** — present in the `plans` and `activity_log` tables. Already removed from `plan_events` in V20. Can't be removed from `plans`/`activity_log` without a DB migration.
4. **All callers** across six service files + two webview JS files + `extension.ts` command registrations.
5. **The `sessionId` field on interfaces** — `KanbanPlanRecord`, `KanbanDispatchCard`, `LiveSyncState`, `PlanningPanelProvider` local type, `ArchiveManager` local type, `NotionBackupService` local type, `SessionActionLog` sheet shape.
6. **`_lastSessionId`** — private field on `TaskViewerProvider` (line 341), used to resume tracking after IDE restart. Must be replaced by `_lastPlanFile`.
7. **The `_planRegistry`** — one code path still indexes by `sheet.sessionId` (search for `_planRegistry.entries[sheet.sessionId]`, approximately line 11377).

All `ByPlanFile` and `ByPlanId` replacement methods already exist in `KanbanDatabase`. **Four** methods have no `ByPlanId` variant yet and need to be added before callers can be migrated (Phase 1). Note: `updatePlanFile` already has a `ByPlanId` variant at line 1740 — it does NOT need a new method.

> **Line Number Disclaimer:** Line numbers in this plan were verified against the codebase on 2026-06-23 but are subject to drift. Always use the grep search patterns provided alongside line numbers to locate the exact code. Do not rely on line numbers alone.

---

## What Already Exists (Do Not Re-Create)

These replacement methods are live in `KanbanDatabase.ts` and must be used:

|| Old method | Replacement | Verified Line |
||---|---|---|
|| `hasPlan(sessionId)` | `hasPlanByPlanFile(planFile, workspaceId)` | 1348 |
|| `updateColumn(sessionId, col)` | `updateColumnByPlanFile(planFile, workspaceId, col)` | 1391 |
|| `movePlan(sessionId, col)` | `movePlanByPlanFile(planFile, workspaceId, col)` | 1448 |
|| `updateComplexity(sessionId, c)` | `updateComplexityByPlanFile(planFile, workspaceId, c)` or `updateComplexityByPlanId(planId, c)` | 1527 / 1548 |
|| `updateTags(sessionId, t)` | `updateTagsByPlanFile(planFile, workspaceId, t)` | 1560 |
|| `updateStatus(sessionId, s)` | `updateStatusByPlanFile(planFile, workspaceId, s)` | 1601 |
|| `updateLastAction(sessionId, a)` | `updateLastActionByPlanFile(planFile, workspaceId, a)` | 1679 |
|| `updateTopic(sessionId, t)` | `updateTopicByPlanFile(planFile, workspaceId, t)` | 1694 |
|| `deletePlan(sessionId)` | `deletePlanByPlanFile(planFile, workspaceId)` or `deletePlanByPlanId(planId)` | 1825 / 1844 |
|| `reviveDeletedPlans(sessionIds[])` | `reviveDeletedPlansByPlanFile(entries[])` | 1620 |
|| `completeMultiple(sessionIds[])` | `completeMultipleByPlanFile(entries[])` | 2780 |
|| `getPlanBySessionId(sessionId)` | `getPlanByPlanFile(planFile, workspaceId)` or `getPlanByPlanId(planId)` | 2571 / 2550 |
|| `getPlanFilePath(sessionId)` | `getPlanFilePathByPlanFile(planFile, workspaceId)` | 1482 |
|| `appendPlanEvent(sessionId, e)` | `appendPlanEventByPlanId(planId, e)` | 5335 |
|| `getPlanEvents(sessionId)` | `getPlanEventsByPlanId(planId)` | 5374 |
|| `getRunSheet(sessionId)` | `getRunSheetByPlanId(planId)` | 5461 |
|| `deletePlanEvents(sessionId)` | `deletePlanEventsByPlanId(planId)` | 5537 |
|| `updateDispatchInfo(sessionId, i)` | `updateDispatchInfoByPlanFile(planFile, workspaceId, i)` | 5564 |
|| `updateLinearIssueId(sessionId, id)` | `updateLinearIssueIdByPlanFile(planFile, workspaceId, id)` | 1759 |
|| `updateClickUpTaskId(sessionId, id)` | `updateClickUpTaskIdByPlanFile(planFile, workspaceId, id)` | 1792 |
|| `updatePlanFile(sessionId, planFile)` | `updatePlanFileByPlanId(planId, newPlanFile)` — **ALREADY EXISTS at line 1740** | 1740 |

---

## Complexity Audit

### Routine
- Deleting 26 deprecated DB methods from `KanbanDatabase.ts` (Phase 4) — mechanical deletion after callers are migrated
- Removing `sessionId` field from interface declarations (Phase 6) — straightforward field removal
- Updating webview JS message shapes to use `planId`/`planFile` (Phase 3.13) — find-and-replace in 2 files
- Updating `extension.ts` command registrations (Phase 3.12) — parameter renames
- Removing `sessionId` from `NotionBackupService` and `ArchiveManager` (Phases 3.6, 3.8) — field removal from serialization
- Updating test fixtures (Phase 7) — mechanical replacement of `sessionId` with `planId`/`planFile`

### Complex / Risky
- **Phase 5 DB migration (copy-swap)** — irreversible schema change on a published extension with ~4,000 installs. The copy-swap SQL must exactly match the current 29-column schema or data is lost. Must handle the UNIQUE index `idx_plans_plan_file_workspace` correctly.
- **Phase 2 sess_ generator removal** — changes the plan creation flow. If downstream code still expects a `sessionId` to exist, it will get `undefined` and crash. Must verify all downstream consumers are migrated first.
- **Phase 3.10 SessionActionLog runsheet filename transition** — existing runsheet files on disk are keyed by the old `sessionId`/`planFile`. Removing the `normalized.sessionId = planFile` fallback (line 492) without a transition path will make existing runsheets unreadable. The `_resolvePlan` hybrid fallback (line 70–76) must also be updated.
- **Phase 3.2 TaskViewerProvider migration** — 470 occurrences of `sessionId` across 18,879 lines. This is the highest-risk file. A missed callsite will cause a runtime error.
- **`activity_log` INSERT paths** — must be identified and migrated before the `session_id` column is dropped (Phase 5.3), or every activity log write will crash.
- **`_lastSessionId` → `_lastPlanFile` rename** — used for IDE restart recovery. If the restart recovery flow breaks, users lose their active plan tracking after restarting VS Code.

---

## Edge-Case & Dependency Audit

### Race Conditions
- **Runsheet write locks**: `_writeLocks` map in `SessionActionLog.ts` (line 37) is keyed by `sessionId`. If renamed to `planId` while a write is in flight, the lock key won't match and concurrent writes could corrupt the runsheet. Must drain all in-flight writes before renaming, or use a transition key.
- **ContinuousSyncService sync queue**: `_syncQueue` (line 23) is an array of `{ sessionId, priority }`. If the queue is mid-flush when the key changes, queued items won't match the new `planFile` key. Must drain or migrate the queue atomically.
- **DB migration during active sync**: If the copy-swap migration runs while ContinuousSyncService is writing to `plans`, the write could target the old table after it's been dropped. The migration must acquire an exclusive lock or pause sync.

### Security
- No security implications — `sessionId` is not used for authentication or authorization. It's an internal identifier.

### Side Effects
- **Notion backup "Session ID" property removal** (Phase 3.6, line 276): Existing Notion pages will retain the property but new backups won't write it. This is cosmetic, not breaking.
- **Archive schema change** (Phase 3.8): DuckDB archive table loses `session_id` column. Existing archived data retains the column; new archives don't write it. No FK in DuckDB so no integrity issue.
- **`updateSessionId` deletion** (Phase 4): This method was used to remap session IDs when Claude restarted. With `planId` as the stable identifier, this concept no longer exists. Verify no caller depends on session ID remapping for plan continuity.

### Dependencies & Conflicts
- **Migration V38 must run after V37** — V37 is the latest verified migration. Check for any other queued migrations before assigning V38.
- **`plan_events` already migrated in V20** — `session_id` was removed from `plan_events` and replaced with `plan_id` FK. Phase 5.2 is confirmation-only, no SQL needed.
- **UNIQUE index `idx_plans_plan_file_workspace`** (line 183, recreated in V20 at line 392) — the copy-swap must recreate this index on the new table, not use a table-level UNIQUE constraint.
- **`PLAN_COLUMNS` constant** (line 589) — includes `session_id`. Must be updated in the same migration that drops the column, or SELECT queries will reference a non-existent column.

---

## Dependencies

- None — this plan is self-contained. All prerequisite `ByPlanFile`/`ByPlanId` methods already exist in the codebase.

---

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) Phase 5 copy-swap SQL must use the verified 28-column schema (excluding `session_id`) with correct types and defaults — the original plan's SQL was missing 5 columns and had wrong types, which would cause data loss for 4,000 users; (2) runsheet filename transition in SessionActionLog.ts must handle existing on-disk files keyed by old sessionId/planFile — removing the fallback without a transition path makes existing runsheets unreadable; (3) `activity_log` INSERT paths must be identified and migrated before the column is dropped. Mitigations: rewrite Phase 5 SQL against the verified schema (corrected below), add a read-both fallback for runsheet filenames during transition, and audit `activity_log` INSERT callsites in Phase 3.

---

## Proposed Changes

### Phase 1 — Add the Four Missing `ByPlanId` Methods to `KanbanDatabase`

File: `src/services/KanbanDatabase.ts`

> **Correction from original plan:** The original plan claimed 5 methods need variants. `updatePlanFile` already has `updatePlanFileByPlanId` at line 1740. Only **4** methods need new variants.

These four methods have no planId/planFile variant. Add them before touching any callers.

#### 1.1 `updateBrainPathsByPlanId(planId: string, brainSourcePath: string, mirrorPath: string): Promise<boolean>`

The existing `updateBrainPaths(sessionId, ...)` at line 3677 does sessionId→planId lookup then `UPDATE plans SET brain_source_path = ?, mirror_path = ?, updated_at = ? WHERE session_id = ?`. New version uses `WHERE plan_id = ?` directly.

#### 1.2 `isOwnedActiveByPlanId(planId: string, workspaceId: string): Promise<boolean>`

The existing `isOwnedActive(sessionId, workspaceId)` at line 3759 runs `SELECT 1 FROM plans WHERE session_id = ? AND workspace_id = ? AND status = 'active'`. New version: `WHERE plan_id = ?`.

#### 1.3 `updateColumnTransactionByPlanId(planIds: string[], targetColumn: string): Promise<boolean>`

The existing `updateColumnTransaction(sessionIds[], targetColumn)` at line 3708 is a bulk UPDATE via `session_id IN (...)`. New version does the same via `plan_id IN (...)`. The method body at line 3708 can serve as the template.

#### 1.4 `migrateSessionEventsByPlanId(planId: string, events: any[]): Promise<number>`

The existing `migrateSessionEvents(sessionId, events)` at line 5484 inserts into `plan_events` using the `plan_id` FK (migration V20 moved `plan_events` to `plan_id` FK). New version just takes `planId` directly — no sessionId lookup needed. Check lines 5484–5530 of `KanbanDatabase.ts` for the insert logic.

---

### Phase 2 — Remove the `sess_` Fallback ID Generator

File: `src/services/TaskViewerProvider.ts`

Search for `sess_${Date.now()}` to find the block (approximately lines 13076–13100).

The block currently reads (simplified):

```ts
let sessionId: string | undefined;
if (fs.existsSync(statePath)) { /* read state.json → sessionId */ }
if (!sessionId) {
    sessionId = `sess_${Date.now()}`;  // ← DELETE THIS BRANCH (line ~13078)
} else {
    // collision check that assigns sess_${Date.now()}_${random} ← DELETE THIS BLOCK (line ~13098)
}
```

**Replace with:** if no Claude session ID is found in `state.json`, do **not** fabricate one. The plan is identified by its `planFile` alone. The runsheet and DB row should be created/found by `planFile` + `workspaceId` from that point forward in the function. The `sessionId` local variable itself can be removed from this code path — callers downstream in the same function that pass `sessionId` to DB methods should already be on `ByPlanFile` variants after Phase 3.

The `sess_` watcher-created-row cleanup code in `KanbanDatabase.ts` (`cleanupSpuriousMirrorPlans` at lines 3437–3591 and `cleanupDuplicateLocalPlans` at lines 3599–3658) can be removed once the generator is gone. Leave it in for now (Phase 5 cleanup).

---

### Phase 3 — Migrate All Callers in Service Files

For each file: find every call that passes a `sessionId`, switch to the `planFile`/`planId` variant. The key is that by the time any service method is called, the caller already has the `KanbanPlanRecord` (which contains both `planFile` and `planId`). Use those. Do not do a secondary `getPlanBySessionId` lookup to get the planFile — the record is already in scope.

#### 3.1 `src/services/ContinuousSyncService.ts` (~116 references)

- The `_states: Map<planFile, LiveSyncState>` is already keyed by `planFile`. Good.
- The `_syncQueue: Array<{ sessionId: string; priority: number }>` (line 23) must change to `{ planFile: string; priority: number }`.
- All method signatures `pausePlan(sessionId)` (line 131), `resumePlan(sessionId)` (line 165), `checkForConflicts(sessionId)` (line 227), `getState(sessionId)` (line 117), `_maybeSync(sessionId)` (line 366), `_executeSync(sessionId)` (line 398), `_showConflictDialog(sessionId)` (line 237), `_bumpEpoch(sessionId)` (line 134), `_isCurrentEpoch(sessionId)` (line 524), `_createInitialState(sessionId)` (line 204), `_getPlanRecord(sessionId)` (line 194), `_getPlanTopicSafe(sessionId)` — replace `sessionId: string` with `planFile: string` throughout. Update the single `_getPlanRecord` call that calls `db.getPlanBySessionId(sessionId)` → `db.getPlanByPlanFile(planFile, workspaceId)`.
- `LiveSyncState` in `src/models/LiveSyncTypes.ts` line 11: remove `sessionId: string`.

#### 3.2 `src/services/TaskViewerProvider.ts` (~470 references)

This is the largest file (18,879 lines). Work through it by callsite cluster. **Use grep to find each pattern — line numbers below are approximate.**

- **`_lastSessionId` field** (line 341): rename to `_lastPlanFile: string | null`. Update all reads/writes (search for `_lastSessionId` — approximately lines 1574, 1579, 1802, 16576, 16591).
- **`selectSession(sessionId)` method** (line ~1801): rename to `selectPlan(planFile)`. Update the VSCode command handler in `extension.ts` at line 691.
- **`_resolveWorkspaceRootForSession(sessionId)`** (line ~1061): rename to `_resolveWorkspaceRootForPlan(planFile)`. The DB call inside (line ~1072) becomes `db.getPlanByPlanFile(planFile, workspaceId)` (workspaceId must be threaded through or resolved from the planFile path).
- **`KanbanDispatchCard.sessionId`** (line 106): remove the field. The primary identifier is `planId`. Update `_dispatchCardId(card)` at line 316 to return `card.planId` only (currently returns `card.planId || card.sessionId`).
- **`_planRegistry.entries[sheet.sessionId]`** (search for `_planRegistry.entries[sheet.sessionId]`, approximately line 11377): change to `_planRegistry.entries[planId]` — the registry is already indexed by `planId` everywhere else.
- **Batch trigger / forward/backward move handlers**: these receive `sessionIds: string[]` as arguments (and as command parameters in `extension.ts`). Change to `planIds: string[]`.
- **All `db.updatePlanFile(plan.sessionId, ...)`** calls (search for `db.updatePlanFile(plan.sessionId`): use `db.updatePlanFileByPlanId(plan.planId, ...)` — this method already exists at line 1740.
- **`handleKanbanCompletePlan(sessionId)`** (line 3293), **`handleDeletePlanFromReview(sessionId)`** (line 3305): change to `handleKanbanCompletePlan(planId)` and `handleDeletePlanFromReview(planId)`. Update call sites in webviews.
- **The `currentColumnBySession.set(row.planId || row.sessionId, ...)`** fallbacks (search for `row.planId || row.sessionId`, approximately lines 2395 and 7050): use `row.planId` only.
- **`routedSessions[role].push({ sessionId: card.sessionId, ... })`** (search for `routedSessions.*push.*sessionId`, approximately line 7933): remove `sessionId` from the pushed shape.
- **`handleKanbanRestorePlan(data.sessionId)`** (search for `handleKanbanRestorePlan(data.sessionId`, approximately line 9075): use `data.planId`.
- **Any webview message with `{ sessionId: ... }`**: update the message shape to use `planId` or `planFile`. See Phase 3.3 for PlanningPanelProvider message handlers.
- **`JulesSessionRecord`** (line 121): contains both `sessionId: string` and `planSessionId?: string`. Remove `sessionId` and `planSessionId` if no longer needed, or replace with `planId`.

#### 3.3 `src/services/PlanningPanelProvider.ts`

- Local interface `KanbanPlanSummary` at line 43 includes `sessionId: string` — remove.
- Message handlers (search for `msg.sessionId`): approximately lines 2582, 2618, 2690, 2709, 2776 — extract `sessionId` from `msg.sessionId` — switch to `msg.planId` or `msg.planFile`.
- Line ~3357 (search for `db.updatePlanFile(plan.sessionId`): `db.updatePlanFile(plan.sessionId, newRelative)` → `db.updatePlanFileByPlanId(plan.planId, newRelative)`.
- Line ~7567 (search for `sessionId: r.sessionId`): `sessionId: r.sessionId || ''` in serialized response — remove field.
- Line ~1810 (search for `sessionId: msg.sessionId`): `sessionId: msg.sessionId || ''` — remove.

#### 3.4 `src/services/GlobalPlanWatcherService.ts`

- Line ~533 (search for `sessionId: ''`): `sessionId: ''` in upsert object — remove field.
- Line ~591 (search for `sessionId: plan.sessionId`): `sessionId: plan.sessionId` in upsert object — remove field.

#### 3.5 `src/services/KanbanMigration.ts`

- Line 5: `sessionId: string` in `LegacyKanbanSnapshotRow` interface — remove.
- Line 58: `db.updateColumn(row.sessionId, remappedColumn)` → `db.updateColumnByPlanFile(row.planFile, row.workspaceId, remappedColumn)`.

#### 3.6 `src/services/NotionBackupService.ts`

- Line 105: `columnUpdates: Array<{ sessionId: string; column: string }>` → `Array<{ planId: string; column: string }>`.
- Line 129: `columnUpdates.push({ sessionId: plan.sessionId, ... })` → `{ planId: plan.planId, ... }`.
- Line 276: `'Session ID': { rich_text: [{ text: { content: plan.sessionId } }] }` — remove this Notion property entirely (it was only ever written for debugging and is not used on restore).
- Line 304: `sessionId: getRichText(p['Session ID'])` — remove.

#### 3.7 `src/services/PipelineOrchestrator.ts`

- Line 17: `DispatchCallback` type includes `sessionId: string` parameter — remove.
- Line 223: `const sessionId: string = sheet.sessionId` — change to use `planId` or `planFile` from the sheet.

#### 3.8 `src/services/ArchiveManager.ts`

- Line 12: `sessionId: string` in `PlanRecord` interface — remove.
- Line 32: same in `ReviewOutcome` interface — remove.
- Line 158: DuckDB INSERT includes `plan.sessionId` — remove that column from the archive schema (it was only ever written for debugging; there is no FK use in DuckDB).
- Line 278: similar — remove `sessionId` from the outcome INSERT.

#### 3.9 `src/services/LinearAutomationService.ts` and `ClickUpAutomationService.ts`

- Line 475 (Linear) and 332 (ClickUp): `_buildWriteBackSummary(planContent, plan.sessionId, rule.name)` — the `sessionId` parameter in `_buildWriteBackSummary` is used for display only (not written to DB). Replace with `plan.planId`.
- Line 478 (Linear) and 336 (ClickUp): `db.updateLastAction(plan.sessionId, ...)` → `db.updateLastActionByPlanFile(plan.planFile, plan.workspaceId, ...)`.

#### 3.10 `src/services/SessionActionLog.ts`

> **Critical addition not in original plan:** The `_resolvePlan` method (line 70–76) is a hybrid that tries `getPlanByPlanFile` first, then falls back to `getPlanBySessionId`. This fallback MUST be removed when `getPlanBySessionId` is deleted in Phase 4. If not removed, every legacy runsheet access will throw a runtime error.

- **`_resolvePlan` method** (line 70): remove the `getPlanBySessionId` fallback at line 76. Keep only the `getPlanByPlanFile` path.
- **`_composeHydratedSheet(sessionId, ...)`** (line 464): rename parameter to `planId`. The `sessionId` field in the returned sheet object (line 466) should be removed or renamed to `planId`.
- **`_writeLocks` map** (declared at line 37, used at lines 478, 480, 481, 482, 539, 541, 542, 543): key by `planId` instead of `sessionId`.
- **`createRunSheet(sessionId, data)`** (line 477): rename to `createRunSheetByPlanId(planId, data)`.
- **`normalized.sessionId = planFile` fallback** (lines 491–492): this is compensating for missing IDs. With the generator gone (Phase 2), all sheets have real planIds. **However:** existing runsheet files on disk may still use the old `planFile` as their key. Instead of throwing, implement a **read-both transition**: if `planId` is missing, fall back to looking up the runsheet by `planFile` (which is what the old key was), then migrate the file to use `planId` on next write. Remove the fallback only after all on-disk files have been migrated (or after a reasonable transition period).
- **`updateRunSheet(sessionId, updater)`** (line 538): rename to `updateRunSheetByPlanId(planId, updater)`.
- **`getRunSheet(sessionId)`** (line 655): rename to `getRunSheetByPlanId(planId)`.
- **`deleteRunSheet(sessionIdOrPlanFile)`** (line 640): already takes a hybrid key — update to `planId` only after transition.

#### 3.11 `src/services/agentPromptBuilder.ts`

- Line 33 (search for `sessionId?: string` in `BatchPromptPlan` interface): remove the field.

#### 3.12 `src/extension.ts`

- Line 691: `switchboard.selectSession` command → rename to `switchboard.selectPlan`. Update webview callers.
- Lines 1110–1120: `switchboard.triggerAgentFromKanban`, `switchboard.analystMapFromKanban`, `switchboard.analystMapFromKanbanBatch` — parameters change from `sessionId: string` / `sessionIds: string[]` to `planId: string` / `planIds: string[]`.
- Lines 1130, 1140, 1145, 1150, 1160, 1165: same for batch trigger, backward/forward move, complete, delete, copy commands.

#### 3.13 Webviews: `src/webview/project.js` and `src/webview/planning.js`

Search for `sessionId` in both files (project.js: ~19 occurrences, planning.js: ~32 occurrences) and update all message sends to use `planId` or `planFile` instead. These are the messages the webview sends back to the extension host — they must match the command parameter changes in 3.12.

#### 3.14 `activity_log` INSERT paths (NEW — not in original plan)

> **Critical addition:** Before Phase 5.3 drops the `session_id` column from `activity_log`, all INSERT statements that write `session_id` must be found and updated. Search `KanbanDatabase.ts` and all service files for `activity_log` INSERT statements. If any code path writes `session_id` to `activity_log`, remove that column from the INSERT. If no code writes to it (it may be a vestigial column), confirm with grep before dropping.

---

### Phase 4 — Remove All Deprecated sessionId DB Methods

File: `src/services/KanbanDatabase.ts`

After all callers are migrated (Phase 3), delete the following methods entirely. No `@deprecated` stub, no empty shell — full deletion:

- `getPlanBySessionId(sessionId)` (line 2481)
- `hasPlan(sessionId)` (line 1360 — the sessionId overload; `hasPlanByPlanFile` is the only one needed)
- `updateColumn(sessionId, col)` (line 1421)
- `movePlan(sessionId, col)` (line 1473)
- `updateComplexity(sessionId, c)` (line 1541)
- `updateTags(sessionId, t)` (line 1569)
- `updateStatus(sessionId, s)` (line 1614)
- `updateLastAction(sessionId, a)` (line 1688)
- `updateTopic(sessionId, t)` (line 1703)
- `updatePlanFile(sessionId, planFile)` (line 1710 — replaced by `updatePlanFileByPlanId` at line 1740)
- `updateBrainPaths(sessionId, ...)` (line 3677 — replaced by `updateBrainPathsByPlanId` from Phase 1)
- `isOwnedActive(sessionId, workspaceId)` (line 3759 — replaced by `isOwnedActiveByPlanId` from Phase 1)
- `updateColumnTransaction(sessionIds[])` (line 3708 — replaced by `updateColumnTransactionByPlanId` from Phase 1)
- `migrateSessionEvents(sessionId, events)` (line 5484 — replaced by `migrateSessionEventsByPlanId` from Phase 1)
- `updateSessionId(oldSessionId, newSessionId)` (line 1748) — delete, no replacement (concept no longer exists)
- `deletePlan(sessionId)` (line 1834)
- `reviveDeletedPlans(sessionIds[])` (line 1650)
- `completeMultiple(sessionIds[])` (line 2804)
- `appendPlanEvent(sessionId, event)` (line 5359)
- `getPlanEvents(sessionId)` (line 5394)
- `getRunSheet(sessionId)` (line 5474)
- `deletePlanEvents(sessionId)` (line 5545)
- `updateDispatchInfo(sessionId, info)` (line 5577)
- `updateLinearIssueId(sessionId, id)` (line 1786)
- `updateClickUpTaskId(sessionId, id)` (line 1819)
- `getPlanFilePath(sessionId)` (line 1500 — superseded by `getPlanFilePathByPlanFile`)

Also remove:
- The `sess_`-row deduplication helpers: `cleanupSpuriousMirrorPlans` (lines 3437–3591) and `cleanupDuplicateLocalPlans` (lines 3599–3658) — these cleaned up rows that the now-deleted generator created.
- `getRunSheet(sessionId)` fallback path and `_writeLocks.get(sessionId)` in `SessionActionLog.ts` (after Phase 3.10 transition is complete).

---

### Phase 5 — DB Schema Migration (V38)

File: `src/services/KanbanDatabase.ts`

> **CRITICAL CORRECTION:** The original plan's copy-swap SQL was missing 5 columns (`dependencies`, `repo_scope`, `worktree_id`, `worktree_status`, `workspace_name`) and had incorrect types/defaults for several columns. The SQL below is corrected against the **verified** schema at lines 111–141 of `KanbanDatabase.ts`. The `plans` table has 29 columns total (28 excluding `session_id`).

Add a new migration SQL constant and register it in the migration runner. The version number is **V38** (V37 is the latest verified migration as of 2026-06-23).

#### 5.1 Drop `session_id` from `plans`

SQLite does not support `ALTER TABLE DROP COLUMN` in versions before 3.35. Use the safe copy-swap pattern. **The new table must exactly match the current schema minus `session_id`:**

```sql
-- 1. New plans table without session_id (28 columns, matching current schema exactly)
CREATE TABLE plans_new (
    plan_id       TEXT PRIMARY KEY,
    topic         TEXT NOT NULL,
    plan_file     TEXT,
    kanban_column TEXT NOT NULL DEFAULT 'CREATED',
    status        TEXT NOT NULL DEFAULT 'active',
    complexity    TEXT DEFAULT 'Unknown',
    tags          TEXT DEFAULT '',
    dependencies  TEXT DEFAULT '',
    repo_scope    TEXT DEFAULT '',
    project       TEXT DEFAULT '',
    workspace_id  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    last_action   TEXT,
    source_type   TEXT DEFAULT 'local',
    brain_source_path TEXT DEFAULT '',
    mirror_path       TEXT DEFAULT '',
    routed_to         TEXT DEFAULT '',
    dispatched_agent  TEXT DEFAULT '',
    dispatched_ide    TEXT DEFAULT '',
    clickup_task_id   TEXT DEFAULT '',
    linear_issue_id   TEXT DEFAULT '',
    worktree_id       INTEGER,
    worktree_status   TEXT DEFAULT 'none',
    is_epic           INTEGER DEFAULT 0,
    epic_id           TEXT DEFAULT '',
    workspace_name    TEXT DEFAULT '',
    project_id        INTEGER DEFAULT NULL
);
-- 2. Copy all rows (exclude session_id — 28 columns in same order as above)
INSERT INTO plans_new SELECT plan_id, topic, plan_file, kanban_column, status, complexity, tags,
    dependencies, repo_scope, project, workspace_id, created_at, updated_at, last_action, source_type,
    brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide,
    clickup_task_id, linear_issue_id, worktree_id, worktree_status, is_epic, epic_id,
    workspace_name, project_id FROM plans;
-- 3. Swap
DROP TABLE plans;
ALTER TABLE plans_new RENAME TO plans;
-- 4. Recreate the UNIQUE index (do NOT use a table-level UNIQUE constraint — match existing approach)
CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_plan_file_workspace ON plans(plan_file, workspace_id);
```

> **Important:** The `INSERT INTO plans_new SELECT ...` column list MUST match the `plans_new` column order exactly. The columns above are verified against lines 111–141 of `KanbanDatabase.ts`. Do not add or remove columns without re-reading the schema.

#### 5.2 Drop `session_id` from `plan_events` — CONFIRMATION ONLY

Migration V20 (lines 396–407) already created `plan_events_v20` with `plan_id` FK and no `session_id` column. **No action needed.** Confirm by checking the current `plan_events` table schema at migration time. If for some reason `session_id` still exists (e.g., a non-V20 database), use the same copy-swap pattern.

#### 5.3 Drop `session_id` from `activity_log`

`activity_log` has `session_id TEXT` (nullable, no FK, line 220). Use the copy-swap pattern:

```sql
CREATE TABLE activity_log_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    correlation_id TEXT
);
INSERT INTO activity_log_new SELECT id, timestamp, event_type, payload, correlation_id FROM activity_log;
DROP TABLE activity_log;
ALTER TABLE activity_log_new RENAME TO activity_log;
```

> **Prerequisite:** Phase 3.14 must be complete — all `activity_log` INSERT paths must no longer write `session_id` before this migration runs.

#### 5.4 Drop orphaned indexes

```sql
DROP INDEX IF EXISTS idx_plans_session_id_unique;
DROP INDEX IF EXISTS idx_events_session;
DROP INDEX IF EXISTS idx_activity_session;
```

Recreate `idx_events_session` and `idx_activity_session` without the `session_id` column (or drop them entirely if nothing queries by session anymore).

#### 5.5 Update `PLAN_COLUMNS` constant

Remove `session_id` from the `PLAN_COLUMNS` constant at line 589. The updated constant should be:

```typescript
const PLAN_COLUMNS = `plan_id, topic, plan_file, kanban_column, status, complexity, tags,
                       repo_scope, project, workspace_id, created_at, updated_at, last_action, source_type,
                       brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide,
                       clickup_task_id, linear_issue_id, worktree_id, worktree_status, is_epic, epic_id,
                       workspace_name, project_id`;
```

> **Note:** `dependencies` was in the original schema (line 120) but NOT in the current `PLAN_COLUMNS` constant (line 589). Do not add it — only remove `session_id`.

---

### Phase 6 — Remove `sessionId` from All Interfaces and Types

After Phases 3–5 compile cleanly, remove the field declarations:

- `KanbanPlanRecord.sessionId: string` — the record shape used everywhere a DB row is returned
- `KanbanDispatchCard.sessionId: string` in `TaskViewerProvider.ts:106`
- `LiveSyncState.sessionId` in `src/models/LiveSyncTypes.ts:11`
- Local interface `KanbanPlanSummary` in `PlanningPanelProvider.ts:43`
- Local interfaces in `ArchiveManager.ts:12` and `:32`
- Local interface in `NotionBackupService.ts`
- `JulesSessionRecord.sessionId` and `.planSessionId` at `TaskViewerProvider.ts:121` — these were sessionId aliases; replace with `planId` if still needed
- `agentPromptBuilder.ts:33` `BatchPromptPlan` options type

Also clean up `PLAN_COLUMNS` constant at `KanbanDatabase.ts:589` to remove `session_id` from the SQL select list after the column is dropped (Phase 5.5).

---

### Phase 7 — Tests

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

1. Phase 1 (add 4 new DB methods) — prerequisite for everything
2. Phase 2 (kill sess_ generator) — can be done alongside Phase 1
3. Phase 3 (migrate callers) — work file by file; compile after each file
4. Phase 4 (delete old DB methods) — only after Phase 3 compiles clean
5. Phase 5 (DB migration V38) — only after Phase 4
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

## Recommendation

**Complexity: 8 → Send to Lead Coder.** This is a multi-file coordination task with an irreversible DB migration on a published extension. The 470 occurrences in TaskViewerProvider.ts alone make this high-risk. A lead coder should handle the Phase 5 migration SQL and Phase 3.2 (TaskViewerProvider) personally; the remaining phases can be delegated if needed.
